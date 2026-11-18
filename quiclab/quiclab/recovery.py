"""每个包号空间独立的丢包恢复 —— RFC 9002 §6 与附录 A.2/A.5/A.7。

需求 1:丢包判定同时使用
- 包号阈值(packet threshold):largest_acked - pn > kPacketThreshold;
- 时间阈值(time threshold):now - time_sent > kTimeThreshold * latest_rtt。
两种触发原因分别用 ``LOSS_PACKET_THRESHOLD`` / ``LOSS_TIME_THRESHOLD``
标记,时间线上分开显示。

需求 7:Initial / Handshake / App-Data 三个包号空间各自独立编号、独立判丢,
连接层为每个空间持有一个 ``SpaceRecovery``。
"""

from __future__ import annotations

from dataclasses import dataclass

from .constants import (
    INITIAL_RTT,
    LOSS_PACKET_THRESHOLD,
    LOSS_TIME_THRESHOLD,
    PACKET_THRESHOLD,
    SPACE_APPDATA,
    TIME_EPS,
    TIME_THRESHOLD_DEN,
    TIME_THRESHOLD_NUM,
)
from .rtt import RttEstimator


@dataclass
class SentPacket:
    """sent_packets 映射中的一条记录(对应规范伪代码里的 SentPacket 结构)。"""

    packet_number: int
    space: int
    time_sent: float
    size: int
    ack_eliciting: bool
    in_flight: bool
    frame_types: tuple = ()
    is_handshake: bool = False
    is_probe: bool = False
    # 生命周期标志
    acked: bool = False
    lost: bool = False
    loss_cause: str | None = None
    time_acked: float | None = None
    # 应用层载荷信息(用于“恰好一次”校验)
    app_offset: int | None = None
    app_length: int = 0

    @property
    def outstanding(self) -> bool:
        """仍在途:既没被确认也没判丢。"""
        return not self.acked and not self.lost


class SpaceRecovery:
    """一个包号空间的全部丢包恢复状态。"""

    def __init__(self, space: int) -> None:
        self.space = space
        self.is_handshake = space != SPACE_APPDATA
        self.sent_packets: dict[int, SentPacket] = {}
        self.largest_acked: int | None = None
        self.largest_sent: int = -1
        # 对应伪代码的 ack_eliciting_in_flight 标志
        self.ack_eliciting_in_flight: int = 0
        # 时间阈值到期点(附录 A.5 的 loss_time)
        self.loss_time: float | None = None
        # 最近一次 PTO 探测发出的时间;退避封顶后用它锚定 deadline,
        # 保证即使旧在途包未被清理,PTO 到期点也单调前进
        self.last_probe_time: float | None = None

    # ------------------------------------------------------------------
    def next_packet_number(self) -> int:
        self.largest_sent += 1
        return self.largest_sent

    def register_sent(self, pkt: SentPacket) -> None:
        if pkt.packet_number in self.sent_packets:
            raise AssertionError(
                f"空间 {self.space} 包号 {pkt.packet_number} 重复发送"
            )
        self.sent_packets[pkt.packet_number] = pkt
        if pkt.ack_eliciting and pkt.in_flight:
            self.ack_eliciting_in_flight += 1

    def unacked_packets(self) -> list[SentPacket]:
        """包号升序的所有在途(未确认、未判丢)包。"""
        return [
            p
            for pn, p in sorted(self.sent_packets.items())
            if p.outstanding
        ]

    def earliest_outstanding_send_time(self) -> float | None:
        times = [
            p.time_sent
            for p in self.sent_packets.values()
            if p.outstanding and p.ack_eliciting
        ]
        return min(times) if times else None

    # ------------------------------------------------------------------
    def _time_threshold(self, rtt_estimator: RttEstimator) -> float:
        # 附录 A.5:没有 RTT 样本时用 kInitialRtt
        latest = rtt_estimator.latest_rtt
        rtt = latest if latest is not None else INITIAL_RTT
        return rtt * TIME_THRESHOLD_NUM / TIME_THRESHOLD_DEN

    def detect_lost_packets(
        self, now: float, rtt_estimator: RttEstimator
    ) -> list[SentPacket]:
        """detect_lost_packets()(附录 A.5),返回本次新判丢的包。

        判定顺序与伪代码一致:先包号阈值,再时间阈值;同一轮里两种条件
        都满足时以包号阈值为准(规范伪代码先检查包号阈值)。
        """
        newly_lost: list[SentPacket] = []
        self.loss_time = None
        if self.largest_acked is None:
            return newly_lost

        time_threshold = self._time_threshold(rtt_estimator)

        for pkt in self.unacked_packets():
            if not pkt.ack_eliciting:
                continue
            # (1) 包号阈值
            if self.largest_acked - pkt.packet_number > PACKET_THRESHOLD:
                self._mark_lost(pkt, LOSS_PACKET_THRESHOLD, newly_lost)
                continue
            # (2) 时间阈值。规范是严格 >;补一个浮点“相等”分支
            #     (差值小于 TIME_EPS),消除 1e-13 量级的边界抖动
            age = now - pkt.time_sent
            if age > time_threshold or abs(age - time_threshold) <= TIME_EPS:
                self._mark_lost(pkt, LOSS_TIME_THRESHOLD, newly_lost)
            else:
                # 记录最早的时间阈值到期点,供连接层设定 loss timer
                expire_at = pkt.time_sent + time_threshold
                if self.loss_time is None or expire_at < self.loss_time:
                    self.loss_time = expire_at
        return newly_lost

    def _mark_lost(
        self, pkt: SentPacket, cause: str, sink: list[SentPacket]
    ) -> None:
        pkt.lost = True
        pkt.loss_cause = cause
        if pkt.ack_eliciting and pkt.in_flight:
            self.ack_eliciting_in_flight -= 1
        sink.append(pkt)

    def mark_acked(self, pkt: SentPacket, now: float) -> None:
        pkt.acked = True
        pkt.time_acked = now
        if pkt.ack_eliciting and pkt.in_flight:
            self.ack_eliciting_in_flight -= 1

    # ------------------------------------------------------------------
    def process_ack(
        self,
        acknowledged: list[int],
        now: float,
        rtt_estimator: RttEstimator,
    ) -> tuple[list[SentPacket], list[SentPacket]]:
        """收到 ACK 帧后的完整处理。

        Returns
        -------
        (newly_acked, newly_lost):本空间新确认的包与新判丢的包。
        注意:不存在的包号(对端确认了从没发过的包)不在此处理,由连接层
        做协议违例检查后直接关连接(需求 8)。
        """
        newly_acked: list[SentPacket] = []
        for pn in acknowledged:
            if self.largest_acked is None or pn > self.largest_acked:
                self.largest_acked = pn
            pkt = self.sent_packets.get(pn)
            if pkt is None or not pkt.outstanding:
                # 已确认/已判丢的旧包号属于重复 ACK,忽略;
                # 完全没发过的包号由连接层先于本函数拦截。
                continue
            self.mark_acked(pkt, now)
            newly_acked.append(pkt)

        newly_acked.sort(key=lambda p: p.packet_number)
        newly_lost = self.detect_lost_packets(now, rtt_estimator)
        return newly_acked, newly_lost

    # ------------------------------------------------------------------
    def pto_deadline(
        self,
        now: float,
        pto_count: int,
        rtt_estimator: RttEstimator,
    ) -> float | None:
        """附录 A.7:本空间的 PTO 到期时间;无在途可确认包时返回 None。

        正常情况下锚定最早在途可确认包的发送时间;若本空间已发过 PTO 探测,
        则取两者较晚者,使退避封顶后的到期点随探测推进而单调前进。
        """
        send_time = self.earliest_outstanding_send_time()
        if send_time is None:
            return None
        if self.last_probe_time is not None:
            send_time = max(send_time, self.last_probe_time)
        # Initial/Handshake 空间的 PTO 不含 max_ack_delay
        include_delay = not self.is_handshake
        duration = rtt_estimator.pto_duration(pto_count, include_delay)
        return send_time + duration

    def outstanding_bytes(self) -> int:
        # 仅可确认包计入在途字节;ACK-only 包不占窗口、不阻塞关闭
        return sum(
            p.size
            for p in self.sent_packets.values()
            if p.outstanding and p.in_flight
        )

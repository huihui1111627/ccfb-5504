"""QUIC 连接实体:三个包号空间、ACK/丢包/PTO/拥塞控制/发送节拍的整合。

外部驱动方式(由仿真引擎驱动):
1. ``on_datagram`` 处理入包;
2. ``next_wakeup`` 查询下一个定时事件;
3. ``wake`` 到点处理 loss timer / PTO / 发送节拍 / ACK 定时器。

规范对应:RFC 9000(包号空间、ACK 帧、连接关闭)+ RFC 9002(恢复与拥塞控制)。
"""

from __future__ import annotations

from collections import deque

from .congestion import CongestionControl, MSS, NEW_RENO
from .constants import (
    ACK_EVERY_PACKETS,
    MAX_ACK_DELAY,
    MAX_ACK_RANGES,
    PTO_MAX_EXPONENT,
    SPACE_APPDATA,
    SPACE_HANDSHAKE,
    SPACE_INITIAL,
    SPACE_NAMES,
    TIME_EPS,
)
from .frames import Frame, WirePacket
from .pacer import Pacer
from .rangeset import RangeSet, encode_ack_ranges
from .recovery import SentPacket, SpaceRecovery
from .rtt import RttEstimator

# 连接状态
STATE_INIT = "init"
STATE_INITIAL = "initial_sent"
STATE_HANDSHAKE = "handshake"
STATE_ESTABLISHED = "established"
STATE_CLOSED = "closed"


class Connection:
    """一个 QUIC 端点(client 或 server)。"""

    def __init__(
        self,
        conn_id: str,
        role: str,
        peer_id: str,
        rng_seq,
        trace,
        app_total_bytes: int | None = None,
        initial_algo: str = NEW_RENO,
        max_ack_delay: float = MAX_ACK_DELAY,
        expected_app_bytes: int | None = None,
    ) -> None:
        self.conn_id = conn_id
        self.role = role  # "client" / "server"
        self.peer_id = peer_id
        self._seq = rng_seq  # 确定性自增序号器,不是随机数
        self.trace = trace

        self.state = STATE_INIT
        self.closed_reason: str | None = None
        self.close_time: float | None = None

        # --- 三个包号空间(需求 7) ---
        self.spaces: dict[int, SpaceRecovery] = {
            SPACE_INITIAL: SpaceRecovery(SPACE_INITIAL),
            SPACE_HANDSHAKE: SpaceRecovery(SPACE_HANDSHAKE),
            SPACE_APPDATA: SpaceRecovery(SPACE_APPDATA),
        }
        # 所有真正发出去过的包号(含 ACK-only),用于需求 8 的违例检查
        self.sent_pns: dict[int, set[int]] = {
            SPACE_INITIAL: set(),
            SPACE_HANDSHAKE: set(),
            SPACE_APPDATA: set(),
        }
        # 已丢弃的包号空间(握手确认后丢弃 Initial);该空间的入包一律忽略
        self.discarded_spaces: set[int] = set()

        # --- 规范状态机组件 ---
        self.rtt = RttEstimator(max_ack_delay=max_ack_delay)
        self.cc = CongestionControl(initial_algo, event_sink=self._cc_sink)
        self.pacer = Pacer()
        self.pto_count = 0  # 连接级退避计数(附录 A.7)

        # --- ACK 生成状态 ---
        self.pending_acks: dict[int, RangeSet] = {
            s: RangeSet() for s in self.spaces
        }
        self.ack_pending_count: dict[int, int] = {s: 0 for s in self.spaces}
        self.ack_timer_start: dict[int, float | None] = {
            s: None for s in self.spaces
        }

        # --- 握手标志 ---
        self.initial_sent = False
        self.client_hs_sent = False
        self.server_hs_sent = False
        self.crypto_contiguous: dict[int, int] = {
            SPACE_INITIAL: 0,
            SPACE_HANDSHAKE: 0,
        }

        # --- 应用数据流(仅 client 发,server 收并重组) ---
        self.app_total_bytes = app_total_bytes
        self.app_chunk = MSS if app_total_bytes is None else max(
            1, app_total_bytes // 20
        )
        self.app_next_offset = 0
        self.app_finished_sending = app_total_bytes is None
        # server 端:期望收到的应用字节数(用于 fin 完成判定)
        self._expected_app_bytes = expected_app_bytes
        self.recv_holes: dict[int, int] = {}
        self.recv_contiguous = 0
        self.delivered_offsets: list[tuple[int, int]] = []
        self._recv_seen: dict[int, set[int]] = {
            s: set() for s in self.spaces
        }

        # 重传队列(按入队顺序,元素为 (space, frame))
        self.retransmit_queue: deque[tuple[int, Frame]] = deque()

        self.bytes_in_flight = 0
        self.now = 0.0

    # ==================================================================
    # 工具
    # ==================================================================
    @property
    def closed(self) -> bool:
        return self.state == STATE_CLOSED

    def _cc_sink(self, event: dict) -> None:
        event["conn_id"] = self.conn_id
        self.trace(event)

    def _emit(self, etype: str, **fields) -> None:
        event = {"type": etype, "time": round(self.now, 6), "conn_id": self.conn_id}
        event.update(fields)
        self.trace(event)

    def snapshot(self) -> dict:
        return {
            "conn_id": self.conn_id,
            "role": self.role,
            "state": self.state,
            "closed_reason": self.closed_reason,
            "now": self.now,
            "bytes_in_flight": self.bytes_in_flight,
            "pto_count": self.pto_count,
            "cc": self.cc.snapshot(),
            "rtt": self.rtt.snapshot(),
            "pacer_next": self.pacer.next_send_time,
            "app_delivered": self.recv_contiguous if self.role == "server" else None,
        }

    def _next_seq(self) -> int:
        return self._seq()

    # ==================================================================
    # 发送侧
    # ==================================================================
    def _new_packet(
        self, space: int, ack_eliciting: bool, frames: list[Frame], is_probe=False
    ) -> tuple[SpaceRecovery, WirePacket]:
        sp = self.spaces[space]
        pn = sp.next_packet_number()
        pkt = WirePacket(
            packet_number=pn,
            space=space,
            frames=frames,
            size=int(MSS),
            ack_eliciting=ack_eliciting,
            src=self.conn_id,
            dst=self.peer_id,
            sent_time=self.now,
            is_probe=is_probe,
            seq=self._next_seq(),
        )
        return sp, pkt

    def _emit_packet(self, sp: SpaceRecovery, pkt: WirePacket) -> SentPacket:
        """登记到恢复状态机并通过 trace 的 _wire 事件交给链路。"""
        rec = SentPacket(
            packet_number=pkt.packet_number,
            space=pkt.space,
            time_sent=self.now,
            size=pkt.size,
            ack_eliciting=pkt.ack_eliciting,
            in_flight=pkt.ack_eliciting,  # 仿真:仅可确认包计入 in-flight
            frame_types=tuple(f.kind for f in pkt.frames),
            is_handshake=sp.is_handshake,
            is_probe=pkt.is_probe,
        )
        for f in pkt.frames:
            if f.kind == "STREAM":
                rec.app_offset = f.offset
                rec.app_length = f.length
        sp.register_sent(rec)
        self.sent_pns[pkt.space].add(pkt.packet_number)
        if rec.in_flight:
            self.bytes_in_flight += pkt.size
        self._emit(
            "packet_sent",
            space=SPACE_NAMES[pkt.space],
            packet_number=pkt.packet_number,
            size=pkt.size,
            ack_eliciting=pkt.ack_eliciting,
            is_probe=pkt.is_probe,
            frames=[f.kind for f in pkt.frames],
            bytes_in_flight=self.bytes_in_flight,
            cwnd=self.cc.cwnd,
        )
        return rec

    def _build_ack_ranges(self, rs: RangeSet) -> tuple[list[tuple[int, int]], int]:
        before = len(rs)
        ordered = encode_ack_ranges(list(rs), MAX_ACK_RANGES)
        dropped = before - len(ordered)
        return ordered, dropped

    def _maybe_attach_ack(self, space: int, frames: list[Frame]) -> None:
        """若该空间有待确认包,给待发数据包挂上 ACK 帧。"""
        rs = self.pending_acks[space]
        if len(rs) == 0:
            return
        ordered, dropped = self._build_ack_ranges(rs)
        delay = (
            self.now - self.ack_timer_start[space]
            if self.ack_timer_start[space] is not None
            else 0.0
        )
        delay = max(0.0, delay)
        encoded = int(delay * 1000.0 / (2 ** self.rtt.ack_delay_exponent))
        frames.append(Frame.ack(ordered, delay, encoded, dropped_oldest=dropped))
        self.pending_acks[space] = RangeSet()
        self.ack_pending_count[space] = 0
        self.ack_timer_start[space] = None

    def _send_ack_only(self, space: int) -> None:
        """没有可确认包可搭车时,单独发一个 ACK 包。

        握手未确认期间(Initial/Handshake 空间,或连接尚未 established),
        ACK-only 包一旦丢失不会被重传,可能让握手永久卡死。此时给 ACK 包
        附加一个 PING,使其成为可确认、计入在途的包,对端 PTO 能把它拉回。
        """
        rs = self.pending_acks[space]
        if len(rs) == 0:
            return
        ordered, dropped = self._build_ack_ranges(rs)
        delay = (
            self.now - self.ack_timer_start[space]
            if self.ack_timer_start[space] is not None
            else 0.0
        )
        encoded = int(max(0.0, delay) * 1000.0 / (2 ** self.rtt.ack_delay_exponent))
        frames = [Frame.ack(
            ordered, max(0.0, delay), encoded, dropped_oldest=dropped
        )]
        handshake_pending = (
            space in (SPACE_INITIAL, SPACE_HANDSHAKE)
            or self.state != STATE_ESTABLISHED
        )
        ack_eliciting = handshake_pending
        if ack_eliciting:
            frames.append(Frame.ping())
        sp, pkt = self._new_packet(
            space, ack_eliciting=ack_eliciting, frames=frames
        )
        sp.register_sent(
            SentPacket(
                packet_number=pkt.packet_number,
                space=space,
                time_sent=self.now,
                size=pkt.size,
                ack_eliciting=ack_eliciting,
                in_flight=ack_eliciting,
                frame_types=tuple(f.kind for f in frames),
                is_handshake=sp.is_handshake,
            )
        )
        self.sent_pns[space].add(pkt.packet_number)
        if ack_eliciting:
            self.bytes_in_flight += pkt.size
        self.pending_acks[space] = RangeSet()
        self.ack_pending_count[space] = 0
        self.ack_timer_start[space] = None
        self._emit(
            "packet_sent",
            space=SPACE_NAMES[space],
            packet_number=pkt.packet_number,
            size=pkt.size,
            ack_eliciting=ack_eliciting,
            is_probe=False,
            frames=[f.kind for f in frames],
            bytes_in_flight=self.bytes_in_flight,
            cwnd=self.cc.cwnd,
            ack_dropped_oldest=dropped,
        )
        self.trace({"type": "_wire", "packet": pkt})

    # ------------------------------------------------------------------
    # 握手帧构造(仅在真正发送时改标志,避免“查询”产生副作用)
    # ------------------------------------------------------------------
    def _crypto_payload(self, space: int) -> str:
        if space == SPACE_INITIAL:
            return f"client-initial-{self.conn_id}"
        who = "client" if self.role == "client" else "server"
        return f"{who}-handshake-{self.conn_id}"

    def _next_crypto_frame(self) -> tuple[int, Frame] | None:
        if self.role == "client":
            if not self.initial_sent and self.state == STATE_INIT:
                self.initial_sent = True
                self.state = STATE_INITIAL
                return SPACE_INITIAL, Frame.crypto(
                    self._crypto_payload(SPACE_INITIAL), 0
                )
            if self.state == STATE_ESTABLISHED and not self.client_hs_sent:
                self.client_hs_sent = True
                return SPACE_HANDSHAKE, Frame.crypto(
                    self._crypto_payload(SPACE_HANDSHAKE), 0
                )
        else:
            if (
                self.state == STATE_INITIAL
                and not self.server_hs_sent
            ):
                self.server_hs_sent = True
                self.state = STATE_HANDSHAKE
                return SPACE_HANDSHAKE, Frame.crypto(
                    self._crypto_payload(SPACE_HANDSHAKE), 0
                )
        return None

    def _has_crypto_to_send(self) -> bool:
        if self.role == "client":
            return (
                not self.initial_sent and self.state == STATE_INIT
            ) or (self.state == STATE_ESTABLISHED and not self.client_hs_sent)
        return self.state == STATE_INITIAL and not self.server_hs_sent

    def _next_stream_frame(self) -> tuple[int, Frame] | None:
        if self.app_finished_sending:
            return None
        remaining = self.app_total_bytes - self.app_next_offset
        if remaining <= 0:
            self.app_finished_sending = True
            return None
        length = int(min(self.app_chunk, remaining))
        offset = self.app_next_offset
        fin = offset + length >= self.app_total_bytes
        frame = Frame.stream(offset, length, fin)
        self.app_next_offset += length
        if fin:
            self.app_finished_sending = True
        return SPACE_APPDATA, frame

    def _try_send(self) -> SentPacket | None:
        """节拍驱动的发送:每次调用最多发一个包,由 pacer 均匀拉开(需求 6)。"""
        if self.closed:
            return None
        if not self.pacer.can_send_at(self.now):
            return None
        if not self.cc.can_send(self.bytes_in_flight):
            return None

        frames: list[Frame] = []
        space: int | None = None
        ack_eliciting = False

        # 优先级 1:握手 CRYPTO
        crypto = self._next_crypto_frame()
        if crypto is not None:
            space, frame = crypto
            frames.append(frame)
            ack_eliciting = True
        elif self.retransmit_queue:
            # 优先级 2:重传队列(跳过目标空间已被丢弃的陈旧条目)
            while self.retransmit_queue:
                space, frame = self.retransmit_queue.popleft()
                if space not in self.discarded_spaces:
                    break
            else:
                space, frame = None, None
            if space is not None:
                frames.append(frame)
                ack_eliciting = True
        elif self.state == STATE_ESTABLISHED and self.role == "client":
            # 优先级 3:新应用数据
            sf = self._next_stream_frame()
            if sf is not None:
                space, frame = sf
                frames.append(frame)
                ack_eliciting = True

        if space is None:
            return None

        self._maybe_attach_ack(space, frames)
        sp, pkt = self._new_packet(space, ack_eliciting, frames)
        rec = self._emit_packet(sp, pkt)
        self.trace({"type": "_wire", "packet": pkt})
        self.pacer.update_rate(self.cc.cwnd, self.rtt.smoothed_rtt)
        self.pacer.schedule_next(self.now)
        return rec

    # ==================================================================
    # 接收侧
    # ==================================================================
    def on_datagram(self, pkt: WirePacket, now: float) -> None:
        if self.closed:
            return
        self.now = now

        # 已丢弃空间(Initial)的任何入包直接忽略
        if pkt.space in self.discarded_spaces:
            self._emit(
                "ignored_discarded_space",
                space=SPACE_NAMES[pkt.space],
                packet_number=pkt.packet_number,
            )
            return

        # 重复包直接丢弃,不产生任何副作用
        if pkt.packet_number in self._recv_seen[pkt.space]:
            self._emit(
                "packet_duplicate",
                space=SPACE_NAMES[pkt.space],
                packet_number=pkt.packet_number,
            )
            return
        self._recv_seen[pkt.space].add(pkt.packet_number)

        self._emit(
            "packet_received",
            space=SPACE_NAMES[pkt.space],
            packet_number=pkt.packet_number,
            size=pkt.size,
            ack_eliciting=pkt.ack_eliciting,
            frames=[f.kind for f in pkt.frames],
            is_probe=pkt.is_probe,
        )

        # ACK 先处理(它确认的是本机发出的包)
        for frame in pkt.frames:
            if frame.kind == "ACK":
                self._handle_ack(frame, pkt.space, now)
                if self.closed:
                    return

        # 记录待确认(仅可确认包需要 ACK)
        if pkt.ack_eliciting:
            self.pending_acks[pkt.space].add(pkt.packet_number)
            self.ack_pending_count[pkt.space] += 1
            if self.ack_timer_start[pkt.space] is None:
                self.ack_timer_start[pkt.space] = now

        for frame in pkt.frames:
            if frame.kind == "CRYPTO":
                self._handle_crypto(frame, pkt.space)
            elif frame.kind == "STREAM":
                self._handle_stream(frame)
            elif frame.kind == "PING":
                self._emit(
                    "probe_received",
                    space=SPACE_NAMES[pkt.space],
                    packet_number=pkt.packet_number,
                )
            elif frame.kind == "CONNECTION_CLOSE":
                self._close(now, f"peer_close: {frame.reason}")
                return

        if self.closed:
            return

        # 每 ACK_EVERY_PACKETS 个可确认包立即回 ACK;否则交给 ACK 定时器
        if self.ack_pending_count[pkt.space] >= ACK_EVERY_PACKETS:
            self._send_ack_only(pkt.space)

    # ------------------------------------------------------------------
    def _handle_ack(self, frame: Frame, space: int, now: float) -> None:
        acked_pns: list[int] = []
        for start, end in frame.ack_ranges:
            acked_pns.extend(range(start, end + 1))
        if not acked_pns:
            return

        # 需求 8:确认了从没发过的包号 -> 立即关闭并记录原因
        sent = self.sent_pns[space]
        for pn in acked_pns:
            if pn not in sent:
                self._close(
                    now,
                    f"protocol_violation: ACK in space {SPACE_NAMES[space]} "
                    f"acknowledges never-sent packet number {pn}",
                )
                return

        sp = self.spaces[space]
        before_largest = sp.largest_acked
        newly_acked, newly_lost = sp.process_ack(acked_pns, now, self.rtt)

        if frame.dropped_oldest:
            self._emit(
                "ack_ranges_truncated",
                space=SPACE_NAMES[space],
                dropped=frame.dropped_oldest,
            )

        if not newly_acked:
            # 纯重复 ACK:仍跑一次时间阈值检查
            newly_lost = sp.detect_lost_packets(now, self.rtt)
            self._process_losses(newly_lost)
            return

        # --- RTT 样本:取本空间最新被确认的包(最大包号) ---
        sample_pkt = max(newly_acked, key=lambda p: p.packet_number)
        latest_rtt = now - sample_pkt.time_sent
        # 需求 2:ACK delay 先按对端声明上限截断再扣(握手空间忽略 delay)
        self.rtt.update(
            latest_rtt=latest_rtt,
            ack_delay_ms=frame.ack_delay,
            now=now,
            is_handshake_space=sp.is_handshake,
        )
        self._emit(
            "rtt_sample",
            space=SPACE_NAMES[space],
            latest_rtt=latest_rtt,
            ack_delay_raw=frame.ack_delay,
            **{f"rtt_{k}": v for k, v in self.rtt.snapshot().items()},
        )

        for pkt in newly_acked:
            self.bytes_in_flight -= pkt.size
            self.cc.on_packet_acked(pkt, now, self.rtt.smoothed_rtt)
            self._emit(
                "packet_acked",
                space=SPACE_NAMES[space],
                packet_number=pkt.packet_number,
                time_sent=pkt.time_sent,
                rtt=now - pkt.time_sent,
                bytes_in_flight=self.bytes_in_flight,
                cwnd=self.cc.cwnd,
            )
            if pkt.is_probe:
                self._emit(
                    "probe_acked",
                    space=SPACE_NAMES[space],
                    packet_number=pkt.packet_number,
                )

        # 需求 3:收到推进 largest_acked 的新确认 -> 退避次数清零
        if before_largest is None or sample_pkt.packet_number > before_largest:
            if self.pto_count != 0:
                self._emit("pto_backoff_reset", pto_count=self.pto_count)
            self.pto_count = 0

        self._process_losses(newly_lost)
        self.pacer.update_rate(self.cc.cwnd, self.rtt.smoothed_rtt)
        # ACK 可能确认了最后一个在途包:立刻检查能否优雅关闭,
        # 否则此后没有任何定时器会再唤醒本端点
        self._maybe_graceful_close(now)

    def _process_losses(self, newly_lost: list[SentPacket]) -> None:
        if not newly_lost:
            return
        for pkt in newly_lost:
            self.bytes_in_flight -= pkt.size
            self._emit(
                "packet_lost",
                space=SPACE_NAMES[pkt.space],
                packet_number=pkt.packet_number,
                cause=pkt.loss_cause,
                time_sent=pkt.time_sent,
                bytes_in_flight=self.bytes_in_flight,
                cwnd=self.cc.cwnd,
            )
            rebuilt = self._rebuild_frame(pkt)
            if rebuilt is not None:
                # Initial 空间在握手确认后已丢弃,不再重传
                if pkt.space in self.discarded_spaces:
                    continue
                self.retransmit_queue.append((pkt.space, rebuilt))
                self._emit(
                    "retransmit_queued",
                    space=SPACE_NAMES[pkt.space],
                    packet_number=pkt.packet_number,
                    frame=rebuilt.kind,
                )

        labels = self.cc.on_packets_lost(newly_lost, self.now, self.rtt)
        for label in labels:
            self._emit(
                "congestion_event",
                label=label,
                lost_packets=[p.packet_number for p in newly_lost],
                algo=self.cc.name,
                **{
                    f"cc_{k}": v
                    for k, v in self.cc.snapshot().items()
                    if k != "name"
                },
            )
        self.pacer.update_rate(self.cc.cwnd, self.rtt.smoothed_rtt)
        # 丢包释放窗口后立刻允许补发
        self.pacer.reset(self.now)

    def _rebuild_frame(self, pkt: SentPacket) -> Frame | None:
        """按 SentPacket 记录重建需要重传的帧(ACK/PING 不重传)。"""
        if "CRYPTO" in pkt.frame_types:
            return Frame.crypto(self._crypto_payload(pkt.space), 0)
        if "STREAM" in pkt.frame_types:
            fin = (
                self.app_total_bytes is not None
                and pkt.app_offset + pkt.app_length >= self.app_total_bytes
            )
            return Frame.stream(pkt.app_offset, pkt.app_length, fin)
        return None

    # ------------------------------------------------------------------
    def _handle_crypto(self, frame: Frame, space: int) -> None:
        end = frame.offset + frame.length
        # 重传的 CRYPTO 帧保持原偏移(RFC 9000 §7.5);已收齐的部分直接忽略,
        # 只有越过连续区的新数据才是协议错误
        if end <= self.crypto_contiguous[space]:
            self._emit(
                "crypto_retransmit_ignored",
                space=SPACE_NAMES[space],
                offset=frame.offset,
                length=frame.length,
            )
            return
        if frame.offset != self.crypto_contiguous[space]:
            self._close(
                self.now,
                f"protocol_violation: unexpected CRYPTO offset {frame.offset} "
                f"(contiguous={self.crypto_contiguous[space]})",
            )
            return
        self.crypto_contiguous[space] = end

        if self.role == "server":
            if space == SPACE_INITIAL and self.state == STATE_INIT:
                # 收到 ClientInitial -> 可以发 ServerHandshake
                self.state = STATE_INITIAL
                self._emit("handshake_state", state=self.state)
            elif space == SPACE_HANDSHAKE and self.state == STATE_HANDSHAKE:
                # 收到 ClientHandshake -> 握手确认
                self._handshake_confirmed()
        else:
            # client 收到 ServerHandshake:先进入 handshake 状态(从而可以
            # 发出 ClientHandshake),再确认握手完成
            if space == SPACE_HANDSHAKE and self.state == STATE_INITIAL:
                self.state = STATE_HANDSHAKE
                self._emit("handshake_state", state=self.state)
                self._handshake_confirmed()

    def _handshake_confirmed(self) -> None:
        self.state = STATE_ESTABLISHED
        self._emit("handshake_state", state=self.state)
        # 丢弃 Initial 空间(RFC 9002 §6.2.1 / RFC 9000 §17.2.2.1)。
        # 必须彻底清空该空间的发送记录与在途计数:丢弃后该空间不再产生
        # 任何 PTO/丢包定时器,旧包也不能再占用 bytes_in_flight。
        sp = self.spaces[SPACE_INITIAL]
        for p in sp.sent_packets.values():
            if p.outstanding and p.in_flight:
                self.bytes_in_flight -= p.size
        self.spaces[SPACE_INITIAL] = SpaceRecovery(SPACE_INITIAL)
        self.pending_acks[SPACE_INITIAL] = RangeSet()
        self.ack_timer_start[SPACE_INITIAL] = None
        self.ack_pending_count[SPACE_INITIAL] = 0
        self.sent_pns[SPACE_INITIAL] = set()
        self.discarded_spaces.add(SPACE_INITIAL)
        # 清掉丢弃前已入队、但目标空间已失效的重传帧
        self.retransmit_queue = deque(
            (s, f) for (s, f) in self.retransmit_queue
            if s not in self.discarded_spaces
        )
        self._emit("space_discarded", space=SPACE_NAMES[SPACE_INITIAL])

    def _handle_stream(self, frame: Frame) -> None:
        if self.role != "server":
            return
        offset, length = frame.offset, frame.length

        if offset > self.recv_contiguous:
            # 乱序到达先入洞表(同偏移重复到达以先到为准)
            self.recv_holes.setdefault(offset, length)
            self._emit(
                "stream_out_of_order",
                offset=offset,
                length=length,
                contiguous=self.recv_contiguous,
            )
            return
        if offset < self.recv_contiguous:
            # 重传的旧数据:绝不重复交付(“恰好一次”)
            if offset + length <= self.recv_contiguous:
                self._emit(
                    "stream_duplicate_suppressed",
                    offset=offset,
                    length=length,
                )
                return
            overlap = self.recv_contiguous - offset
            offset = self.recv_contiguous
            length -= overlap
        self._deliver(offset, length)
        while self.recv_contiguous in self.recv_holes:
            hole_len = self.recv_holes.pop(self.recv_contiguous)
            self._deliver(self.recv_contiguous, hole_len)

        if frame.fin and (
            self._expected_app_bytes is None
            or self.recv_contiguous >= self._expected_app_bytes
        ):
            self._emit(
                "app_complete",
                delivered=self.recv_contiguous,
                segments=len(self.delivered_offsets),
            )

    def _deliver(self, offset: int, length: int) -> None:
        self.delivered_offsets.append((offset, length))
        self.recv_contiguous = offset + length
        self._emit(
            "app_deliver",
            offset=offset,
            length=length,
            contiguous=self.recv_contiguous,
        )

    # ==================================================================
    # 定时器:PTO / loss timer / ACK 定时器 / 节拍
    # ==================================================================
    def next_wakeup(self, now: float) -> float | None:
        if self.closed:
            return None
        candidates: list[float] = []

        # 1) PTO(存活的三个空间各自计算,取最早;已丢弃空间跳过)
        for sid, sp in self.spaces.items():
            if sid in self.discarded_spaces:
                continue
            dl = sp.pto_deadline(now, self.pto_count, self.rtt)
            if dl is not None:
                candidates.append(dl)

        # 2) 时间阈值 loss timer
        for sid, sp in self.spaces.items():
            if sid in self.discarded_spaces:
                continue
            if sp.loss_time is not None:
                candidates.append(sp.loss_time)

        # 3) ACK 定时器(max_ack_delay 后必须发出)
        for space, start in self.ack_timer_start.items():
            if space in self.discarded_spaces:
                continue
            if start is not None and len(self.pending_acks[space]) > 0:
                candidates.append(start + self.rtt.max_ack_delay)

        # 4) 发送节拍(还有数据要发且窗口允许)。
        #    节拍点在未来才需要唤醒;若节拍点已到/已过,本端点应当被“当前”
        #    事件驱动(wake/入包),不能把 now 自身当成新的唤醒时刻造成空转。
        if self._has_data_to_send() and self.cc.can_send(self.bytes_in_flight):
            if self.pacer.next_send_time > now + TIME_EPS:
                candidates.append(self.pacer.next_send_time)

        return min(candidates) if candidates else None

    def _has_data_to_send(self) -> bool:
        if self.closed:
            return False
        if self._has_crypto_to_send():
            return True
        if self.retransmit_queue:
            return True
        return (
            self.state == STATE_ESTABLISHED
            and self.role == "client"
            and not self.app_finished_sending
        )

    def wake(self, now: float) -> None:
        if self.closed:
            return
        self.now = now

        # 1) 时间阈值丢包检查(跳过已丢弃空间)
        for sid, sp in self.spaces.items():
            if sid in self.discarded_spaces:
                continue
            if sp.loss_time is not None and now + TIME_EPS >= sp.loss_time:
                lost = sp.detect_lost_packets(now, self.rtt)
                self._process_losses(lost)

        # 2) ACK 定时器
        for space, start in list(self.ack_timer_start.items()):
            if space in self.discarded_spaces:
                continue
            if start is not None and len(self.pending_acks[space]) > 0:
                if now + TIME_EPS >= start + self.rtt.max_ack_delay:
                    self._send_ack_only(space)

        # 3) PTO(需求 3:先发探测包,不直接判丢;连续超时指数退避)
        earliest_pto: float | None = None
        earliest_space: int | None = None
        for sid, sp in self.spaces.items():
            if sid in self.discarded_spaces:
                continue
            dl = sp.pto_deadline(now, self.pto_count, self.rtt)
            if dl is not None and (earliest_pto is None or dl < earliest_pto):
                earliest_pto, earliest_space = dl, sid
        if earliest_pto is not None and now + TIME_EPS >= earliest_pto:
            # 同一到期时刻只触发一次:_on_pto 会推进 pto_count,使下一次
            # pto_deadline 严格晚于 now,避免同刻重复发探测包撑爆在途计数
            self._on_pto(earliest_space, now)

        # 4) 节拍发送:每个节拍点发一个包,窗口或节拍不允许时停下
        guard = 0
        while guard < 10000:
            guard += 1
            if self.closed or not self._has_data_to_send():
                break
            if not self.cc.can_send(self.bytes_in_flight):
                break
            if not self.pacer.can_send_at(now):
                break
            sent = self._try_send()
            if sent is None:
                break

        # 5) 收尾
        self._maybe_graceful_close(now)

    def _on_pto(self, space: int, now: float) -> None:
        sp = self.spaces[space]
        duration = self.rtt.pto_duration(
            self.pto_count, include_max_ack_delay=not sp.is_handshake
        )
        self._emit(
            "pto_expired",
            space=SPACE_NAMES[space],
            pto_count=self.pto_count,
            backoff_duration=duration,
        )
        # 先发探测包,而不是直接判丢(RFC 9002 §6.2.4)。
        # 探测包是新的在途可确认包,会把本空间“最早在途发送时间”向后推,
        # 从而让下一个 PTO deadline 严格晚于 now。
        self._send_probe(space)
        # 指数退避:pto_count += 1,下一个 PTO 翻倍。
        # 退避指数封顶 PTO_MAX_EXPONENT:超过后倍数不再增长,但因为探测包
        # 已发出、最早在途时间推进,deadline 仍会前进,保持连接活性。
        if self.pto_count < PTO_MAX_EXPONENT:
            self.pto_count += 1
        self._emit("pto_backoff", pto_count=self.pto_count)

    def _send_probe(self, space: int) -> None:
        if space in self.discarded_spaces:
            # 理论上 PTO 选择已跳过丢弃空间;这里是最后一道防线
            return
        # 优先发该空间已排队的重传帧
        frame: Frame | None = None
        for idx, (qspace, qframe) in enumerate(self.retransmit_queue):
            if qspace == space:
                frame = qframe
                del self.retransmit_queue[idx]
                break
        retransmitted = frame is not None

        if frame is None:
            # 没有排队重传:重发该空间最早在途可确认包的数据;再不行发 PING
            earliest = None
            for pkt in self.spaces[space].sent_packets.values():
                if pkt.outstanding and pkt.ack_eliciting:
                    if earliest is None or pkt.time_sent < earliest.time_sent:
                        earliest = pkt
            if earliest is not None:
                frame = self._rebuild_frame(earliest)
            if frame is None:
                frame = Frame.ping()

        frames = [frame]
        self._maybe_attach_ack(space, frames)
        sp, pkt = self._new_packet(
            space, ack_eliciting=True, frames=frames, is_probe=True
        )
        self._emit_packet(sp, pkt)
        # 记录探测时间,供退避封顶后锚定下一个 PTO deadline
        sp.last_probe_time = self.now
        self._emit(
            "probe_sent",
            space=SPACE_NAMES[space],
            packet_number=pkt.packet_number,
            retransmitted=retransmitted,
        )
        self.trace({"type": "_wire", "packet": pkt})

    def _maybe_graceful_close(self, now: float) -> None:
        if self.closed or self.state != STATE_ESTABLISHED:
            return
        if self.role != "client" or not self.app_finished_sending:
            return
        in_flight = sum(sp.outstanding_bytes() for sp in self.spaces.values())
        if in_flight != 0:
            return
        frame = Frame.close("graceful: all app data acknowledged")
        self._maybe_attach_ack(SPACE_APPDATA, [frame])
        sp, pkt = self._new_packet(
            SPACE_APPDATA, ack_eliciting=False, frames=[frame]
        )
        sp.register_sent(
            SentPacket(
                packet_number=pkt.packet_number,
                space=SPACE_APPDATA,
                time_sent=now,
                size=pkt.size,
                ack_eliciting=False,
                in_flight=False,
                frame_types=("CONNECTION_CLOSE",),
            )
        )
        self.sent_pns[SPACE_APPDATA].add(pkt.packet_number)
        self.trace({"type": "_wire", "packet": pkt})
        self._close(now, "graceful: all app data acknowledged")

    def _close(self, now: float, reason: str) -> None:
        if self.closed:
            return
        self.state = STATE_CLOSED
        self.closed_reason = reason
        self.close_time = now
        self._emit("connection_closed", reason=reason)

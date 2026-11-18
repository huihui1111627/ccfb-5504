"""拥塞控制:持续拥塞判定(RFC 9002 附录 A.6)、NewReno、CUBIC(RFC 8312)。

需求 5:
- 先实现 NewReno 再实现 CUBIC,运行时可通过 ``CongestionControl.switch_to`` 切换;
- 判定为持续拥塞(persistent congestion)时,拥塞窗口降到 ``MINIMUM_WINDOW``。

窗口单位为字节,``MSS = MAX_DATAGRAM_SIZE``(仿真里每个包恰好一个 MSS)。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .constants import (
    CUBIC_BETA,
    CUBIC_C,
    GRANULARITY,
    INITIAL_RTT,
    LOSS_REDUCTION_FACTOR,
    MAX_DATAGRAM_SIZE,
    MINIMUM_WINDOW,
    PERSISTENT_CONGESTION_THRESHOLD,
)

MSS = MAX_DATAGRAM_SIZE
NEW_RENO = "newreno"
CUBIC = "cubic"


# ----------------------------------------------------------------------
# 持续拥塞 —— RFC 9002 附录 A.6
# ----------------------------------------------------------------------
def persistent_congestion_period(rtt_estimator) -> float:
    """persistent_congestion_period():3 * PTO 基准时长(不含退避)。"""
    if rtt_estimator.smoothed_rtt is None or rtt_estimator.rttvar is None:
        base = rtt_estimator.initial_rtt
    else:
        base = rtt_estimator.smoothed_rtt + max(
            4.0 * rtt_estimator.rttvar, GRANULARITY
        )
    # AppData 空间的 PTO 含 max_ack_delay;持续拥塞判定也包含它
    base += rtt_estimator.max_ack_delay
    return PERSISTENT_CONGESTION_THRESHOLD * base


def is_persistent_congestion(lost_packets: list, now: float, rtt_estimator) -> bool:
    """persistent_congestion_event() 的判定部分(附录 A.6 伪代码逐步对照)。

    入参 ``lost_packets`` 是同一次丢包事件中、自上一个被 ACK 的包之后
    所有判定丢失的 in-flight 包(调用方保证非空且全为 in-flight)。
    """
    if not lost_packets:
        return False
    period = persistent_congestion_period(rtt_estimator)
    # 伪代码:for each p in packets:if now - p.time_sent <= period:return false
    for pkt in lost_packets:
        if now - pkt.time_sent <= period:
            return False
    return True


# ----------------------------------------------------------------------
# 控制器基类
# ----------------------------------------------------------------------
@dataclass
class CongestionController:
    """所有拥塞控制器共用的状态与接口。"""

    name: str = "base"
    cwnd: float = MINIMUM_WINDOW
    ssthresh: float = float("inf")
    in_recovery: bool = False
    recovery_start_time: float = 0.0
    events: list = field(default_factory=list)  # 连接注入的 trace 回调

    def can_send(self, bytes_in_flight: float) -> bool:
        return bytes_in_flight < self.cwnd

    def on_packet_acked(self, pkt, now: float, smoothed_rtt: float | None) -> None:
        raise NotImplementedError

    def on_packets_lost(
        self, lost_packets: list, now: float, rtt_estimator
    ) -> list[str]:
        """返回本次触发的事件标签列表(供 trace 记录)。"""
        raise NotImplementedError

    def _enter_recovery(self, now: float, factor: float) -> list[str]:
        labels: list[str] = []
        if not self.in_recovery:
            self.ssthresh = max(self.cwnd * factor, 2.0 * MSS)
            self.cwnd = max(self.ssthresh, MINIMUM_WINDOW)
            self.in_recovery = True
            self.recovery_start_time = now
            labels.append("enter_recovery")
        return labels

    def _maybe_exit_recovery(self, pkt) -> bool:
        # 确认了恢复起点之后发出的包 -> 恢复结束(RFC 9002 §7.4 精神)
        if self.in_recovery and pkt.time_sent > self.recovery_start_time:
            self.in_recovery = False
            return True
        return False

    def snapshot(self) -> dict:
        return {
            "name": self.name,
            "cwnd": self.cwnd,
            "cwnd_packets": self.cwnd / MSS,
            "ssthresh": None if math.isinf(self.ssthresh) else self.ssthresh,
            "in_recovery": self.in_recovery,
        }


# ----------------------------------------------------------------------
# NewReno —— RFC 9002 §7.4(附录 A.3/A.4 的窗口增减语义)
# ----------------------------------------------------------------------
class NewReno(CongestionController):
    def __init__(self, events: list | None = None) -> None:
        super().__init__(name=NEW_RENO, events=events or [])

    def on_packet_acked(self, pkt, now: float, smoothed_rtt: float | None) -> None:
        exited = self._maybe_exit_recovery(pkt)
        if exited:
            self.events.append(("exit_recovery", now, self.snapshot()))
        # 恢复期间不增窗;恢复外每确认一个 MSS 增一个 MSS(§7.4)
        if not self.in_recovery and pkt.in_flight:
            self.cwnd += MSS

    def on_packets_lost(
        self, lost_packets: list, now: float, rtt_estimator
    ) -> list[str]:
        labels: list[str] = []
        in_flight_lost = [p for p in lost_packets if p.in_flight]
        if not in_flight_lost:
            return labels

        # 1) 持续拥塞优先:窗口直接打到最小值(附录 A.6)
        if is_persistent_congestion(in_flight_lost, now, rtt_estimator):
            self.cwnd = MINIMUM_WINDOW
            self.in_recovery = True
            self.recovery_start_time = now
            self.ssthresh = max(MINIMUM_WINDOW, 2.0 * MSS)
            labels.append("persistent_congestion")
            return labels

        # 2) 普通丢包:一次恢复窗口只减半一次(kPacketThreshold 触发的丢包
        #    在同一次 detect_loss 调用里成批到达,后续 ACK 若仍处于恢复期
        #    则不再减半)
        labels.extend(self._enter_recovery(now, LOSS_REDUCTION_FACTOR))
        return labels


# ----------------------------------------------------------------------
# CUBIC —— RFC 8312,配合 RFC 9002 §7.7
# ----------------------------------------------------------------------
class Cubic(CongestionController):
    def __init__(self, events: list | None = None) -> None:
        super().__init__(name=CUBIC, events=events or [])
        # RFC 8312 变量
        self.w_max: float = self.cwnd          # W_max
        self.w_est: float = 0.0                # W_est(TCP 友好项)
        self.k: float = 0.0                    # K,单位秒
        self.epoch_start: float | None = None  # 拥塞避免纪元起点(ms)
        self.origin_point: float = self.cwnd

    # --- RFC 8312 §4.1:丢包处理 ---
    def on_packets_lost(
        self, lost_packets: list, now: float, rtt_estimator
    ) -> list[str]:
        labels: list[str] = []
        in_flight_lost = [p for p in lost_packets if p.in_flight]
        if not in_flight_lost:
            return labels

        if is_persistent_congestion(in_flight_lost, now, rtt_estimator):
            # 持续拥塞:窗口降到最小值,W_max 也重置(RFC 9002 §7.6)
            self.w_max = MINIMUM_WINDOW
            self.origin_point = MINIMUM_WINDOW
            self.w_est = MINIMUM_WINDOW
            self.cwnd = MINIMUM_WINDOW
            self.ssthresh = MINIMUM_WINDOW
            self.epoch_start = None
            self.in_recovery = True
            self.recovery_start_time = now
            labels.append("persistent_congestion")
            return labels

        if not self.in_recovery:
            # RFC 8312 式(4):W_max = cwnd;式(7):W_est = cwnd*(1-beta)
            self.w_max = self.cwnd
            self.w_est = self.cwnd * (1.0 - CUBIC_BETA)
            self.ssthresh = self.w_est
            self.cwnd = max(MINIMUM_WINDOW, self.w_est)
            # 式(5):K = cbrt(W_max * beta / C)
            self.k = _cbrt(self.w_max * CUBIC_BETA / CUBIC_C)
            self.origin_point = self.w_max
            self.epoch_start = None  # 进入拥塞避免时惰性开启新纪元
            self.in_recovery = True
            self.recovery_start_time = now
            labels.append("enter_recovery")
        return labels

    # --- RFC 8312 §4.2/§4.3:ACK 处理 ---
    def on_packet_acked(self, pkt, now: float, smoothed_rtt: float | None) -> None:
        if self._maybe_exit_recovery(pkt):
            self.events.append(("exit_recovery", now, self.snapshot()))
        if not pkt.in_flight:
            return

        # 慢启动:cwnd < ssthresh 时每个 ACK 增一个 MSS
        if self.cwnd < self.ssthresh:
            self.cwnd += MSS
            return

        # 拥塞避免:惰性初始化纪元(RFC 8312 §4.3)
        if self.epoch_start is None:
            self.epoch_start = now
            self.origin_point = self.w_max
            # 纪元起点对齐当前窗口,避免时间跳变
            self.k = _cbrt(max(self.w_max - self.cwnd, 0.0) * MSS / (CUBIC_C * MSS))
            self.w_est = self.cwnd

        # 时间单位换算成秒(RFC 8312 的 C=0.4 以秒计)
        t = (now - self.epoch_start) / 1000.0
        rtt_s = (smoothed_rtt or INITIAL_RTT) / 1000.0

        # 式(1):W_cubic(t) = C*(t-K)^3 + W_max
        w_cubic = CUBIC_C * ((t - self.k) ** 3) * MSS + self.origin_point
        # 式(2)/式(3):TCP 友好估计 W_est
        self.w_est = (
            self.origin_point * (1.0 - CUBIC_BETA)
            + (3.0 * CUBIC_BETA / (1.0 + CUBIC_BETA))
            * (t / max(rtt_s, 1e-9))
            * MSS
        )
        # 式(8):取两者较大值作为目标窗口
        target = max(w_cubic, self.w_est)
        if target >= self.cwnd:
            self.cwnd = max(target, MINIMUM_WINDOW)

    def snapshot(self) -> dict:
        data = super().snapshot()
        data.update(
            {
                "w_max": self.w_max,
                "w_est": self.w_est,
                "k_s": self.k,
                "epoch_start": self.epoch_start,
            }
        )
        return data


def _cbrt(x: float) -> float:
    if x <= 0:
        return 0.0
    return x ** (1.0 / 3.0)


# ----------------------------------------------------------------------
# 运行时可切换的管理器
# ----------------------------------------------------------------------
class CongestionControl:
    """持有当前控制器;``switch_to`` 在运行中切换算法并保留当前窗口。"""

    def __init__(self, algo: str = NEW_RENO, event_sink=None) -> None:
        self._sink = event_sink
        self.events: list = []
        self.impl: CongestionController = self._make(algo)

    def _make(self, algo: str) -> CongestionController:
        if algo == NEW_RENO:
            return NewReno(events=self.events)
        if algo == CUBIC:
            return Cubic(events=self.events)
        raise ValueError(f"未知拥塞控制算法: {algo}")

    @property
    def name(self) -> str:
        return self.impl.name

    @property
    def cwnd(self) -> float:
        return self.impl.cwnd

    def can_send(self, bytes_in_flight: float) -> bool:
        return self.impl.can_send(bytes_in_flight)

    def switch_to(self, algo: str, now: float) -> None:
        if algo == self.impl.name:
            return
        old_cwnd = self.impl.cwnd
        old_ssthresh = self.impl.ssthresh
        new_impl = self._make(algo)
        # 保留当前窗口与慢启动阈值,切换不本身构成拥塞事件
        new_impl.cwnd = old_cwnd
        new_impl.ssthresh = old_ssthresh
        if isinstance(new_impl, Cubic):
            new_impl.w_max = max(old_cwnd, MINIMUM_WINDOW)
            new_impl.origin_point = new_impl.w_max
        self.impl = new_impl
        if self._sink is not None:
            self._sink(
                {
                    "type": "cc_switch",
                    "time": now,
                    "algo": algo,
                    "cwnd": old_cwnd,
                }
            )

    def on_packet_acked(self, pkt, now: float, smoothed_rtt: float | None) -> None:
        self.impl.on_packet_acked(pkt, now, smoothed_rtt)

    def on_packets_lost(
        self, lost_packets: list, now: float, rtt_estimator
    ) -> list[str]:
        return self.impl.on_packets_lost(lost_packets, now, rtt_estimator)

    def snapshot(self) -> dict:
        return self.impl.snapshot()

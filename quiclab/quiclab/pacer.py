"""发送节拍器(pacer)—— RFC 9002 §7.7。

需求 6:按节拍均匀发出,不一次把整个窗口的包都打出去。

pacing_rate = congestion_window * kPacingFactor / smoothed_rtt
相邻两个包的发送间隔 = MSS / pacing_rate
没有 RTT 样本时使用 INITIAL_RTT。
"""

from __future__ import annotations

from .constants import INITIAL_RTT, PACING_FACTOR
from .congestion import MSS


class Pacer:
    def __init__(self) -> None:
        self.next_send_time: float = 0.0
        self.pacing_rate: float | None = None  # 字节/毫秒

    def reset(self, now: float) -> None:
        self.next_send_time = now

    def update_rate(self, cwnd: float, smoothed_rtt: float | None) -> float:
        rtt = smoothed_rtt if smoothed_rtt else INITIAL_RTT
        # bytes/ms:窗口字节 * 1.25 / RTT(ms)
        self.pacing_rate = cwnd * PACING_FACTOR / max(rtt, 1e-9)
        return self.pacing_rate

    def packet_interval(self) -> float:
        if not self.pacing_rate:
            # 首个包之前:用初始 RTT 估算
            return MSS / (MSS * PACING_FACTOR / INITIAL_RTT)
        return MSS / self.pacing_rate

    def schedule_next(self, now: float) -> float:
        """记录一个包已发出,返回下一个包允许发送的最早时间。"""
        target = max(now, self.next_send_time)
        self.next_send_time = target + self.packet_interval()
        return self.next_send_time

    def can_send_at(self, now: float) -> bool:
        # 1e-9 容差,避免浮点边界让节拍点永远不可达
        return now + 1e-9 >= self.next_send_time

    def time_until_sendable(self, now: float) -> float:
        return max(0.0, self.next_send_time - now)

"""RTT 估计器 —— 严格对应 RFC 9002 §5 与附录 A.8。

维护三个量(需求 2):
- ``min_rtt``:       连接级最小 RTT;
- ``smoothed_rtt``:  指数平滑 RTT;
- ``rttvar``:        RTT 波动(平滑偏差)。

确认帧里携带的 ACK Delay 先按对端声明的 max_ack_delay 上限截断,再从
latest_rtt 中扣除(扣除后不低于 min_rtt,等价于规范的 max 判断)。
"""

from __future__ import annotations

from .constants import (
    ACK_DELAY_EXPONENT,
    GRANULARITY,
    INITIAL_RTT,
    MAX_ACK_DELAY,
    MIN_RTT_WINDOW,
    PTO_EXPONENT,
)


class RttEstimator:
    """RFC 9002 附录 A.8 的 RTT 状态机。"""

    def __init__(
        self,
        initial_rtt: float = INITIAL_RTT,
        max_ack_delay: float = MAX_ACK_DELAY,
        ack_delay_exponent: int = ACK_DELAY_EXPONENT,
    ) -> None:
        self.latest_rtt: float | None = None
        self.min_rtt: float | None = None
        self.smoothed_rtt: float | None = None
        self.rttvar: float | None = None
        self.initial_rtt = initial_rtt
        # 对端通过 transport parameter 声明的 ACK 延迟上限(ms)
        self.max_ack_delay = max_ack_delay
        self.ack_delay_exponent = ack_delay_exponent
        # min_rtt 最近一次被更新的时间
        self._min_rtt_timestamp: float | None = None

    # ------------------------------------------------------------------
    def decode_ack_delay(self, encoded: int) -> float:
        """RFC 9000 §19.3:ack_delay 字段以 2^ack_delay_exponent 微秒为单位。

        返回毫秒。
        """
        return encoded * (2 ** self.ack_delay_exponent) / 1000.0

    def clamp_ack_delay(self, ack_delay_ms: float) -> float:
        """ACK delay 按对端声明的 max_ack_delay 上限截断。

        对应 RFC 9002 §5.3:ack_delay 不得大于对端声明的 max_ack_delay。
        Initial/Handshake 空间的 ACK delay 由调用方直接传 0。
        """
        if ack_delay_ms < 0:
            return 0.0
        return min(ack_delay_ms, self.max_ack_delay)

    def update(
        self,
        latest_rtt: float,
        ack_delay_ms: float,
        now: float,
        is_handshake_space: bool,
    ) -> None:
        """处理一个 RTT 样本。逐步对应 RFC 9002 附录 A.8 update_rtt()。

        Parameters
        ----------
        latest_rtt:
            now - newly_acked_packet.time_sent(未扣 ACK delay 的原始样本)。
        ack_delay_ms:
            ACK 帧携带的确认延迟(调用方已解码成 ms)。
        now:
            当前仿真时间(ms)。
        is_handshake_space:
            样本是否来自 Initial/Handshake 包号空间;若是,忽略 ACK delay。
        """
        # 1) min_rtt 过期窗口(RFC 9002:min_rtt 在 kMinRttWindowLength 后失效)
        if (
            self._min_rtt_timestamp is not None
            and now - self._min_rtt_timestamp > MIN_RTT_WINDOW
        ):
            self.min_rtt = None
            self._min_rtt_timestamp = None

        self.latest_rtt = latest_rtt

        # 2) 更新 min_rtt
        if self.min_rtt is None or latest_rtt < self.min_rtt:
            self.min_rtt = latest_rtt
            self._min_rtt_timestamp = now

        # 3) ACK delay 截断(§5.3):握手空间忽略 ack delay
        effective_delay = 0.0
        if not is_handshake_space:
            effective_delay = self.clamp_ack_delay(ack_delay_ms)

        # 4) 第一个样本
        if self.smoothed_rtt is None or self.rttvar is None:
            self.smoothed_rtt = latest_rtt
            self.rttvar = latest_rtt / 2.0
            return

        # 5) adjusted_rtt = max(latest_rtt - ack_delay, min_rtt)
        adjusted_rtt = max(latest_rtt - effective_delay, self.min_rtt)

        # 6) rttvar 与 smoothed_rtt 的 EWMA(规范权重 1/8、7/8)
        self.rttvar = (3.0 / 4.0) * self.rttvar + (1.0 / 4.0) * abs(
            self.smoothed_rtt - adjusted_rtt
        )
        self.smoothed_rtt = (7.0 / 8.0) * self.smoothed_rtt + (1.0 / 8.0) * adjusted_rtt

    # ------------------------------------------------------------------
    def pto_duration(self, pto_count: int, include_max_ack_delay: bool) -> float:
        """RFC 9002 附录 A.7 set_loss_detection_timer() 中的 PTO 计算。

        duration = (smoothed_rtt + max(4*rttvar, granularity))
                   + max_ack_delay(仅 AppData 空间)
        退避由调用方乘 2^pto_count。
        """
        if self.smoothed_rtt is None or self.rttvar is None:
            duration = self.initial_rtt
        else:
            duration = self.smoothed_rtt + max(
                4.0 * self.rttvar, GRANULARITY
            )
        if include_max_ack_delay:
            duration += self.max_ack_delay
        return duration * (PTO_EXPONENT ** pto_count)

    def snapshot(self) -> dict:
        return {
            "latest_rtt": self.latest_rtt,
            "min_rtt": self.min_rtt,
            "smoothed_rtt": self.smoothed_rtt,
            "rttvar": self.rttvar,
        }

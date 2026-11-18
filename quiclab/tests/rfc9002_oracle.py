"""RFC 9002 附录伪代码独立 oracle,用于逐步对照判丢时机。

本模块是规范附录 A 的一份**独立重写**(不 import 生产代码的 recovery/
congestion),只保留附录里的常量与判定逻辑,作为对照基准。测试把同一串
“发送 / ACK / 时间推进”事件分别喂给 oracle 和生产实现,断言:
  1) 每个包被判丢的时刻完全相同;
  2) 触发原因(packet threshold / time threshold)完全相同;
  3) 持续拥塞判定结论相同。

参考:RFC 9002 Appendix A.2-A.8。
"""

from __future__ import annotations

# --- 附录 A.1 常量(独立字面量,故意不引用生产 constants) ---
ORACLE_PACKET_THRESHOLD = 3
ORACLE_TIME_THRESHOLD_NUM = 9
ORACLE_TIME_THRESHOLD_DEN = 8
ORACLE_GRANULARITY = 1.0
ORACLE_INITIAL_RTT = 333.0
ORACLE_PERSISTENT_PTO_MULTIPLIER = 3


class OraclePacket:
    def __init__(self, pn, time_sent, ack_eliciting=True):
        self.pn = pn
        self.time_sent = time_sent
        self.ack_eliciting = ack_eliciting
        self.acked = False
        self.lost = False
        self.loss_cause = None


class OracleRtt:
    """附录 A.8 的最小 RTT 状态(只保留判丢需要的 latest_rtt)。"""

    def __init__(self):
        self.latest_rtt = None
        self.smoothed_rtt = None
        self.rttvar = None
        self.min_rtt = None

    def update(self, latest_rtt, now):
        self.latest_rtt = latest_rtt
        if self.min_rtt is None or latest_rtt < self.min_rtt:
            self.min_rtt = latest_rtt
        if self.smoothed_rtt is None:
            self.smoothed_rtt = latest_rtt
            self.rttvar = latest_rtt / 2.0
        else:
            adjusted = max(latest_rtt, self.min_rtt)  # oracle 里不扣 ack delay
            self.rttvar = 0.75 * self.rttvar + 0.25 * abs(
                self.smoothed_rtt - adjusted
            )
            self.smoothed_rtt = 0.875 * self.smoothed_rtt + 0.125 * adjusted

    def pto_duration(self, pto_count):
        if self.smoothed_rtt is None:
            duration = ORACLE_INITIAL_RTT
        else:
            duration = self.smoothed_rtt + max(
                4.0 * self.rttvar, ORACLE_GRANULARITY
            )
        return duration * (2 ** pto_count)


class OracleSpace:
    """附录 A.2/A.5 的单空间丢包判定参考实现。"""

    def __init__(self):
        self.sent = {}
        self.largest_acked = None
        self.loss_time = None

    def on_sent(self, pkt: OraclePacket):
        self.sent[pkt.pn] = pkt

    def on_ack(self, pns, now, rtt: OracleRtt):
        """附录 A.4 OnAckReceivedRange + A.5 detect_lost_packets。

        返回本轮新判丢的 [(pn, cause), ...],顺序与生产实现对齐(按包号升序)。
        """
        for pn in pns:
            if self.largest_acked is None or pn > self.largest_acked:
                self.largest_acked = pn
            if pn in self.sent:
                self.sent[pn].acked = True

        lost = []
        self.loss_time = None
        if self.largest_acked is None:
            return lost

        latest = rtt.latest_rtt if rtt.latest_rtt is not None else ORACLE_INITIAL_RTT
        time_threshold = (
            latest * ORACLE_TIME_THRESHOLD_NUM / ORACLE_TIME_THRESHOLD_DEN
        )

        # 附录 A.5 的遍历:unacked 包按包号升序
        for pn in sorted(self.sent):
            pkt = self.sent[pn]
            if pkt.acked or pkt.lost or not pkt.ack_eliciting:
                continue
            # 伪代码先判包号阈值
            if self.largest_acked - pkt.pn > ORACLE_PACKET_THRESHOLD:
                pkt.lost = True
                pkt.loss_cause = "packet_threshold"
                lost.append((pkt.pn, "packet_threshold"))
                continue
            # 再判时间阈值
            if now - pkt.time_sent > time_threshold:
                pkt.lost = True
                pkt.loss_cause = "time_threshold"
                lost.append((pkt.pn, "time_threshold"))
            else:
                expire = pkt.time_sent + time_threshold
                if self.loss_time is None or expire < self.loss_time:
                    self.loss_time = expire
        return lost

    def detect_on_timer(self, now, rtt):
        """loss timer 到期时的时间阈值检查,返回新判丢列表。"""
        lost = []
        self.loss_time = None
        if self.largest_acked is None:
            return lost
        latest = rtt.latest_rtt if rtt.latest_rtt is not None else ORACLE_INITIAL_RTT
        time_threshold = (
            latest * ORACLE_TIME_THRESHOLD_NUM / ORACLE_TIME_THRESHOLD_DEN
        )
        for pn in sorted(self.sent):
            pkt = self.sent[pn]
            if pkt.acked or pkt.lost or not pkt.ack_eliciting:
                continue
            if self.largest_acked - pkt.pn > ORACLE_PACKET_THRESHOLD:
                pkt.lost = True
                pkt.loss_cause = "packet_threshold"
                lost.append((pkt.pn, "packet_threshold"))
                continue
            if now - pkt.time_sent > time_threshold:
                pkt.lost = True
                pkt.loss_cause = "time_threshold"
                lost.append((pkt.pn, "time_threshold"))
            else:
                expire = pkt.time_sent + time_threshold
                if self.loss_time is None or expire < self.loss_time:
                    self.loss_time = expire
        return lost

    def persistent_congestion(self, lost_pns, now, rtt):
        """附录 A.6:所有丢包的发送时间都早于 now - 3*PTO 基准。"""
        period = ORACLE_PERSISTENT_PTO_MULTIPLIER * rtt.pto_duration(0)
        for pn in lost_pns:
            pkt = self.sent[pn]
            if now - pkt.time_sent <= period:
                return False
        return True

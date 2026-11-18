"""需求 5:NewReno 与 CUBIC、运行时切换、持续拥塞降到最小窗口。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.congestion import (
    CUBIC,
    MSS,
    MINIMUM_WINDOW,
    CongestionControl,
    NewReno,
    is_persistent_congestion,
)
from quiclab.recovery import SentPacket
from quiclab.rtt import RttEstimator


def mk_packet(pn, t):
    return SentPacket(
        packet_number=pn, space=2, time_sent=t, size=int(MSS),
        ack_eliciting=True, in_flight=True,
    )


def test_newreno_slow_start_growth():
    cc = CongestionControl("newreno")
    initial = cc.cwnd
    # 恢复外每确认一个 MSS,窗口增一个 MSS
    for pn in range(5):
        cc.on_packet_acked(mk_packet(pn, float(pn)), now=float(pn),
                           smoothed_rtt=100.0)
    assert abs(cc.cwnd - (initial + 5 * MSS)) < 1e-9
    print("OK NewReno 恢复期外每 ACK 增一个 MSS")


def test_newreno_halves_window_once_per_recovery():
    cc = CongestionControl("newreno")
    # 先把窗口涨上去
    for pn in range(10):
        cc.on_packet_acked(mk_packet(pn, float(pn)), float(pn), 100.0)
    before = cc.cwnd
    lost = [mk_packet(20, 100.0)]
    rtt = RttEstimator()
    rtt.update(100.0, 0.0, 100.0, False)
    labels = cc.on_packets_lost(lost, now=200.0, rtt_estimator=rtt)
    assert "enter_recovery" in labels
    assert abs(cc.cwnd - max(before * 0.5, MINIMUM_WINDOW)) < 1e-9
    # 同一次恢复期内再次丢包不再减半
    cc.on_packets_lost([mk_packet(21, 101.0)], 201.0, rtt)
    assert abs(cc.cwnd - max(before * 0.5, MINIMUM_WINDOW)) < 1e-9
    print("OK NewReno 一次恢复窗口只减半一次, cwnd =", round(cc.cwnd, 1))


def test_persistent_congestion_floor():
    cc = CongestionControl("newreno")
    for pn in range(10):
        cc.on_packet_acked(mk_packet(pn, float(pn)), float(pn), 100.0)
    rtt = RttEstimator()
    rtt.update(100.0, 0.0, 100.0, False)
    # 构造极老的丢包(发送时间远超 3*PTO),触发持续拥塞
    old_lost = [mk_packet(30, 0.0)]
    labels = cc.on_packets_lost(old_lost, now=100000.0, rtt_estimator=rtt)
    assert "persistent_congestion" in labels
    assert abs(cc.cwnd - MINIMUM_WINDOW) < 1e-9
    print("OK 持续拥塞窗口降到最小值", MINIMUM_WINDOW)


def test_cubic_switch_preserves_window():
    cc = CongestionControl("newreno")
    for pn in range(8):
        cc.on_packet_acked(mk_packet(pn, float(pn)), float(pn), 100.0)
    window_before = cc.cwnd
    cc.switch_to("cubic", now=500.0)
    assert cc.name == CUBIC
    # 切换本身不改变窗口
    assert abs(cc.cwnd - window_before) < 1e-9
    # 切换后 CUBIC 仍能正常处理 ACK
    cc.on_packet_acked(mk_packet(40, 501.0), 501.0, 100.0)
    assert cc.cwnd > 0
    print("OK 运行时切换到 CUBIC 且保留当前窗口", round(cc.cwnd, 1))


def test_cubic_then_back_to_newreno():
    cc = CongestionControl("cubic")
    cc.on_packet_acked(mk_packet(0, 0.0), 0.0, 100.0)
    cc.switch_to("newreno", now=100.0)
    assert cc.name == "newreno"
    rtt = RttEstimator(); rtt.update(100.0, 0.0, 100.0, False)
    labels = cc.on_packets_lost([mk_packet(5, 50.0)], 200.0, rtt)
    assert "enter_recovery" in labels
    print("OK CUBIC->NewReno 切换后丢包恢复逻辑正常")


def test_cubic_loss_sets_beta_window():
    cc = CongestionControl("cubic")
    for pn in range(12):
        cc.on_packet_acked(mk_packet(pn, float(pn)), float(pn), 100.0)
    before = cc.cwnd
    rtt = RttEstimator(); rtt.update(100.0, 0.0, 100.0, False)
    # 非持续拥塞的普通丢包(近期包)
    cc.on_packets_lost([mk_packet(50, 190.0)], 200.0, rtt)
    # RFC 8312 式(7):W_est = W_cubic * (1-β),β=0.7 -> 乘 0.3,且不低于最小窗口
    assert abs(cc.cwnd - max(before * (1 - 0.7), MINIMUM_WINDOW)) < 1e-6
    print("OK CUBIC 普通丢包窗口 ×(1-β)=0.3, cwnd =", round(cc.cwnd, 1))


if __name__ == "__main__":
    test_newreno_slow_start_growth()
    test_newreno_halves_window_once_per_recovery()
    test_persistent_congestion_floor()
    test_cubic_switch_preserves_window()
    test_cubic_then_back_to_newreno()
    test_cubic_loss_sets_beta_window()
    print("\n所有需求 5 拥塞控制测试通过")

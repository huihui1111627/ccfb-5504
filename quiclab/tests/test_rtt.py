"""需求 2:RTT 维护 min/smoothed/rttvar;ACK delay 按对端声明上限截断后再扣。

数值逐步对照 RFC 9002 附录 A.8 的 update_rtt() 伪代码。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.rtt import RttEstimator


def test_first_sample():
    rtt = RttEstimator(max_ack_delay=25.0)
    rtt.update(latest_rtt=200.0, ack_delay_ms=10.0, now=1000.0,
               is_handshake_space=False)
    # 第一个样本:smoothed = latest, rttvar = latest/2
    assert rtt.latest_rtt == 200.0
    assert rtt.min_rtt == 200.0
    assert rtt.smoothed_rtt == 200.0
    assert rtt.rttvar == 100.0
    print("OK 首个样本: smoothed=latest, rttvar=latest/2")


def test_min_rtt_tracking():
    rtt = RttEstimator(max_ack_delay=25.0)
    for sample in (300.0, 250.0, 400.0, 180.0, 260.0):
        rtt.update(sample, 0.0, sample * 10, False)
    assert rtt.min_rtt == 180.0
    print("OK min_rtt 持续保持历史最小值:", rtt.min_rtt)


def test_ack_delay_clamped_to_max():
    # 对端声明 max_ack_delay=25ms,但 ACK 帧带了 100ms delay
    rtt = RttEstimator(max_ack_delay=25.0)
    rtt.update(300.0, 0.0, 1000.0, False)       # 建立基线
    # 第二个样本:latest=300,delay=100 -> 截断为 25
    rtt.update(300.0, 100.0, 2000.0, False)
    # adjusted = max(300 - 25, min_rtt=300) = 300(被 min_rtt 托底)
    # 若没有截断,adjusted = max(200, 300) 仍是 300;这里换一个能区分的样本
    rtt2 = RttEstimator(max_ack_delay=25.0)
    rtt2.update(300.0, 0.0, 1000.0, False)
    rtt2.update(330.0, 100.0, 2000.0, False)
    # 截断:adjusted = max(330-25, 300) = 305
    # 不截断(错误):adjusted = max(330-100, 300) = 300
    assert rtt2.smoothed_rtt > 300.0, "ACK delay 截断应当生效"
    print("OK ACK delay 100ms 被截断到 25ms 后再扣除, smoothed =",
          round(rtt2.smoothed_rtt, 3))


def test_handshake_space_ignores_ack_delay():
    rtt = RttEstimator(max_ack_delay=25.0)
    rtt.update(300.0, 0.0, 1000.0, True)
    # 握手空间:即使带了 delay 也忽略
    rtt.update(330.0, 100.0, 2000.0, True)
    # adjusted = 330(不扣 delay),而非 max(330-25, 300)=305
    expected = 0.875 * 300 + 0.125 * 330
    assert abs(rtt.smoothed_rtt - expected) < 1e-9
    print("OK 握手空间忽略 ACK delay, smoothed =", round(rtt.smoothed_rtt, 3))


def test_ewma_weights():
    # 对照 RFC 9002: rttvar = 3/4 old + 1/4 |S-adj|; S = 7/8 old + 1/8 adj
    rtt = RttEstimator(max_ack_delay=25.0)
    rtt.update(200.0, 0.0, 1000.0, False)
    rtt.update(220.0, 0.0, 2000.0, False)
    # min=200, adjusted=max(220-0, 200)=220
    expected_s = 0.875 * 200 + 0.125 * 220
    expected_var = 0.75 * 100 + 0.25 * abs(200 - 220)
    assert abs(rtt.smoothed_rtt - expected_s) < 1e-9
    assert abs(rtt.rttvar - expected_var) < 1e-9
    print("OK EWMA 权重 7/8、3/4 与规范一致")


def test_pto_duration_and_backoff():
    rtt = RttEstimator(max_ack_delay=25.0)
    rtt.update(200.0, 0.0, 1000.0, False)
    # smoothed=200, rttvar=100
    base = rtt.pto_duration(pto_count=0, include_max_ack_delay=True)
    # 200 + max(4*100, 1) + 25 = 625
    assert abs(base - 625.0) < 1e-9
    # 退避 pto_count=2 -> ×4
    backed = rtt.pto_duration(2, True)
    assert abs(backed - 625.0 * 4) < 1e-9
    # 握手空间不含 max_ack_delay:200 + 400 = 600
    hs = rtt.pto_duration(0, False)
    assert abs(hs - 600.0) < 1e-9
    print("OK PTO 时长、指数退避、握手空间不含 ack_delay")


if __name__ == "__main__":
    test_first_sample()
    test_min_rtt_tracking()
    test_ack_delay_clamped_to_max()
    test_handshake_space_ignores_ack_delay()
    test_ewma_weights()
    test_pto_duration_and_backoff()
    print("\n所有需求 2 RTT 估计测试通过")

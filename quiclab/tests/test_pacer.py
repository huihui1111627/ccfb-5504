"""需求 6:发送按节拍均匀发出,不一次把整个窗口的包打出去。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.pacer import Pacer


def test_pacer_spreads_packets():
    pacer = Pacer()
    # cwnd = 10 包,RTT = 100ms
    cwnd = 10 * 1200.0
    pacer.update_rate(cwnd, smoothed_rtt=100.0)
    pacer.reset(0.0)
    times = []
    now = 0.0
    for _ in range(10):
        assert pacer.can_send_at(now), "节拍点应当可发"
        nxt = pacer.schedule_next(now)
        times.append(nxt)
        now = nxt
    # 相邻发送时刻严格递增 -> 没有一次性打出整个窗口
    for a, b in zip(times, times[1:]):
        assert b > a
    # 间隔为正且近似均匀(方差很小)
    intervals = [b - a for a, b in zip(times, times[1:])]
    mean = sum(intervals) / len(intervals)
    assert all(abs(i - mean) < 1e-9 for i in intervals), "节拍间隔应当均匀"
    assert mean > 0
    print(f"OK 10 个包均匀铺开, 固定间隔 {mean:.3f}ms")


def test_pacer_rate_formula():
    pacer = Pacer()
    # pacing_rate = cwnd * 1.25 / rtt
    rate = pacer.update_rate(12000.0, smoothed_rtt=100.0)
    expected_rate = 12000.0 * 1.25 / 100.0
    assert abs(rate - expected_rate) < 1e-9
    # 包间隔 = MSS / rate
    pacer.reset(0.0)
    interval = pacer.packet_interval()
    assert abs(interval - 1200.0 / expected_rate) < 1e-9
    print(f"OK pacer 速率 = cwnd*1.25/RTT, 包间隔 {interval:.3f}ms")


def test_pacer_blocks_before_deadline():
    pacer = Pacer()
    pacer.update_rate(12000.0, 100.0)
    pacer.reset(1000.0)
    pacer.schedule_next(1000.0)  # 下一个节拍点 > 1000
    assert not pacer.can_send_at(1000.0 + 1e-12), "节拍点之前不能发送"
    assert pacer.can_send_at(pacer.next_send_time), "节拍点到达后可发送"
    print("OK 节拍点之前阻塞,到达后放行")


if __name__ == "__main__":
    test_pacer_spreads_packets()
    test_pacer_rate_formula()
    test_pacer_blocks_before_deadline()
    print("\n所有需求 6 发送节拍测试通过")

"""需求 4 集成验证:真实连接在高乱序下生成的 ACK 帧会限制区间数并丢最旧。

不依赖随机丢包,直接向 server 注入一批间隔很大的包,迫使其待确认集合
产生远超 MAX_ACK_RANGES 的区间,再检查发出的 ACK 帧。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.connection import Connection
from quiclab.constants import MAX_ACK_RANGES, SPACE_APPDATA
from quiclab.frames import Frame, WirePacket


def make_server():
    events = []
    conn = Connection(
        conn_id="server",
        role="server",
        peer_id="client",
        rng_seq=iter(range(10_000_000)).__next__,
        trace=events.append,
        expected_app_bytes=10 ** 9,
    )
    return conn, events


def test_ack_frame_truncates_oldest_ranges():
    # 直接在待确认集合里累积超过上限的区间(模拟 ACK 延迟期间高乱序到达),
    # 再触发一次 ACK 发送,验证线上 ACK 帧确实截断并丢弃最旧区间
    conn, events = make_server()
    n_ranges = MAX_ACK_RANGES + 10
    for i in range(n_ranges):
        conn.pending_acks[SPACE_APPDATA].add(i * 3)
        conn.ack_pending_count[SPACE_APPDATA] += 1
    conn.ack_timer_start[SPACE_APPDATA] = 1000.0
    conn.now = 2000.0

    before_ranges = len(conn.pending_acks[SPACE_APPDATA])
    assert before_ranges == n_ranges
    conn._send_ack_only(SPACE_APPDATA)

    ack_sends = [
        e for e in events
        if e.get("type") == "packet_sent" and "ACK" in (e.get("frames") or [])
    ]
    assert len(ack_sends) == 1
    # 丢弃的最旧区间数 = 输入区间数 - 上限
    assert ack_sends[0]["ack_dropped_oldest"] == n_ranges - MAX_ACK_RANGES
    # 发送后待确认集合被清空
    assert len(conn.pending_acks[SPACE_APPDATA]) == 0
    print(
        f"OK {n_ranges} 个区间的 ACK 帧截断到 {MAX_ACK_RANGES}, "
        f"丢弃最旧 {n_ranges - MAX_ACK_RANGES} 个"
    )


def test_ack_ranges_are_disjoint_and_sorted():
    # 区间并集的合并与降序排列是 RangeSet/编码器的纯语义,直接验证
    from quiclab.rangeset import RangeSet, encode_ack_ranges
    rs = RangeSet()
    for pn in (0, 1, 2, 10, 11, 20):
        rs.add(pn)
    # 区间并集应合并为 [(0,2),(10,11),(20,20)]
    assert rs.ranges == [(0, 2), (10, 11), (20, 20)]
    ordered = encode_ack_ranges(list(rs), MAX_ACK_RANGES)
    # 降序
    assert ordered == [(20, 20), (10, 11), (0, 2)]
    print("OK 相邻包合并为区间, ACK 帧按包号降序排列")


if __name__ == "__main__":
    test_ack_frame_truncates_oldest_ranges()
    test_ack_ranges_are_disjoint_and_sorted()
    print("\n需求 4 集成测试通过")

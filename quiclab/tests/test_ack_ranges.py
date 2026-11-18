"""需求 4:ACK 帧用区间表示,最多带 MAX_ACK_RANGES 个区间,超出丢最旧。

同时验证 RFC 9000 §19.3 的 gap/length 编解码互逆。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.constants import MAX_ACK_RANGES
from quiclab.rangeset import (
    RangeSet,
    decode_gap_lengths,
    encode_ack_ranges,
    encode_gap_lengths,
)


def test_rangeset_merge():
    rs = RangeSet()
    rs.add(0)
    rs.add(1)
    rs.add(2)
    assert rs.ranges == [(0, 2)]
    rs.add(5)
    rs.add(6)
    assert rs.ranges == [(0, 2), (5, 6)]
    # 相邻区间合并
    rs.add(3)
    rs.add(4)
    assert rs.ranges == [(0, 6)]
    # 包含关系
    rs.add(2, 3)
    assert rs.ranges == [(0, 6)]
    print("OK RangeSet 合并/相邻/包含")


def test_truncation_drops_oldest():
    rs = RangeSet()
    # 构造 MAX_ACK_RANGES + 5 个互不相邻的区间
    for i in range(MAX_ACK_RANGES + 5):
        rs.add(i * 10)
    assert len(rs) == MAX_ACK_RANGES + 5
    ordered = encode_ack_ranges(list(rs), MAX_ACK_RANGES)
    assert len(ordered) == MAX_ACK_RANGES
    # 降序排列,最大区间在前
    assert ordered[0][1] > ordered[-1][1]
    # 被丢掉的是最旧(包号最小)的 5 个区间
    smallest_kept = ordered[-1][0]
    dropped_starts = [i * 10 for i in range(5)]
    assert all(d < smallest_kept for d in dropped_starts)
    # 最大的区间一定保留
    assert ordered[0] == ((MAX_ACK_RANGES + 4) * 10, (MAX_ACK_RANGES + 4) * 10)
    print(f"OK 区间截断: 输入 {MAX_ACK_RANGES + 5} -> 保留 {MAX_ACK_RANGES}, 丢弃最旧 5 个")


def test_wire_codec_roundtrip():
    ranges = [(100, 110), (80, 85), (60, 62), (40, 40)]
    ordered = encode_ack_ranges(ranges, MAX_ACK_RANGES)
    frame = encode_gap_lengths(ordered)
    assert frame["largest_acknowledged"] == 110
    decoded = decode_gap_lengths(frame)
    assert decoded == ordered, f"编解码不一致: {decoded} != {ordered}"
    print("OK RFC 9000 §19.3 gap/length 编解码互逆")


def test_gap_values():
    # 手工核对一个简单例子:区间 [10,12] 和 [5,6]
    ordered = [(10, 12), (5, 6)]
    frame = encode_gap_lengths(ordered)
    assert frame["largest_acknowledged"] == 12
    assert frame["first_ack_range"] == 2  # 12-10
    # gap = 10 - 6 - 2 = 2
    assert frame["ack_ranges"][0]["gap"] == 2
    # length = 6 - 5 = 1
    assert frame["ack_ranges"][0]["length"] == 1
    print("OK gap/length 手工数值核对")


if __name__ == "__main__":
    test_rangeset_merge()
    test_truncation_drops_oldest()
    test_wire_codec_roundtrip()
    test_gap_values()
    print("\n所有需求 4 ACK 区间测试通过")

"""ACK 区间集合与 RFC 9000 §19.3 ACK Frame 编码。

本仿真不真正走 UDP 字节线,但 ACK 帧的区间结构严格按 RFC 9000 §19.3 的
语义编码(首区间 + ACK Range 数组,Range 用 Gap + 长度表示),以便和规范
逐步对照。区间用 Python 元组 ``(start, end)`` 表示,两端均为闭区间。

规则要点(需求 4):
- 一个 ACK 帧最多携带 ``MAX_ACK_RANGES`` 个区间;
- 区间太多时丢弃最旧(包号最小)的区间。
"""

from __future__ import annotations

from .constants import MAX_ACK_RANGES


class RangeSet:
    """维护已确认包号的闭区间并集,支持插入、合并、询问包含关系。

    内部始终保持 ``ranges`` 升序且互不相邻/相交。
    """

    __slots__ = ("ranges",)

    def __init__(self, ranges: list[tuple[int, int]] | None = None) -> None:
        self.ranges: list[tuple[int, int]] = []
        if ranges:
            for start, end in ranges:
                self.add(start, end)

    def add(self, start: int, end: int | None = None) -> None:
        """加入闭区间 [start, end](end 缺省表示单点 start)。"""
        if end is None:
            end = start
        if start > end:
            raise ValueError(f"非法区间: ({start}, {end})")
        new_ranges: list[tuple[int, int]] = []
        inserted = False
        for r_start, r_end in self.ranges:
            if r_end < start - 1:
                # 当前区间在新区间左侧,不相交
                new_ranges.append((r_start, r_end))
            elif r_start > end + 1:
                # 当前区间在新区间右侧:先放新区间(只放一次),再放当前区间
                if not inserted:
                    new_ranges.append((start, end))
                    inserted = True
                new_ranges.append((r_start, r_end))
            else:
                # 相交或相邻,合并
                start = min(start, r_start)
                end = max(end, r_end)
        if not inserted:
            new_ranges.append((start, end))
        self.ranges = new_ranges

    def contains(self, packet_number: int) -> bool:
        for start, end in self.ranges:
            if start <= packet_number <= end:
                return True
        return False

    def largest(self) -> int | None:
        """最大的已确认包号。"""
        return self.ranges[-1][1] if self.ranges else None

    def smallest(self) -> int | None:
        """最小的已确认包号。"""
        return self.ranges[0][0] if self.ranges else None

    def copy(self) -> "RangeSet":
        rs = RangeSet()
        rs.ranges = list(self.ranges)
        return rs

    def __len__(self) -> int:
        return len(self.ranges)

    def __iter__(self):
        return iter(self.ranges)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, RangeSet) and self.ranges == other.ranges

    def __repr__(self) -> str:
        return f"RangeSet({self.ranges!r})"


def encode_ack_ranges(
    ranges: list[tuple[int, int]], max_ranges: int = MAX_ACK_RANGES
) -> list[tuple[int, int]]:
    """把区间并集转成 ACK 帧携带的区间列表。

    返回降序排列的闭区间列表(最大区间在前,与 RFC 9000 §19.3 的
    Largest Acknowledged / First ACK Range / ACK Range 顺序一致)。

    区间数超过 ``max_ranges`` 时丢弃最旧(包号最小)的区间,并在
    返回值之外由调用方通过长度变化感知截断。
    """
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda r: r[0], reverse=True)
    if len(ordered) > max_ranges:
        # 丢掉最旧的:保留包号最大的 max_ranges 个区间
        ordered = ordered[:max_ranges]
    return ordered


def ack_frame_packet_count(ranges: list[tuple[int, int]]) -> int:
    """ACK 帧区间列表一共覆盖了多少个包号。"""
    return sum(end - start + 1 for start, end in ranges)


def encode_gap_lengths(ordered_ranges: list[tuple[int, int]]) -> dict:
    """严格按 RFC 9000 §19.3 的字段语义做一次结构化编码。

    Returns
    -------
    dict 包含:
      - largest_acknowledged: 最大确认包号
      - first_ack_range:      最大区间长度 - 1
      - ack_ranges:           [{"gap": g, "length": len-1}, ...] 按线序
    """
    if not ordered_ranges:
        raise ValueError("空 ACK 区间无法编码")
    largest = ordered_ranges[0][1]
    first_range_len = largest - ordered_ranges[0][0]
    wire_ranges: list[dict] = []
    for i in range(1, len(ordered_ranges)):
        prev_smallest = ordered_ranges[i - 1][0]
        cur_largest = ordered_ranges[i][1]
        gap = prev_smallest - cur_largest - 2
        length = cur_largest - ordered_ranges[i][0]
        if gap < 0:
            raise ValueError("ACK 区间非法:gap 为负")
        wire_ranges.append({"gap": gap, "length": length})
    return {
        "largest_acknowledged": largest,
        "first_ack_range": first_range_len,
        "ack_ranges": wire_ranges,
    }


def decode_gap_lengths(frame: dict) -> list[tuple[int, int]]:
    """RFC 9000 §19.3 解码,返回降序闭区间列表,与 encode_gap_lengths 互逆。"""
    largest = frame["largest_acknowledged"]
    first_end = largest
    first_start = largest - frame["first_ack_range"]
    ranges = [(first_start, first_end)]
    prev_smallest = first_start
    for part in frame["ack_ranges"]:
        cur_largest = prev_smallest - part["gap"] - 2
        cur_smallest = cur_largest - part["length"]
        ranges.append((cur_smallest, cur_largest))
        prev_smallest = cur_smallest
    return ranges

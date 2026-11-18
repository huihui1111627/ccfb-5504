"""QUIC 帧与线上数据包的数据结构(仿真用,不做真实字节编解码)。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Frame:
    kind: str  # CRYPTO / STREAM / ACK / PING / CONNECTION_CLOSE
    # CRYPTO / STREAM
    offset: int | None = None
    length: int = 0
    fin: bool = False
    data: str | None = None
    # ACK
    ack_ranges: tuple = ()          # 降序闭区间 ((start,end),...)
    ack_delay: float = 0.0          # 解码后的毫秒值
    encoded_ack_delay: int = 0      # 线上整型字段(2^ack_delay_exponent 微秒单位)
    dropped_oldest: int = 0         # 本 ACK 帧因区间上限丢弃的最旧区间数
    # CONNECTION_CLOSE
    reason: str | None = None

    @staticmethod
    def crypto(data: str, offset: int = 0) -> "Frame":
        return Frame(kind="CRYPTO", offset=offset, length=len(data), data=data)

    @staticmethod
    def stream(offset: int, length: int, fin: bool = False) -> "Frame":
        return Frame(kind="STREAM", offset=offset, length=length, fin=fin)

    @staticmethod
    def ack(
        ordered_ranges: list[tuple[int, int]],
        ack_delay: float,
        encoded_ack_delay: int,
        dropped_oldest: int = 0,
    ) -> "Frame":
        return Frame(
            kind="ACK",
            ack_ranges=tuple(ordered_ranges),
            ack_delay=ack_delay,
            encoded_ack_delay=encoded_ack_delay,
            dropped_oldest=dropped_oldest,
        )

    @staticmethod
    def ping() -> "Frame":
        return Frame(kind="PING")

    @staticmethod
    def close(reason: str) -> "Frame":
        return Frame(kind="CONNECTION_CLOSE", reason=reason)


@dataclass
class WirePacket:
    """链路上传输的一个数据包(一个数据报恰好装一个 QUIC 包)。"""

    packet_number: int
    space: int
    frames: list[Frame]
    size: int
    ack_eliciting: bool
    src: int
    dst: int
    sent_time: float = 0.0
    # 仿真辅助:发送方记录用的元数据(接收方不应依赖)
    is_probe: bool = False
    seq: int = 0  # 全局发送序号,用于确定性排序

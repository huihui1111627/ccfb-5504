"""quiclab — 按 QUIC 规范(RFC 9000/9002)实现的丢包恢复与拥塞控制传输库。

模块划分
--------
- rangeset:   ACK 区间集合(RFC 9000 §19.3 编码)
- rtt:        RTT 估计:min_rtt / smoothed_rtt / rttvar(RFC 9002 §5,附录 A.8)
- congestion: NewReno(RFC 9002 §7.4)与 CUBIC(RFC 8312)、持续拥塞判定(附录 A.6)
- pacer:      按节拍均匀发送(RFC 9002 §7.7 pacer 公式)
- recovery:   每个包号空间独立的丢包恢复与 PTO(RFC 9002 §6,附录 A.2-A.5)
- connection: 三个包号空间(Initial/Handshake/App-Data)的连接实体
"""

__all__ = [
    "rangeset",
    "rtt",
    "congestion",
    "pacer",
    "recovery",
    "connection",
]

__version__ = "1.0.0"

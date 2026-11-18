"""需求 8:对端确认了一个从没发过的包号时,立即关闭连接并记下原因。

通过直接向 Connection 注入一个携带“幽灵包号”的 ACK 帧来验证,
不依赖随机丢包,结果完全确定。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.connection import Connection, STATE_CLOSED
from quiclab.constants import SPACE_APPDATA, SPACE_INITIAL
from quiclab.frames import Frame, WirePacket


def make_conn(role="client"):
    events = []
    conn = Connection(
        conn_id=role,
        role=role,
        peer_id="peer",
        rng_seq=iter(range(10_000_000)).__next__,
        trace=events.append,
        app_total_bytes=1200 * 5,
    )
    return conn, events


def test_phantom_ack_closes_connection():
    conn, events = make_conn("client")
    # 直接构造一个确认 AppData 空间 PN=999 的 ACK 帧(该包号从未发送)
    phantom = Frame.ack(
        ordered_ranges=[(999, 999)],
        ack_delay=0.0,
        encoded_ack_delay=0,
    )
    pkt = WirePacket(
        packet_number=0,
        space=SPACE_APPDATA,
        frames=[phantom],
        size=1200,
        ack_eliciting=False,
        src="peer",
        dst="client",
    )
    conn.on_datagram(pkt, now=100.0)

    assert conn.state == STATE_CLOSED, "幽灵 ACK 必须立即关闭连接"
    assert conn.closed_reason is not None
    assert "never-sent packet number 999" in conn.closed_reason
    close_events = [e for e in events if e["type"] == "connection_closed"]
    assert len(close_events) == 1
    assert "999" in close_events[0]["reason"]
    print("OK phantom ACK -> closed:", conn.closed_reason)


def test_phantom_ack_in_initial_space():
    conn, events = make_conn("server")
    phantom = Frame.ack([(42, 42)], 0.0, 0)
    pkt = WirePacket(
        packet_number=0,
        space=SPACE_INITIAL,
        frames=[phantom],
        size=1200,
        ack_eliciting=False,
        src="peer",
        dst="server",
    )
    conn.on_datagram(pkt, now=50.0)
    assert conn.state == STATE_CLOSED
    assert "initial" in conn.closed_reason and "42" in conn.closed_reason
    print("OK phantom ACK in initial space -> closed:", conn.closed_reason)


def test_legitimate_ack_does_not_close():
    # 正常 ACK 一个确实发过的包号不应触发关闭
    conn, events = make_conn("client")
    conn.now = 0.0
    conn.wake(0.0)  # 发出 ClientInitial(pn 0)
    # 服务端回 ACK 确认 initial pn 0(确实发过)
    ack = Frame.ack([(0, 0)], 0.0, 0)
    pkt = WirePacket(
        packet_number=0,
        space=SPACE_INITIAL,
        frames=[ack],
        size=1200,
        ack_eliciting=False,
        src="peer",
        dst="client",
    )
    conn.on_datagram(pkt, now=400.0)
    assert conn.state != STATE_CLOSED, "合法 ACK 不应关闭连接"
    print("OK legitimate ACK keeps connection alive, state =", conn.state)


if __name__ == "__main__":
    test_phantom_ack_closes_connection()
    test_phantom_ack_in_initial_space()
    test_legitimate_ack_does_not_close()
    print("\n所有需求 8 协议违例测试通过")

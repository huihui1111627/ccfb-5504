"""故障注入:构造“对端确认从未发送过的包号”的确定性场景(需求 8 演示)。

做法:在正常引擎跑到握手完成后,直接向 client 注入一个携带幽灵包号的 ACK
数据包(走完整的 on_datagram 入口),断言连接立即关闭并在 trace 中记录原因。
"""

from __future__ import annotations

from ..frames import Frame, WirePacket
from .engine import Engine
from .scenario import violation_scenario
from .trace import TraceCollector

PHANTOM_SPACE = 2       # AppData
PHANTOM_PACKET_NUMBER = 99999


def run_violation_demo() -> tuple[dict, dict]:
    sc = violation_scenario()
    collector = TraceCollector(sc)
    engine = Engine(sc, collector)

    # 先让引擎正常跑到 client 建立连接(发出若干应用包)
    client = engine.client
    # 手动推进若干轮:直接驱动 client 发包、server 回应,直到 established
    engine._schedule(0.0, "wake", "client")
    import heapq
    from .engine import EV_WAKE, EV_WIRE, EV_STOP

    engine._schedule(60_000.0, EV_STOP, None)
    n = 0
    injected = False
    while engine._heap and n < 100000:
        ev = heapq.heappop(engine._heap)
        engine.now = ev.time
        n += 1
        if ev.kind == EV_STOP:
            break
        if ev.kind == EV_WIRE:
            engine._handle_wire(ev.payload)
        elif ev.kind == EV_WAKE:
            engine._handle_wake(ev.payload)
        engine._reschedule_wakes()

        # client 一建立连接且已发出 AppData 包,就注入幽灵 ACK
        if (
            not injected
            and client.state == "established"
            and client.sent_pns[PHANTOM_SPACE]
        ):
            phantom_ack = Frame.ack(
                ordered_ranges=[(PHANTOM_PACKET_NUMBER, PHANTOM_PACKET_NUMBER)],
                ack_delay=0.0,
                encoded_ack_delay=0,
            )
            evil_pkt = WirePacket(
                packet_number=engine._seq(),
                space=PHANTOM_SPACE,
                frames=[phantom_ack],
                size=1200,
                ack_eliciting=False,
                src="server",
                dst="client",
            )
            client.on_datagram(evil_pkt, engine.now)
            injected = True
            collector(
                {
                    "type": "fault_injection",
                    "sim_time": round(engine.now, 6),
                    "detail": f"phantom ACK for never-sent pn "
                    f"{PHANTOM_PACKET_NUMBER} in appdata space",
                }
            )
            break

    assert injected, "故障注入未发生"
    assert client.closed, "client 应当因幽灵 ACK 立即关闭"
    result = engine.result()
    result["violation_injected"] = True
    result["client_reason"] = client.closed_reason
    trace = collector.export(result)
    return result, trace

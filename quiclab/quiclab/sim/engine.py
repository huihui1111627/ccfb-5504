"""离散事件仿真引擎。

事件堆按 (time, seq) 排序,seq 全局单调递增,保证同一时刻的事件顺序
也完全确定 —— 同场景同种子跑两遍,事件序列与 trace 逐字节一致。
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

from ..connection import Connection
from ..frames import WirePacket
from .link import Link
from .rng import LinkRng

# 事件类型
EV_WIRE = "wire"          # 数据包到达对端
EV_WAKE = "wake"          # 端点定时唤醒
EV_SWITCH = "switch_cc"   # 运行时切换拥塞控制算法
EV_STOP = "stop"          # 仿真结束


@dataclass(order=True)
class _HeapEvent:
    time: float
    seq: int
    kind: str = field(compare=False)
    payload: object = field(compare=False, default=None)


class Engine:
    def __init__(
        self,
        scenario,
        trace_collector,
    ) -> None:
        self.scenario = scenario
        self.trace = trace_collector
        self.now = 0.0
        self._heap: list[_HeapEvent] = []
        self._seq_counter = 0

        # 两条单向链路(方向以 client/server 命名)
        self.link_c2s = Link(
            scenario.link_client_to_server,
            LinkRng(scenario.seed, "c2s"),
        )
        self.link_s2c = Link(
            scenario.link_server_to_client,
            LinkRng(scenario.seed, "s2c"),
        )

        def seq_fn():
            v = self._seq_counter
            self._seq_counter += 1
            return v

        self._seq = seq_fn
        self.client = Connection(
            conn_id="client",
            role="client",
            peer_id="server",
            rng_seq=seq_fn,
            trace=self._on_trace,
            app_total_bytes=scenario.app_bytes,
            initial_algo=scenario.initial_cc,
            max_ack_delay=scenario.max_ack_delay,
        )
        self.server = Connection(
            conn_id="server",
            role="server",
            peer_id="client",
            rng_seq=seq_fn,
            trace=self._on_trace,
            expected_app_bytes=scenario.app_bytes,
            initial_algo=scenario.initial_cc,
            max_ack_delay=scenario.max_ack_delay,
        )
        self.conns = {"client": self.client, "server": self.server}

        # 拥塞控制切换计划:[(time, target_algo), ...]
        for t, algo in scenario.cc_schedule:
            self._schedule(t, EV_SWITCH, (t, algo))

        self._stop_scheduled = False
        # 每个连接已压栈但尚未触发的唤醒时刻集合,防止重复调度
        self._pending_wakes: dict[str, set[float]] = {
            "client": set(),
            "server": set(),
        }

    # ------------------------------------------------------------------
    def _on_trace(self, event: dict) -> None:
        if event.get("type") == "_wire":
            self._transmit(event["packet"])
            return
        event.setdefault("sim_time", round(self.now, 6))
        self.trace(event)

    def _schedule(self, time: float, kind: str, payload=None) -> None:
        # 不允许把事件排到“过去”:定时器可能在连接获得发送资格前就持有
        # 旧时间戳(如 pacer 初始值 0),钳制到当前时刻保证时钟单调
        if time < self.now:
            time = self.now
        heapq.heappush(self._heap, _HeapEvent(time, self._seq(), kind, payload))

    def _transmit(self, pkt: WirePacket) -> None:
        link = self.link_c2s if pkt.src == "client" else self.link_s2c
        dropped, reason = link.should_drop()
        self.trace(
            {
                "type": "link_decision",
                "sim_time": round(self.now, 6),
                "conn_id": pkt.src,
                "space": pkt.space,
                "packet_number": pkt.packet_number,
                "decision": "drop" if dropped else "forward",
                "drop_reason": reason,
                "link_state": link.state,
            }
        )
        if dropped:
            return
        delay = link.one_way_delay()
        pkt.sent_time = self.now
        self._schedule(self.now + delay, EV_WIRE, pkt)

    # ------------------------------------------------------------------
    def run(self) -> dict:
        # 初始唤醒:让 client 发出 Initial
        self._schedule(0.0, EV_WAKE, "client")
        self._schedule(self.scenario.max_sim_time, EV_STOP, None)

        while self._heap:
            ev = heapq.heappop(self._heap)
            self.now = ev.time
            if ev.kind == EV_STOP:
                self.trace(
                    {
                        "type": "sim_stop",
                        "sim_time": round(self.now, 6),
                        "reason": "max_sim_time",
                    }
                )
                break
            if ev.kind == EV_WIRE:
                self._handle_wire(ev.payload)
            elif ev.kind == EV_WAKE:
                self._handle_wake(ev.payload)
            elif ev.kind == EV_SWITCH:
                self._handle_switch(ev.payload)

            if self._check_finished():
                self.trace(
                    {
                        "type": "sim_stop",
                        "sim_time": round(self.now, 6),
                        "reason": "connection_finished",
                    }
                )
                break

            self._reschedule_wakes()
        return self.result()

    # ------------------------------------------------------------------
    def _handle_wire(self, pkt: WirePacket) -> None:
        dst = self.conns[pkt.dst]
        link = self.link_c2s if pkt.dst == "server" else self.link_s2c
        link.delivered += 1
        dst.on_datagram(pkt, self.now)

    def _handle_wake(self, conn_id: str) -> None:
        conn = self.conns[conn_id]
        # 唤醒已触发,从待处理集合移除所有不晚于当前时刻的条目
        due = {t for t in self._pending_wakes[conn_id] if t <= self.now + 1e-9}
        self._pending_wakes[conn_id] -= due
        conn.wake(self.now)

    def _handle_switch(self, payload: tuple[float, str]) -> None:
        t, algo = payload
        for conn in self.conns.values():
            conn.cc.switch_to(algo, self.now)

    def _reschedule_wakes(self) -> None:
        for conn_id, conn in self.conns.items():
            nxt = conn.next_wakeup(self.now)
            if nxt is None:
                continue
            # 注意:不能在这里按 now 清理 pending_wakes —— 同一时刻可能已有
            # 多个入堆但尚未弹出的唤醒,误删会导致每次 wake 都重新压入
            # 同时刻事件形成空转。去重完全依赖 pending 集合的成员判断。
            key = round(nxt, 9)
            if key in self._pending_wakes[conn_id]:
                continue
            self._pending_wakes[conn_id].add(key)
            self._schedule(nxt, EV_WAKE, conn_id)

    def _check_finished(self) -> bool:
        # 双方都关闭
        if self.client.closed and self.server.closed:
            return True
        # 传输目标达成:client 已优雅关闭(全部数据被确认)且 server 已收齐
        # 应用字节。最后一跳 CLOSE 帧可能丢失,不影响“送达且恰好一次”结论
        if (
            self.client.closed
            and self.server.recv_contiguous >= (self.scenario.app_bytes or 0)
        ):
            return True
        return False

    # ------------------------------------------------------------------
    def result(self) -> dict:
        delivered = self.server.delivered_offsets
        # “恰好一次”校验:重组后每个字节位置恰好出现一次
        covered = [0] * (self.scenario.app_bytes or 0)
        for offset, length in delivered:
            for i in range(offset, offset + length):
                if 0 <= i < len(covered):
                    covered[i] += 1
        exactly_once = bool(covered) and all(c == 1 for c in covered)
        total = sum(covered)
        return {
            "scenario": self.scenario.name,
            "seed": self.scenario.seed,
            "sim_time": self.now,
            "client_closed": self.client.closed,
            "server_closed": self.server.closed,
            "client_reason": self.client.closed_reason,
            "server_reason": self.server.closed_reason,
            "app_expected": self.scenario.app_bytes,
            "app_delivered_bytes": total,
            "app_delivered_segments": len(delivered),
            "exactly_once": exactly_once,
            "all_bytes_covered": total == self.scenario.app_bytes,
            "link_c2s": self.link_c2s.stats(),
            "link_s2c": self.link_s2c.stats(),
            "final_client": self.client.snapshot(),
            "final_server": self.server.snapshot(),
        }

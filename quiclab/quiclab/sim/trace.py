"""Trace 收集与 JSON 导出。

一次仿真的全部事件按发生顺序存入 ``TraceCollector``,运行结束后导出为
自描述 JSON,供可视化页面直接加载。所有浮点数保留固定位数,保证同场景
同种子两次运行导出的文件内容完全一致。
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path

from ..frames import Frame, WirePacket

TRACE_VERSION = 1


class TraceCollector:
    def __init__(self, scenario) -> None:
        self.scenario = scenario
        self.events: list[dict] = []

    def __call__(self, event: dict) -> None:
        # 引擎内部事件(线上数据包)不进 trace,由引擎转换为 link_decision
        if event.get("type") == "_wire":
            return
        self.events.append(_jsonable(event))

    def export(self, result: dict) -> dict:
        packet_events = [
            e for e in self.events
            if e["type"] in ("packet_sent", "packet_received", "packet_lost",
                             "packet_acked", "packet_duplicate")
        ]
        rtt_events = [e for e in self.events if e["type"] == "rtt_sample"]
        cc_events = [
            e for e in self.events
            if e["type"] in ("congestion_event", "cc_switch")
        ]
        pto_events = [
            e for e in self.events
            if e["type"] in ("pto_expired", "pto_backoff", "pto_backoff_reset",
                             "probe_sent", "probe_acked", "probe_received")
        ]
        app_events = [
            e for e in self.events
            if e["type"] in ("app_deliver", "app_complete", "stream_out_of_order",
                             "stream_duplicate_suppressed")
        ]
        return {
            "trace_version": TRACE_VERSION,
            "scenario": self.scenario.to_dict(),
            "result": result,
            "summary": {
                "total_events": len(self.events),
                "packet_events": len(packet_events),
                "rtt_samples": len(rtt_events),
                "cc_events": len(cc_events),
                "pto_events": len(pto_events),
                "app_events": len(app_events),
            },
            "events": self.events,
        }

    def write_json(self, path: str | Path, result: dict) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = self.export(result)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return path


def _jsonable(obj):
    """把 dataclass/Frame 等递归转成 JSON 可序列化结构。"""
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, WirePacket):
        return {
            "packet_number": obj.packet_number,
            "space": obj.space,
            "frames": [_jsonable(f) for f in obj.frames],
            "size": obj.size,
            "ack_eliciting": obj.ack_eliciting,
            "src": obj.src,
            "dst": obj.dst,
            "sent_time": round(obj.sent_time, 6),
            "is_probe": obj.is_probe,
            "seq": obj.seq,
        }
    if isinstance(obj, Frame):
        return asdict(obj)
    if is_dataclass(obj):
        return _jsonable(asdict(obj))
    if isinstance(obj, float):
        return round(obj, 9)
    return obj

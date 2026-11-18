#!/usr/bin/env python3
"""命令行入口:批量跑场景、可复现性检查、启动可视化页面。

用法
----
python run_scenarios.py run [--out traces] [--filter 名称片段]
python run_scenarios.py repro        # 同场景同种子跑两遍逐字节比对
python run_scenarios.py web [--port 8000] [--traces traces]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from quiclab.sim.runner import (  # noqa: E402
    reproducibility_check,
    run_all,
    run_and_save,
)
from quiclab.sim.fault_injection import run_violation_demo  # noqa: E402
from quiclab.sim.scenario import build_scenarios, violation_scenario  # noqa: E402


def cmd_run(args) -> int:
    scenarios = build_scenarios()
    if args.filter:
        scenarios = [s for s in scenarios if args.filter in s.name]
    results = run_all(args.out, scenarios)
    ok = all(r["exactly_once"] and r["all_bytes_covered"] for r in results)
    print(f"运行 {len(results)} 个场景,输出目录: {args.out}")
    for r in results:
        flag = "OK " if (r["exactly_once"] and r["all_bytes_covered"]) else "FAIL"
        print(
            f"  [{flag}] {r['scenario']:<32} seed={r['seed']:<5} "
            f"delivered={r['app_delivered_bytes']}/{r['app_expected']} "
            f"time={r['sim_time']:.1f}ms"
        )
    # 违例场景:注入幽灵 ACK,期望连接被立即关闭
    import json as _json
    from pathlib import Path as _Path
    v_result, v_trace = run_violation_demo()
    v_dir = _Path(args.out) / "violation"
    v_dir.mkdir(parents=True, exist_ok=True)
    v_path = v_dir / "protocol_violation_phantom_ack.json"
    v_path.write_text(
        _json.dumps(v_trace, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(f"违例场景 trace: {v_path}")
    print(f"  client_reason={v_result['client_reason']!r}")
    assert v_result["client_closed"], "幽灵 ACK 必须导致 client 立即关闭"
    return 0 if ok else 1


def cmd_repro(args) -> int:
    scenarios = build_scenarios()
    if args.filter:
        scenarios = [s for s in scenarios if args.filter in s.name]
    all_ok = True
    for sc in scenarios:
        ok, detail = reproducibility_check(sc)
        all_ok &= ok
        print(f"[{'OK ' if ok else 'FAIL'}] {sc.name} (seed={sc.seed}) {detail}")
    return 0 if all_ok else 1


def cmd_web(args) -> None:
    from web.server import serve

    serve(port=args.port, traces_dir=args.traces)


def main() -> int:
    parser = argparse.ArgumentParser(description="quiclab 仿真与可视化")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="批量运行场景")
    p_run.add_argument("--out", default="traces")
    p_run.add_argument("--filter", default=None)
    p_run.set_defaults(func=cmd_run)

    p_repro = sub.add_parser("repro", help="同场景同种子两遍一致性检查")
    p_repro.add_argument("--filter", default=None)
    p_repro.set_defaults(func=cmd_repro)

    p_web = sub.add_parser("web", help="启动可视化页面")
    p_web.add_argument("--port", type=int, default=8000)
    p_web.add_argument("--traces", default="traces")
    p_web.set_defaults(func=cmd_web)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

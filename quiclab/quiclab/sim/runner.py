"""场景运行入口:单场景运行 + 批量运行 + 可复现性校验。"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from .engine import Engine
from .scenario import Scenario, build_scenarios
from .trace import TraceCollector


def run_once(scenario: Scenario) -> tuple[dict, dict]:
    """运行一个场景,返回 (result, trace_dict)。"""
    collector = TraceCollector(scenario)
    engine = Engine(scenario, collector)
    result = engine.run()
    trace = collector.export(result)
    return result, trace


def run_and_save(scenario: Scenario, out_dir: str | Path) -> tuple[dict, Path]:
    result, trace = run_once(scenario)
    out = Path(out_dir) / f"{scenario.name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(trace, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return result, out


def run_all(out_dir: str | Path, scenarios: list[Scenario] | None = None) -> list[dict]:
    scenarios = scenarios or build_scenarios()
    out_dir = Path(out_dir)
    results = []
    for sc in scenarios:
        result, path = run_and_save(sc, out_dir)
        result["trace_path"] = str(path)
        results.append(result)
    # 汇总清单
    manifest = {
        "scenario_count": len(results),
        "scenarios": [
            {
                "name": r["scenario"],
                "seed": r["seed"],
                "exactly_once": r["exactly_once"],
                "all_bytes_covered": r["all_bytes_covered"],
                "sim_time": r["sim_time"],
                "client_reason": r["client_reason"],
                "server_reason": r["server_reason"],
            }
            for r in results
        ],
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return results


def reproducibility_check(scenario: Scenario) -> tuple[bool, dict]:
    """同一场景同一参数跑两遍,比对 trace 与结果是否完全相同。"""
    sc1 = copy.deepcopy(scenario)
    sc2 = copy.deepcopy(scenario)
    r1, t1 = run_once(sc1)
    r2, t2 = run_once(sc2)
    same_result = json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)
    same_trace = json.dumps(t1, sort_keys=True) == json.dumps(t2, sort_keys=True)
    return (same_result and same_trace), {
        "same_result": same_result,
        "same_trace": same_trace,
        "scenario": scenario.name,
        "seed": scenario.seed,
    }

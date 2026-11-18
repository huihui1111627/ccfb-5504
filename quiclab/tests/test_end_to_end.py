"""端到端:几十组带种子场景,验证每个应用字节最终送达且只交付一次。

需求原文:“用几十组带种子的场景验证每个包最终送达且只交给应用一次”。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.sim.runner import reproducibility_check, run_once
from quiclab.sim.scenario import build_scenarios


def test_all_scenarios_deliver_exactly_once():
    scenarios = build_scenarios()
    assert len(scenarios) >= 30, f"场景数应至少 30,实际 {len(scenarios)}"
    failures = []
    for sc in scenarios:
        result, trace = run_once(sc)
        if not (result["exactly_once"] and result["all_bytes_covered"]):
            failures.append((sc.name, result))
            continue
        # 额外核对:交付段拼接后无缝覆盖 [0, app_bytes)
        server = result["final_server"]
        assert server["app_delivered"] == sc.app_bytes
    assert not failures, f"以下场景未通过恰好一次校验: {[f[0] for f in failures]}"
    print(f"OK {len(scenarios)} 个场景全部: 全字节覆盖 + 恰好交付一次")


def test_determinism_across_duplicate_runs():
    # 抽样若干代表性场景做两遍一致性(全量在 run_scenarios.py repro 里跑)
    sample_names = [
        "baseline_clean_0",
        "random_loss_10pct",
        "burst_loss_2",
        "persistent_congestion",
        "cc_switch_newreno_to_cubic",
        "repro_seed_2001",
    ]
    scenarios = {s.name: s for s in build_scenarios()}
    for name in sample_names:
        ok, detail = reproducibility_check(scenarios[name])
        assert ok, f"{name} 两遍运行不一致: {detail}"
        assert detail["same_trace"] and detail["same_result"]
    print(f"OK {len(sample_names)} 个抽样场景同种子两遍 trace/result 逐字节一致")


def test_two_loss_causes_both_present_in_trace():
    # 时间线上两种丢包原因要能分开出现
    result, trace = run_once(
        next(s for s in build_scenarios() if s.name == "persistent_congestion")
    )
    causes = {
        e.get("cause")
        for e in trace["events"]
        if e.get("type") == "packet_lost"
    }
    assert "packet_threshold" in causes, "缺少包号阈值丢包标记"
    assert "time_threshold" in causes, "缺少时间阈值丢包标记"
    print("OK 时间线同时包含两种丢包原因标记:", causes)


if __name__ == "__main__":
    test_all_scenarios_deliver_exactly_once()
    test_determinism_across_duplicate_runs()
    test_two_loss_causes_both_present_in_trace()
    print("\n所有端到端交付/可复现测试通过")

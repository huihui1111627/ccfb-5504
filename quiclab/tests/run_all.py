#!/usr/bin/env python3
"""统一测试入口:依次运行全部单元测试、oracle 对照、端到端与可复现校验。

用法: python3 -I tests/run_all.py
"""

import importlib.util
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

TEST_MODULES = [
    "test_ack_ranges",
    "test_ack_integration",
    "test_rtt",
    "test_pacer",
    "test_congestion",
    "test_spaces_pto",
    "test_loss_oracle",
    "test_protocol_violation",
    "test_end_to_end",
]


def load(name: str):
    spec = importlib.util.spec_from_file_location(
        name, HERE / f"{name}.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    failures = []
    for name in TEST_MODULES:
        print(f"\n{'=' * 70}\n▶ {name}\n{'=' * 70}")
        mod = load(name)
        runners = [
            getattr(mod, n)
            for n in dir(mod)
            if n.startswith("test_") and callable(getattr(mod, n))
        ]
        for fn in runners:
            try:
                fn()
            except Exception:  # noqa: BLE001
                failures.append((name, fn.__name__))
                traceback.print_exc()
    print(f"\n{'=' * 70}")
    if failures:
        print(f"失败 {len(failures)} 项:")
        for m, fn in failures:
            print(f"  - {m}.{fn}")
        return 1
    print("✅ 全部测试通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

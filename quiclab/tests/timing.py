import sys, time
sys.path.insert(0, '.')
from quiclab.sim.scenario import build_scenarios
from quiclab.sim.runner import run_once

names = sys.argv[1:] or [s.name for s in build_scenarios()]
all_ok = True
t_start = time.time()
for name in names:
    sc = next((s for s in build_scenarios() if s.name == name), None)
    if sc is None:
        print("UNKNOWN", name, flush=True)
        continue
    t0 = time.time()
    r, tr = run_once(sc)
    ok = r["exactly_once"] and r["all_bytes_covered"]
    all_ok &= ok
    print(f"[{'OK ' if ok else 'FAIL'}] {name:28s} {time.time()-t0:5.2f}s "
          f"ev={len(tr['events']):6d} sim={r['sim_time']:9.1f}ms "
          f"{r['app_delivered_bytes']}/{r['app_expected']}", flush=True)
print(f"--- total {time.time()-t_start:.1f}s all_ok={all_ok}", flush=True)

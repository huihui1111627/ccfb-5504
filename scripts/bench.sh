#!/usr/bin/env bash
# 压测：开 N 个模拟后端 + 长连接压测客户端，压测中途动态增减后端，
# 最终输出三大指标：
#   1) 被迫断开连接比例 (forced_disconnect_ratio)
#   2) 各后端负载是否均匀 (active 连接分布)
#   3) 转发增加延迟 p99 (relay_p99_us) / 建连 p99 / UDP RTT p99
#
# 用法: scripts/bench.sh [后端数] [长连接数] [持续秒]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug"
LOGDIR="$ROOT/bench-logs"
mkdir -p "$LOGDIR"

BACKENDS="${1:-12}"
CONNS="${2:-3000}"
DURATION="${3:-45}"
BASE_TCP=9300
BASE_UDP=9300
ADMIN=127.0.0.1:8090
LB_TCP=9400
LB_UDP=9401

pids=()
api() { curl -s --max-time 8 "http://$ADMIN$1" || true; }
apipost() { curl -s --max-time 8 -X POST "http://$ADMIN$1" -H 'content-type: application/json' -d "$2" || true; }

# ---------- 生成配置 ----------
# ---------- 生成配置 ----------
CFG="$(mktemp -t exam_lb_bench).toml"
cleanup() {
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 0.2
  for p in "${pids[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  rm -f "${CFG:-}"
}
trap cleanup EXIT
cat > "$CFG" <<EOF
workers = 0
[admin]
listen = "$ADMIN"
control_socket = "/tmp/exam-lb-bench.sock"
pid_file = "/tmp/exam-lb-bench.pid"
[prewarm]
pool_idle_per_worker = 2
[health]
interval_secs = 2
timeout_secs = 1
fall = 2
rise = 2
[drain]
deadline_secs = 20
recover_step = 0.2
recover_tick_secs = 1
backup_threshold = 0.35
[[listeners]]
name = "tcp"
protocol = "tcp"
listen = "127.0.0.1:$LB_TCP"
proxy_protocol = "off"
[[listeners]]
name = "udp"
protocol = "udp"
listen = "127.0.0.1:$LB_UDP"
EOF

# 前 2/3 主组，后 1/3 备组
N_PRIMARY=$(( BACKENDS * 2 / 3 ))
for i in $(seq 0 $((BACKENDS - 1))); do
  port=$((BASE_TCP + i))
  if [ "$i" -lt "$N_PRIMARY" ]; then group="primary"; else group="backup"; fi
  cat >> "$CFG" <<EOF
[[backends]]
id = "be$i"
addr = "127.0.0.1:$port"
weight = 100
group = "$group"
capacity = 100000
check = "off"
EOF
done

# ---------- 启动后端 ----------
echo "== 启动 $BACKENDS 个模拟后端 =="
for i in $(seq 0 $((BACKENDS - 1))); do
  port=$((BASE_TCP + i))
  "$BIN/mock-backend" --id "be$i" --listen "127.0.0.1:$port" --udp "127.0.0.1:$port" \
      >"$LOGDIR/be$i.log" 2>&1 &
  pids+=($!)
done
sleep 1.5

# ---------- 启动 LB ----------
echo "== 启动 exam-lb =="
"$BIN/exam-lb" run --config "$CFG" >"$LOGDIR/lb.log" 2>&1 &
pids+=($!)
sleep 2.5

# ---------- 考前预热：提前建好到各后端的连接池（需求 1）----------
# 开考分钟的新连接大多命中已建好的 warm socket，无需现场三次握手。
echo "== 考前预热（报名人数=${CONNS}）=="
apipost "/api/prewarm" "{\"expected_clients\":${CONNS}}" >/dev/null
sleep 4

# ---------- 启动压测客户端（后台跑整个持续期）----------
# ramp 控制在 macOS backlog(128) 可承受的速率；Linux 生产可调高。
echo "== 启动压测: $CONNS 长连接, ${DURATION}s =="
"$BIN/loadgen" --target "127.0.0.1:$LB_TCP" \
  --connections "$CONNS" --workers 16 --ping-secs 3 \
  --ramp-per-sec 800 --duration-secs "$DURATION" \
  --udp-per-sec 200 --admin "http://127.0.0.1:$ADMIN" \
  --report "$LOGDIR/loadgen.json" >"$LOGDIR/loadgen.stdout" 2>&1 &
LG_PID=$!
pids+=($LG_PID)

# ---------- 压测中途：后端 churn ----------
sleep $(( DURATION / 4 ))
echo "== 中途排空 be1（宽限 8s）=="
apipost "/api/backends/be1/drain" '{"deadline_secs":8}' >/dev/null
sleep 2

echo "== 中途新增后端 be-new =="
NEW_PORT=$((BASE_TCP + BACKENDS + 10))
"$BIN/mock-backend" --id "be-new" --listen "127.0.0.1:$NEW_PORT" --udp "127.0.0.1:$NEW_PORT" \
    >"$LOGDIR/be-new.log" 2>&1 &
pids+=($!)
apipost "/api/backends" "{\"id\":\"be-new\",\"addr\":\"127.0.0.1:$NEW_PORT\",\"group\":\"primary\",\"capacity\":100000,\"weight\":100,\"check\":\"off\"}" >/dev/null
sleep 2

echo "== 再排空 be2（宽限 3s，会触发强断）=="
apipost "/api/backends/be2/drain" '{"deadline_secs":3}' >/dev/null

# 等压测结束
wait "$LG_PID" 2>/dev/null || true

# ---------- 汇总 ----------
echo
echo "================ 压测结果 ================"
python3 - "$LOGDIR/loadgen.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"目标连接 / 实际建立 : {r['wanted_connections']} / {r['connected']}")
print(f"连接失败           : {r['connect_failures']}")
# 客户端观测到的断开包含压测结束时的正常关闭(FIN)；真正被强断的权威数字
# 以下方 LB 侧 forced_disconnects 为准（仅统计超过 drain 宽限的连接）。
print(f"客户端观测断开     : {r['disconnects']} (含测试结束正常关闭 FIN={r.get('closed_by_fin',0)}, RST={r.get('closed_by_reset',0)})")
print(f"PING 成功/失败     : {r['pings_ok']} / {r['pings_failed']}")
print(f"★ 端到端 RTT p50   : {r['rtt_p50_us']} µs")
print(f"★ 端到端 RTT p99   : {r['rtt_p99_us']} µs")
print(f"累计入/出字节      : {r['bytes_in']} / {r['bytes_out']}")

# 后端负载均匀度：取一次中段采样的 active 分布，算变异系数
samples = r.get("backend_load_samples", [])
mid = samples[len(samples)//2] if samples else None
if mid:
    backs = mid.get("backends", [])
    acts = [b["active"] for b in backs]
    if acts:
        mean = sum(acts) / len(acts)
        var = sum((a - mean) ** 2 for a in acts) / len(acts)
        cv = (var ** 0.5) / mean if mean else 0
        print(f"\n各后端 active 连接  : min={min(acts)} max={max(acts)} mean={mean:.1f}")
        print(f"★ 负载变异系数 CV  : {cv:.4f} (越小越均匀, <0.2 为优)")
        for b in backs:
            print(f"   {b['id']:8s} group={b['group']:7s} active={b['active']:6d} state={b['state']}")
else:
    print("\n(未采集到后端负载采样，见 LB 侧 /api/backends)")
PY

echo
echo "--- LB 侧统计（权威强断指标）---"
LB_STATS=""
for i in 1 2 3 4 5; do
  LB_STATS=$(api "/api/stats")
  if echo "$LB_STATS" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    break
  fi
  sleep 1
done
echo "$LB_STATS" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('LB 统计暂不可用（进程可能已退出）'); sys.exit(0)
for k in ['active_conns','total_opened','total_closed','forced_disconnects','forced_disconnect_ratio','relay_p50_us','relay_p99_us','tcp_setup_p99_us','udp_rtt_p99_us']:
    print(f'{k:28s}: {d[k]}')
"
echo
echo "完整报告: $LOGDIR/loadgen.json"

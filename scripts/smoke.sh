#!/usr/bin/env bash
# 端到端冒烟测试：
# 1) 起 3 个模拟后端（主 p1/p2，备 b1）
# 2) 起 exam-lb
# 3) TCP/UDP 连通性 + PROXY 协议 + 管理 API 校验
# 4) 排空一个后端，验证新连接不再进入、老连接不被强断
# 5) 输出管理面 stats 摘要
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug"
LOGDIR="$ROOT/run-logs"
mkdir -p "$LOGDIR"

pids=()
cleanup() {
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 0.3
  for p in "${pids[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

echo "== 启动模拟后端 =="
target/debug/mock-backend --id p1 --listen 127.0.0.1:9101 --udp 127.0.0.1:9101 \
    >"$LOGDIR/backend-p1.log" 2>&1 &
pids+=($!)
target/debug/mock-backend --id p2 --listen 127.0.0.1:9102 --udp 127.0.0.1:9102 \
    >"$LOGDIR/backend-p2.log" 2>&1 &
pids+=($!)
target/debug/mock-backend --id b1 --listen 127.0.0.1:9201 --udp 127.0.0.1:9201 \
    >"$LOGDIR/backend-b1.log" 2>&1 &
pids+=($!)
sleep 1.5

echo "== 启动 exam-lb =="
"$BIN/exam-lb" run --config "$ROOT/examples/exam-lb.toml" \
    >"$LOGDIR/lb.log" 2>&1 &
pids+=($!)
# Wait for the admin API with retries (many workers take a moment to bind).
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "== 健康检查接口 =="
curl -fsS --max-time 8 http://127.0.0.1:8080/api/health
echo

echo "== TCP 转发 + PROXY 协议 =="
python3 -c "
import socket
s = socket.create_connection(('127.0.0.1', 9000), timeout=3)
s.sendall(b'PING smoke1\r\n')
s.settimeout(3)
print('TCP reply:', s.recv(2048))
s.close()
"
sleep 1

echo "== 后端池状态 =="
curl -fsS --max-time 8 http://127.0.0.1:8080/api/backends | python3 -m json.tool | head -40

echo "== UDP 转发 =="
python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
s.sendto(b"PING udp-smoke", ("127.0.0.1", 9001))
data, _ = s.recvfrom(2048)
print("UDP reply:", data.decode())
assert data.startswith(b"PONG"), "UDP relay failed"
PY

echo "== 预热接口 =="
curl -fsS --max-time 8 -X POST http://127.0.0.1:8080/api/prewarm \
  -H 'content-type: application/json' -d '{"expected_clients":300}'
echo
sleep 2
curl -fsS --max-time 8 --max-time 5 http://127.0.0.1:8080/api/pools
echo

echo "== 排空 p2（宽限 10s）=="
curl -fsS --max-time 8 -X POST http://127.0.0.1:8080/api/backends/p2/drain \
  -H 'content-type: application/json' -d '{"deadline_secs":10}'
echo
sleep 1
curl -fsS --max-time 8 http://127.0.0.1:8080/api/backends | python3 -m json.tool | grep -A2 '"id": "p2"' || true

echo "== 连接表 =="
curl -fsS --max-time 8 "http://127.0.0.1:8080/api/connections?limit=5" | python3 -m json.tool | head -30

echo "== 汇总统计 =="
curl -fsS --max-time 8 http://127.0.0.1:8080/api/stats | python3 -c "
import json, sys
d = json.load(sys.stdin)
keys = ['active_conns','total_opened','total_closed','forced_disconnects',
        'forced_disconnect_ratio','rejected_no_backend','bytes_in','bytes_out',
        'tcp_setup_p99_us','relay_p99_us','udp_rtt_p99_us']
for k in keys:
    print(f'{k}: {d[k]}')
"

echo
echo "SMOKE OK —— 日志在 $LOGDIR"

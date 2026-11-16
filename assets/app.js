// 考试负载均衡控制台 — 原生 JS，无外部依赖。
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
}

function fmtBytes(n) {
  if (n == null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtUs(us) {
  if (!us) return "0 µs";
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(2)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}
function pct(x) { return `${(x * 100).toFixed(4)}%`; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    refreshAll();
  });
});

// ---------- listeners ----------
async function loadListeners() {
  const cfg = await api("/api/config");
  $("listeners-body").innerHTML = cfg.listeners.map((l) => `
    <tr>
      <td>${esc(l.name)}</td>
      <td>${esc(l.protocol)}</td>
      <td>${esc(l.listen)}</td>
      <td>${esc(l.proxy_protocol || "off")}</td>
      <td>${l.udp_session_timeout_secs ?? "-"} s</td>
    </tr>`).join("");
}

// ---------- backends ----------
async function loadBackends() {
  const data = await api("/api/backends");
  $("kpi-backup-share").innerHTML =
    `备组分流比例：<b>${(data.backup_share * 100).toFixed(1)}%</b>`;
  $("kpi-primary-low").innerHTML =
    `主组容量告急：<b class="${data.primary_capacity_low ? "warn-text" : "ok-text"}">${data.primary_capacity_low ? "是" : "否"}</b>`;

  const select = $("conn-backend");
  const current = select.value;
  select.innerHTML = '<option value="">全部后端</option>' +
    data.backends.map((b) => `<option value="${esc(b.id)}">${esc(b.id)}</option>`).join("");
  select.value = current;

  $("backends-body").innerHTML = data.backends.map((b) => {
    const cls = b.state === "up" ? "ok-text" : b.state === "draining" ? "warn-text" : "err-text";
    return `
    <tr>
      <td>${esc(b.id)}</td>
      <td>${esc(b.addr)}</td>
      <td>${esc(b.group)}</td>
      <td>${b.weight}</td>
      <td>${b.capacity}</td>
      <td>${b.active}</td>
      <td>${b.available}</td>
      <td class="${cls}">${esc(b.state)}</td>
      <td>${b.warmup_target}</td>
      <td class="actions">
        <button onclick="drainBackend('${esc(b.id)}')">排空下线</button>
        <button onclick="undrainBackend('${esc(b.id)}')">恢复</button>
        <button onclick="removeBackend('${esc(b.id)}')">删除</button>
      </td>
    </tr>`;
  }).join("");
}

window.drainBackend = async (id) => {
  const secs = prompt("排空宽限秒数（超时强断），留空用配置默认值", "");
  await api(`/api/backends/${encodeURIComponent(id)}/drain`, {
    method: "POST",
    body: JSON.stringify({ deadline_secs: secs ? Number(secs) : null }),
  });
  refreshAll();
};
window.undrainBackend = async (id) => {
  await api(`/api/backends/${encodeURIComponent(id)}/undrain`, { method: "POST" });
  refreshAll();
};
window.removeBackend = async (id) => {
  if (!confirm(`确认删除后端 ${id}？建议先排空。`)) return;
  await api(`/api/backends/${encodeURIComponent(id)}`, { method: "DELETE" });
  refreshAll();
};

$("btn-prewarm").onclick = async () => {
  const n = Number($("prewarm-count").value);
  if (!n) return alert("请输入报名人数");
  const r = await api("/api/prewarm", { method: "POST", body: JSON.stringify({ expected_clients: n }) });
  $("prewarm-result").textContent =
    "预热目标（每 worker 连接数）：" + r.plan.map(([id, t]) => `${id}=${t}`).join(", ");
};
$("btn-add-backend").onclick = async () => {
  const body = {
    id: $("be-id").value.trim(),
    addr: $("be-addr").value.trim(),
    group: $("be-group").value,
    capacity: Number($("be-capacity").value || 10000),
    weight: 100,
    check: "tcp",
  };
  if (!body.id || !body.addr) return alert("ID 和地址必填");
  try {
    await api("/api/backends", { method: "POST", body: JSON.stringify(body) });
    refreshAll();
  } catch (e) { alert(e.message); }
};

// ---------- connections ----------
async function loadConnections() {
  const q = $("conn-q").value.trim();
  const backend = $("conn-backend").value;
  const params = new URLSearchParams({ limit: "500" });
  if (q) params.set("q", q);
  if (backend) params.set("backend_id", backend);
  const data = await api(`/api/connections?${params}`);
  $("conn-total").textContent = `共 ${data.total} 条，显示 ${data.connections.length} 条`;
  $("connections-body").innerHTML = data.connections.map((c) => `
    <tr>
      <td>${c.id}</td><td>${c.worker_id}</td><td>${esc(c.listener)}</td>
      <td>${esc(c.protocol)}</td><td>${esc(c.client_addr)}</td>
      <td>${esc(c.backend_id)}</td><td>${esc(c.backend_addr)}</td>
      <td>${fmtBytes(c.bytes_in)}</td><td>${fmtBytes(c.bytes_out)}</td>
      <td>${c.age_ms}</td><td>${c.idle_ms}</td>
      <td class="${c.state === "active" ? "ok-text" : "warn-text"}">${esc(c.state)}</td>
    </tr>`).join("");
}
$("btn-conn-refresh").onclick = loadConnections;

// ---------- health / SLO ----------
async function loadHealth(stats) {
  $("h-workers").textContent = stats.workers.length;
  $("h-active").textContent = stats.active_conns;
  $("h-opened").textContent = stats.total_opened;
  $("h-closed").textContent = stats.total_closed;
  $("h-forced").textContent = stats.forced_disconnects;
  $("h-forced-ratio").textContent = pct(stats.forced_disconnect_ratio);
  $("h-rejected").textContent = stats.rejected_no_backend;
  $("h-setup-p99").textContent = fmtUs(stats.tcp_setup_p99_us);
  $("h-relay-p99").textContent = fmtUs(stats.relay_p99_us);
  $("h-udp-p99").textContent = fmtUs(stats.udp_rtt_p99_us);
  $("worker-body").innerHTML = stats.workers.map((w) => `
    <tr>
      <td>${w.worker_id}</td><td>${w.active_conns}</td>
      <td>${w.total_opened}</td><td>${w.total_closed}</td>
      <td>${w.forced_disconnects}</td>
      <td>${fmtBytes(w.bytes_in)}</td><td>${fmtBytes(w.bytes_out)}</td>
    </tr>`).join("");
}

// ---------- traffic chart ----------
function drawTraffic(stats) {
  const cv = $("traffic-canvas");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, pad = 46;
  ctx.clearRect(0, 0, W, H);
  const rows = stats.traffic || [];
  if (!rows.length) {
    ctx.fillStyle = "#8895a7";
    ctx.font = "14px sans-serif";
    ctx.fillText("暂无数据", W / 2 - 30, H / 2);
    return;
  }
  const maxIn = Math.max(1, ...rows.map((r) => r.bytes_in));
  const maxOut = Math.max(1, ...rows.map((r) => r.bytes_out));
  const max = Math.max(maxIn, maxOut);
  const x = (i) => pad + (i * (W - pad - 12)) / Math.max(1, rows.length - 1);
  const y = (v) => H - pad - (v / max) * (H - pad - 20);

  // grid
  ctx.strokeStyle = "#2a3345";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = pad + g * (H - pad - 20) / 4;
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - 12, gy); ctx.stroke();
    ctx.fillStyle = "#8895a7";
    ctx.font = "11px sans-serif";
    ctx.fillText(fmtBytes(max * (1 - g / 4)), 4, gy + 4);
  }

  const line = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    rows.forEach((r, i) => {
      const px = x(i), py = y(r[key]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
  };
  line("bytes_in", "#4fc3f7");
  line("bytes_out", "#ffb74d");

  // opens/closes as faint bars
  const maxConn = Math.max(1, ...rows.map((r) => Math.max(r.conns_opened, r.conns_closed)));
  ctx.fillStyle = "rgba(129,199,132,0.35)";
  rows.forEach((r, i) => {
    const bh = (r.conns_opened / maxConn) * 40;
    ctx.fillRect(x(i) - 1, H - pad - bh, 2, bh);
  });

  // legend
  ctx.font = "12px sans-serif";
  ctx.fillStyle = "#4fc3f7"; ctx.fillText("● 入字节/秒", pad, 18);
  ctx.fillStyle = "#ffb74d"; ctx.fillText("● 出字节/秒", pad + 110, 18);
  ctx.fillStyle = "rgba(129,199,132,0.8)"; ctx.fillText("▮ 新建连接/秒", pad + 220, 18);
  const last = rows[rows.length - 1];
  ctx.fillStyle = "#8895a7";
  ctx.fillText(new Date(last.sec * 1000).toLocaleTimeString(), W - 120, H - 14);
}

async function loadTraffic(stats) {
  $("t-bytes-in").textContent = fmtBytes(stats.bytes_in);
  $("t-bytes-out").textContent = fmtBytes(stats.bytes_out);
  $("t-relay").textContent = `${fmtUs(stats.relay_p50_us)} / ${fmtUs(stats.relay_p99_us)}`;
  drawTraffic(stats);
}

// ---------- polling ----------
let timer = null;
async function refreshAll() {
  try {
    const stats = await api("/api/stats");
    $("health-dot").className = "dot ok";
    $("health-text").textContent = "正常";
    const active = document.querySelector(".tab.active").dataset.tab;
    if (active === "listeners") await loadListeners();
    if (active === "backends") await loadBackends();
    if (active === "connections") await loadConnections();
    if (active === "health") await loadHealth(stats);
    if (active === "traffic") await loadTraffic(stats);
    // KPIs needed regardless of tab.
    await loadBackends().catch(() => {});
  } catch (e) {
    $("health-dot").className = "dot err";
    $("health-text").textContent = `异常：${e.message}`;
  }
}
function restartTimer() {
  if (timer) clearInterval(timer);
  const ms = Number($("refresh-ms").value);
  timer = setInterval(refreshAll, ms);
}
$("refresh-ms").onchange = restartTimer;
refreshAll();
restartTimer();

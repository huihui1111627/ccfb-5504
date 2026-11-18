/* quiclab 可视化主逻辑:零依赖原生 JS + Canvas。
 *
 * 数据来源:
 *   GET /api/scenarios       连接(场景)列表
 *   GET /api/trace/<name>    单场景完整 trace
 *
 * 五个区块:连接列表 / 包号时间线 / 拥塞窗口曲线 / RTT 估计 / 丢包事件。
 */

"use strict";

const COLORS = {
  sent: "#6ec1ff",
  recv: "#8be0a0",
  ack: "#c9a6ff",
  lossP: "#ff7a7a",
  lossT: "#ffb347",
  probe: "#ffd166",
  cwnd: "#4da3ff",
  ssthresh: "#9aa7bd",
  ccswitch: "#ff8fab",
  latest: "#8be0a0",
  smoothed: "#4da3ff",
  minrtt: "#ffd166",
  rttvar: "#c9a6ff",
  grid: "#283449",
  text: "#7d8ba3",
  persist: "#ff5d8f",
};

const state = {
  scenarios: [],
  current: null,   // 当前 trace
  currentName: null,
  currentKey: null,
  filters: { endpoint: "all", space: "all", name: "" },
};

const $ = (id) => document.getElementById(id);

// ======================================================================
// 通用 Canvas 工具
// ======================================================================
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = parseInt(canvas.getAttribute("height"), 10);
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function makeScaler(min, max, px0, px1) {
  const span = max - min || 1;
  return (v) => px0 + ((v - min) / span) * (px1 - px0);
}

function drawGrid(ctx, plot, yTicks, xTicks, fmtX, fmtY) {
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.lineWidth = 1;
  ctx.font = "10px monospace";
  // 横向网格 + y 轴标签
  yTicks.forEach((v) => {
    const y = plot.y(v);
    ctx.beginPath();
    ctx.moveTo(plot.x0, y);
    ctx.lineTo(plot.x1, y);
    ctx.stroke();
    ctx.fillText(fmtY(v), 4, y - 2);
  });
  // 纵向网格 + x 轴标签
  xTicks.forEach((v) => {
    const x = plot.x(v);
    ctx.beginPath();
    ctx.moveTo(x, plot.y0);
    ctx.lineTo(x, plot.y1);
    ctx.stroke();
    ctx.fillText(fmtX(v), x - 18, plot.y1 + 14);
  });
}

function ticks(min, max, count) {
  if (min === max) return [min];
  const step = (max - min) / count;
  const out = [];
  for (let i = 0; i <= count; i++) out.push(min + step * i);
  return out;
}

// ======================================================================
// 区块 1:连接列表
// ======================================================================
async function loadScenarios() {
  const res = await fetch("/api/scenarios");
  const data = await res.json();
  state.scenarios = data.scenarios || [];
  renderConnList();
}

function renderConnList() {
  const ul = $("connList");
  const kw = state.filters.name.trim().toLowerCase();
  const items = state.scenarios.filter((s) =>
    !kw || s.name.toLowerCase().includes(kw)
  );
  if (!items.length) {
    ul.innerHTML = '<li class="muted">没有匹配的场景</li>';
    return;
  }
  ul.innerHTML = "";
  items.forEach((s) => {
    const li = document.createElement("li");
    if (s.trace_key === state.currentKey) li.classList.add("active");
    // 违例场景用专门的标记
    const isViolation = (s.client_reason || "").includes("protocol_violation");
    const ok = s.exactly_once && s.all_bytes_covered;
    const badge = isViolation
      ? '<span class="badge fail">违例关闭</span>'
      : `<span class="badge ${ok ? "ok" : "fail"}">${ok ? "通过" : "异常"}</span>`;
    li.innerHTML = `
      <div class="name">${s.name}${badge}</div>
      <div class="sub">seed=${s.seed} · ${s.event_count} 事件 ·
        ${(s.sim_time || 0).toFixed(0)}ms</div>`;
    li.addEventListener("click", () => selectScenario(s.trace_key, s.name));
    ul.appendChild(li);
  });
}

async function selectScenario(key, name) {
  const res = await fetch(`/api/trace/${encodeURIComponent(key)}`);
  state.current = await res.json();
  state.currentKey = key;
  state.currentName = name || key;
  renderConnList();
  renderMeta();
  renderAll();
}

function renderMeta() {
  const t = state.current;
  if (!t) return;
  const sc = t.scenario;
  const r = t.result;
  $("scenarioMeta").innerHTML = `
    <b>${sc.name}</b> · seed ${sc.seed}<br/>
    ${sc.description || ""}<br/>
    送达 ${r.app_delivered_bytes}/${r.app_expected} 字节 ·
    恰好一次:${r.exactly_once ? "✅" : "❌"} ·
    仿真 ${(r.sim_time || 0).toFixed(1)}ms`;
  $("connDetail").innerHTML = `
    <div class="kv"><span>初始 CC</span><span>${sc.initial_cc}</span></div>
    <div class="kv"><span>CC 切换计划</span><span>${
      (sc.cc_schedule || []).map((c) => `${c[0]}ms→${c[1]}`).join(", ") || "无"
    }</span></div>
    <div class="kv"><span>单向时延 c2s</span><span>
      ${sc.link_client_to_server.base_delay_ms}±${sc.link_client_to_server.jitter_ms}ms</span></div>
    <div class="kv"><span>随机丢包 c2s</span><span>
      ${(sc.link_client_to_server.random_loss * 100).toFixed(1)}%</span></div>
    <div class="kv"><span>成串丢包 c2s</span><span>
      ${sc.link_client_to_server.burst_loss
        ? `开 p=${sc.link_client_to_server.burst_p_enter}, 串长[${sc.link_client_to_server.min_burst},${sc.link_client_to_server.max_burst}]`
        : "关"}</span></div>
    <div class="kv"><span>client 关闭原因</span><span>${r.client_reason || "未关闭"}</span></div>
    <div class="kv"><span>server 关闭原因</span><span>${r.server_reason || "未关闭"}</span></div>`;
}

// ======================================================================
// 事件过滤与索引
// ======================================================================
function events() {
  return state.current ? state.current.events : [];
}

function passFilter(ev) {
  const f = state.filters;
  if (f.endpoint !== "all" && ev.conn_id !== f.endpoint) return false;
  if (f.space !== "all" && ev.space !== f.space) return false;
  return true;
}

function timeRange(evs) {
  const times = evs.map((e) => e.time ?? e.sim_time).filter((v) => v != null);
  if (!times.length) return [0, 1];
  return [Math.min(...times), Math.max(...times)];
}

// ======================================================================
// 区块 2:包号时间线
// 每个端点一行泳道;x=时间,点按事件类型着色,两种丢包分开标注。
// ======================================================================
function renderTimeline() {
  const canvas = $("timelineCanvas");
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const evs = events().filter(passFilter);
  if (!evs.length) return;

  const [tMin, tMax] = timeRange(evs);
  const padL = 70, padR = 16, padT = 14, padB = 28;
  const x = makeScaler(tMin, tMax, padL, w - padR);

  const lanes =
    state.filters.endpoint === "all"
      ? ["client", "server"]
      : [state.filters.endpoint];
  const laneH = (h - padT - padB) / lanes.length;
  const plot = {
    x, x0: padL, x1: w - padR, y0: padT, y1: h - padB,
    y: (v) => padT + (v / 4) * (h - padT - padB),
  };

  drawGrid(
    ctx, plot,
    [0, 1, 2, 3],
    ticks(tMin, tMax, 6),
    (v) => v.toFixed(0),
    () => ""
  );

  lanes.forEach((lane, idx) => {
    const cy = padT + laneH * idx + laneH / 2;
    // 泳道分隔与标签
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(padL, padT + laneH * idx);
    ctx.lineTo(w - padR, padT + laneH * idx);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = "11px sans-serif";
    ctx.fillText(lane, 6, cy + 4);

    evs.filter((e) => e.conn_id === lane).forEach((e) => {
      const t = e.time ?? e.sim_time;
      const cx = x(t);
      let color = null;
      let shape = "circle";
      let r = 3.2;
      switch (e.type) {
        case "packet_sent":
          color = COLORS.sent;
          if (e.is_probe) { color = COLORS.probe; shape = "triangle"; r = 4.5; }
          break;
        case "packet_received": color = COLORS.recv; break;
        case "packet_acked": color = COLORS.ack; break;
        case "packet_lost":
          color = e.cause === "packet_threshold" ? COLORS.lossP : COLORS.lossT;
          shape = "x";
          r = 4.5;
          break;
        default: return;
      }
      drawMarker(ctx, cx, cy, shape, r, color);
    });
  });

  // 记录命中区用于 tooltip
  canvas._hover = buildTimelineHover(evs, lanes, x, padT, laneH);
}

function drawMarker(ctx, cx, cy, shape, r, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (shape === "circle") {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === "triangle") {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx - r, cy + r);
    ctx.lineTo(cx + r, cy + r);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r);
    ctx.lineTo(cx - r, cy + r);
    ctx.stroke();
  }
}

function buildTimelineHover(evs, lanes, x, padT, laneH) {
  const items = [];
  lanes.forEach((lane, idx) => {
    const cy = padT + laneH * idx + laneH / 2;
    evs.filter((e) => e.conn_id === lane &&
      ["packet_sent", "packet_received", "packet_acked", "packet_lost"].includes(e.type))
      .forEach((e) => {
        items.push({
          x: x(e.time ?? e.sim_time), y: cy, ev: e,
        });
      });
  });
  return items;
}

// ======================================================================
// 区块 3:拥塞窗口曲线
// ======================================================================
function renderCwnd() {
  const canvas = $("cwndCanvas");
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const evs = events();
  // 用 packet_sent / packet_acked / packet_lost / congestion_event 上的 cwnd 采样
  const samples = [];
  evs.forEach((e) => {
    if (e.cwnd != null && (e.time ?? e.sim_time) != null) {
      samples.push({ t: e.time ?? e.sim_time, cwnd: e.cwnd / 1200, sst: e.ssthresh });
    }
  });
  const switches = evs.filter((e) => e.type === "cc_switch");
  const ccEvents = evs.filter((e) => e.type === "congestion_event");
  if (!samples.length) return;

  const [tMin, tMax] = timeRange(evs);
  const padL = 46, padR = 14, padT = 12, padB = 26;
  const x = makeScaler(tMin, tMax, padL, w - padR);
  const cwndVals = samples.map((s) => s.cwnd);
  const yMax = Math.max(...cwndVals, 1) * 1.15;
  const y = makeScaler(0, yMax, h - padB, padT);
  const plot = { x, x0: padL, x1: w - padR, y0: padT, y1: h - padB, y };

  drawGrid(ctx, plot, ticks(0, yMax, 5), ticks(tMin, tMax, 6),
    (v) => v.toFixed(0), (v) => v.toFixed(1));

  // cwnd 阶梯线
  ctx.strokeStyle = COLORS.cwnd;
  ctx.lineWidth = 2;
  ctx.beginPath();
  samples.forEach((s, i) => {
    const px = x(s.t), py = y(s.cwnd);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // ssthresh(有数值时)虚线
  const sstSamples = samples.filter((s) => s.sst != null);
  if (sstSamples.length) {
    ctx.strokeStyle = COLORS.ssthresh;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    sstSamples.forEach((s, i) => {
      const px = x(s.t), py = y(s.sst / 1200);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 持续拥塞事件标红竖线
  ccEvents.filter((e) => e.label === "persistent_congestion").forEach((e) => {
    const px = x(e.time ?? e.sim_time);
    ctx.strokeStyle = COLORS.persist;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, h - padB);
    ctx.stroke();
  });

  // 算法切换菱形
  switches.forEach((e) => {
    const px = x(e.time ?? e.sim_time);
    ctx.fillStyle = COLORS.ccswitch;
    ctx.beginPath();
    ctx.moveTo(px, padT + 2);
    ctx.lineTo(px + 5, padT + 8);
    ctx.lineTo(px, padT + 14);
    ctx.lineTo(px - 5, padT + 8);
    ctx.closePath();
    ctx.fill();
  });
  canvas._hover = samples.map((s) => ({ x: x(s.t), y: y(s.cwnd), s }));
  canvas._switches = switches;
}

// ======================================================================
// 区块 4:RTT 估计
// ======================================================================
function renderRtt() {
  const canvas = $("rttCanvas");
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const samples = events()
    .filter((e) => e.type === "rtt_sample")
    .map((e) => ({
      t: e.time,
      latest: e.rtt_latest_rtt,
      smoothed: e.rtt_smoothed_rtt,
      min: e.rtt_min_rtt,
      rttvar: e.rtt_rttvar,
    }));
  if (!samples.length) return;

  const tMin = samples[0].t;
  const tMax = samples[samples.length - 1].t;
  const padL = 46, padR = 14, padT = 12, padB = 26;
  const x = makeScaler(tMin, tMax, padL, w - padR);
  const allVals = samples.flatMap((s) =>
    [s.latest, s.smoothed, s.min, s.rttvar].filter((v) => v != null));
  const yMax = Math.max(...allVals) * 1.1;
  const y = makeScaler(0, yMax, h - padB, padT);
  const plot = { x, x0: padL, x1: w - padR, y0: padT, y1: h - padB, y };
  drawGrid(ctx, plot, ticks(0, yMax, 5), ticks(tMin, tMax, 6),
    (v) => v.toFixed(0), (v) => v.toFixed(1));

  const series = [
    ["latest", COLORS.latest],
    ["smoothed", COLORS.smoothed],
    ["min", COLORS.minrtt],
    ["rttvar", COLORS.rttvar],
  ];
  series.forEach(([key, color]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = key === "smoothed" ? 2 : 1.3;
    ctx.beginPath();
    samples.forEach((s, i) => {
      if (s[key] == null) return;
      const px = x(s.t), py = y(s[key]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  });
  canvas._hover = samples;
  canvas._x = x;
  canvas._y = y;
}

// ======================================================================
// 区块 5:丢包 / PTO 事件表
// ======================================================================
function renderLossTable() {
  const tbody = $("lossTable").querySelector("tbody");
  const rows = [];
  events().forEach((e) => {
    const t = e.time ?? e.sim_time;
    if (e.type === "packet_lost") {
      const isP = e.cause === "packet_threshold";
      rows.push(`<tr>
        <td>${t.toFixed(2)}</td><td>${e.conn_id}</td><td>${e.space}</td>
        <td>${e.packet_number}</td>
        <td><span class="tag ${isP ? "loss-p" : "loss-t"}">
          ${isP ? "包号阈值丢包" : "时间阈值丢包"}</span></td>
        <td>${isP
          ? `largest_acked 领先超过 kPacketThreshold(3)`
          : `发送后超过 9/8 × latest_rtt`}</td></tr>`);
    } else if (e.type === "pto_expired") {
      rows.push(`<tr>
        <td>${t.toFixed(2)}</td><td>${e.conn_id}</td><td>${e.space}</td>
        <td>—</td>
        <td><span class="tag pto">PTO 超时 #${e.pto_count}</span></td>
        <td>退避时长 ${e.backoff_duration.toFixed(1)}ms,先发探测包不判丢</td></tr>`);
    } else if (e.type === "congestion_event" && e.label === "persistent_congestion") {
      rows.push(`<tr>
        <td>${t.toFixed(2)}</td><td>${e.conn_id}</td><td>—</td>
        <td>${(e.lost_packets || []).join(",")}</td>
        <td><span class="tag persist">持续拥塞</span></td>
        <td>窗口降到最小值 2×MSS</td></tr>`);
    }
  });
  tbody.innerHTML = rows.join("") ||
    '<tr><td colspan="6" class="muted">本场景没有丢包/PTO 事件</td></tr>';
}

// ======================================================================
// Tooltip
// ======================================================================
function bindTooltip() {
  const tip = $("tooltip");
  const canvases = [
    { el: $("timelineCanvas"), kind: "timeline" },
    { el: $("cwndCanvas"), kind: "cwnd" },
    { el: $("rttCanvas"), kind: "rtt" },
  ];
  canvases.forEach(({ el, kind }) => {
    el.addEventListener("mousemove", (ev) => {
      const rect = el.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      let html = null;
      if (kind === "timeline" && el._hover) {
        const hit = el._hover.find((p) => Math.abs(p.x - mx) < 6 && Math.abs(p.y - my) < 10);
        if (hit) html = describeTimeline(hit.ev);
      } else if (kind === "cwnd" && el._hover) {
        let best = null, bd = 1e9;
        el._hover.forEach((p) => {
          const d = Math.abs(p.x - mx);
          if (d < bd) { bd = d; best = p; }
        });
        if (best && bd < 12) {
          html = `<b>t=${best.s.t.toFixed(1)}ms</b><br/>cwnd=${best.s.cwnd.toFixed(2)} 包` +
            (best.s.sst != null ? `<br/>ssthresh=${(best.s.sst / 1200).toFixed(2)} 包` : "");
        }
      } else if (kind === "rtt" && el._hover) {
        let best = null, bd = 1e9;
        el._hover.forEach((s) => {
          const d = Math.abs(el._x(s.t) - mx);
          if (d < bd) { bd = d; best = s; }
        });
        if (best && bd < 14) {
          html = `<b>t=${best.t.toFixed(1)}ms</b><br/>
            latest=${fmt(best.latest)}<br/>smoothed=${fmt(best.smoothed)}<br/>
            min=${fmt(best.min)}<br/>rttvar=${fmt(best.rttvar)}`;
        }
      }
      if (html) {
        tip.innerHTML = html;
        tip.hidden = false;
        tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 300) + "px";
        tip.style.top = (ev.clientY + 14) + "px";
      } else {
        tip.hidden = true;
      }
    });
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}

function fmt(v) { return v == null ? "—" : v.toFixed(2) + "ms"; }

function describeTimeline(e) {
  const head = `<b>${e.conn_id} · ${e.space} · pn=${e.packet_number}</b><br/>t=${(e.time ?? e.sim_time).toFixed(2)}ms`;
  switch (e.type) {
    case "packet_sent":
      return `${head}<br/>发送 ${e.is_probe ? "(PTO 探测包)" : ""}<br/>帧: ${(e.frames || []).join(",")}`;
    case "packet_received":
      return `${head}<br/>接收`;
    case "packet_acked":
      return `${head}<br/>确认, RTT=${e.rtt.toFixed(2)}ms`;
    case "packet_lost":
      return `${head}<br/><span style="color:${e.cause === "packet_threshold" ? COLORS.lossP : COLORS.lossT}">
        ${e.cause === "packet_threshold" ? "包号阈值判丢" : "时间阈值判丢"}</span>`;
    default: return head;
  }
}

// ======================================================================
// 渲染编排
// ======================================================================
function renderAll() {
  if (!state.current) return;
  renderTimeline();
  renderCwnd();
  renderRtt();
  renderLossTable();
}

function init() {
  $("refreshBtn").addEventListener("click", loadScenarios);
  $("filterInput").addEventListener("input", (e) => {
    state.filters.name = e.target.value;
    renderConnList();
  });
  $("endpointSelect").addEventListener("change", (e) => {
    state.filters.endpoint = e.target.value;
    renderTimeline();
  });
  $("spaceSelect").addEventListener("change", (e) => {
    state.filters.space = e.target.value;
    renderTimeline();
  });
  window.addEventListener("resize", () => state.current && renderAll());
  bindTooltip();
  loadScenarios();
}

document.addEventListener("DOMContentLoaded", init);

//! Admin HTTP API + management UI server.
//!
//! Runs on its own multi-threaded Tokio runtime so UI traffic never competes
//! with data-plane workers. Every stats/connection call fans out to workers
//! over mpsc and merges the responses — no shared mutable state, no global
//! lock on the forwarding path.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use crate::backend::{BackendView, Registry};
use crate::config::{BackendConfig, BackendGroup, CheckMode, Config};
use crate::conntrack::{ConnFilter, ConnView};
use crate::stats::{now_sec, GlobalStats, WorkerStatsSnapshot};
use crate::worker::{WorkerHandle, WorkerMessage};

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<Registry>,
    pub workers: Arc<Vec<WorkerHandle>>,
    pub config: Arc<Config>,
}

pub async fn serve(state: AppState, addr: SocketAddr, static_dir: Option<String>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "admin API listening");
    let static_dir = static_dir.map(Arc::new);
    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let state = state.clone();
        let static_dir = static_dir.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let state = state.clone();
                let static_dir = static_dir.clone();
                async move { handle(req, state, static_dir).await }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, svc)
                .await;
        });
    }
}

type Resp = Response<Full<Bytes>>;

fn json_response(status: StatusCode, body: serde_json::Value) -> Resp {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

fn ok(body: serde_json::Value) -> Resp {
    json_response(StatusCode::OK, body)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Resp {
    json_response(status, json!({"error": msg.into()}))
}

async fn read_json<T: for<'de> Deserialize<'de>>(req: Request<Incoming>) -> anyhow::Result<T> {
    let body = req.into_body().collect().await?.to_bytes();
    Ok(serde_json::from_slice(&body)?)
}

async fn handle(
    req: Request<Incoming>,
    state: AppState,
    static_dir: Option<Arc<String>>,
) -> Result<Resp, std::convert::Infallible> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let res = route(method, &path, req, &state, static_dir.as_deref()).await;
    Ok(res.unwrap_or_else(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())))
}

async fn route(
    method: hyper::Method,
    path: &str,
    req: Request<Incoming>,
    state: &AppState,
    static_dir: Option<&String>,
) -> anyhow::Result<Resp> {
    // ---- static UI ----
    if method == hyper::Method::GET
        && (path == "/"
            || path.starts_with("/ui/")
            || path == "/app.js"
            || path == "/styles.css"
            || path == "/index.html")
    {
        return Ok(serve_static(path, static_dir));
    }

    // ---- API ----
    if method == hyper::Method::GET && path == "/api/health" {
        return Ok(ok(json!({"status":"ok"})));
    }
    if method == hyper::Method::GET && path == "/api/config" {
        return Ok(ok(json!({
            "workers": state.workers.len(),
            "listeners": state.config.listeners,
            "drain": state.config.drain,
            "prewarm": state.config.prewarm,
            "health": state.config.health,
        })));
    }

    // Stats
    if method == hyper::Method::GET && path == "/api/stats" {
        let snaps = collect_stats(state).await;
        let global = GlobalStats::merge(snaps, now_sec());
        return Ok(ok(serde_json::to_value(global)?));
    }

    // Listeners (from config + live socket state)
    if method == hyper::Method::GET && path == "/api/listeners" {
        return Ok(ok(json!(state.config.listeners)));
    }

    // Backend pool
    if method == hyper::Method::GET && path == "/api/backends" {
        let views: Vec<BackendView> = state.registry.views();
        return Ok(ok(json!({
            "backends": views,
            "backup_share": state.registry.backup_share(),
            "primary_capacity_low": state.registry.primary_capacity_low(),
        })));
    }
    if method == hyper::Method::POST && path == "/api/backends" {
        let cfg: BackendConfig = read_json(req).await?;
        state.registry.add(cfg)?;
        nudge_prewarm(state);
        return Ok(ok(json!({"ok": true})));
    }
    // Backend sub-routes: /api/backends/{id} and /api/backends/{id}/{action}
    if let Some(rest) = strip_prefix(path, "/api/backends/") {
        let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        match segments.as_slice() {
            [id] if method == hyper::Method::DELETE => {
                state.registry.remove(id)?;
                return Ok(ok(json!({"ok": true})));
            }
            [id, action] if method == hyper::Method::POST => {
                let id = (*id).to_string();
                match *action {
                    "drain" => {
                        let body: DrainReq =
                            read_json(req).await.unwrap_or(DrainReq { deadline_secs: None });
                        let dl = state.registry.drain(&id, body.deadline_secs)?;
                        return Ok(ok(json!({"draining_until": format!("{dl:?}")})));
                    }
                    "undrain" => {
                        state.registry.undrain(&id)?;
                        return Ok(ok(json!({"ok": true})));
                    }
                    "prewarm" => {
                        let body: PrewarmOneReq = read_json(req).await?;
                        state.registry.prewarm_one(&id, body.per_worker)?;
                        nudge_prewarm(state);
                        return Ok(ok(json!({"ok": true})));
                    }
                    "weight" => {
                        let body: WeightReq = read_json(req).await?;
                        state.registry.set_weight(&id, body.weight)?;
                        return Ok(ok(json!({"ok": true})));
                    }
                    _ => return Ok(err(StatusCode::NOT_FOUND, "no such action")),
                }
            }
            _ => return Ok(err(StatusCode::NOT_FOUND, "no such route")),
        }
    }

    // Exam-style prewarm: expected examinees -> per-backend target plan.
    if method == hyper::Method::POST && path == "/api/prewarm" {
        let body: PrewarmReq = read_json(req).await?;
        let plan = state.registry.prewarm(body.expected_clients, state.workers.len());
        nudge_prewarm(state);
        return Ok(ok(json!({"plan": plan})));
    }

    // Connection table
    if method == hyper::Method::GET && path == "/api/connections" {
        let q = query_map(req.uri().query().unwrap_or(""));
        let filter = ConnFilter {
            backend_id: q.get("backend_id").cloned(),
            listener: q.get("listener").cloned(),
            text: q.get("q").cloned(),
        };
        let limit = q
            .get("limit")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(500);
        let offset = q
            .get("offset")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let mut futs = Vec::with_capacity(state.workers.len());
        for w in state.workers.iter() {
            let filter = filter.clone();
            futs.push(async move {
                let (tx, mut rx) = mpsc::channel::<Vec<ConnView>>(1);
                if w
                    .tx
                    .send(WorkerMessage::Conns { filter, reply: tx })
                    .is_ok()
                {
                    tokio::time::timeout(Duration::from_millis(800), rx.recv())
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                } else {
                    Vec::new()
                }
            });
        }
        let parts = futures::future::join_all(futs).await;
        let mut all: Vec<ConnView> = parts.into_iter().flatten().collect();
        let total = all.len();
        all.sort_by_key(|c| c.id);
        let page: Vec<ConnView> = all.into_iter().skip(offset).take(limit).collect();
        return Ok(ok(json!({"total": total, "offset": offset, "limit": limit, "connections": page})));
    }

    // Warm pool sizes
    if method == hyper::Method::GET && path == "/api/pools" {
        let mut futs = Vec::with_capacity(state.workers.len());
        for w in state.workers.iter() {
            futs.push(async move {
                let (tx, mut rx) = mpsc::channel(1);
                if w.tx.send(WorkerMessage::PoolSizes(tx)).is_ok() {
                    tokio::time::timeout(Duration::from_millis(800), rx.recv())
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                } else {
                    HashMap::new()
                }
            });
        }
        let parts = futures::future::join_all(futs).await;
        let mut merged: HashMap<String, usize> = HashMap::new();
        for sizes in parts {
            for (k, v) in sizes {
                *merged.entry(k).or_insert(0) += v;
            }
        }
        return Ok(ok(json!({"warm_sockets": merged})));
    }

    Ok(err(StatusCode::NOT_FOUND, "no such route"))
}

#[derive(Deserialize)]
struct DrainReq {
    deadline_secs: Option<u64>,
}
#[derive(Deserialize)]
struct PrewarmOneReq {
    per_worker: u64,
}
#[derive(Deserialize)]
struct WeightReq {
    weight: u64,
}
#[derive(Deserialize)]
struct PrewarmReq {
    expected_clients: u64,
}

fn strip_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    path.strip_prefix(prefix)
}

fn query_map(q: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in q.split('&').filter(|s| !s.is_empty()) {
        if let Some((k, v)) = pair.split_once('=') {
            let v = urlencoding_decode(v);
            out.insert(k.to_string(), v);
        }
    }
    out
}

fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Fan out to every worker *concurrently* and wait for all replies under a
/// per-worker deadline. A slow/starving worker is skipped rather than making
/// the whole admin request wait out per-worker timeouts serially.
async fn collect_stats(state: &AppState) -> Vec<WorkerStatsSnapshot> {
    let mut futs = Vec::with_capacity(state.workers.len());
    for w in state.workers.iter() {
        futs.push(async {
            let (tx, mut rx) = mpsc::channel(1);
            w.tx.send(WorkerMessage::Stats(tx)).ok()?;
            tokio::time::timeout(Duration::from_millis(800), rx.recv())
                .await
                .ok()
                .flatten()
        });
    }
    futures::future::join_all(futs)
        .await
        .into_iter()
        .flatten()
        .collect()
}

fn nudge_prewarm(state: &AppState) {
    for w in state.workers.iter() {
        let _ = w.tx.send(WorkerMessage::PrewarmTick);
    }
}

fn serve_static(path: &str, static_dir: Option<&String>) -> Resp {
    let rel = if path == "/" {
        "index.html".to_string()
    } else {
        // Accept both "/app.js" and "/ui/app.js"; normalize to a bare relative
        // asset name with no leading slash or traversal segments.
        path.trim_start_matches('/')
            .trim_start_matches("ui/")
            .to_string()
    };
    // Prevent path traversal.
    if rel.contains("..") || rel.contains('/') {
        return err(StatusCode::BAD_REQUEST, "bad path");
    }
    let (content_type, body) = if let Some(dir) = static_dir {
        let p = std::path::Path::new(dir).join(&rel);
        match std::fs::read(&p) {
            Ok(b) => (mime_for(&rel), b),
            Err(_) => return err(StatusCode::NOT_FOUND, "not found"),
        }
    } else {
        match crate::ui::asset(&rel) {
            Some(b) => (mime_for(&rel), b.to_vec()),
            None => return err(StatusCode::NOT_FOUND, "not found"),
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

fn mime_for(rel: &str) -> &'static str {
    if rel.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if rel.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if rel.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

// Silence unused import warnings on platforms where these enums only appear in
// deserialized payloads.
#[allow(dead_code)]
fn _enum_markers(_g: BackendGroup, _c: CheckMode) {}

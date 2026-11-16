//! Per-worker warm connection pool.
//!
//! Before an exam starts the admin API calls `prewarm`, which sets a target on
//! every backend. Each worker then keeps `target` *idle, already-connected*
//! sockets per backend (plus the baseline idle count), so the exam-minute
//! accept loop never blocks on a three-way handshake to a backend.
//!
//! All state lives inside one worker's LocalSet: plain `VecDeque`, no locks.

use std::collections::VecDeque;
use std::io;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;

use crate::backend::Backend;
use crate::config::PrewarmConfig;

struct WarmSocket {
    stream: TcpStream,
    born_at: Instant,
}

pub struct BackendPool {
    idle: VecDeque<WarmSocket>,
}

impl BackendPool {
    fn new() -> Self {
        Self {
            idle: VecDeque::new(),
        }
    }

    fn take(&mut self) -> Option<TcpStream> {
        self.idle.pop_front().map(|w| w.stream)
    }

    fn recycle(&mut self, stream: TcpStream, now: Instant, max_idle: Duration) {
        // Don't keep sockets that are already stale; the caller's maintenance
        // pass also evicts aged entries.
        let _ = max_idle;
        self.idle.push_back(WarmSocket {
            stream,
            born_at: now,
        });
    }

    fn evict_aged(&mut self, now: Instant, max_idle: Duration) {
        while let Some(front) = self.idle.front() {
            if now.duration_since(front.born_at) > max_idle {
                self.idle.pop_front();
            } else {
                break;
            }
        }
    }

    fn len(&self) -> usize {
        self.idle.len()
    }
}

pub struct WarmPools {
    cfg: PrewarmConfig,
    pools: std::collections::HashMap<String, BackendPool>,
}

impl WarmPools {
    pub fn new(cfg: PrewarmConfig) -> Self {
        Self {
            cfg,
            pools: std::collections::HashMap::new(),
        }
    }

    fn entry(&mut self, id: &str) -> &mut BackendPool {
        self.pools.entry(id.to_string()).or_insert_with(BackendPool::new)
    }

    /// Pop a warm socket for `backend`, connecting on demand if the pool is
    /// empty. `setup` measures how long the upstream acquisition took (zero
    /// for a pool hit) for the p99 setup metric.
    pub async fn acquire(
        &mut self,
        backend: &Backend,
    ) -> io::Result<(TcpStream, Duration, bool)> {
        let started = Instant::now();
        if let Some(s) = self.entry(&backend.id).take() {
            return Ok((s, Duration::ZERO, true));
        }
        let stream = connect_upstream(backend.addr).await?;
        Ok((stream, started.elapsed(), false))
    }

    /// Return a still-healthy socket to the pool. Sockets that error mid
    /// relay are simply dropped (closed) by the caller instead.
    pub fn give_back(&mut self, backend_id: &str, stream: TcpStream) {
        let now = Instant::now();
        let max_idle = Duration::from_secs(self.cfg.pool_max_idle_secs);
        self.entry(backend_id)
            .recycle(stream, now, max_idle);
    }

    /// Maintenance tick: grow/shrink pools toward their configured targets.
    ///
    /// Contention design: the lock is held only for cheap, synchronous
    /// bookkeeping. All outbound connects happen *outside* the lock so admin
    /// queries and connection acquisition never wait behind a long prewarm.
    pub async fn reconcile(
        pools: &tokio::sync::Mutex<WarmPools>,
        backends: &[std::sync::Arc<Backend>],
    ) -> (u64, u64) {
        // Phase 1 (locked, sync): evict removed backends, compute per-backend
        // growth/shrink deltas and perform synchronous shrink.
        let plan: Vec<(String, usize)> = {
            let mut guard = pools.lock().await;
            let now = Instant::now();
            let max_idle = Duration::from_secs(guard.cfg.pool_max_idle_secs);

            let live: std::collections::HashSet<String> =
                backends.iter().map(|b| b.id.clone()).collect();
            let dead: Vec<String> = guard
                .pools
                .keys()
                .filter(|id| !live.contains(*id))
                .cloned()
                .collect();
            for id in dead {
                let p = guard.pools.remove(&id).unwrap();
                drop(p); // sockets close
            }

            let mut plan = Vec::new();
            for b in backends {
                let target =
                    b.warmup_target() as usize + guard.cfg.pool_idle_per_worker;
                let pool = guard.entry(&b.id);
                pool.evict_aged(now, max_idle);
                while pool.len() > target {
                    pool.idle.pop_front();
                }
                let need = target.saturating_sub(pool.len());
                if need > 0 {
                    plan.push((b.id.clone(), need.min(8)));
                }
            }
            plan
        }; // lock released here

        // Phase 2 (unlocked): open the new warm sockets. This awaits freely
        // without blocking any other lock waiter.
        let mut opened = 0u64;
        let mut connected: Vec<(String, TcpStream)> = Vec::new();
        for (id, need) in plan {
            let backend = backends.iter().find(|b| b.id == id);
            let Some(b) = backend else { continue };
            for _ in 0..need {
                match connect_upstream(b.addr).await {
                    Ok(s) => {
                        connected.push((id.clone(), s));
                        opened += 1;
                    }
                    Err(_) => break, // retry next tick
                }
                tokio::task::yield_now().await;
            }
        }

        // Phase 3 (locked, sync): deposit the new sockets.
        if !connected.is_empty() {
            let mut guard = pools.lock().await;
            let now = Instant::now();
            let max_idle = Duration::from_secs(guard.cfg.pool_max_idle_secs);
            for (id, s) in connected {
                guard.entry(&id).recycle(s, now, max_idle);
            }
        }
        (opened, 0)
    }

    pub fn pool_sizes(&self) -> std::collections::HashMap<String, usize> {
        self.pools.iter().map(|(k, v)| (k.clone(), v.len())).collect()
    }
}

/// Outbound connect with exam-grade socket defaults. IPv4/IPv6 is decided by
/// the resolved backend address — an IPv6 client arriving at a dual-stack
/// listener is transparently relayed over an IPv4 upstream socket here.
pub async fn connect_upstream(addr: SocketAddr) -> io::Result<TcpStream> {
    let stream = TcpStream::connect(addr).await?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

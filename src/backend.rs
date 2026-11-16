//! Backend pool: membership, health/drain state machine, and the
//! primary/backup weighted least-connections selector.
//!
//! Hot path (per new connection):
//!   * one [`arc_swap::ArcSwap::load`] — an atomic pointer chase, no lock;
//!   * a linear scan over backends (dozens at most) reading relaxed atomics.
//!
//! Control path (admin API / health checker / ramp loop):
//!   * builds a new `Vec<Arc<Backend>>` and atomically swaps it in. Existing
//!     `Arc<Backend>` handles keep their identity so in-flight connections and
//!     warm pools never observe torn state.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use arc_swap::ArcSwap;
use serde::Serialize;

use crate::config::{BackendConfig, BackendGroup, CheckMode, DrainConfig};

const STATE_UP: u8 = 0;
const STATE_DRAINING: u8 = 1;
const STATE_DOWN: u8 = 2;

/// Fixed-point 1.0 for the backup ramp share.
const SHARE_ONE: u64 = 1_000_000;

pub struct Backend {
    pub id: String,
    pub addr: SocketAddr,
    pub weight: AtomicU64,
    pub group: BackendGroup,
    pub capacity: u64,
    pub check: CheckMode,

    state: AtomicU8,
    /// Force-close deadline while draining. Control-plane only, hence a mutex
    /// that the data plane never locks (it reads [`Backend::drain_deadline`]
    /// through an [`AtomicDeadline`]).
    drain_until: Mutex<Option<Instant>>,
    drain_deadline: AtomicDeadline,

    /// Active connections across ALL workers. Workers add/sub with relaxed
    /// ordering; only approximate fairness is required.
    active: AtomicU64,
    /// Warm pool target size per worker, set by the prewarm API.
    warmup_target: AtomicU64,
}

/// Stores an [`Instant`] as nanos-since-an-epoch base; `u64::MAX` = none.
struct AtomicDeadline {
    nanos: AtomicU64,
    base: Instant,
}

impl AtomicDeadline {
    fn new(base: Instant) -> Self {
        Self {
            nanos: AtomicU64::new(u64::MAX),
            base,
        }
    }
    fn store(&self, t: Option<Instant>) {
        match t {
            Some(t) => {
                let d = t.saturating_duration_since(self.base).as_nanos() as u64;
                self.nanos.store(d, Ordering::Release);
            }
            None => self.nanos.store(u64::MAX, Ordering::Release),
        }
    }
    fn get(&self) -> Option<Instant> {
        match self.nanos.load(Ordering::Acquire) {
            u64::MAX => None,
            d => Some(self.base + std::time::Duration::from_nanos(d)),
        }
    }
}

impl Backend {
    fn from_cfg(cfg: &BackendConfig, epoch: Instant) -> Self {
        Self {
            id: cfg.id.clone(),
            addr: crate::config::resolve_addr(&cfg.addr).expect("validated at config load"),
            weight: AtomicU64::new(cfg.weight as u64),
            group: cfg.group,
            capacity: cfg.capacity as u64,
            check: cfg.check,
            state: AtomicU8::new(STATE_UP),
            drain_until: Mutex::new(None),
            drain_deadline: AtomicDeadline::new(epoch),
            active: AtomicU64::new(0),
            warmup_target: AtomicU64::new(0),
        }
    }

    pub fn state(&self) -> BackendStateView {
        match self.state.load(Ordering::Acquire) {
            STATE_UP => BackendStateView::Up,
            STATE_DRAINING => BackendStateView::Draining,
            _ => BackendStateView::Down,
        }
    }

    /// Eligible for NEW connections.
    pub fn selectable(&self) -> bool {
        self.state.load(Ordering::Acquire) == STATE_UP
    }

    pub fn is_draining(&self) -> bool {
        self.state.load(Ordering::Acquire) == STATE_DRAINING
    }

    pub fn active(&self) -> u64 {
        self.active.load(Ordering::Relaxed)
    }

    pub fn inc_active(&self) {
        self.active.fetch_add(1, Ordering::Relaxed);
    }
    pub fn dec_active(&self) {
        self.active.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn warmup_target(&self) -> u64 {
        self.warmup_target.load(Ordering::Relaxed)
    }
    pub fn set_warmup_target(&self, n: u64) {
        self.warmup_target.store(n, Ordering::Relaxed);
    }

    pub fn weight(&self) -> u64 {
        self.weight.load(Ordering::Relaxed).max(1)
    }

    pub fn drain_deadline(&self) -> Option<Instant> {
        self.drain_deadline.get()
    }

    pub fn start_drain(&self, deadline: Instant) {
        *self.drain_until.lock().unwrap() = Some(deadline);
        self.drain_deadline.store(Some(deadline));
        self.state.store(STATE_DRAINING, Ordering::Release);
    }

    pub fn stop_drain(&self) {
        *self.drain_until.lock().unwrap() = None;
        self.drain_deadline.store(None);
        self.state.store(STATE_UP, Ordering::Release);
    }

    /// Health-checker only.
    pub fn mark_down(&self) {
        if self.state.load(Ordering::Acquire) != STATE_DOWN {
            self.state.store(STATE_DOWN, Ordering::Release);
        }
    }
    pub fn mark_up(&self) {
        // A manually draining backend is not revived by health checks.
        if self.state.load(Ordering::Acquire) == STATE_DOWN {
            self.state.store(STATE_UP, Ordering::Release);
        }
    }

    /// Remaining free capacity; saturates at zero.
    pub fn available(&self) -> u64 {
        self.capacity.saturating_sub(self.active())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendStateView {
    Up,
    Draining,
    Down,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendView {
    pub id: String,
    pub addr: String,
    pub weight: u64,
    pub group: String,
    pub capacity: u64,
    pub active: u64,
    pub available: u64,
    pub state: BackendStateView,
    pub warmup_target: u64,
    pub check: String,
}

pub struct Registry {
    list: ArcSwap<Vec<Arc<Backend>>>,
    /// Fraction (fixed point [`SHARE_ONE`]) of NEW connections sent to the
    /// backup group. Ramps to 1 when primary capacity is low, ramps back to 0
    /// slowly after primary recovers.
    backup_share: AtomicU64,
    pub drain_cfg: DrainConfig,
    epoch: Instant,
}

impl Registry {
    pub fn new(cfgs: &[BackendConfig], drain_cfg: DrainConfig) -> Arc<Self> {
        let epoch = Instant::now();
        let backends = cfgs
            .iter()
            .map(|c| Arc::new(Backend::from_cfg(c, epoch)))
            .collect();
        Arc::new(Self {
            list: ArcSwap::from(Arc::new(backends)),
            backup_share: AtomicU64::new(0),
            drain_cfg,
            epoch,
        })
    }

    /// Hot-path read: cheap Arc clone of the immutable snapshot pointer.
    pub fn snapshot(&self) -> Arc<Vec<Arc<Backend>>> {
        self.list.load_full()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Backend>> {
        self.list.load().iter().find(|b| b.id == id).cloned()
    }

    pub fn backup_share(&self) -> f64 {
        self.backup_share.load(Ordering::Relaxed) as f64 / SHARE_ONE as f64
    }

    pub fn views(&self) -> Vec<BackendView> {
        self.list
            .load()
            .iter()
            .map(|b| BackendView {
                id: b.id.clone(),
                addr: b.addr.to_string(),
                weight: b.weight(),
                group: format!("{:?}", b.group).to_lowercase(),
                capacity: b.capacity,
                active: b.active(),
                available: b.available(),
                state: b.state(),
                warmup_target: b.warmup_target(),
                check: format!("{:?}", b.check).to_lowercase(),
            })
            .collect()
    }

    fn replace(&self, mut next: Vec<Arc<Backend>>) {
        let cur = self.list.load();
        let by_id: HashMap<&str, &Arc<Backend>> =
            cur.iter().map(|b| (b.id.as_str(), b)).collect();
        // Preserve identity/state for backends that already exist.
        for b in &mut next {
            if let Some(existing) = by_id.get(b.id.as_str()) {
                *b = (*existing).clone();
            }
        }
        self.list.store(Arc::new(next));
    }

    pub fn add(&self, cfg: BackendConfig) -> anyhow::Result<()> {
        let mut next: Vec<Arc<Backend>> = self.list.load().as_ref().clone();
        if next.iter().any(|b| b.id == cfg.id) {
            anyhow::bail!("backend {} already exists", cfg.id);
        }
        next.push(Arc::new(Backend::from_cfg(&cfg, self.epoch)));
        self.replace(next);
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let mut next: Vec<Arc<Backend>> = self.list.load().as_ref().clone();
        let pos = next
            .iter()
            .position(|b| b.id == id)
            .ok_or_else(|| anyhow::anyhow!("unknown backend {id}"))?;
        let b = next.remove(pos);
        self.replace(next);
        // Existing connections keep their own Arc clone and finish naturally.
        drop(b);
        Ok(())
    }

    pub fn set_weight(&self, id: &str, weight: u64) -> anyhow::Result<()> {
        anyhow::ensure!(weight > 0, "weight must be > 0");
        let b = self.get(id).ok_or_else(|| anyhow::anyhow!("unknown backend {id}"))?;
        b.weight.store(weight, Ordering::Relaxed);
        Ok(())
    }

    pub fn drain(&self, id: &str, deadline_secs: Option<u64>) -> anyhow::Result<Instant> {
        let b = self.get(id).ok_or_else(|| anyhow::anyhow!("unknown backend {id}"))?;
        let secs = deadline_secs.unwrap_or(self.drain_cfg.deadline_secs);
        let deadline = Instant::now() + std::time::Duration::from_secs(secs);
        b.start_drain(deadline);
        Ok(deadline)
    }

    pub fn undrain(&self, id: &str) -> anyhow::Result<()> {
        let b = self.get(id).ok_or_else(|| anyhow::anyhow!("unknown backend {id}"))?;
        b.stop_drain();
        Ok(())
    }

    /// Set per-worker warm-pool target for one backend.
    pub fn prewarm_one(&self, id: &str, per_worker: u64) -> anyhow::Result<()> {
        let b = self.get(id).ok_or_else(|| anyhow::anyhow!("unknown backend {id}"))?;
        b.set_warmup_target(per_worker);
        Ok(())
    }

    /// Exam-style prewarm: total expected examinees are split across backends
    /// weighted by capacity, then each backend's share is divided by the number
    /// of workers to get a *per-worker* warm-pool target. The aggregate warm
    /// sockets across all workers therefore match the expected client count.
    pub fn prewarm(&self, expected_clients: u64, workers: usize) -> Vec<(String, u64)> {
        let workers = workers.max(1) as u64;
        let snapshot = self.snapshot();
        let total_cap: u64 = snapshot.iter().map(|b| b.capacity.max(1)).sum();
        let mut plan = Vec::new();
        for b in snapshot.iter() {
            let share = if total_cap == 0 {
                0
            } else {
                (expected_clients as u128 * b.capacity as u128 / total_cap as u128) as u64
            };
            // Per-worker target so the sum over workers approximates `share`.
            let target = share.div_ceil(workers);
            b.set_warmup_target(target);
            plan.push((b.id.clone(), target));
        }
        plan
    }

    /// Recompute the primary/backup ramp. Called periodically by the control
    /// loop. Backup engages when primary available capacity fraction drops
    /// below `backup_threshold`; recovery ramps share down one step per tick.
    pub fn update_ramp(&self, backup_engaged: bool) -> f64 {
        let cur = self.backup_share.load(Ordering::Relaxed);
        let step = (self.drain_cfg.recover_step.clamp(0.0, 1.0) * SHARE_ONE as f64) as u64;
        let next = if backup_engaged {
            SHARE_ONE
        } else if cur == 0 {
            0
        } else {
            cur.saturating_sub(step.max(1))
        };
        self.backup_share.store(next, Ordering::Relaxed);
        self.backup_share()
    }

    /// Whether primary available capacity is below threshold.
    pub fn primary_capacity_low(&self) -> bool {
        let (mut cap, mut free) = (0u64, 0u64);
        for b in self.list.load().iter() {
            if matches!(b.group, BackendGroup::Primary) && b.state() != BackendStateView::Down {
                cap += b.capacity;
                free += b.available();
            }
        }
        if cap == 0 {
            return true; // no primary capacity at all
        }
        (free as f64 / cap as f64) < self.drain_cfg.backup_threshold
    }

    /// Selector. `draw` is a worker-local pseudo-random in [0, 1); passing it
    /// in keeps this crate free of an RNG dependency and makes tests exact.
    pub fn select(&self, draw: f64) -> Option<Arc<Backend>> {
        let all = self.snapshot();
        let want_backup = draw < self.backup_share();
        let pick = |group: BackendGroup| -> Option<Arc<Backend>> {
            let mut best: Option<Arc<Backend>> = None;
            let mut best_score = f64::MAX;
            for b in all.iter() {
                if b.group != group || !b.selectable() {
                    continue;
                }
                // weighted least connections: active / weight
                let score = b.active() as f64 / b.weight() as f64;
                if score < best_score {
                    best_score = score;
                    best = Some(b.clone());
                }
            }
            best
        };
        if want_backup {
            pick(BackendGroup::Backup).or_else(|| pick(BackendGroup::Primary))
        } else {
            pick(BackendGroup::Primary).or_else(|| pick(BackendGroup::Backup))
        }
    }
}

/// Cheap deterministic xorshift64* so each worker spreads load without an RNG
/// crate. Seeded differently per worker.
pub struct SplitMix {
    state: u64,
}

impl SplitMix {
    pub fn new(seed: u64) -> Self {
        Self {
            state: seed ^ 0x9E37_79B9_7F4A_7C15,
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut z = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        self.state = z;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform-ish float in [0, 1).
    pub fn next_unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{BackendConfig, CheckMode, DrainConfig};

    fn cfg(id: &str, group: BackendGroup, cap: u32) -> BackendConfig {
        BackendConfig {
            id: id.into(),
            addr: "127.0.0.1:1".into(),
            weight: 100,
            group,
            capacity: cap,
            check: CheckMode::Off,
        }
    }

    fn drain_cfg() -> DrainConfig {
        DrainConfig {
            deadline_secs: 10,
            recover_step: 0.25,
            recover_tick_secs: 1,
            backup_threshold: 0.35,
        }
    }

    #[test]
    fn selects_primary_until_capacity_low() {
        let reg = Registry::new(
            &[
                cfg("p1", BackendGroup::Primary, 100),
                cfg("b1", BackendGroup::Backup, 100),
            ],
            drain_cfg(),
        );
        assert!(!reg.primary_capacity_low());
        for _ in 0..10 {
            let b = reg.select(0.5).unwrap();
            assert_eq!(b.id, "p1");
        }
        // exhaust primary capacity past 65%
        let p1 = reg.get("p1").unwrap();
        for _ in 0..80 {
            p1.inc_active();
        }
        assert!(reg.primary_capacity_low());
        reg.update_ramp(true);
        assert_eq!(reg.backup_share(), 1.0);
        let b = reg.select(0.5).unwrap();
        assert_eq!(b.id, "b1");
        // recovery ramps down
        reg.update_ramp(false);
        assert!(reg.backup_share() < 1.0);
    }

    #[test]
    fn draining_backend_is_not_selected() {
        let reg = Registry::new(
            &[cfg("p1", BackendGroup::Primary, 100)],
            drain_cfg(),
        );
        reg.drain("p1", Some(60)).unwrap();
        assert!(reg.select(0.1).is_none());
        reg.undrain("p1").unwrap();
        assert!(reg.select(0.1).is_some());
    }

    #[test]
    fn add_remove_preserves_identity() {
        let reg = Registry::new(&[cfg("p1", BackendGroup::Primary, 100)], drain_cfg());
        let first = reg.get("p1").unwrap();
        first.inc_active();
        reg.add(cfg("p2", BackendGroup::Primary, 100)).unwrap();
        let again = reg.get("p1").unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(again.active(), 1);
        reg.remove("p2").unwrap();
        assert!(reg.get("p2").is_none());
    }

    #[test]
    fn weighted_least_connections_balances() {
        let reg = Registry::new(
            &[
                cfg("p1", BackendGroup::Primary, 1_000_000),
                cfg("p2", BackendGroup::Primary, 1_000_000),
            ],
            drain_cfg(),
        );
        reg.get("p1").unwrap().inc_active();
        let b = reg.select(0.0).unwrap();
        assert_eq!(b.id, "p2");
    }
}

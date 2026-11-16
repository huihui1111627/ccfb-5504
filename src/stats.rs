//! Lock-free-friendly statistics primitives.
//!
//! Design rule: the forwarding hot path only ever touches worker-local data.
//! Each worker thread owns a [`WorkerStats`] behind its own `!Sync` cell; there
//! is no global mutex on the data plane. The admin task asks every worker for a
//! snapshot through a channel and merges them here.
//!
//! Cross-worker *control* signals (active connection counts the scheduler
//! needs) use atomics in [`crate::backend`], never locks.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Log-linear latency histogram in microseconds.
///
/// Buckets: [0,2us), [2,4), [4,8), ... powers of two up to ~137s, plus an
/// overflow bucket. Cheap on the hot path (one leading-zero scan), no
/// allocation, mergeable by addition.
#[derive(Debug)]
pub struct Histogram {
    buckets: Vec<AtomicU64>,
    sum_us: AtomicU64,
    min_us: AtomicU64,
    max_us: AtomicU64,
    count: AtomicU64,
}

const HIST_BUCKETS: usize = 48;

impl Histogram {
    pub fn new() -> Self {
        Self {
            buckets: (0..HIST_BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            sum_us: AtomicU64::new(0),
            min_us: AtomicU64::new(u64::MAX),
            max_us: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }

    pub fn observe(&self, d: Duration) {
        let us = d.as_micros() as u64;
        let idx = if us == 0 {
            0
        } else {
            // smallest k with 2^k > us, capped
            let k = 64 - us.leading_zeros();
            (k as usize).min(HIST_BUCKETS - 1)
        };
        self.buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.sum_us.fetch_add(us, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
        self.min_us.fetch_min(us, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> HistogramSnapshot {
        let buckets: Vec<u64> = self
            .buckets
            .iter()
            .map(|b| b.load(Ordering::Relaxed))
            .collect();
        let count: u64 = buckets.iter().sum();
        let min = self.min_us.load(Ordering::Relaxed);
        HistogramSnapshot {
            buckets,
            count,
            sum_us: self.sum_us.load(Ordering::Relaxed),
            min_us: if min == u64::MAX { 0 } else { min },
            max_us: self.max_us.load(Ordering::Relaxed),
        }
    }
}

impl Default for Histogram {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HistogramSnapshot {
    pub buckets: Vec<u64>,
    pub count: u64,
    pub sum_us: u64,
    pub min_us: u64,
    pub max_us: u64,
}

impl HistogramSnapshot {
    /// Quantile in microseconds. `q` in [0,1], e.g. 0.99 for p99.
    pub fn quantile_us(&self, q: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let target = (self.count as f64 * q).ceil() as u64;
        let mut acc = 0u64;
        for (idx, n) in self.buckets.iter().enumerate() {
            acc += n;
            if acc >= target {
                // bucket idx covers [2^(idx-1), 2^idx) us; report upper edge
                return if idx == 0 { 2 } else { 1u64 << idx };
            }
        }
        self.max_us
    }

    pub fn avg_us(&self) -> f64 {
        if self.count == 0 {
            0.0
        } else {
            self.sum_us as f64 / self.count as f64
        }
    }

    pub fn merge(&mut self, other: &HistogramSnapshot) {
        for (a, b) in self.buckets.iter_mut().zip(other.buckets.iter()) {
            *a += b;
        }
        self.count += other.count;
        self.sum_us += other.sum_us;
        self.max_us = self.max_us.max(other.max_us);
        if other.min_us > 0 {
            self.min_us = if self.min_us == 0 {
                other.min_us
            } else {
                self.min_us.min(other.min_us)
            };
        }
    }
}

/// Per-second ring of traffic counters. Oldest entries are overwritten; the
/// admin UI renders this as the traffic curve.
#[derive(Debug)]
pub struct TrafficRing {
    slots: Vec<TrafficSlot>,
    /// Second-of-timestamp of slot 0; ring rotates as wall time advances.
    base_sec: i64,
    len: usize,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct TrafficSlot {
    pub sec: i64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub conns_opened: u64,
    pub conns_closed: u64,
}

impl TrafficRing {
    pub fn new(len: usize, now: Instant) -> Self {
        let _ = now;
        Self {
            slots: (0..len).map(|_| TrafficSlot::default()).collect(),
            base_sec: 0,
            len,
        }
    }

    /// Rotate/initialize the ring against current unix seconds on first use
    /// and whenever time advances past the window.
    fn ensure(&mut self, now_sec: i64) {
        if self.base_sec == 0 {
            self.base_sec = now_sec;
            for s in &mut self.slots {
                s.sec = -1;
            }
        }
        let offset = now_sec - self.base_sec;
        if offset < 0 {
            // Clock step backwards: rebase without rewriting history.
            self.base_sec = now_sec;
            return;
        }
        if offset >= self.len as i64 {
            // Jump beyond window: clear and rebase.
            for s in &mut self.slots {
                *s = TrafficSlot::default();
                s.sec = -1;
            }
            self.base_sec = now_sec;
            return;
        }
    }
    fn slot(&mut self, now_sec: i64) -> &mut TrafficSlot {
        self.ensure(now_sec);
        let idx = (now_sec - self.base_sec) as usize % self.len;
        if self.slots[idx].sec != now_sec {
            self.slots[idx] = TrafficSlot {
                sec: now_sec,
                ..Default::default()
            };
        }
        &mut self.slots[idx]
    }

    pub fn record(&mut self, now_sec: i64, bytes_in: u64, bytes_out: u64, opened: u64, closed: u64) {
        let s = self.slot(now_sec);
        s.bytes_in += bytes_in;
        s.bytes_out += bytes_out;
        s.conns_opened += opened;
        s.conns_closed += closed;
    }

    pub fn snapshot(&self, now_sec: i64) -> Vec<TrafficSlot> {
        if self.base_sec == 0 {
            return Vec::new();
        }
        let start = now_sec - self.len as i64 + 1;
        let mut out = Vec::with_capacity(self.len);
        for sec in start..=now_sec {
            let idx = (sec - self.base_sec).rem_euclid(self.len as i64) as usize;
            let s = self.slots[idx];
            if s.sec == sec {
                out.push(s);
            } else {
                out.push(TrafficSlot {
                    sec,
                    ..Default::default()
                });
            }
        }
        out
    }
}

/// Everything one worker accumulates. Held inside the worker's LocalSet; the
/// histograms are `Arc`-shared (they are built entirely on atomics) so spawned
/// relay tasks can record latency without touching the rest of the struct.
#[derive(Debug)]
pub struct WorkerStats {
    pub worker_id: usize,
    pub active_conns: u64,
    pub total_opened: u64,
    pub total_closed: u64,
    /// Closed because a draining backend / draining LB exceeded its deadline.
    pub forced_disconnects: u64,
    pub rejected_no_backend: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub tcp_setup_us: Arc<Histogram>,
    pub relay_latency_us: Arc<Histogram>,
    pub udp_rtt_us: Arc<Histogram>,
    /// Shared handle handed to relay tasks; same allocation as
    /// `relay_latency_us`.
    pub relay_latency_arc: Arc<Histogram>,
    pub traffic: TrafficRing,
    pub started_at: Instant,
}

impl WorkerStats {
    pub fn new(worker_id: usize) -> Self {
        let relay = Arc::new(Histogram::new());
        Self {
            worker_id,
            active_conns: 0,
            total_opened: 0,
            total_closed: 0,
            forced_disconnects: 0,
            rejected_no_backend: 0,
            bytes_in: 0,
            bytes_out: 0,
            tcp_setup_us: Arc::new(Histogram::new()),
            relay_latency_us: relay.clone(),
            relay_latency_arc: relay,
            udp_rtt_us: Arc::new(Histogram::new()),
            traffic: TrafficRing::new(600, Instant::now()),
            started_at: Instant::now(),
        }
    }

    pub fn snapshot(&self, now_sec: i64) -> WorkerStatsSnapshot {
        WorkerStatsSnapshot {
            worker_id: self.worker_id,
            active_conns: self.active_conns,
            total_opened: self.total_opened,
            total_closed: self.total_closed,
            forced_disconnects: self.forced_disconnects,
            rejected_no_backend: self.rejected_no_backend,
            bytes_in: self.bytes_in,
            bytes_out: self.bytes_out,
            tcp_setup: self.tcp_setup_us.snapshot(),
            relay_latency: self.relay_latency_us.snapshot(),
            udp_rtt: self.udp_rtt_us.snapshot(),
            traffic: self.traffic.snapshot(now_sec),
            uptime_secs: self.started_at.elapsed().as_secs(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkerStatsSnapshot {
    pub worker_id: usize,
    pub active_conns: u64,
    pub total_opened: u64,
    pub total_closed: u64,
    pub forced_disconnects: u64,
    pub rejected_no_backend: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub tcp_setup: HistogramSnapshot,
    pub relay_latency: HistogramSnapshot,
    pub udp_rtt: HistogramSnapshot,
    pub traffic: Vec<TrafficSlot>,
    pub uptime_secs: u64,
}

/// Merged view the admin API serves. `forced_disconnect_ratio` is the headline
/// SLO number the benchmark reports.
#[derive(Debug, Clone, Serialize)]
pub struct GlobalStats {
    pub workers: Vec<WorkerStatsSnapshot>,
    pub active_conns: u64,
    pub total_opened: u64,
    pub total_closed: u64,
    pub forced_disconnects: u64,
    pub rejected_no_backend: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub forced_disconnect_ratio: f64,
    pub tcp_setup_p50_us: u64,
    pub tcp_setup_p99_us: u64,
    pub relay_p50_us: u64,
    pub relay_p99_us: u64,
    pub udp_rtt_p50_us: u64,
    pub udp_rtt_p99_us: u64,
    pub traffic: Vec<TrafficSlot>,
}

impl GlobalStats {
    pub fn merge(workers: Vec<WorkerStatsSnapshot>, _now_sec: i64) -> Self {
        let mut totals = WorkerStatsSnapshot {
            worker_id: usize::MAX,
            active_conns: 0,
            total_opened: 0,
            total_closed: 0,
            forced_disconnects: 0,
            rejected_no_backend: 0,
            bytes_in: 0,
            bytes_out: 0,
            tcp_setup: HistogramSnapshot {
                buckets: vec![0; HIST_BUCKETS],
                count: 0,
                sum_us: 0,
                min_us: 0,
                max_us: 0,
            },
            relay_latency: HistogramSnapshot {
                buckets: vec![0; HIST_BUCKETS],
                count: 0,
                sum_us: 0,
                min_us: 0,
                max_us: 0,
            },
            udp_rtt: HistogramSnapshot {
                buckets: vec![0; HIST_BUCKETS],
                count: 0,
                sum_us: 0,
                min_us: 0,
                max_us: 0,
            },
            traffic: Vec::new(),
            uptime_secs: 0,
        };
        let _n = workers.len().max(1);
        let mut traffic = vec![TrafficSlot::default(); 600];
        let mut have_traffic = false;
        for w in &workers {
            totals.active_conns += w.active_conns;
            totals.total_opened += w.total_opened;
            totals.total_closed += w.total_closed;
            totals.forced_disconnects += w.forced_disconnects;
            totals.rejected_no_backend += w.rejected_no_backend;
            totals.bytes_in += w.bytes_in;
            totals.bytes_out += w.bytes_out;
            totals.tcp_setup.merge(&w.tcp_setup);
            totals.relay_latency.merge(&w.relay_latency);
            totals.udp_rtt.merge(&w.udp_rtt);
            if !w.traffic.is_empty() {
                have_traffic = true;
                if traffic.len() != w.traffic.len() {
                    traffic = vec![TrafficSlot::default(); w.traffic.len()];
                }
                for (i, slot) in w.traffic.iter().enumerate() {
                    let t = &mut traffic[i];
                    t.sec = slot.sec;
                    t.bytes_in += slot.bytes_in;
                    t.bytes_out += slot.bytes_out;
                    t.conns_opened += slot.conns_opened;
                    t.conns_closed += slot.conns_closed;
                }
            }
        }
        if !have_traffic {
            traffic.clear();
        }
        let closed = totals.total_closed.max(0);
        let ratio = if closed > 0 {
            totals.forced_disconnects as f64 / closed as f64
        } else {
            0.0
        };
        GlobalStats {
            forced_disconnect_ratio: ratio,
            active_conns: totals.active_conns,
            total_opened: totals.total_opened,
            total_closed: totals.total_closed,
            forced_disconnects: totals.forced_disconnects,
            rejected_no_backend: totals.rejected_no_backend,
            bytes_in: totals.bytes_in,
            bytes_out: totals.bytes_out,
            tcp_setup_p50_us: totals.tcp_setup.quantile_us(0.50),
            tcp_setup_p99_us: totals.tcp_setup.quantile_us(0.99),
            relay_p50_us: totals.relay_latency.quantile_us(0.50),
            relay_p99_us: totals.relay_latency.quantile_us(0.99),
            udp_rtt_p50_us: totals.udp_rtt.quantile_us(0.50),
            udp_rtt_p99_us: totals.udp_rtt.quantile_us(0.99),
            traffic,
            workers,
        }
    }
}

/// Monotonic-ish unix seconds; workers call this once per I/O turn batch.
pub fn now_sec() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Traffic counters flushed per-connection into the worker ring periodically.
#[derive(Debug, Default, Clone, Copy)]
pub struct ConnCounters {
    pub bytes_in: u64,
    pub bytes_out: u64,
}

#[allow(dead_code)]
pub fn histogram_buckets() -> usize {
    HIST_BUCKETS
}

/// Merge two traffic snapshots pointwise (used in tests).
pub fn merge_traffic(a: &mut [TrafficSlot], b: &[TrafficSlot]) {
    for (x, y) in a.iter_mut().zip(b.iter()) {
        x.bytes_in += y.bytes_in;
        x.bytes_out += y.bytes_out;
        x.conns_opened += y.conns_opened;
        x.conns_closed += y.conns_closed;
    }
}

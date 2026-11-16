//! Static configuration loaded from TOML.
//!
//! Everything that can change at runtime (backend membership, weights, drain
//! state, warm-up targets) lives in [`crate::backend`] instead; this file only
//! covers boot-time knobs.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// HTTP API + management UI bind address.
    pub admin: AdminConfig,
    /// Number of worker threads. 0 / absent => number of available CPUs.
    #[serde(default)]
    pub workers: usize,
    #[serde(default)]
    pub prewarm: PrewarmConfig,
    #[serde(default)]
    pub health: HealthConfig,
    #[serde(default)]
    pub drain: DrainConfig,
    pub listeners: Vec<ListenerConfig>,
    #[serde(default)]
    pub backends: Vec<BackendConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdminConfig {
    pub listen: String,
    /// Directory of static assets; embedded assets are used when absent.
    #[serde(default)]
    pub static_dir: Option<String>,
    /// Unix control socket used for graceful handover on upgrade.
    #[serde(default = "default_control_socket")]
    pub control_socket: String,
    /// PID file path; the CLI uses it to locate a running instance.
    #[serde(default = "default_pid_file")]
    pub pid_file: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrewarmConfig {
    /// Idle outbound connections kept warm per (worker, backend).
    #[serde(default = "default_pool_idle")]
    pub pool_idle_per_worker: usize,
    /// How long a warm pool socket may sit idle before being recycled.
    #[serde(default = "default_pool_max_idle_secs")]
    pub pool_max_idle_secs: u64,
    /// When warm-up cannot reach a backend, retry at this cadence.
    #[serde(default = "default_warmup_retry_secs")]
    pub warmup_retry_secs: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HealthConfig {
    #[serde(default = "default_health_interval_secs")]
    pub interval_secs: u64,
    #[serde(default = "default_health_timeout_secs")]
    pub timeout_secs: u64,
    /// Consecutive failures before a backend is marked down.
    #[serde(default = "default_health_fall")]
    pub fall: u32,
    /// Consecutive successes before a drained/down backend is marked up again.
    #[serde(default = "default_health_rise")]
    pub rise: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DrainConfig {
    /// Grace period after which draining connections are force-closed.
    #[serde(default = "default_drain_deadline_secs")]
    pub deadline_secs: u64,
    /// Backup group ramp: share grows by this fraction per tick while primary
    /// is healthy, so traffic "slowly" moves back.
    #[serde(default = "default_recover_step")]
    pub recover_step: f64,
    #[serde(default = "default_recover_tick_secs")]
    pub recover_tick_secs: u64,
    /// Backup engages only when primary available capacity drops below this
    /// fraction of primary weight, e.g. 0.35 = 35%.
    #[serde(default = "default_backup_threshold")]
    pub backup_threshold: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ListenerConfig {
    pub name: String,
    /// `tcp` or `udp`.
    pub protocol: Protocol,
    /// e.g. "0.0.0.0:9000" or "[::]:9000" (dual-stack when the platform allows).
    pub listen: String,
    /// PROXY protocol version: `off`, `v1`, `v2`. TCP only.
    #[serde(default)]
    pub proxy_protocol: ProxyMode,
    #[serde(default = "default_udp_session_timeout_secs")]
    pub udp_session_timeout_secs: u64,
    /// Maximum simultaneous UDP sessions per worker; 0 = unlimited.
    #[serde(default)]
    pub udp_max_sessions: usize,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    #[default]
    Off,
    V1,
    V2,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BackendConfig {
    pub id: String,
    pub addr: String,
    #[serde(default = "default_weight")]
    pub weight: u32,
    #[serde(default)]
    pub group: BackendGroup,
    /// Capacity estimate (max concurrent long connections), used for the
    /// primary-vs-backup threshold and warm-up sizing.
    #[serde(default = "default_capacity")]
    pub capacity: u32,
    /// Health check: `tcp` (connect) or `off` (static, assumed healthy).
    #[serde(default = "default_check")]
    pub check: CheckMode,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendGroup {
    #[default]
    Primary,
    Backup,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckMode {
    #[default]
    Tcp,
    Off,
}

fn default_weight() -> u32 {
    100
}
fn default_capacity() -> u32 {
    10_000
}
fn default_check() -> CheckMode {
    CheckMode::Tcp
}
fn default_pool_idle() -> usize {
    8
}
fn default_pool_max_idle_secs() -> u64 {
    120
}
fn default_warmup_retry_secs() -> u64 {
    2
}
fn default_health_interval_secs() -> u64 {
    3
}
fn default_health_timeout_secs() -> u64 {
    1
}
fn default_health_fall() -> u32 {
    2
}
fn default_health_rise() -> u32 {
    2
}
fn default_drain_deadline_secs() -> u64 {
    120
}
fn default_recover_step() -> f64 {
    0.1
}
fn default_recover_tick_secs() -> u64 {
    2
}
fn default_backup_threshold() -> f64 {
    0.35
}
fn default_udp_session_timeout_secs() -> u64 {
    180
}
fn default_control_socket() -> String {
    "/tmp/exam-lb.sock".into()
}
fn default_pid_file() -> String {
    "/tmp/exam-lb.pid".into()
}

impl Config {
    pub fn load(path: &str) -> Result<Config> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config file {path}"))?;
        let cfg: Config = toml::from_str(&raw).context("parsing config TOML")?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(!self.listeners.is_empty(), "config has no listeners");
        anyhow::ensure!(!self.backends.is_empty(), "config has no backends");
        let mut names = std::collections::HashSet::new();
        for l in &self.listeners {
            anyhow::ensure!(names.insert(l.name.clone()), "duplicate listener {}", l.name);
            resolve_addr(&l.listen).with_context(|| format!("listener {}", l.name))?;
        }
        let mut ids = std::collections::HashSet::new();
        for b in &self.backends {
            anyhow::ensure!(ids.insert(b.id.clone()), "duplicate backend id {}", b.id);
            anyhow::ensure!(b.weight > 0, "backend {} weight must be > 0", b.id);
            resolve_addr(&b.addr).with_context(|| format!("backend {}", b.id))?;
        }
        anyhow::ensure!(
            (0.0..=1.0).contains(&self.drain.backup_threshold),
            "backup_threshold must be within [0, 1]"
        );
        Ok(())
    }

    pub fn worker_count(&self) -> usize {
        if self.workers == 0 {
            std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
        } else {
            self.workers
        }
    }

    pub fn health_interval(&self) -> Duration {
        Duration::from_secs(self.health.interval_secs)
    }
    pub fn health_timeout(&self) -> Duration {
        Duration::from_secs(self.health.timeout_secs)
    }
    pub fn drain_deadline(&self) -> Duration {
        Duration::from_secs(self.drain.deadline_secs)
    }
}

/// Resolve a `host:port` string into a concrete socket address. Configuration
/// uses resolved addresses everywhere so the hot path never blocks on DNS.
pub fn resolve_addr(s: &str) -> Result<SocketAddr> {
    use std::net::ToSocketAddrs;
    s.to_socket_addrs()
        .with_context(|| format!("resolving address {s}"))?
        .next()
        .ok_or_else(|| anyhow::anyhow!("no address resolved for {s}"))
}

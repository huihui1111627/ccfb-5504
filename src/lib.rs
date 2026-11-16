//! exam-lb: layer-4 TCP/UDP load balancer for online exam traffic.
//!
//! Crate layout:
//! - [`config`]   — boot-time TOML configuration
//! - [`stats`]    — per-worker lock-free counters, histograms, traffic ring
//! - [`backend`]  — backend pool state machine + primary/backup selector
//! - [`conntrack`]— per-worker connection table
//! - [`pool`]     — per-worker warm (pre-connected) backend pools
//! - [`relay`]    — bidirectional TCP relay pump
//! - [`socket`]   — SO_REUSEPORT / dual-stack socket helpers
//! - [`worker`]   — one event loop per core
//! - [`health`]   — active health checks
//! - [`control`]  — backup-ramp and prewarm control loops
//! - [`admin`]    — HTTP API + management UI
//! - [`upgrade`]  — zero-downtime fd handover (Unix)
//! - [`proxyproto`]— PROXY v1/v2 header encoding

pub mod admin;
pub mod backend;
pub mod config;
pub mod control;
pub mod conntrack;
pub mod health;
pub mod pool;
pub mod proxyproto;
pub mod relay;
pub mod socket;
pub mod stats;
pub mod ui;
pub mod worker;

#[cfg(unix)]
pub mod upgrade;

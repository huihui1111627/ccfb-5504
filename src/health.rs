//! Active health checking.
//!
//! Runs on the admin runtime (single task, sequential checks with a timeout)
//! so the data plane never pays for it. Backends with `check = "off"` are
//! treated as statically healthy and skipped. Results flip the atomic state in
//! [`crate::backend::Backend`]; workers observe the change through the same
//! lock-free registry snapshot they already read every connection.

use std::sync::Arc;
use std::time::Duration;

use crate::backend::{Backend, BackendStateView, Registry};
use crate::config::HealthConfig;

pub struct HealthChecker {
    registry: Arc<Registry>,
    cfg: HealthConfig,
}

impl HealthChecker {
    pub fn new(registry: Arc<Registry>, cfg: HealthConfig) -> Self {
        Self { registry, cfg }
    }

    pub fn spawn(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let period = Duration::from_secs(self.cfg.interval_secs.max(1));
            let mut ticker = tokio::time::interval(period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // Per-backend consecutive counters keyed by id.
            let mut fails: std::collections::HashMap<String, u32> =
                std::collections::HashMap::new();
            let mut rises: std::collections::HashMap<String, u32> =
                std::collections::HashMap::new();
            loop {
                ticker.tick().await;
                let backends = self.registry.snapshot();
                for b in backends.iter() {
                    if matches!(b.check, crate::config::CheckMode::Off) {
                        continue;
                    }
                    let ok = probe(b, Duration::from_secs(self.cfg.timeout_secs)).await;
                    let f = fails.entry(b.id.clone()).or_insert(0);
                    let r = rises.entry(b.id.clone()).or_insert(0);
                    match ok {
                        true => {
                            *f = 0;
                            if b.state() == BackendStateView::Down {
                                *r += 1;
                                if *r >= self.cfg.rise {
                                    b.mark_up();
                                    tracing::info!(backend = %b.id, "health recovered -> up");
                                    *r = 0;
                                }
                            }
                        }
                        false => {
                            *r = 0;
                            if b.state() != BackendStateView::Down {
                                *f += 1;
                                if *f >= self.cfg.fall {
                                    b.mark_down();
                                    tracing::warn!(backend = %b.id, "health failed -> down");
                                    *f = 0;
                                }
                            }
                        }
                    }
                }
            }
        })
    }
}

async fn probe(b: &Backend, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(b.addr)).await {
        Ok(Ok(s)) => {
            drop(s);
            true
        }
        Ok(Err(e)) => {
            tracing::debug!(backend = %b.id, error = %e, "health probe error");
            false
        }
        Err(_) => {
            tracing::debug!(backend = %b.id, "health probe timeout");
            false
        }
    }
}

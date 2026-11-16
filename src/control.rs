//! Control-plane background loops: primary/backup ramp and warm-up nudging.
//!
//! The ramp rule (requirement 2):
//!   * when primary available capacity drops below `backup_threshold`, backup
//!     share snaps to 100% of *new* connections;
//!   * after primary recovers, share decays by `recover_step` every tick so
//!     traffic "slowly" moves back instead of stampeding.
//!
//! Existing connections are never moved — only new-connection routing changes.

use std::sync::Arc;
use std::time::Duration;

use crate::backend::Registry;

pub fn spawn_ramp_loop(registry: Arc<Registry>, tick_secs: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs.max(1)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut engaged = false;
        loop {
            ticker.tick().await;
            let low = registry.primary_capacity_low();
            // Hysteresis: engage immediately, disengage only when capacity is
            // comfortably above the threshold to avoid flapping at the edge.
            if low {
                engaged = true;
            } else if !low && !registry_under_pressure(&registry) {
                engaged = false;
            }
            let share = registry.update_ramp(engaged);
            if share != 0.0 || engaged {
                tracing::debug!(backup_share = share, engaged, "ramp update");
            }
        }
    })
}

/// Secondary check used for hysteresis: primary has at least 1.5x threshold
/// headroom before we start ramping back.
fn registry_under_pressure(registry: &Arc<Registry>) -> bool {
    let snapshot = registry.snapshot();
    let (mut cap, mut free) = (0u64, 0u64);
    for b in snapshot.iter() {
        if matches!(b.group, crate::config::BackendGroup::Primary)
            && b.state() != crate::backend::BackendStateView::Down
        {
            cap += b.capacity;
            free += b.available();
        }
    }
    if cap == 0 {
        return true;
    }
    let frac = free as f64 / cap as f64;
    frac < registry.drain_cfg.backup_threshold * 1.5
}

/// Periodically nudge workers to reconcile warm pools. The workers themselves
/// own the reconcile logic (per-worker target sizes); this loop just sends the
/// tick so prewarm takes effect promptly after an API call.
pub fn spawn_prewarm_nudger(
    handles: Arc<Vec<crate::worker::WorkerHandle>>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            for h in handles.iter() {
                let _ = h.tx.send(crate::worker::WorkerMessage::PrewarmTick);
            }
        }
    })
}

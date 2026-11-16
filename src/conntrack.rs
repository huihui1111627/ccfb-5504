//! Per-worker connection table.
//!
//! Each worker owns one `ConnTable` inside its LocalSet — the data plane
//! touches it without any lock or atomic. The admin plane never reaches into
//! it directly: it sends a request over a channel and receives a serializable
//! snapshot page.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::Protocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnState {
    Active,
    Draining,
}

pub struct ConnEntry {
    pub id: u64,
    pub worker_id: usize,
    pub listener: String,
    pub protocol: Protocol,
    pub client_addr: SocketAddr,
    pub backend_id: String,
    pub backend_addr: SocketAddr,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub created_at: Instant,
    pub state: ConnState,
    /// When draining: force-close deadline.
    pub drain_deadline: Option<Instant>,
    /// Last I/O activity, for idle diagnostics.
    pub last_io: Instant,
}

impl ConnEntry {
    pub fn age(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.created_at)
    }
}

pub struct ConnTable {
    pub(crate) worker_id: usize,
    pub(crate) conns: HashMap<u64, ConnEntry>,
    next_id: u64,
}

impl ConnTable {
    pub fn new(worker_id: usize) -> Self {
        Self {
            worker_id,
            conns: HashMap::new(),
            next_id: (worker_id as u64 + 1) << 40,
        }
    }

    pub fn insert(
        &mut self,
        listener: String,
        protocol: Protocol,
        client_addr: SocketAddr,
        backend_id: String,
        backend_addr: SocketAddr,
        now: Instant,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.conns.insert(
            id,
            ConnEntry {
                id,
                worker_id: self.worker_id,
                listener,
                protocol,
                client_addr,
                backend_id,
                backend_addr,
                bytes_in: 0,
                bytes_out: 0,
                created_at: now,
                state: ConnState::Active,
                drain_deadline: None,
                last_io: now,
            },
        );
        id
    }

    pub fn remove(&mut self, id: u64) -> Option<ConnEntry> {
        self.conns.remove(&id)
    }

    pub fn add_bytes(&mut self, id: u64, in_bytes: u64, out_bytes: u64, now: Instant) {
        if let Some(e) = self.conns.get_mut(&id) {
            e.bytes_in += in_bytes;
            e.bytes_out += out_bytes;
            e.last_io = now;
        }
    }

    pub fn mark_draining(&mut self, backend_id: &str, deadline: Instant) -> usize {
        let mut n = 0;
        for e in self.conns.values_mut() {
            if e.backend_id == backend_id && e.state == ConnState::Active {
                e.state = ConnState::Draining;
                e.drain_deadline = Some(deadline);
                n += 1;
            }
        }
        n
    }

    /// IDs whose drain deadline has expired — the worker force-closes them.
    pub fn drain_expired(&self, now: Instant) -> Vec<u64> {
        self.conns
            .values()
            .filter(|e| {
                e.state == ConnState::Draining
                    && e.drain_deadline.map(|d| now >= d).unwrap_or(false)
            })
            .map(|e| e.id)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.conns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.conns.is_empty()
    }

    /// Snapshot page for the admin API. Filters are simple substring matches;
    /// workers return page-sized slices and the admin merges/paginates.
    pub fn snapshot(&self, filter: &ConnFilter, now: Instant) -> Vec<ConnView> {
        self.conns
            .values()
            .filter(|e| filter.matches(e))
            .map(|e| ConnView {
                id: e.id,
                worker_id: e.worker_id,
                listener: e.listener.clone(),
                protocol: match e.protocol {
                    Protocol::Tcp => "tcp",
                    Protocol::Udp => "udp",
                }
                .into(),
                client_addr: e.client_addr.to_string(),
                backend_id: e.backend_id.clone(),
                backend_addr: e.backend_addr.to_string(),
                bytes_in: e.bytes_in,
                bytes_out: e.bytes_out,
                age_ms: e.age(now).as_millis() as u64,
                state: match e.state {
                    ConnState::Active => "active",
                    ConnState::Draining => "draining",
                }
                .into(),
                idle_ms: now.saturating_duration_since(e.last_io).as_millis() as u64,
            })
            .collect()
    }
}

#[derive(Debug, Default, Clone)]
pub struct ConnFilter {
    pub backend_id: Option<String>,
    pub listener: Option<String>,
    pub text: Option<String>,
}

impl ConnFilter {
    fn matches(&self, e: &ConnEntry) -> bool {
        if let Some(b) = &self.backend_id {
            if &e.backend_id != b {
                return false;
            }
        }
        if let Some(l) = &self.listener {
            if &e.listener != l {
                return false;
            }
        }
        if let Some(t) = &self.text {
            let t = t.to_lowercase();
            if !e.client_addr.to_string().to_lowercase().contains(&t)
                && !e.backend_addr.to_string().to_lowercase().contains(&t)
                && !e.backend_id.to_lowercase().contains(&t)
            {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnView {
    pub id: u64,
    pub worker_id: usize,
    pub listener: String,
    pub protocol: String,
    pub client_addr: String,
    pub backend_id: String,
    pub backend_addr: String,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub age_ms: u64,
    pub state: String,
    pub idle_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    fn addr(p: u16) -> SocketAddr {
        format!("127.0.0.1:{p}").parse().unwrap()
    }

    #[test]
    fn lifecycle_and_drain() {
        let mut t = ConnTable::new(0);
        let now = Instant::now();
        let id = t.insert(
            "l1".into(),
            Protocol::Tcp,
            addr(1000),
            "b1".into(),
            addr(2000),
            now,
        );
        t.add_bytes(id, 10, 20, now);
        assert_eq!(t.len(), 1);
        let dl = now + Duration::from_secs(5);
        assert_eq!(t.mark_draining("b1", dl), 1);
        assert!(t.drain_expired(now).is_empty());
        assert_eq!(t.drain_expired(now + Duration::from_secs(6)), vec![id]);
        let v = t.snapshot(&ConnFilter::default(), now + Duration::from_secs(1));
        assert_eq!(v[0].bytes_in, 10);
        assert_eq!(v[0].state, "draining");
        t.remove(id);
        assert!(t.is_empty());
    }
}

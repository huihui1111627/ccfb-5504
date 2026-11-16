//! Worker thread: one per core, each with its own current-thread runtime and
//! LocalSet. Everything touched on the I/O path — connection table, warm
//! pools, traffic counters, latency histograms — is owned here and never
//! shared, so the data plane takes no global lock. Cross-worker coordination
//! (backend selection, active counts) goes through lock-free atomics in
//! [`crate::backend`] and [`crate::stats`].
//!
//! Event-loop design: the worker owns *long-lived* socket futures (one per
//! listener) stored in `tcp_accepts`/`udp_accepts`. A single `select!` polls
//! those futures plus the two mpsc receivers every iteration. Because the
//! futures are never recreated while Pending, their waker registrations stay
//! valid and the task is reliably woken on I/O. Relay/UDP sessions run as
//! detached LocalSet tasks and report back over the event channel.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::backend::{Registry, SplitMix};
use crate::config::{ListenerConfig, Protocol, ProxyMode};
use crate::conntrack::{ConnFilter, ConnState, ConnTable, ConnView};
use crate::pool::WarmPools;
use crate::proxyproto;
use crate::relay::{Relay, RelayOutcome};
use crate::socket::{connect_udp, listener_raw_fd, udp_raw_fd};
use crate::stats::{now_sec, WorkerStats, WorkerStatsSnapshot};

// ============================== messages ==================================

pub enum WorkerMessage {
    Stats(mpsc::Sender<WorkerStatsSnapshot>),
    Conns {
        filter: ConnFilter,
        reply: mpsc::Sender<Vec<ConnView>>,
    },
    PrewarmTick,
    Drain {
        deadline: Instant,
        ack: mpsc::Sender<WorkerDrainAck>,
    },
    Handover {
        ack: mpsc::Sender<HandoverFds>,
    },
    PoolSizes(mpsc::Sender<HashMap<String, usize>>),
}

#[derive(Debug)]
pub struct WorkerDrainAck {
    pub worker_id: usize,
    pub active_conns: u64,
}

#[derive(Debug)]
pub struct HandoverFds {
    pub worker_id: usize,
    pub tcp: Vec<std::os::fd::RawFd>,
    pub udp: Vec<std::os::fd::RawFd>,
}

enum RelayEvent {
    Bytes {
        conn_id: u64,
        bytes_in: u64,
        bytes_out: u64,
    },
    Finished {
        conn_id: u64,
        backend_id: String,
        outcome: RelayOutcome,
    },
    UdpFlow(UdpFlowResult),
}

struct UdpFlowResult {
    listener: String,
    peer: SocketAddr,
    backend_id: String,
    reply: Option<Vec<u8>>,
    bytes_in: u64,
    rtt: Duration,
    rejected: bool,
}

pub struct WorkerHandle {
    pub id: usize,
    pub tx: mpsc::UnboundedSender<WorkerMessage>,
    pub thread: Option<std::thread::JoinHandle<()>>,
}

pub type DrainFlag = Arc<AtomicBool>;
pub type Inherited =
    Option<(Vec<std::os::fd::RawFd>, Vec<std::os::fd::RawFd>)>;

// ============================== accept slots ==============================

type TcpFut =
    Pin<Box<dyn std::future::Future<Output = io::Result<(TcpStream, SocketAddr)>> + Send>>;

struct TcpAcceptSlot {
    name: String,
    listener: TcpListener,
    fut: TcpFut,
}

impl TcpAcceptSlot {
    fn new(name: String, l: TcpListener) -> Self {
        let fut = Self::make_fut(&l);
        Self { name, listener: l, fut }
    }
    fn make_fut(l: &TcpListener) -> TcpFut {
        let l2 = dup_tcp_listener(l);
        Box::pin(async move { l2.accept().await })
    }
    fn rearm(&mut self) {
        self.fut = Self::make_fut(&self.listener);
    }
}

type UdpFut = Pin<
    Box<
        dyn std::future::Future<Output = io::Result<(Vec<u8>, SocketAddr)>>
            + Send,
    >,
>;

struct UdpAcceptSlot {
    name: String,
    sock: UdpSocket,
    /// Owned receive buffer. The recv future must write into memory that
    /// outlives every poll; keeping it here (rather than a local inside the
    /// async block) prevents the buffer being dropped while the kernel still
    /// holds a pending read registration against it.
    rbuf: Vec<u8>,
    fut: Option<UdpFut>,
}

impl UdpAcceptSlot {
    fn new(name: String, s: UdpSocket) -> Self {
        let mut slot = Self {
            name,
            sock: s,
            rbuf: vec![0u8; 65535],
            fut: None,
        };
        slot.arm();
        slot
    }

    fn arm(&mut self) {
        // Take the buffer so the future owns it; on completion the datagram
        // bytes are returned and a fresh buffer is installed on re-arm.
        let buf = std::mem::take(&mut self.rbuf);
        let s2 = dup_udp(&self.sock);
        self.fut = Some(Box::pin(async move {
            let mut buf = buf;
            let (n, peer) = s2.recv_from(&mut buf).await?;
            buf.truncate(n);
            Ok((buf, peer))
        }));
    }

    fn rearm(&mut self) {
        // The previous future consumed its buffer; allocate a new one.
        if self.rbuf.is_empty() {
            self.rbuf = vec![0u8; 65535];
        }
        self.arm();
    }
}

struct UdpDatagram {
    listener: String,
    data: Vec<u8>,
    peer: SocketAddr,
}

// ============================== listener set ==============================

pub struct ListenerSet {
    tcp: HashMap<String, TcpListener>,
    udp: HashMap<String, UdpSocket>,
    cfgs: Vec<ListenerConfig>,
}

impl ListenerSet {
    fn bind_all(cfgs: &[ListenerConfig]) -> io::Result<Self> {
        let mut tcp = HashMap::new();
        let mut udp = HashMap::new();
        for c in cfgs {
            let addr: SocketAddr = c
                .listen
                .parse()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("{e}")))?;
            match c.protocol {
                Protocol::Tcp => {
                    tcp.insert(c.name.clone(), crate::socket::bind_tcp(addr, 65535)?);
                }
                Protocol::Udp => {
                    udp.insert(c.name.clone(), crate::socket::bind_udp(addr)?);
                }
            }
        }
        Ok(Self { tcp, udp, cfgs: cfgs.to_vec() })
    }

    /// Duplicate every bound socket via fd dup. The result references the same
    /// kernel sockets, so accepts across workers contend on one listener.
    fn dup(&self) -> ListenerSet {
        let tcp = self
            .tcp
            .iter()
            .map(|(n, l)| (n.clone(), dup_tcp_listener(l)))
            .collect();
        let udp = self
            .udp
            .iter()
            .map(|(n, s)| (n.clone(), dup_udp(s)))
            .collect();
        ListenerSet {
            tcp,
            udp,
            cfgs: self.cfgs.clone(),
        }
    }
}

// ============================== worker state ==============================

struct Worker {
    id: usize,
    registry: Arc<Registry>,
    stats: WorkerStats,
    table: ConnTable,
    /// Behind an async mutex so a background reconcile task can grow the pool
    /// without stalling the control channel (stats/pools queries take the lock
    /// briefly or skip a round while reconcile holds it).
    pools: Arc<tokio::sync::Mutex<WarmPools>>,
    rng: SplitMix,
    drain_flag: DrainFlag,
    listeners: ListenerSet,
    tcp_accepts: Vec<TcpAcceptSlot>,
    udp_accepts: Vec<UdpAcceptSlot>,
    global_drain_deadline: Option<Instant>,
    proxy_modes: HashMap<String, ProxyMode>,
    events: mpsc::UnboundedReceiver<RelayEvent>,
    event_tx: mpsc::UnboundedSender<RelayEvent>,
    control_rx: mpsc::UnboundedReceiver<WorkerMessage>,
    relays: HashMap<u64, (String, JoinHandle<()>)>,
    opened_this_sec: u64,
    closed_this_sec: u64,
    traffic_sec: i64,
}

// ============================== entry point ===============================

/// Bind every configured listener exactly once. All workers then dup these
/// shared fds and call accept on the *same* kernel socket. This is required
/// for portability: macOS does not spread connections across independent
/// SO_REUSEPORT sockets the way Linux does (it pins them to one socket), so
/// per-worker binds there leave every connection on a single worker. Sharing
/// one socket gives fair, kernel-driven accept competition on both platforms.
pub fn bind_shared_listeners(
    cfgs: &[ListenerConfig],
) -> io::Result<Arc<ListenerSet>> {
    Ok(Arc::new(ListenerSet::bind_all(cfgs)?))
}

/// Build an empty listener set carrying only the config. Used by a new process
/// inheriting fds via handover: it must not bind the port itself (the old
/// generation still owns it); workers populate the maps through adoption.
pub fn empty_shared_listeners(cfgs: &[ListenerConfig]) -> Arc<ListenerSet> {
    Arc::new(ListenerSet {
        tcp: HashMap::new(),
        udp: HashMap::new(),
        cfgs: cfgs.to_vec(),
    })
}

pub fn spawn_worker(
    id: usize,
    registry: Arc<Registry>,
    shared_listeners: Arc<ListenerSet>,
    pools_cfg: crate::config::PrewarmConfig,
    drain_flag: DrainFlag,
    inherited: Inherited,
) -> io::Result<WorkerHandle> {
    let (tx, rx) = mpsc::unbounded_channel::<WorkerMessage>();
    let thread = std::thread::Builder::new()
        .name(format!("lb-worker-{id}"))
        .spawn(move || {
            // Surface worker-task panics instead of silently dropping them in
            // the detached thread.
            std::panic::set_hook(Box::new(|info| {
                tracing::error!(%info, "worker task panicked");
            }));
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("worker runtime");
            let local = tokio::task::LocalSet::new();
            local.block_on(&rt, async move {
                run_worker(id, registry, shared_listeners, pools_cfg, drain_flag, inherited, rx).await;
            });
        })?;
    Ok(WorkerHandle { id, tx, thread: Some(thread) })
}

async fn run_worker(
    id: usize,
    registry: Arc<Registry>,
    shared_listeners: Arc<ListenerSet>,
    pools_cfg: crate::config::PrewarmConfig,
    drain_flag: DrainFlag,
    inherited: Inherited,
    control_channel: mpsc::UnboundedReceiver<WorkerMessage>,
) {
    // Duplicate the shared, already-bound sockets for this worker's accept
    // slots. dup gives an independent fd referencing the same open file
    // description, so every worker competes for accepts on one kernel socket.
    let mut listeners = (*shared_listeners).dup();
    if let Some((tcp_fds, udp_fds)) = inherited {
        adopt_fds(id, &mut listeners, &shared_listeners.cfgs, tcp_fds, udp_fds);
    }

    let proxy_modes: HashMap<String, ProxyMode> = shared_listeners
        .cfgs
        .iter()
        .map(|c| (c.name.clone(), c.proxy_protocol))
        .collect();
    let (event_tx, events) = mpsc::unbounded_channel();
    let control_rx = control_channel;
    let tcp_accepts = listeners
        .tcp
        .iter()
        .map(|(n, l)| TcpAcceptSlot::new(n.clone(), dup_tcp_listener(l)))
        .collect();
    let udp_accepts = listeners
        .udp
        .iter()
        .map(|(n, s)| UdpAcceptSlot::new(n.clone(), dup_udp(s)))
        .collect();

    let pools = Arc::new(tokio::sync::Mutex::new(WarmPools::new(pools_cfg)));
    let mut w = Box::new(Worker {
        id,
        registry,
        stats: WorkerStats::new(id),
        table: ConnTable::new(id),
        pools: pools.clone(),
        rng: SplitMix::new(0x5151_5151 ^ ((id as u64) << 32)),
        drain_flag,
        listeners,
        tcp_accepts,
        udp_accepts,
        global_drain_deadline: None,
        proxy_modes,
        events,
        event_tx,
        control_rx,
        relays: HashMap::new(),
        opened_this_sec: 0,
        closed_this_sec: 0,
        traffic_sec: now_sec(),
    });

    // Background pool maintenance on the same LocalSet. It grows the warm
    // pools in small batches, re-acquiring the lock per backend so admin
    // queries (which take the same lock briefly) are never starved.
    let maint_registry = w.registry.clone();
    let maint_pools = pools.clone();
    tokio::task::spawn_local(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let backends = maint_registry.snapshot();
            let (opened, closed) =
                WarmPools::reconcile(&maint_pools, &backends).await;
            if opened + closed > 0 {
                tracing::debug!(
                    worker = id,
                    warm_opened = opened,
                    warm_closed = closed,
                    "prewarm reconcile"
                );
            }
        }
    });

    loop {
        // Poll every long-lived source through a 'static poll_fn so the
        // future passed to the runtime owns no short-lived borrows. The raw
        // pointer is sound: the whole loop runs on one LocalSet thread and
        // the Worker outlives every await.
        let wptr: *mut Worker = &mut *w;
        let poll = std::future::poll_fn(move |cx| {
            let w = unsafe { &mut *wptr };
            if let Poll::Ready(Some(ev)) = Pin::new(&mut w.events).poll_recv(cx) {
                return Poll::Ready(Wake::Event(ev));
            }
            if let Poll::Ready(Some(msg)) = Pin::new(&mut w.control_rx).poll_recv(cx) {
                return Poll::Ready(Wake::Control(msg));
            }
            // TCP: when a listener wakes, drain its whole backlog in this pass
            // rather than accepting one connection per wake. Under a burst
            // (the exam-minute rush) this prevents the kernel accept queue
            // filling and the kernel dropping/resetting new connections.
            let mut accepted: Vec<(String, TcpStream, SocketAddr)> = Vec::new();
            for slot in w.tcp_accepts.iter_mut() {
                loop {
                    match slot.fut.as_mut().poll(cx) {
                        Poll::Ready(r) => {
                            let name = slot.name.clone();
                            slot.rearm();
                            match r {
                                Ok((stream, peer)) => accepted.push((name, stream, peer)),
                                Err(e) => {
                                    tracing::warn!(listener = %name, error = %e, "accept failed");
                                    break;
                                }
                            }
                        }
                        Poll::Pending => break,
                    }
                }
            }
            if !accepted.is_empty() {
                return Poll::Ready(Wake::TcpBatch(accepted));
            }
            for slot in w.udp_accepts.iter_mut() {
                let Some(fut) = slot.fut.as_mut() else { continue };
                if let Poll::Ready(r) = fut.as_mut().poll(cx) {
                    let name = slot.name.clone();
                    slot.rearm();
                    return Poll::Ready(match r {
                        Ok((data, peer)) => Wake::Udp(UdpDatagram { listener: name, data, peer }),
                        Err(e) => {
                            tracing::warn!(listener = %name, error = %e, "udp recv failed");
                            Wake::Spurious
                        }
                    });
                }
            }
            Poll::Pending
        });

        match poll.await {
            Wake::Event(ev) => handle_relay_event(&mut w, ev),
            Wake::Control(msg) => handle_control(&mut w, msg).await,
            Wake::TcpBatch(batch) => {
                for (name, stream, peer) in batch {
                    handle_tcp(&mut w, name, stream, peer).await;
                }
            }
            Wake::Udp(dg) => spawn_udp_flow(&mut w, dg),
            Wake::Spurious => {}
        }

        flush_traffic(&mut w);

        if w.drain_flag.load(Ordering::Acquire)
            && w.tcp_accepts.is_empty()
            && w.udp_accepts.is_empty()
            && w.relays.is_empty()
        {
            tracing::info!(worker = w.id, "drained, exiting");
            break;
        }
    }
}

enum Wake {
    Event(RelayEvent),
    Control(WorkerMessage),
    TcpBatch(Vec<(String, TcpStream, SocketAddr)>),
    Udp(UdpDatagram),
    Spurious,
}


// ============================== control ===================================

fn flush_traffic(w: &mut Worker) {
    let sec = now_sec();
    if sec != w.traffic_sec {
        w.stats.traffic.record(
            w.traffic_sec,
            0,
            0,
            w.opened_this_sec,
            w.closed_this_sec,
        );
        w.opened_this_sec = 0;
        w.closed_this_sec = 0;
        w.traffic_sec = sec;
    }
}

// ============================== control ===================================

async fn handle_control(w: &mut Worker, msg: WorkerMessage) {
    match msg {
        WorkerMessage::Stats(reply) => {
            let _ = reply.send(w.stats.snapshot(now_sec())).await;
        }
        WorkerMessage::Conns { filter, reply } => {
            let _ = reply.send(w.table.snapshot(&filter, Instant::now())).await;
        }
        WorkerMessage::PrewarmTick => {
            // Reconcile now runs in the dedicated background task; this branch
            // only propagates drain state, which is synchronous.
            propagate_backend_drain(w);
        }
        WorkerMessage::PoolSizes(reply) => {
            // The pool lock is only ever held across synchronous bookkeeping,
            // so this resolves immediately even during a large prewarm.
            let sizes = w.pools.lock().await.pool_sizes();
            let _ = reply.send(sizes).await;
        }
        WorkerMessage::Drain { deadline, ack } => {
            w.drain_flag.store(true, Ordering::Release);
            w.global_drain_deadline = Some(deadline);
            for e in w.table.conns_mut() {
                if e.state == ConnState::Active {
                    e.state = ConnState::Draining;
                    e.drain_deadline = Some(deadline);
                }
            }
            let _ = ack
                .send(WorkerDrainAck {
                    worker_id: w.id,
                    active_conns: w.stats.active_conns,
                })
                .await;
        }
        WorkerMessage::Handover { ack } => {
            // Dup every listener fd BEFORE dropping our owned sockets. The dups
            // are independent descriptors that stay valid for sendmsg even after
            // this worker clears its accept slots and listener maps; the kernel
            // keeps the underlying socket alive while any fd (including the new
            // process's inherited copy) references it.
            let mut tcp = Vec::new();
            let mut udp = Vec::new();
            let dup_ok = (|| -> std::io::Result<()> {
                for l in w.listeners.tcp.values() {
                    tcp.push(unsafe { dup_raw(listener_raw_fd(l)) }?);
                }
                for s in w.listeners.udp.values() {
                    udp.push(unsafe { dup_raw(udp_raw_fd(s)) }?);
                }
                Ok(())
            })();
            if let Err(e) = dup_ok {
                tracing::error!(worker = w.id, error = %e, "handover fd dup failed");
                let _ = ack
                    .send(HandoverFds { worker_id: w.id, tcp: vec![], udp: vec![] })
                    .await;
                return;
            }
            let _ = ack
                .send(HandoverFds {
                    worker_id: w.id,
                    tcp,
                    udp,
                })
                .await;
            w.tcp_accepts.clear();
            w.udp_accepts.clear();
            w.listeners.tcp.clear();
            w.listeners.udp.clear();
            w.drain_flag.store(true, Ordering::Release);
        }
    }
}

fn propagate_backend_drain(w: &mut Worker) {
    let now = Instant::now();
    let backends = w.registry.snapshot();
    for b in backends.iter() {
        if b.is_draining() {
            if let Some(dl) = b.drain_deadline() {
                w.table.mark_draining(&b.id, dl);
            }
        }
    }
    // Force-close connections whose drain deadline expired.
    for conn_id in w.table.drain_expired(now) {
        if let Some((_bid, handle)) = w.relays.remove(&conn_id) {
            handle.abort();
            finalize_conn(w, conn_id, RelayOutcome::Forced);
        }
    }
    if let Some(dl) = w.global_drain_deadline {
        for e in w.table.conns_mut() {
            if e.state == ConnState::Active {
                e.state = ConnState::Draining;
                e.drain_deadline = Some(dl);
            }
        }
    }
}

// ============================== TCP relay =================================

async fn handle_tcp(w: &mut Worker, listener: String, mut client: TcpStream, peer: SocketAddr) {
    use tokio::io::AsyncWriteExt;
    let _ = client.set_nodelay(true);
    if w.drain_flag.load(Ordering::Acquire) {
        let _ = client.shutdown().await;
        return;
    }
    let backend = match w.registry.select(w.rng.next_unit()) {
        Some(b) => b,
        None => {
            w.stats.rejected_no_backend += 1;
            let _ = client.shutdown().await;
            return;
        }
    };

    let setup_start = Instant::now();
    let (upstream, pool_wait, _pooled) = match w.pools.lock().await.acquire(&backend).await {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(backend = %backend.id, error = %e, "upstream connect failed");
            w.stats.rejected_no_backend += 1;
            let _ = client.shutdown().await;
            return;
        }
    };
    w.stats.tcp_setup_us.observe(setup_start.elapsed().max(pool_wait));

    let mode = w.proxy_modes.get(&listener).copied().unwrap_or(ProxyMode::Off);
    let hdr = if mode == ProxyMode::Off {
        None
    } else {
        Some(proxyproto::encode(mode, peer, backend.addr))
    };

    let conn_id = w.table.insert(
        listener,
        Protocol::Tcp,
        peer,
        backend.id.clone(),
        backend.addr,
        Instant::now(),
    );
    let mut relay = Relay::new(client, upstream, hdr);
    if let Some(dl) = backend.drain_deadline() {
        relay.set_deadline(dl);
        if let Some(e) = w.table.get_mut(conn_id) {
            e.state = ConnState::Draining;
            e.drain_deadline = Some(dl);
        }
    } else if let Some(dl) = w.global_drain_deadline {
        relay.set_deadline(dl);
        if let Some(e) = w.table.get_mut(conn_id) {
            e.state = ConnState::Draining;
            e.drain_deadline = Some(dl);
        }
    }

    backend.inc_active();
    w.stats.active_conns += 1;
    w.stats.total_opened += 1;
    w.opened_this_sec += 1;

    let tx = w.event_tx.clone();
    let tx2 = tx.clone();
    let bid = backend.id.clone();
    let cid = conn_id;
    let hist = w.stats.relay_hist_handle();
    let handle = tokio::task::spawn_local(async move {
        let outcome = relay
            .run(
                move |bin, bout| {
                    let _ = tx.send(RelayEvent::Bytes {
                        conn_id: cid,
                        bytes_in: bin,
                        bytes_out: bout,
                    });
                },
                &hist,
            )
            .await;
        let _ = tx2.send(RelayEvent::Finished {
            conn_id: cid,
            backend_id: bid,
            outcome,
        });
    });
    w.relays.insert(conn_id, (backend.id.clone(), handle));
}

fn handle_relay_event(w: &mut Worker, ev: RelayEvent) {
    match ev {
        RelayEvent::Bytes { conn_id, bytes_in, bytes_out } => {
            w.table.add_bytes(conn_id, bytes_in, bytes_out, Instant::now());
            w.stats.bytes_in += bytes_in;
            w.stats.bytes_out += bytes_out;
        }
        RelayEvent::Finished { conn_id, backend_id, outcome } => {
            if w.relays.remove(&conn_id).is_some() {
                finalize_conn_with(w, conn_id, &backend_id, outcome);
            }
        }
        RelayEvent::UdpFlow(r) => finish_udp_flow(w, r),
    }
}

fn finalize_conn(w: &mut Worker, conn_id: u64, outcome: RelayOutcome) {
    if let Some(entry) = w.table.remove(conn_id) {
        finalize_locked(w, &entry.backend_id, outcome);
    }
}

fn finalize_conn_with(w: &mut Worker, conn_id: u64, backend_id: &str, outcome: RelayOutcome) {
    if w.table.remove(conn_id).is_none() {
        // already removed (e.g. forced path); still balance the counters.
    }
    finalize_locked(w, backend_id, outcome);
}

fn finalize_locked(w: &mut Worker, backend_id: &str, outcome: RelayOutcome) {
    w.stats.active_conns = w.stats.active_conns.saturating_sub(1);
    w.stats.total_closed += 1;
    w.closed_this_sec += 1;
    if outcome == RelayOutcome::Forced {
        w.stats.forced_disconnects += 1;
    }
    if let Some(b) = w.registry.get(backend_id) {
        b.dec_active();
    }
}

// ============================== UDP =======================================

fn spawn_udp_flow(w: &mut Worker, dg: UdpDatagram) {
    let UdpDatagram { listener, data, peer } = dg;
    if w.drain_flag.load(Ordering::Acquire) {
        return;
    }
    let backend = match w.registry.select(w.rng.next_unit()) {
        Some(b) => b,
        None => {
            w.stats.rejected_no_backend += 1;
            return;
        }
    };
    let conn_id = w.table.insert(
        listener.clone(),
        Protocol::Udp,
        peer,
        backend.id.clone(),
        backend.addr,
        Instant::now(),
    );
    backend.inc_active();
    w.stats.active_conns += 1;
    w.stats.total_opened += 1;
    w.opened_this_sec += 1;

    let tx = w.event_tx.clone();
    let setup_hist = w.stats.tcp_setup_us.clone();
    let backend_id = backend.id.clone();
    let backend_addr = backend.addr;
    let bytes_in = data.len() as u64;
    let listener_name = listener;

    tokio::task::spawn_local(async move {
        let started = Instant::now();
        let send_result = async {
            let upstream = connect_udp(backend_addr).await?;
            setup_hist.observe(started.elapsed());
            upstream.send(&data).await?;
            let mut resp = vec![0u8; 65535];
            let n = tokio::time::timeout(Duration::from_secs(5), upstream.recv(&mut resp)).await??;
            resp.truncate(n);
            Ok::<Vec<u8>, io::Error>(resp)
        }
        .await;

        let result = match send_result {
            Ok(resp) => UdpFlowResult {
                listener: listener_name,
                peer,
                backend_id,
                reply: Some(resp),
                bytes_in,
                rtt: started.elapsed(),
                rejected: false,
            },
            Err(_) => UdpFlowResult {
                listener: listener_name,
                peer,
                backend_id,
                reply: None,
                bytes_in,
                rtt: started.elapsed(),
                rejected: true,
            },
        };
        let _ = tx.send(RelayEvent::UdpFlow(result));
    });

    w.table.remove(conn_id);
}

fn finish_udp_flow(w: &mut Worker, r: UdpFlowResult) {
    w.stats.active_conns = w.stats.active_conns.saturating_sub(1);
    w.stats.total_closed += 1;
    w.closed_this_sec += 1;
    if let Some(b) = w.registry.get(&r.backend_id) {
        b.dec_active();
    }
    if r.rejected {
        w.stats.rejected_no_backend += 1;
        return;
    }
    w.stats.bytes_in += r.bytes_in;
    if let Some(reply) = r.reply {
        let n = reply.len() as u64;
        if let Some(sock) = w.listeners.udp.get(&r.listener) {
            let sock = dup_udp(sock);
            let peer = r.peer;
            tokio::task::spawn_local(async move {
                let _ = sock.send_to(&reply, peer).await;
            });
            w.stats.bytes_out += n;
            w.stats.udp_rtt_us.observe(r.rtt.max(Duration::from_micros(1)));
        }
    }
}

// ============================== fd helpers ================================

fn dup_udp(s: &UdpSocket) -> UdpSocket {
    let dup = unsafe { dup_raw(s.as_raw_fd()) }.expect("dup udp fd");
    let owned = unsafe { OwnedFd::from_raw_fd(dup) };
    let std_sock = std::net::UdpSocket::from(owned);
    std_sock.set_nonblocking(true).unwrap();
    UdpSocket::from_std(std_sock).expect("std -> udp")
}

fn dup_tcp_listener(s: &TcpListener) -> TcpListener {
    let dup = unsafe { dup_raw(s.as_raw_fd()) }.expect("dup tcp listener fd");
    let owned = unsafe { OwnedFd::from_raw_fd(dup) };
    let std_sock = std::net::TcpListener::from(owned);
    std_sock.set_nonblocking(true).unwrap();
    TcpListener::from_std(std_sock).expect("std -> tcp listener")
}

extern "C" {
    fn dup(fd: std::os::fd::RawFd) -> std::os::fd::RawFd;
}
unsafe fn dup_raw(fd: std::os::fd::RawFd) -> std::io::Result<std::os::fd::RawFd> {
    let d = dup(fd);
    if d < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(d)
    }
}

#[cfg(unix)]
fn adopt_fds(
    worker_id: usize,
    listeners: &mut ListenerSet,
    cfgs: &[ListenerConfig],
    tcp_fds: Vec<std::os::fd::RawFd>,
    udp_fds: Vec<std::os::fd::RawFd>,
) {
    let mut ti = tcp_fds.into_iter();
    let mut ui = udp_fds.into_iter();
    for c in cfgs {
        match c.protocol {
            Protocol::Tcp => {
                if let Some(fd) = ti.next() {
                    match crate::upgrade::fd_to_tcp_listener(fd) {
                        Ok(l) => {
                            listeners.tcp.insert(c.name.clone(), l);
                            tracing::info!(worker = worker_id, listener = %c.name, "adopted TCP listener");
                        }
                        Err(e) => tracing::error!(worker = worker_id, error = %e, "adopt tcp failed"),
                    }
                }
            }
            Protocol::Udp => {
                if let Some(fd) = ui.next() {
                    match crate::upgrade::fd_to_udp_socket(fd) {
                        Ok(s) => {
                            listeners.udp.insert(c.name.clone(), s);
                            tracing::info!(worker = worker_id, listener = %c.name, "adopted UDP socket");
                        }
                        Err(e) => tracing::error!(worker = worker_id, error = %e, "adopt udp failed"),
                    }
                }
            }
        }
    }
}

// ============================== table/stats accessors =====================

impl ConnTable {
    pub fn conns_mut(&mut self) -> impl Iterator<Item = &mut crate::conntrack::ConnEntry> {
        self.conns.values_mut()
    }
    pub fn get_mut(&mut self, id: u64) -> Option<&mut crate::conntrack::ConnEntry> {
        self.conns.get_mut(&id)
    }
}

impl WorkerStats {
    pub fn relay_hist_handle(&self) -> Arc<crate::stats::Histogram> {
        self.relay_latency_arc.clone()
    }
}

// Keep Context import used for future manual poll extensions.
#[allow(dead_code)]
fn _cx_marker(_: &Context<'_>) {}

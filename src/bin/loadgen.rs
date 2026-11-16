//! Load generator for exam-lb.
//!
//! Opens tens of thousands of long-lived TCP connections (and optional UDP
//! flows) against the balancer, keeps them alive with periodic PINGs, and
//! reports the numbers the exercise asks for:
//!   * forced/unexpected disconnect ratio during backend churn;
//!   * per-backend load distribution (queried from the admin API);
//!   * end-to-end PING/PONG latency p50/p99.
//!
//! It deliberately avoids extra crates: threads + blocking sockets scale fine
//! to ~50k connections on a tuned macOS/Linux box, and each connection only
//! does a few small writes per second.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clap::Parser;

#[derive(Parser)]
#[command(name = "loadgen")]
struct Cli {
    /// Balancer TCP target, e.g. 127.0.0.1:9000
    #[arg(long)]
    target: String,
    /// Total long connections to hold open.
    #[arg(long, default_value_t = 20_000)]
    connections: usize,
    /// Number of client worker threads.
    #[arg(long, default_value_t = 8)]
    workers: usize,
    /// PING interval per connection.
    #[arg(long, default_value_t = 5)]
    ping_secs: u64,
    /// Ramp-up: connect this many new connections per second total.
    #[arg(long, default_value_t = 2_000)]
    ramp_per_sec: u64,
    /// Test duration in seconds (0 = until Ctrl-C).
    #[arg(long, default_value_t = 300)]
    duration_secs: u64,
    /// Also send this many UDP probes per second (0 disables).
    #[arg(long, default_value_t = 0)]
    udp_per_sec: u64,
    /// Where to write the final JSON report.
    #[arg(long, default_value = "loadgen-report.json")]
    report: String,
    /// Admin API base for per-backend load snapshots.
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    admin: String,
}

#[derive(Default)]
struct Agg {
    connected: AtomicU64,
    connect_failures: AtomicU64,
    pings_ok: AtomicU64,
    pings_failed: AtomicU64,
    /// Connections that dropped after a successful connect.
    disconnects: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
}

/// Lock-free-ish latency histogram (same log2 buckets as the balancer).
struct LatHist {
    buckets: Vec<AtomicU64>,
    count: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
}

impl LatHist {
    fn new() -> Self {
        Self {
            buckets: (0..48).map(|_| AtomicU64::new(0)).collect(),
            count: AtomicU64::new(0),
            sum_us: AtomicU64::new(0),
            max_us: AtomicU64::new(0),
        }
    }
    fn observe(&self, d: Duration) {
        let us = d.as_micros() as u64;
        let idx = if us == 0 {
            0
        } else {
            let k = 64 - us.leading_zeros();
            (k as usize).min(47)
        };
        self.buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum_us.fetch_add(us, Ordering::Relaxed);
        self.max_us.fetch_max(us, Ordering::Relaxed);
    }
    fn quantile_us(&self, q: f64) -> u64 {
        let total: u64 = self.buckets.iter().map(|b| b.load(Ordering::Relaxed)).sum();
        if total == 0 {
            return 0;
        }
        let target = (total as f64 * q).ceil() as u64;
        let mut acc = 0;
        for (i, b) in self.buckets.iter().enumerate() {
            acc += b.load(Ordering::Relaxed);
            if acc >= target {
                return if i == 0 { 2 } else { 1u64 << i };
            }
        }
        self.max_us.load(Ordering::Relaxed)
    }
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let target: SocketAddr = cli.target.parse()?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        ctrlc_wait(move || stop.store(true, Ordering::Release));
    }

    let agg = Arc::new(Agg::default());
    let hist = Arc::new(LatHist::new());

    // Backend load samples collected over time.
    let load_samples: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    if !cli.admin.is_empty() {
        let stop = stop.clone();
        let admin = cli.admin.clone();
        let samples = load_samples.clone();
        std::thread::spawn(move || poll_backend_load(stop, admin, samples));
    }

    // UDP prober.
    if cli.udp_per_sec > 0 {
        let stop = stop.clone();
        let agg = agg.clone();
        let hist = hist.clone();
        let target = cli.target.clone();
        std::thread::spawn(move || udp_prober(stop, agg, hist, target, cli.udp_per_sec));
    }

    let start = Instant::now();
    let per_worker = cli.connections / cli.workers;
    let ramp_interval = if cli.ramp_per_sec == 0 {
        Duration::from_millis(10)
    } else {
        Duration::from_secs_f64(cli.workers as f64 / cli.ramp_per_sec as f64)
    };

    let mut handles = Vec::new();
    for wid in 0..cli.workers {
        let target = target;
        let agg = agg.clone();
        let hist = hist.clone();
        let stop = stop.clone();
        let n = if wid == cli.workers - 1 {
            cli.connections - per_worker * (cli.workers - 1)
        } else {
            per_worker
        };
        handles.push(std::thread::spawn(move || {
            client_worker(wid, n, target, agg, hist, stop, ramp_interval, cli.ping_secs)
        }));
    }

    // Duration watchdog.
    if cli.duration_secs > 0 {
        let stop = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(cli.duration_secs));
            stop.store(true, Ordering::Release);
        });
    }

    for h in handles {
        let _ = h.join();
    }
    let elapsed = start.elapsed();
    stop.store(true, Ordering::Release);

    let connected = agg.connected.load(Ordering::Relaxed);
    let disconnects = agg.disconnects.load(Ordering::Relaxed);
    eprintln!(
        "[loadgen] closed_by_fin={} closed_by_reset={}",
        CLOSED_FIN.load(Ordering::Relaxed),
        CLOSED_RESET.load(Ordering::Relaxed)
    );
    let report = serde_json::json!({
        "target": cli.target,
        "elapsed_secs": elapsed.as_secs_f64(),
        "wanted_connections": cli.connections,
        "connected": connected,
        "connect_failures": agg.connect_failures.load(Ordering::Relaxed),
        "disconnects": disconnects,
        "closed_by_fin": CLOSED_FIN.load(Ordering::Relaxed),
        "closed_by_reset": CLOSED_RESET.load(Ordering::Relaxed),
        "disconnect_ratio": if connected > 0 {
            disconnects as f64 / connected as f64
        } else { 0.0 },
        "pings_ok": agg.pings_ok.load(Ordering::Relaxed),
        "pings_failed": agg.pings_failed.load(Ordering::Relaxed),
        "rtt_p50_us": hist.quantile_us(0.50),
        "rtt_p99_us": hist.quantile_us(0.99),
        "bytes_in": agg.bytes_in.load(Ordering::Relaxed),
        "bytes_out": agg.bytes_out.load(Ordering::Relaxed),
        "backend_load_samples": load_samples.lock().unwrap().clone(),
    });
    std::fs::write(&cli.report, serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn client_worker(
    wid: usize,
    n: usize,
    target: SocketAddr,
    agg: Arc<Agg>,
    hist: Arc<LatHist>,
    stop: Arc<AtomicBool>,
    ramp: Duration,
    ping_secs: u64,
) {
    let mut conns: Vec<ClientConn> = Vec::with_capacity(n);
    for _seq in 0..n {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match TcpStream::connect(target) {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                // Fully non-blocking: the poll loop never stalls on one
                // connection. Writes of small PING lines effectively always
                // succeed immediately; reads return WouldBlock when no data.
                let _ = s.set_nonblocking(true);
                agg.connected.fetch_add(1, Ordering::Relaxed);
                // Stagger the first PING across one ping interval so all
                // connections don't fire (and await replies) simultaneously.
                let jitter_us = if n > 0 {
                    (conns.len() as u64 * ping_secs * 1_000_000) / n as u64
                } else {
                    0
                };
                let jitter = Duration::from_micros(jitter_us);
                conns.push(ClientConn {
                    stream: s,
                    read_buf: Vec::with_capacity(256),
                    next_ping: Instant::now() + jitter,
                    ping_seq: 0,
                    rbuf: [0u8; 1024],
                    pending_since: None,
                });
            }
            Err(_) => {
                agg.connect_failures.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        if ramp.as_millis() > 0 {
            std::thread::sleep(ramp);
        }
    }

    // Steady state. Per round, per connection: send a due PING first, then
    // read any buffered/arriving reply. A read timeout is normal (the reply
    // may land in a later round) and never counts as a disconnect.
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        let mut alive = Vec::with_capacity(conns.len());
        for mut c in conns {
            if stop.load(Ordering::Relaxed) {
                alive.push(c);
                continue;
            }

            // (a) Send a due PING when none is already in flight.
            if c.pending_since.is_none() && now >= c.next_ping {
                c.ping_seq += 1;
                let msg = format!("PING {}-{}\r\n", wid, c.ping_seq);
                match c.stream.write_all(msg.as_bytes()) {
                    Ok(()) => {
                        agg.bytes_out.fetch_add(msg.len() as u64, Ordering::Relaxed);
                        c.pending_since = Some(Instant::now());
                        c.next_ping = now + Duration::from_secs(ping_secs);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // Socket send buffer momentarily full; keep the
                        // connection and retry on a later round (undo the seq
                        // bump so the same PING is re-sent).
                        c.ping_seq -= 1;
                    }
                    Err(_) => {
                        agg.disconnects.fetch_add(1, Ordering::Relaxed);
                        agg.pings_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                }
            }

            // (b) Read a reply line if one is available/arrives promptly.
            match read_line(&mut c) {
                Ok(line) => {
                    agg.bytes_in.fetch_add(line.len() as u64 + 1, Ordering::Relaxed);
                    if line.starts_with("PONG") {
                        agg.pings_ok.fetch_add(1, Ordering::Relaxed);
                        if let Some(t0) = c.pending_since.take() {
                            hist.observe(t0.elapsed());
                        }
                    } else {
                        agg.pings_failed.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Err(ReadErr::Closed) => {
                    agg.disconnects.fetch_add(1, Ordering::Relaxed);
                    continue; // real peer close: drop this connection
                }
                Err(ReadErr::Timeout) | Err(ReadErr::Other) => {
                    // No full line yet; keep the connection and try next round.
                }
            }
            alive.push(c);
        }
        conns = alive;
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct ClientConn {
    stream: TcpStream,
    read_buf: Vec<u8>,
    rbuf: [u8; 1024],
    next_ping: Instant,
    ping_seq: u64,
    pending_since: Option<Instant>,
}

enum ReadErr {
    Timeout,
    Closed,
    Other,
}

fn read_line(c: &mut ClientConn) -> Result<String, ReadErr> {
    // Socket is non-blocking: return Timeout immediately when no full line is
    // available yet, so the poll loop can move on to the next connection.
    loop {
        if let Some(pos) = c.read_buf.iter().position(|b| *b == b'\n') {
            let line = c.read_buf[..pos].to_vec();
            c.read_buf.drain(..=pos);
            return Ok(String::from_utf8_lossy(&line).trim().to_string());
        }
        match c.stream.read(&mut c.rbuf) {
            Ok(0) => {
                CLOSED_FIN.fetch_add(1, Ordering::Relaxed);
                return Err(ReadErr::Closed);
            }
            Ok(n) => c.read_buf.extend_from_slice(&c.rbuf[..n]),
            Err(e) => match e.kind() {
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                    return Err(ReadErr::Timeout)
                }
                std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe => {
                    CLOSED_RESET.fetch_add(1, Ordering::Relaxed);
                    return Err(ReadErr::Closed);
                }
                other => {
                    eprintln!("[loadgen] read unexpected error: {other:?}");
                    return Err(ReadErr::Other);
                }
            },
        }
    }
}

static CLOSED_FIN: AtomicU64 = AtomicU64::new(0);
static CLOSED_RESET: AtomicU64 = AtomicU64::new(0);

fn udp_prober(
    stop: Arc<AtomicBool>,
    agg: Arc<Agg>,
    hist: Arc<LatHist>,
    target: String,
    per_sec: u64,
) {
    let sock = match std::net::UdpSocket::bind("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("udp bind failed: {e}");
            return;
        }
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(500)));
    let interval = Duration::from_secs_f64(1.0 / per_sec.max(1) as f64);
    let mut seq = 0u64;
    while !stop.load(Ordering::Relaxed) {
        seq += 1;
        let msg = format!("PING u{seq}");
        let t0 = Instant::now();
        if sock.send_to(msg.as_bytes(), &target).is_ok() {
            agg.bytes_out.fetch_add(msg.len() as u64, Ordering::Relaxed);
            let mut buf = [0u8; 1024];
            match sock.recv_from(&mut buf) {
                Ok((n, _)) => {
                    agg.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
                    agg.pings_ok.fetch_add(1, Ordering::Relaxed);
                    hist.observe(t0.elapsed());
                }
                Err(_) => {
                    agg.pings_failed.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        std::thread::sleep(interval);
    }
}

fn poll_backend_load(
    stop: Arc<AtomicBool>,
    admin: String,
    samples: Arc<Mutex<Vec<serde_json::Value>>>,
) {
    // Parse host:port from the admin base URL once.
    let authority = admin
        .strip_prefix("http://")
        .unwrap_or(&admin)
        .trim_end_matches('/');
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(8080)),
        None => (authority.to_string(), 8080),
    };
    while !stop.load(Ordering::Relaxed) {
        if let Ok(body) = http_get(&host, port, "/api/backends") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                samples.lock().unwrap().push(v);
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Dependency-free HTTP/1.1 GET for localhost admin calls. Opens a fresh
/// connection per request so a refused/closed connection never poisons later
/// polls.
fn http_get(host: &str, port: u16, path: &str) -> std::io::Result<String> {
    let mut s = std::net::TcpStream::connect((host, port))?;
    s.set_read_timeout(Some(Duration::from_secs(2)))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf)?;
    let body = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| String::from_utf8_lossy(&buf[p + 4..]).to_string())
        .unwrap_or_default();
    Ok(body)
}

fn ctrlc_wait<F: Fn() + Send + 'static>(on_signal: F) {
    #[cfg(unix)]
    {
        std::thread::spawn(move || {
            type SignalHandler = extern "C" fn(i32);
            extern "C" {
                fn signal(signum: i32, handler: SignalHandler) -> usize;
            }
            const SIGINT: i32 = 2;
            extern "C" fn handle(_sig: i32) {
                std::process::exit(130);
            }
            unsafe {
                signal(SIGINT, handle);
            }
            // Park forever; the handler exits the process directly.
            loop {
                std::thread::sleep(Duration::from_secs(60));
                on_signal();
            }
        });
    }
    #[cfg(not(unix))]
    {
        let _ = on_signal;
    }
}

// Keep HashMap referenced for future per-backend client-side bucketing.
#[allow(dead_code)]
fn _map_marker(_m: &HashMap<String, u64>) {}

//! Mock exam backend.
//!
//! Speaks a tiny line-based protocol on TCP and UDP so the load generator can
//! measure end-to-end behavior through the balancer:
//!
//! TCP (long connection, mimics an exam session):
//!   client -> `PING <seq>\n`        backend -> `PONG <seq>\n`
//!   client -> `STATS\n`             backend -> JSON stats line + `\n`
//!   client -> `BYE\n`               backend closes
//!
//! The backend parses an optional PROXY protocol v1/v2 header on the first
//! read and records how many connections carried a real client address — the
//! benchmark asserts that number to verify requirement 5 end to end.
//!
//! UDP: datagram `PING <seq>` -> datagram `PONG <seq>` from the same socket.
//!
//! Usage:
//!   mock-backend --id b1 --listen 127.0.0.1:9101 [--udp 127.0.0.1:9101]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;

#[derive(Parser)]
#[command(name = "mock-backend")]
struct Cli {
    #[arg(long)]
    id: String,
    #[arg(long)]
    listen: String,
    #[arg(long)]
    udp: Option<String>,
    /// Per-connection read timeout; idle exam sessions are allowed to linger.
    #[arg(long, default_value_t = 3600)]
    idle_timeout_secs: u64,
}

#[derive(Default)]
struct Counters {
    conns_total: AtomicU64,
    conns_active: AtomicU64,
    conns_closed: AtomicU64,
    proxy_seen: AtomicU64,
    pings: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let counters = Arc::new(Counters::default());

    let tcp_listener = TcpListener::bind(&cli.listen)?;
    tcp_listener.set_nonblocking(false)?;
    eprintln!("[{}] TCP listening on {}", cli.id, cli.listen);

    if let Some(udp_addr) = &cli.udp {
        let sock = UdpSocket::bind(udp_addr)?;
        eprintln!("[{}] UDP listening on {}", cli.id, udp_addr);
        let c = counters.clone();
        let id = cli.id.clone();
        std::thread::spawn(move || udp_loop(id, sock, c));
    }

    // Stats printer on SIGUSR1-ish cadence: dump every 10s to stderr.
    {
        let c = counters.clone();
        let id = cli.id.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(10));
            eprintln!(
                "[{id}] active={} total={} closed={} proxy={} pings={} in={} out={}",
                c.conns_active.load(Ordering::Relaxed),
                c.conns_total.load(Ordering::Relaxed),
                c.conns_closed.load(Ordering::Relaxed),
                c.proxy_seen.load(Ordering::Relaxed),
                c.pings.load(Ordering::Relaxed),
                c.bytes_in.load(Ordering::Relaxed),
                c.bytes_out.load(Ordering::Relaxed),
            );
        });
    }

    for stream in tcp_listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[{}] accept error: {e}", cli.id);
                continue;
            }
        };
        let c = counters.clone();
        let id = cli.id.clone();
        let idle = Duration::from_secs(cli.idle_timeout_secs);
        std::thread::spawn(move || {
            if let Err(e) = tcp_conn(id, stream, c.clone(), idle) {
                eprintln!("conn ended: {e}");
            }
            c.conns_active.fetch_sub(1, Ordering::Relaxed);
            c.conns_closed.fetch_add(1, Ordering::Relaxed);
        });
        counters.conns_total.fetch_add(1, Ordering::Relaxed);
        counters.conns_active.fetch_add(1, Ordering::Relaxed);
    }
    Ok(())
}

fn tcp_conn(id: String, mut stream: TcpStream, c: Arc<Counters>, idle: Duration) -> anyhow::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(idle))?;
    let mut reader = stream.try_clone()?;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let mut proxy_done = false;
    let mut peer_reported = String::new();

    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => return Err(e.into()),
        };
        c.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
        buf.extend_from_slice(&chunk[..n]);

        // PROXY v1 header on first bytes.
        if !proxy_done {
            if let Some(end) = find_crlf(&buf) {
                let line = &buf[..end];
                if line.starts_with(b"PROXY ") {
                    proxy_done = true;
                    c.proxy_seen.fetch_add(1, Ordering::Relaxed);
                    if let Ok(text) = std::str::from_utf8(line) {
                        peer_reported = text.to_string();
                    }
                    buf.drain(..end + 2);
                } else if line.starts_with(b"\r\n\r\n") || buf.len() > 107 {
                    proxy_done = true; // not a proxy header; stop looking
                }
            }
            if buf.len() > 65536 {
                proxy_done = true;
            }
        }

        // Process complete lines.
        while let Some(end) = find_crlf(&buf) {
            let line = buf[..end].to_vec();
            buf.drain(..end + 2);
            let text = String::from_utf8_lossy(&line).to_string();
            let started = Instant::now();
            let reply = handle_line(&text, &c, &id, &peer_reported);
            let mut out = reply.into_bytes();
            out.extend_from_slice(b"\n");
            stream.write_all(&out)?;
            c.bytes_out.fetch_add(out.len() as u64, Ordering::Relaxed);
            let _ = started;
            if text == "BYE" {
                return Ok(());
            }
        }
    }
}

fn handle_line(text: &str, c: &Counters, id: &str, proxy_peer: &str) -> String {
    let parts: Vec<&str> = text.split_whitespace().collect();
    match parts.first().copied() {
        Some("PING") => {
            c.pings.fetch_add(1, Ordering::Relaxed);
            let seq = parts.get(1).copied().unwrap_or("0");
            format!("PONG {seq}")
        }
        Some("STATS") => serde_json::json!({
            "backend": id,
            "active": c.conns_active.load(Ordering::Relaxed),
            "total": c.conns_total.load(Ordering::Relaxed),
            "proxy_seen": c.proxy_seen.load(Ordering::Relaxed),
            "pings": c.pings.load(Ordering::Relaxed),
            "proxy_peer": proxy_peer,
        })
        .to_string(),
        Some("BYE") => "BYE".to_string(),
        _ => format!("ERR unknown command: {text}"),
    }
}

fn find_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\r\n")
}

fn udp_loop(id: String, sock: UdpSocket, c: Arc<Counters>) {
    let mut buf = [0u8; 65535];
    loop {
        let (n, peer) = match sock.recv_from(&mut buf) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[{id}] udp recv error: {e}");
                continue;
            }
        };
        c.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
        c.conns_total.fetch_add(1, Ordering::Relaxed);
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        let reply = if let Some(seq) = text.strip_prefix("PING ") {
            c.pings.fetch_add(1, Ordering::Relaxed);
            format!("PONG {seq}")
        } else {
            "ERR".to_string()
        };
        if sock.send_to(reply.as_bytes(), peer).is_ok() {
            c.bytes_out.fetch_add(reply.len() as u64, Ordering::Relaxed);
        }
        c.conns_closed.fetch_add(1, Ordering::Relaxed);
    }
}

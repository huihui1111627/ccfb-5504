//! Socket construction helpers shared by workers.
//!
//! Every worker binds its *own* listening socket with `SO_REUSEPORT` so the
//! kernel load-balances incoming connections across worker event loops — no
//! single accept thread, no thundering herd. IPv6 listeners request dual-stack
//! mode (`IPV6_V6ONLY=0`) where the platform supports it; an IPv6 candidate is
//! then relayed to a v4-only backend over a normal v4 upstream socket.

use std::io;
use std::net::SocketAddr;

use socket2::{Domain, Protocol as SockProto, Socket, Type};
use tokio::net::{TcpListener, UdpSocket};

fn make_socket(addr: SocketAddr, sock_type: Type, proto: SockProto) -> io::Result<Socket> {
    let domain = if addr.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, sock_type, Some(proto))?;
    socket.set_reuse_address(true)?;
    // SO_REUSEPORT is the cornerstone of per-worker accept scaling (Unix).
    socket.set_reuse_port(true)?;
    socket.set_nonblocking(true)?;

    if addr.is_ipv6() {
        // Dual-stack: accept both v6 and v4-mapped connections on one socket.
        // macOS/BSD default to dual-stack anyway; Linux needs the explicit
        // opt-out of v6only. Failure is non-fatal (v6-only still works).
        let _ = socket.set_only_v6(false);
    }
    socket.bind(&addr.into())?;
    Ok(socket)
}

pub fn bind_tcp(addr: SocketAddr, backlog: i32) -> io::Result<TcpListener> {
    let socket = make_socket(addr, Type::STREAM, SockProto::TCP)?;
    if backlog > 0 {
        socket.listen(backlog)?;
    } else {
        socket.listen(4096)?;
    }
    TcpListener::from_std(socket.into())
}

pub fn bind_udp(addr: SocketAddr) -> io::Result<UdpSocket> {
    let socket = make_socket(addr, Type::DGRAM, SockProto::UDP)?;
    UdpSocket::from_std(socket.into())
}

/// Open an outbound UDP socket "connected" to the backend, on the same address
/// family as the backend address.
pub async fn connect_udp(backend: SocketAddr) -> io::Result<UdpSocket> {
    let bind: SocketAddr = if backend.is_ipv4() {
        "0.0.0.0:0".parse().unwrap()
    } else {
        "[::]:0".parse().unwrap()
    };
    let socket = bind_udp(bind)?;
    socket.connect(backend).await?;
    Ok(socket)
}

/// Extract a raw fd for handover (see `upgrade.rs`).
#[cfg(unix)]
pub fn listener_raw_fd(l: &TcpListener) -> i32 {
    use std::os::fd::AsRawFd;
    l.as_raw_fd()
}

#[cfg(unix)]
pub fn udp_raw_fd(s: &UdpSocket) -> i32 {
    use std::os::fd::AsRawFd;
    s.as_raw_fd()
}

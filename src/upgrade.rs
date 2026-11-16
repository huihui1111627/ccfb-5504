//! Zero-downtime upgrade via listening-socket handover (requirement 4).
//!
//! Sequence:
//! 1. The new process connects to the old process's Unix control socket and
//!    sends `HELLO`.
//! 2. The old process asks every worker for its listener fds, then sends them
//!    back with `SCM_RIGHTS` ancillary data — the kernel duplicates each fd
//!    into the new process. One datagram per worker.
//! 3. Old workers close their copies and stop accepting; new workers adopt the
//!    inherited fds on the *same* kernel sockets. Clients in the accept queue
//!    and incoming SYNs never see a refusal.
//! 4. The old process keeps running until every established relay finishes,
//!    bounded by the drain deadline. The upgrade closes no established
//!    connection.
//!
//! Transport: a `SOCK_STREAM` Unix domain socket carrying length-prefixed
//! frames, each sent in a *single* `sendmsg` with its `SCM_RIGHTS` array in the
//! ancillary buffer. On Unix domain sockets the kernel delivers the ancillary
//! data together with the associated bytes, so one `recvmsg` returns both the
//! whole frame and its fds. SEQPACKET would be ideal but macOS AF_UNIX does not
//! support it, hence the framed-stream approach. All I/O is blocking on a
//! dedicated thread, so no async-runtime assumptions leak into the FFI layer.

#![cfg(unix)]

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::worker::{WorkerHandle, WorkerMessage};

const KIND_HELLO: u8 = 1;
const KIND_FDS: u8 = 2;
const KIND_ACK: u8 = 3;

/// Max frame payload + header; listener fd counts per worker are small.
const MAX_FRAME: usize = 64 * 1024;
/// Hard cap on fds in one SCM_RIGHTS message (a few listeners per worker).
const MAX_FDS: usize = 64;

// ===================== libc-backed SCM_RIGHTS framing =====================

fn last_err() -> std::io::Error {
    std::io::Error::last_os_error()
}

/// Mark an fd close-on-exec (best effort).
fn set_cloexec(fd: RawFd) -> std::io::Result<()> {
    let r = unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    if r < 0 {
        Err(last_err())
    } else {
        Ok(())
    }
}

fn sockaddr_for(path: &str) -> std::io::Result<libc::sockaddr_un> {
    let bytes = path.as_bytes();
    if bytes.len() >= 104 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "control socket path too long",
        ));
    }
    // SAFETY: sockaddr_un is all-zero initialized; sun_path is a byte array.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as _;
    // macOS types sun_path as [c_char; N]; copy via raw u8 view.
    let path_view = unsafe {
        std::slice::from_raw_parts_mut(addr.sun_path.as_mut_ptr() as *mut u8, addr.sun_path.len())
    };
    path_view[..bytes.len()].copy_from_slice(bytes);
    Ok(addr)
}

/// Create a blocking AF_UNIX STREAM socket with close-on-exec set.
fn make_socket() -> std::io::Result<RawFd> {
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(last_err());
    }
    if let Err(e) = set_cloexec(fd) {
        unsafe { libc::close(fd) };
        return Err(e);
    }
    Ok(fd)
}

fn stream_bind_listen(path: &str) -> std::io::Result<OwnedFd> {
    let _ = std::fs::remove_file(path);
    let fd = make_socket()?;
    let addr = sockaddr_for(path)?;
    let len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
    let rc = unsafe { libc::bind(fd, &addr as *const _ as *const _, len) };
    if rc < 0 || unsafe { libc::listen(fd, 8) } < 0 {
        let e = last_err();
        unsafe { libc::close(fd) };
        return Err(e);
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn stream_connect(path: &str) -> std::io::Result<OwnedFd> {
    let fd = make_socket()?;
    let addr = sockaddr_for(path)?;
    let len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
    if unsafe { libc::connect(fd, &addr as *const _ as *const _, len) } < 0 {
        let e = last_err();
        unsafe { libc::close(fd) };
        return Err(e);
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

// ------------------------------ frames ------------------------------------

struct Frame {
    kind: u8,
    payload: Vec<u8>,
    fds: Vec<RawFd>,
}

fn cmsg_buffer_len(fd_count: usize) -> usize {
    // Space needed for one SCM_RIGHTS cmsg holding fd_count descriptors.
    unsafe { libc::CMSG_SPACE((fd_count * std::mem::size_of::<RawFd>()) as u32) as usize }
}

/// Send a frame in one sendmsg, header+payload in a single iovec, fds in an
/// SCM_RIGHTS cmsg. The kernel keeps the ancillary data attached to these bytes.
fn send_frame(fd: RawFd, kind: u8, payload: &[u8], fds: &[RawFd]) -> std::io::Result<()> {
    if fds.len() > MAX_FDS || payload.len() + 9 > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "handover frame too large",
        ));
    }
    let mut data = Vec::with_capacity(9 + payload.len());
    data.push(kind);
    data.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    data.extend_from_slice(&(fds.len() as u32).to_be_bytes());
    data.extend_from_slice(payload);

    let mut iov = libc::iovec {
        iov_base: data.as_ptr() as *mut _,
        iov_len: data.len(),
    };

    let mut cbuf: Vec<u8> = vec![0u8; cmsg_buffer_len(fds.len())];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    if fds.is_empty() {
        msg.msg_control = std::ptr::null_mut();
        msg.msg_controllen = 0;
    } else {
        msg.msg_control = cbuf.as_mut_ptr() as *mut _;
        msg.msg_controllen = cbuf.len() as _;
        // Fill the cmsg header and copy the fd array into its data area.
        unsafe {
            let hdr = libc::CMSG_FIRSTHDR(&msg);
            if hdr.is_null() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "null cmsg header",
                ));
            }
            (*hdr).cmsg_level = libc::SOL_SOCKET;
            (*hdr).cmsg_type = libc::SCM_RIGHTS;
            (*hdr).cmsg_len = libc::CMSG_LEN(
                (fds.len() * std::mem::size_of::<RawFd>()) as u32,
            ) as _;
            let data_ptr = libc::CMSG_DATA(hdr) as *mut RawFd;
            std::ptr::copy_nonoverlapping(fds.as_ptr(), data_ptr, fds.len());
        }
    }

    let n = unsafe { libc::sendmsg(fd, &msg, 0) };
    if n < 0 {
        return Err(last_err());
    }
    if n as usize != data.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "short sendmsg on control socket",
        ));
    }
    Ok(())
}

fn read_exact(fd: RawFd, buf: &mut [u8]) -> std::io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = unsafe {
            libc::read(
                fd,
                buf.as_mut_ptr().add(filled) as *mut _,
                buf.len() - filled,
            )
        };
        match n {
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "control socket closed mid-frame",
                ))
            }
            n if n < 0 => {
                let e = last_err();
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            n => filled += n as usize,
        }
    }
    Ok(())
}

fn recv_frame(fd: RawFd) -> std::io::Result<Frame> {
    // A generous buffer lets the common frame arrive in one recvmsg together
    // with its ancillary fds.
    let mut data = vec![0u8; MAX_FRAME];
    let mut cbuf: Vec<u8> = vec![0u8; cmsg_buffer_len(MAX_FDS)];
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr() as *mut _,
        iov_len: data.len(),
    };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cbuf.as_mut_ptr() as *mut _;
    msg.msg_controllen = cbuf.len() as _;

    // MSG_CMSG_CLOEXEC is Linux-only; elsewhere we set CLOEXEC on each received
    // descriptor explicitly after parsing the ancillary array.
    #[cfg(target_os = "linux")]
    let recv_flags: i32 = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let recv_flags: i32 = 0;
    let n = unsafe { libc::recvmsg(fd, &mut msg, recv_flags) };
    if n < 0 {
        return Err(last_err());
    }
    let n0 = n as usize;
    if n0 < 9 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "short handover header",
        ));
    }
    let kind = data[0];
    let payload_len = u32::from_be_bytes(data[1..5].try_into().unwrap()) as usize;
    let fd_count = u32::from_be_bytes(data[5..9].try_into().unwrap()) as usize;
    let total = 9 + payload_len;
    if total > data.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "handover frame exceeds buffer",
        ));
    }
    // SOCK_STREAM may deliver the frame across multiple calls; read the rest.
    if n0 < total {
        read_exact(fd, &mut data[n0..total])?;
    }
    let payload = data[9..total].to_vec();

    // Walk the control messages and collect the SCM_RIGHTS descriptors.
    let mut fds = Vec::new();
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET
                && (*cmsg).cmsg_type == libc::SCM_RIGHTS
            {
                let data_ptr = libc::CMSG_DATA(cmsg) as *const RawFd;
                let got =
                    ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize)
                        / std::mem::size_of::<RawFd>();
                for i in 0..got {
                    let inherited = std::ptr::read_unaligned(data_ptr.add(i));
                    // Ensure close-on-exec regardless of platform recv flags.
                    let _ = set_cloexec(inherited);
                    fds.push(inherited);
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    if fds.len() != fd_count {
        let got = fds.len();
        for f in fds {
            unsafe { libc::close(f) };
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("expected {fd_count} fds, received {got}"),
        ));
    }
    Ok(Frame { kind, payload, fds })
}

// ============================== public API ================================

/// Bind the control socket. The Tokio-facing name is retained for main.rs.
pub async fn bind_control(path: &str) -> std::io::Result<ControlListener> {
    let fd = stream_bind_listen(path)?;
    Ok(ControlListener { fd })
}

pub struct ControlListener {
    fd: OwnedFd,
}

impl ControlListener {
    /// Accept one handover session (blocking, run via spawn_blocking).
    fn accept(&self) -> std::io::Result<OwnedFd> {
        let fd = unsafe {
            libc::accept(
                self.fd.as_raw_fd(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if fd < 0 {
            return Err(last_err());
        }
        // Set close-on-exec on the accepted session fd.
        if let Err(e) = set_cloexec(fd) {
            unsafe { libc::close(fd) };
            return Err(e);
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

/// New-process side: connect, pull every worker's listener fds, ACK, and
/// return one (tcp_fds, udp_fds) pair per worker.
pub async fn request_handover(
    control_path: &str,
    pid: u32,
    workers: usize,
) -> std::io::Result<Vec<(Vec<RawFd>, Vec<RawFd>)>> {
    let path = control_path.to_string();
    tokio::task::spawn_blocking(move || -> std::io::Result<Vec<(Vec<RawFd>, Vec<RawFd>)>> {
        // The old process may still be starting up and not have bound its
        // control socket yet; retry the connect for a bounded window.
        let sock = {
            let start = std::time::Instant::now();
            loop {
                match stream_connect(&path) {
                    Ok(s) => break s,
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::NotFound
                                | std::io::ErrorKind::ConnectionRefused,
                        ) && start.elapsed() < std::time::Duration::from_secs(10) =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(e) => return Err(e),
                }
            }
        };
        let fd = sock.as_raw_fd();
        send_frame(fd, KIND_HELLO, pid.to_string().as_bytes(), &[])?;

        let mut out = Vec::with_capacity(workers);
        for _ in 0..workers {
            let frame = recv_frame(fd)?;
            if frame.kind != KIND_FDS {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "expected FDS datagram",
                ));
            }
            let meta: serde_json::Value =
                serde_json::from_slice(&frame.payload).map_err(std::io::Error::from)?;
            let tcp_n = meta["tcp"].as_u64().unwrap_or(0) as usize;
            let udp_n = meta["udp"].as_u64().unwrap_or(0) as usize;
            if frame.fds.len() < tcp_n + udp_n {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "handover fd count mismatch",
                ));
            }
            let tcp = frame.fds[..tcp_n].to_vec();
            let udp = frame.fds[tcp_n..tcp_n + udp_n].to_vec();
            out.push((tcp, udp));
        }
        send_frame(fd, KIND_ACK, b"ok", &[])?;
        Ok(out)
    })
    .await
    .map_err(|e| std::io::Error::other(format!("handover join error: {e}")))?
}

/// Old-process side: accept one session and stream each worker's fds, then
/// drive the drain flag. Runs on the admin multi-thread runtime.
pub async fn serve_handover(
    listener: ControlListener,
    workers: Arc<Vec<WorkerHandle>>,
    drain_flag: crate::worker::DrainFlag,
    drain_deadline: Duration,
) -> std::io::Result<()> {
    let session = tokio::task::spawn_blocking(move || listener.accept())
        .await
        .map_err(|e| std::io::Error::other(format!("accept join: {e}")))??;
    let session_fd = session.as_raw_fd();

    let hello = tokio::task::spawn_blocking(move || recv_frame_blocking(session_fd))
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))??;
    if hello.kind != KIND_HELLO {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "expected HELLO",
        ));
    }
    tracing::info!(
        new_pid = %String::from_utf8_lossy(&hello.payload),
        "handover: new process connected"
    );

    for h in workers.iter() {
        let (ack_tx, mut ack_rx) = mpsc::channel::<crate::worker::HandoverFds>(1);
        h.tx
            .send(WorkerMessage::Handover { ack: ack_tx })
            .map_err(|_| std::io::Error::other("worker gone"))?;
        let fds = ack_rx
            .recv()
            .await
            .ok_or_else(|| std::io::Error::other("worker handover ack lost"))?;
        let payload = serde_json::to_vec(&serde_json::json!({
            "worker_id": fds.worker_id,
            "tcp": fds.tcp.len(),
            "udp": fds.udp.len(),
        }))
        .unwrap();
        let mut all = fds.tcp;
        all.extend(fds.udp);
        let fd_for_send = session_fd;
        let payload_send = payload.clone();
        tokio::task::spawn_blocking(move || send_frame(fd_for_send, KIND_FDS, &payload_send, &all))
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))??;
    }

    let ack_fd = session_fd;
    tokio::task::spawn_blocking(move || send_frame(ack_fd, KIND_ACK, b"ok", &[]))
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))??;
    tracing::info!("handover: new generation adopted listeners; old process draining");

    drain_flag.store(true, std::sync::atomic::Ordering::Release);
    let deadline = std::time::Instant::now() + drain_deadline;
    for h in workers.iter() {
        let (tx, mut rx) = mpsc::channel(1);
        if h
            .tx
            .send(WorkerMessage::Drain { deadline, ack: tx })
            .is_ok()
        {
            let _ = rx.recv().await;
        }
    }
    Ok(())
}

/// Blocking recv on an owned raw fd (the session outlives the closure).
fn recv_frame_blocking(fd: RawFd) -> std::io::Result<Frame> {
    recv_frame(fd)
}

// ============================== fd adoption ===============================

pub fn fd_to_tcp_listener(fd: RawFd) -> std::io::Result<tokio::net::TcpListener> {
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let std_listener = std::net::TcpListener::from(owned);
    std_listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(std_listener)
}

pub fn fd_to_udp_socket(fd: RawFd) -> std::io::Result<tokio::net::UdpSocket> {
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let std_sock = std::net::UdpSocket::from(owned);
    std_sock.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(std_sock)
}

//! PROXY protocol header encoding (v1 text and v2 binary).
//!
//! The balancer sits in front of exam backends that need the candidate's real
//! source address. We only ever *send* the header (on the upstream side), so
//! only encoders are needed.
//!
//! Spec: <https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt>

use std::net::SocketAddr;

use crate::config::ProxyMode;

/// Build the header bytes to prefix onto an upstream TCP stream.
pub fn encode(mode: ProxyMode, client: SocketAddr, backend: SocketAddr) -> Vec<u8> {
    match mode {
        ProxyMode::Off => Vec::new(),
        ProxyMode::V1 => encode_v1(client, backend),
        ProxyMode::V2 => encode_v2(client, backend),
    }
}

fn encode_v1(client: SocketAddr, backend: SocketAddr) -> Vec<u8> {
    let proto = if client.is_ipv4() { "TCP4" } else { "TCP6" };
    format!(
        "PROXY {proto} {src} {dst} {sport} {dport}\r\n",
        src = client.ip(),
        dst = backend.ip(),
        sport = client.port(),
        dport = backend.port()
    )
    .into_bytes()
}

const V2_SIG: [u8; 12] = [
    0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A,
];

fn encode_v2(client: SocketAddr, backend: SocketAddr) -> Vec<u8> {
    // version 2 (0x20) | command PROXY (0x01)
    let ver_cmd: u8 = 0x21;
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&V2_SIG);
    match (client, backend) {
        (SocketAddr::V4(c), SocketAddr::V4(b)) => {
            out.push(ver_cmd);
            out.push(0x11); // AF_INET + STREAM
            out.extend_from_slice(&12u16.to_be_bytes());
            out.extend_from_slice(&c.ip().octets());
            out.extend_from_slice(&b.ip().octets());
            out.extend_from_slice(&c.port().to_be_bytes());
            out.extend_from_slice(&b.port().to_be_bytes());
        }
        (SocketAddr::V6(c), SocketAddr::V6(b)) => {
            out.push(ver_cmd);
            out.push(0x21); // AF_INET6 + STREAM
            out.extend_from_slice(&36u16.to_be_bytes());
            out.extend_from_slice(&c.ip().octets());
            out.extend_from_slice(&b.ip().octets());
            out.extend_from_slice(&c.port().to_be_bytes());
            out.extend_from_slice(&b.port().to_be_bytes());
        }
        // Mixed families (the dual-stack-to-v4-backend case): PROXY v2 has no
        // mixed-family address block, so fall back to LOCAL with the real
        // address carried in a Type-Length-Value (PP2_TYPE_AUTHORITY-style
        // custom TLV 0xEA). Backends that only understand standard TLVs still
        // get a syntactically valid LOCAL header.
        (c, b) => {
            out.push(0x20); // LOCAL command
            out.push(if c.is_ipv4() { 0x11 } else { 0x21 });
            let payload = mixed_tlv(c, b);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            out.extend_from_slice(&payload);
        }
    }
    out
}

fn mixed_tlv(client: SocketAddr, backend: SocketAddr) -> Vec<u8> {
    // TLV type 0xEA (experimentally-used): UTF-8 "client=<a>;backend=<b>"
    let text = format!("client={client};backend={backend}");
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + 3);
    out.push(0xEA);
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Convenience used by mock backends: parse a v1 header (for verification).
pub fn parse_v1(buf: &[u8]) -> Option<(SocketAddr, usize)> {
    let end = buf.windows(2).position(|w| w == b"\r\n")? + 2;
    let line = std::str::from_utf8(&buf[..end]).ok()?;
    let parts: Vec<&str> = line.trim_end().split_whitespace().collect();
    if parts.len() != 6 || parts[0] != "PROXY" {
        return None;
    }
    let src: SocketAddr = format!("{}:{}", parts[2], parts[4]).parse().ok()?;
    Some((src, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_roundtrip_text() {
        let c: SocketAddr = "203.0.113.7:51000".parse().unwrap();
        let b: SocketAddr = "10.0.0.9:8080".parse().unwrap();
        let hdr = encode(ProxyMode::V1, c, b);
        let (src, n) = parse_v1(&hdr).unwrap();
        assert_eq!(src, c);
        assert_eq!(n, hdr.len());
    }

    #[test]
    fn v2_signature_and_length_v4() {
        let c: SocketAddr = "203.0.113.7:51000".parse().unwrap();
        let b: SocketAddr = "10.0.0.9:8080".parse().unwrap();
        let hdr = encode(ProxyMode::V2, c, b);
        assert_eq!(&hdr[..12], &V2_SIG);
        // byte 12 = ver/command, byte 13 = family/proto
        assert_eq!(hdr[12], 0x21);
        assert_eq!(hdr[13], 0x11);
        assert_eq!(u16::from_be_bytes([hdr[14], hdr[15]]), 12);
        // 12 signature + 3 header (ver/cmd, fam/proto, len u16 = 4 actually)
        // layout: sig(12) ver(1) fam(1) len(2) addr(12) = 28
        assert_eq!(hdr.len(), 28);
    }

    #[test]
    fn v2_mixed_family_uses_local_tlv() {
        let c: SocketAddr = "[2001:db8::1]:51000".parse().unwrap();
        let b: SocketAddr = "10.0.0.9:8080".parse().unwrap();
        let hdr = encode(ProxyMode::V2, c, b);
        assert_eq!(hdr[12], 0x20); // LOCAL
        // TLV payload begins after the 12-byte signature + 3-byte header.
        let payload = &hdr[16..];
        // TLV: type(1)=0xEA, len(2), then UTF-8 text.
        assert_eq!(payload[0], 0xEA);
        let tlv_len = u16::from_be_bytes([payload[1], payload[2]]) as usize;
        let text = std::str::from_utf8(&payload[3..3 + tlv_len]).unwrap();
        assert!(text.contains("client=[2001:db8::1]:51000"));
    }
}

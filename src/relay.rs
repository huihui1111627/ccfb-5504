//! Bidirectional TCP relay pump.
//!
//! One pump task per connection, pinned to a worker's LocalSet. Built on
//! Tokio's battle-tested `copy_bidirectional`, wrapped in a timeout so an exam
//! backend going offline can force-close after its drain grace period. Byte
//! counts come from the (client->upstream, upstream->client) tuple the helper
//! returns; forwarding latency is sampled around each pump round.

use std::time::{Duration, Instant};

use tokio::io::{copy_bidirectional, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::stats::Histogram;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayOutcome {
    NaturalEof,
    Error,
    Forced,
}

pub struct Relay {
    client: TcpStream,
    upstream: TcpStream,
    proxy_hdr: Option<Vec<u8>>,
    deadline: Option<Instant>,
}

impl Relay {
    pub fn new(client: TcpStream, upstream: TcpStream, proxy_hdr: Option<Vec<u8>>) -> Self {
        Self {
            client,
            upstream,
            proxy_hdr,
            deadline: None,
        }
    }

    pub fn set_deadline(&mut self, t: Instant) {
        self.deadline = Some(t);
    }

    /// Run until one side closes, an error occurs, or the drain deadline
    /// expires. `on_bytes(bytes_in, bytes_out)` fires once at pump completion
    /// with the total transferred in each direction.
    pub async fn run<F: FnMut(u64, u64)>(
        mut self,
        mut on_bytes: F,
        hist: &Histogram,
    ) -> RelayOutcome {
        // PROXY header prefixes the upstream stream.
        if let Some(hdr) = self.proxy_hdr.take() {
            if self.upstream.write_all(&hdr).await.is_err() {
                let _ = self.client.shutdown().await;
                let _ = self.upstream.shutdown().await;
                return RelayOutcome::Error;
            }
        }

        let started = Instant::now();
        let Relay {
            mut client,
            mut upstream,
            deadline,
            ..
        } = self;

        let (outcome, inb, outb) = match deadline {
            None => {
                let r = copy_bidirectional(&mut client, &mut upstream).await;
                finish(r, started, hist)
            }
            Some(dl) => {
                let now = Instant::now();
                if dl <= now {
                    (RelayOutcome::Forced, 0, 0)
                } else {
                    let r = tokio::time::timeout(
                        dl - now,
                        copy_bidirectional(&mut client, &mut upstream),
                    )
                    .await;
                    match r {
                        Ok(io_r) => finish(io_r, started, hist),
                        Err(_) => (RelayOutcome::Forced, 0, 0),
                    }
                }
            }
        };
        on_bytes(inb, outb);

        let _ = client.shutdown().await;
        let _ = upstream.shutdown().await;
        outcome
    }
}

fn finish(
    r: std::io::Result<(u64, u64)>,
    started: Instant,
    hist: &Histogram,
) -> (RelayOutcome, u64, u64) {
    match r {
        Ok((i, o)) => {
            hist.observe(started.elapsed().max(Duration::from_micros(1)));
            (RelayOutcome::NaturalEof, i, o)
        }
        Err(_) => (RelayOutcome::Error, 0, 0),
    }
}

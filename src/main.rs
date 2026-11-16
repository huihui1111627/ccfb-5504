//! exam-lb binary entry point.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use clap::{Parser, Subcommand};
use exam_lb::config::Config;
use exam_lb::worker::{spawn_worker, DrainFlag, WorkerHandle};

#[derive(Parser)]
#[command(name = "exam-lb", version, about = "Layer-4 TCP/UDP load balancer for exam traffic")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start the balancer.
    Run {
        /// Path to the TOML config.
        #[arg(short, long, default_value = "exam-lb.toml")]
        config: String,
        /// Inherit listeners from a running instance (zero-downtime upgrade).
        #[arg(long)]
        inherit: bool,
    },
    /// Tell a running instance to hand its listeners over to a new instance
    /// and drain (used by the upgrade script).
    Upgrade {
        #[arg(short, long, default_value = "exam-lb.toml")]
        config: String,
    },
    /// Gracefully drain and stop the running instance.
    Stop {
        #[arg(short, long, default_value = "exam-lb.toml")]
        config: String,
    },
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,exam_lb=debug".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Run { config, inherit } => run(config, inherit),
        Cmd::Upgrade { config } => upgrade_only(config),
        Cmd::Stop { config } => stop(config),
    }
}

fn run(config_path: String, inherit: bool) -> anyhow::Result<()> {
    let cfg = Config::load(&config_path)?;
    let nworkers = cfg.worker_count();
    tracing::info!(workers = nworkers, "starting exam-lb");

    // Multi-thread runtime for the admin/control plane; workers each create
    // their own current-thread runtime on dedicated OS threads.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("lb-admin")
        .build()?;

    rt.block_on(async move {
        let registry = exam_lb::backend::Registry::new(&cfg.backends, cfg.drain.clone());
        let drain_flag: DrainFlag = Arc::new(AtomicBool::new(false));

        // Optional: inherit listener fds from the previous generation. This
        // connects to the *existing* control socket before we rebind it.
        let inherited = if inherit {
            #[cfg(unix)]
            {
                Some(request_handover(&cfg.admin.control_socket, nworkers).await?)
            }
            #[cfg(not(unix))]
            {
                anyhow::bail!("zero-downtime upgrade is only supported on Unix");
            }
        } else {
            None
        };

        // Bind listeners only on a fresh start. When inheriting via handover,
        // build an empty set; workers adopt the previous generation's fds
        // instead of re-binding a port the old process still owns.
        let shared_listeners = if inherited.is_some() {
            exam_lb::worker::empty_shared_listeners(&cfg.listeners)
        } else {
            exam_lb::worker::bind_shared_listeners(&cfg.listeners)?
        };

        // Spawn one worker per core.
        let mut handles = Vec::with_capacity(nworkers);
        for id in 0..nworkers {
            let inh = inherited.as_ref().map(|all| {
                let (t, u) = &all[id];
                (t.clone(), u.clone())
            });
            let h = spawn_worker(
                id,
                registry.clone(),
                shared_listeners.clone(),
                cfg.prewarm.clone(),
                drain_flag.clone(),
                inh,
            )?;
            handles.push(h);
        }
        let handles = Arc::new(handles);

        // Control socket for future upgrades. When inheriting, the old process
        // still owns this path until its drain finishes; bind_control removes
        // the stale socket (now safe) and re-creates it for this generation.
        #[cfg(unix)]
        let control_listener =
            exam_lb::upgrade::bind_control(&cfg.admin.control_socket).await?;
        write_pid_file(&cfg.admin.pid_file)?;

        // Background control loops.
        let health = Arc::new(exam_lb::health::HealthChecker::new(
            registry.clone(),
            cfg.health.clone(),
        ));
        let _health_task = health.spawn();
        let _ramp_task = exam_lb::control::spawn_ramp_loop(
            registry.clone(),
            cfg.drain.recover_tick_secs,
        );
        let _prewarm_task = exam_lb::control::spawn_prewarm_nudger(
            handles.clone(),
            std::time::Duration::from_secs(cfg.prewarm.warmup_retry_secs.max(1)),
        );

        // Admin API.
        let admin_addr: std::net::SocketAddr = cfg
            .admin
            .listen
            .parse()
            .map_err(|e| anyhow::anyhow!("bad admin listen address: {e}"))?;
        let state = exam_lb::admin::AppState {
            registry: registry.clone(),
            workers: handles.clone(),
            config: Arc::new(cfg.clone()),
        };
        let admin_task = tokio::spawn(exam_lb::admin::serve(
            state,
            admin_addr,
            cfg.admin.static_dir.clone(),
        ));

        // Signal handling: SIGTERM/SIGINT -> graceful drain.
        install_signal_handler(drain_flag.clone());

        // Handover server: blocks until an upgrade happens, then drains.
        #[cfg(unix)]
        {
            let workers_for_ho = handles.clone();
            let flag_for_ho = drain_flag.clone();
            let deadline = std::time::Duration::from_secs(cfg.drain.deadline_secs);
            let ho_task = tokio::spawn(async move {
                if let Err(e) = exam_lb::upgrade::serve_handover(
                    control_listener,
                    workers_for_ho,
                    flag_for_ho,
                    deadline,
                )
                .await
                {
                    tracing::warn!(error = %e, "handover server ended");
                }
            });

            // Wait for either a drain signal or the handover to complete.
            wait_for_drain(drain_flag.clone()).await;
            tracing::warn!("drain signal received; stopping new connections");

            // Give workers their deadline, then exit.
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(cfg.drain.deadline_secs);
            drain_workers(&handles, deadline).await;
            ho_task.abort();
            let _ = admin_task.abort();
            cleanup_pid_and_socket(&cfg.admin.pid_file, &cfg.admin.control_socket);
            tracing::info!("exam-lb stopped cleanly");
        }
        #[cfg(not(unix))]
        {
            wait_for_drain(drain_flag.clone()).await;
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(cfg.drain.deadline_secs);
            drain_workers(&handles, deadline).await;
            let _ = admin_task.abort();
        }
        Ok::<(), anyhow::Error>(())
    })?;
    Ok(())
}

#[cfg(unix)]
async fn request_handover(
    path: &str,
    nworkers: usize,
) -> anyhow::Result<Vec<(Vec<std::os::fd::RawFd>, Vec<std::os::fd::RawFd>)>> {
    let pid = std::process::id();
    let frames = exam_lb::upgrade::request_handover(path, pid, nworkers)
        .await
        .map_err(|e| anyhow::anyhow!("handover request failed: {e}"))?;
    anyhow::ensure!(frames.len() == nworkers, "handover frame count mismatch");
    Ok(frames)
}

async fn drain_workers(handles: &[WorkerHandle], deadline: std::time::Instant) {
    for h in handles {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        if h
            .tx
            .send(exam_lb::worker::WorkerMessage::Drain {
                deadline,
                ack: tx,
            })
            .is_ok()
        {
            let _ = rx.recv().await;
        }
    }
    // Worker threads exit on their own once their relay set is empty. Give
    // them until the deadline plus a small grace, then return regardless.
    let wait = deadline.saturating_duration_since(std::time::Instant::now())
        + std::time::Duration::from_secs(2);
    let _ = tokio::time::sleep(wait).await;
    let _ = handles;
}

fn install_signal_handler(flag: DrainFlag) {
    #[cfg(unix)]
    {
        tokio::spawn(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            let mut int =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
            flag.store(true, Ordering::Release);
        });
    }
    #[cfg(not(unix))]
    {
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            flag.store(true, Ordering::Release);
        });
    }
}

async fn wait_for_drain(flag: DrainFlag) {
    while !flag.load(Ordering::Acquire) {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

fn write_pid_file(path: &str) -> anyhow::Result<()> {
    std::fs::write(path, std::process::id().to_string())?;
    Ok(())
}

#[cfg(unix)]
fn cleanup_pid_and_socket(pid: &str, sock: &str) {
    let _ = std::fs::remove_file(pid);
    let _ = std::fs::remove_file(sock);
}

fn upgrade_only(config_path: String) -> anyhow::Result<()> {
    // Convenience wrapper: start a new inheriting process of this same binary.
    let exe = std::env::current_exe()?;
    let mut child = std::process::Command::new(exe)
        .args(["run", "--config", &config_path, "--inherit"])
        .spawn()?;
    let status = child.wait()?;
    std::process::exit(status.code().unwrap_or(1));
}

fn stop(config_path: String) -> anyhow::Result<()> {
    let cfg = Config::load(&config_path)?;
    let pid = std::fs::read_to_string(&cfg.admin.pid_file)
        .map_err(|e| anyhow::anyhow!("no pid file (is exam-lb running?): {e}"))?
    .trim()
    .parse::<i32>()?;
    #[cfg(unix)]
    {
        unsafe {
            libc_signal(pid, 15 /* SIGTERM */);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    println!("SIGTERM sent to pid {pid}");
    Ok(())
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
#[cfg(unix)]
unsafe fn libc_signal(pid: i32, sig: i32) {
    kill(pid, sig);
}

# exam-lb — 在线考试场景的四层负载均衡器

一个用 Rust + Tokio 编写的 L4（TCP/UDP）负载均衡器，针对「开考一分钟几十万考生同时涌入」
的场景设计。核心目标：加减后端机器时**不断掉已建立的长连接**。

## 架构总览

```
                         ┌──────────────────────────────────────────┐
   考生连接 ───────────▶ │  共享 listener fd（SO_REUSEADDR，一次 bind）│
                         │  每个 worker dup 同一组 socket 竞争 accept  │
                         └──────────────────────────────────────────┘
            ┌──────────────┬──────────────┬──────────────┐
            ▼              ▼              ▼              ▼
       worker 0       worker 1       worker 2  ...   worker N
   (独立 current-thread runtime + LocalSet，每核一个事件循环)
            │              │              │
            ▼              ▼              ▼
   本地连接表/连接池/直方图/流量环（均为 worker 本地，无全局锁）
            └──────────────┴──────────────┴──────────────┘
                                    │  仅跨 worker 协调用
                                    ▼
                    ArcSwap 后端注册表（热路径只读，无锁）
                    原子 active 计数 / 原子备份分流比例
```

### 关键设计决策

1. **每核一个事件循环，数据面无全局锁。**
   每个 worker 是独立 OS 线程上的 current-thread Tokio runtime + LocalSet。
   连接表、预热连接池、延迟直方图、每秒流量环都是 worker 本地数据。
   热路径上跨 worker 的协调只有：`arc-swap` 无锁读后端快照、后端上的原子
   active 计数、原子的备份组分流比例。管理面要全局数据时通过 mpsc 向各 worker
   发消息并**并行**收集（单 worker 慢不会拖垮整个请求）。

2. **共享 listener fd 而非每 worker 独立 bind。**
   所有 worker 通过 `dup` 共享同一组已 bind 的 socket，在内核层面竞争 accept。
   这样在 macOS 和 Linux 上都能把连接均匀分到各 worker（macOS 的 `SO_REUSEPORT`
   不会像 Linux 那样在独立 socket 间做负载均衡，会把连接全钉在一个 socket 上）。

3. **长连接预热池。**
   考前按报名人数预热：每个 worker 提前向后端建好空闲连接。开考时新连接优先命中
   warm socket，省掉现场三次握手。预热目标按后端容量加权、再除以 worker 数，
   保证全集群 warm 连接总数约等于报名人数。reconcile 在锁外做异步建连，
   不会阻塞管理查询。

4. **主备分组 + 慢恢复。**
   主组可用容量低于阈值（默认 35%）才启用备组；备组承担的新连接比例瞬间拉满，
   主组恢复后按固定步长（默认每 tick 降 20%）缓慢切回，避免抖动。

5. **优雅排空（drain）。**
   后端下线先进入 `draining`：新连接不再选它，已建立连接继续跑，直到超过宽限
   时限才强断。强断计数单独统计，用于计算「被迫断开连接比例」。

6. **零停机升级（SCM_RIGHTS fd 交接）。**
   新进程连接旧进程的 Unix 控制 socket（`SOCK_STREAM` + 单 sendmsg 携带
   `SCM_RIGHTS` 辅助数据），旧进程把每个 worker 的 listener fd 复制给新进程后
   停止 accept 并进入 drain；新进程在**同一内核 socket** 上接管。accept 队列里的
   连接和后续 SYN 不会被拒绝，已建立的 relay 留在旧进程跑到结束。

## 目录结构

| 文件 | 职责 |
|------|------|
| `src/main.rs` | CLI、进程编排、信号处理、升级流程 |
| `src/config.rs` | TOML 配置与校验 |
| `src/worker.rs` | 每核事件循环、accept、TCP/UDP 分发、连接表、fd 交接 |
| `src/backend.rs` | 后端状态机、arc-swap 注册表、加权最少连接、主备 ramp、预热计划 |
| `src/pool.rs` | 每 worker 预热连接池（锁外异步建连） |
| `src/relay.rs` | 双向 TCP 转发（tokio copy_bidirectional + drain 超时） |
| `src/proxyproto.rs` | PROXY protocol v1/v2，含 IPv6→IPv4 混合族 TLV |
| `src/socket.rs` | SO_REUSEPORT/双栈 socket 构造、UDP 外连 |
| `src/health.rs` | 主动 TCP 健康检查（连续失败/恢复阈值） |
| `src/conntrack.rs` | 每 worker 连接表（来源/后端/字节数/存活时间/drain） |
| `src/stats.rs` | 无锁直方图、每秒流量环、全局合并（不加全局锁） |
| `src/control.rs` | 主备 ramp 循环、预热 nudge |
| `src/admin.rs` | hyper HTTP API + 内嵌管理页面 |
| `src/upgrade.rs` | SCM_RIGHTS 零停机 fd 交接（libc，跨平台布局正确） |
| `src/ui/` | 单文件 HTML/CSS/JS 管理控制台（无外部 CDN 依赖） |
| `src/bin/mock_backend.rs` | 模拟考试后端（TCP 长连接 + UDP） |
| `src/bin/loadgen.rs` | 万级长连接压测客户端 |

## 快速开始

```bash
cargo build --release

# 1. 端到端冒烟（3 后端 + LB + TCP/UDP + 预热 + 排空 + 管理 API）
./scripts/smoke.sh

# 2. 压测（N 后端、M 长连接、中途动态增减后端）
./scripts/bench.sh 12 2000 60
#    参数：后端数  长连接数  持续秒数
```

### 手动运行

```bash
# 起模拟后端
./target/debug/mock-backend --id p1 --listen 127.0.0.1:9101 --udp 127.0.0.1:9101 &

# 起 LB
./target/debug/exam-lb run --config examples/exam-lb.toml

# 零停机升级（新进程继承旧进程的 listener fd）
./target/debug/exam-lb run --config examples/exam-lb.toml --inherit
```

## 管理 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 存活探针 |
| GET | `/api/config` | 当前配置 |
| GET | `/api/listeners` | 监听器列表 |
| GET/POST | `/api/backends` | 查看 / 新增后端 |
| DELETE | `/api/backends/{id}` | 删除后端 |
| POST | `/api/backends/{id}/drain` | 优雅排空 `{"deadline_secs":10}` |
| POST | `/api/backends/{id}/undrain` | 恢复 |
| POST | `/api/backends/{id}/weight` | 调权重 |
| POST | `/api/backends/{id}/prewarm` | 单后端预热 |
| POST | `/api/prewarm` | 按报名人数整体预热 `{"expected_clients":200000}` |
| GET | `/api/pools` | 各 worker warm 连接数 |
| GET | `/api/connections` | 连接表（支持 backend_id/listener/q 过滤分页） |
| GET | `/api/stats` | 全局统计（强断比例、p50/p99 延迟、流量曲线） |

浏览器打开 `http://127.0.0.1:8080/` 即管理控制台，含五个标签页：
监听器、后端池、连接表、健康检查、流量曲线。

## 压测关注的三个指标

`loadgen` 结束输出 JSON 报告，`bench.sh` 汇总：

1. **被迫断开连接比例** `disconnect_ratio` —— 无后端 churn 时应为 0；
   drain 后端时只影响该后端承载的连接。
2. **后端负载均匀度** —— 取最后一次采样的 active 连接分布，算变异系数 CV
   （越小越均匀）。
3. **转发延迟 p99** —— `rtt_p99_us`（端到端）与 LB 侧 `relay_p99_us`，
   基于对数分桶直方图。

## 平台说明

- 开发与测试在 macOS（aarch64）完成，生产目标为 Linux。
- macOS 的 `kern.ipc.somaxconn` 默认 128，突发建连超过该值会被内核丢弃；
  这是本机测试约束，Linux 可调 `net.core.somaxconn` 到数万。压测脚本因此用
  受控 ramp 速率并先做预热。
- macOS AF_UNIX 不支持 `SOCK_SEQPACKET`，fd 交接采用 `SOCK_STREAM` + 单
  `sendmsg` 携带 SCM_RIGHTS 的方式，msghdr/cmsghdr 布局用 `libc` crate 保证
  跨平台正确。
- IPv6 双栈监听（`IPV6_V6ONLY=0`）：IPv6 客户端可被转到只有 IPv4 地址的后端，
  PROXY v2 混合族用 LOCAL 命令 + 自定义 TLV 携带真实地址。

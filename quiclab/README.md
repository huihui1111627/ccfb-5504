# quiclab — 面向高时延/丢包卫星链路的 QUIC 传输库与离散事件仿真

给潜水俱乐部船岸通信场景实现的传输层:按 **RFC 9000 / RFC 9002** 做丢包恢复与
拥塞控制,配一个确定性的离散事件链路仿真器,以及一个零依赖的可视化页面。

链路假设(贴合卫星上网):单向时延 700–800ms、明显抖动、随机丢包与成串丢包。

---

## 目录结构

```
quiclab/
├── quiclab/                  # 传输库(纯 Python,无第三方依赖)
│   ├── constants.py          # RFC 9002 附录 A.1/A.7 常量
│   ├── rangeset.py           # ACK 区间集合 + RFC 9000 §19.3 编解码
│   ├── rtt.py                # min/smoothed/rttvar + ACK delay 截断(附录 A.8)
│   ├── congestion.py         # NewReno、CUBIC(RFC 8312)、持续拥塞(附录 A.6)
│   ├── pacer.py              # 发送节拍 RFC 9002 §7.7
│   ├── recovery.py           # 每空间丢包判定 + PTO(附录 A.2/A.5/A.7)
│   ├── frames.py             # 帧与线上数据包数据结构
│   ├── connection.py         # 连接实体:三空间整合状态机
│   └── sim/
│       ├── rng.py            # 带种子的确定性随机子流
│       ├── link.py           # 时延/抖动/随机丢包/有界成串丢包
│       ├── engine.py         # 离散事件堆引擎
│       ├── scenario.py       # 34 个带种子场景
│       ├── trace.py          # trace 收集与 JSON 导出
│       ├── runner.py         # 批量运行 + 可复现校验
│       └── fault_injection.py# 需求 8 幽灵 ACK 故障注入
├── web/                      # 可视化页面(原生 JS + Canvas,无构建步骤)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── server.py             # 零依赖 HTTP 服务 + JSON API
├── tests/
│   ├── rfc9002_oracle.py     # RFC 9002 附录伪代码独立重写(对照基准)
│   ├── test_loss_oracle.py   # 判丢时机与 oracle 逐步对照
│   ├── test_rtt.py           # 需求 2
│   ├── test_ack_ranges.py    # 需求 4
│   ├── test_congestion.py    # 需求 5
│   ├── test_pacer.py         # 需求 6
│   ├── test_spaces_pto.py    # 需求 3、7
│   ├── test_protocol_violation.py # 需求 8
│   ├── test_end_to_end.py    # 几十组场景恰好一次 + 可复现
│   └── run_all.py            # 统一测试入口
└── run_scenarios.py          # 命令行入口
```

---

## 八项需求的实现位置

| # | 需求 | 实现 |
|---|------|------|
| 1 | 包号阈值 + 时间阈值双判丢,时间线分开标注 | `recovery.py: detect_lost_packets`,原因常量 `LOSS_PACKET_THRESHOLD/LOSS_TIME_THRESHOLD`;前端 `app.js` 红/橙两色 |
| 2 | RTT 维护 min/smoothed/rttvar,ACK delay 按对端上限截断再扣 | `rtt.py: update/pto_duration`,截断在 `clamp_ack_delay`,握手空间忽略 delay |
| 3 | PTO 先发探测包不判丢、指数退避、新 ACK 清零 | `connection.py: _on_pto/_send_probe`,退避计数清零在 `_handle_ack` |
| 4 | ACK 区间表示,最多 32 个,超了丢最旧 | `rangeset.py: encode_ack_ranges`,常量 `MAX_ACK_RANGES` |
| 5 | NewReno→CUBIC,运行时可切换,持续拥塞降到最小窗 | `congestion.py`,切换 `CongestionControl.switch_to`,持续拥塞 `is_persistent_congestion` |
| 6 | 按节拍均匀发送,不一次打满窗口 | `pacer.py`,速率 `cwnd×1.25/RTT` |
| 7 | Initial/Handshake/AppData 三空间独立编号判丢 | `connection.py` 持三个 `SpaceRecovery`;`test_spaces_pto.py` |
| 8 | 确认从未发送的包号立即关闭并记原因 | `connection.py: _handle_ack` 检查 `sent_pns`;`fault_injection.py` 演示 |

---

## 快速开始

需要 Python 3.10+(标准库即可,无第三方依赖)。建议用隔离模式运行:

```bash
# 1. 跑全部 34 个场景,生成 traces/*.json
python3 -I run_scenarios.py run --out traces

# 2. 同场景同种子跑两遍,逐字节比对可复现性
python3 -I run_scenarios.py repro

# 3. 启动可视化页面
python3 -I run_scenarios.py web --port 8000 --traces traces
# 浏览器打开 http://127.0.0.1:8000/
```

## 运行测试

```bash
python3 -I tests/run_all.py
```

覆盖:RTT、ACK 区间、拥塞控制、节拍、三空间/PTO、RFC 9002 伪代码 oracle 对照、
协议违例关闭,以及 34 个场景的端到端“恰好一次”与可复现校验。

---

## 可视化页面的五个区块

1. **连接列表** — 所有场景,带通过/违例标记、种子、事件数、仿真时长。
2. **包号时间线** — client/server 双泳道;发送/接收/确认/两种丢包/PTO 探测分色,
   可按端点和包号空间过滤,鼠标悬停看详情。
3. **拥塞窗口曲线** — cwnd(包数)阶梯线、ssthresh 虚线、持续拥塞红竖线、
   算法切换菱形标记。
4. **往返时间估计** — latest / smoothed / min / rttvar 四条曲线。
5. **丢包 / PTO 事件表** — 每个丢包的时间、空间、包号、触发原因,以及 PTO 退避。

---

## 关键设计说明

### 确定性
所有随机量来自带种子的 `random.Random`,并按“主种子 + CRC32(通道名)”派生
抖动/随机丢包/成串丢包三条独立子流。事件堆以 `(time, 全局自增 seq)` 排序,
同一时刻事件顺序也完全确定。同场景同种子两次运行的 trace JSON 用
`sorted_keys` 序列化后逐字节相同(见 `repro` 命令)。

### 判丢与 RFC 9002 附录对照
`tests/rfc9002_oracle.py` 是一份**不引用生产代码**的附录 A 伪代码独立重写。
`test_loss_oracle.py` 把相同事件脚本同时喂给 oracle 与生产实现,断言每个包的
判丢时刻、原因(包号/时间阈值)、`loss_time`、持续拥塞结论完全一致。

### 活性保护(恶劣链路)
- PTO 退避指数封顶在 `PTO_MAX_EXPONENT=7`,封顶后靠新探测包推进锚点,
  deadline 仍单调前进,不会退避到仿真时长之外。
- PTO 探测不受拥塞窗口限制(RFC 9002 §6.2.4 精神)。
- 握手未确认期间 ACK 包附加 PING 成为可确认包,避免 ACK-only 丢失导致握手死锁。
- Initial 空间在握手确认后彻底丢弃,旧重传帧不会再发往已死空间。

### 恰好一次
接收端用连续偏移 + 洞表重组;重复/重叠的重传片段在 `_handle_stream` 去重,
引擎结果里逐字节统计每个偏移被交付的次数,断言全部恰为 1。

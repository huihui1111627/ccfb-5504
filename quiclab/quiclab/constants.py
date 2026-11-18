"""全局常量,数值与 RFC 9002 附录 A 的常量保持一致。

时间单位统一为毫秒(ms),使用 float;字节单位为 int。
"""

from __future__ import annotations

# --- RFC 9002 Appendix A.1: Loss Detection Constants ---
PACKET_THRESHOLD = 3          # kPacketThreshold
TIME_THRESHOLD_NUM = 9.0      # kTimeThreshold = 9/8
TIME_THRESHOLD_DEN = 8.0
GRANULARITY = 1.0             # kGranularity,单位 ms
INITIAL_RTT = 333.0           # kInitialRtt,单位 ms
PTO_EXPONENT = 2              # kPtoFactor
PTO_MAX_COUNT = 2             # kMaxPtoCount(规范允许的退避上限参考值)
# 退避指数封顶:2^7 倍 PTO 后不再继续翻倍,保持该间隔持续探测以维持活性
PTO_MAX_EXPONENT = 7
PERSISTENT_CONGESTION_THRESHOLD = 3  # kPersistentCongestionThreshold
MIN_RTT_WINDOW = 5.0 * 60.0 * 1000.0   # kMinRttWindowLength = 5 分钟
MAX_ACK_DELAY = 25.0          # kMaxAckDelay,单位 ms(默认对端声明值)
ACK_DELAY_EXPONENT = 3        # RFC 9000 §18.2 传输参数默认指数

# --- RFC 9002 Appendix A.7: Congestion Control Constants ---
MINIMUM_WINDOW = 2.0 * 1460.0   # kMinimumWindow
MAX_DATAGRAM_SIZE = 1200.0      # kInitialMaxDatagramSize(本仿真单包固定大小)
LOSS_REDUCTION_FACTOR = 0.5     # kLossReductionFactor
PERSISTENT_CONGESTION_FACTOR = 0.7  # kPersistentCongestionFactor(NewReno 用)

# RFC 8312 CUBIC
CUBIC_C = 0.4
CUBIC_BETA = 0.7

# RFC 9002 §7.7 pacing:kPacingFactor = 1.25
PACING_FACTOR = 1.25

# 一个 ACK 帧最多携带的区间数(“几十个”,取 32;超出时丢弃最旧区间)
MAX_ACK_RANGES = 32

# 收到多少个可确认包后立刻回 ACK(规范建议每 2 个)
ACK_EVERY_PACKETS = 2

# 包号空间(RFC 9000 §12.1)
SPACE_INITIAL = 0
SPACE_HANDSHAKE = 1
SPACE_APPDATA = 2
SPACE_NAMES = ("initial", "handshake", "appdata")

# 丢包触发原因(时间线上分开标注)
LOSS_PACKET_THRESHOLD = "packet_threshold"
LOSS_TIME_THRESHOLD = "time_threshold"

# PTO 探测包标记
PROBE_PTO = "pto"

# 定时器比较的浮点容差(ms):消除“恰好到期却差 1e-13 不触发”的边界死循环
TIME_EPS = 1e-9

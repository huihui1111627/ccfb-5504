"""场景定义与场景库。

每个场景固定一个种子,链路参数、应用流量大小、拥塞控制切换计划都可配置。
场景库覆盖:无丢包基线、随机丢包、成串丢包、高时延高抖动、握手丢包、
PTO 退避、持续拥塞、ACK 区间截断、协议违例、CC 运行时切换等。
"""

from __future__ import annotations

from dataclasses import dataclass

from .link import LinkConfig


@dataclass(frozen=True)
class Scenario:
    name: str
    seed: int
    link_client_to_server: LinkConfig
    link_server_to_client: LinkConfig
    app_bytes: int = 1200 * 40
    initial_cc: str = "newreno"
    # 运行时切换拥塞控制算法:[(time_ms, "cubic"|"newreno"), ...]
    cc_schedule: tuple = ()
    max_sim_time: float = 120_000.0
    max_ack_delay: float = 25.0
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "seed": self.seed,
            "link_client_to_server": self.link_client_to_server.__dict__,
            "link_server_to_client": self.link_server_to_client.__dict__,
            "app_bytes": self.app_bytes,
            "initial_cc": self.initial_cc,
            "cc_schedule": list(self.cc_schedule),
            "max_sim_time": self.max_sim_time,
            "max_ack_delay": self.max_ack_delay,
            "description": self.description,
        }


def _symmetric(c2s: LinkConfig, s2c: LinkConfig | None = None) -> tuple:
    return c2s, (s2s if (s2s := s2c) is not None else c2s)


# ----------------------------------------------------------------------
# 场景库
# ----------------------------------------------------------------------
def build_scenarios() -> list[Scenario]:
    scenarios: list[Scenario] = []

    def add(name, seed, c2s, s2c=None, **kw):
        link_c2s, link_s2c = _symmetric(c2s, s2c)
        scenarios.append(
            Scenario(name=name, seed=seed,
                     link_client_to_server=link_c2s,
                     link_server_to_client=link_s2c, **kw)
        )

    # 1) 无丢包基线,不同种子(验证基本传输与恰好一次)
    for idx, seed in enumerate((1, 2, 3, 4, 5)):
        add(
            f"baseline_clean_{idx}",
            seed,
            LinkConfig(base_delay_ms=400, jitter_ms=20),
            description="无丢包基线,验证握手/数据流/优雅关闭",
        )

    # 2) 低/中/高随机丢包(700-800ms 时延贴近船上卫星链路)
    for idx, p in enumerate((0.02, 0.05, 0.10, 0.15, 0.20, 0.25)):
        add(
            f"random_loss_{int(p*100):02d}pct",
            100 + idx,
            LinkConfig(base_delay_ms=750, jitter_ms=50, random_loss=p),
            description=f"双向独立随机丢包 {p:.0%}",
        )

    # 3) 成串丢包:不同进入概率与串长
    burst_params = [
        (0.05, 2, 4),
        (0.08, 3, 6),
        (0.08, 4, 7),
        (0.10, 5, 8),
        (0.06, 2, 3),
    ]
    burst_timeouts = [120_000.0, 120_000.0, 180_000.0, 240_000.0, 120_000.0]
    for idx, (p_enter, lo, hi) in enumerate(burst_params):
        add(
            f"burst_loss_{idx}",
            200 + idx,
            LinkConfig(
                base_delay_ms=600,
                jitter_ms=50,
                burst_loss=True,
                burst_p_enter=p_enter,
                min_burst=lo,
                max_burst=hi,
            ),
            max_sim_time=burst_timeouts[idx],
            description=f"成串丢包 进入概率{p_enter} 串长[{lo},{hi}]",
        )

    # 4) 随机 + 成串混合(最恶劣的链路)
    for idx, (p_rand, p_enter) in enumerate(((0.05, 0.05), (0.08, 0.08), (0.10, 0.10))):
        add(
            f"mixed_loss_{idx}",
            300 + idx,
            LinkConfig(
                base_delay_ms=760,
                jitter_ms=70,
                random_loss=p_rand,
                burst_loss=True,
                burst_p_enter=p_enter,
                min_burst=3,
                max_burst=8,
            ),
            description=f"随机{p_rand}+成串{p_enter}混合丢包",
        )

    # 5) 非对称链路:上行差、下行好(ACK 路径相对干净)与反向
    add(
        "asymmetric_bad_uplink",
        401,
        LinkConfig(base_delay_ms=720, jitter_ms=40, random_loss=0.12,
                   burst_loss=True, burst_p_enter=0.08, min_burst=2, max_burst=5),
        LinkConfig(base_delay_ms=700, jitter_ms=20, random_loss=0.01),
        description="上行(数据)差、下行(ACK)好",
    )
    add(
        "asymmetric_bad_downlink",
        402,
        LinkConfig(base_delay_ms=700, jitter_ms=20, random_loss=0.01),
        LinkConfig(base_delay_ms=720, jitter_ms=40, random_loss=0.12,
                   burst_loss=True, burst_p_enter=0.08, min_burst=2, max_burst=5),
        description="上行好、下行(ACK)差,逼出 PTO",
    )

    # 6) 握手阶段丢包:Initial/Handshake 所在的前几个包高概率丢失
    add(
        "handshake_heavy_loss",
        501,
        LinkConfig(base_delay_ms=600, jitter_ms=30, random_loss=0.3),
        description="30% 丢包,握手包需要多次 PTO 才能完成",
    )

    # 7) 极端高抖动
    add(
        "high_jitter",
        601,
        LinkConfig(base_delay_ms=800, jitter_ms=250, random_loss=0.03),
        description="抖动 ±250ms,考验时间阈值与 RTT 估计",
    )

    # 8) 持续拥塞场景:偶发但足够长的丢串,使整窗包的发送时间都早于
    #    persistent congestion period 边界,触发窗口降到最小值后靠好区间恢复
    add(
        "persistent_congestion",
        701,
        LinkConfig(
            base_delay_ms=350,
            jitter_ms=20,
            burst_loss=True,
            burst_p_enter=0.04,
            min_burst=8,
            max_burst=12,
        ),
        app_bytes=1200 * 20,
        max_sim_time=120_000.0,
        description="偶发长丢串触发持续拥塞,窗口降到最小值后恢复",
    )
    # 8b) 极端压力:高随机丢包叠加成串丢包,考验 PTO 退避封顶后的活性
    add(
        "extreme_pressure",
        702,
        LinkConfig(
            base_delay_ms=400,
            jitter_ms=30,
            random_loss=0.10,
            burst_loss=True,
            burst_p_enter=0.06,
            min_burst=5,
            max_burst=9,
        ),
        app_bytes=1200 * 15,
        max_sim_time=180_000.0,
        description="随机+成串高丢包,验证退避封顶后仍能最终送达",
    )

    # 9) CUBIC 场景与运行时切换
    add(
        "cubic_random",
        801,
        LinkConfig(base_delay_ms=750, jitter_ms=40, random_loss=0.08),
        initial_cc="cubic",
        description="全程 CUBIC",
    )
    add(
        "cc_switch_newreno_to_cubic",
        802,
        LinkConfig(base_delay_ms=500, jitter_ms=30, random_loss=0.03,
                   burst_loss=True, burst_p_enter=0.03, min_burst=2, max_burst=5),
        initial_cc="newreno",
        cc_schedule=((8000.0, "cubic"), (20000.0, "newreno")),
        max_sim_time=120_000.0,
        description="运行时 NewReno->CUBIC->NewReno 切换",
    )

    # 10) 大流量(更多包,覆盖窗口增长与多轮恢复)
    add(
        "large_transfer",
        901,
        LinkConfig(base_delay_ms=700, jitter_ms=40, random_loss=0.06,
                   burst_loss=True, burst_p_enter=0.04, min_burst=2, max_burst=6),
        app_bytes=1200 * 120,
        description="120 个包的大传输",
    )

    # 11) 小流量(单包/几包,覆盖最小窗口边界)
    add(
        "tiny_transfer",
        1001,
        LinkConfig(base_delay_ms=500, jitter_ms=20, random_loss=0.1),
        app_bytes=1200 * 3,
        description="仅 3 个应用包",
    )

    # 12) 同参数不同种子,用于可复现性交叉验证
    for seed in (2001, 2002, 2003):
        add(
            f"repro_seed_{seed}",
            seed,
            LinkConfig(
                base_delay_ms=730,
                jitter_ms=45,
                random_loss=0.07,
                burst_loss=True,
                burst_p_enter=0.06,
                min_burst=2,
                max_burst=6,
            ),
            app_bytes=1200 * 30,
            description="同参数换种子,配合确定性测试",
        )

    # 13) 低时延无丢包(验证窗口增长与节拍)
    add(
        "low_latency_clean",
        3001,
        LinkConfig(base_delay_ms=50, jitter_ms=5),
        LinkConfig(base_delay_ms=50, jitter_ms=5),
        app_bytes=1200 * 60,
        description="低时延干净链路,观察拥塞窗口爬升",
    )

    return scenarios


# 协议违例场景不走正常 build_scenarios(它期望传输失败),由测试直接构造
def violation_scenario() -> Scenario:
    return Scenario(
        name="protocol_violation_phantom_ack",
        seed=9999,
        link_client_to_server=LinkConfig(base_delay_ms=400, jitter_ms=10),
        link_server_to_client=LinkConfig(base_delay_ms=400, jitter_ms=10),
        app_bytes=1200 * 5,
        description="对端确认从未发送过的包号,连接必须立即关闭",
    )

"""链路模型:时延、抖动、独立随机丢包、Gilbert-Elliott 成串丢包。

链路是单向的(``Link``),一个连接由两条方向相反的链路组成,各自持有
独立的随机数子流,因此双向丢包互不耦合但整体仍可由种子完全复现。

参数
----
base_delay_ms:     基础单向时延
jitter_ms:         均匀分布抖动 U(-jitter, +jitter),叠加在基础时延上
random_loss:       每包独立丢包概率(伯努利)
burst_loss:        成串丢包开关
burst_p_enter:     正常态 -> 丢包态的概率(坏状态进入概率)
burst_p_exit:      丢包态 -> 正常态的概率(坏状态持续期望长度 1/p_exit)
min_burst / max_burst: 进入丢包态后本次成串丢包的长度上下界(均匀取整)
"""

from __future__ import annotations

from dataclasses import dataclass

from .rng import LinkRng


@dataclass
class LinkConfig:
    base_delay_ms: float = 400.0
    jitter_ms: float = 0.0
    random_loss: float = 0.0
    burst_loss: bool = False
    burst_p_enter: float = 0.0
    burst_p_exit: float = 0.2
    min_burst: int = 2
    max_burst: int = 6

    def validate(self) -> None:
        if self.base_delay_ms < 0:
            raise ValueError("base_delay_ms 不能为负")
        if self.jitter_ms < 0 or self.jitter_ms > self.base_delay_ms:
            raise ValueError("jitter_ms 需满足 0 <= jitter <= base_delay")
        for name in ("random_loss", "burst_p_enter", "burst_p_exit"):
            p = getattr(self, name)
            if not 0.0 <= p <= 1.0:
                raise ValueError(f"{name} 必须在 [0,1] 区间")
        if self.min_burst < 1 or self.max_burst < self.min_burst:
            raise ValueError("burst 长度上下界非法")


class Link:
    """单向链路。"""

    GOOD = "good"
    BAD = "bad"

    def __init__(self, config: LinkConfig, rng: LinkRng) -> None:
        config.validate()
        self.cfg = config
        self.rng = rng
        self.state = self.GOOD
        self.burst_remaining = 0
        # 统计
        self.offered = 0
        self.dropped_random = 0
        self.dropped_burst = 0
        self.delivered = 0

    def one_way_delay(self) -> float:
        jitter = 0.0
        if self.cfg.jitter_ms > 0:
            jitter = self.rng.jitter.uniform(
                -self.cfg.jitter_ms, self.cfg.jitter_ms
            )
        return max(0.0, self.cfg.base_delay_ms + jitter)

    def should_drop(self) -> tuple[bool, str | None]:
        """返回 (是否丢弃, 丢弃原因)。

        成串丢包用两态马尔可夫 + 固定串长:
        - GOOD 态:每包以 burst_p_enter 概率进入 BAD 态,进入时抽取本次
          坏串长度 U[min_burst, max_burst];
        - BAD 态:连续丢弃恰好 burst_remaining 个包后无条件回到 GOOD 态。
        这样坏串长度有确定上界,不会无限滞留 BAD 态。
        """
        self.offered += 1

        # 1) 独立随机丢包
        if self.cfg.random_loss > 0 and self.rng.random_loss.random() < self.cfg.random_loss:
            self.dropped_random += 1
            return True, "random"

        # 2) 成串丢包(Gilbert-Elliott 两态,坏串长度有界)
        if self.cfg.burst_loss:
            if self.state == self.GOOD:
                if self.rng.burst.random() < self.cfg.burst_p_enter:
                    self.state = self.BAD
                    self.burst_remaining = self.rng.burst.randint(
                        self.cfg.min_burst, self.cfg.max_burst
                    )
            if self.state == self.BAD:
                self.burst_remaining -= 1
                self.dropped_burst += 1
                if self.burst_remaining <= 0:
                    # 坏串结束,无条件恢复 GOOD,保证好区间必然出现
                    self.state = self.GOOD
                    self.burst_remaining = 0
                return True, "burst"

        return False, None

    def stats(self) -> dict:
        return {
            "offered": self.offered,
            "delivered": self.delivered,
            "dropped_random": self.dropped_random,
            "dropped_burst": self.dropped_burst,
            "loss_rate": (
                (self.dropped_random + self.dropped_burst) / self.offered
                if self.offered
                else 0.0
            ),
        }

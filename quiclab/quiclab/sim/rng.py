"""确定性随机源:所有随机量统一从带种子的 ``random.Random`` 派生。

同一场景同一参数跑两遍结果完全相同(需求:可复现)。为避免不同方向、不同
用途的随机数互相耦合导致顺序敏感,这里按“主种子 + 通道编号”派生子流。
"""

from __future__ import annotations

import random
import zlib


class RngStream:
    """一条独立的随机数子流,内部就是固定种子的 random.Random。"""

    def __init__(self, seed: int, channel: str) -> None:
        self.seed = seed
        self.channel = channel
        # 用 CRC32 做确定性派生(不依赖受 PYTHONHASHSEED 影响的内置 hash)
        channel_tag = zlib.crc32(channel.encode("utf-8")) & 0xFFFFFFFFFFFFFFFF
        derived = random.Random(seed).getrandbits(64) ^ channel_tag
        self._r = random.Random(derived)

    def uniform(self, a: float, b: float) -> float:
        return self._r.uniform(a, b)

    def random(self) -> float:
        return self._r.random()

    def randint(self, a: int, b: int) -> int:
        return self._r.randint(a, b)

    def getrandbits(self, k: int) -> int:
        return self._r.getrandbits(k)


class LinkRng:
    """一条单向链路用到的全部随机数:抖动、随机丢包、成串丢包状态机。"""

    def __init__(self, seed: int, direction: str) -> None:
        self.jitter = RngStream(seed, f"{direction}:jitter")
        self.random_loss = RngStream(seed, f"{direction}:random_loss")
        self.burst = RngStream(seed, f"{direction}:burst")

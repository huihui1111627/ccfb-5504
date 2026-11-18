"""需求 7:三个包号空间独立编号、独立判丢。
需求 3:PTO 先发探测包不判丢、连续超时指数退避、新 ACK 清零退避。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quiclab.constants import (
    SPACE_APPDATA,
    SPACE_HANDSHAKE,
    SPACE_INITIAL,
)
from quiclab.recovery import SentPacket, SpaceRecovery
from quiclab.rtt import RttEstimator


def mk(space, pn, t, ae=True):
    return SentPacket(
        packet_number=pn, space=space, time_sent=t, size=1200,
        ack_eliciting=ae, in_flight=ae, is_handshake=(space != SPACE_APPDATA),
    )


def test_three_spaces_independent_numbering():
    spaces = {
        SPACE_INITIAL: SpaceRecovery(SPACE_INITIAL),
        SPACE_HANDSHAKE: SpaceRecovery(SPACE_HANDSHAKE),
        SPACE_APPDATA: SpaceRecovery(SPACE_APPDATA),
    }
    # 每个空间都从 0 开始独立编号
    for _ in range(3):
        for sp in spaces.values():
            sp.register_sent(mk(sp.space, sp.next_packet_number(), 0.0))
    for sp in spaces.values():
        assert sorted(sp.sent_packets) == [0, 1, 2]
    print("OK 三个空间各自从 0 独立编号")


def test_three_spaces_independent_loss():
    initial = SpaceRecovery(SPACE_INITIAL)
    appdata = SpaceRecovery(SPACE_APPDATA)
    rtt = RttEstimator()
    rtt.update(50.0, 0.0, 50.0, False)
    for sp in (initial, appdata):
        for pn in range(8):
            sp.register_sent(mk(sp.space, pn, 100.0))
    # 只在 AppData 空间 ACK pn7
    lost_app = appdata.process_ack([7], 1000.0, rtt)[1]
    # Initial 空间没有任何 ACK,不应有丢包
    lost_initial = initial.detect_lost_packets(1000.0, rtt)
    assert len(lost_app) > 0
    assert lost_initial == []
    assert initial.largest_acked is None
    assert appdata.largest_acked == 7
    print(f"OK AppData 判丢 {len(lost_app)} 个, Initial 空间完全不受影响")


def test_pto_exponential_backoff():
    rtt = RttEstimator()
    rtt.update(100.0, 0.0, 100.0, False)
    sp = SpaceRecovery(SPACE_APPDATA)
    sp.register_sent(mk(SPACE_APPDATA, 0, 1000.0))
    d0 = sp.pto_deadline(1000.0, pto_count=0, rtt_estimator=rtt)
    d1 = sp.pto_deadline(1000.0, pto_count=1, rtt_estimator=rtt)
    d2 = sp.pto_deadline(1000.0, pto_count=2, rtt_estimator=rtt)
    # 退避倍数 2^count
    assert abs((d1 - 1000.0) / (d0 - 1000.0) - 2.0) < 1e-9
    assert abs((d2 - 1000.0) / (d0 - 1000.0) - 4.0) < 1e-9
    print("OK PTO 连续超时按 2^count 指数退避")


def test_handshake_space_pto_excludes_ack_delay():
    rtt = RttEstimator(max_ack_delay=25.0)
    rtt.update(100.0, 0.0, 100.0, False)
    hs = SpaceRecovery(SPACE_HANDSHAKE)
    app = SpaceRecovery(SPACE_APPDATA)
    hs.register_sent(mk(SPACE_HANDSHAKE, 0, 1000.0))
    app.register_sent(mk(SPACE_APPDATA, 0, 1000.0))
    d_hs = hs.pto_deadline(1000.0, 0, rtt)
    d_app = app.pto_deadline(1000.0, 0, rtt)
    # AppData 的 PTO 比握手多一个 max_ack_delay
    assert abs((d_app - d_hs) - 25.0) < 1e-9
    print("OK 握手空间 PTO 不含 max_ack_delay, AppData 含")


def test_no_pto_without_ack_eliciting():
    sp = SpaceRecovery(SPACE_APPDATA)
    rtt = RttEstimator()
    # 只有 ACK-only(不可确认)包 -> 无 PTO
    sp.register_sent(mk(SPACE_APPDATA, 0, 1000.0, ae=False))
    assert sp.pto_deadline(1000.0, 0, rtt) is None
    # 加入一个可确认包后才有 PTO
    sp.register_sent(mk(SPACE_APPDATA, 1, 1001.0, ae=True))
    assert sp.pto_deadline(1000.0, 0, rtt) is not None
    print("OK 无在途可确认包时不设 PTO")


if __name__ == "__main__":
    test_three_spaces_independent_numbering()
    test_three_spaces_independent_loss()
    test_pto_exponential_backoff()
    test_handshake_space_pto_excludes_ack_delay()
    test_no_pto_without_ack_eliciting()
    print("\n所有需求 3/7 空间与 PTO 测试通过")

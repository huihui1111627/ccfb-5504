"""判丢时机与 RFC 9002 附录伪代码 oracle 逐步对照。

构造确定性的“发送 -> ACK -> 时间推进”脚本,同时喂给:
- 生产实现 quiclab.recovery.SpaceRecovery + RttEstimator
- 独立 oracle tests.rfc9002_oracle.OracleSpace + OracleRtt
断言每个包的判丢时刻、触发原因、持续拥塞结论完全一致。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from quiclab.recovery import SpaceRecovery, SentPacket
from quiclab.rtt import RttEstimator
from rfc9002_oracle import OraclePacket, OracleRtt, OracleSpace


def make_prod():
    sp = SpaceRecovery(space=2)  # AppData,非握手
    rtt = RttEstimator()
    return sp, rtt


def make_oracle():
    return OracleSpace(), OracleRtt()


def prod_send(sp, pn, t):
    pkt = SentPacket(
        packet_number=pn, space=2, time_sent=t, size=1200,
        ack_eliciting=True, in_flight=True,
    )
    sp.register_sent(pkt)


def sync_rtt(prod_rtt, oracle_rtt, latest, now):
    prod_rtt.update(latest, ack_delay_ms=0.0, now=now,
                    is_handshake_space=False)
    oracle_rtt.update(latest, now)


def test_packet_threshold_matches_oracle():
    """包号阈值:largest_acked - pn > 3 判丢,逐步对照。"""
    psp, prtt = make_prod()
    osp, ortt = make_oracle()
    # 发送 pn 0..6
    for pn in range(7):
        prod_send(psp, pn, float(pn))
        osp.on_sent(OraclePacket(pn, float(pn)))
    # 建立一个 RTT 样本(确认 pn0),避免落在 INITIAL_RTT 分支
    sync_rtt(prtt, ortt, latest=100.0, now=101.0)
    # ACK pn0(在 t=101),此时无丢包
    p_lost = psp.process_ack([0], 101.0, prtt)[1]
    o_lost = osp.on_ack([0], 101.0, ortt)
    assert [(p.packet_number, p.loss_cause) for p in p_lost] == o_lost == []
    # ACK pn6:largest_acked=6。pn0 已确认;pn1/pn2 满足 6-pn>3 走包号阈值;
    # pn3 因 6-3=3 不满足严格 >3,与 pn4/pn5 一起走时间阈值(此时时间也超了)
    p_lost = psp.process_ack([6], 200.0, prtt)[1]
    o_lost = osp.on_ack([6], 200.0, ortt)
    p_pairs = sorted((p.packet_number, p.loss_cause) for p in p_lost)
    assert p_pairs == sorted(o_lost)
    o_map = dict(o_lost)
    assert o_map.get(1) == "packet_threshold"
    assert o_map.get(2) == "packet_threshold"
    # pn3: 6-3=3 不满足 >3,不能走包号阈值
    assert o_map.get(3) == "time_threshold"
    print("OK 包号阈值判丢与 oracle 逐步一致:", o_lost)


def test_time_threshold_matches_oracle():
    """时间阈值:now - time_sent > 9/8 * latest_rtt 判丢。"""
    psp, prtt = make_prod()
    osp, ortt = make_oracle()
    for pn in range(4):
        prod_send(psp, pn, 1000.0 + pn)
        osp.on_sent(OraclePacket(pn, 1000.0 + pn))
    # RTT 样本 80ms
    sync_rtt(prtt, ortt, latest=80.0, now=1080.0)
    psp.process_ack([0], 1080.0, prtt)
    osp.on_ack([0], 1080.0, ortt)
    # 时间阈值 = 80 * 9/8 = 90ms。在 t=1095 触发 loss timer:
    # pn1 发送于 1001,age=94 > 90 -> 时间阈值判丢
    p_lost = psp.detect_lost_packets(1095.0, prtt)
    o_lost = osp.detect_on_timer(1095.0, ortt)
    p_pairs = sorted((p.packet_number, p.loss_cause) for p in p_lost)
    assert p_pairs == sorted(o_lost)
    assert all(cause == "time_threshold" for _, cause in o_lost)
    print("OK 时间阈值判丢与 oracle 逐步一致:", o_lost)


def test_threshold_precedence():
    """同一轮两个条件都满足时,规范伪代码先判包号阈值。"""
    psp, prtt = make_prod()
    osp, ortt = make_oracle()
    for pn in range(8):
        prod_send(psp, pn, 100.0)
        osp.on_sent(OraclePacket(pn, 100.0))
    sync_rtt(prtt, ortt, latest=50.0, now=1000.0)
    # 极晚的 ACK pn7:pn0..3 包号差距满足 >3,走包号阈值;pn4..6 差距不够,
    # 但时间远超阈值,走时间阈值
    p_lost = psp.process_ack([7], 1000.0, prtt)[1]
    o_lost = osp.on_ack([7], 1000.0, ortt)
    p_map = {p.packet_number: p.loss_cause for p in p_lost}
    o_map = dict(o_lost)
    assert p_map == o_map
    # 双重满足的包必须标 packet_threshold(伪代码先检查的分支)
    for pn in (0, 1, 2, 3):
        assert p_map[pn] == "packet_threshold"
    for pn in (4, 5, 6):
        assert p_map[pn] == "time_threshold"
    print("OK 双条件同时满足时统一标 packet_threshold,与伪代码顺序一致")


def test_persistent_congestion_matches_oracle():
    """持续拥塞:对照附录 A.6 的 3*PTO 边界判定。"""
    psp, prtt = make_prod()
    osp, ortt = make_oracle()
    base = 1000.0
    for pn in range(5):
        prod_send(psp, pn, base + pn)
        osp.on_sent(OraclePacket(pn, base + pn))
    sync_rtt(prtt, ortt, latest=100.0, now=base + 100)
    # 让这些包都先被判丢(走包号阈值)
    psp.process_ack([9], base + 500, prtt)
    osp.on_ack([9], base + 500, ortt)
    lost_pns = [pn for pn, p in psp.sent_packets.items() if p.lost]
    # oracle 持续拥塞判定
    o_pc = osp.persistent_congestion(lost_pns, base + 500, ortt)
    # 生产实现持续拥塞判定
    from quiclab.congestion import is_persistent_congestion
    lost_objs = [psp.sent_packets[pn] for pn in lost_pns]
    p_pc = is_persistent_congestion(lost_objs, base + 500, prtt)
    assert o_pc == p_pc
    print(f"OK 持续拥塞判定与 oracle 一致 (结论={p_pc})")

    # 时间拉得足够远 -> 必然持续拥塞
    far_now = base + 10000.0
    o_pc2 = osp.persistent_congestion(lost_pns, far_now, ortt)
    p_pc2 = is_persistent_congestion(lost_objs, far_now, prtt)
    assert o_pc2 is True and p_pc2 is True
    print("OK 远超 3*PTO 边界时双方都判持续拥塞")


def test_no_false_loss_before_threshold():
    """阈值未到不得判丢(防止 epsilon 放宽导致提前判丢)。"""
    psp, prtt = make_prod()
    osp, ortt = make_oracle()
    for pn in range(5):
        prod_send(psp, pn, 1000.0)
        osp.on_sent(OraclePacket(pn, 1000.0))
    sync_rtt(prtt, ortt, latest=80.0, now=1080.0)
    psp.process_ack([0], 1080.0, prtt)
    osp.on_ack([0], 1080.0, ortt)
    # t=1089:age=89 < 90 时间阈值;pn 差距也不够 -> 无丢包
    p_lost = psp.detect_lost_packets(1089.0, prtt)
    o_lost = osp.detect_on_timer(1089.0, ortt)
    assert [(p.packet_number, p.loss_cause) for p in p_lost] == o_lost == []
    # loss_time 应当被设置为到期点,两侧都有
    assert psp.loss_time is not None and osp.loss_time is not None
    assert abs(psp.loss_time - osp.loss_time) < 1e-9
    print("OK 阈值未到不判丢,且两侧 loss_time 一致:", round(psp.loss_time, 3))


if __name__ == "__main__":
    test_packet_threshold_matches_oracle()
    test_time_threshold_matches_oracle()
    test_threshold_precedence()
    test_persistent_congestion_matches_oracle()
    test_no_false_loss_before_threshold()
    print("\n所有 RFC 9002 附录伪代码 oracle 对照测试通过")

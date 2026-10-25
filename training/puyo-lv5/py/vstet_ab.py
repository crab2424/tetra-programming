"""異種戦（ぷよ lv6 対 テト lv5）の A/B：持論の構造（設計 lv6-vstet-design.md §10）を1つずつ足して 600 局。

    python3 py/vstet_ab.py base k1 k2            # 名前は VARIANTS を参照
    python3 py/vstet_ab.py --list

同じシード（1..600・同時刻はぷよ先）で打つので、基準との差は対応のある比較（勝ち負けが入れ替わった局の数）で見る。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import tetsim  # noqa: E402
from vstet_baseline import wilson  # noqa: E402


def mk(build=None, fast=None, **ext):
    """build/fast：{添字: 値}。ext：puyosim.EXT の名前。"""
    def f(pol):
        for k, v in (build or {}).items():
            pol.build[k] = v
        for k, v in (fast or {}).items():
            pol.fast[k] = v
        return pol.with_ext(**ext) if ext else pol
    return f


# 重みの添字（core/weights.h）
QSUB, SUB_MC, SUB_MP, SUB_FILL, KEEP_W, KEEP_D, KEEP_R = 45, 51, 52, 53, 54, 55, 56
TEAR_W, TEAR_T, TEAR_C, SIDE_W, SIDE_P, SIDE_F, SIDE_MC = 28, 68, 69, 70, 71, 72, 73   # §15
D_EMERG, D_OJ, D_LOSS, D_MIN, D_FIRE, D_OFF, D_KEEP, D_RED = 78, 79, 80, 81, 82, 83, 84, 85   # §17 D
E_W, E_BUR, E_REACH, E_ROWS, E_KEY = 86, 87, 88, 89, 90                                        # §17 E
F_FAR, G_PCT, G_MIN, G_FILL = 91, 94, 95, 96                                                   # §18 F・G（[92][93] は ext）
G_KEEP, G_LOSS, G_MINH, G_MINC3 = 97, 98, 99, 100                                             # §18.11 G の条件の絞り込み
S_MIN, S_PCT, S_DEPTH, S_KEEP, S_DANGER = 102, 103, 104, 105, 106                             # §18 H1 構え（[101] は思考ごとの入力）
# ユーザーの回答（§18.15）：ゲージ 8＝20個以上・全部相殺（危険なら 70%）・到達連鎖 70% まで譲る・NEXT2 まで
ST_USER = {S_MIN: 20, S_PCT: 100, S_DEPTH: 2, S_KEEP: 70, S_DANGER: 70}
VARIANTS = {
    "base": mk(),
    # ① 降っても撃てる（K）：おじゃまを qKeepRows 段載せた後に起こせる連鎖に価値（正）／失う量に罰（負）
    "k1":   mk({KEEP_W: 5, KEEP_D: 2, KEEP_R: 1}),
    "k2":   mk({KEEP_W: 10, KEEP_D: 2, KEEP_R: 1}),
    "k3":   mk({KEEP_W: 20, KEEP_D: 2, KEEP_R: 1}),
    "k2r2": mk({KEEP_W: 10, KEEP_D: 2, KEEP_R: 2}),
    "kn":   mk({KEEP_W: -10, KEEP_D: 2, KEEP_R: 1}),
    "kn2":  mk({KEEP_W: -20, KEEP_D: 2, KEEP_R: 1}),
    # ② 相殺用の副砲＋本線（E2b qSub と G1）＋カウンターで本線を残す（H2）
    "s1":   mk({QSUB: 45, SUB_MC: 5, SUB_MP: 20}),
    "s2":   mk({QSUB: 100, SUB_MC: 5, SUB_MP: 20}),
    "s3":   mk({QSUB: 100, SUB_MC: 4, SUB_MP: 0}),
    "h2":   mk(vt_keep_reach=1),
    "h2c":  mk(vt_keep_reach=3),
    "s2h2": mk({QSUB: 100, SUB_MC: 5, SUB_MP: 20}, vt_keep_reach=1),
    # ③ 経過時間で本線の目標発火を下げる
    "d60":  mk(vt_decay_start_s=60, vt_decay_step_s=10, vt_decay_min=4),
    "d30":  mk(vt_decay_start_s=30, vt_decay_step_s=10, vt_decay_min=4),
    "d15":  mk(vt_decay_start_s=15, vt_decay_step_s=10, vt_decay_min=4),
    "d15m5": mk(vt_decay_start_s=15, vt_decay_step_s=10, vt_decay_min=5),
    # ④ カウンターをただの相殺に合わせる
    "c100":  mk(vt_counter_pct=100),
    "c100q": mk(vt_counter_pct=100, vt_queue_only=1),
    "c80q":  mk(vt_counter_pct=80, vt_queue_only=1),
    "c130q": mk(vt_counter_pct=130, vt_queue_only=1),
    # §12 A 撃って倒せるか（倒すのに要るライン×pct%）
    "af100":   mk(vt_kill_pct=100, vt_kill_fire=1),                       # 倒せるなら目標未満でも撃つ
    "af130":   mk(vt_kill_pct=130, vt_kill_fire=1),
    "ah100":   mk(vt_kill_pct=100, vt_kill_hold_pct=100),                 # 倒せないなら目標でも撃たない
    "ah70":    mk(vt_kill_pct=100, vt_kill_hold_pct=70),
    "afh100":  mk(vt_kill_pct=100, vt_kill_fire=1, vt_kill_hold_pct=100),
    "afh130":  mk(vt_kill_pct=130, vt_kill_fire=1, vt_kill_hold_pct=100),
    "af200":   mk(vt_kill_pct=200, vt_kill_fire=1),
    "af300":   mk(vt_kill_pct=300, vt_kill_fire=1),
    "ah150":   mk(vt_kill_pct=150, vt_kill_hold_pct=100),
    "ah200":   mk(vt_kill_pct=200, vt_kill_hold_pct=100),
    "ah300":   mk(vt_kill_pct=300, vt_kill_hold_pct=100),
    "afh200":  mk(vt_kill_pct=200, vt_kill_fire=1, vt_kill_hold_pct=100),
    # §13 受ける／返す／軽減の区別（対テト版の地形優先の対応）
    "t6":    mk(vt_terrain_max=6),
    "t10":   mk(vt_terrain_max=10),
    "t13":   mk(vt_terrain_max=13),
    "t20":   mk(vt_terrain_max=20),
    "t30":   mk(vt_terrain_max=30),
    "t13q":  mk(vt_terrain_max=13, vt_terrain_queue=1),
    "t20q":  mk(vt_terrain_max=20, vt_terrain_queue=1),
    "t13c2":    mk(vt_terrain_max=13, vt_terrain_min_chains=2),
    "t13c3":    mk(vt_terrain_max=13, vt_terrain_min_chains=3),
    "t13g30":   mk(vt_terrain_max=13, vt_terrain_gain_pct=30),
    "t13g100":  mk(vt_terrain_max=13, vt_terrain_gain_pct=100),
    "t13c2g30": mk(vt_terrain_max=13, vt_terrain_min_chains=2, vt_terrain_gain_pct=30),
    "t13c3g100": mk(vt_terrain_max=13, vt_terrain_min_chains=3, vt_terrain_gain_pct=100),
    "t30c3g100": mk(vt_terrain_max=30, vt_terrain_min_chains=3, vt_terrain_gain_pct=100),
    # §12 B 整地だけの1連鎖を撃たない
    "b1":      mk(vt_strict=1),
    "b1af100": mk(vt_strict=1, vt_kill_pct=100, vt_kill_fire=1),
    # §15.1 ちぎり：量（段数+1＝失う時間）に比例・発火は罰なし（tt）／到達連鎖から点で引く（tc）
    "tt60":     mk({TEAR_W: 0, TEAR_T: -60}),
    "tt120":    mk({TEAR_W: 0, TEAR_T: -120}),
    "tc200":    mk({TEAR_C: 200}),
    "tc500":    mk({TEAR_C: 500}),
    "tc1000":   mk({TEAR_C: 1000}),
    "tt60c500": mk({TEAR_W: 0, TEAR_T: -60, TEAR_C: 500}),
    # §15.2 発火点の側面（K の置き換え：qKeep 0）。山の頂上 2段・1段ごとに 50% 減・2連鎖以上の発火点
    "sk20":     mk({KEEP_W: 0, SIDE_W: 20}),
    "sk50":     mk({KEEP_W: 0, SIDE_W: 50}),
    "sk100":    mk({KEEP_W: 0, SIDE_W: 100}),
    "sk50p1":   mk({KEEP_W: 0, SIDE_W: 50, SIDE_P: 1}),
    "sk50p3":   mk({KEEP_W: 0, SIDE_W: 50, SIDE_P: 3}),
    "sk50f34":  mk({KEEP_W: 0, SIDE_W: 50, SIDE_F: 34}),
    # §15.3 おじゃまを降らせる探索：固定の順（oa）／初手だけ全パターンの最悪（ob）／ready 済みだけ初手の後（obr＝旧案）
    "oa":       mk(vt_ojama_search=1),
    "ob":       mk(vt_ojama_search=1, vt_ojama_worst=1),
    "obr":      mk(vt_ojama_search=1, vt_ojama_worst=1, vt_ojama_turn_ms=1),
    # 組み合わせ
    "ob_sk50":       mk({KEEP_W: 0, SIDE_W: 50}, vt_ojama_search=1, vt_ojama_worst=1),
    "ob_tc500":      mk({TEAR_C: 500}, vt_ojama_search=1, vt_ojama_worst=1),
    "ob_sk50_tc500": mk({KEEP_W: 0, SIDE_W: 50, TEAR_C: 500}, vt_ojama_search=1, vt_ojama_worst=1),
    # §17 D 危険度で妥協して撃つ（基準＝本番 lv6 0.485。lv6 は ojamaSearch=1 なので [74..76] が入っている）
    "de1":          mk({D_EMERG: 1}),                                         # 緊急を降った後の盤面でも判定
    "do30r40":      mk({D_OJ: 30, D_FIRE: 40}),                               # おじゃま 30% → 反撃（比 40%）
    "do40r40":      mk({D_OJ: 40, D_FIRE: 40}),
    "do30o100":     mk({D_OJ: 30, D_OFF: 100}),                               # → 相殺
    "do30o100k50":  mk({D_OJ: 30, D_OFF: 100, D_KEEP: 50}),
    "do30r40o100k50":   mk({D_OJ: 30, D_FIRE: 40, D_OFF: 100, D_KEEP: 50}),  # 反撃＋相殺
    "do30r40o100k50rd": mk({D_OJ: 30, D_FIRE: 40, D_OFF: 100, D_KEEP: 50, D_RED: 1}),   # ＋軽減
    "dl50r40":      mk({D_LOSS: 50, D_FIRE: 40}),                             # 撃てる連鎖が 50% 減る → 反撃
    "dl50o100k50":  mk({D_LOSS: 50, D_OFF: 100, D_KEEP: 50}),
    # §17 E 発火点を縦に露出（1段6個・発火ぷよ2個まで。側面は今の 42 のまま併用）
    "ex30":         mk({E_W: 30}),
    "bu30":         mk({E_BUR: -30}),
    "exbu30":       mk({E_W: 30, E_BUR: -30}),
    "er30":         mk({E_REACH: 30}),                                        # 到達連鎖の割引（本命）
    "er50":         mk({E_REACH: 50}),
    "er50bu30":     mk({E_REACH: 50, E_BUR: -30}),
    "er50s0":       mk({E_REACH: 50, SIDE_W: 0}),                             # 側面を外す（置き換え）
    "er70":         mk({E_REACH: 70}),                                        # 割引を強める（§17.10 の次）
    "er100":        mk({E_REACH: 100}),                                       # 1段で埋まる発火点は到達連鎖に数えない
    "er50r2":       mk({E_REACH: 50, E_ROWS: 2}),                             # 2段載せても撃てるか
    "er30r2":       mk({E_REACH: 30, E_ROWS: 2}),                             # 2段の周り（§17.10.1 の次）
    "er70r2":       mk({E_REACH: 70, E_ROWS: 2}),
    "er50r3":       mk({E_REACH: 50, E_ROWS: 3}),
    # §17.12 ユーザーが CPU TEST の重み調整パネルで決めた値（本番＝er50r2 に足す。buriedWeight は +50 のまま）
    "user0":        mk({E_W: 100, E_BUR: 50, E_KEY: 3,
                        D_EMERG: 1, D_OJ: 20, D_LOSS: 40, D_MIN: 7, D_FIRE: 50}),
    # §18 F 見えている3手を重く（4手目以降の到達連鎖の割引・端数の最悪を見る深さ・最悪の選び方）
    "fr30":         mk({F_FAR: 30}),
    "fr50":         mk({F_FAR: 50}),
    "fr70":         mk({F_FAR: 70}),
    "wr":           mk(vt_ojama_worst_by_reach=1),                            # 初手の最悪を「撃てる連鎖」で選ぶ
    "wd1":          mk(vt_ojama_worst_depth=1),
    "wd2":          mk(vt_ojama_worst_depth=2),
    "wd2r":         mk(vt_ojama_worst_depth=2, vt_ojama_worst_by_reach=1),
    # §18 G 撃たないと埋まるなら撃つ（今撃てる最大×100 > 安全な火力×% で、相殺できて本線が最も残る手）
    "g70":          mk({G_PCT: 70}),
    "g100":         mk({G_PCT: 100}),
    "g150":         mk({G_PCT: 150}),
    "g100m7":       mk({G_PCT: 100, G_MIN: 7}),                               # 1段（6個）以下は見ない
    "g100h8":       mk({G_PCT: 100, G_FILL: 8}),                              # 平均8段以上は発火点が生きていても安全と見ない
    "g100fr50":     mk({G_PCT: 100, F_FAR: 50}),
    "g100wd2r":     mk({G_PCT: 100}, vt_ojama_worst_depth=2, vt_ojama_worst_by_reach=1),
    # §18.11 G の条件の絞り込み：案1 本線そのもの（reachPot < basePot×K%）は安全な火力 < basePot×L% のときだけ／
    #   案2 届いた量を降らせた後の平均の高さ（h）・第3列（c）の下限／案3 7個以上（m7）
    "g100k50l50":   mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 50}),
    "g100k50l30":   mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 30}),
    "g100h6":       mk({G_PCT: 100, G_MINH: 6}),
    "g100h7":       mk({G_PCT: 100, G_MINH: 7}),
    "g100c8":       mk({G_PCT: 100, G_MINC3: 8}),
    "g100k50l50m7": mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 50, G_MIN: 7}),
    "g100k50l50h6": mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 50, G_MINH: 6}),
    "g100k50l50h7": mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 50, G_MINH: 7}),
    "g100k50l50h6m7": mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 50, G_MINH: 6, G_MIN: 7}),
    "g70k50l50":    mk({G_PCT: 70, G_KEEP: 50, G_LOSS: 50}),
    # §18 H1 テトのゲージへの構え・H2 後打ち（カウンターの入り・発火点を届いた分だけで見る）
    "h2q":          mk(vt_counter_queue_only=1),
    "st20":         mk(ST_USER),
    "st20q":        mk(ST_USER, vt_counter_queue_only=1),                     # ユーザーの回答どおり（H1＋H2）
    "st20n1q":      mk({**ST_USER, S_DEPTH: 1}, vt_counter_queue_only=1),     # NEXT1 だけ
    "st20bq":       mk({**ST_USER, S_KEEP: 0}, vt_counter_queue_only=1),      # 本線は譲らない（band の中だけ）
    "st20p70q":     mk({**ST_USER, S_PCT: 70}, vt_counter_queue_only=1),      # いつも 70%
    "st13q":        mk({**ST_USER, S_MIN: 13}, vt_counter_queue_only=1),      # ゲージ 6（13個）から
    "st8q":         mk({**ST_USER, S_MIN: 8}, vt_counter_queue_only=1),       # ゲージ 4（8個）から
    # §18 W-a 待機：カウンターで撃つ手の quickDrop を、ゲージが届くまで止める（上限 ms・自然に固定したらそこまで）
    "wa20":         mk(vt_wait_min_gauge=20),
    "wa13":         mk(vt_wait_min_gauge=13),
    "wa8":          mk(vt_wait_min_gauge=8),
    "wa8m3000":     mk(vt_wait_min_gauge=8, vt_wait_max_ms=3000),
    "g100h5":       mk({G_PCT: 100, G_MINH: 5}),
    "g100k50l50h5": mk({G_PCT: 100, G_KEEP: 50, G_LOSS: 50, G_MINH: 5}),
    "g150h6":       mk({G_PCT: 150, G_MINH: 6}),
    "g70h6":        mk({G_PCT: 70, G_MINH: 6}),
}


def run(name: str, games: int, pol0) -> dict:
    pol = VARIANTS[name](pol0.__class__(list(pol0.build), list(pol0.fast),
                                                               pol0.counter_trigger, pol0.counter_margin,
                                                               list(pol0.ext)))
    rs = tetsim.run_vstet(pol, np.arange(1, games + 1), both_orders=False)
    w = np.array([r["winner"] == 0 for r in rs])
    a = {k: np.array([r[k] for r in rs]) for k in tetsim.VSTET_KEYS}
    return {"win": w, "a": a}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        print(" ".join(VARIANTS))
        return
    pol0 = tetsim.vstet_policy("lv6")
    base = None
    for name in (["base"] + [n for n in args.names if n != "base"]):
        t = time.time()
        r = run(name, args.games, pol0)
        w = r["win"]
        a = r["a"]
        lo, hi = wilson(int(w.sum()), len(w))
        line = (f"{name:7s} 勝率 {w.mean():.3f} [{lo:.3f}, {hi:.3f}]")
        if base is not None:
            gain = int((w & ~base).sum()); loss = int((~w & base).sum())
            line += f"  基準比 +{gain}/−{loss}"
        lose = a["winner"] == 1
        line += (f"｜決着 中央 {np.median(a['ms']) / 1000:.1f}s・最大連鎖 {a['puyo_max_chain'].mean():.2f}"
                 f"（≧6 {(a['puyo_max_chain'] >= 6).mean():.1%}）・送 {a['puyo_lines_sent'].mean():.1f} ライン・"
                 f"被弾 {a['puyo_ojama_received'].mean():.1f}・ただの相殺 {a['free_offsets'].mean():.2f}・"
                 f"カウンター手 {a['puyo_counter_turns'].mean():.1f}・負け局の最大連鎖 {a['puyo_max_chain'][lose].mean():.2f}"
                 f"・ちぎり {a['puyo_tears'].mean():.1f} 回／量 {a['puyo_tear_units'].mean():.1f}"
                 f"・負け局で本線級(5+)なし {(a['puyo_max_chain'][lose] < 5).mean():.0%}"
                 f"・危険 {a['puyo_danger_turns'].mean():.1f} 手／撃った {a['puyo_danger_fires'].mean():.1f}"
                 f"・G 確認 {a['puyo_safe_checks'].mean():.1f} 手／撃った {a['puyo_safe_fires'].mean():.1f}"
                 f"・構え 確認 {a['puyo_standby_checks'].mean():.2f} 手／そのまま満たす {a['puyo_standby_ok'].mean():.2f}"
                 f"／危険 {a['puyo_standby_danger'].mean():.2f}／変えた {a['puyo_standby_changes'].mean():.2f}"
                 f"・待機 {a['puyo_counter_waits'].mean():.2f} 回（届いて撃つ {a['puyo_counter_wait_arrived'].mean():.2f}）"
                 f"・1回 {a['puyo_counter_wait_ms'].sum() / max(1, a['puyo_counter_waits'].sum()):.0f}ms"
                 f"・1手 {(time.time() - t) * 1000 / max(1, a['puyo_turns'].sum()):.2f}ms"
                 f"（{time.time() - t:.0f}s）")
        print(line, flush=True)
        if base is None:
            base = w


if __name__ == "__main__":
    main()

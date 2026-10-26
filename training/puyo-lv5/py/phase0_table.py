"""runs/phase0/*.summary.json を表にする（lv6-learning-design.md Phase 0）。
  python3 py/phase0_table.py
"""
from __future__ import annotations

import json
from pathlib import Path

D = Path(__file__).resolve().parent.parent / "runs" / "phase0"


def main() -> None:
    rows = []
    for f in sorted(D.glob("*.summary.json")):
        s = json.loads(f.read_text())
        a, b = s["a"], s["b"]
        p, q = a["per100"], b["per100"]
        rows.append((f.name.replace(".summary.json", ""), s["games"], s["a_win"], s["ci95"], p, a, q, b))
    print("| run | 局 | A勝率(95%) | A TSD | 4L | PC | BtB | 火/ライン | 受けた段/局 | PPS | 思考ms/手 | ノード/手 | ノード/ms | B TSD | 4L | PC |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, n, w, ci, p, a, q, b in rows:
        print(f"| {name} | {n} | {w:.3f}（{ci[0]:.2f}–{ci[1]:.2f}） | {p['tsd']:.1f} | {p['tetrises']:.1f} | {p['pcs']:.2f} | "
              f"{p['b2bs']:.1f} | {a['attack_per_line']:.2f} | {a['garbage_taken_per_game']:.0f} | {a['pps']:.2f} | "
              f"{a['think_ms_per_piece']:.1f} | {a['nodes_per_piece']:.0f} | {a['nodes_per_ms']:.0f} | "
              f"{q['tsd']:.1f} | {q['tetrises']:.1f} | {q['pcs']:.2f} |")
    for f in sorted(D.glob("solo_*.json")):
        s = json.loads(f.read_text())
        for k, v in s.items():
            print(f"{f.stem} {k}: TS {v['tspins']:.1f} 4L {v['tetrises']:.1f} 火/100手 {v['attack']:.0f} "
                  f"穴 {v['holes']:.2f} 穴3+ {100*v['holes3']:.1f}% 凸凹 {v['bump']:.1f} dead {v['dead']} ({v['wall_sec']:.0f}s)")


if __name__ == "__main__":
    main()

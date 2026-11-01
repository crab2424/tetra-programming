// ─────────────────────────────────────────────
// game_clock.js — ゲーム時計
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §4.1 D1
//   ・ゲームの判断（重力・固定猶予・DAS・タイム表示など）に使う時刻は全部ここから取る。
//     見た目だけのアニメ・SE の間引き・CPU の見張りなどは実時間（performance.now）のままでよい。
//   ・1 試合に 1 本。VERSUS は両盤面に同じ時計を渡す（versus.js）。
//   ・M0 の段階では今の performance.now() と同じ値を返すだけ。
//     後の段階（M1〜）で「rAF ごとに進める・ポーズで止める・録画した経過時間で進める」に変える。
// ─────────────────────────────────────────────

class GameClock {
    now() {
        return performance.now();
    }
}

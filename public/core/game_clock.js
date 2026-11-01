// ─────────────────────────────────────────────
// game_clock.js — ゲーム時計
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §4.1 D1・D2
//   ・ゲームの判断（重力・固定猶予・DAS・タイム表示など）に使う時刻は全部ここから取る。
//     見た目だけのアニメ・SE の間引き・CPU の見張りなどは実時間（performance.now）のままでよい。
//   ・1 試合に 1 本。VERSUS は両盤面に同じ時計を渡す（versus.js）。
//   ・時刻はフレームの頭で advance() したときだけ進む（1 フレームの中では同じ値）。
//     進む量は実時間の差を 1/16ms 単位に丸めたもの。丸めの端数は次のフレームへ持ち越すので、
//     長く遊んでも実時間からずれない（ずれるのは最後の advance からの経過ぶんだけ）。
//   ・予約（schedule）は setTimeout の代わり。advance() の中で予定時刻の順（同時刻なら予約順）に
//     実行し、実行中の now() はその予定時刻になる。予約の中で入れた予約も、同じ advance の範囲内なら続けて実行する。
//   ・advance() はそのフレームでこの時計を使うループが頭で呼ぶ（tet: render.js startRenderLoop、
//     puyo: engine.js _loop）。VERSUS で 2 つのループが同じ時計を進めても、2 回目はほぼ 0 進むだけ。
//   ・後の段階（M3〜）で「試合の親ループだけが進める・ポーズで止める・録画した経過時間で進める」に変える。
// ─────────────────────────────────────────────

class GameClock {
    constructor() {
        this._last = performance.now();               // 最後に advance したときの実時間
        this._t = Math.round(this._last * 16) / 16;   // ゲーム時刻（実時間に近い値から始める）
        this._timers = [];                            // 予約（due・seq の順に並べる）
        this._seq = 0;
    }

    now() {
        return this._t;
    }

    // 実時間の経過ぶん時計を進め、その間に来た予約を順に実行する。進めた量（ms）を返す
    advance() {
        const dt = Math.round((performance.now() - this._last) * 16) / 16;
        if (dt <= 0) return 0;
        this._last += dt;
        const target = this._t + dt;
        const timers = this._timers;
        while (timers.length && timers[0].due <= target) {
            const h = timers.shift();
            if (h.due > this._t) this._t = h.due;
            const cb = h.cb;
            h.cb = null;
            if (cb) cb();
        }
        this._t = target;
        return dt;
    }

    // ms 後に cb を実行する予約。戻り値は cancel() に渡す
    schedule(ms, cb) {
        const h = { due: this._t + Math.max(0, ms), seq: this._seq++, cb };
        const timers = this._timers;
        let i = timers.length;
        while (i > 0 && timers[i - 1].due > h.due) i--;
        timers.splice(i, 0, h);
        return h;
    }

    // 別の時計で入れた予約を渡しても cb を消すので、その予約は実行されない
    // （VERSUS は試合ごとに時計を作り直すため、前の試合の予約が手元に残っていることがある）
    cancel(h) {
        if (!h) return;
        const i = this._timers.indexOf(h);
        if (i !== -1) this._timers.splice(i, 1);
        h.cb = null;
    }
}

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
//   ・advance() は試合の親ループ（core/match_loop.js）がフレームの頭で 1 回だけ呼ぶ。
//     フレームが回っていなかった後に時刻の基準を取る所（試合の頭など）も先に呼ぶ。
//     予約の実行中（advance の中）に呼ばれた advance は何もしない。
//   ・pause() の間は進まない。resume() は止まっていた間の実時間を捨てて、止めた時刻から続ける（設計 D7）。
//     予約の実行中に pause() されたら、その advance の残りの予約もそこで止める。
//   ・録画・再生（core/replay.js、設計 §5）: 録画中は advance() のたびに進めた量を _tape に書き、
//     再生中は実時間の代わりに _feed から読んだ量で進める（どちらも 1/16ms 単位の整数）。
//     止まっている間・予約の実行中の advance() は何も書かず何も読まない（録画と再生で同じ所を通るため）。
// ─────────────────────────────────────────────

class GameClock {
    constructor() {
        this._last = performance.now();               // 最後に advance したときの実時間
        this._t = Math.round(this._last * 16) / 16;   // ゲーム時刻（実時間に近い値から始める）
        this._timers = [];                            // 予約（due・seq の順に並べる）
        this._seq = 0;
        this._paused = false;
        this._advancing = false;
        this._tape = null;                            // 録画: 進めた量を書く先（ReplayBuf）
        this._feed = null;                            // 再生: 進める量を読む元（ReplayReader）
    }

    now() {
        return this._t;
    }

    // 実時間の経過ぶん時計を進め、その間に来た予約を順に実行する。進めた量（ms）を返す
    advance() {
        if (this._paused || this._advancing) return 0;
        let dt;
        if (this._feed) {
            dt = this._feed.done ? 0 : this._feed.varint() / 16;
        } else {
            dt = Math.round((performance.now() - this._last) * 16) / 16;
            if (this._tape) this._tape.varint(dt > 0 ? dt * 16 : 0);
        }
        if (dt <= 0) return 0;
        // 再生中は実時間の基準を動かさない（録画した量を足すと、見終わった後の実時間の基準が先へずれて時計が止まる）
        if (!this._feed) this._last += dt;
        const start = this._t;
        const target = start + dt;
        const timers = this._timers;
        this._advancing = true;
        try {
            while (timers.length && timers[0].due <= target) {
                const h = timers.shift();
                if (h.due > this._t) this._t = h.due;
                const cb = h.cb;
                h.cb = null;
                if (cb) cb();
                if (this._paused) return this._t - start; // 予約の中でポーズされた: 時刻はその予約のところで止める
            }
            this._t = target;
        } finally {
            this._advancing = false;
        }
        return dt;
    }

    // ポーズ。止めている間は advance() しても進まない
    pause() {
        this._paused = true;
    }

    // ポーズ明け。止まっていた間の実時間は数えない
    resume() {
        if (!this._paused) return;
        this._paused = false;
        this._last = performance.now();
    }

    get paused() {
        return this._paused;
    }

    // 再生の頭: 予約を全部捨てて、録画したときの時刻から始める（core/replay.js）
    reset(t) {
        for (let i = 0; i < this._timers.length; i++) this._timers[i].cb = null;
        this._timers.length = 0;
        this._t = t;
        this._paused = false;
        this._last = performance.now();
    }

    // 再生の頭（VERSUS）: 試合の初期化で入れた予約（マージンタイム）は残したまま、録画したときの時刻から始める
    // （VERSUS は試合ごとに時計を作り直すので、残っているのはこの試合の予約だけ。core/replay.js）。
    // offsets: 録画した頭の時刻からの各予約の残り（並びは予約の順）。数が合わなければ今からの残りをそのまま使う
    rebase(t, offsets) {
        const timers = this._timers;
        const rec = Array.isArray(offsets) && offsets.length === timers.length;
        for (let i = 0; i < timers.length; i++) timers[i].due = t + (rec ? offsets[i] : timers[i].due - this._t);
        this._t = t;
        this._paused = false;
        this._last = performance.now();
    }

    // 再生の終わり: 実時間で進む時計に戻す（再生していた間の実時間は数えない）
    endFeed() {
        this._feed = null;
        this._last = performance.now();
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

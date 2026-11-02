// ─────────────────────────────────────────────
// cpu_port.js — CPU が盤面に触る口（tet / puyo 共通の時間の部分）
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §4.1 D6
//   ・CPU が盤面を動かすのは game.cpuAction(type, …)（tet: game/tet/board.js、puyo: game/puyo/input.js）だけ。
//     録画（M6）ではこの口を通った手を「入力」として記録し、再生では CPU を動かさずに同じ手を流す。
//   ・CPU の待ち時間は setTimeout でなく game.cpuSchedule(ms, cb)（ゲーム時計の時刻）。
//     毎フレームの polling は game.cpuFrame(cb)（次のフレームで 1 回呼ぶ）。
//     Worker の思考結果も cpuSchedule(0, …) で受け取る。
//   ・どれもフレームの「入力の取り込み」の所（人のキーを取り込んだ直後、重力・盤面の更新の前）で
//     _runCpu() がまとめて実行する。だから CPU の手は人のキーと同じく、フレームの決まった位置で盤面に入る。
//     時計の予約（固定猶予など）とは混ぜない（混ぜると同じ時刻の予約との前後が再生で再現できない）。
//   ・待ち時間の予約の中で入れた予約は、今の予約の予定時刻から数える（setTimeout を続けたときと同じく、
//     フレームの遅れが一手ごとに積み重ならない。CPU の操作の速さを変えないため）。それ以外はフレームの時刻から。
//   ・ポーズ中は時計が止まるので、待ち時間の予約は進まない（cpuFrame の polling は tet ではポーズ中も回る）。
// ─────────────────────────────────────────────

const CpuPort = {
    // ms 後（ゲーム時計）に cb を呼ぶ。戻り値は cpuCancel に渡す
    cpuSchedule(ms, cb) {
        const list = this._cpuTimers || (this._cpuTimers = []);
        const base = (this._cpuDue !== undefined && this._cpuDue !== null) ? this._cpuDue : this.clock.now();
        const h = { due: base + Math.max(0, ms || 0), seq: this._cpuSeq = (this._cpuSeq || 0) + 1, cb };
        let i = list.length;
        while (i > 0 && list[i - 1].due > h.due) i--;
        list.splice(i, 0, h);
        return h;
    },

    cpuCancel(h) {
        if (!h) return;
        h.cb = null;
        const list = this._cpuTimers;
        if (!list) return;
        const i = list.indexOf(h);
        if (i !== -1) list.splice(i, 1);
    },

    // 次のフレームの入力の所で 1 回だけ cb を呼ぶ（rAF の代わり）
    cpuFrame(cb) {
        (this._cpuFrameCbs || (this._cpuFrameCbs = [])).push(cb);
    },

    // 前の試合の CPU の予約を全部捨てる（VERSUS で時計を作り直すとき）
    cpuReset() {
        if (this._cpuTimers) this._cpuTimers.length = 0;
        if (this._cpuFrameCbs) this._cpuFrameCbs.length = 0;
    },

    // フレームの入力の所で呼ぶ: cpuFrame → 時刻が来た cpuSchedule の順
    _runCpu() {
        // 再生中は CPU を動かさず、録画した CPU の手をここで流す（core/replay.js）
        if (this._replay) { this._replay.runCpu(this); return; }
        const frame = this._cpuFrameCbs;
        const timers = this._cpuTimers;
        if (!(frame && frame.length) && !(timers && timers.length)) return;
        this._cpuRunning = true;
        try {
            if (frame && frame.length) {
                // このフレームで登録されたものは次のフレームへ（入れ替えて回す）
                this._cpuFrameCbs = this._cpuFrameSpare || [];
                this._cpuFrameSpare = frame;
                for (let i = 0; i < frame.length; i++) frame[i]();
                frame.length = 0;
            }
            if (timers) {
                const now = this.clock.now();
                // 予約の中で入れた 0ms の予約も同じフレームで続けて呼ぶ（念のため回数に上限）
                for (let n = 0; timers.length && timers[0].due <= now && n < 10000; n++) {
                    const h = timers.shift();
                    const cb = h.cb;
                    h.cb = null;
                    this._cpuDue = h.due;
                    try {
                        if (cb) cb();
                    } finally {
                        this._cpuDue = null;
                    }
                }
            }
        } finally {
            this._cpuRunning = false;
        }
    },
};

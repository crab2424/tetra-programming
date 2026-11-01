// ─────────────────────────────────────────────
// match_loop.js — 試合の親ループ（1 試合 1 ループ）
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §4.1 D4
//   ・盤面ごとに rAF を回すのをやめ、試合に 1 本の rAF で毎フレーム同じ順に
//       時計を進める（予約の実行）→ 1P を進める → 2P を進める → 1P を描く → 2P を描く
//     を回す。VERSUS は両盤面に同じループを渡す（versus.js）。シングルは盤面ごとに 1 本。
//   ・盤面は add(game, update, draw) で加わり、remove(game) で抜ける。並び順は game.rngSide（0=1P, 1=2P）。
//     抜けて加わり直しても順番は変わらない。
//   ・加わっている盤面が無くなったら rAF を止める。
//   ・時計は各盤面の game.clock（VERSUS は共通の 1 本）。同じ時計は 1 フレームに 1 回だけ進める。
// ─────────────────────────────────────────────

class MatchLoop {
    constructor() {
        this._members = [];      // { game, slot, update, draw, removed }（slot の順）
        this._rafId = null;
        this._ticking = false;
        this._needsCompact = false;
        this._pending = [];      // フレームの中で新しく加わった盤面（そのフレームが終わってから並びに入れる）
        this._tick = this._tick.bind(this);
    }

    // 盤面を加える（加わっていれば update/draw を差し替えるだけ）
    add(game, update, draw) {
        const slot = game.rngSide || 0;
        let m = this._find(game);
        if (m) {
            m.update = update;
            m.draw = draw;
            m.removed = false;
        } else {
            m = { game, slot, update, draw, removed: false };
            if (this._ticking) this._pending.push(m); // 回している最中に並びを動かさない（次のフレームから加わる）
            else this._insert(m);
        }
        if (this._rafId === null) this._rafId = requestAnimationFrame(this._tick);
    }

    remove(game) {
        const m = this._find(game);
        if (!m || m.removed) return;
        m.removed = true;
        if (this._ticking) { this._needsCompact = true; return; }
        this._compact();
    }

    has(game) {
        const m = this._find(game);
        return !!m && !m.removed;
    }

    _find(game) {
        const list = this._members;
        for (let i = 0; i < list.length; i++) if (list[i].game === game) return list[i];
        const pend = this._pending;
        for (let i = 0; i < pend.length; i++) if (pend[i].game === game) return pend[i];
        return null;
    }

    _insert(m) {
        const list = this._members;
        let i = list.length;
        while (i > 0 && list[i - 1].slot > m.slot) i--;
        list.splice(i, 0, m);
    }

    _compact() {
        const list = this._members;
        let j = 0;
        for (let i = 0; i < list.length; i++) if (!list[i].removed) list[j++] = list[i];
        list.length = j;
        this._needsCompact = false;
        if (j === 0 && this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    _tick() {
        this._rafId = null;
        const list = this._members;
        this._ticking = true;
        try {
            // 時計を進める（予約の実行。同じ時計は 1 回だけ）
            for (let i = 0; i < list.length; i++) {
                if (list[i].removed) continue;
                const clock = list[i].game.clock;
                let seen = false;
                for (let j = 0; j < i; j++) if (!list[j].removed && list[j].game.clock === clock) { seen = true; break; }
                if (!seen) clock.advance();
            }
            // 盤面を進める（1P → 2P）
            for (let i = 0; i < list.length; i++) {
                if (!list[i].removed && list[i].update) list[i].update();
            }
            // 描く
            for (let i = 0; i < list.length; i++) {
                if (!list[i].removed && list[i].draw) list[i].draw();
            }
        } finally {
            this._ticking = false;
            if (this._pending.length) {
                for (let i = 0; i < this._pending.length; i++) this._insert(this._pending[i]);
                this._pending.length = 0;
                this._needsCompact = true;
            }
            if (this._needsCompact) this._compact();
            if (list.length && this._rafId === null) this._rafId = requestAnimationFrame(this._tick);
        }
    }
}

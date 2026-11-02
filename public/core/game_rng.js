// ─────────────────────────────────────────────
// game_rng.js — 1 試合ぶんの乱数（シード付き・用途別）
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §4.1 D3
//   ・シード（32bit × 4）から決まった列を出す。式はオンラインの createSeededRng
//     （src/online/game_protocol.ts）と同じ sfc32。
//   ・用途（ツモ・おじゃまの穴・ぷよの色など）ごとに別の列を作る。片方の使い方が
//     変わっても、他の列はずれない。
//     例: ぷよは以前 1 本の列をツモ・おじゃまの列・連鎖文字の位置で共有していたため、
//     VERSUS で同じシードを配っても連鎖やおじゃまのたびに両者のツモがずれていた。
//   ・ゲームの判断に効く乱数は全部ここから取る（Math.random を直に呼ばない）。
//     見た目だけの乱数（背景パーティクル等）は対象外。
// ─────────────────────────────────────────────

const GameRng = (() => {

    // 状態は next.state（Uint32Array(4)）に持つ。録画の再生のスナップショット（core/replay.js）が写して戻すため。
    // 入れるときに Uint32Array が >>> 0 するので、以前の「呼ぶたびに a >>>= 0 …」と同じ列になる
    function sfc32(a, b, c, d) {
        const st = new Uint32Array([a, b, c, d]);
        const next = function () {
            let a = st[0], b = st[1], c = st[2], d = st[3];
            let t = (a + b) | 0;
            a = b ^ (b >>> 9);
            b = (c + (c << 3)) | 0;
            c = (c << 21) | (c >>> 11);
            d = (d + 1) | 0;
            t = (t + d) | 0;
            c = (c + t) | 0;
            st[0] = a; st[1] = b; st[2] = c; st[3] = d;
            return (t >>> 0) / 4294967296;
        };
        next.state = st;
        return next;
    }

    // 用途名を 32bit に畳む（FNV-1a）
    function hashLabel(label) {
        let h = 0x811c9dc5;
        for (let i = 0; i < label.length; i++) {
            h ^= label.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    // 新しいシード（32bit × 4）
    function newSeed() {
        const s = new Uint32Array(4);
        crypto.getRandomValues(s);
        return Array.from(s);
    }

    // シードと用途名から列を作る。同じシード・同じ用途名なら必ず同じ列になる
    function stream(seed, label) {
        const h = hashLabel(label);
        const next = sfc32(
            seed[0] ^ h,
            seed[1] ^ Math.imul(h, 0x9e3779b1),
            seed[2] ^ Math.imul(h, 0x85ebca6b),
            seed[3] ^ Math.imul(h, 0xc2b2ae35),
        );
        // 初期状態の偏りを除くウォームアップ（createSeededRng と同じ回数）
        for (let i = 0; i < 12; i++) next();
        return next;
    }

    // 録画ファイル等に書くための 32 文字の hex
    function toHex(seed) {
        return seed.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
    }

    function fromHex(hex) {
        const seed = [];
        for (let i = 0; i < 4; i++) seed.push(parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0);
        return seed;
    }

    return { newSeed, stream, toHex, fromHex };
})();

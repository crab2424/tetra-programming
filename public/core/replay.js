// ─────────────────────────────────────────────
// replay.js — 録画・再生
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §5〜§7・§12（M5: tet シングル、M6: puyo・VERSUS・CPU TEST）
//   ・エンジンは決定的（M0〜M4）なので、録画は「シード・時計を進めた量の列・入力」だけを残す。
//     1 本のリプレイ＝1 試合（盤面 1〜2 枚。VERSUS は 2 枚で時計とループを共有）。盤面は side（0=1P, 1=2P）で区別する。
//       時計を進めた量: game_clock.js の advance() のたびに 1/16ms 単位で書く（_tape）。フレームの外の advance
//                       （runCountdown の頭・puyo の resume など）も同じ順に通るので、そのまま 1 本の列にする。
//       フレーム: 試合の親ループ（match_loop.js）の step 1 回が 1 フレーム（VERSUS も両盤面で同じ番号）。
//       入力: フレームの頭で取り込んだ人のキー・パッド（届いた瞬間でなく取り込んだフレームで残す）、
//             CPU の手（game.cpuAction の口。core/cpu_port.js の _runCpu の所で入る）、
//             ポーズ・再開・キー設定の読み直し（次のフレームの頭の出来事）、
//             tet でゲーム画面が出ていなくて入力を取り込まなかったフレームの印。
//       設置ごとの盤面のハッシュ（ずれの検出。§7）。tet は固定したとき、puyo は次のぷよを出す直前。
//   ・再生は本物の Game / PuyoGame に同じシード・同じ設定で start() し、時計は記録した量で進め（_feed）、
//     入力はフレームの頭で _inputQueue に入れ、CPU の手は _runCpu の所で cpuAction に流す（CPU は読み込まない）。
//     人のキー・パッドは受けない（input.js）。試合の親ループに driver として入り、rAF ごとに何フレーム進めるかを決める。
//   ・シーク（M5）: 前へは描かずに早送り、戻るときは最初からやり直して早送り。速いシークはスナップショット（M7）。
//   ・音（§5.2）: BGM は等速で流し続ける（再生の頭で 1 回だけ）。SE は 2 倍まで鳴らし、それより速いとき・シーク中は鳴らさない。
//   ・ずれたら止める（§7）。動きを変える修正をしたら REPLAY_ENGINE_VERSION を上げる。
//   ・コンソール: ReplayManager.verify() で直前のリプレイを描かずに最初から再生し、ハッシュを全部照らし合わせる。
//     localStorage.replayAutoVerify = '1' なら、リザルト画面に入るたびに自動で照らし合わせてコンソールに出す。
// ─────────────────────────────────────────────

const REPLAY_FORMAT_VERSION = 2;   // ファイルの形の版（§6.2）。2: 盤面 2 枚・CPU の手・キー設定の読み直し
const REPLAY_ENGINE_VERSION = 3;   // エンジンの動きの版（§7）。動きを変える修正をしたら上げる。2: ATTACK BIAS の切り捨て（分数・最低 1 なし）と ULTRA 時間切れの経過時間。3: MARATHON の START LEVEL を開始時から（2 以下の録画は従来どおり再生。tet/lifecycle.js）

// 入力の列の種類。1 バイト目＝種類 << 1 | side
//   キー 0〜3（bit0 押す・bit1 長押しの繰り返し）＋コードの番号、tet のパッド 4〜5（bit0 押す）＋アクションの番号
const REPLAY_EV_PAD = 4;
const REPLAY_EV_PAUSE = 8;    // 次のフレームの頭
const REPLAY_EV_RESUME = 9;   // 次のフレームの頭
const REPLAY_EV_SKIP = 10;    // このフレームはゲーム画面が出ていなくて tet が入力を取り込まなかった
const REPLAY_EV_CONFIG = 11;  // 次のフレームの頭: キー設定・DAS を読み直した（設定画面で保存）＋設定の番号
const REPLAY_EV_CPU = 12;     // CPU の手（cpuAction）＋種類の番号・引数
const REPLAY_EV_COUNTDOWN = 13; // 次のフレームの頭: VERSUS のカウントダウンを始めた（ロード画面の後なのでフレームの間で起きる）
// 足すときは末尾へ（番号で記録しているので、古い録画の番号を変えない）
const REPLAY_PAD_ACTIONS = ['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'hold', 'zone'];
const REPLAY_CPU_ACTIONS = [
    // tet
    'hold', 'rotate', 'move', 'shift', 'softDrop', 'softDropQuiet', 'stepToX', 'warp', 'teleport', 'hardDrop', 'gravity',
    // puyo
    'quickDrop', 'softDropStart', 'softDropStep', 'forceLock', 'softKey',
    // tet（あとから足したもの。番号を変えないよう末尾へ）
    'zone',
];
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
// 印の画面（UI 設計書 §7）: 札の幅・同じ段の札の間隔（札の中心どうし）・時刻 1ms あたりの幅（1 秒 40px）
const REPLAY_MK_CARD_W = 150;
const REPLAY_MK_STEP = 162;
const REPLAY_MK_PX_PER_MS = 0.04;
const REPLAY_MK_KIND = { attack: 'ATTACK', hit: 'HIT', end: 'END', pause: 'PAUSE' };

// 自動の印の閾値（§8.1・§13）。tet はライン、puyo はおじゃまの個数。localStorage.replay_mark_thresholds で変えられる
const REPLAY_MARK_DEFAULT = { tetAttack: 2, tetHit: 2, puyoAttack: 6, puyoHit: 6 };
function replayMarkThresholds() {
    try {
        const s = JSON.parse(localStorage.getItem('replay_mark_thresholds') || 'null');
        if (s && typeof s === 'object') return Object.assign({}, REPLAY_MARK_DEFAULT, s);
    } catch (e) { /* 使えない・壊れた値は既定 */ }
    return REPLAY_MARK_DEFAULT;
}

// tet の攻撃の名前（画面のアクションラベルと同じ呼び方）
function replayTetLabel(tSpin, lines, b2b, ren, pc) {
    const parts = [];
    if (b2b) parts.push('B2B');
    if (pc) parts.push('PERFECT CLEAR');
    else if (tSpin === 'tspin' || tSpin === 'mini') parts.push((tSpin === 'mini' ? 'T-SPIN MINI ' : 'T-SPIN ') + ['ZERO', 'SINGLE', 'DOUBLE', 'TRIPLE'][lines]);
    else if (lines > 0) parts.push(['', 'SINGLE', 'DOUBLE', 'TRIPLE', '4-LINES'][lines] || (lines + '-LINES'));
    if (ren >= 2) parts.push('REN ' + ren);
    return parts.join(' ');
}
const REPLAY_TET_SINGLE = ['marathon', 'sprint', 'ultra', 'zone'];

// 盤面の設定のうち結果に響くもの（外の画面が書き込む値。PRACTICE などが残した値も含めて録画したときと同じにする）
const REPLAY_ENV_FIELDS = {
    tet: ['gravityDisabled', 'practiceNoLock', 'practiceFallSpeedMs', 'practiceHoldMode', 'lockDelay',
        'marathonGoal', 'marathonStartLevel', 'isCpuControlled',
        'zoneFixedLevel', 'zoneQuarterLinesSetting', 'zoneQuarterMsSetting',
        'vsMarginTimeMs', 'vsAttackMultiplier', 'vsGarbageHoleRate', 'vsGarbageDamageOnClear', 'vsHoldEnabled',
        'vsChainMin', 'vsOjamaRate', 'vsPuyoSpeed', 'vsMarginMultiplier'],
    puyo: ['vsEraseCount', 'vsColorCount', 'practiceFallMs', 'practiceNoLock', 'isCpuControlled', 'suppressBlink',
        'vsMarginTimeMs', 'vsAttackMultiplier', 'vsGarbageHoleRate', 'vsGarbageDamageOnClear', 'vsChainMin',
        'vsOjamaRate', 'vsPuyoSpeed', 'vsMarginMultiplier'],
};

// 可変長整数などを追記するバッファ（毎フレーム小さなゴミを出さない。§5.1）
class ReplayBuf {
    constructor(size = 4096) {
        this.a = new Uint8Array(size);
        this.n = 0;
    }
    _room(k) {
        if (this.n + k <= this.a.length) return;
        const b = new Uint8Array(Math.max(this.a.length * 2, this.n + k));
        b.set(this.a.subarray(0, this.n));
        this.a = b;
    }
    byte(v) {
        this._room(1);
        this.a[this.n++] = v;
    }
    varint(v) {
        this._room(10);
        while (v >= 0x80) {
            this.a[this.n++] = (v % 128) | 0x80;
            v = Math.floor(v / 128);
        }
        this.a[this.n++] = v;
    }
    u32(v) {
        this._room(4);
        this.a[this.n++] = v & 0xff;
        this.a[this.n++] = (v >>> 8) & 0xff;
        this.a[this.n++] = (v >>> 16) & 0xff;
        this.a[this.n++] = (v >>> 24) & 0xff;
    }
    f64(v) {
        this._room(8);
        new DataView(this.a.buffer).setFloat64(this.n, v, true);
        this.n += 8;
    }
    bytes() {
        return this.a.subarray(0, this.n);
    }
}

class ReplayReader {
    constructor(u8) {
        this.a = u8;
        this.p = 0;
    }
    get done() {
        return this.p >= this.a.length;
    }
    byte() {
        return this.a[this.p++];
    }
    varint() {
        let v = 0, mul = 1, b;
        do {
            b = this.a[this.p++];
            v += (b & 0x7f) * mul;
            mul *= 128;
        } while ((b & 0x80) && this.p < this.a.length);
        return v;
    }
    f64() {
        const v = new DataView(this.a.buffer, this.a.byteOffset).getFloat64(this.p, true);
        this.p += 8;
        return v;
    }
}

// CPU の手の引数（undefined / 真偽 / 整数 / それ以外の数は float64 のまま）
function replayPutArg(buf, v) {
    if (v === undefined || v === null) buf.byte(0);
    else if (v === false) buf.byte(1);
    else if (v === true) buf.byte(2);
    else if (Number.isInteger(v) && Math.abs(v) < 2 ** 30) { buf.byte(3); buf.varint(v < 0 ? -2 * v - 1 : 2 * v); }
    else { buf.byte(4); buf.f64(Number(v)); }
}

function replayGetArg(r) {
    const t = r.byte();
    if (t === 0) return undefined;
    if (t === 1) return false;
    if (t === 2) return true;
    if (t === 3) { const z = r.varint(); return (z % 2) ? -(z + 1) / 2 : z / 2; }
    return r.f64();
}

function replayToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}

function replayFromB64(b64) {
    const s = atob(b64 || '');
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
}

function replayRule(g) {
    return g.rule === 'tet' ? 'tet' : 'puyo';
}

function replaySide(g) {
    return g.rngSide || 0;
}

// 盤面のハッシュ（4 バイト）
function replayHasher() {
    let h = 0x811c9dc5 | 0;
    return {
        w(v) {
            h = Math.imul(h ^ (v | 0), 0x01000193);
            h ^= h >>> 15;
        },
        get() { return h >>> 0; },
    };
}

// tet: 固定したとき。盤面・得点・ライン・レベル・REN・B2B・HOLD・NEXT 7 個・おじゃまの予約・時刻
function replayTetHash(g, t0) {
    const H = replayHasher();
    H.w(replaySide(g));
    const bs = g.field.blocks;
    H.w(bs.length);
    for (let i = 0; i < bs.length; i++) H.w(((bs[i].y + 16) * 16 + bs[i].x) * 16 + (bs[i].type | 0));
    H.w(g.score);
    H.w(g.lines);
    H.w(g.level);
    H.w(g.ren);
    H.w(g.backToBack ? 1 : 0);
    H.w(g.holdMino ? g.holdMino.type + 1 : 0);
    const nq = g.nextQueue;
    for (let i = 0; i < nq.length && i < 7; i++) H.w(nq[i].type);
    const gq = g.garbageQueue || [];
    for (let i = 0; i < gq.length; i++) H.w(gq[i].amount * 2 + (gq[i].ready ? 1 : 0));
    // ZONE（tet/zone.js）。ZONE の無いモードでは何も足さない（古い録画のハッシュを変えない）
    if (g.zoneEnabled) {
        H.w(g.zoneMeter);
        H.w(g.zoneActive ? 1 : 0);
        H.w(g.zoneLines);
        H.w(g.zoneScorePool);
        H.w(g.zoneLinesTotal);
        let nz = 0;
        for (let i = 0; i < bs.length; i++) if (bs[i].zone) nz++;
        H.w(nz);
    }
    H.w(Math.round((g.clock.now() - t0) * 16));
    return H.get();
}

// puyo: 次のぷよを出す直前（連鎖・おじゃまが落ち切った後）。盤面・得点・最大連鎖・NEXT 3 組・おじゃまの予約・時刻
function replayPuyoHash(g, t0) {
    const H = replayHasher();
    H.w(replaySide(g));
    const f = g.field;
    for (let r = 0; r < f.length; r++) {
        let v = 0;
        for (let c = 0; c < f[r].length; c++) v = v * 8 + (f[r][c] | 0);
        H.w(v);
    }
    H.w(g.score);
    H.w(g.chainMax);
    const nq = g.nextQueue;
    for (let i = 0; i < nq.length && i < 3; i++) H.w(nq[i][0] * 8 + nq[i][1]);
    const gq = g.garbageQueue || [];
    for (let i = 0; i < gq.length; i++) H.w(gq[i].amount * 2 + (gq[i].ready ? 1 : 0));
    H.w(Math.round((g.clock.now() - t0) * 16));
    return H.get();
}

function replayHash(g, t0) {
    return replayRule(g) === 'tet' ? replayTetHash(g, t0) : replayPuyoHash(g, t0);
}

// 盤面の設定を写す（Infinity は JSON に入らないので文字列にする）
function replayEnv(g) {
    const env = {};
    for (const k of REPLAY_ENV_FIELDS[replayRule(g)]) {
        const v = g[k];
        if (v === undefined) continue;
        env[k] = (v === Infinity) ? 'Infinity' : v;
    }
    return env;
}

function replayApplyEnv(g, env, rule) {
    for (const k of REPLAY_ENV_FIELDS[rule]) {
        if (!(k in env)) { delete g[k]; continue; }
        const v = env[k];
        g[k] = (v === 'Infinity') ? Infinity : v;
    }
}

// ─── CPU の思考（Worker の返事）を、再生中に読める短い形へ写す ───
// 返事はどの CPU も数の配列で、並びは CPU ごとに違う。長さが CPU ごとに決まっているので、ルールと長さで見分ける。
//   puyo  7: LV1〜3（[0]列 [1]回転 [2]評価。cpu_worker1〜3）
//        31: LV4 / 36: LV5・LV6（build.cpp の outResult。[0]列 [1]回転 [14]到達連鎖の点 [15]撃った段数(0=撃たず)
//            [20]到達連鎖の段数 [23]撃った理由 [24]今置くとこぼれる段数 [25]到達の深さ(-1=届かない)）
//   tet  12: LV2 / 26: LV3 / 43: LV4〜6（[0]1=HOLD -1=手なし [1]評価 [3]ミノ [4]向き [5]x [12]T-spin(26・43 だけ)）
//       160: LV7 / 96: CLYS（[0]1=手あり [1]ミノ [2..9]4マスの x,y [10]HOLD [15]評価(LV7) [16]T-spin(LV7。2=mini)）
// 写した形は { k: 'puyo' | 'tet', … }。分からない形は null（記録しない・出さない）。
// 録画（ReplayRecorder.think）と、M6c の録画に入っている生の配列の再生（ReplayPlayer）の両方で使う。
const REPLAY_PUYO_FIRE_WHY = ['', '目標到達', '緊急', '緊急延命', '催促', '地形優先の対応', '倒せるので撃つ',
    '危険で反撃', '危険で相殺', '危険で軽減', '撃たないと埋まる'];
const REPLAY_DIR = ['上', '右', '下', '左'];   // puyo の子ぷよの向き・tet のミノの向き（どちらも 0:上 1:右 2:下 3:左）
const REPLAY_TET_MINO = 'IOTJLSZ';             // Mino の type の順（core/base.js）

function replayThinkPick(rule, res) {
    if (!res || !(Array.isArray(res) || ArrayBuffer.isView(res))) return null;
    const n = res.length;
    const v = (i) => { const x = res[i]; return (typeof x === 'number' && isFinite(x)) ? Math.trunc(x) : 0; };
    if (rule === 'puyo' && (n === 7 || n === 31 || n === 36)) {
        if (v(0) < 0) return { k: 'puyo', none: 1 };
        const o = { k: 'puyo', col: v(0), rot: v(1) & 3 };
        if (n === 7) { o.ev = v(2); return o; }
        o.fire = v(15); o.score = v(14); o.chain = v(20); o.why = v(23); o.spill = v(24); o.depth = v(25);
        return o;
    }
    if (rule === 'tet' && (n === 12 || n === 26 || n === 43)) {
        const id = v(3);
        if (v(0) === -1 || id < 0 || id > 6) return { k: 'tet', none: 1 };
        const o = { k: 'tet', mino: id, rot: v(4) & 3, ev: v(1) };
        const cols = replayTetCols(id, o.rot, v(5));
        if (cols) o.cols = cols;
        if (v(0) === 1) o.hold = 1;
        if (n > 12 && v(12) > 0) o.spin = 1;
        return o;
    }
    if (rule === 'tet' && (n === 160 || n === 96)) {
        const id = v(1);
        if (v(0) !== 1 || id < 0 || id > 6) return { k: 'tet', none: 1 };
        const xs = [v(2), v(4), v(6), v(8)];
        const o = { k: 'tet', mino: id, cols: [Math.min(...xs), Math.max(...xs)] };
        if (v(10) === 1) o.hold = 1;
        if (n === 160) {
            o.ev = v(15);
            if (v(16) > 0) o.spin = v(16);
        }
        return o;
    }
    return null;
}

// tet LV2〜6 の置き方（向き・x）が埋める列の範囲（lv7 の _findPose と同じく Mino を向きの数だけ回す）
function replayTetCols(id, rot, x) {
    try {
        const m = new Mino(id);
        for (let i = 0; i < rot; i++) m.rotate();
        let lo = Infinity, hi = -Infinity;
        for (const b of m.blocks) { lo = Math.min(lo, b.x + x); hi = Math.max(hi, b.x + x); }
        return isFinite(lo) ? [lo, hi] : null;
    } catch (e) { return null; }
}

// 写した思考を 1 行の言葉にする（分からない形は ''）
function replayThinkText(p) {
    if (!p || typeof p !== 'object') return '';
    if (p.k === 'puyo') {
        if (p.none) return '置ける手なし';
        const at = `${p.col + 1}列（子が${REPLAY_DIR[p.rot & 3]}）`;
        if (p.ev !== undefined) return `${at}｜評価 ${p.ev}`;
        if (p.fire > 0) {
            const why = REPLAY_PUYO_FIRE_WHY[p.why] || '';
            return `${at}｜発火 ${p.fire}連鎖 ${p.score}点` + (why ? `（${why}）` : '');
        }
        if (p.spill > 0) return `${at}｜整地 ${p.spill}連鎖`;
        if (p.depth < 0) return `${at}｜育成（連鎖の見込みなし）`;
        return `${at}｜育成 見込み ${p.chain}連鎖 ${p.score}点`;
    }
    if (p.k === 'tet') {
        if (p.none) return '置ける手なし';
        let s = REPLAY_TET_MINO[p.mino] || '?';
        if (p.cols) s += ' ' + (p.cols[0] === p.cols[1] ? `${p.cols[0] + 1}列` : `${p.cols[0] + 1}〜${p.cols[1] + 1}列`);
        if (p.rot !== undefined) s += ` 向き${REPLAY_DIR[p.rot & 3]}`;
        if (p.hold) s += '（HOLD）';
        if (p.spin) s += p.spin === 2 ? ' T-SPIN MINI' : ' T-SPIN';
        if (p.ev !== undefined) s += `｜評価 ${p.ev}`;
        return s;
    }
    return '';
}

function replayFmtTime(ms) {
    ms = Math.max(0, ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// ─── 録画（1 試合ぶん）───
// spec: { mode, modeOption, games: [1P, 2P?], players: [{ name, kind, cpu }] }
class ReplayRecorder {
    constructor(spec) {
        const games = spec.games;
        const g0 = games[0];
        this.mode = spec.mode;
        this.modeOption = spec.modeOption || null;
        this.games = games;
        this.clock = g0.clock;
        this.loop = g0.loop;
        this.seed = GameRng.toHex(g0.matchSeed);
        this.t0 = this.clock.now();
        // VERSUS: 試合の初期化で入れた時計の予約（マージンタイム）の残り。再生はこれを残して始める（GameClock.rebase）
        this.timers = (this.mode === 'versus') ? this.clock._timers.map((h) => h.due - this.t0) : null;
        this.players = games.map((g, i) => Object.assign({
            name: 'PLAYER', kind: 'human',
        }, (spec.players && spec.players[i]) || {}, {
            side: replaySide(g), rule: replayRule(g), env: replayEnv(g), config: null,
        }));
        this.configs = [];
        this.dts = new ReplayBuf(16384);
        this.events = new ReplayBuf(4096);
        this.checks = new ReplayBuf(1024);
        this.codes = [];
        this._codeIdx = new Map();
        this.nFrames = 0;   // 回ったフレームの数
        this.cur = 0;       // 今のフレームの番号
        this._lastEv = 0;
        this.locks = 0;
        this.thinks = [];   // [フレーム, side, 思考の結果の写し]
        this.marks = [];    // 自動の印（§8.1）
        this._th = replayMarkThresholds();
        this.clock._tape = this.dts;
        this.loop.recorder = this;
        for (const g of games) {
            g._rec = this;
            // VERSUS はキーを先に読んでいる（試合を始める前に setKeyEvent / _setKeyHandlers 済み）
            if (spec.keysReady && g._keysUsed) this.config(g, g._keysUsed, g._tuningUsed);
        }
    }

    // 試合の親ループの step の頭
    beginFrame() {
        this.cur = this.nFrames++;
    }

    _player(g) {
        const s = replaySide(g);
        for (const p of this.players) if (p.side === s) return p;
        return this.players[0];
    }

    _ev(frame, kind, g) {
        if (frame < this._lastEv) frame = this._lastEv; // フレームの中でポーズされたとき（起きない想定。起きればハッシュで分かる）
        this.events.varint(frame - this._lastEv);
        this._lastEv = frame;
        this.events.byte((kind << 1) | (replaySide(g) & 1));
    }

    _code(code) {
        let i = this._codeIdx.get(code);
        if (i === undefined) {
            i = this.codes.length;
            this.codes.push(code);
            this._codeIdx.set(code, i);
        }
        return i;
    }

    // フレームの頭で取り込んだ入力（tet: {pad, down, code|action, repeat}、puyo: {down, code, repeat}）
    input(g, ev) {
        if (ev.pad) {
            const i = REPLAY_PAD_ACTIONS.indexOf(ev.action);
            if (i < 0) return;
            this._ev(this.cur, REPLAY_EV_PAD | (ev.down ? 1 : 0), g);
            this.events.varint(i);
        } else {
            this._ev(this.cur, (ev.down ? 1 : 0) | (ev.repeat ? 2 : 0), g);
            this.events.varint(this._code(ev.code));
        }
    }

    // ポーズ・再開はフレームの間で起きるので、次のフレームの頭の出来事として残す
    pause(g, on) {
        this._ev(this.nFrames, on ? REPLAY_EV_PAUSE : REPLAY_EV_RESUME, g);
        if (on) this._mark(g, 'pause', 'PAUSE', 0);
    }

    // ─── 自動の印（§8.1）。t は試合の頭（t0）からの時刻 ───
    _mark(g, kind, label, value, t) {
        this.marks.push({ t: (t === undefined ? this.clock.now() : t) - this.t0, side: replaySide(g), kind, label, value });
    }

    // 攻撃（tet: 火力ライン、puyo: 連鎖で出たおじゃま。puyo は連鎖の始まりの時刻 t に置く）
    attack(g, label, value, t) {
        const th = replayRule(g) === 'tet' ? this._th.tetAttack : this._th.puyoAttack;
        if (value >= th) this._mark(g, 'attack', label, value, t);
    }

    // 被弾（tet: せり上がった段数、puyo: 降ったおじゃまの数）
    hit(g, value) {
        const th = replayRule(g) === 'tet' ? this._th.tetHit : this._th.puyoHit;
        if (value >= th) this._mark(g, 'hit', replayRule(g) === 'tet' ? `+${value} LINES` : `+${value} OJAMA`, value);
    }

    skipPoll(g) {
        this._ev(this.cur, REPLAY_EV_SKIP, g);
    }

    // キー設定・DAS を読んだ（最初の 1 回は盤面の設定、2 回目からは設定画面での保存）
    config(g, keys, tuning) {
        const k = {};
        for (const action in (keys || {})) k[action] = (keys[action].codes || []).slice();
        const idx = this.configs.length;
        this.configs.push({ keys: k, tuning: JSON.parse(JSON.stringify(tuning || {})) });
        const p = this._player(g);
        if (p.config === null) { p.config = idx; return; }
        this._ev(this.nFrames, REPLAY_EV_CONFIG, g);
        this.events.varint(idx);
    }

    cpu(g, type, args) {
        const t = REPLAY_CPU_ACTIONS.indexOf(type);
        if (t < 0) return;
        this._ev(this.cur, REPLAY_EV_CPU, g);
        this.events.varint(t);
        let n = args.length;
        while (n > 0 && args[n - 1] === undefined) n--;
        this.events.byte(n);
        for (let i = 0; i < n; i++) replayPutArg(this.events, args[i]);
    }

    // CPU の思考の結果（game.cpuThink。core/cpu_port.js）。読める形に写せたものだけ残す（replayThinkPick）
    think(g, res) {
        try {
            const t = replayThinkPick(this._player(g).rule, res);
            if (t) this.thinks.push([this.cur, replaySide(g), t]);
        } catch (e) { /* 写せない形は残さない */ }
    }

    // VERSUS のカウントダウンを始めた（versus.js。再生はここで runCountdown する）
    countdown(g) {
        this._ev(this.nFrames, REPLAY_EV_COUNTDOWN, g);
    }

    lock(g) {
        this.checks.u32(replayHash(g, this.t0));
        this.locks++;
    }

    detach() {
        if (this.clock._tape === this.dts) this.clock._tape = null;
        if (this.loop.recorder === this) this.loop.recorder = null;
        for (const g of this.games) if (g._rec === this) g._rec = null;
    }

    // ファイルの中身（§6.1）。loser: 負けた盤面（VERSUS）
    finish(g, isClear, extra) {
        const b = window.TETLABO_BUILD || {};
        this._mark(g, 'end', isClear ? 'CLEAR' : (this.mode === 'versus' ? 'K.O.' : 'GAME OVER'), 0);
        const events = this.marks.slice().sort((a, x) => a.t - x.t);
        const results = this.games.map((x) => {
            const r = { side: replaySide(x), score: x.score };
            if (replayRule(x) === 'tet') {
                r.lines = x.lines;
                r.level = x.level;
                r.timeMs = x.elapsedTime;
            } else {
                r.chainMax = x.chainMax;
                r.cleared = x.clearedPuyos;
                r.timeMs = x.elapsed;
            }
            return r;
        });
        return {
            format: 'tetlabo-replay',
            formatVersion: REPLAY_FORMAT_VERSION,
            engine: REPLAY_ENGINE_VERSION,
            app: b.app || '?',
            build: b.build || '?',
            id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
            recordedAt: new Date().toISOString(),
            seed: this.seed,
            mode: this.mode,
            modeOption: this.modeOption,
            settings: { configs: this.configs },
            players: this.players,
            t0: this.t0,
            timers: this.timers,
            durationMs: this.clock.now() - this.t0,
            frameCount: this.nFrames,
            result: Object.assign({
                clear: !!isClear,
                endedBy: replaySide(g),
                boards: results,
            }, extra || {}),
            clip: null,
            events,
            codes: this.codes.slice(),
            frames: replayToB64(this.dts.bytes()),
            inputs: replayToB64(this.events.bytes()),
            checks: replayToB64(this.checks.bytes()),
            think: this.thinks.length ? this.thinks : null,
        };
    }
}

// ─── 再生のモードごとの組み立て ───
//   boards(p): 盤面を用意して設定を入れる（[1P, 2P?]）。start(p): 最初から始める。end(p): 盤面を止める。
const ReplayModes = {
    // MARATHON / SPRINT / ULTRA、tet の CPU TEST
    tetSingle: {
        page: 'game',
        bgm(data) { return data.mode === 'test' ? 'test_bgm' : window.BgmManager.singleBgmKey(data.mode); },
        boards(p) {
            if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(false);
            if (!window._game || typeof window._game.initMainCanvas !== 'function') window._game = new Game();
            const g = window._game;
            if (window.GameManager && GameManager.setInstance) GameManager.setInstance('p1', g);
            g.currentMode = p.data.mode;
            g.isVersusMode = false;
            g.canvasPrefix = null;
            g.statsPrefix = null;
            g.rngSide = 0;
            g.tumoRng = null;
            g._labelsInitialized = false;
            g.initMainCanvas();
            g.initNextCanvas();
            g.initHoldCanvas();
            const evalArea = document.getElementById('eval-area');
            if (evalArea) evalArea.style.display = p.data.mode === 'test' ? 'block' : 'none';
            const ga = document.getElementById('test-garbage-area');
            if (ga) ga.style.display = 'none';
            if (typeof updateLinesGoalDisplay === 'function') updateLinesGoalDisplay(p.data.mode);
            return [g];
        },
        start(p) {
            const g = p.games[0];
            g.nextMatchSeed = p.seed.slice();
            g.start();
        },
        end(p) {
            const g = p.games[0];
            g.stopRenderLoop();
            if (g.timer) { clearInterval(g.timer); g.timer = null; }
            g._cancelLockTimer();
            g._cancelGarbageTimers();
            g.isPaused = true;
            g.isTimerRunning = false;
        },
    },

    // PUYO、puyo の CPU TEST
    puyoSingle: {
        page: 'game',
        bgm(data) { return data.mode === 'test' ? 'test_bgm' : window.BgmManager.singleBgmKey(data.mode); },
        boards(p) {
            if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(true);
            if (window._puyoGame && window._puyoGame.stop) window._puyoGame.stop();
            const g = new PuyoGame();
            window._puyoGame = g;
            if (window.GameManager && GameManager.setInstance) GameManager.setInstance('p1', g);
            g.currentMode = p.data.mode;
            g.isVersusMode = false;
            g.recordEligible = false;
            const evalArea = document.getElementById('eval-area');
            if (evalArea) evalArea.style.display = p.data.mode === 'test' ? 'block' : 'none';
            const ga = document.getElementById('test-garbage-area');
            if (ga) ga.style.display = 'none';
            return [g];
        },
        start(p) {
            const g = p.games[0];
            g.nextMatchSeed = p.seed.slice();
            g.start(); // 画像は起動時に読み込み済み（ReplayPlayer.ready で確かめる）なので initGame は同期で進む
        },
        end(p) {
            const g = p.games[0];
            g.stop();
        },
    },
};

// VERSUS（CPU TEST から始めた CPU 同士も）。versus.js の startVersusGame の盤面の用意と同じ順に組み立てる
// （ロード画面・CPU・ポーズキー・アシストは無し）。エンジンが見る versusPlayerRule / versusCpuRule と
// window._game / window._cpuGame も録画したときに合わせ、見終わったら戻す
ReplayModes.versus = {
    page: 'versus',
    bgm() { return 'versus_bgm'; },
    boards(p) {
        const pl = p.data.players;
        const rule = (side) => (pl.find((x) => x.side === side) || pl[side]).rule;
        const r0 = rule(0), r1 = rule(1);
        p._globals = { pr: versusPlayerRule, cr: versusCpuRule, game: window._game, cpuGame: window._cpuGame };
        versusPlayerRule = r0;
        versusCpuRule = r1;
        if (typeof _switchToVersusMixedLayout === 'function') _switchToVersusMixedLayout(r0, r1);
        const inst = (r, side) => {
            if (r === 'puyo') {
                const key = side ? '_puyoGameCpu' : '_puyoGamePlayer';
                return window[key] || (window[key] = new PuyoGame(side ? 'cpu' : 'player'));
            }
            const key = side ? '_tetGameCpu' : '_tetGamePlayer';
            return window[key] || (window[key] = new Game(side ? 'cpu' : 'player'));
        };
        const g0 = inst(r0, 0), g1 = inst(r1, 1);
        window._game = g0;
        window._cpuGame = g1;
        const clock = new GameClock();
        const loop = new MatchLoop();
        [g0, g1].forEach((g, side) => {
            if (g.loop && g.loop !== loop) g.loop.remove(g);
            g.loop = loop;
            g.clock = clock;
            g.cpuReset();
            g.rngSide = side;
            g.tumoRng = null;
            g.rng = null;
            g.currentMode = 'versus';
            g.marathonGoal = Infinity;
            g.isVersusMode = true;
            g.canvasPrefix = side ? 'cpu' : 'player';
            g.statsPrefix = side ? 'cpu' : 'player';
            g._labelsInitialized = false;
        });
        const name = (side) => (pl.find((x) => x.side === side) || {}).name || '';
        const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
        set('versus-cpu-level-display', name(1));
        set('versus-cpu-side-label', name(1));
        set('versus-player-side-label', name(0));
        return [g0, g1];
    },
    start(p) {
        const [g0, g1] = p.games;
        for (const g of p.games) {
            g.nextMatchSeed = p.seed.slice();
            g._versusFinishing = false;
        }
        for (const g of p.games) {
            if (g instanceof PuyoGame) {
                g.initGame(); // 画像は読み込み済み（ReplayPlayer.ready）なので同期で進む
            } else {
                g.initMainCanvas();
                g.initNextCanvas();
                g.initHoldCanvas();
                g._initGameState();
                if (g === g0 && !g.isCpuControlled) g.setKeyEvent();
                g.level = 2;
                g.updateStatsDisplay();
            }
        }
        for (const g of p.games) if (g instanceof PuyoGame) g.state = 'starting';
        ReplayManager.beginMatch({ games: [g0, g1] });
        for (const g of p.games) {
            if (g instanceof PuyoGame) g._startCountdownDas();
            else g.startRenderLoop();
        }
    },
    // 録画の REPLAY_EV_COUNTDOWN の所（versus.js の runCountdown と同じ）
    countdown(p) {
        const [g0, g1] = p.games;
        runCountdown('player-countdown-overlay', 'player-countdown-text', () => g0._startGameplay(), null, undefined, false, g0.clock);
        runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', () => g1._startGameplay(), null, undefined, true, g0.clock);
    },
    end(p) {
        for (const g of p.games) {
            if (g instanceof PuyoGame) {
                g._versusFinishing = false;
                g.stop();
            } else {
                ReplayModes.tetSingle.end({ games: [g] });
            }
        }
        const s = p._globals;
        if (s) {
            versusPlayerRule = s.pr;
            versusCpuRule = s.cr;
            window._game = s.game;
            window._cpuGame = s.cpuGame;
            p._globals = null;
        }
    },
};

function replayModeOf(data) {
    if (REPLAY_TET_SINGLE.indexOf(data.mode) >= 0) return ReplayModes.tetSingle;
    if (data.mode === 'puyo') return ReplayModes.puyoSingle;
    if (data.mode === 'test') return (data.players[0].rule === 'tet') ? ReplayModes.tetSingle : ReplayModes.puyoSingle;
    if (data.mode === 'versus' && ReplayModes.versus) return ReplayModes.versus;
    return null;
}

// ─── スナップショット（M7a。§5.3）───
//   再生中に数秒ごと、盤面の状態（Game / PuyoGame の持ち物）・時計（時刻と予約）・ループの顔ぶれ・
//   読んでいる位置をメモリに写す。巻き戻し・1 手戻るは「直前のスナップショットに戻して早送り」。
//   写すのは盤面の中身だけ: DOM・canvas・時計・ループ・Worker などは同じものを指したまま、
//   配列・Map・Set・クラスのオブジェクト（Mino・Field・乱数）は中身ごと写す（同じものを指す所は同じまま）。
//   予約の中身（cb）は関数をそのまま使う（盤面の this を指すので、同じ盤面に戻せば同じに動く）。
//   盤面から指されていない予約（カウントダウン・START! を消す）がある間は取らない。
//   戻した後もハッシュを照らし合わせるので、写し漏れがあればずれとして分かる（そのときは最初からに戻す）。
// 画面の持ち物（DOM のやりくり・描画のキャッシュ・キーの受け口）は写さず、戻すときも触らない
const REPLAY_SNAP_LIVE = new Set([
    '_replay', '_rec', 'clock', 'loop',
    '_keyDownHandler', '_keyUpHandler', '_keyHandlerDown', '_keyHandlerUp', '_gpConnectedHandler', '_gpDisconnectedHandler', '_gamepadLoop',
    'labelElements', 'labelTimers', 'labelLayout', '_gridCache',
    'yokokuContainer', '_yokokuPool', '_yokokuMounted', '_yokokuRow1', '_yokokuRow2', '_lastYokokuAmount',
    '_chainTextEl', '_chainNumEl', '_images', '_ciBuf', '_ghostSig', '_ghostVField', '_ghostEraseCache',
]);

function replaySnapKeep(v, keep) {
    return keep.has(v)
        || (typeof EventTarget !== 'undefined' && v instanceof EventTarget)   // DOM・canvas・Image・Worker・window
        || (typeof CanvasRenderingContext2D !== 'undefined' && v instanceof CanvasRenderingContext2D)
        || (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap)
        || v instanceof GameClock || v instanceof MatchLoop || v instanceof ReplayPlayer || v instanceof ReplayRecorder
        || v instanceof Promise || v instanceof WeakMap || v instanceof WeakSet;
}

function replayClone(v, memo, keep) {
    if (v === null || typeof v !== 'object') return v; // 数・文字・真偽・関数はそのまま
    const hit = memo.get(v);
    if (hit !== undefined) return hit;
    if (replaySnapKeep(v, keep)) return v;
    let c;
    if (ArrayBuffer.isView(v)) {
        c = v.slice();
        memo.set(v, c);
    } else if (Array.isArray(v)) {
        c = new Array(v.length);
        memo.set(v, c);
        for (let i = 0; i < v.length; i++) c[i] = replayClone(v[i], memo, keep);
    } else if (v instanceof Map) {
        c = new Map();
        memo.set(v, c);
        v.forEach((x, k) => c.set(replayClone(k, memo, keep), replayClone(x, memo, keep)));
    } else if (v instanceof Set) {
        c = new Set();
        memo.set(v, c);
        v.forEach((x) => c.add(replayClone(x, memo, keep)));
    } else {
        c = Object.create(Object.getPrototypeOf(v));
        memo.set(v, c);
        for (const k of Object.keys(v)) c[k] = replayClone(v[k], memo, keep);
    }
    return c;
}

// 盤面の持ち物を写す（画面の持ち物は除く）
// 乱数の列（core/game_rng.js）は関数なので同じものを指したまま、中の状態（next.state）だけ別に写す
function replaySnapGame(g, memo, keep) {
    const o = {};
    for (const k of Object.keys(g)) if (!REPLAY_SNAP_LIVE.has(k)) o[k] = replayClone(g[k], memo, keep);
    const rng = g._rng;
    return { o, rng: rng ? Object.keys(rng).map((k) => [rng[k], rng[k] && rng[k].state ? rng[k].state.slice() : null]) : [] };
}

// 写したものを盤面へ戻す（写したものは何度でも使えるよう、もう一度写して入れる）
function replayRestoreGame(g, s, memo, keep) {
    const o = s.o;
    for (const k of Object.keys(g)) if (!(k in o) && !REPLAY_SNAP_LIVE.has(k)) delete g[k];
    for (const k of Object.keys(o)) g[k] = replayClone(o[k], memo, keep);
    for (const [fn, st] of s.rng) if (st && fn.state) fn.state.set(st);
}

// 盤面の外に字だけで持っている表示（puyo の連鎖数・最大連鎖・タイムは出来事のときにしか書き換えない）
function replayHudEls(g) {
    return replayRule(g) === 'puyo' ? [g.scoreEl, g.linesEl, g.levelEl, g.timeEl] : [];
}

// 戻した後に画面を盤面に合わせる（ふだんはゲームの進行に合わせて書き換えている所）
function replayRefreshGame(g) {
    if (replayRule(g) === 'tet') {
        if (g.field && g.field.markDirty) g.field.markDirty();
        g._needsRedraw = true;
        if (g.updateStatsDisplay) g.updateStatsDisplay();
        if (g.updateTimeDisplay) g.updateTimeDisplay();
    } else {
        g._ghostSig = NaN;
        g._ghostEraseCache = null;
        if (g._updateScoreDisplay) g._updateScoreDisplay();
        g._lastYokokuAmount = -1;
        if (g._updateOjamaYokoku) g._updateOjamaYokoku();
        if (!g.chainTextInfo && g._clearChainTextDOM) g._clearChainTextDOM();
    }
}

// ─── 再生（1 本のリプレイ）───
class ReplayPlayer {
    constructor(data) {
        if (!data || data.format !== 'tetlabo-replay') throw new Error('リプレイのファイルではありません');
        if (data.formatVersion > REPLAY_FORMAT_VERSION) throw new Error('新しい版で作られたリプレイです');
        if (data.formatVersion < 2) throw new Error('古い形のリプレイです（M5 の試作）');
        this.mode = replayModeOf(data);
        if (!this.mode) throw new Error('このモードのリプレイはまだ再生できません: ' + data.mode);
        this.data = data;
        this.seed = GameRng.fromHex(data.seed);
        this.t0 = data.t0;
        this.duration = data.durationMs || 0;
        this.codes = data.codes || [];
        // キー設定（loadKeys と同じ形）
        this.configs = ((data.settings && data.settings.configs) || []).map((c) => {
            const keys = {};
            for (const action in c.keys) keys[action] = { codes: c.keys[action].slice(), code: c.keys[action][0] || '', label: '' };
            return { keys, tuning: c.tuning || {} };
        });
        this.dtBytes = replayFromB64(data.frames);
        // 入力の列をほどいておく
        const r = new ReplayReader(replayFromB64(data.inputs));
        const evs = [];
        let f = 0;
        while (!r.done) {
            f += r.varint();
            const ks = r.byte();
            const k = ks >> 1;
            const ev = { f, k, side: ks & 1, idx: 0, args: null };
            if (k < REPLAY_EV_PAUSE || k === REPLAY_EV_CONFIG) ev.idx = r.varint();
            else if (k === REPLAY_EV_CPU) {
                ev.idx = r.varint();
                const n = r.byte();
                ev.args = [];
                for (let i = 0; i < n; i++) ev.args.push(replayGetArg(r));
            }
            ev.end = r.p; // この出来事の終わりのバイト位置（切り出しで前だけ残すため）
            evs.push(ev);
        }
        this.evs = evs;
        const cb = replayFromB64(data.checks);
        this.checks = [];
        for (let i = 0; i + 3 < cb.length; i += 4) this.checks.push((cb[i] | (cb[i + 1] << 8) | (cb[i + 2] << 16) | (cb[i + 3] << 24)) >>> 0);
        // CPU の思考は先に言葉にしておく: [フレーム, side, 文]。壊れたもの・分からない形は捨てる
        // （M6c の録画は生の配列のまま。tet LV4〜7・CLYS の返事は写せず null で残っている）
        const rules = {};
        for (const pl of data.players || []) rules[pl.side] = pl.rule;
        this.thinks = [];
        for (const e of (Array.isArray(data.think) ? data.think : [])) {
            if (!Array.isArray(e) || typeof e[0] !== 'number' || !e[2] || typeof e[2] !== 'object') continue;
            let text = '';
            try { text = replayThinkText(Array.isArray(e[2]) ? replayThinkPick(rules[e[1]], e[2]) : e[2]); } catch (err) { /* 出さない */ }
            if (text) this.thinks.push([e[0], e[1], text]);
        }

        this.games = [];
        this.loop = null;
        this.speed = 1;
        this.state = 'pause';     // play / pause / seek / end / desync
        this.watching = false;    // 画面に出して見ている（verify は false）
        this.onUi = null;
        this._saved = null;
        // スナップショット（M7a）: snaps[k] は時刻 k × snapEvery を最初に過ぎたフレームの終わり。
        // 一度通った所の分だけできる（決定的なので最初からやり直しても同じ）。最大 300 個ほど
        this.snaps = [];
        this.snapEvery = Math.max(3000, Math.ceil(this.duration / 300));
        this.snapOn = false;      // 画面で見るとき（と開発用の確かめ）だけ取る
        this.lockLog = [];        // 設置ごとの { f: そのフレームの番号, side }（通った所の分）
        // 切り出し（M7b）: fromMs から見る。cut のときは録画の終わり（frameCount）で止める（試合は終わっていない）
        const clip = data.clip && typeof data.clip.fromMs === 'number' ? data.clip : null;
        this.clipFrom = clip ? Math.max(0, Math.min(this.duration, clip.fromMs)) : 0;
        this.clipCut = !!(clip && !clip.full);
        this.clipStartFrame = 0;
        this._resetCounters();
    }

    get page() {
        return this.mode.page;
    }

    // すぐに始められるか（puyo の画像の読み込み待ち）
    ready(cb) {
        const needPuyo = this.data.players.some((p) => p.rule === 'puyo');
        if (needPuyo && !PuyoGame._sharedImagesLoaded) PuyoGame.preloadImages(cb);
        else cb();
    }

    _resetCounters() {
        this.nFrames = 0;
        this.ep = 0;
        this.checkIdx = 0;
        this.ended = false;
        this.desynced = false;
        this.desyncInfo = null;
        this.playTime = 0;
        this.seekTarget = 0;
        this.seekResume = 'pause';
        this.seekFrame = -1;      // >=0: このフレームまで進める（1 手戻る・進むで設置の所がわかっているとき）
        this.seekLockSide = -1;   // >=0: この side の次の設置まで進める（まだ通っていない所へ 1 手進む）
        this._lockHit = false;
        this._fromSnap = false;   // 最初からやり直した後にスナップショットへ戻したか（ずれたら最初からに戻す）
        this._lastReal = null;
        this._cfg = [null, null];
        this._skip = [false, false];
        this._cpuQ = [[], []];
        for (const p of this.data.players) this._cfg[p.side] = this.configs[p.config] || { keys: {}, tuning: {} };
    }

    _gameOf(side) {
        for (const g of this.games) if (replaySide(g) === side) return g;
        return null;
    }

    // 盤面を用意して録画したときの設定にする（見終わったら restore で戻す）
    prepare() {
        const games = this.mode.boards(this);
        this.games = games;
        this.loop = games[0].loop;
        this._saved = games.map((g) => ({ g, env: replayEnv(g) }));
        for (const p of this.data.players) {
            const g = this._gameOf(p.side) || games[0];
            replayApplyEnv(g, p.env || {}, p.rule);
        }
    }

    restore() {
        if (!this._saved) return;
        for (const s of this._saved) replayApplyEnv(s.g, s.env, replayRule(s.g));
        this._saved = null;
    }

    // 最初から（同じシード・同じ設定で始める。時計と入力は attach で録画に合わせる）
    restart() {
        const clock = this.games[0].clock;
        // 前の回の予約（カウントダウンの途中など）を捨て、始める前の advance() が古い列を読まないようにする
        clock.reset(clock.now());
        clock._feed = null;
        this._resetCounters();
        for (const g of this.games) {
            g._replay = this;
            g._rec = null;
        }
        this.loop.driver = this;
        this.mode.start(this);
        // 切り出し: 始まりまで描かずに進める
        if (this.clipFrom > 0) {
            this._withSe(true, () => {
                while (!this.ended && !this.desynced && this.time() < this.clipFrom) this.step(false);
            });
        }
        this.clipStartFrame = this.nFrames;
    }

    // 試合を始めたところ（シングルは乱数を作った直後、VERSUS は両盤面の初期化の後）から呼ばれる
    attach() {
        const clock = this.games[0].clock;
        // VERSUS は両盤面の初期化で入れたマージンタイムの予約を残す（録画でも残っている。捨てるとレートが変わらずずれる）
        if (this.data.mode === 'versus') clock.rebase(this.t0, this.data.timers);
        else clock.reset(this.t0);
        clock._tape = null;
        clock._feed = new ReplayReader(this.dtBytes);
        if (this.loop.recorder) this.loop.recorder = null;
    }

    time() {
        return this.games[0].clock.now() - this.t0;
    }

    // 今のフレームまでで一番新しい CPU の思考の文（side ごと。無ければ ''）
    thinkAt(side) {
        const th = this.thinks;
        let lo = 0, hi = th.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (th[mid][0] < this.nFrames) { lo = mid + 1; } else { hi = mid - 1; }
        }
        for (let i = hi; i >= 0; i--) if (th[i][1] === side) return th[i][2];
        return '';
    }

    // ─── エンジンから呼ばれる ───
    configFor(g) {
        return this._cfg[replaySide(g)] || { keys: {}, tuning: {} };
    }

    skipFor(g) {
        return this._skip[replaySide(g)];
    }

    // _runCpu の所: このフレームのこの盤面の CPU の手を流す
    runCpu(g) {
        const q = this._cpuQ[replaySide(g)];
        if (!q.length) return;
        g._cpuRunning = true;
        try {
            for (let i = 0; i < q.length; i++) g.cpuAction(REPLAY_CPU_ACTIONS[q[i].idx], ...q[i].args);
        } finally {
            g._cpuRunning = false;
        }
        q.length = 0;
    }

    onLock(g) {
        if (this.desynced) return;
        const i = this.checkIdx++;
        if (i >= this.checks.length || replayHash(g, this.t0) !== this.checks[i]) {
            this._desync(i >= this.checks.length ? '記録より設置が多い' : `${i + 1} 手目の盤面が合わない`, i);
            return;
        }
        const side = replaySide(g);
        if (!this.lockLog[i]) this.lockLog[i] = { f: this.nFrames, side };
        if (side === this.seekLockSide) this._lockHit = true;
    }

    onGameOver(g, isClear) {
        if (this.desynced || this.ended) return;
        this.ended = true;
        const r = this.data.result || {};
        const rb = (r.boards || []).find((b) => b.side === replaySide(g));
        if (this.checkIdx !== this.checks.length) {
            this._desync(`設置の数が合わない（録画 ${this.checks.length}・再生 ${this.checkIdx}）`, this.checkIdx);
        } else if (r.endedBy !== replaySide(g) || !!r.clear !== !!isClear || (rb && rb.score !== g.score)) {
            this._desync('結果が合わない', this.checkIdx);
        }
    }

    _desync(reason, lockIdx) {
        this.desynced = true;
        // スナップショットから戻した後のずれは写し漏れ（録画は正しい）: スナップショットをやめて最初からやり直す（onFrame）
        if (this._fromSnap && this.watching) {
            console.warn('[replay] スナップショットから戻した後にずれました。最初からやり直します:', reason);
            this._recover = { ms: this.state === 'seek' ? Math.max(this.time(), this.seekTarget) : this.time(), resume:this.state === 'seek' ? this.seekResume : (this.state === 'play' ? 'play' : 'pause') };
            return;
        }
        this.desyncInfo = { reason, lock: lockIdx, timeMs: this.time(), frame: this.nFrames };
        this.state = 'desync'; // 盤面はそこで止める（driver がフレームを進めない）
        if (this.onUi) this.onUi();
    }

    _applyEvent(ev) {
        const g = this._gameOf(ev.side);
        if (!g) return;
        const k = ev.k;
        if (k < REPLAY_EV_PAD) {
            const e = { down: !!(k & 1), code: this.codes[ev.idx], repeat: !!(k & 2) };
            if (replayRule(g) === 'tet') e.pad = false;
            g._inputQueue.push(e);
        } else if (k < REPLAY_EV_PAUSE) g._inputQueue.push({ pad: true, down: !!(k & 1), action: REPLAY_PAD_ACTIONS[ev.idx] });
        else if (k === REPLAY_EV_PAUSE) g.pause();
        else if (k === REPLAY_EV_RESUME) g.resume();
        else if (k === REPLAY_EV_SKIP) this._skip[ev.side] = true;
        else if (k === REPLAY_EV_CONFIG) {
            this._cfg[ev.side] = this.configs[ev.idx] || this._cfg[ev.side];
            if (replayRule(g) === 'tet') g.setKeyEvent();
            else g._setKeyHandlers();
        } else if (k === REPLAY_EV_CPU) this._cpuQ[ev.side].push(ev);
        else if (k === REPLAY_EV_COUNTDOWN && this.mode.countdown) this.mode.countdown(this);
    }

    _isPre(k) {
        return k === REPLAY_EV_PAUSE || k === REPLAY_EV_RESUME || k === REPLAY_EV_CONFIG || k === REPLAY_EV_COUNTDOWN;
    }

    // 1 フレーム進める。ポーズ・再開・設定の読み直しはフレームの頭（時計を進める前）、
    // 入力は _inputQueue へ（人のキーがたまっているのと同じ状態にする）、CPU の手は _runCpu の所で
    step(draw) {
        const f = this.nFrames;
        const evs = this.evs;
        while (this.ep < evs.length && evs[this.ep].f === f && this._isPre(evs[this.ep].k)) this._applyEvent(evs[this.ep++]);
        let alive = false;
        for (const g of this.games) if (this.loop.has(g)) { alive = true; break; }
        if (!alive) { this.ended = true; return; } // 盤面がループから抜けた（ゲームオーバー以外で終わった）
        if (this.clipCut && f >= this.data.frameCount) { this.ended = true; return; } // 切り出しの終わり
        this.nFrames++;
        this._skip[0] = this._skip[1] = false;
        while (this.ep < evs.length && evs[this.ep].f <= f) this._applyEvent(evs[this.ep++]);
        this.loop.step(draw);
        this._cpuQ[0].length = this._cpuQ[1].length = 0;
        if (!this.ended && !this.desynced && this.nFrames > (this.data.frameCount || 0) + 600) {
            this._desync('記録したフレームを過ぎても終わらない');
        }
        if (this.snapOn && !this.ended && !this.desynced) {
            const k = Math.floor(this.time() / this.snapEvery);
            if (k >= 1 && !this.snaps[k]) {
                const s = this._takeSnap();
                if (s) this.snaps[k] = s;
            }
        }
    }

    // ─── スナップショット（M7a）───
    // 今のフレームの終わりを写す。盤面の外の予約がある間（カウントダウン中など）は null
    _takeSnap() {
        const loop = this.loop;
        if (loop._pending.length || loop._ticking) return null;
        const clock = this.games[0].clock;
        const memo = new Map();
        const keep = new Set(this.games);
        const games = this.games.map((g) => replaySnapGame(g, memo, keep));
        for (const h of clock._timers) if (!memo.has(h)) return null;
        return {
            f: this.nFrames,
            t: this.time(),
            ep: this.ep,
            checkIdx: this.checkIdx,
            feedP: clock._feed ? clock._feed.p : 0,
            cfg: this._cfg.slice(),
            clock: { t: clock._t, seq: clock._seq, paused: clock._paused, timers: clock._timers.map((h) => memo.get(h)) },
            games,
            hud: this.games.map((g) => replayHudEls(g).map((el) => (el ? el.textContent : null))),
            members: loop._members.map((m) => Object.assign({}, m)),
        };
    }

    _restoreSnap(s) {
        const memo = new Map();
        const keep = new Set(this.games);
        this.games.forEach((g, i) => replayRestoreGame(g, s.games[i], memo, keep));
        const clock = this.games[0].clock;
        const timers = s.clock.timers.map((h) => replayClone(h, memo, keep));
        // VERSUS のおじゃまの猶予の予約は cb が元のエントリ・おじゃまを掴んでいるので、写しを見るものに作り直す
        const bg = window.BattleGarbage;
        if (bg && bg.rebindLocalGarbageTimers) for (const g of this.games) bg.rebindLocalGarbageTimers(g);
        for (const h of clock._timers) if (timers.indexOf(h) < 0) h.cb = null;
        clock._timers.length = 0;
        for (const h of timers) clock._timers.push(h);
        clock._t = s.clock.t;
        clock._seq = s.clock.seq;
        clock._paused = s.clock.paused;
        clock._advancing = false;
        clock._tape = null;
        clock._feed = new ReplayReader(this.dtBytes);
        clock._feed.p = s.feedP;
        const loop = this.loop;
        loop._members = s.members.map((m) => Object.assign({}, m));
        loop._pending.length = 0;
        loop._needsCompact = false;
        if (loop._members.length && loop._rafId === null && !loop._ticking) loop._rafId = requestAnimationFrame(loop._tick);
        this._resetCounters();
        this.nFrames = s.f;
        this.ep = s.ep;
        this.checkIdx = s.checkIdx;
        this._cfg = s.cfg.slice();
        this._fromSnap = true;
        this._hideCountdown();
        this.games.forEach((g, i) => {
            replayRefreshGame(g);
            replayHudEls(g).forEach((el, j) => { if (el && s.hud[i][j] !== null) el.textContent = s.hud[i][j]; });
        });
    }

    _hideCountdown() {
        for (const id of ['countdown-overlay', 'player-countdown-overlay', 'cpu-countdown-overlay']) {
            const ov = document.getElementById(id);
            if (ov && typeof cancelCountdownTimer === 'function') {
                cancelCountdownTimer(ov);
                ov.classList.remove('active');
            }
        }
    }

    // 一番新しい「ok(s) を満たすスナップショット」
    _snapBefore(ok) {
        for (let k = this.snaps.length - 1; k >= 1; k--) {
            const s = this.snaps[k];
            if (s && ok(s)) return s;
        }
        return null;
    }

    // 向かう所の手前まで一気に戻る/飛ぶ。back: 今より前へ戻る必要がある。ok: 使えるスナップショットか
    _jump(back, ok) {
        const s = this._snapBefore(ok);
        const ahead = s && !this.ended && !this.desynced && s.f > this.nFrames; // 今より先のスナップショットへ飛べる
        if (s && (back || this.ended || this.desynced || ahead)) {
            this._withSe(true, () => this._restoreSnap(s));
        } else if (back || this.ended || this.desynced) {
            this._withSe(true, () => this.restart());
        }
    }

    _seekDone() {
        if (this.seekLockSide >= 0) return this._lockHit;
        if (this.seekFrame >= 0) return this.nFrames >= this.seekFrame;
        return this.time() >= this.seekTarget;
    }

    // SE を止めて fn を実行（2 倍より速いとき・シーク中）
    _withSe(mute, fn) {
        const se = window.SeManager;
        const prev = se ? se._muted : false;
        if (mute && se) se._muted = true;
        try {
            fn();
        } finally {
            if (se) se._muted = prev;
        }
    }

    // 最後まで描かずに進める（照らし合わせ）
    runToEnd() {
        const limit = (this.data.frameCount || 0) + 1000;
        let n = 0;
        this._withSe(true, () => {
            this.restart();
            while (!this.ended && !this.desynced && n < limit) { this.step(false); n++; }
        });
    }

    // ─── 画面で見るとき（試合の親ループの driver。rAF ごとに呼ばれる）───
    onFrame(loop) {
        const now = performance.now();
        const realDt = (this._lastReal === null) ? 0 : Math.min(100, now - this._lastReal);
        this._lastReal = now;
        if (this._recover) this._recoverFromSnap();
        if (this.state === 'seek') {
            const until = now + 12; // 1 回の rAF で使う時間（その間も盤面は描く）
            this._withSe(true, () => {
                while (!this.ended && !this.desynced && !this._seekDone() && performance.now() < until) this.step(false);
            });
            if (this._recover) this._recoverFromSnap();
            else if (!this.desynced && (this.ended || this._seekDone())) this._seekFinish();
        } else if (this.state === 'play') {
            this.playTime += realDt * this.speed;
            let n = 0;
            this._withSe(this.speed > 2, () => {
                while (!this.ended && !this.desynced && this.time() < this.playTime && n < 5000) { this.step(false); n++; }
            });
            if (this._recover) this._recoverFromSnap();
            else if (this.ended && !this.desynced) this.state = 'end';
        }
        loop.drawOnly();
        // 操作バーの更新で何か起きても、再生は止めない（1 回だけ知らせる）
        if (this.onUi) {
            try { this.onUi(); } catch (e) {
                if (!this._uiErr) { this._uiErr = true; console.warn('[replay] 操作バーを更新できませんでした', e); }
            }
        }
    }

    play() {
        if (this.state === 'desync') return;
        if (this.state === 'end' || this.ended) this.restart();
        this.state = 'play';
        this._lastReal = null;
        this.playTime = this.time();
        if (this.onUi) this.onUi();
    }

    pause() {
        if (this.state === 'play') this.state = 'pause';
        else if (this.state === 'seek') this.seekResume = 'pause';
        if (this.onUi) this.onUi();
    }

    _resumeState() {
        return (this.state === 'seek') ? this.seekResume : (this.state === 'play' ? 'play' : 'pause');
    }

    _seekStart(resume) {
        this.seekResume = resume;
        this.state = 'seek';
        if (this.onUi) this.onUi();
    }

    _seekFinish() {
        this.state = this.ended ? 'end' : this.seekResume;
        this.playTime = this.time();
        this.seekFrame = -1;
        this.seekLockSide = -1;
        this._lockHit = false;
    }

    seek(ms) {
        ms = Math.max(this.clipFrom, Math.min(this.duration, ms));
        const resume = this._resumeState();
        this._jump(ms < this.time(), (s) => s.t <= ms);
        this.seekTarget = ms;
        this.seekFrame = -1;
        this.seekLockSide = -1;
        this._seekStart(resume);
    }

    // 1 手戻る/進む（dir = -1 / 1）。VERSUS は 1P の設置ごと。止めて見る
    stepLock(dir) {
        if (this.state === 'desync') return;
        const side = 0;
        const log = this.lockLog;
        // シーク中なら向かっている所から数える
        const cur = (this.state === 'seek' && this.seekFrame >= 0) ? this.seekFrame : this.nFrames;
        let target = -1;
        if (dir < 0) {
            for (let i = log.length - 1; i >= 0; i--) if (log[i] && log[i].side === side && log[i].f < cur && log[i].f >= this.clipStartFrame) { target = log[i].f; break; }
            if (target < 0) { this.seek(0); this.seekResume = 'pause'; return; }
        } else {
            for (let i = 0; i < log.length; i++) if (log[i] && log[i].side === side && log[i].f > cur) { target = log[i].f; break; }
            if (target < 0 && this.ended) return;
        }
        if (target >= 0) {
            this._jump(target < this.nFrames, (s) => s.f <= target);
            this.seekFrame = target;
            this.seekLockSide = -1;
        } else {
            // まだ通っていない所: 次の設置まで進める（シーク中ならその行き先まで先に進めておく）
            if (this.state === 'seek' && this.seekFrame >= 0) {
                this._withSe(true, () => { while (!this.ended && !this.desynced && this.nFrames < this.seekFrame) this.step(false); });
            }
            this.seekFrame = -1;
            this.seekLockSide = side;
            this._lockHit = false;
        }
        this.seekTarget = this.time();
        this._seekStart('pause');
    }

    // 切り出し（M7b。§8.2）: fromMs〜toMs を 1 本のリプレイにする。
    //   スナップショットは DOM や関数を指していてファイルに書けないので、録画の頭から toMs までをそのまま残し
    //   （時計の進み・入力・照合をその所で切る）、clip.fromMs から見る（頭から描かずに進める）。
    //   一度描かずに toMs まで進めて切る所（フレーム・読んだ位置）を確かめ、見ていた所へ戻る。
    makeClip(fromMs, toMs, label) {
        const data = this.data;
        fromMs = Math.max(this.clipFrom, Math.round(fromMs));
        toMs = Math.min(this.duration, Math.round(toMs));
        if (toMs - fromMs < 500 || this.state === 'desync') return null;
        const back = this.state === 'seek' ? this.seekTarget : this.time();
        const resume = this._resumeState() === 'play' ? 'play' : 'pause';
        let out = null;
        this._withSe(true, () => {
            this._jump(toMs < this.time() || this.ended, (s) => s.t <= toMs);
            while (!this.ended && !this.desynced && this.time() < toMs) this.step(false);
            if (this.desynced) return;
            const natural = this.ended && !this.clipCut; // 試合の終わりまで入る（切らない）
            const F = this.nFrames;
            const dur = natural ? data.durationMs : this.time();
            const inEnd = this.ep ? this.evs[this.ep - 1].end : 0;
            const clock = this.games[0].clock;
            out = Object.assign({}, data, {
                id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
                durationMs: dur,
                frameCount: natural ? data.frameCount : F,
                frames: natural ? data.frames : replayToB64(this.dtBytes.slice(0, clock._feed ? clock._feed.p : 0)),
                inputs: natural ? data.inputs : replayToB64(replayFromB64(data.inputs).slice(0, inEnd)),
                checks: natural ? data.checks : replayToB64(replayFromB64(data.checks).slice(0, this.checkIdx * 4)),
                think: Array.isArray(data.think) ? data.think.filter((e) => Array.isArray(e) && e[0] < F) : null,
                events: (data.events || []).filter((m) => m.t >= fromMs && m.t <= dur),
                clip: {
                    fromMs, toMs: dur, full: natural, label: label || '',
                    sourceId: data.clip ? data.clip.sourceId : data.id,
                    createdAt: new Date().toISOString(),
                },
            });
        });
        // 見ていた所へ戻る
        this.seek(back);
        this.seekResume = resume;
        return out;
    }

    // 局面から続きを遊ぶ（M7c。§10）: 1P の盤面を PRACTICE のスナップショット（practice_snapshot.js の 1 行）にする。
    //   PRACTICE の保存地点は「次のツモが出る直前」なので、操作中のミノ・ぷよは NEXT の頭へ戻す。
    //   puyo の連鎖・落下の途中は盤面が決まっていないので、次のぷよが出る所まで描かずに進める。
    //   乱数の列の状態も渡す（その先のツモも元の試合と同じになる）。
    practiceHandoff() {
        if (typeof PracticeSnapshot === 'undefined' || this.state === 'desync') return null;
        const g = this._gameOf(0) || this.games[0];
        const rule = replayRule(g);
        if (rule === 'puyo') {
            const busy = () => ['spawn', 'spawnAnim', 'falling'].indexOf(g._gs) < 0;
            if (busy() && !this.ended) {
                this._withSe(true, () => {
                    let n = 0;
                    while (!this.ended && !this.desynced && busy() && n < 20000) { this.step(false); n++; }
                });
                this.seekTarget = this.time();
                this.playTime = this.time();
            }
            if (busy()) return null;
        }
        if (this.ended && !this.clipCut) return null; // 試合の終わり（ゲームオーバー・クリア）からは遊べない
        const view = Object.create(g); // 盤面はそのまま、NEXT と HOLD だけ差し替えて写す
        if (rule === 'tet') {
            if (g.mino) view.nextQueue = [new Mino(g.mino.type)].concat(g.nextQueue);
            view.canHold = true;
        } else if (g._gs === 'falling') {
            view.nextQueue = [[g.pivotColor, g.childColor]].concat(g.nextQueue);
        }
        const rng = {};
        if (g._rng) for (const k of Object.keys(g._rng)) if (g._rng[k] && g._rng[k].state) rng[k] = Array.from(g._rng[k].state);
        return { rule, line: PracticeSnapshot.capture(view, rule, { tp: 0, tg: 0 }), rng };
    }

    // VERSUS の続き（M7d）: 今の局面のまま本物の対戦に切り替えられるか（両盤面とも本編の途中）
    canGoLive() {
        if (this.ended || this.desynced || this.state === 'desync') return false;
        return this.games.every((g) => (replayRule(g) === 'tet')
            ? (!!g._renderLoopId && !g.isCountingDown && !g.isPaused && !g.isFinishing && !!g.mino)
            : g.state === 'playing');
    }

    // 再生をやめて、盤面をそのまま本物の試合に渡す（盤面の設定・時計・ループ・おじゃまの予約・マージンはそのまま）。
    // 戻り値は再生の頭で入れ替えた VERSUS のルールと盤面の参照（試合が終わったら戻す）
    detachLive() {
        if (this.loop && this.loop.driver === this) this.loop.driver = null;
        const clock = this.games[0].clock;
        for (const g of this.games) {
            g._replay = null;
            g._rec = null;
            g.nextMatchSeed = null;
            g._inputQueue && (g._inputQueue.length = 0);
        }
        clock.endFeed(); // 実時間で進む時計に戻す
        const globals = this._globals;
        this._globals = null;
        this._saved = null;  // 盤面の設定（録画したときの VS 設定）は戻さずに続ける
        this.snaps = [];
        this.watching = false;
        this.state = 'pause';
        return globals;
    }

    // スナップショットから戻した後にずれた: スナップショットを捨てて、最初からその時刻まで進め直す
    _recoverFromSnap() {
        const r = this._recover;
        this._recover = null;
        this.snaps = [];
        this.snapOn = false;
        this._withSe(true, () => this.restart());
        this.seekTarget = r.ms;
        this._seekStart(r.resume);
    }

    setSpeed(s) {
        this.speed = s;
        if (this.onUi) this.onUi();
    }

    // 再生をやめて盤面を止める
    stop() {
        if (!this.games.length) return;
        if (this.loop && this.loop.driver === this) this.loop.driver = null;
        this.mode.end(this);
        const clock = this.games[0].clock;
        for (const g of this.games) {
            g._replay = null;
            g.nextMatchSeed = null;
        }
        clock.endFeed();
        clock.resume();
        for (const id of ['countdown-overlay', 'player-countdown-overlay', 'cpu-countdown-overlay']) {
            const ov = document.getElementById(id);
            if (ov && typeof cancelCountdownTimer === 'function') {
                cancelCountdownTimer(ov);
                ov.classList.remove('active');
            }
        }
        this.restore();
        this.state = 'pause';
        this.watching = false;
    }
}

// ─── 録画の出入り口・再生の画面 ───
const ReplayManager = {
    last: null,          // 直前に録画したリプレイ（コンソールの verify 用）
    resultReplay: null,  // リザルト画面の WATCH REPLAY で見るもの（別の画面へ移ったら消す）
    player: null,        // 画面で見ている再生
    returnPage: 'result',
    backTo: null,        // PLAY HERE の戻り先 { data, t, returnPage, speed, fresh }（UI 設計書 §8.2。◀ REPLAY）
    _keyHandler: null,
    _uiBound: false,

    // シングル（tet の _initGameState・puyo の initGame。乱数を作った直後）から呼ばれる
    begin(g) {
        if (g._replay) {
            if (g._replay.games.length === 1) g._replay.attach();
            return;
        }
        // 前の録画（途中でやめた試合）は捨てる
        if (g._rec) g._rec.detach();
        if (g.loop && g.loop.recorder) g.loop.recorder.detach();
        if (g.clock._feed) g.clock.endFeed();
        // 新しい試合（RESTART・RETRY・別のモード）を始めたら ◀ REPLAY の戻り先を忘れる。
        // PLAY HERE で PRACTICE を始めた最初の 1 回（fresh）だけは残す
        if (this.backTo) {
            if (this.backTo.fresh) this.backTo.fresh = false;
            else this._setBack(null);
        }
        if (g.isVersusMode || g.canvasPrefix || g.tumoRng || g.rng) return;
        const mode = g.currentMode;
        const tet = replayRule(g) === 'tet';
        if (!(tet ? (REPLAY_TET_SINGLE.indexOf(mode) >= 0 || mode === 'test') : (mode === 'puyo' || mode === 'test'))) return;
        let modeOption = null;
        if (mode === 'marathon') modeOption = (g.marathonGoal === Infinity) ? 'endless' : String(g.marathonGoal || 150);
        // CPU TEST の CPU は start() の後に作られるので、名前などは締めるときに入れる（finish）
        new ReplayRecorder({ mode, modeOption, games: [g], players: [{ name: 'PLAYER', kind: 'human' }] });
        this.resultReplay = null;
    },

    // VERSUS（versus.js が両盤面の初期化の後に呼ぶ）。再生中なら時計と入力を録画に合わせる
    beginMatch(spec) {
        const g0 = spec.games[0];
        if (g0._replay) { g0._replay.attach(); return; }
        if (this.backTo) this._setBack(null); // 新しい対戦（RESTART・RETRY）。VERSUS の続きはここを通らない
        for (const g of spec.games) if (g._rec) g._rec.detach();
        if (g0.loop.recorder) g0.loop.recorder.detach();
        if (g0.clock._feed) g0.clock.endFeed();
        new ReplayRecorder(Object.assign({ keysReady: true }, spec));
        this.resultReplay = null;
    },

    // VERSUS のカウントダウンを始めた（versus.js）
    countdown(g) {
        if (g && g._rec) g._rec.countdown(g);
    },

    // 盤面入れ替え（デバッグ）など、再生できない操作をしたら録画をやめる
    cancel(g) {
        if (g && g._rec) g._rec.detach();
    },

    _cpuInfo(c) {
        if (!c) return null;
        const info = { className: c.constructor ? c.constructor.name : null };
        if (c.weightsId) info.weightsId = c.weightsId;
        return info;
    },

    // ゲームオーバー（tet の gameOver・puyo の _beginGameOver）から呼ばれる（録画中のとき）
    finish(g, isClear, extra) {
        const rec = g._rec;
        if (!rec) return;
        rec.detach();
        if (rec.mode === 'versus') {
            // CPU は試合を始めた後に作られるので、ここで入れる（versus.js の _cpuControllerPlayer / _cpuController）
            const ctrls = [window._cpuControllerPlayer, window._cpuController];
            for (const p of rec.players) if (p.kind === 'cpu' && !p.cpu) p.cpu = this._cpuInfo(ctrls[p.side]);
        }
        if (rec.mode !== 'versus' && g.currentMode !== rec.mode) return; // 別のモード（PRACTICE 等）に使い回された録画は捨てる
        if (rec.mode === 'test') {
            const c = window._cpuController;
            rec.players[0].kind = g.isCpuControlled ? 'cpu' : 'human';
            rec.players[0].name = g.isCpuControlled ? 'CPU' : 'PLAYER';
            rec.players[0].cpu = this._cpuInfo(c);
        }
        let data;
        try {
            data = rec.finish(g, isClear, extra);
        } catch (e) {
            console.warn('[replay] 録画を締められませんでした', e);
            return;
        }
        this.last = data;
        this.resultReplay = data;
        this._verified = false;
        if (this.onRecorded) this.onRecorded(data);
    },

    // navigation.js の switchPage から（ページが変わるたび）
    onSwitchPage(pageId) {
        if (this.player && this.player.watching && pageId !== this.player.page) this._endWatch(false);
        // VERSUS の続き（M7d）を終えて対戦の画面を離れたら、準備画面の設定を戻す
        if (this._liveSaved && pageId !== 'versus' && pageId !== 'versus-result') this._restoreLive();
        // ◀ REPLAY の戻り先は、試合・リザルト・ポーズの SETTINGS 以外へ移ったら忘れる（MODE SELECT・MAIN MENU など）
        if (this.backTo && ['game', 'versus', 'result', 'versus-result', 'settings'].indexOf(pageId) < 0) this._setBack(null);
        if (pageId === 'result' || pageId === 'versus-result') {
            for (const id of ['result-replay-btn', 'versus-result-replay-btn']) {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = this.resultReplay ? '' : 'none';
            }
            if (this.resultReplay && this.updateResultTools) this.updateResultTools();
            let auto = false;
            try { auto = localStorage.getItem('replayAutoVerify') === '1'; } catch (e) { /* 使えない */ }
            if (auto && this.resultReplay && !this._verified) {
                this._verified = true;
                this.verify(this.resultReplay);
            }
            this.returnPage = pageId;
        } else if (pageId !== 'game' && pageId !== 'versus') {
            this.resultReplay = null;
        }
        if (pageId === 'replays' && window.ReplaysPage) {
            this.returnPage = 'replays';
            setTimeout(() => window.ReplaysPage.render({ open: true }), 0); // ページが切り替わってから描く
        }
    },

    _restoreLive() {
        const s = this._liveSaved;
        if (!s) return;
        this._liveSaved = null;
        versusPlayerRule = s.pr;
        versusCpuRule = s.cr;
        selectedCpuLevel = s.lv;
        versusPlayerIsCpu = s.pIsCpu;
        selectedPlayerCpuLevel = s.plv;
    },

    // ─── REPLAY に戻る（UI 設計書 §8.2）───
    // PLAY HERE の先（PRACTICE・VERSUS の続き）のポーズとリザルトに ◀ REPLAY を出す（戻り先があるときだけ）
    _setBack(b) {
        this.backTo = b;
        const kind = b ? (b.data.mode === 'versus' ? 'versus' : 'practice') : null;
        const ids = {
            practice: ['pause-replay-back-btn', 'result-replay-back-btn'],
            versus: ['versus-pause-replay-back-btn', 'versus-result-replay-back-btn'],
        };
        for (const k in ids) {
            for (const id of ids[k]) {
                const el = document.getElementById(id);
                if (el) el.style.display = k === kind ? '' : 'none';
            }
        }
    },

    // ◀ REPLAY: 試合を止めて、PLAY HERE を押した所から見直す（止めた状態。スナップショットは作り直しなので長い試合はシークに少しかかる）
    backToReplay() {
        const b = this.backTo;
        if (!b) return;
        this._setBack(null);
        if (b.data.mode === 'versus') {
            if (window.BattleVersusLifecycle) window.BattleVersusLifecycle.transition('idle', 'back to replay');
            this._restoreLive();
        }
        if (typeof stopAllGames === 'function') stopAllGames();
        this.watch(b.data, b.returnPage, { at: b.t, speed: b.speed });
    },

    _busy() {
        const all = [window._game, window._puyoGame, window._cpuGame];
        return all.some((g) => g && !g._replay && ((g._renderLoopId) || (g.state === 'playing' || g.state === 'starting')));
    },

    // 描かずに最初から再生し、設置ごとのハッシュを全部照らし合わせる（コンソール・開発用）
    verify(data = this.last) {
        if (!data) { console.warn('[replay] リプレイがありません'); return null; }
        if (this.player || this._busy()) {
            console.warn('[replay] プレイ中・再生中は照らし合わせられません');
            return null;
        }
        let p;
        try {
            p = new ReplayPlayer(data);
        } catch (e) {
            console.warn('[replay]', e.message);
            return null;
        }
        if (data.players.some((x) => x.rule === 'puyo') && !PuyoGame._sharedImagesLoaded) {
            console.warn('[replay] ぷよの画像の読み込みがまだです');
            return null;
        }
        const t = performance.now();
        p.prepare();
        p.runToEnd();
        const res = {
            ok: !p.desynced && p.ended && p.checkIdx === p.checks.length,
            locks: p.checks.length,
            matched: p.desynced ? (p.desyncInfo.lock || 0) : p.checkIdx,
            frames: p.nFrames,
            recordedFrames: data.frameCount,
            ms: Math.round(performance.now() - t),
            desync: p.desyncInfo,
            version: `v${data.app} / ${data.build}`,
        };
        p.stop();
        if (res.ok) console.log(`[replay] 一致: 設置 ${res.locks} 手・フレーム ${res.frames}（${res.ms}ms）`, res);
        else console.warn('[replay] ずれ:', res);
        return res;
    },

    // スナップショットの確かめ（コンソール・開発用）: 描かずに最後まで進めながら写し、
    // 写したものそれぞれに戻して最後まで進め、ハッシュが全部合うか見る
    verifySnaps(data = this.last, every) {
        if (!data) { console.warn('[replay] リプレイがありません'); return null; }
        if (this.player || this._busy()) { console.warn('[replay] プレイ中・再生中は確かめられません'); return null; }
        const p = new ReplayPlayer(data);
        if (every) p.snapEvery = every;
        const t = performance.now();
        p.prepare();
        p.snapOn = true;
        p.runToEnd();
        const snaps = p.snaps.filter(Boolean);
        const tTake = performance.now() - t;
        p.snapOn = false;
        const bad = [];
        let tRestore = 0;
        this._withMute(() => {
            for (const s of snaps) {
                const t1 = performance.now();
                p._restoreSnap(s);
                tRestore += performance.now() - t1;
                let n = 0;
                while (!p.ended && !p.desynced && n < (data.frameCount || 0) + 1000) { p.step(false); n++; }
                const ok = !p.desynced && p.ended && p.checkIdx === p.checks.length;
                if (!ok) bad.push({ snapMs: Math.round(s.t), desync: p.desyncInfo });
            }
        });
        p.stop();
        const res = {
            ok: bad.length === 0 && snaps.length > 0, snaps: snaps.length, bad,
            msRunWithSnaps: Math.round(tTake), msPerRestore: snaps.length ? +(tRestore / snaps.length).toFixed(2) : 0,
        };
        if (res.ok) console.log(`[replay] スナップショット ${res.snaps} 個、どれから進めても一致`, res);
        else console.warn('[replay] スナップショットから進めるとずれる:', res);
        return res;
    },

    _withMute(fn) {
        const se = window.SeManager;
        const prev = se ? se._muted : false;
        if (se) se._muted = true;
        try { fn(); } finally { if (se) se._muted = prev; }
    },

    // ─── 画面で見る ───
    watchResult() {
        if (this.resultReplay) this.watch(this.resultReplay, this.returnPage);
    },

    // at・speed: その時刻へシークして止めた状態で見せる（◀ REPLAY）
    watch(data, returnPage, opts) {
        if (this.player) this._endWatch(false);
        let p;
        try {
            p = new ReplayPlayer(data);
        } catch (e) {
            if (typeof showGlobalToast === 'function') showGlobalToast(e.message);
            else console.warn('[replay]', e.message);
            return;
        }
        this.returnPage = returnPage || 'replays';
        p.ready(() => this._startWatch(p, opts));
    },

    _startWatch(p, opts) {
        const data = p.data;
        this._drawMarks(p);
        p.prepare();
        p.watching = true;
        p.snapOn = true;
        this.player = p;
        this._bindUi();
        p.onUi = () => this._updateUi();
        if (typeof switchPage === 'function') switchPage(p.page);
        document.body.classList.add('replay-watching');
        this._setTitle(data);
        this._setUiHidden(this._loadUiHidden(), false);
        this._thinkPos = [];
        // 古い版の録画（§7）
        this._msg(data.engine !== REPLAY_ENGINE_VERSION
            ? `v${data.app}（${data.build}）で録画されたリプレイです。今の版では途中からずれることがあります`
            : '');
        // BGM は等速で流し続ける（1 回だけ鳴らす。同じ曲が流れていればそのまま）
        if (window.BgmManager) window.BgmManager.play(p.mode.bgm(data));
        p.restart();
        p.play();
        if (opts && opts.at != null) {
            if (opts.speed) p.setSpeed(opts.speed);
            p.pause();
            p.seek(opts.at);
        }
    },

    // 見るのをやめる（toBack: 来た画面へ戻る）
    _endWatch(toBack) {
        const p = this.player;
        if (!p) return;
        this._closePause(false);
        this._closeMarks(null);
        this._mk = null;
        this._clearEnd();
        this._prevState = null;
        this.player = null;
        p.onUi = null;
        p.stop();
        document.body.classList.remove('replay-watching', 'replay-ui-hidden');
        for (const side of [0, 1]) {
            const el = document.getElementById('replay-think-' + side);
            if (el) { el.textContent = ''; el.style.display = 'none'; }
        }
        if (toBack && typeof switchPage === 'function') {
            const back = (this.returnPage === 'result' || this.returnPage === 'versus-result') && !this.resultReplay ? 'main-menu' : this.returnPage;
            switchPage(back);
        }
    },

    // 上の帯: モード名と録画日時（app/replays.js の要約と日付の書き方を使う）
    _setTitle(data) {
        const el = document.getElementById('replay-title');
        if (!el) return;
        const mode = (typeof replaySummary === 'function') ? replaySummary(data).mode : String(data.mode || '').toUpperCase();
        const date = (typeof replayDateText === 'function') ? replayDateText(data.recordedAt) : '';
        el.textContent = mode;
        if (date) {
            const d = document.createElement('span');
            d.className = 'replay-title-date';
            d.textContent = date;
            el.appendChild(d);
        }
    },

    // UI の表示 ON/OFF（H キー・◱）。見終わっても覚えておく
    _loadUiHidden() {
        try { return localStorage.getItem('replayUiHidden') === '1'; } catch (e) { return false; }
    },
    _setUiHidden(on, flash) {
        document.body.classList.toggle('replay-ui-hidden', on);
        try { localStorage.setItem('replayUiHidden', on ? '1' : '0'); } catch (e) { /* 使えない */ }
        const show = document.getElementById('replay-ui-show');
        if (!show) return;
        // 隠した直後だけ SHOW UI をはっきり出す（隠したことと戻し方が分かるように）
        clearTimeout(this._uiFlashTimer);
        show.classList.toggle('is-flash', on && flash);
        if (on && flash) this._uiFlashTimer = setTimeout(() => show.classList.remove('is-flash'), 1500);
    },
    _toggleUi() {
        this._setUiHidden(!document.body.classList.contains('replay-ui-hidden'), true);
    },

    // 盤面の上に CPU の思考を置く（盤面の canvas に合わせる。位置が変わったときだけ書く）。
    // puyo は盤面のすぐ上におじゃまの予告（<canvas id>-ojama-yokoku）があるので、その上に置く
    _placeThink(el, g, side) {
        const cv = g && (g.mainCanvas || g.canvas);
        if (!cv) return;
        const r = cv.getBoundingClientRect();
        let top = r.top;
        const yk = cv.id && document.getElementById(cv.id + '-ojama-yokoku');
        if (yk && yk.offsetParent) top = Math.min(top, yk.getBoundingClientRect().top);
        const w = Math.max(r.width, 240);
        const key = `${Math.round(r.left)},${Math.round(top)},${Math.round(r.width)}`;
        if (this._thinkPos[side] === key) return;
        this._thinkPos[side] = key;
        el.style.left = Math.round(r.left + r.width / 2 - w / 2) + 'px';
        el.style.width = Math.round(w) + 'px';
        el.style.top = Math.round(top) + 'px';
        el.style.transform = 'translateY(calc(-100% - 6px))';
    },

    _msg(text) {
        const el = document.getElementById('replay-msg');
        if (!el) return;
        el.textContent = text || '';
        el.style.display = text ? '' : 'none';
    },

    _bindUi() {
        if (this._uiBound) return;
        this._uiBound = true;
        const $ = (id) => document.getElementById(id);
        // ボタンにフォーカスを残さない（SPACE が最後に押したボタンをもう一度押さないように）
        const playBtn = $('replay-play-btn');
        if (playBtn) { playBtn.onmousedown = (e) => e.preventDefault(); playBtn.onclick = () => this._togglePlay(); }
        const menuBtn = $('replay-menu-btn');
        if (menuBtn) { menuBtn.onmousedown = (e) => e.preventDefault(); menuBtn.onclick = () => this._openPause(); }
        // PAUSE 画面のボタン
        const pauseActions = {
            'replay-pause-resume': () => { this._closePause(false); if (this.player) this.player.play(); },
            'replay-pause-again': () => {
                this._closePause(false);
                const p = this.player;
                if (p && p.state !== 'desync') { p.restart(); p.play(); }
            },
            'replay-pause-restart': () => {
                this._closePause(false);
                const p = this.player;
                if (p && p.state !== 'desync') { p.restart(); p.play(); }
            },
            'replay-pause-marks': () => this._openMarks(),
            'replay-pause-here': () => { this._closePause(false); this._playFromHere(); },
            'replay-pause-save': async () => {
                const p = this.player;
                const b = $('replay-pause-save');
                if (!p || !this.saveReplay) return;
                const it = await this.saveReplay(p.data);
                if (it && b) { b.disabled = true; b.textContent = '✓ SAVED'; }
                if (window.FocusNav) window.FocusNav.refresh();
            },
            'replay-pause-exit': () => { this._closePause(false); this._endWatch(true); },
            'replay-pause-mainmenu': () => {
                this._closePause(false);
                this._endWatch(false);
                if (typeof switchPage === 'function') switchPage('main-menu');
            },
        };
        for (const id in pauseActions) {
            const b = $(id);
            if (b) { b.onmousedown = (e) => e.preventDefault(); b.onclick = pauseActions[id]; }
        }
        for (const [id, dir] of [['replay-speed-down', -1], ['replay-speed-up', 1]]) {
            const b = $(id);
            if (b) { b.onmousedown = (e) => e.preventDefault(); b.onclick = () => this._stepSpeed(dir); }
        }
        for (const id of ['replay-ui-btn', 'replay-ui-show']) {
            const b = $(id);
            if (b) { b.onmousedown = (e) => e.preventDefault(); b.onclick = () => this._toggleUi(); }
        }
        for (const [id, dir] of [['replay-mark-prev', -1], ['replay-mark-next', 1]]) {
            const b = $(id);
            if (b) { b.onmousedown = (e) => e.preventDefault(); b.onclick = () => this._jumpMark(dir); }
        }
        for (const [id, dir] of [['replay-step-prev', -1], ['replay-step-next', 1]]) {
            const b = $(id);
            if (b) { b.onmousedown = (e) => e.preventDefault(); b.onclick = () => { if (this.player) this.player.stepLock(dir); }; }
        }
        const marksBtn = $('replay-marks-btn');
        if (marksBtn) { marksBtn.onmousedown = (e) => e.preventDefault(); marksBtn.onclick = () => this._openMarks(); }
        // 印の画面（UI 設計書 §7）: 閉じる・ホイールで横に流す
        const mkClose = $('replay-mk-close');
        if (mkClose) { mkClose.onmousedown = (e) => e.preventDefault(); mkClose.onclick = () => this._closeMarks('back'); }
        const mkStrip = $('replay-mk-strip');
        if (mkStrip) {
            mkStrip.addEventListener('wheel', (e) => {
                const mk = this._mk;
                if (!mk || !this._marksOpen()) return;
                e.preventDefault();
                const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                this._mkScrollTo(mk.target + d * (e.deltaMode === 1 ? 40 : 1));
            }, { passive: false });
        }
        const seek = $('replay-seek');
        if (seek) {
            seek.addEventListener('input', () => { if (this.player) this.player.seek(Number(seek.value)); });
            seek.addEventListener('keydown', (e) => e.preventDefault()); // キーはまとめて下で受ける
        }
        // 見ている間のキー（ゲームのキー・ポーズ・リスタート・フォーカス移動には渡さない）。
        // ポーズキー（設定。ESC は常に）で PAUSE 画面を開く/閉じる。開いている間は上下・決定だけ
        // FocusNav（PAUSE 画面のボタン選び）へ通し、← → , . [ ] は画面を閉じて止めたまま動かす。
        // 印の画面を開いている間は札の選びをここで全部受ける（FocusNav へは何も通さない）
        this._keyHandler = (e) => {
            const p = this.player;
            if (!p || !p.watching) return;
            const gp = document.getElementById(p.page + '-page');
            if (!gp || !gp.classList.contains('active')) return;
            if (this._marksOpen()) { this._marksKey(e); return; }
            const menu = this._pauseOpen();
            if (this._pauseCodes().indexOf(e.code) >= 0) {
                e.stopImmediatePropagation();
                e.preventDefault();
                if (e.repeat) return;
                if (menu) this._closePause(this._pauseResume);
                else this._openPause();
                return;
            }
            if (menu) {
                if (['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Enter', 'NumpadEnter', 'Space'].indexOf(e.code) >= 0) return;
                if (['ArrowLeft', 'ArrowRight', 'BracketLeft', 'BracketRight', 'Comma', 'Period'].indexOf(e.code) >= 0) this._closePause(false);
                else if (e.code !== 'KeyH' && e.code !== 'KeyM') {
                    e.stopImmediatePropagation();
                    if (e.code === 'Tab') e.preventDefault();
                    return;
                }
            }
            e.stopImmediatePropagation();
            const handled = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'BracketLeft', 'BracketRight', 'Comma', 'Period', 'KeyH', 'KeyM'];
            if (handled.indexOf(e.code) < 0) return;
            e.preventDefault();
            if (e.repeat && (e.code === 'Space' || e.code === 'KeyH' || e.code === 'KeyM')) return;
            switch (e.code) {
                case 'Space': this._togglePlay(); break;
                case 'ArrowLeft': p.seek(this._targetTime() - 5000); break;
                case 'ArrowRight': p.seek(this._targetTime() + 5000); break;
                case 'ArrowUp': this._stepSpeed(1); break;
                case 'ArrowDown': this._stepSpeed(-1); break;
                case 'KeyH': this._toggleUi(); break;
                case 'KeyM': this._openMarks(); break;
                case 'BracketLeft': this._jumpMark(-1); break;
                case 'BracketRight': this._jumpMark(1); break;
                case 'Comma': p.stepLock(-1); break;
                case 'Period': p.stepLock(1); break;
            }
        };
        window.addEventListener('keydown', this._keyHandler, true);
    },

    // ─── PAUSE 画面（UI 設計書 §5）───
    _pauseOpen() {
        const o = document.getElementById('replay-pause-overlay');
        return !!(o && o.classList.contains('active'));
    },

    // 設定のポーズキー（キーボードの割り当て）。ESC はいつでも
    _pauseCodes() {
        const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
        const codes = (keys && keys.pause && keys.pause.codes) ? keys.pause.codes.slice() : [];
        if (codes.indexOf('Escape') < 0) codes.push('Escape');
        return codes;
    },

    // focusId: 最初にフォーカスするボタン（印の画面から戻ったときは MARKS。無ければ RESUME／REPLAY AGAIN）。
    // focus_nav.js の replay-pause-overlay が開いたときに読む
    _openPause(focusId) {
        const p = this.player;
        const o = document.getElementById('replay-pause-overlay');
        if (!p || !o || this._pauseOpen()) return;
        this._pauseFocusId = focusId || null;
        // 閉じるとき（ポーズキー）は開く前の状態に戻す。再生中だったら続きから流す
        this._pauseResume = p.state === 'play' || (p.state === 'seek' && p.seekResume === 'play');
        p.pause();
        const $ = (id) => document.getElementById(id);
        // 最後まで見たところ（END）: 見出しを END に、RESUME・RESTART の代わりに REPLAY AGAIN
        const atEnd = p.state === 'end';
        const title = $('replay-pause-title');
        if (title) title.textContent = atEnd ? 'END' : 'PAUSE';
        for (const [id, show] of [['replay-pause-resume', !atEnd], ['replay-pause-restart', !atEnd], ['replay-pause-again', atEnd]]) {
            const b = $(id);
            if (b) b.style.display = show ? '' : 'none';
        }
        const marks = $('replay-pause-marks');
        if (marks) marks.style.display = (p.data.events || []).length ? '' : 'none';
        // PLAY HERE: VERSUS の続きは止めた所（シーク中・カウントダウン・決着の所以外）からだけ
        let why = '';
        if (p.state === 'desync') why = 'ずれた所からは遊べません';
        else if ((p.ended || p.state === 'end') && !p.clipCut) why = '終わった所からは遊べません'; // 途中で切ったクリップの終わりからは遊べる
        else if (p.data.mode === 'versus' && (p.state !== 'pause' || !p.canGoLive())) why = 'ここからは遊べません（シーク中・カウントダウン・ポーズ・決着の所）';
        else if (p.data.mode === 'zone') why = 'ZONE はまだ PRACTICE で遊べません';
        const here = $('replay-pause-here');
        if (here) here.disabled = !!why;
        const note = $('replay-pause-here-note');
        if (note) { note.textContent = why; note.style.display = why ? '' : 'none'; }
        // SAVE REPLAY: 自動保存 OFF で、まだ保存していないときだけ（app/replays.js）
        const save = $('replay-pause-save');
        if (save) {
            save.style.display = 'none';
            save.disabled = false;
            save.textContent = '⤓ SAVE REPLAY';
            if (this.needsSave) {
                this.needsSave(p.data).then((need) => {
                    if (!need || this.player !== p || !this._pauseOpen()) return;
                    save.style.display = '';
                    if (window.FocusNav) window.FocusNav.refresh();
                }).catch(() => {});
            }
        }
        o.classList.add('active');
    },

    // ─── 終了演出（UI 設計書 §8.1）───
    // 再生が最後まで行ったら本番と同じ演出（シングル FINISH!/GAME OVER、対戦は両盤面に WIN!/LOSE...）を出し、
    // 終わったら END の PAUSE 画面を開く。シークで最後に着いたとき（描かずに進めたとき）は出さない。
    // 試合の途中で切ったクリップは勝ち負けが決まっていないので、演出なしで少し置いて END を開く
    _showEnd(p) {
        const bf = window.BattleFinish;
        if (!bf) return;
        this._endShown = true;
        const r = p.data.result || {};
        const done = () => {
            if (this.player === p && p.state === 'end' && this._endShown && !this._pauseOpen() && !this._marksOpen()) this._openPause();
        };
        if (p.clipCut) {
            clearTimeout(this._endTimer);
            this._endTimer = setTimeout(done, 500);
            return;
        }
        if ((p.data.players || []).length > 1) {
            bf.showFieldFinish('player-', r.endedBy === 0 ? 'lose' : 'win');
            bf.showFieldFinish('cpu-', r.endedBy === 1 ? 'lose' : 'win', done);
        } else {
            bf.showFieldFinish('', r.clear ? 'clear' : 'gameover', done); // '' → シングルの #finish-overlay
        }
    },

    _clearEnd() {
        this._endShown = false;
        clearTimeout(this._endTimer);
        const bf = window.BattleFinish;
        if (bf) for (const prefix of ['', 'player-', 'cpu-']) bf.clearFieldFinish(prefix);
    },

    // resume: 閉じたあと再生する（ポーズキーで閉じたときの「開く前に再生していたら」）
    _closePause(resume) {
        const o = document.getElementById('replay-pause-overlay');
        if (!o || !o.classList.contains('active')) return;
        o.classList.remove('active');
        if (document.activeElement && o.contains(document.activeElement)) document.activeElement.blur();
        if (resume && this.player) this.player.play();
    },

    // ここから遊ぶ（M7c）: シングル・CPU TEST は PRACTICE へ渡す（VERSUS はその対戦の続き＝M7d）
    _playFromHere() {
        const p = this.player;
        if (!p) return;
        if (p.data.mode === 'versus') { this._continueVersus(); return; }
        // ZONE は PRACTICE にまだ無い（ZONE 段の印・メーターを渡せない。設計 tetlabo-zone-design.md Q7）
        if (p.data.mode === 'zone') {
            if (typeof showGlobalToast === 'function') showGlobalToast('ZONE はまだ PRACTICE で遊べません');
            return;
        }
        p.pause();
        const h = p.practiceHandoff();
        if (!h || typeof startPracticeFromReplay !== 'function') {
            if (typeof showGlobalToast === 'function') showGlobalToast('ここからは遊べません');
            return;
        }
        // ◀ REPLAY の戻り先（puyo は次のぷよが出る所まで進めてから渡すので、その時刻）。
        // PRACTICE を始める start() の 1 回目の begin では消さない（fresh）
        const back = this._backFrom(p, true);
        this.resultReplay = null; // PRACTICE のリザルトに元の試合の WATCH REPLAY を出さない
        this._endWatch(false);
        this._setBack(back);
        startPracticeFromReplay(h);
    },

    // 戻り先。リザルトから見ていたときは、戻ったころにはリザルトが別の試合のものなので REPLAYS へ帰す
    _backFrom(p, fresh) {
        const rp = this.returnPage;
        return {
            data: p.data, t: p.time(), speed: p.speed, fresh,
            returnPage: (rp === 'result' || rp === 'versus-result') ? 'replays' : rp,
        };
    },

    // VERSUS の続きを遊ぶ（M7d。§10）: 相手の CPU を読み込み、入力の出どころをリプレイからキーボードへ
    // 切り替え、CPU に今の局面から考えさせる。続きは録画しない。
    // versus.js の startVersusGame と同じ順に、盤面を作り直さずに試合の外回り（状態・CPU・キー・ポーズ・見張り）だけ付ける
    async _continueVersus() {
        const p = this.player;
        if (!p || this._goingLive) return;
        p.pause();
        if (p.state !== 'pause' || !p.canGoLive()) {
            if (typeof showGlobalToast === 'function') showGlobalToast('ここからは遊べません（シーク中・カウントダウン・ポーズ・決着の所）');
            return;
        }
        const pl = p.data.players || [];
        const cpus = pl.filter((x) => x.kind === 'cpu');
        if (cpus.some((x) => typeof x.level !== 'number')) {
            if (typeof showGlobalToast === 'function') showGlobalToast('CPU のレベルが記録されていないので続きを遊べません');
            return;
        }
        this._goingLive = true;
        const sessionId = currentSessionId;
        const stale = () => currentSessionId !== sessionId || this.player !== p || !p.watching;
        let prep;
        try {
            prep = await window.BattleLocalLoading.prepare({
                rules: pl.map((x) => x.rule),
                bgmKey: 'versus_bgm',
                cpus: cpus.map((x) => ({ level: x.level, rule: x.rule, label: x.name })),
                isStale: stale,
            });
        } finally {
            this._goingLive = false;
        }
        if (prep.cancelled || stale()) {
            if (prep.cpuFailed && typeof showGlobalToast === 'function') showGlobalToast('CPU を読み込めませんでした');
            return;
        }
        if (p.state !== 'pause' || !p.canGoLive()) return; // 読み込みの間に再生・シークされた
        // 再生をやめて、盤面はそのまま本物の試合へ
        const back = this._backFrom(p, false);
        this.player = null;
        p.onUi = null;
        const globals = p.detachLive();
        document.body.classList.remove('replay-watching');
        this.resultReplay = null; // 続きの試合は録画しない（対戦結果に WATCH REPLAY を出さない）
        // 準備画面の設定は試合が終わって VERSUS の画面を離れるときに戻す（onSwitchPage）
        this._liveSaved = {
            pr: globals ? globals.pr : versusPlayerRule, cr: globals ? globals.cr : versusCpuRule,
            lv: selectedCpuLevel, pIsCpu: versusPlayerIsCpu, plv: selectedPlayerCpuLevel,
        };
        const sideCpu = (side) => pl.find((x) => x.side === side && x.kind === 'cpu');
        if (sideCpu(1)) selectedCpuLevel = sideCpu(1).level;
        versusPlayerIsCpu = !!sideCpu(0);
        selectedPlayerCpuLevel = sideCpu(0) ? sideCpu(0).level : null;

        const lc = window.BattleVersusLifecycle;
        lc.transition('idle', 'replay continue');
        lc.transition('preparing', 'replay continue');
        lc.beginRound();
        lc.transition('countdown', 'replay continue');
        lc.transition('playing', 'replay continue');

        const games = [window._game, window._cpuGame];
        games.forEach((g, side) => {
            const cpu = sideCpu(side);
            g.isCpuControlled = !!cpu;
            g.cpuReset();
            if (cpu) return;
            // 人の盤面: 再生のキーの押したままを捨てて、今のキー設定で受け口を付け直す
            if (g._heldCodes) g._heldCodes.clear();
            if (replayRule(g) === 'tet') {
                g.keyState = {};
                g.setKeyEvent();
            } else {
                if (g._keys) for (const k in g._keys) g._keys[k] = false;
                g._dasDir = 0;
                g._dasTimer = 0;
                g._arrTimer = 0;
                g._setKeyHandlers();
            }
        });
        _stopVersusCpuControllers();
        cpus.forEach((x, i) => {
            const Cls = prep.classes[i];
            if (!Cls) return;
            const key = x.side === 0 ? '_cpuControllerPlayer' : '_cpuController';
            const ctrl = new Cls(games[x.side]);
            window[key] = ctrl;
            if (typeof ctrl.start === 'function') ctrl.start();
        });
        if (!sideCpu(0) && window.Assist) window.Assist.attach(window._game, 'versus');
        window.CpuMatchLog?.hideDock();
        await window.BattleLocalLoading.reveal();
        setupVersusPauseKey();
        if (typeof startVersusCpuWatchdog === 'function') startVersusCpuWatchdog(currentSessionId);
        this._setBack(back);
        if (typeof showGlobalToast === 'function') showGlobalToast('ここから対戦の続きです（録画はしません）');
    },

    // 印の少し前（1 秒）から見る
    _markTime(m) {
        return Math.max(this.player ? this.player.clipFrom : 0, m.t - 1000);
    },

    // 印の前 5 秒・後 3 秒を切り出して保存する（M7b。保存は app/replays.js の onClip）
    _clip(m, label) {
        const p = this.player;
        if (!p) return;
        const data = p.makeClip(m.t - 5000, m.t + 3000, label);
        if (!data) {
            if (typeof showGlobalToast === 'function') showGlobalToast('ここは切り出せません');
            return;
        }
        if (this.onClip) this.onClip(data);
    },

    // 前／次の印へ
    _jumpMark(dir) {
        const p = this.player;
        if (!p) return;
        const ev = p.data.events || [];
        const now = this._targetTime();
        let target = null;
        if (dir > 0) target = ev.find((m) => this._markTime(m) > now + 50);
        else for (let i = ev.length - 1; i >= 0; i--) if (this._markTime(ev[i]) < now - 300) { target = ev[i]; break; }
        if (target) p.seek(this._markTime(target));
    },

    // シークバーの上の印と ◆ n（見始めに 1 回）。印の画面の並びは開いたときに作る（_mkLayout）
    _drawMarks(p) {
        const ev = p.data.events || [];
        const layer = document.getElementById('replay-marks');
        const btn = document.getElementById('replay-marks-btn');
        const from = p.clipFrom;
        const dur = Math.max(1, p.duration - from);
        const name = (side) => ((p.data.players || []).find((x) => x.side === side) || {}).name || '';
        const two = (p.data.players || []).length > 1;
        if (layer) {
            layer.innerHTML = '';
            for (const m of ev) {
                const tick = document.createElement('span');
                tick.className = `replay-mark replay-mark-${m.kind}` + (m.side ? ' replay-mark-2p' : '');
                tick.style.left = (100 * Math.max(0, m.t - from) / dur) + '%';
                tick.title = `${replayFmtTime(m.t)} ${two ? name(m.side) + ' ' : ''}${m.label}`;
                tick.onmousedown = (e) => e.preventDefault();
                tick.onclick = () => { if (this.player) this.player.seek(this._markTime(m)); };
                layer.appendChild(tick);
            }
        }
        if (btn) btn.textContent = '◆ ' + ev.length;
        this._mk = null;
    },

    // ─── 印の画面（UI 設計書 §7）───
    // 印を札にして時刻順に横へ並べ（対戦は上の段 1P・下の段 2P）、選んだ札を中央の縦線へ流す。
    // 札の位置は時刻に比例させ（REPLAY_MK_PX_PER_MS）、同じ段で重なる所と、もう一方の段の前の札より
    // 左になる所だけ右へずらす（両段をまたいでも左右の順＝時刻の順）。札は見えている範囲だけ DOM に作る
    _marksOpen() {
        const o = document.getElementById('replay-marks-overlay');
        return !!(o && o.classList.contains('active'));
    },

    _mkLayout(p) {
        const pl = p.data.players || [];
        const two = pl.length > 1;
        const items = (p.data.events || []).map((m, k) => ({ m, k })).sort((a, b) => (a.m.t - b.m.t) || (a.m.side - b.m.side) || (a.k - b.k));
        const lastX = [-Infinity, -Infinity];
        let prev = -Infinity;
        const list = items.map(({ m }) => {
            const lane = two && m.side === 1 ? 1 : 0;
            const x = Math.max(m.t * REPLAY_MK_PX_PER_MS, lastX[lane] + REPLAY_MK_STEP, prev);
            lastX[lane] = x;
            prev = x;
            return { m, lane, x };
        });
        const lanesEl = document.getElementById('replay-mk-lanes');
        const lanes = [];
        if (lanesEl) {
            lanesEl.innerHTML = '';
            for (let i = 0; i < (two ? 2 : 1); i++) {
                const lane = document.createElement('div');
                lane.className = 'replay-mk-lane';
                if (two) {
                    const who = pl.find((x) => x.side === i) || {};
                    const nm = document.createElement('span');
                    nm.className = 'replay-mk-lane-name' + (i ? ' is-2p' : '');
                    nm.textContent = `${i + 1}P  ${who.name || ''}`;
                    lane.appendChild(nm);
                }
                const track = document.createElement('div');
                track.className = 'replay-mk-track';
                lane.appendChild(track);
                lanesEl.appendChild(lane);
                lanes.push(track);
            }
        }
        const rules = pl.map((x) => x.rule);
        return { p, list, lanes, two, rules, sel: 0, offset: 0, target: 0, els: new Map(), raf: 0 };
    },

    // 時刻 → 並びの上の位置（札と札の間は直線でつなぐ）と、その逆
    _mkX(t) {
        const L = this._mk.list;
        if (!L.length) return t * REPLAY_MK_PX_PER_MS;
        if (t <= L[0].m.t) return L[0].x - (L[0].m.t - t) * REPLAY_MK_PX_PER_MS;
        const n = L.length - 1;
        if (t >= L[n].m.t) return L[n].x + (t - L[n].m.t) * REPLAY_MK_PX_PER_MS;
        let i = 0;
        while (i < n && L[i + 1].m.t <= t) i++;
        const a = L[i], b = L[i + 1];
        return b.m.t === a.m.t ? a.x : a.x + (b.x - a.x) * (t - a.m.t) / (b.m.t - a.m.t);
    },
    _mkT(x) {
        const L = this._mk.list;
        if (!L.length) return x / REPLAY_MK_PX_PER_MS;
        if (x <= L[0].x) return L[0].m.t - (L[0].x - x) / REPLAY_MK_PX_PER_MS;
        const n = L.length - 1;
        if (x >= L[n].x) return L[n].m.t + (x - L[n].x) / REPLAY_MK_PX_PER_MS;
        let i = 0;
        while (i < n && L[i + 1].x <= x) i++;
        const a = L[i], b = L[i + 1];
        return b.x === a.x ? a.m.t : a.m.t + (b.m.t - a.m.t) * (x - a.x) / (b.x - a.x);
    },

    // 開く（バーの ◆ n・PAUSE の MARKS・M キー）。開くと止める。PAUSE から開いたら閉じたとき PAUSE へ戻る
    _openMarks() {
        const p = this.player;
        const o = document.getElementById('replay-marks-overlay');
        if (!p || !o || this._marksOpen()) return;
        if (!(p.data.events || []).length) {
            if (typeof showGlobalToast === 'function') showGlobalToast('印がありません');
            return;
        }
        const fromPause = this._pauseOpen();
        if (fromPause) {
            this._mkBack = { pause: true, resume: this._pauseResume };
            this._closePause(false);
        } else {
            this._mkBack = { pause: false, resume: p.state === 'play' || (p.state === 'seek' && p.seekResume === 'play') };
        }
        p.pause();
        if (!this._mk || this._mk.p !== p) this._mk = this._mkLayout(p);
        const mk = this._mk;
        const cnt = document.getElementById('replay-mk-count');
        if (cnt) cnt.textContent = '◆ ' + mk.list.length;
        o.classList.add('active');
        // 今の時刻にいちばん近い札を選び、今の所から流す（飛ぶ先＝印の 1 秒前で比べる。飛んでから開き直すと同じ札）
        const now = this._targetTime();
        const dist = (it) => Math.abs(this._markTime(it.m) - now);
        let best = 0;
        mk.list.forEach((it, i) => { if (dist(it) < dist(mk.list[best])) best = i; });
        mk.offset = this._mkX(now);
        mk.target = mk.offset;
        this._mkSelect(best);
    },

    // how: 'back'（ESC・M・CLOSE。開く前に戻す）／'jump'（印へ飛んだ。止めたまま）／null（見終わるときなど。何もしない）
    _closeMarks(how) {
        const o = document.getElementById('replay-marks-overlay');
        if (!o || !o.classList.contains('active')) return;
        o.classList.remove('active');
        if (document.activeElement && o.contains(document.activeElement)) document.activeElement.blur();
        const mk = this._mk;
        if (mk) { cancelAnimationFrame(mk.raf); mk.raf = 0; }
        const back = this._mkBack;
        this._mkBack = null;
        if (how !== 'back' || !back || !this.player) return;
        if (back.pause) {
            this._openPause('replay-pause-marks');
            this._pauseResume = back.resume; // 止めて開き直したので、PAUSE を開く前の状態を戻す
        } else if (back.resume) {
            this.player.play();
        }
    },

    _mkSelect(i) {
        const mk = this._mk;
        if (!mk || !mk.list.length) return;
        mk.sel = Math.max(0, Math.min(mk.list.length - 1, i));
        for (const [k, el] of mk.els) el.classList.toggle('is-sel', k === mk.sel);
        this._mkScrollTo(mk.list[mk.sel].x);
    },

    // ↑ ↓: もう一方の段の、いちばん近い時刻の札へ
    _mkLane(dir) {
        const mk = this._mk;
        if (!mk || !mk.two) return;
        const cur = mk.list[mk.sel];
        const lane = cur.lane + dir;
        if (lane < 0 || lane > 1) return;
        let best = -1;
        mk.list.forEach((it, i) => {
            if (it.lane === lane && (best < 0 || Math.abs(it.m.t - cur.m.t) < Math.abs(mk.list[best].m.t - cur.m.t))) best = i;
        });
        if (best >= 0) this._mkSelect(best);
    },

    // 列を x が中央に来るように流す（少しずつ近づける）
    _mkScrollTo(x) {
        const mk = this._mk;
        if (!mk || !mk.list.length) return;
        mk.target = Math.max(mk.list[0].x, Math.min(mk.list[mk.list.length - 1].x, x));
        if (mk.raf) return;
        const tick = () => {
            mk.raf = 0;
            if (this._mk !== mk || !this._marksOpen()) return;
            const d = mk.target - mk.offset;
            mk.offset = Math.abs(d) < 0.5 ? mk.target : mk.offset + d * 0.25;
            this._mkRender();
            if (mk.offset !== mk.target) mk.raf = requestAnimationFrame(tick);
        };
        this._mkRender();
        mk.raf = requestAnimationFrame(tick);
    },

    _mkLabel(m) {
        return `${this._mk.two ? (((this._mk.p.data.players || []).find((x) => x.side === m.side) || {}).name || '') + ' ' : ''}${m.label}`;
    },

    _mkCard(i) {
        const mk = this._mk;
        const it = mk.list[i];
        const m = it.m;
        const card = document.createElement('div');
        card.className = `replay-mk-card replay-mark-${m.kind}` + (it.lane ? ' is-2p' : '');
        const body = document.createElement('button');
        body.type = 'button';
        body.className = 'replay-mk-body';
        const head = document.createElement('span');
        head.className = 'replay-mk-card-head';
        const time = document.createElement('span');
        time.className = 'replay-mk-time';
        time.textContent = replayFmtTime(Math.max(0, m.t - mk.p.clipFrom));
        const kind = document.createElement('span');
        kind.className = 'replay-mk-kind';
        kind.textContent = REPLAY_MK_KIND[m.kind] || String(m.kind || '').toUpperCase();
        if (kind.textContent === m.label) kind.textContent = ''; // PAUSE の札は名前と同じなので出さない
        head.append(time, kind);
        const name = document.createElement('span');
        name.className = 'replay-mk-name';
        name.textContent = m.label;
        body.append(head, name);
        if (m.kind === 'attack' && m.value) {
            const amt = document.createElement('span');
            amt.className = 'replay-mk-amount';
            amt.textContent = `→ ${m.value} ${mk.rules[m.side] === 'puyo' ? 'OJAMA' : 'LINES'}`;
            body.appendChild(amt);
        }
        body.onmousedown = (e) => e.preventDefault();
        body.onclick = () => { if (this._mk.sel === i) this._mkJump(); else this._mkSelect(i); };
        const clip = document.createElement('button');
        clip.type = 'button';
        clip.className = 'replay-btn replay-mk-clip';
        clip.textContent = 'CLIP';
        clip.title = '前 5 秒・後 3 秒を切り出して保存 C';
        clip.onmousedown = (e) => e.preventDefault();
        clip.onclick = () => { this._mkSelect(i); this._clip(m, this._mkLabel(m)); };
        card.append(body, clip);
        return card;
    },

    // 見えている範囲（±1 画面の半分）の札だけ作り、はみ出たものは消す。中央の時刻・NOW の線もここで
    _mkRender() {
        const mk = this._mk;
        const strip = document.getElementById('replay-mk-strip');
        if (!mk || !strip) return;
        const W = strip.clientWidth;
        const lo = mk.offset - W, hi = mk.offset + W;
        const L = mk.list;
        let a = 0, b = L.length;
        while (a < b) { const c = (a + b) >> 1; if (L[c].x < lo) a = c + 1; else b = c; }
        const keep = new Set();
        for (let i = a; i < L.length && L[i].x <= hi; i++) {
            keep.add(i);
            let el = mk.els.get(i);
            if (!el) {
                el = this._mkCard(i);
                el.classList.toggle('is-sel', i === mk.sel);
                mk.els.set(i, el);
                const track = mk.lanes[L[i].lane];
                if (track) track.appendChild(el);
            }
            const left = L[i].x - mk.offset + W / 2 - REPLAY_MK_CARD_W / 2;
            el.style.transform = `translateX(${left.toFixed(1)}px)`;
        }
        for (const [i, el] of mk.els) if (!keep.has(i)) { el.remove(); mk.els.delete(i); }
        const ct = document.getElementById('replay-mk-center-time');
        if (ct) ct.textContent = replayFmtTime(Math.max(0, this._mkT(mk.offset) - mk.p.clipFrom));
        const now = document.getElementById('replay-mk-now');
        if (now) {
            const x = this._mkX(this._targetTime()) - mk.offset + W / 2;
            now.style.display = (x < 0 || x > W) ? 'none' : '';
            now.style.transform = `translateX(${x.toFixed(1)}px)`;
        }
    },

    // Enter・選んだ札をもう一度: その印の 1 秒前へ飛んで閉じる（止めたまま）
    _mkJump() {
        const mk = this._mk;
        const p = this.player;
        if (!mk || !p || !mk.list.length) return;
        const m = mk.list[mk.sel].m;
        this._closeMarks('jump');
        p.seek(this._markTime(m));
    },

    _marksKey(e) {
        e.stopImmediatePropagation();
        const mk = this._mk;
        const code = e.code;
        if (this._pauseCodes().indexOf(code) >= 0 || code === 'KeyM') {
            e.preventDefault();
            if (!e.repeat) this._closeMarks('back');
            return;
        }
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Enter', 'NumpadEnter', 'KeyC', 'Tab', 'Space'];
        if (keys.indexOf(code) < 0) return;
        e.preventDefault();
        if (!mk) return;
        switch (code) {
            case 'ArrowLeft': case 'KeyA': this._mkSelect(mk.sel - 1); break;
            case 'ArrowRight': case 'KeyD': this._mkSelect(mk.sel + 1); break;
            case 'ArrowUp': case 'KeyW': this._mkLane(-1); break;
            case 'ArrowDown': case 'KeyS': this._mkLane(1); break;
            case 'Enter': case 'NumpadEnter': if (!e.repeat) this._mkJump(); break;
            case 'KeyC': if (!e.repeat && mk.list[mk.sel]) this._clip(mk.list[mk.sel].m, this._mkLabel(mk.list[mk.sel].m)); break;
        }
    },

    // シーク中は向かっている時刻から数える（←→ を続けて押したとき）
    _targetTime() {
        const p = this.player;
        return p.state === 'seek' ? p.seekTarget : p.time();
    },

    // 速さを 1 段上げる／下げる（◂ ▸・↑↓）
    _stepSpeed(dir) {
        const p = this.player;
        if (!p) return;
        const i = REPLAY_SPEEDS.indexOf(p.speed);
        p.setSpeed(REPLAY_SPEEDS[Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, i + dir))]);
    },

    _togglePlay() {
        const p = this.player;
        if (!p) return;
        if (p.state === 'play' || (p.state === 'seek' && p.seekResume === 'play')) p.pause();
        else p.play();
    },

    _updateUi() {
        const p = this.player;
        if (!p) return;
        const $ = (id) => document.getElementById(id);
        // 再生していて最後に着いた瞬間だけ終了演出。最後から離れたら（最初から・シーク・1 手戻る）消す
        if (p.state === 'end' && this._prevState === 'play' && !this._endShown) this._showEnd(p);
        else if (this._endShown && p.state !== 'end') this._clearEnd();
        this._prevState = p.state;
        const t = Math.min(p.duration, p.time());
        const from = p.clipFrom; // 切り出しは始まりを 0 として見せる
        const seek = $('replay-seek');
        if (seek) {
            seek.min = String(Math.round(from));
            seek.max = String(Math.max(Math.round(from) + 1, Math.round(p.duration)));
            if (document.activeElement !== seek || p.state !== 'seek') seek.value = String(Math.round(p.state === 'seek' ? p.seekTarget : t));
        }
        const timeEl = $('replay-time');
        if (timeEl) timeEl.textContent = replayFmtTime(Math.max(0, t - from)) + ' / ' + replayFmtTime(p.duration - from);
        const playing = p.state === 'play' || (p.state === 'seek' && p.seekResume === 'play');
        const playBtn = $('replay-play-btn');
        if (playBtn) playBtn.textContent = playing ? '❚❚' : '▶';
        const st = $('replay-state');
        if (st) st.textContent = p.state === 'seek' ? 'SEEK' : (p.state === 'end' ? 'END' : (p.state === 'desync' ? 'STOP' : (playing ? '' : 'PAUSE')));
        const speedEl = $('replay-speed-label');
        if (speedEl) {
            const text = p.speed + 'x';
            if (speedEl.textContent !== text) speedEl.textContent = text;
            speedEl.classList.toggle('is-changed', p.speed !== 1);
        }
        // CPU の思考はその盤面の上に（名前は盤面の下にあるので出さない）
        for (const side of [0, 1]) {
            const el = $('replay-think-' + side);
            if (!el) continue;
            const pl = p.data.players.find((x) => x.side === side);
            const text = (pl && p.thinkAt(side)) || '';
            if (el.textContent !== text) el.textContent = text;
            el.style.display = text ? '' : 'none';
            if (text) this._placeThink(el, p._gameOf(side), side);
        }
        if (p.state === 'desync' && !p._desyncShown) {
            p._desyncShown = true;
            const d = p.data;
            this._msg(`ここから先はこの版では正しく再生できません（録画: v${d.app} / ${d.build}）`);
            console.warn('[replay] ずれ:', p.desyncInfo);
        }
    },
};
window.ReplayManager = ReplayManager;

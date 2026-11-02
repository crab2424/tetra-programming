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
const REPLAY_ENGINE_VERSION = 1;   // エンジンの動きの版（§7）。動きを変える修正をしたら上げる

// 入力の列の種類。1 バイト目＝種類 << 1 | side
//   キー 0〜3（bit0 押す・bit1 長押しの繰り返し）＋コードの番号、tet のパッド 4〜5（bit0 押す）＋アクションの番号
const REPLAY_EV_PAD = 4;
const REPLAY_EV_PAUSE = 8;    // 次のフレームの頭
const REPLAY_EV_RESUME = 9;   // 次のフレームの頭
const REPLAY_EV_SKIP = 10;    // このフレームはゲーム画面が出ていなくて tet が入力を取り込まなかった
const REPLAY_EV_CONFIG = 11;  // 次のフレームの頭: キー設定・DAS を読み直した（設定画面で保存）＋設定の番号
const REPLAY_EV_CPU = 12;     // CPU の手（cpuAction）＋種類の番号・引数
const REPLAY_PAD_ACTIONS = ['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'hold'];
const REPLAY_CPU_ACTIONS = [
    // tet
    'hold', 'rotate', 'move', 'shift', 'softDrop', 'softDropQuiet', 'stepToX', 'warp', 'teleport', 'hardDrop', 'gravity',
    // puyo
    'quickDrop', 'softDropStart', 'softDropStep', 'forceLock', 'softKey',
];
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const REPLAY_TET_SINGLE = ['marathon', 'sprint', 'ultra'];

// 盤面の設定のうち結果に響くもの（外の画面が書き込む値。PRACTICE などが残した値も含めて録画したときと同じにする）
const REPLAY_ENV_FIELDS = {
    tet: ['gravityDisabled', 'practiceNoLock', 'practiceFallSpeedMs', 'practiceHoldMode', 'lockDelay',
        'marathonGoal', 'marathonStartLevel', 'isCpuControlled',
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
            durationMs: this.clock.now() - this.t0,
            frameCount: this.nFrames,
            result: Object.assign({
                clear: !!isClear,
                endedBy: replaySide(g),
                boards: results,
            }, extra || {}),
            clip: null,
            events: [],
            codes: this.codes.slice(),
            frames: replayToB64(this.dts.bytes()),
            inputs: replayToB64(this.events.bytes()),
            checks: replayToB64(this.checks.bytes()),
            think: null,
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

function replayModeOf(data) {
    if (REPLAY_TET_SINGLE.indexOf(data.mode) >= 0) return ReplayModes.tetSingle;
    if (data.mode === 'puyo') return ReplayModes.puyoSingle;
    if (data.mode === 'test') return (data.players[0].rule === 'tet') ? ReplayModes.tetSingle : ReplayModes.puyoSingle;
    if (data.mode === 'versus' && ReplayModes.versus) return ReplayModes.versus;
    return null;
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
            evs.push(ev);
        }
        this.evs = evs;
        const cb = replayFromB64(data.checks);
        this.checks = [];
        for (let i = 0; i + 3 < cb.length; i += 4) this.checks.push((cb[i] | (cb[i + 1] << 8) | (cb[i + 2] << 16) | (cb[i + 3] << 24)) >>> 0);

        this.games = [];
        this.loop = null;
        this.speed = 1;
        this.state = 'pause';     // play / pause / seek / end / desync
        this.watching = false;    // 画面に出して見ている（verify は false）
        this.onUi = null;
        this._saved = null;
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
    }

    // 試合を始めたところ（シングルは乱数を作った直後、VERSUS は両盤面の初期化の後）から呼ばれる
    attach() {
        const clock = this.games[0].clock;
        clock.reset(this.t0);
        clock._tape = null;
        clock._feed = new ReplayReader(this.dtBytes);
        if (this.loop.recorder) this.loop.recorder = null;
    }

    time() {
        return this.games[0].clock.now() - this.t0;
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
        }
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
    }

    _isPre(k) {
        return k === REPLAY_EV_PAUSE || k === REPLAY_EV_RESUME || k === REPLAY_EV_CONFIG;
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
        this.nFrames++;
        this._skip[0] = this._skip[1] = false;
        while (this.ep < evs.length && evs[this.ep].f <= f) this._applyEvent(evs[this.ep++]);
        this.loop.step(draw);
        this._cpuQ[0].length = this._cpuQ[1].length = 0;
        if (!this.ended && !this.desynced && this.nFrames > (this.data.frameCount || 0) + 600) {
            this._desync('記録したフレームを過ぎても終わらない');
        }
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
        if (this.state === 'seek') {
            const until = now + 12; // 1 回の rAF で使う時間（その間も盤面は描く）
            this._withSe(true, () => {
                while (!this.ended && !this.desynced && this.time() < this.seekTarget && performance.now() < until) this.step(false);
            });
            if (!this.desynced && (this.ended || this.time() >= this.seekTarget)) {
                this.state = this.ended ? 'end' : this.seekResume;
                this.playTime = this.time();
            }
        } else if (this.state === 'play') {
            this.playTime += realDt * this.speed;
            let n = 0;
            this._withSe(this.speed > 2, () => {
                while (!this.ended && !this.desynced && this.time() < this.playTime && n < 5000) { this.step(false); n++; }
            });
            if (this.ended && !this.desynced) this.state = 'end';
        }
        loop.drawOnly();
        if (this.onUi) this.onUi();
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

    seek(ms) {
        ms = Math.max(0, Math.min(this.duration, ms));
        const resume = (this.state === 'seek') ? this.seekResume : (this.state === 'play' ? 'play' : 'pause');
        if (ms < this.time() || this.ended || this.desynced) {
            this._withSe(true, () => this.restart());
        }
        this.seekTarget = ms;
        this.seekResume = resume;
        this.state = 'seek';
        if (this.onUi) this.onUi();
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
        for (const g of spec.games) if (g._rec) g._rec.detach();
        if (g0.loop.recorder) g0.loop.recorder.detach();
        if (g0.clock._feed) g0.clock.endFeed();
        new ReplayRecorder(Object.assign({ keysReady: true }, spec));
        this.resultReplay = null;
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
        if (pageId === 'result' || pageId === 'versus-result') {
            for (const id of ['result-replay-btn', 'versus-result-replay-btn']) {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = this.resultReplay ? '' : 'none';
            }
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

    // ─── 画面で見る ───
    watchResult() {
        if (this.resultReplay) this.watch(this.resultReplay, this.returnPage);
    },

    watch(data, returnPage) {
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
        p.ready(() => this._startWatch(p));
    },

    _startWatch(p) {
        const data = p.data;
        p.prepare();
        p.watching = true;
        this.player = p;
        this._bindUi();
        p.onUi = () => this._updateUi();
        if (typeof switchPage === 'function') switchPage(p.page);
        document.body.classList.add('replay-watching');
        // 古い版の録画（§7）
        this._msg(data.engine !== REPLAY_ENGINE_VERSION
            ? `v${data.app}（${data.build}）で録画されたリプレイです。今の版では途中からずれることがあります`
            : '');
        // BGM は等速で流し続ける（1 回だけ鳴らす。同じ曲が流れていればそのまま）
        if (window.BgmManager) window.BgmManager.play(p.mode.bgm(data));
        p.restart();
        p.play();
    },

    // 見るのをやめる（toBack: 来た画面へ戻る）
    _endWatch(toBack) {
        const p = this.player;
        if (!p) return;
        this.player = null;
        p.onUi = null;
        p.stop();
        document.body.classList.remove('replay-watching');
        if (toBack && typeof switchPage === 'function') {
            const back = (this.returnPage === 'result' || this.returnPage === 'versus-result') && !this.resultReplay ? 'main-menu' : this.returnPage;
            switchPage(back);
        }
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
        const exitBtn = $('replay-exit-btn');
        if (exitBtn) { exitBtn.onmousedown = (e) => e.preventDefault(); exitBtn.onclick = () => this._endWatch(true); }
        const speeds = $('replay-speeds');
        if (speeds) {
            speeds.innerHTML = '';
            REPLAY_SPEEDS.forEach((s) => {
                const b = document.createElement('button');
                b.className = 'replay-speed-btn';
                b.textContent = s + 'x';
                b.dataset.speed = String(s);
                b.onmousedown = (e) => e.preventDefault();
                b.onclick = () => { if (this.player) this.player.setSpeed(s); };
                speeds.appendChild(b);
            });
        }
        const seek = $('replay-seek');
        if (seek) {
            seek.addEventListener('input', () => { if (this.player) this.player.seek(Number(seek.value)); });
            seek.addEventListener('keydown', (e) => e.preventDefault()); // キーはまとめて下で受ける
        }
        // 見ている間のキー（ゲームのキー・ポーズ・リスタート・フォーカス移動には渡さない）
        this._keyHandler = (e) => {
            const p = this.player;
            if (!p || !p.watching) return;
            const gp = document.getElementById(p.page + '-page');
            if (!gp || !gp.classList.contains('active')) return;
            e.stopImmediatePropagation();
            const handled = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Tab'];
            if (handled.indexOf(e.code) < 0) return;
            e.preventDefault();
            if (e.repeat && (e.code === 'Space' || e.code === 'Escape')) return;
            const i = REPLAY_SPEEDS.indexOf(p.speed);
            switch (e.code) {
                case 'Space': this._togglePlay(); break;
                case 'ArrowLeft': p.seek(this._targetTime() - 5000); break;
                case 'ArrowRight': p.seek(this._targetTime() + 5000); break;
                case 'ArrowUp': p.setSpeed(REPLAY_SPEEDS[Math.min(REPLAY_SPEEDS.length - 1, i + 1)]); break;
                case 'ArrowDown': p.setSpeed(REPLAY_SPEEDS[Math.max(0, i - 1)]); break;
                case 'Escape': this._endWatch(true); break;
            }
        };
        window.addEventListener('keydown', this._keyHandler, true);
    },

    // シーク中は向かっている時刻から数える（←→ を続けて押したとき）
    _targetTime() {
        const p = this.player;
        return p.state === 'seek' ? p.seekTarget : p.time();
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
        const t = Math.min(p.duration, p.time());
        const seek = $('replay-seek');
        if (seek) {
            seek.max = String(Math.max(1, Math.round(p.duration)));
            if (document.activeElement !== seek || p.state !== 'seek') seek.value = String(Math.round(p.state === 'seek' ? p.seekTarget : t));
        }
        const timeEl = $('replay-time');
        if (timeEl) timeEl.textContent = replayFmtTime(t) + ' / ' + replayFmtTime(p.duration);
        const playing = p.state === 'play' || (p.state === 'seek' && p.seekResume === 'play');
        const playBtn = $('replay-play-btn');
        if (playBtn) playBtn.textContent = playing ? '❚❚' : '▶';
        const st = $('replay-state');
        if (st) st.textContent = p.state === 'seek' ? 'SEEK' : (p.state === 'end' ? 'END' : (p.state === 'desync' ? 'STOP' : (playing ? '' : 'PAUSE')));
        document.querySelectorAll('#replay-speeds .replay-speed-btn').forEach((b) => {
            b.classList.toggle('active', Number(b.dataset.speed) === p.speed);
        });
        if (p.state === 'desync' && !p._desyncShown) {
            p._desyncShown = true;
            const d = p.data;
            this._msg(`ここから先はこの版では正しく再生できません（録画: v${d.app} / ${d.build}）`);
            console.warn('[replay] ずれ:', p.desyncInfo);
        }
    },
};
window.ReplayManager = ReplayManager;

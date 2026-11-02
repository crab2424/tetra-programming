// ─────────────────────────────────────────────
// replay.js — 録画・再生（M5: tet シングル MARATHON / SPRINT / ULTRA）
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §5〜§7・§12
//   ・エンジンは決定的（M0〜M4）なので、録画は「シード・時計を進めた量の列・入力」だけを残す。
//       時計を進めた量: game_clock.js の advance() のたびに 1/16ms 単位で書く（_tape）。フレームの外の advance
//                       （runCountdown の頭など）も同じ順に通るので、そのまま 1 本の列にする。
//       入力: フレームの頭で取り込んだ人のキー・パッド（届いた瞬間でなく取り込んだフレームで残す）、
//             ポーズ・再開（次のフレームの頭の出来事）、ゲーム画面が出ていなくて入力を取り込まなかったフレームの印。
//       設置ごとの盤面のハッシュ（ずれの検出。§7）。
//   ・再生は本物の Game に同じシード・同じ時刻で start() し、時計は記録した量で進め（_feed）、
//     入力はフレームの頭で _inputQueue に入れる。人のキー・パッドは受けない（input.js）。
//     試合の親ループ（match_loop.js）に driver として入り、rAF ごとに何フレーム進めるかを決める（倍速・シーク）。
//   ・シーク（M5）: 前へは描かずに早送り、戻るときは最初からやり直して早送り。速いシークはスナップショット（M7）。
//   ・音（§5.2）: BGM は等速で流し続ける（再生の頭で 1 回だけ）。SE は 2 倍まで鳴らし、それより速いとき・シーク中は鳴らさない。
//   ・ずれたら止める（§7）。動きを変える修正をしたら REPLAY_ENGINE_VERSION を上げる。
//   ・コンソール: ReplayManager.verify() で直前のリプレイを描かずに最初から再生し、ハッシュを全部照らし合わせる。
//     localStorage.replayAutoVerify = '1' なら、リザルト画面に入るたびに自動で照らし合わせてコンソールに出す。
// ─────────────────────────────────────────────

const REPLAY_FORMAT_VERSION = 1;   // ファイルの形の版（§6.2）
const REPLAY_ENGINE_VERSION = 1;   // エンジンの動きの版（§7）。動きを変える修正をしたら上げる

// 入力の列の種類（1 バイト）。キーは 0〜3（bit0 押す・bit1 長押しの繰り返し）、パッドは 4〜5（bit0 押す）
const REPLAY_EV_PAD = 4;
const REPLAY_EV_PAUSE = 8;
const REPLAY_EV_RESUME = 9;
const REPLAY_EV_SKIP = 10;          // このフレームはゲーム画面が出ていなくて入力を取り込まなかった
const REPLAY_PAD_ACTIONS = ['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'hold'];
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const REPLAY_MODES = ['marathon', 'sprint', 'ultra'];

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
        this._room(5);
        while (v >= 0x80) {
            this.a[this.n++] = (v & 0x7f) | 0x80;
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

// 設置ごとの盤面のハッシュ（4 バイト）。盤面・得点・ライン・レベル・REN・B2B・HOLD・NEXT・時刻
function replayTetHash(g, t0) {
    let h = 0x811c9dc5 | 0;
    const w = (v) => {
        h = Math.imul(h ^ (v | 0), 0x01000193);
        h ^= h >>> 15;
    };
    const bs = g.field.blocks;
    w(bs.length);
    for (let i = 0; i < bs.length; i++) w(((bs[i].y + 16) * 16 + bs[i].x) * 16 + (bs[i].type | 0));
    w(g.score);
    w(g.lines);
    w(g.level);
    w(g.ren);
    w(g.backToBack ? 1 : 0);
    w(g.holdMino ? g.holdMino.type + 1 : 0);
    const nq = g.nextQueue;
    for (let i = 0; i < nq.length && i < 7; i++) w(nq[i].type);
    w(Math.round((g.clock.now() - t0) * 16));
    return h >>> 0;
}

// 結果に響く盤面の設定（PRACTICE などが残した値も含めて、録画したときと同じにする）
function replayTetEnv(g) {
    return {
        gravityDisabled: !!g.gravityDisabled,
        practiceNoLock: !!g.practiceNoLock,
        practiceFallSpeedMs: (typeof g.practiceFallSpeedMs === 'number') ? g.practiceFallSpeedMs : null,
        practiceHoldMode: g.practiceHoldMode || null,
        lockDelay: g.lockDelay,
    };
}

function replayFmtTime(ms) {
    ms = Math.max(0, ms);
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// ─── 録画（1 試合ぶん）───
class ReplayRecorder {
    constructor(g) {
        this.mode = g.mode;
        this.seed = GameRng.toHex(g.matchSeed);
        this.t0 = g.clock.now();
        this.settings = {
            marathonGoal: (g.marathonGoal === Infinity) ? 'endless' : (g.marathonGoal || null),
            marathonStartLevel: g.marathonStartLevel || 1,
            env: replayTetEnv(g),
        };
        this.dts = new ReplayBuf(16384);
        this.events = new ReplayBuf(4096);
        this.checks = new ReplayBuf(1024);
        this.codes = [];
        this._codeIdx = new Map();
        this.nFrames = 0;   // 回ったフレームの数
        this.cur = 0;       // 今のフレームの番号
        this._lastEv = 0;
        g.clock._tape = this.dts;
    }

    beginFrame() {
        this.cur = this.nFrames++;
    }

    _ev(frame, kind) {
        if (frame < this._lastEv) frame = this._lastEv; // フレームの中でポーズされたとき（起きない想定。起きればハッシュで分かる）
        this.events.varint(frame - this._lastEv);
        this._lastEv = frame;
        this.events.byte(kind);
    }

    input(ev) {
        if (ev.pad) {
            const i = REPLAY_PAD_ACTIONS.indexOf(ev.action);
            if (i < 0) return;
            this._ev(this.cur, REPLAY_EV_PAD | (ev.down ? 1 : 0));
            this.events.varint(i);
        } else {
            let i = this._codeIdx.get(ev.code);
            if (i === undefined) {
                i = this.codes.length;
                this.codes.push(ev.code);
                this._codeIdx.set(ev.code, i);
            }
            this._ev(this.cur, (ev.down ? 1 : 0) | (ev.repeat ? 2 : 0));
            this.events.varint(i);
        }
    }

    // ポーズ・再開はフレームの間で起きるので、次のフレームの頭の出来事として残す
    pause(on) {
        this._ev(this.nFrames, on ? REPLAY_EV_PAUSE : REPLAY_EV_RESUME);
    }

    skipPoll() {
        this._ev(this.cur, REPLAY_EV_SKIP);
    }

    lock(g) {
        this.checks.u32(replayTetHash(g, this.t0));
    }

    // ファイルの中身（§6.1）
    finish(g, isClear) {
        const keys = {};
        const ku = g._keysUsed || {};
        for (const action in ku) keys[action] = (ku[action].codes || []).slice();
        const b = window.TETLABO_BUILD || {};
        const mode = this.mode;
        return {
            format: 'tetlabo-replay',
            formatVersion: REPLAY_FORMAT_VERSION,
            engine: REPLAY_ENGINE_VERSION,
            app: b.app || '?',
            build: b.build || '?',
            id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
            recordedAt: new Date().toISOString(),
            seed: this.seed,
            mode,
            modeOption: mode === 'marathon' ? String(this.settings.marathonGoal) : null,
            settings: {
                marathonGoal: this.settings.marathonGoal,
                marathonStartLevel: this.settings.marathonStartLevel,
                env: this.settings.env,
                tuning: JSON.parse(JSON.stringify(g._tuningUsed || {})),
                keys,
            },
            players: [{ name: 'PLAYER', kind: 'human', rule: 'tet' }],
            t0: this.t0,
            durationMs: g.clock.now() - this.t0,
            frameCount: this.nFrames,
            result: {
                clear: !!isClear,
                score: g.score,
                lines: g.lines,
                level: g.level,
                timeMs: g.elapsedTime,
            },
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

// ─── 再生（1 本のリプレイ）───
class ReplayPlayer {
    constructor(data) {
        if (!data || data.format !== 'tetlabo-replay') throw new Error('リプレイのファイルではありません');
        if (data.formatVersion > REPLAY_FORMAT_VERSION) throw new Error('新しい版で作られたリプレイです');
        if (REPLAY_MODES.indexOf(data.mode) < 0) throw new Error('このモードのリプレイはまだ再生できません: ' + data.mode);
        this.data = data;
        this.seed = GameRng.fromHex(data.seed);
        this.t0 = data.t0;
        this.duration = data.durationMs || 0;
        this.codes = data.codes || [];
        const keys = {};
        const sk = (data.settings && data.settings.keys) || {};
        for (const action in sk) keys[action] = { codes: sk[action].slice(), code: sk[action][0] || '', label: '' };
        this.keys = keys;
        this.tuning = (data.settings && data.settings.tuning) || {};
        this.dtBytes = replayFromB64(data.frames);
        // 入力の列をほどいておく
        const r = new ReplayReader(replayFromB64(data.inputs));
        const fr = [], kd = [], ix = [];
        let f = 0;
        while (!r.done) {
            f += r.varint();
            const k = r.byte();
            fr.push(f);
            kd.push(k);
            ix.push(k < REPLAY_EV_PAUSE ? r.varint() : 0);
        }
        this.evFrame = fr;
        this.evKind = kd;
        this.evIdx = ix;
        const cb = replayFromB64(data.checks);
        this.checks = [];
        for (let i = 0; i + 3 < cb.length; i += 4) this.checks.push((cb[i] | (cb[i + 1] << 8) | (cb[i + 2] << 16) | (cb[i + 3] << 24)) >>> 0);

        this.game = null;
        this.loop = null;
        this.speed = 1;
        this.state = 'pause';     // play / pause / seek / end / desync
        this.watching = false;    // 画面に出して見ている（verify は false）
        this.onUi = null;
        this._resetCounters();
    }

    _resetCounters() {
        this.nUpdates = 0;
        this.ep = 0;
        this.checkIdx = 0;
        this.skipPoll = false;
        this.ended = false;
        this.desynced = false;
        this.desyncInfo = null;
        this.playTime = 0;
        this.seekTarget = 0;
        this.seekResume = 'pause';
        this._lastReal = null;
    }

    // 盤面を録画したときの設定にする（見終わったら restore で戻す）
    prepare(g) {
        this.game = g;
        this.loop = g.loop;
        const s = this.data.settings || {};
        const env = s.env || {};
        this._saved = {
            currentMode: g.currentMode, marathonGoal: g.marathonGoal, marathonStartLevel: g.marathonStartLevel,
            env: replayTetEnv(g),
        };
        g.currentMode = this.data.mode;
        g.isVersusMode = false;
        g.isCpuControlled = false;
        g.marathonGoal = (s.marathonGoal === 'endless') ? Infinity : (s.marathonGoal || 150);
        g.marathonStartLevel = s.marathonStartLevel || 1;
        this._applyEnv(g, env);
    }

    _applyEnv(g, env) {
        g.gravityDisabled = !!env.gravityDisabled;
        g.practiceNoLock = !!env.practiceNoLock;
        g.practiceFallSpeedMs = (typeof env.practiceFallSpeedMs === 'number') ? env.practiceFallSpeedMs : null;
        g.practiceHoldMode = env.practiceHoldMode || undefined;
        if (typeof env.lockDelay === 'number') g.lockDelay = env.lockDelay;
    }

    restore() {
        const g = this.game, sv = this._saved;
        if (!g || !sv) return;
        g.currentMode = sv.currentMode;
        g.marathonGoal = sv.marathonGoal;
        g.marathonStartLevel = sv.marathonStartLevel;
        this._applyEnv(g, sv.env);
        this._saved = null;
    }

    // 最初から（同じシード・同じ時刻で start() する。時計と入力は begin → attach で録画に合わせる）
    restart() {
        const g = this.game;
        // 前の回の予約（カウントダウンの途中など）を捨て、_initGameState の頭の advance() が古い列を読まないようにする
        g.clock.reset(g.clock.now());
        g.clock._feed = null;
        this._resetCounters();
        g._replay = this;
        g._rec = null;
        g.nextMatchSeed = this.seed.slice();
        this.loop.driver = this;
        g.start();
    }

    // _initGameState の中（乱数を作った直後）から呼ばれる
    attach(g) {
        g._rec = null;
        g.clock.reset(this.t0);
        g.clock._tape = null;
        g.clock._feed = new ReplayReader(this.dtBytes);
    }

    time() {
        return this.game.clock.now() - this.t0;
    }

    _applyEvent(g, k, idx) {
        if (k < REPLAY_EV_PAD) g._inputQueue.push({ pad: false, down: !!(k & 1), code: this.codes[idx], repeat: !!(k & 2) });
        else if (k < REPLAY_EV_PAUSE) g._inputQueue.push({ pad: true, down: !!(k & 1), action: REPLAY_PAD_ACTIONS[idx] });
        else if (k === REPLAY_EV_PAUSE) g.pause();
        else if (k === REPLAY_EV_RESUME) g.resume();
        else if (k === REPLAY_EV_SKIP) this.skipPoll = true;
    }

    // フレームの頭（render.js の _frameUpdate）: このフレームで取り込まれた入力を入れる
    beginFrame(g) {
        const f = this.nUpdates++;
        this.skipPoll = false;
        while (this.ep < this.evFrame.length && this.evFrame[this.ep] <= f) {
            this._applyEvent(g, this.evKind[this.ep], this.evIdx[this.ep]);
            this.ep++;
        }
    }

    // 1 フレーム進める。ポーズ・再開はフレームの頭（時計を進める前）に入れる
    step(draw) {
        const g = this.game;
        const f = this.nUpdates;
        while (this.ep < this.evFrame.length && this.evFrame[this.ep] === f &&
            (this.evKind[this.ep] === REPLAY_EV_PAUSE || this.evKind[this.ep] === REPLAY_EV_RESUME)) {
            this._applyEvent(g, this.evKind[this.ep], 0);
            this.ep++;
        }
        this.loop.step(draw);
        if (this.ended || this.desynced) return;
        if (!this.loop.has(g)) {
            this.ended = true; // 盤面がループから抜けた（ゲームオーバー以外で終わった）
        } else if (this.nUpdates > (this.data.frameCount || 0) + 600) {
            this._desync('記録したフレームを過ぎても終わらない');
        }
    }

    onLock(g) {
        if (this.desynced) return;
        const i = this.checkIdx++;
        if (i >= this.checks.length || replayTetHash(g, this.t0) !== this.checks[i]) {
            this._desync(i >= this.checks.length ? '記録より設置が多い' : `${i + 1} 手目の盤面が合わない`, i);
        }
    }

    onGameOver(g, isClear) {
        if (this.desynced) return;
        this.ended = true;
        const r = this.data.result || {};
        if (this.checkIdx !== this.checks.length) {
            this._desync(`設置の数が合わない（録画 ${this.checks.length}・再生 ${this.checkIdx}）`, this.checkIdx);
        } else if (r.score !== g.score || r.lines !== g.lines || !!r.clear !== !!isClear) {
            this._desync('結果が合わない', this.checkIdx);
        }
    }

    _desync(reason, lockIdx) {
        this.desynced = true;
        this.desyncInfo = { reason, lock: lockIdx, timeMs: this.time(), frame: this.nUpdates };
        this.state = 'desync';
        // 盤面はそこで止める（フレームを回さない）
        this.game.stopRenderLoop();
        if (this.onUi) this.onUi();
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
        if (this.state === 'end' || this.ended) {
            this.restart();
        }
        this.state = 'play';
        this._lastReal = null;
        this.playTime = this.time();
        this._kick();
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
        this._kick();
    }

    setSpeed(s) {
        this.speed = s;
        if (this.onUi) this.onUi();
    }

    // 盤面がループにいれば rAF は回っている。いなければ（終わった後）UI だけ合わせる
    _kick() {
        if (this.onUi) this.onUi();
    }

    // 再生をやめて盤面を止める
    stop() {
        const g = this.game;
        if (!g) return;
        if (this.loop && this.loop.driver === this) this.loop.driver = null;
        g.stopRenderLoop();
        if (g.timer) { clearInterval(g.timer); g.timer = null; }
        g._cancelLockTimer();
        g._cancelGarbageTimers();
        g.isPaused = true;
        g.isTimerRunning = false;
        g.clock.endFeed();
        g._replay = null;
        g.nextMatchSeed = null;
        g.clock.resume();
        const ov = document.getElementById('countdown-overlay');
        if (ov && typeof cancelCountdownTimer === 'function') {
            cancelCountdownTimer(ov);
            ov.classList.remove('active');
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
    _keyHandler: null,
    _uiBound: false,

    // tet の _initGameState（乱数を作った直後）から呼ばれる
    begin(g) {
        if (g._replay) { g._replay.attach(g); return; }
        g._rec = null;
        g.clock._tape = null;
        if (g.clock._feed) g.clock.endFeed();
        if (!g.isVersusMode && !g.isCpuControlled && !g.canvasPrefix && REPLAY_MODES.indexOf(g.currentMode) >= 0) {
            g._rec = new ReplayRecorder(g);
            this.resultReplay = null;
        }
    },

    // tet の gameOver から呼ばれる（録画中のとき）
    finish(g, isClear) {
        const rec = g._rec;
        g._rec = null;
        if (g.clock._tape === rec.dts) g.clock._tape = null;
        if (g.currentMode !== rec.mode || g.mode !== rec.mode) return; // 別のモード（PRACTICE 等）に使い回された録画は捨てる
        let data;
        try {
            data = rec.finish(g, isClear);
        } catch (e) {
            console.warn('[replay] 録画を締められませんでした', e);
            return;
        }
        this.last = data;
        this.resultReplay = data;
        this._verified = false;
    },

    // navigation.js の switchPage から（ページが変わるたび）
    onSwitchPage(pageId) {
        if (this.player && this.player.watching && pageId !== 'game') this._endWatch(false);
        if (pageId === 'result') {
            const btn = document.getElementById('result-replay-btn');
            if (btn) btn.style.display = this.resultReplay ? '' : 'none';
            let auto = false;
            try { auto = localStorage.getItem('replayAutoVerify') === '1'; } catch (e) { /* 使えない */ }
            if (auto && this.resultReplay && !this._verified) {
                this._verified = true;
                this.verify(this.resultReplay);
            }
        } else if (pageId !== 'game') {
            this.resultReplay = null;
        }
    },

    // 描かずに最初から再生し、設置ごとのハッシュを全部照らし合わせる（コンソール・開発用）
    verify(data = this.last) {
        if (!data) { console.warn('[replay] リプレイがありません'); return null; }
        const g = window._game;
        if (!g || (g._renderLoopId && !g._replay) || this.player) {
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
        const t = performance.now();
        p.prepare(g);
        let steps = 0;
        const limit = (data.frameCount || 0) + 1000;
        p._withSe(true, () => {
            p.restart();
            while (!p.ended && !p.desynced && steps < limit) { p.step(false); steps++; }
        });
        const res = {
            ok: !p.desynced && p.ended && p.checkIdx === p.checks.length,
            locks: p.checks.length,
            matched: p.desynced ? (p.desyncInfo.lock || 0) : p.checkIdx,
            frames: p.nUpdates,
            recordedFrames: data.frameCount,
            score: g.score,
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
        if (this.resultReplay) this.watch(this.resultReplay);
    },

    watch(data) {
        if (this.player) this._endWatch(false);
        let p;
        try {
            p = new ReplayPlayer(data);
        } catch (e) {
            if (typeof showGlobalToast === 'function') showGlobalToast(e.message);
            else console.warn('[replay]', e.message);
            return;
        }
        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(false);
        if (!window._game || typeof window._game.initMainCanvas !== 'function') window._game = new Game();
        const g = window._game;
        if (window.GameManager && GameManager.setInstance) GameManager.setInstance('p1', g);
        g.canvasPrefix = null;
        g.statsPrefix = null;
        g._labelsInitialized = false;
        g.initMainCanvas();
        g.initNextCanvas();
        g.initHoldCanvas();
        const evalArea = document.getElementById('eval-area');
        if (evalArea) evalArea.style.display = 'none';
        const ga = document.getElementById('test-garbage-area');
        if (ga) ga.style.display = 'none';

        p.prepare(g);
        p.watching = true;
        this.player = p;
        this._bindUi();
        p.onUi = () => this._updateUi();
        if (typeof switchPage === 'function') switchPage('game');
        if (typeof updateLinesGoalDisplay === 'function') updateLinesGoalDisplay(data.mode);
        document.body.classList.add('replay-watching');
        // 古い版の録画（§7）
        this._msg(data.engine !== REPLAY_ENGINE_VERSION
            ? `v${data.app}（${data.build}）で録画されたリプレイです。今の版では途中からずれることがあります`
            : '');
        // BGM は等速で流し続ける（1 回だけ鳴らす。同じ曲が流れていればそのまま）
        if (window.BgmManager) window.BgmManager.play(window.BgmManager.singleBgmKey(data.mode));
        p.restart();
        p.play();
    },

    // 見るのをやめる（toResult: リザルト画面へ戻る）
    _endWatch(toResult) {
        const p = this.player;
        if (!p) return;
        this.player = null;
        p.onUi = null;
        p.stop();
        document.body.classList.remove('replay-watching');
        if (toResult && typeof switchPage === 'function') switchPage(this.resultReplay ? 'result' : 'mode-check');
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
            const gp = document.getElementById('game-page');
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

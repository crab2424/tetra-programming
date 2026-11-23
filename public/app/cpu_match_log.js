// ─────────────────────────────────────────────
// cpu_match_log.js — CPU TEST の CPU 同士（OPPONENT: PUYO / TET）の対局記録（window.CpuMatchLog）
//   1局ごとに 勝敗・TSD/TSS/TST・4-LINES・PC・APM・負け方 などを記録し、JSON / CSV で書き出す。
//   lv6 と参考AI clys の実機比較用（設計 source_assets/memory/cpu/tet/clys-port-design.md §7）。
//
//   ・begin(sides)  … versus.js startVersusGame（CPU TEST から始めた CPU 同士のときだけ）
//   ・end(loser)    … versus.js versusGameOver（'player' = 1P の負け / 'cpu' = 2P の負け）
//   ・テトの集計は Game.prototype の Scoring / applyGarbage / gameOver を包んで取る（記録中の盤面だけ数える）
//   ・記録は localStorage（tetlabo.cpuMatchLog）に残す。途中でやめた局（リスタート・中断）は残さない
//   ・画面左下の小さな欄に件数・勝敗と EXPORT（JSON / CSV）・CLEAR を出す（対戦画面で記録中のときだけ）
//   ・AUTO（自動再戦）を ON にすると、結果画面が出てから AUTO_DELAY_MS 後に RETRY と同じ再戦を始める（放置で回す用）。
//     ON/OFF は localStorage（tetlabo.cpuMatchLog.auto）に残す。結果画面から離れたら取りやめる
//   ・REPLAY（リプレイの自動保存）: ALL＝ふだんどおり（SETTINGS › DISPLAY の自動保存に従う）/ FILTER＝条件を満たした局だけ
//     保存（自動保存 OFF でも残す）/ OFF＝自動では残さない。条件は TIME（分）・SCORE・CHAIN（ぷよ）・ATTACK の下限で、
//     空欄は使わない。ALL（すべて満たす）か ANY（どれか 1 つ）。SCORE・CHAIN・ATTACK はどちらかの盤面が届けばよい。
//     localStorage（tetlabo.cpuMatchLog.replay）。判定は app/replays.js の ReplayManager.onRecorded から replayDecision(data)
//   ・コンソール: CpuMatchLog.matches() / CpuMatchLog.download('csv') / CpuMatchLog.clear() / CpuMatchLog.setAuto(true)
// ─────────────────────────────────────────────

window.CpuMatchLog = (() => {
    const STORE_KEY = 'tetlabo.cpuMatchLog';
    const AUTO_KEY = 'tetlabo.cpuMatchLog.auto';
    const AUTO_DELAY_MS = 2000;      // 結果画面が出てから再戦するまで
    const GARBAGE_DEATH_MS = 3000;   // 死ぬ直前この時間内にせり上がりがあれば「おじゃまで押し上げ」

    const REPLAY_KEY = 'tetlabo.cpuMatchLog.replay';
    const REPLAY_FIELDS = [   // [キー, 見出し, 単位, 盤面の値の取り出し]
        ['minMin', 'TIME', '分'],
        ['minScore', 'SCORE', '点'],
        ['minChain', 'CHAIN', '連鎖'],
        ['minAttack', 'ATTACK', ''],
    ];

    let current = null;   // 記録中の1局 { startedAt, sides: { '1P': side, '2P': side } }
    let dock = null;
    let autoTimer = null;

    function isAuto() {
        try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (_) { return false; }
    }
    function setAuto(on) {
        try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (_) { /* noop */ }
        if (!on) cancelAuto();
        else if (window.BattleVersusLifecycle && window.BattleVersusLifecycle.phase === 'roundResult') scheduleAuto();
        renderDock();
    }
    function cancelAuto() {
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    }
    function onResultPage() {
        const el = document.getElementById('versus-result-page');
        return !!el && el.classList.contains('active');
    }
    // 結果画面（lifecycle の roundResult）になるのを待ってから、少し置いて再戦する
    function scheduleAuto() {
        cancelAuto();
        const t0 = now();
        const tick = () => {
            autoTimer = null;
            if (!isAuto()) return;
            const lc = window.BattleVersusLifecycle;
            if (lc && lc.phase === 'roundResult' && onResultPage()) {
                autoTimer = setTimeout(() => {
                    autoTimer = null;
                    if (isAuto() && onResultPage() && typeof restartVersusFromResult === 'function') restartVersusFromResult();
                }, AUTO_DELAY_MS);
                return;
            }
            if (now() - t0 < 20000) autoTimer = setTimeout(tick, 200);   // 終了演出の途中。20秒たっても結果画面が出なければやめる
        };
        autoTimer = setTimeout(tick, 200);
    }

    // ── リプレイの自動保存の条件 ──
    function replayFilter() {
        let f = null;
        try { f = JSON.parse(localStorage.getItem(REPLAY_KEY) || 'null'); } catch (_) { f = null; }
        if (!f || typeof f !== 'object') f = {};
        const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
        return {
            mode: (f.mode === 'filter' || f.mode === 'off') ? f.mode : 'all',
            match: f.match === 'any' ? 'any' : 'all',
            minMin: num(f.minMin), minScore: num(f.minScore), minChain: num(f.minChain), minAttack: num(f.minAttack),
            saved: (typeof f.saved === 'number' && f.saved > 0) ? f.saved : 0,
        };
    }
    function setReplayFilter(patch) {
        const f = Object.assign(replayFilter(), patch || {});
        try { localStorage.setItem(REPLAY_KEY, JSON.stringify(f)); } catch (_) { /* noop */ }
        renderDock();
        return f;
    }
    function isCpuVsCpuReplay(data) {
        const pl = (data && data.players) || [];
        return !!data && data.mode === 'versus' && pl.length === 2 && pl.every((p) => p.kind === 'cpu');
    }
    // リプレイの値（durationMs・result.boards[].score / chainMax / attack）が条件を満たすか。
    // CHAIN はぷよの盤面だけを見る（ぷよが無い試合では CHAIN の条件は使わない）
    function replayMeets(data, f) {
        const boards = (data.result && data.result.boards) || [];
        const max = (k) => boards.reduce((m, b) => (typeof b[k] === 'number' && b[k] > m ? b[k] : m), 0);
        const checks = [];
        if (f.minMin) checks.push((data.durationMs || 0) >= f.minMin * 60000);
        if (f.minScore) checks.push(max('score') >= f.minScore);
        if (f.minChain && boards.some((b) => typeof b.chainMax === 'number')) checks.push(max('chainMax') >= f.minChain);
        if (f.minAttack) checks.push(max('attack') >= f.minAttack);
        if (!checks.length) return true; // 条件なし＝全部残す
        return f.match === 'any' ? checks.some(Boolean) : checks.every(Boolean);
    }
    // app/replays.js から: CPU 同士の局なら 'save' / 'skip'、それ以外（人の対戦など）は null＝ふだんどおり
    function replayDecision(data) {
        if (!isCpuVsCpuReplay(data)) return null;
        const f = replayFilter();
        if (f.mode === 'all') return null;
        if (f.mode === 'off') return 'skip';
        const ok = replayMeets(data, f);
        if (ok) setReplayFilter({ saved: f.saved + 1 });
        return ok ? 'save' : 'skip';
    }
    function replayFilterText(f) {
        if (f.mode === 'off') return 'REPLAY: 自動保存しない';
        if (f.mode === 'all') return 'REPLAY: ふだんどおり（DISPLAY の自動保存）';
        const parts = REPLAY_FIELDS.filter(([k]) => f[k]).map(([k, label, unit]) => `${label} ≥ ${f[k].toLocaleString()}${unit}`);
        const cond = parts.length ? parts.join(f.match === 'any' ? ' or ' : ' and ') : '条件なし（全部）';
        return `REPLAY: ${cond}（保存 ${f.saved} 本）`;
    }

    function load() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (_) { return []; }
    }
    function save(list) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (_) { /* 容量超過等は諦める */ }
    }

    function now() { return performance.now(); }

    // ── テトの盤面ごとの集計 ──
    function newTetStats() {
        return {
            pieces: 0, lines: 0, attack: 0, tss: 0, tsd: 0, tst: 0, tsMini: 0, tetrises: 0, pcs: 0, b2b: 0,
            maxRen: 0, maxSpike: 0, spikeRun: 0, garbageTaken: 0, lastGarbageAt: null,
            garbageLog: [],   // [時刻, 段数]（死ぬ直前の判定用）
            zones: 0, zoneLinesMax: 0, zoneAttack: 0,
            zoneLog: [],      // ZONE 1 回ごと { q: 発動時の 1/4 の数, h: 発動した時点の高さ, lines, attack: 出した火力の合計, normal: うち発動中の通常火力（補正前）,
                              //   phase: 発動時のフェーズ（ZONE BATTLE のフェーズありだけ）, why: CPU の発動の理由（cpu_zone.js decide） }
        };
    }

    function sideOf(game) {
        if (!current || !game) return null;
        for (const k of ['1P', '2P']) if (current.sides[k].game === game) return current.sides[k];
        return null;
    }

    function stackHeight(game) {
        let top = 20;
        for (const b of (game.field && game.field.blocks) || []) top = Math.min(top, b.y);
        return 20 - top;
    }

    function incomingOf(game) {
        let n = 0;
        for (const g of game.garbageQueue || []) if (!g.internal) n += g.amount;
        return n;
    }

    // ZONE の発動・終了（game/tet/zone.js から。VERSUS の ZONE が ON のときだけ来る）
    function zone(game, phase, charge, lines, attack, normal) {
        const s = sideOf(game);
        if (!s || !s.tet) return;
        const t = s.tet;
        if (phase === 'start') {
            t.zones++;
            const e = { q: charge, h: stackHeight(game), lines: null, attack: null };
            if (game.matchPhase) e.phase = game.matchPhase;
            if (s.cpu && s.cpu.zoneWhy) e.why = s.cpu.zoneWhy;
            t.zoneLog.push(e);
        } else {
            const last = t.zoneLog[t.zoneLog.length - 1];
            if (last && last.lines === null) { last.lines = lines; last.attack = attack; last.normal = normal || 0; }
            if (lines > t.zoneLinesMax) t.zoneLinesMax = lines;
            t.zoneAttack += attack;
        }
    }

    // ZONE BATTLE のフェーズが進んだ（game/tet/zone.js _zoneSetPhase。1P の盤面から 1 回だけ来る）。
    // 操作が始まってからの秒と、そのときの両者のスコアを残す
    function phase(game, p) {
        if (!current || !sideOf(game)) return;
        const s1 = current.sides['1P'], s2 = current.sides['2P'];
        const starts = [s1.startedAt, s2.startedAt].filter(v => v !== null);
        const sec = starts.length ? +((now() - Math.min(...starts)) / 1000).toFixed(1) : 0;
        (current.phaseLog || (current.phaseLog = [])).push({
            p, sec, score: [s1.game ? s1.game.score || 0 : 0, s2.game ? s2.game.score || 0 : 0],
        });
    }

    let hooked = false;
    function installHooks() {
        if (hooked || typeof Game === 'undefined') return;
        hooked = true;
        const P = Game.prototype;

        const origScoring = P.Scoring;
        P.Scoring = function(tSpinType, linesCleared, isPerfectClear = false) {
            const b2bBefore = this.backToBack;
            const renBefore = this.ren || 0;
            const atk = origScoring.call(this, tSpinType, linesCleared, isPerfectClear);
            const s = sideOf(this);
            if (s && s.tet) {
                const t = s.tet;
                t.pieces++;
                t.lines += linesCleared;
                if (tSpinType === 'tspin' && linesCleared === 1) t.tss++;
                if (tSpinType === 'tspin' && linesCleared === 2) t.tsd++;
                if (tSpinType === 'tspin' && linesCleared >= 3) t.tst++;
                if (tSpinType === 'mini' && linesCleared > 0) t.tsMini++;
                if (linesCleared === 4) t.tetrises++;
                if (isPerfectClear) t.pcs++;
                if (linesCleared > 0 && (linesCleared === 4 || tSpinType !== null) && b2bBefore) t.b2b++;
                const mult = this.isVersusMode ? (this.vsAttackMultiplier ?? 1.0) : 1.0;
                const a = (atk || 0) * mult;
                t.attack += a;
                if (linesCleared > 0) {
                    t.spikeRun += a;
                    t.maxSpike = Math.max(t.maxSpike, t.spikeRun);
                    t.maxRen = Math.max(t.maxRen, renBefore + 1);
                } else {
                    t.spikeRun = 0;
                }
            }
            return atk;
        };

        // 着弾待ち（ready・internal 以外）の段数。applyGarbage の前後の差がせり上がった段数
        const readyLines = (g) => (g.garbageQueue || []).reduce((n, q) => n + (q.ready && !q.internal ? q.amount : 0), 0);
        const origApply = P.applyGarbage;
        P.applyGarbage = function() {
            const s = sideOf(this);
            const before = s && s.tet ? readyLines(this) : 0;
            const r = origApply.apply(this, arguments);
            if (s && s.tet) {
                const lines = before - readyLines(this);
                if (lines > 0) {
                    s.tet.garbageTaken += lines;
                    s.tet.lastGarbageAt = now();
                    s.tet.garbageLog.push([now(), lines]);
                    if (s.tet.garbageLog.length > 20) s.tet.garbageLog.shift();
                }
            }
            return r;
        };

        const origOver = P.gameOver;
        P.gameOver = function(isClear = false) {
            const s = sideOf(this);
            if (s && s.tet && !isClear && !s.death) s.death = deathInfo(this, s);
            return origOver.apply(this, arguments);
        };
    }

    // 負け方：死んだ瞬間の盤面と、直前のおじゃま
    function deathInfo(game, s) {
        const t = now();
        const recent = s.tet.garbageLog.filter(([at]) => t - at <= GARBAGE_DEATH_MS).reduce((n, [, l]) => n + l, 0);
        const cpu = s.cpu;
        return {
            // lockout＝置いたミノが全部見えない段（設置で死亡）／blockout＝次のミノが出せない（出現位置が塞がった）
            reason: game.mino === null ? 'lockout' : 'blockout',
            kind: recent > 0 ? 'garbage' : 'stack',   // garbage＝直前 3 秒のせり上がりで死亡／stack＝自分の積み上げで死亡
            stackHeight: stackHeight(game),
            incoming: incomingOf(game),
            garbageLast3s: recent,
            lastGarbageAgoMs: s.tet.lastGarbageAt === null ? null : Math.round(t - s.tet.lastGarbageAt),
            inPCSequence: !!(cpu && cpu.pcSequence),
            b2b: !!game.backToBack,
            ren: game.ren || 0,
        };
    }

    function cpuInfo(cpu) {
        if (!cpu) return {};
        const o = { className: cpu.constructor && cpu.constructor.name };
        if (cpu.disablePC !== undefined) o.disablePC = !!(cpu.disablePC ?? window.__cpu6DisablePC);
        if (cpu.thinkMs !== undefined) o.thinkMs = cpu.thinkMs;
        return o;
    }

    // sides: { '1P': { game, cpu, rule, label }, '2P': {...} }
    function begin(sides) {
        installHooks();
        current = { startedAt: null, sides: {} };
        for (const k of ['1P', '2P']) {
            const sd = sides[k];
            const side = { game: sd.game, cpu: sd.cpu, rule: sd.rule, label: sd.label, info: cpuInfo(sd.cpu),
                           tet: sd.rule === 'tet' ? newTetStats() : null, death: null, startedAt: null };
            current.sides[k] = side;
            // カウントダウンが終わって操作が始まった時刻（_startGameplay）から測る
            const g = sd.game;
            if (g && typeof g._startGameplay === 'function' && !g._cmlWrapped) {
                const orig = g._startGameplay;
                g._startGameplay = function() {
                    const s = sideOf(this);
                    if (s && s.startedAt === null) s.startedAt = now();
                    return orig.apply(this, arguments);
                };
                g._cmlWrapped = true;
            }
        }
        showDock();
    }

    function sideResult(s, endT) {
        const sec = s.startedAt === null ? 0 : (endT - s.startedAt) / 1000;
        const o = { label: s.label, rule: s.rule, ...s.info };
        if (s.tet) {
            const t = s.tet;
            Object.assign(o, {
                pieces: t.pieces, lines: t.lines, attack: t.attack,
                apm: sec > 0 ? +(t.attack / sec * 60).toFixed(1) : 0,
                pps: sec > 0 ? +(t.pieces / sec).toFixed(2) : 0,
                tss: t.tss, tsd: t.tsd, tst: t.tst, tsMini: t.tsMini, tetrises: t.tetrises, pcs: t.pcs,
                b2b: t.b2b, maxRen: t.maxRen, maxSpike: t.maxSpike, garbageTaken: t.garbageTaken,
            });
            if (t.zones > 0) Object.assign(o, { zones: t.zones, zoneLinesMax: t.zoneLinesMax, zoneAttack: t.zoneAttack, zoneLog: t.zoneLog });
        } else if (s.game) {
            o.maxChain = s.game.chainMax || 0;
            o.score = s.game.score || 0;
        }
        return o;
    }

    function end(loser) {
        if (!current) return;
        const endT = now();
        const loserKey = loser === 'player' ? '1P' : '2P';
        const winnerKey = loserKey === '1P' ? '2P' : '1P';
        const ls = current.sides[loserKey];
        const starts = ['1P', '2P'].map(k => current.sides[k].startedAt).filter(v => v !== null);
        const t0 = starts.length ? Math.min(...starts) : endT;
        const list = load();
        const rec = {
            no: list.length + 1,
            at: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            sec: +((endT - t0) / 1000).toFixed(1),
            winner: winnerKey,
            winnerLabel: current.sides[winnerKey].label,
            loserLabel: ls.label,
            death: ls.tet ? (ls.death || { reason: 'unknown' }) : { reason: 'puyo' },
            '1P': sideResult(current.sides['1P'], endT),
            '2P': sideResult(current.sides['2P'], endT),
        };
        if (current.phaseLog) rec.phaseLog = current.phaseLog;
        list.push(rec);
        save(list);
        current = null;
        renderDock();
        console.log('📝 CpuMatchLog:', rec);
        if (isAuto()) scheduleAuto();
    }

    // 途中でやめた局（R リスタート・中断）は残さない
    function abort() { current = null; }

    // ── 書き出し ──
    const CSV_SIDE = ['label', 'className', 'rule', 'pieces', 'pps', 'attack', 'apm', 'lines', 'tss', 'tsd', 'tst',
                      'tsMini', 'tetrises', 'pcs', 'b2b', 'maxRen', 'maxSpike', 'garbageTaken', 'maxChain', 'disablePC', 'thinkMs',
                      'zones', 'zoneLinesMax', 'zoneAttack'];
    const CSV_DEATH = ['reason', 'kind', 'stackHeight', 'incoming', 'garbageLast3s', 'lastGarbageAgoMs', 'inPCSequence'];
    function toCsv(list) {
        const head = ['no', 'at', 'sec', 'winner', 'winnerLabel', 'loserLabel']
            .concat(CSV_DEATH.map(k => 'death_' + k))
            .concat(...['1P', '2P'].map(p => CSV_SIDE.map(k => `${p}_${k}`)));
        const esc = (v) => {
            if (v === undefined || v === null) return '';
            const s = String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const rows = list.map(r => [r.no, r.at, r.sec, r.winner, r.winnerLabel, r.loserLabel]
            .concat(CSV_DEATH.map(k => r.death && r.death[k]))
            .concat(...['1P', '2P'].map(p => CSV_SIDE.map(k => r[p] && r[p][k])))
            .map(esc).join(','));
        return [head.join(',')].concat(rows).join('\n') + '\n';
    }

    function download(format = 'json') {
        const list = load();
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const isCsv = format === 'csv';
        const body = isCsv ? '﻿' + toCsv(list) : JSON.stringify(list, null, 1);
        const blob = new Blob([body], { type: isCsv ? 'text/csv' : 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cpu-match-log-${stamp}.${isCsv ? 'csv' : 'json'}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function clear() {
        save([]);
        renderDock();
    }

    // ── 画面左下の欄 ──
    function showDock() {
        if (!dock) {
            dock = document.createElement('div');
            dock.className = 'cml-dock';
            dock.innerHTML = `
                <div class="cml-title">MATCH LOG</div>
                <div class="cml-sum"></div>
                <div class="cml-btns">
                    <button type="button" data-act="json" tabindex="-1">JSON</button>
                    <button type="button" data-act="csv" tabindex="-1">CSV</button>
                    <button type="button" data-act="clear" tabindex="-1">CLEAR</button>
                    <button type="button" data-act="auto" class="cml-auto" tabindex="-1" title="結果画面から自動で再戦する（放置で回す）">AUTO</button>
                </div>
                <div class="cml-replay">
                    <div class="cml-replay-sum"></div>
                    <div class="cml-btns">
                        <button type="button" data-act="rmode" class="cml-rmode" tabindex="-1" title="リプレイの自動保存: ALL＝ふだんどおり / FILTER＝条件を満たした局だけ / OFF＝残さない">REPLAY</button>
                        <button type="button" data-act="redit" class="cml-redit" tabindex="-1" title="保存する条件を変える">EDIT</button>
                    </div>
                    <div class="cml-replay-form" style="display:none">
                        ${REPLAY_FIELDS.map(([k, label, unit]) => `<label><span>${label} ≥</span><input type="number" min="0" step="${k === 'minMin' ? '0.5' : '1'}" data-k="${k}" placeholder="—"><em>${unit}</em></label>`).join('')}
                        <div class="cml-btns">
                            <button type="button" data-act="rmatch" class="cml-rmatch" tabindex="-1" title="ALL＝すべて満たす / ANY＝どれか 1 つ">ALL</button>
                            <button type="button" data-act="rsave" tabindex="-1">OK</button>
                        </div>
                    </div>
                </div>`;
            dock.addEventListener('click', (e) => {
                const act = e.target && e.target.dataset && e.target.dataset.act;
                if (act === 'json' || act === 'csv') download(act);
                else if (act === 'clear' && confirm('対局記録をすべて消します。よろしいですか？')) clear();
                else if (act === 'auto') setAuto(!isAuto());
                else if (act === 'rmode') {
                    const order = ['all', 'filter', 'off'];
                    const f = replayFilter();
                    setReplayFilter({ mode: order[(order.indexOf(f.mode) + 1) % order.length] });
                } else if (act === 'redit') toggleReplayForm();
                else if (act === 'rmatch') {
                    const b = e.target;
                    b.textContent = b.textContent === 'ALL' ? 'ANY' : 'ALL';
                } else if (act === 'rsave') saveReplayForm();
                if (e.target && e.target.blur && e.target.tagName === 'BUTTON') e.target.blur();   // SPACE 等のキーがボタンに残らないように
            });
            // 数字の入力中のキーはゲーム（ポーズ・リスタート等）へ渡さない。Enter で確定、Esc で閉じる
            const stop = (e) => {
                if (!e.target || e.target.tagName !== 'INPUT') return;
                e.stopPropagation();
                if (e.type === 'keydown' && e.key === 'Enter') { e.preventDefault(); saveReplayForm(); }
                else if (e.type === 'keydown' && e.key === 'Escape') { e.preventDefault(); toggleReplayForm(false); }
            };
            dock.addEventListener('keydown', stop, true);
            dock.addEventListener('keyup', stop, true);
            dock.addEventListener('keypress', stop, true);
            document.body.appendChild(dock);
        }
        dock.style.display = '';
        renderDock();
    }

    function toggleReplayForm(show) {
        if (!dock) return;
        const form = dock.querySelector('.cml-replay-form');
        const open = show === undefined ? form.style.display === 'none' : !!show;
        if (open) {
            const f = replayFilter();
            form.querySelectorAll('input[data-k]').forEach((inp) => { inp.value = f[inp.dataset.k] || ''; });
            form.querySelector('.cml-rmatch').textContent = f.match === 'any' ? 'ANY' : 'ALL';
        } else if (document.activeElement && form.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        form.style.display = open ? '' : 'none';
    }
    function saveReplayForm() {
        if (!dock) return;
        const form = dock.querySelector('.cml-replay-form');
        const patch = { match: form.querySelector('.cml-rmatch').textContent === 'ANY' ? 'any' : 'all' };
        form.querySelectorAll('input[data-k]').forEach((inp) => {
            const v = parseFloat(inp.value);
            patch[inp.dataset.k] = (isFinite(v) && v > 0) ? v : null;
        });
        // 条件を書いたら FILTER にする（ALL / OFF のままだと効かないため）
        if (replayFilter().mode !== 'filter') patch.mode = 'filter';
        setReplayFilter(patch);
        toggleReplayForm(false);
    }

    function hideDock() {
        if (dock) dock.style.display = 'none';
        current = null;
        cancelAuto();
    }

    function renderDock() {
        if (!dock) return;
        const autoBtn = dock.querySelector('.cml-auto');
        if (autoBtn) {
            autoBtn.textContent = isAuto() ? 'AUTO: ON' : 'AUTO: OFF';
            autoBtn.classList.toggle('is-on', isAuto());
        }
        const rf = replayFilter();
        const rmode = dock.querySelector('.cml-rmode');
        if (rmode) {
            rmode.textContent = `REPLAY: ${rf.mode.toUpperCase()}`;
            rmode.classList.toggle('is-on', rf.mode === 'filter');
        }
        const rsum = dock.querySelector('.cml-replay-sum');
        if (rsum) rsum.textContent = replayFilterText(rf);
        const list = load();
        const tally = {};
        for (const r of list) {
            const key = [r['1P'].label, r['2P'].label].join(' vs ');
            const t = tally[key] || (tally[key] = { w1: 0, w2: 0 });
            if (r.winner === '1P') t.w1++; else t.w2++;
        }
        const lines = Object.entries(tally).map(([k, t]) => `${k}：${t.w1}-${t.w2}`);
        dock.querySelector('.cml-sum').textContent = list.length
            ? `${list.length} 局（1P勝-2P勝）\n${lines.join('\n')}`
            : '記録なし（終わった局を自動で残します）';
    }

    return {
        begin, end, abort, zone, phase, hideDock, matches: load, download, clear, toCsv, setAuto, isAuto,
        replayFilter, setReplayFilter, replayDecision, replayMeets,
    };
})();

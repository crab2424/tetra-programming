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
//   ・コンソール: CpuMatchLog.matches() / CpuMatchLog.download('csv') / CpuMatchLog.clear()
// ─────────────────────────────────────────────

window.CpuMatchLog = (() => {
    const STORE_KEY = 'tetlabo.cpuMatchLog';
    const GARBAGE_DEATH_MS = 3000;   // 死ぬ直前この時間内にせり上がりがあれば「おじゃまで押し上げ」

    let current = null;   // 記録中の1局 { startedAt, sides: { '1P': side, '2P': side } }
    let dock = null;

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
        list.push(rec);
        save(list);
        current = null;
        renderDock();
        console.log('📝 CpuMatchLog:', rec);
    }

    // 途中でやめた局（R リスタート・中断）は残さない
    function abort() { current = null; }

    // ── 書き出し ──
    const CSV_SIDE = ['label', 'className', 'rule', 'pieces', 'pps', 'attack', 'apm', 'lines', 'tss', 'tsd', 'tst',
                      'tsMini', 'tetrises', 'pcs', 'b2b', 'maxRen', 'maxSpike', 'garbageTaken', 'maxChain', 'disablePC', 'thinkMs'];
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
                </div>`;
            dock.addEventListener('click', (e) => {
                const act = e.target && e.target.dataset && e.target.dataset.act;
                if (act === 'json' || act === 'csv') download(act);
                else if (act === 'clear' && confirm('対局記録をすべて消します。よろしいですか？')) clear();
                if (e.target && e.target.blur) e.target.blur();   // SPACE 等のキーがボタンに残らないように
            });
            document.body.appendChild(dock);
        }
        dock.style.display = '';
        renderDock();
    }

    function hideDock() {
        if (dock) dock.style.display = 'none';
        current = null;
    }

    function renderDock() {
        if (!dock) return;
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

    return { begin, end, abort, hideDock, matches: load, download, clear, toCsv };
})();

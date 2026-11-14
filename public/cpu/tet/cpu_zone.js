// ─────────────────────────────────────────────
// cpu/tet/cpu_zone.js — テト CPU の ZONE（VERSUS）: 発動の判断・発動中の手の速さ・探索へ渡す盤面の印
// 設計: source_assets/memory/tet_zone/tetlabo-zone-versus-cpu-design.md §5・§6
//
// ・各レベルの CPU（lv1〜lv7）は updateLoop の頭で CpuZone.tick(this, レベル) を呼ぶ。
//   発動の判断は探索の評価に混ぜず、ここ（手を選ぶ前の決まり）に書く。ZONE が無い試合では何もしない。
// ・探索（wasm）へ渡す盤面は実盤面のまま（ZONE 段はそろった段として底に入っている）。
//   発動中だけ先頭のバイトに印（100 + ZONE 段の数）を付け、探索側が「ZONE 段は消えない・
//   発動中の消去は下が上がる」と読む（C1。各 cpuN.cpp / lv7 engine）。
// ・盤面に触るのは game.cpuAction('zone') だけ（録画に残る。core/cpu_port.js）。
// ─────────────────────────────────────────────
const CpuZone = (() => {

    // 調整用の値（仮。実機で 20 秒に何段作れるかを見て決める。設計 §6・Q12）
    const CONFIG = {
        // 発動中、置いてから次のミノに取りかかるまでの最小間隔（ms）。CPU は手が速いので人の速さに寄せる
        minMoveMs: 450,
        // 発動中の 1 手にかかる見込み（ms。見込み段数の計算用。レベルごと）
        moveMs: { 1: 1500, 2: 1100, 3: 900, 4: 800, 5: 700, 6: 650, 7: 650 },
        // 「攻め」で発動する見込み段数（低いほど早く撃つ＝弱い）
        attackTarget: { 3: 6, 4: 6, 5: 10, 6: 10, 7: 10 },
        attackMaxHeight: 10,     // 「攻め」: これより高い盤面では撃たない
        attackMaxHoles: 1,       // 「攻め」: 穴がこれより多い盤面では撃たない
        attackMaxIncoming: 3,    // 「攻め」: 予告がこれより大きいときは撃たない
        finishMaxHeight: 12,     // 「とどめ」: 自分の高さの上限
        finishOppHeight: 10,     // 「とどめ」: 相手がこの高さ以上のとき
        lethalHeight: 19,        // 「守り」: 高さ＋予告がこれ以上なら着弾で死ぬとみなす
        counterDanger: 16,       // 「返し」: 高さ＋予告＋相手の見込み火力がこれ以上なら危ない
        counterLeadMs: 3000,     // 「返し」: 相手の終了より後にこれだけ自分の時間を残す（後出し）
        simpleDelayMs: 1500,     // lv1・lv2: 満タンになってから発動するまでの遅れ
    };

    // レベルごとの決まり（設計 §5.3 の表）
    const RULES = {
        1: { simple: true },
        2: { simple: true },
        3: { attack: true, defend: true },
        4: { attack: true, defend: true },
        5: { attack: true, finish: true, defend: true },
        6: { attack: true, finish: true, defend: true },
        7: { attack: true, finish: true, defend: true, counter: true },
    };

    // 発動中なら ZONE 段の数、していなければ -1
    function floor(game) {
        return (game && game.zoneActive) ? game.zoneLines : -1;
    }

    // 探索へ渡す 250 バイトの盤面（(y+5)*10+x）に発動中の印を付ける。
    // 先頭（x=0, y=-5）はふだん必ず空なので、ここを 100 + ZONE 段の数にする。発動していなければ何もしない
    function stampBoard(buf, game) {
        const z = floor(game);
        if (z >= 0) buf[0] = 100 + Math.min(25, z);
        return buf;
    }

    // 相手の盤面を探索へ渡すとき用: ZONE 段を除いて、その段数ぶん下げた「ふつうの盤面」のブロック（{x, y}）
    function plainBlocks(game) {
        const bs = (game && game.field && game.field.blocks) || [];
        if (!game || !game.zoneActive || !(game.zoneLines > 0)) return bs;
        const out = [];
        for (let i = 0; i < bs.length; i++) {
            if (!bs[i].zone) out.push({ x: bs[i].x, y: bs[i].y + game.zoneLines });
        }
        return out;
    }

    // 対戦の相手（テトの盤面だけ。garbage.js sendGarbage と同じ決め方）
    function opponent(game) {
        const opp = game.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        return (opp && opp !== game && typeof opp.zoneQuarters === 'function') ? opp : null;
    }

    // 盤面の高さ・穴・ブロック数・すぐ消せそうな段（8 マス以上埋まっている段）の数
    function boardStats(game) {
        const top = new Array(10).fill(20);
        const rowCount = {};
        const bs = game.field.blocks;
        let blocks = 0;
        for (let i = 0; i < bs.length; i++) {
            const b = bs[i];
            if (b.zone || b.x < 0 || b.x >= 10) continue;
            blocks++;
            if (b.y < top[b.x]) top[b.x] = b.y;
            rowCount[b.y] = (rowCount[b.y] || 0) + 1;
        }
        const floorY = 20 - (game.zoneActive ? game.zoneLines : 0);
        let height = 0, filled = 0, nearFull = 0;
        for (let x = 0; x < 10; x++) {
            const h = Math.max(0, floorY - top[x]);
            if (h > height) height = h;
            filled += h;
        }
        for (const y in rowCount) if (rowCount[y] >= 8) nearFull++;
        return { height, holes: Math.max(0, filled - blocks), blocks, nearFull };
    }

    function incoming(game) {
        let n = 0;
        for (const g of (game.garbageQueue || [])) if (!g.internal) n += g.amount;
        return n;
    }

    // 発動中に作れる見込みの段数: 置ける手数 ÷ 2.5（1 手 4 マス・1 段 10 マス）＋今ある分。天井で頭打ち
    function expectedLines(ms, level, st) {
        const moves = ms / (CONFIG.moveMs[level] || 700);
        const cap = 20 - 1 - Math.min(6, st.holes);
        return Math.max(0, Math.min(cap, Math.floor(moves / 2.5 + st.blocks / 10)));
    }

    function attackOf(charge, lines, mult) {
        let n = 0;
        for (const c of zoneAttackChunks(charge, lines)) n += Math.floor(c * mult + 1e-9);
        return n;
    }

    // 発動するか（設計 §5.3）。理由の名前を返す（しないなら null）
    function decide(cpu, level) {
        const g = cpu.game;
        const rule = RULES[level] || RULES[3];
        const q = Math.min(4, g.zoneQuarters());
        if (q < 1) { cpu._zoneFullAt = null; return null; }
        const now = g.clock.now();

        if (rule.simple) {
            // 満タンになったら、少し遅れて発動（判断なし）
            if (q < 4) { cpu._zoneFullAt = null; return null; }
            if (cpu._zoneFullAt == null) { cpu._zoneFullAt = now; return null; }
            return (now - cpu._zoneFullAt >= CONFIG.simpleDelayMs) ? 'full' : null;
        }

        const st = boardStats(g);
        const inc = incoming(g);
        const opp = opponent(g);
        const mult = g.vsAttackMultiplier ?? 1.0;
        const lethal = inc > 0 && st.height + inc >= CONFIG.lethalHeight;

        // 返し: 相手が発動中で、終了時の火力を受けたら危ない → 相手の残り時間が短くなってから発動する
        if (rule.counter && opp && opp.zoneActive) {
            const oppRem = opp.zoneRemainingMs();
            const oppLines = opp.zoneLines + Math.floor(oppRem / (CONFIG.moveMs[level] || 700) / 2.5);
            const threat = attackOf(opp.zoneCharge, oppLines, opp.vsAttackMultiplier ?? 1.0);
            if (st.height + inc + threat >= CONFIG.counterDanger && st.nearFull >= 1) {
                const mine = q * g.zoneQuarterMs;
                if (oppRem <= Math.max(1000, mine - CONFIG.counterLeadMs)) return 'counter';
                if (!lethal) return null; // まだ待つ（後出し）
            }
        }

        // 守り: 予告が着弾したら死ぬ。1 段以上はすぐ消せること（消せないと盤面が下がらず負ける）
        if (rule.defend && lethal && st.nearFull >= 1) return 'defend';

        // 攻め: 満タン・穴がない・低い・予告が小さい・見込み段数が目標以上
        if (rule.attack && q === 4 && st.holes <= CONFIG.attackMaxHoles && st.height <= CONFIG.attackMaxHeight
            && inc <= CONFIG.attackMaxIncoming
            && expectedLines(4 * g.zoneQuarterMs, level, st) >= (CONFIG.attackTarget[level] || 10)) {
            return 'attack';
        }

        // とどめ: 相手が高い。見込み段数の火力が、相手の天井までの余裕＋相手が相殺に使える量以上
        if (rule.finish && q >= 2 && opp && !lethal && st.holes <= CONFIG.attackMaxHoles
            && st.height <= CONFIG.finishMaxHeight) {
            const os = boardStats(opp);
            if (os.height >= CONFIG.finishOppHeight) {
                const atk = attackOf(q, expectedLines(q * g.zoneQuarterMs, level, st), mult);
                // 相手が相殺に使える量: 発動できるなら大きめに、できないなら 4 ライン 1 回ぶん程度
                const oppCancel = (opp.zoneActive || opp.zoneQuarters() >= 1) ? 8 : 3;
                if (atk >= (20 - os.height) + oppCancel) return 'finish';
            }
        }
        return null;
    }

    // 各 CPU の updateLoop の頭で毎フレーム呼ぶ。true を返したら、そのフレームは新しいミノに取りかからない
    // （発動中の手の速さ。設計 §6）
    function tick(cpu, level) {
        const g = cpu && cpu.game;
        if (!g || !g.zoneEnabled || !g.isVersusMode || !g.mino) return false;
        if (g.isPaused || g.isCountingDown || g.isFinishing) return false;
        if (g.mino === cpu.currentMino) return false; // もう取りかかっている
        if (g.zoneActive) {
            return (g.clock.now() - (g._zoneLastLockAt || 0)) < CONFIG.minMoveMs;
        }
        if (cpu.isAutoPlay === false) return false;
        // 発動の判断は、ミノが出て取りかかる前に 1 回
        const why = decide(cpu, level);
        if (why && g.cpuAction('zone')) {
            cpu._zoneFullAt = null;
            cpu.zoneWhy = why; // 記録・デバッグ用
        }
        return false;
    }

    return { CONFIG, RULES, floor, stampBoard, plainBlocks, tick, decide, boardStats, expectedLines };
})();
window.CpuZone = CpuZone;

// ─────────────────────────────────────────────
// cpu/tet/cpu_zone.js — テト CPU の ZONE（VERSUS）: 発動の判断・探索へ渡す盤面の印
// 設計: source_assets/memory/mode/tet_zone/tetlabo-zone-versus-cpu-design.md §5・§6・§11・§17
// （発動中の手の速さは通常と同じ。§11.2 で待ちをやめた）
//
// ・各レベルの CPU（lv1〜lv7）は updateLoop の頭で CpuZone.tick(this, レベル) を呼ぶ。
//   発動の判断は探索の評価に混ぜず、ここ（手を選ぶ前の決まり）に書く。ZONE が無い試合では何もしない。
// ・探索（wasm）へ渡す盤面は実盤面のまま（ZONE 段はそろった段として底に入っている）。
//   発動中だけ先頭のバイトに印（100 + ZONE 段の数）を付け、探索側が「ZONE 段は消えない・
//   発動中の消去は下が上がる」と読む（C1。各 cpuN.cpp / lv7 engine）。
// ・火力の見込みは全部 attackOf（＝エンジンの zoneEndAttackChunks。火力表・マージンの倍率表・ATTACK BIAS）で出す。
//   ここには火力の数字を持たない。game/tet/zone.js の表を変えれば、発動の判断もそのまま付いてくる（§17）。
// ・盤面に触るのは game.cpuAction('zone') だけ（録画に残る。core/cpu_port.js）。
// ─────────────────────────────────────────────
const CpuZone = (() => {

    // 調整用の値（仮。設計 §6・§11.2）
    const CONFIG = {
        // 発動中の 1 手にかかる見込み（ms。見込み段数の計算用。レベルごと）。発動中も通常と同じ速さで打つので、
        // ふだんの 1 手の時間を入れる。lv7 は CPU 同士の記録の実測（約 2.8 手/秒）。ほかのレベルは目分量の仮の値
        moveMs: { 1: 1300, 2: 900, 3: 700, 4: 550, 5: 450, 6: 380, 7: 360 },
        // 発動中の通常火力の見込み（1 段あたり。REN・4 ラインをねらわない打ち方なので控えめ。仮）
        normalPerLine: 0.5,
        // 「攻め」で発動する見込み段数（満タンで撃つときの値。低いほど早く撃つ＝弱い。満タン前はメーターの割合ぶん）
        attackTarget: { 3: 6, 4: 6, 5: 10, 6: 10, 7: 10 },
        attackMaxHeight: 10,     // 「攻め」: これより高い盤面では撃たない
        attackMaxHoles: 1,       // 「攻め」: 穴がこれより多い盤面では撃たない
        attackMaxIncoming: 3,    // 「攻め」: 予告がこれより大きいときは撃たない
        finishMaxHeight: 12,     // 「とどめ」: 自分の高さの上限
        finishOppHeight: 15,     // 「とどめ」: 相手がこの高さ以上のとき
        lethalHeight: 19,        // 「守り」: 高さ＋予告がこれ以上なら着弾で死ぬとみなす
        counterDanger: 16,       // 「返し」: 高さ＋予告＋相手の見込み火力がこれ以上なら危ない
        counterLeadMs: 3000,     // 「返し」: 相手の終了より後にこれだけ自分の時間を残す（後出し）
        simpleDelayMs: 1500,     // lv1・lv2: 満タンになってから発動するまでの遅れ
        // ── 火力の表から決める判断（§17）──
        // 「攻め」は満タンのときだけ（false）。true にすると、メーター 1/4 あたりの見込み火力が満タンで撃つときの
        // attackMinEfficiency 倍以上なら満タン前でも撃つ。既定で切っている理由: 見込み段数は天井（19 段）で
        // 頭打ちになるので、ZONE TIME が長い設定では「小さく 4 回撃つほうが得」と出てしまい、1/4 で即撃ちになった
        // （実機で弱くなった。§18）。ためて撃つのがこのモードの本筋なので、既定は満タンまで待つ
        attackEarly: false,
        attackMinEfficiency: 1.2,
        // 「攻め」: マージンの次の段階がこの時間以内に来るなら、待つ得（倍率が上がるぶんの火力）と
        // 待つ損（待つ間に消してあふれるメーターぶんの火力）を比べる。0 にすると待たない
        marginWaitMaxMs: 32000,
        // 「とどめ」: 相手が ZONE で相殺してくる見込み（相手の見込み火力のこの割合。人は毎回は返せないので割り引く）
        oppCancelRate: 0.6,
        oppCancelPlain: 3,       // 「とどめ」: 相手が ZONE を使えないときの相殺の見込み（4 ライン 1 回ぶん程度）
        oppMoveMs: 700,          // 相手の発動中の 1 手の見込み（ms。相手の段数の見込み用）
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

    // 発動中、時間切れまでに置ける見込みの手数（1 以上）。発動していなければ 0。
    // 探索へ渡して「この手数を使い切ったら ZONE が終わる」と読ませる（設計 §20）
    // §22: 切り捨て。1 手ぶんに足りない残りでは置き切れない（切り上げだと最後の 1 手を当てにして、
    //   消す手を後回しにしたまま時間切れになっていた）
    function movesLeft(game, level) {
        if (!game || !game.zoneActive || !game.isVersusMode) return 0;
        return Math.max(1, Math.floor(game.zoneRemainingMs() / (CONFIG.moveMs[level] || 700)));
    }

    // 発動中の終了時の火力表（段数 0〜ZONE_TABLE_LEN-1 ごとの表のかたまりの合計。マージン倍率・ATTACK BIAS 込み）。
    // 探索（lv6 など）が「段を増やす価値」をこれで読む（設計 §22）。発動していなければ null。
    // 発動中にためた通常火力（pool）は入れない（探索が手ごとの火力として数えている）
    const ZONE_TABLE_LEN = 32;
    function zoneTable(game) {
        if (!game || !game.zoneActive || !game.isVersusMode || typeof zoneEndAttackChunks !== 'function') return null;
        const out = [];
        for (let L = 0; L < ZONE_TABLE_LEN; L++) {
            let sum = 0;
            for (const c of zoneEndAttackChunks(game.zoneCharge, L, 0, game._tetMarginStep, game.vsAttackMultiplier ?? 1.0)) sum += c;
            out.push(sum);
        }
        return out;
    }

    // 発動中にためた通常火力に終了時に掛かる倍率（ATTACK BIAS）の 100 倍。探索が通常火力を表と同じ物差しで数える用（設計 §23）
    function attackBias100(game) {
        return Math.round(((game && game.vsAttackMultiplier) ?? 1.0) * 100);
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
    function expectedLines(ms, level, st, moveMs) {
        const moves = ms / (moveMs || CONFIG.moveMs[level] || 700);
        const cap = 20 - 1 - Math.min(6, st.holes);
        return Math.max(0, Math.min(cap, Math.floor(moves / 2.5 + st.blocks / 10)));
    }

    // game が ZONE を lines 段で終えたときの見込み火力（エンジンの終了時と同じ式。設計 §11）。
    // 通常火力は「いままでにためた分（発動中だけ）＋これから増える段 × normalPerLine」で見込む
    // marginStep を渡すと、そのマージンの段階で終えたとして見込む（省略＝いまの段階）
    function attackOf(game, charge, lines, marginStep) {
        const have = game.zoneActive ? (game.zoneAtkPool || 0) : 0;
        const more = Math.max(0, lines - (game.zoneActive ? game.zoneLines : 0));
        const pool = have + Math.floor(more * CONFIG.normalPerLine);
        const step = (marginStep === undefined) ? game._tetMarginStep : marginStep;
        let n = 0;
        for (const c of zoneEndAttackChunks(charge, lines, pool, step, game.vsAttackMultiplier ?? 1.0)) n += c;
        return n;
    }

    // いまメーター q/4 で発動したときの見込み火力（marginStep 省略＝いまの段階）
    function attackIfFired(game, level, q, st, marginStep) {
        return attackOf(game, q, expectedLines(q * game.zoneQuarterMs, level, st), marginStep);
    }

    // 「攻め」を満タン前に撃ってよいか: 1/4 あたりの見込み火力が、満タンで撃つときの attackMinEfficiency 倍以上。
    // 火力表とマージンの倍率表から出すので、表が「ためるほど得」なら満タンまで待ち、そうでなければ早く撃つ
    function worthFiringAt(game, level, q, st) {
        if (q >= 4) return true;
        if (!CONFIG.attackEarly) return false;
        const now = attackIfFired(game, level, q, st) / q;
        const full = attackIfFired(game, level, 4, st) / 4;
        return now > 0 && now >= full * CONFIG.attackMinEfficiency;
    }

    // マージンの次の段階までの時間（ms）。もう上がらない・マージンなしは Infinity
    function nextMarginStepIn(game) {
        if (!game._vsMarginTimer || !(game._vsMarginTimerDuration > 0)) return Infinity;
        return Math.max(0, game._vsMarginTimerStart + game._vsMarginTimerDuration - game.clock.now());
    }

    // 「攻め」で、マージンの次の段階まで待つほうが得か。
    //   得 = 次の段階で撃ったときの見込み火力 − いま撃ったときの見込み火力
    //   損 = 待つ間に消す段のうちメーターに入らないぶん（満タン＋持ち越しの枠を超えるぶん）× メーター 1 段あたりの火力
    // 待つ間もふつうの攻撃は続くので、損はあふれるメーターだけで見る
    function shouldWaitForMargin(game, level, q, st, atkNow) {
        const wait = nextMarginStepIn(game);
        if (!(wait <= CONFIG.marginWaitMaxMs)) return false;
        const cur = game._tetMarginStep;
        const next = (cur === null || cur === undefined) ? 0 : cur + 1;
        const gain = attackIfFired(game, level, q, st, next) - atkNow;
        if (!(gain > 0)) return false;
        const perMeterLine = atkNow / (4 * game.zoneQuarterLines);
        const linesWhileWaiting = wait / (CONFIG.moveMs[level] || 700) / 2.5;
        const room = (4 - q) * game.zoneQuarterLines
            + Math.max(0, game.zoneQuarterLines - (game.zoneCarry || 0));
        return gain > Math.max(0, linesWhileWaiting - room) * perMeterLine;
    }

    // 「とどめ」で、相手が相殺に使える見込み。相手が ZONE を使える（発動中も）なら、相手の見込み火力を
    // oppCancelRate で割り引いたもの。使えないなら oppCancelPlain
    function oppCancelOf(opp, os) {
        let zoneAtk = 0;
        if (opp.zoneActive) {
            const lines = opp.zoneLines + Math.floor(opp.zoneRemainingMs() / CONFIG.oppMoveMs / 2.5);
            zoneAtk = attackOf(opp, opp.zoneCharge, lines);
        } else {
            const oq = Math.min(4, opp.zoneQuarters());
            if (oq >= 1) zoneAtk = attackOf(opp, oq, expectedLines(oq * opp.zoneQuarterMs, 0, os, CONFIG.oppMoveMs));
        }
        return Math.max(CONFIG.oppCancelPlain, Math.floor(zoneAtk * CONFIG.oppCancelRate));
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
        const lethal = inc > 0 && st.height + inc >= CONFIG.lethalHeight;

        // 返し: 相手が発動中で、終了時の火力を受けたら危ない → 相手の残り時間が短くなってから発動する
        if (rule.counter && opp && opp.zoneActive) {
            const oppRem = opp.zoneRemainingMs();
            const oppLines = opp.zoneLines + Math.floor(oppRem / (CONFIG.moveMs[level] || 700) / 2.5);
            const threat = attackOf(opp, opp.zoneCharge, oppLines);
            if (st.height + inc + threat >= CONFIG.counterDanger && st.nearFull >= 1) {
                const mine = q * g.zoneQuarterMs;
                if (oppRem <= Math.max(1000, mine - CONFIG.counterLeadMs)) return 'counter';
                if (!lethal) return null; // まだ待つ（後出し）
            }
        }

        // 守り: 予告が着弾したら死ぬ。すぐ消せる段が無くても発動する（発動しなければ次の設置で着弾して負ける。
        // 発動中は着弾が止まるので、その間に 1 段でも消せば盤面が下がって生き延びる。設計 §13.2）
        if (rule.defend && lethal) return 'defend';

        // 攻め: 穴がない・低い・予告が小さい・見込み段数が目標以上。
        // 満タン前は「ためても得をしない」ときだけ（worthFiringAt）。マージンの次の段階が近くて得なら待つ
        if (rule.attack && st.holes <= CONFIG.attackMaxHoles && st.height <= CONFIG.attackMaxHeight
            && inc <= CONFIG.attackMaxIncoming
            && expectedLines(q * g.zoneQuarterMs, level, st) >= Math.ceil((CONFIG.attackTarget[level] || 10) * q / 4)
            && worthFiringAt(g, level, q, st)) {
            const atkNow = attackIfFired(g, level, q, st);
            if (atkNow > 0 && !shouldWaitForMargin(g, level, q, st, atkNow)) return 'attack';
        }

        // とどめ: 相手が高い。見込み段数の火力が、相手の天井までの余裕＋相手が相殺に使える量以上
        if (rule.finish && q >= 2 && opp && !lethal && st.holes <= CONFIG.attackMaxHoles
            && st.height <= CONFIG.finishMaxHeight) {
            const os = boardStats(opp);
            if (os.height >= CONFIG.finishOppHeight) {
                const atk = attackIfFired(g, level, q, st);
                if (atk >= (20 - os.height) + oppCancelOf(opp, os)) return 'finish';
            }
        }
        return null;
    }

    // 探索が「置ける手がない」を返したとき、その場で落とすまでの待ち（ms）。各レベルの handleWorkerResult から。
    // ふだんは今までどおり待つ。ZONE の発動中は待たない: 発動中は自由落下も固定もしないので、待つと ZONE の
    // 時間だけ減る。落として枠の上で固定（または次のミノが出せない）になれば ZONE が終わり、発動中に消した
    // 段数ぶん盤面が下がって続けられる（game/tet/zone.js _zoneRespawnAfterTopOut。設計 §13.2）
    function noMoveDelay(cpu, ms) {
        const g = cpu && cpu.game;
        return (g && g.zoneActive && g.isVersusMode) ? 0 : ms;
    }

    // 探索の結果が手を持たない（初手で出現できないと読んだ死に枝）とき用。ZONE の発動中だけ、その場で落とす。
    // 発動中は自由落下で固定されないので、何もしないと CPU が止まったままになる（設計 §14）
    function dropIfNoMove(cpu) {
        const g = cpu && cpu.game;
        if (!g || !g.zoneActive || !g.isVersusMode || cpu.isAutoPlay === false) return;
        const mino = cpu.currentMino;
        g.cpuSchedule(0, () => {
            if (cpu.isActive && g.mino === mino && !g.isPaused) g.cpuAction('hardDrop');
        });
    }

    // 各 CPU の updateLoop の頭で毎フレーム呼ぶ。true を返したら、そのフレームは新しいミノに取りかからない
    // （いまは常に false。発動中も通常と同じ速さで打つ。設計 §11.2）
    function tick(cpu, level) {
        const g = cpu && cpu.game;
        if (!g || !g.zoneEnabled || !g.isVersusMode || !g.mino) return false;
        if (g.isPaused || g.isCountingDown || g.isFinishing) return false;
        if (g.mino === cpu.currentMino) return false; // もう取りかかっている
        if (g.zoneActive) return false;
        if (cpu.isAutoPlay === false) return false;
        // 発動の判断は、ミノが出て取りかかる前に 1 回
        const why = decide(cpu, level);
        if (why && g.cpuAction('zone')) {
            cpu._zoneFullAt = null;
            cpu.zoneWhy = why; // 記録・デバッグ用
        }
        return false;
    }

    return { CONFIG, RULES, floor, stampBoard, movesLeft, incoming, zoneTable, attackBias100, plainBlocks, tick, decide, boardStats, expectedLines, attackOf, attackIfFired, worthFiringAt, nextMarginStepIn, shouldWaitForMargin, oppCancelOf, noMoveDelay, dropIfNoMove };
})();
window.CpuZone = CpuZone;

// ─────────────────────────────────────────────
// tet/garbage.js  ―  Game.prototype mixin
// 対戦・おじゃま/火力ゲージ
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    // opts.zoneChunk: ZONE 終了時の火力のかたまり（受ける側がかたまりごとに穴を引き直す。tet/zone.js）
    // opts.zoneHold: 分けて送る ZONE の火力（VS 設定 ZONE ATTACK: SPLIT）。受ける側は 1 手につき 1 かたまりだけ着弾させる
    sendGarbage(amount, opts) {
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        if (!opponent || amount <= 0) return;

        // ── 注意：火力補正乗率は secureMino 内で実効火力として計算済み。ここでは再計算しない ──

        let isOpponentPuyo = false;
        if (this.opponentRule) {
            // オンライン対戦: コントローラが注入する相手ルールを最優先で使う
            isOpponentPuyo = this.opponentRule === 'puyo';
        } else if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        } else if (opponent) {
            isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
        }

        // 変換(tetゲージ→おじゃまぷよ)・配送タイマーは BattleGarbage(src/battle/garbage_router.ts)に集約。
        // 異種戦(ぷよ相手)なら1000ms後、テト同士なら1500ms後に降下可能になる。
        // テトへ送るときは穴を決めない（受け手が applyGarbage で決める）。
        const BG = window.BattleGarbage;
        BG.routeGarbage({
            amount: amount,
            targetRule: isOpponentPuyo ? 'puyo' : 'tet',
            gaugeToOjama: true,
        }, {
            sendTetLines: (lines) => {
                const entry = { amount: lines, holes: [], ready: false };
                if (opts && opts.zoneChunk) entry.zoneChunk = true;
                if (opts && opts.zoneHold) entry.zoneHold = true;
                BG.deliverLocalWithReadyTimer(opponent, entry, 1500);
            },
            sendOjama: (count) => {
                BG.deliverLocalWithReadyTimer(opponent, { amount: count, holes: [], ready: false }, 1000);
            },
        });
    },

    applyGarbage() {
        // stage3(ready かつ internalでない)のみ落下対象。internal は ready でも残置（internal優先）
        // ZONE の分けて送る火力（zoneHold）は 1 手につき 1 かたまりだけ: 古い順に取っていき、zoneHold のかたまりを
        // 1 つ取ったらそこで止める。残りは着弾できる状態のまま次の手を待つ（順番は変えない。設計 §14.1）
        // VS 設定 ZONE ATTACK: SPLIT の試合では、ふつうの火力も 1 手に 1 かたまり（攻撃 1 回ぶん）ずつ（_garbageHoldEach）
        const holdEach = this._garbageHoldEach();
        const readyGarbage = [];
        const restGarbage = [];
        let held = false;
        for (const g of this.garbageQueue) {
            if (g.ready && !g.internal && !held) {
                readyGarbage.push(g);
                if (g.zoneHold || holdEach) held = true;
            } else {
                restGarbage.push(g);
            }
        }
        this.garbageQueue = restGarbage;

        if (readyGarbage.length === 0) return;

        // おじゃまラインの着弾音。予告ゲージの点灯（stage1/2）では鳴らさず、
        // 実際に盤面がせり上がるこの瞬間だけ1回鳴らす。
        this.playSe('garbage');

        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        let isOpponentPuyo = false;
        if (this.opponentRule) {
            // オンライン対戦: コントローラが注入する相手ルールを最優先で使う
            isOpponentPuyo = this.opponentRule === 'puyo';
        } else if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        } else if (opponent) {
            isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
        }

        // ★ 異種戦（相手がぷよ）からの攻撃は最大7ラインずつ降る。
        //   オンラインの混在戦では、受け取ったおじゃまに送り手のルール(_srcRule)が付いているので
        //   送り手ごとに決める（テトからの攻撃まで 7 ラインで止めない）。付いていなければ従来どおり。
        const PUYO_DROP_LIMIT = 7;
        let droppedLines = 0;

        // ★ 追加：まとめて降ってくるおじゃまの穴位置を一貫して保持・計算するための変数
        let lastHole = -1;

        for (let j = 0; j < readyGarbage.length; j++) {
            let g = readyGarbage[j];
            let dropCount = 0;
            const fromPuyo = (g._srcRule !== undefined) ? (g._srcRule === 'puyo') : isOpponentPuyo;
            const limit = fromPuyo ? PUYO_DROP_LIMIT : Infinity;

            for (let i = 0; i < g.amount; i++) {
                if (droppedLines >= limit) {
                    break;
                }
                this.field.blocks.forEach(block => block.y -= 1);
                this.garbageTaken = (this.garbageTaken || 0) + 1; // 成績（STATS）: せり上がった段数

                // ★ 穴は受ける側がこの着弾（applyGarbage の1回）の中で決める（VERSUS・オンラインとも送る側は穴を付けない）。
                //   g.holes があるのは PRACTICE が自分で穴列を作って積んだときだけ。
                let currentHole;
                const rng = this._rngStream('garbage');
                if (g.holes && g.holes[i] !== undefined && g.holes[i] !== null) {
                    currentHole = g.holes[i];
                } else if (droppedLines === 0 || (g.zoneChunk && i === 0)) {
                    // 今回受ける一番下の段（最初の1段目）は完全にランダム。
                    // ZONE の火力はかたまりごとに穴を引き直す（設計 tetlabo-zone-versus-cpu-design.md Q10）
                    currentHole = Math.floor(rng() * COLS_COUNT);
                } else {
                    // 2段目以降は70%で同じ穴、30%で違う穴
                    const rate = this.vsGarbageHoleRate !== undefined ? this.vsGarbageHoleRate / 100 : 0.7;
                    if (rng() < rate) {
                        currentHole = lastHole;
                    } else {
                        const offset = Math.floor(rng() * (COLS_COUNT - 1)) + 1;
                        currentHole = (lastHole + offset) % COLS_COUNT;
                    }
                }
                lastHole = currentHole;

                for (let x = 0; x < COLS_COUNT; x++) {
                    if (x !== currentHole) {
                        this.field.blocks.push(new Block(x, ROWS_COUNT - 1, 7));
                    }
                }
                dropCount++;
                droppedLines++;
            }

            if (dropCount < g.amount) {
                // 制限にかかった場合、残りの攻撃を再びreadyキューの先頭へ
                let remainHoles = g.holes ? g.holes.slice(dropCount) : [];
                const rest = { amount: g.amount - dropCount, holes: remainHoles, ready: true };
                if (g._srcRule !== undefined) rest._srcRule = g._srcRule;
                if (g._srcSender !== undefined) rest._srcSender = g._srcSender;
                if (g.zoneChunk) rest.zoneChunk = true;
                if (g.zoneHold) rest.zoneHold = true;
                this.garbageQueue.unshift(rest);
                for (let k = j + 1; k < readyGarbage.length; k++) {
                    this.garbageQueue.push(readyGarbage[k]);
                }
                break;
            }
        }

        // ブロック座標を直接ずらした＆push したので占有マップを再構築させる
        this.field.markDirty();

        // 録画の印: 被弾（せり上がった段数。core/replay.js）
        if (this._rec && droppedLines > 0) this._rec.hit(this, droppedLines);

        // おじゃまがフィールドに出現したのでゲージを減らす
        this.updateGarbageGauge();
    },

    // 自分に降ってくる予定の火力を相殺し、余った火力を返す
    offsetGarbage(amount) {
        //console.log(`[offsetGarbage] ${this.canvasPrefix || 'player'} が ${amount} の火力で相殺を試みます。現在のキュー:`, JSON.parse(JSON.stringify(this.garbageQueue)));

        // 1. まずは「確定(ready)」で最も古いおじゃまから相殺
        for (let i = 0; i < this.garbageQueue.length && amount > 0; i++) {
            if (this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                if (this.garbageQueue[i].amount <= amount) {
                    amount -= this.garbageQueue[i].amount;
                    this.garbageQueue[i].amount = 0;
                } else {
                    this.garbageQueue[i].amount -= amount;
                    amount = 0;
                }
            }
        }

        // 2. 次に「猶予中(unready)」で最も古いおじゃまを相殺
        for (let i = 0; i < this.garbageQueue.length && amount > 0; i++) {
            if (!this.garbageQueue[i].ready && this.garbageQueue[i].amount > 0) {
                if (this.garbageQueue[i].amount <= amount) {
                    amount -= this.garbageQueue[i].amount;
                    this.garbageQueue[i].amount = 0;
                } else {
                    this.garbageQueue[i].amount -= amount;
                    amount = 0;
                }
            }
        }

        // 相殺で amount が減ったエントリは holes も整合させる（先頭側から相殺された扱いで末尾を残す）
        this.garbageQueue.forEach(g => {
            if (g.holes && g.holes.length > g.amount) {
                g.holes = g.holes.slice(g.holes.length - g.amount);
            }
        });

        // 相殺しきって amount が 0 になったキューを削除
        this.garbageQueue = this.garbageQueue.filter(g => g.amount > 0);

        // 相殺した結果をゲージに反映
        this.updateGarbageGauge();

        // 相殺しきれず余った火力（＝相手に送り返す火力）を返す
        return amount;
    },

    // 着弾できるおじゃま（ready かつ internal でない）を、1 手ごとに降る段数の列にする（予告ゲージの表示用）。
    // applyGarbage と同じ決まりで先を読む: 古い順に取り、ZONE の分けて送る火力（zoneHold・SPLIT の試合のふつうの火力）は 1 かたまりで止め、
    // ぷよからの火力は 1 手 7 段まで（あふれた分は次の手の先頭）。盤面・キューは変えない
    _garbageLandingGroups() {
        const isOpponentPuyo = this._garbageOpponentIsPuyo();
        const holdEach = this._garbageHoldEach();
        const PUYO_DROP_LIMIT = 7;
        let pending = [];
        for (const g of this.garbageQueue) {
            if (!g.ready || g.internal || !(g.amount > 0)) continue;
            const fromPuyo = (g._srcRule !== undefined) ? (g._srcRule === 'puyo') : isOpponentPuyo;
            pending.push({ amount: g.amount, zoneHold: !!g.zoneHold || holdEach, limit: fromPuyo ? PUYO_DROP_LIMIT : Infinity });
        }
        const groups = [];
        while (pending.length && groups.length < 64) {
            let dropped = 0;
            let next = null;
            let used = 0;
            for (let j = 0; j < pending.length; j++) {
                const g = pending[j];
                used = j + 1;
                const take = Math.max(0, Math.min(g.amount, g.limit - dropped));
                dropped += take;
                if (take < g.amount) {
                    next = Object.assign({}, g, { amount: g.amount - take });
                    break;
                }
                if (g.zoneHold) break;
            }
            pending = (next ? [next] : []).concat(pending.slice(used));
            if (dropped > 0) groups.push(dropped);
            else break;
        }
        return groups;
    },

    // おじゃまを 1 手に 1 かたまりずつ着弾させるか: VERSUS の ZONE が ON で ZONE ATTACK が SPLIT のとき（テト同士）。
    // ZONE の火力（zoneHold）だけでなく、ふつうの火力が溜まったときも攻撃 1 回ぶんずつ降る。
    // 版 6 以前の録画の再生は従来どおり（ZONE の火力だけ。core/replay.js REPLAY_ENGINE_VERSION 7）
    _garbageHoldEach() {
        if (!(this.isVersusMode && this.zoneEnabled && this.vsZoneSplit === true)) return false;
        if (this._replay && this._replay.data && (this._replay.data.engine || 0) < 7) return false;
        return true;
    },

    // 相手がぷよか（sendGarbage・applyGarbage と同じ決め方）
    _garbageOpponentIsPuyo() {
        if (this.opponentRule) return this.opponentRule === 'puyo';
        if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            return (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        }
        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        return !!opponent && ((opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo'));
    },

    // 予告ゲージのDOMを更新
    updateGarbageGauge() {
        if (!this.isVersusMode) return;
        const gaugeId = this.canvasPrefix ? `${this.canvasPrefix}-garbage-gauge` : null;
        if (!gaugeId) return;
        const gaugeEl = document.getElementById(gaugeId);
        if (!gaugeEl) return;

        gaugeEl.innerHTML = '';

        // 予告ゲージは「かたまり」で見せる（ZONE の有無に関係なく。設計 tetlabo-zone-versus-cpu-design.md §15）。
        //   ・色は猶予だけを表す（赤=着弾できる、青=猶予中）。
        //   ・赤は「1 手で一緒に降る分」ごとに 1 かたまりにまとめる（_garbageLandingGroups＝applyGarbage と同じ決まり。
        //     ふつうは着弾できる分が全部つながる／ぷよからの火力は 7 段ごと／ZONE の SPLIT は 1 かたまりごと）。
        //   ・青は攻撃 1 回ごとに別のかたまり。着弾できるようになったら赤のかたまりへつながる。
        //   ・かたまりの中は線を消してつなげ、かたまりの間にすき間を入れる。
        //   ・点滅（すぐ降る合図）は次の 1 手で降るいちばん下のかたまりだけ。その後ろの赤は点灯。
        const GAUGE_MAX = 20;
        const groups = this._garbageLandingGroups().map(n => ({ n, ready: true }));
        let readyCount = 0;
        for (const gr of groups) readyCount += gr.n;
        let unreadyCount = 0;
        for (const g of this.garbageQueue) {
            if (g.internal || g.ready || !(g.amount > 0)) continue; // stage1(内部のみ) は非表示
            groups.push({ n: g.amount, ready: false });
            unreadyCount += g.amount;
        }
        // 下から表示する（column-reverse）。ブロックは盤面の高さ（20）まで。超えた分は数を出す
        let shown = 0;
        for (let i = 0; i < groups.length && shown < GAUGE_MAX; i++) {
            const gr = groups[i];
            const n = Math.min(gr.n, GAUGE_MAX - shown);
            const isLast = i === groups.length - 1;
            for (let k = 0; k < n; k++) {
                const block = document.createElement('div');
                block.className = 'gauge-block chunk ' + (gr.ready ? 'ready' : 'unready')
                    + (gr.ready && i > 0 ? ' waiting' : '')
                    + (!isLast && k === gr.n - 1 ? ' chunk-end' : '');
                gaugeEl.appendChild(block);
            }
            shown += n;
        }
        const total = readyCount + unreadyCount;
        if (total > GAUGE_MAX) {
            const count = document.createElement('div');
            count.className = 'gauge-count';
            count.textContent = String(total);
            gaugeEl.appendChild(count);
        }
    },

    // ★追加: 攻撃(送る用)ゲージの更新
    updateAttackGauge() {
        if (!this.isVersusMode) return;

        const opponent = this.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
        let isOpponentPuyo = false;
        if (this.opponentRule) {
            // オンライン対戦: コントローラが注入する相手ルールを最優先で使う
            isOpponentPuyo = this.opponentRule === 'puyo';
        } else if (typeof versusCpuRule !== 'undefined' && typeof versusPlayerRule !== 'undefined') {
            isOpponentPuyo = (this.canvasPrefix === 'cpu') ? (versusPlayerRule === 'puyo') : (versusCpuRule === 'puyo');
        } else if (opponent) {
            isOpponentPuyo = (opponent.constructor && opponent.constructor.name === 'PuyoGame') || (opponent.rule === 'puyo');
        }

        const gaugeId = this.canvasPrefix ? `${this.canvasPrefix}-attack-gauge` : null;
        if (!gaugeId) return;
        const gaugeEl = document.getElementById(gaugeId);
        if (!gaugeEl) return;

        gaugeEl.innerHTML = '';

        // 相手がぷよの場合のみ表示する
        if (!isOpponentPuyo) {
            gaugeEl.style.display = 'none';
            return;
        }

        gaugeEl.style.display = 'flex';

        if (this.pendingAttack <= 0) return;

        let amount = this.pendingAttack;
        let cycles = Math.floor(amount / 20);
        let remain = amount % 20;

        if (amount > 0 && remain === 0) {
            cycles -= 1;
            remain = 20;
        }

        const colors = ['c-0', 'c-1', 'c-2', 'c-3']; // 緑, 黄, オレンジ, 水色

        // 1周目の場合はベースがない
        if (cycles === 0) {
            let color = colors[0];
            for (let i = 0; i < remain; i++) {
                const block = document.createElement('div');
                block.className = `attack-block ${color}`;
                gaugeEl.appendChild(block);
            }
        } else {
            let baseColorIdx = (cycles - 1) % colors.length;
            let nextColorIdx = cycles % colors.length;

            let baseColor = colors[baseColorIdx];
            let nextColor = colors[nextColorIdx];

            for (let i = 0; i < 20; i++) {
                const block = document.createElement('div');
                // 下から上に積むので、remainの数だけ新しい色にする
                if (i < remain) {
                    block.className = `attack-block ${nextColor}`;
                } else {
                    block.className = `attack-block ${baseColor}`;
                }
                gaugeEl.appendChild(block);
            }
        }
    },
});

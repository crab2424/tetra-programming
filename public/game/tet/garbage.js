// ─────────────────────────────────────────────
// tet/garbage.js  ―  Game.prototype mixin
// 対戦・おじゃま/火力ゲージ
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    sendGarbage(amount) {
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

        // ★追加：異種戦（ぷよ相手）の場合はゲージ量をおじゃまぷよの個数に変換する
        let actualAmount = amount;
        if (isOpponentPuyo) {
            const table = [0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68];
            if (amount < table.length) {
                actualAmount = table[amount];
            } else {
                // n>=18の場合の階差数列の一般項: an = (n^2 - 21n + 204)/2
                actualAmount = Math.floor((amount * amount - 21 * amount + 204) / 2);
            }
            //console.log(`[sendGarbage] ぷよ相手用にゲージ ${amount} をおじゃまぷよ ${actualAmount} 個に変換して送信`);
        } else {
            //console.log(`[sendGarbage] ${this.canvasPrefix || 'player'} から相手へ ${amount} 送信`);
        }

        // 穴の計算（テト相手のみ意味があるが、エラーを防ぐため actualAmount 回ループする）
        const holes = [];
        let prevHole = -1;

        for (let i = 0; i < actualAmount; i++) {
            let holeX;
            if (i === 0) {
                holeX = Math.floor(Math.random() * COLS_COUNT);
            } else {
                const rate = this.vsGarbageHoleRate !== undefined ? this.vsGarbageHoleRate / 100 : 0.7;
                if (Math.random() < rate) {
                    holeX = prevHole;
                } else {
                    const offset = Math.floor(Math.random() * (COLS_COUNT - 1)) + 1;
                    holeX = (prevHole + offset) % COLS_COUNT;
                }
            }
            holes.push(holeX);
            prevHole = holeX;
        }

        const garbageObj = { amount: actualAmount, holes: holes, ready: false };
        opponent.garbageQueue.push(garbageObj);

        // 相手のゲージを更新（青色のゲージが増える）
        if (typeof opponent.updateGarbageGauge === 'function') {
            opponent.updateGarbageGauge();
        }

        // 異種戦(ぷよ相手)なら1000ms後、テト同士なら1500ms後に降下可能に
        const delay = isOpponentPuyo ? 1000 : 1500;

        // ポーズ中にこの猶予タイマーが止まるよう、opponent 側で管理する
        if (!opponent._garbageTimers) opponent._garbageTimers = [];
        const timerEntry = { obj: garbageObj, duration: delay, remaining: null, id: null };
        timerEntry.cb = () => {
            timerEntry.id = null;
            // タイマー発火時に相殺されて消滅していなければ状態変更
            if (opponent.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
                garbageObj.ready = true;
                // 相手のゲージを更新（青→赤点滅に変わる）
                if (typeof opponent.updateGarbageGauge === 'function') {
                    opponent.updateGarbageGauge();
                }
            }
            // 発火済みエントリをリストから除去
            const idx = opponent._garbageTimers.indexOf(timerEntry);
            if (idx !== -1) opponent._garbageTimers.splice(idx, 1);
        };
        opponent._garbageTimers.push(timerEntry);

        if (opponent.isPaused) {
            // 受け手がポーズ中なら開始を保留し、resume 時に計時を始める
            timerEntry.remaining = delay;
        } else {
            timerEntry.start = performance.now();
            timerEntry.id = setTimeout(timerEntry.cb, delay);
        }
    },

    applyGarbage() {
        // stage3(ready かつ internalでない)のみ落下対象。internal は ready でも残置（internal優先）
        const readyGarbage = this.garbageQueue.filter(g => g.ready && !g.internal);
        this.garbageQueue = this.garbageQueue.filter(g => !(g.ready && !g.internal));

        if (readyGarbage.length === 0) return;

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

        // ★ 異種戦（相手がぷよ）からの攻撃は最大7ラインずつ降る
        const limit = isOpponentPuyo ? 7 : Infinity;
        let droppedLines = 0;

        // ★ 追加：まとめて降ってくるおじゃまの穴位置を一貫して保持・計算するための変数
        let lastHole = -1;

        for (let j = 0; j < readyGarbage.length; j++) {
            let g = readyGarbage[j];
            let dropCount = 0;

            for (let i = 0; i < g.amount; i++) {
                if (droppedLines >= limit) {
                    break;
                }
                this.field.blocks.forEach(block => block.y -= 1);

                // ★ 送信側で確定した穴があればそれを使う（オンライン: 全員の盤面表示が一致する）。
                //   無ければ従来どおり受信側で一括計算する。
                let currentHole;
                if (g.holes && g.holes[i] !== undefined && g.holes[i] !== null) {
                    currentHole = g.holes[i];
                } else if (droppedLines === 0) {
                    // 今回受ける一番下の段（最初の1段目）は完全にランダム
                    currentHole = Math.floor(Math.random() * COLS_COUNT);
                } else {
                    // 2段目以降は70%で同じ穴、30%で違う穴
                    const rate = this.vsGarbageHoleRate !== undefined ? this.vsGarbageHoleRate / 100 : 0.7;
                    if (Math.random() < rate) {
                        currentHole = lastHole;
                    } else {
                        const offset = Math.floor(Math.random() * (COLS_COUNT - 1)) + 1;
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
                this.garbageQueue.unshift({ amount: g.amount - dropCount, holes: remainHoles, ready: true });
                for (let k = j + 1; k < readyGarbage.length; k++) {
                    this.garbageQueue.push(readyGarbage[k]);
                }
                break;
            }
        }

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

    // 予告ゲージのDOMを更新
    updateGarbageGauge() {
        if (!this.isVersusMode) return;
        const gaugeId = this.canvasPrefix ? `${this.canvasPrefix}-garbage-gauge` : null;
        if (!gaugeId) return;
        const gaugeEl = document.getElementById(gaugeId);
        if (!gaugeEl) return;

        gaugeEl.innerHTML = '';

        // ready（確定・赤）と unready（猶予中・青）の合計をカウント
        let readyCount = 0;
        let unreadyCount = 0;

        this.garbageQueue.forEach(g => {
            if (g.internal) return; // stage1(内部のみ) は非表示
            if (g.ready) readyCount += g.amount;
            else unreadyCount += g.amount;
        });

        // 下から表示するため、先にreadyを、後にunreadyをDOMに追加する
        for (let i = 0; i < readyCount; i++) {
            const block = document.createElement('div');
            block.className = 'gauge-block ready';
            gaugeEl.appendChild(block);
        }
        for (let i = 0; i < unreadyCount; i++) {
            const block = document.createElement('div');
            block.className = 'gauge-block unready';
            gaugeEl.appendChild(block);
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

// ─────────────────────────────────────────────
// tet/scoring.js  ―  Game.prototype mixin
// スコア計算・アクションラベル・スタッツ表示
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    // 第3引数 isPerfectClear を追加（デフォルトは false）
    Scoring(tSpinType, linesCleared, isPerfectClear = false) {
        let baseScore = 0;

        // ─── T-SPIN系 ───
        if (tSpinType === 'tspin') {
            if (linesCleared === 0) baseScore = 400;
            if (linesCleared === 1) baseScore = 800;
            if (linesCleared === 2) baseScore = 1200;
            if (linesCleared === 3) baseScore = 1600;
        }
        else if (tSpinType === 'mini') {
            if (linesCleared === 0) baseScore = 100;
            if (linesCleared === 1) baseScore = 200;
        }
        // ─── 通常ライン消去 ───
        else {
            if (linesCleared === 1) baseScore = 100;
            if (linesCleared === 2) baseScore = 300;
            if (linesCleared === 3) baseScore = 500;
            if (linesCleared === 4) baseScore = 800;
        }

        // ─── BtB判定 ───
        const isBtBAction = (
            linesCleared > 0 &&
            (linesCleared === 4 || tSpinType !== null)
        );

        let lineScore = baseScore;
        let isB2BTriggered = false; // 火力計算用フラグ

        if (isBtBAction) {
            if (this.backToBack) {
                lineScore = Math.floor(lineScore * 1.5);
                isB2BTriggered = true; // 発動したことを記録
            }
            this.backToBack = true;
        } else if (linesCleared > 0) {
            this.backToBack = false;
        }

        // ─── Level適用（ライン消去分のみ） ───
        lineScore *= this.level;

        // ─── PERFECT CLEAR ボーナス ───
        if (isPerfectClear) {
            let pcBonus = 0;
            if (linesCleared === 1) pcBonus = 800;
            if (linesCleared === 2) pcBonus = 1000;
            if (linesCleared === 3) pcBonus = 1800;
            if (linesCleared === 4) pcBonus = 2000;

            lineScore += (pcBonus * this.level);
        }

        // ─── REN処理 ───
        let renBonus = 0;
        let currentRenForGarbage = this.ren; // 火力計算用に加算前の値を保持
        if (linesCleared > 0) {
            const renCount = Math.min(this.ren, 20);
            renBonus = renCount * 50;
            this.ren++;
        } else {
            this.ren = 0;
        }

        this.score += Math.floor(lineScore + renBonus);

        if (linesCleared > 0) {
            this.lines += linesCleared;
            if (this.mode === 'marathon') {
                this.level = Math.min(15, this.startLevel + Math.floor(this.lines / 10));
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // おじゃまブロック（火力）の計算
        // _tetMarginStep === null : マージン未突入（従来の固定値を使用）
        // _tetMarginStep === 0〜5 : マージン中（テーブルから値を参照）
        // テーブルは [0秒, 32秒, 64秒, 96秒, 128秒, 160秒] 突入後のステップに対応
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        let generatedGarbage = 0;

        const _ms = this._tetMarginStep; // null = 未突入、0〜5 = マージン中

        if (_ms === null) {
            // ────────────────────────────────────────
            // マージン未突入：従来の固定テーブルをそのまま使用
            // ────────────────────────────────────────
            if (isPerfectClear) {
                generatedGarbage = 10;
            } else if (linesCleared > 0) {
                // 基本火力
                if (tSpinType === 'tspin') {
                    generatedGarbage = linesCleared * 2;
                } else {
                    if (linesCleared === 2) generatedGarbage = 1;
                    else if (linesCleared === 3) generatedGarbage = 2;
                    else if (linesCleared === 4) generatedGarbage = 4;
                }
                // BtBボーナス（オンライン設定 vsB2bBonusEnabled=false で無効化。未設定時は有効）
                if (isB2BTriggered && this.vsB2bBonusEnabled !== false) generatedGarbage += 1;
                // RENボーナス（従来テーブル）
                let r = currentRenForGarbage;
                if (r === 2 || r === 3) generatedGarbage += 1;
                else if (r === 4 || r === 5) generatedGarbage += 2;
                else if (r === 6 || r === 7) generatedGarbage += 3;
                else if (r >= 8 && r <= 12) generatedGarbage += 4;
                else if (r >= 13) generatedGarbage += 5;
            }
        } else {
            // ────────────────────────────────────────
            // マージン中：各要素をテーブルから参照
            // ────────────────────────────────────────

            // ── 基本火力テーブル（clear lines） ──
            const _garbageTables = {
                lines1: [0, 0, 1, 1, 1, 2],
                lines2: [1, 1, 2, 2, 3, 4],
                lines3: [2, 2, 3, 4, 5, 6],
                lines4: [4, 5, 5, 6, 8, 10],
            };
            // T-Spin（mini除く）火力テーブル
            const _tspinTables = {
                single: [2, 2, 3, 4, 5, 6],
                double: [4, 5, 5, 6, 8, 10],
                triple: [6, 7, 8, 10, 12, 16],
            };
            // BtBボーナステーブル
            const _btbBonus = [1, 1, 2, 2, 3, 4];
            // PCボーナステーブル（対テト相殺用）
            const _pcBonus = [12, 13, 14, 15, 16, 18];
            // REN追加ボーナステーブル（従来RENボーナスにさらに加算、2REN以降）
            const _renBonus = [0, 0, 0, 1, 1, 1];

            if (isPerfectClear) {
                generatedGarbage = _pcBonus[_ms];
            } else if (linesCleared > 0) {
                // 基本火力
                if (tSpinType === 'tspin') {
                    if (linesCleared === 1) generatedGarbage = _tspinTables.single[_ms];
                    else if (linesCleared === 2) generatedGarbage = _tspinTables.double[_ms];
                    else if (linesCleared === 3) generatedGarbage = _tspinTables.triple[_ms];
                } else {
                    if (linesCleared === 1) generatedGarbage = _garbageTables.lines1[_ms];
                    else if (linesCleared === 2) generatedGarbage = _garbageTables.lines2[_ms];
                    else if (linesCleared === 3) generatedGarbage = _garbageTables.lines3[_ms];
                    else if (linesCleared === 4) generatedGarbage = _garbageTables.lines4[_ms];
                }
                // BtBボーナス（オンライン設定 vsB2bBonusEnabled=false で無効化。未設定時は有効）
                if (isB2BTriggered && this.vsB2bBonusEnabled !== false) generatedGarbage += _btbBonus[_ms];
                // RENボーナス：従来テーブル + マージン追加ボーナス（2REN以降の全ボーナスに加算）
                let r = currentRenForGarbage;
                if (r === 2 || r === 3) generatedGarbage += 1 + _renBonus[_ms];
                else if (r === 4 || r === 5) generatedGarbage += 2 + _renBonus[_ms];
                else if (r === 6 || r === 7) generatedGarbage += 3 + _renBonus[_ms];
                else if (r >= 8 && r <= 12) generatedGarbage += 4 + _renBonus[_ms];
                else if (r >= 13) generatedGarbage += 5 + _renBonus[_ms];
            }
        }

        ////console.log(`[Scoring] prefix: ${this.canvasPrefix}, lines: ${linesCleared}, tSpin: ${tSpinType}, ren: ${currentRenForGarbage}, genGarbage: ${generatedGarbage}`);

        return generatedGarbage;
    },

    // ─────────────────────────────────────────
    // アクションラベル（PC, 4-LINES, T-Spin, B2B, REN）を一定時間表示する（DOM表示）
    // ─────────────────────────────────────────
    showActionLabels(tSpinType, linesCleared, isB2B, renCount, isPerfectClear, is4Lines) {
        // 対戦モードでは prefix 付きのコンテナを使う
        const containerId = (this.isVersusMode && this.canvasPrefix)
            ? `${this.canvasPrefix}-action-label-container`
            : 'action-label-container';
        const container = document.getElementById(containerId);
        if (!container) return;

        // 初回呼び出し時に、完全に独立した絶対配置のスロットを作成する
        if (!this._labelsInitialized) {
            container.innerHTML = '';

            // コンテナを基準点（座標0, 0のアンカー）として扱うための設定
            container.style.width = '0px';
            container.style.height = '0px';
            container.style.position = 'absolute';

            this.labelElements = {};
            this.labelTimers = {};

            // 完全自由配置用の座標マッピング（コンテナを基準としたpx単位）
            this.labelLayout = {
                four: { x: 80, y: 0 },    // 1. 4-LINES
                mini: { x: 40, y: 35 },   // 2. MINI
                tspin: { x: 60, y: 70 },   // 3. T-SPIN
                b2b: { x: 60, y: 105 },  // 4. BACK-TO-BACK
                pc: { x: 60, y: 140 },  // 5. PERFECT CLEAR
                ren: { x: 80, y: 175 }   // 6. REN
            };

            const slotIds = ['four', 'mini', 'tspin', 'b2b', 'pc', 'ren'];
            slotIds.forEach(id => {
                const el = document.createElement('div');
                el.className = `action-label`;
                el.style.opacity = '0';

                // 絶対配置（他のラベルの位置に一切影響を与えない）
                el.style.position = 'absolute';
                el.style.whiteSpace = 'nowrap'; // テキストの意図しない折り返しを防止

                // 座標の適用 (テキストの中央がX座標の基準になるように transform を使用)
                el.style.left = `${this.labelLayout[id].x}px`;
                el.style.top = `${this.labelLayout[id].y}px`;
                el.style.transform = 'translateX(-50%)';

                el.innerHTML = '&nbsp;';

                container.appendChild(el);
                this.labelElements[id] = el;
                this.labelTimers[id] = { fade: null, clear: null };
            });
            this._labelsInitialized = true;
        }

        const triggerLabel = (id, text, additionalClass) => {
            const el = this.labelElements[id];
            const timers = this.labelTimers[id];

            if (timers.fade) clearTimeout(timers.fade);
            if (timers.clear) clearTimeout(timers.clear);

            el.className = `action-label ${additionalClass}`;
            el.textContent = text;
            el.style.opacity = '1';

            timers.fade = setTimeout(() => {
                el.style.opacity = '0';
            }, 800);

            timers.clear = setTimeout(() => {
                el.innerHTML = '&nbsp;';
            }, 1200);
        };

        // 1. 4-LINES
        if (is4Lines) {
            triggerLabel('four', '4-LINES', 'four font-orbitron');
        }

        // 2 & 3. T-SPIN / MINI T-SPIN
        if (tSpinType !== null) {
            const clearNames = ['', ' SINGLE', ' DOUBLE', ' TRIPLE'];
            const suffix = clearNames[linesCleared] ?? '';

            if (tSpinType === 'mini') {
                triggerLabel('mini', 'MINI', 'mini font-tech');
                triggerLabel('tspin', 'T-SPIN' + suffix, 'mini font-tech');
            } else {
                if (this.labelElements['mini'].style.opacity !== '0') {
                    this.labelElements['mini'].style.opacity = '0';
                    this.labelElements['mini'].innerHTML = '&nbsp;';
                }
                triggerLabel('tspin', 'T-SPIN' + suffix, 'tspin font-tech');
            }
        }

        // 4. BACK-TO-BACK
        if (isB2B) {
            triggerLabel('b2b', 'BACK-TO-BACK', 'b2b font-orbitron');
        }

        // 5. PERFECT CLEAR
        if (isPerfectClear) {
            triggerLabel('pc', 'PERFECT CLEAR', 'pc font-orbitron');
        }

        // 6. REN
        if (renCount > 0) {
            triggerLabel('ren', renCount + ' REN', 'ren font-orbitron');
        }
    },

    // ─── 表示の更新 ───
    updateStatsDisplay() {
        // 対戦モードでは prefix 付きの要素IDを参照する
        const prefix = (this.isVersusMode && this.statsPrefix) ? `${this.statsPrefix}-` : '';

        // スコア
        const scoreEl = document.getElementById(`${prefix}score-value`);
        if (scoreEl) scoreEl.textContent = this.score;

        // レベル
        const levelEl = document.getElementById(`${prefix}level-value`);
        if (levelEl) levelEl.textContent = this.level;

        // ライン
        const linesEl = document.getElementById(`${prefix}lines-value`);
        if (linesEl) linesEl.textContent = this.lines;
    },

    // 攻撃量の累積を1回だけ加算する（APM計測用。sendGarbageはonlineで丸ごと上書きされるため
    // 呼び出し側=board.jsのsecureMino()で送信直前に呼ぶ）
    _countAttackSent(amount) {
        if (!(amount > 0)) return;
        this.attackSent = (this.attackSent || 0) + amount;
    },

    // シングルプレイのゲームオーバー/クリア時に最高記録へ提出する。
    // CPUテスト・QUIZ・対戦は対象外（対戦はgameOver()内でここに到達しない）。
    async _submitRecordIfEligible(isClear) {
        if (this.isCpuControlled) return null;
        if (!window.Records) return null;

        let key = null;
        let record = null;
        const timeMs = (typeof this.getActiveMs === 'function') ? this.getActiveMs() : this.elapsedTime;

        if (this.mode === 'marathon') {
            key = (this.goalLines === Infinity) ? 'marathon:endless' : 'marathon:150';
            record = { score: this.score, level: this.level, lines: this.lines, timeMs, startLevel: this.startLevel };
        } else if (this.mode === 'sprint') {
            if (!isClear) return null; // 40ライン未達成はタイム記録の対象外
            key = 'sprint:40';
            record = { timeMs, score: this.score };
        } else if (this.mode === 'ultra') {
            key = 'ultra';
            record = { score: this.score, lines: this.lines, timeMs };
        } else {
            return null;
        }

        return window.Records.submit(key, record);
    },
});

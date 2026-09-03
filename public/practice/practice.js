// ─────────────────────────────────────────────
// practice.js
// PRACTICEモード（1人用の練習モード）の進行管理
//
// 設計: source_assets/memory/tetlabo-practice-mode-design.md
// Phase 1（§10）: モード追加（準備画面の RULE / GOAL / VALUE）/ 自由落下速度0と
//   それに伴う固定仕様（§8）/ 1手ごとの巻き戻し（§5。直列化は practice_snapshot.js）/
//   目標 LINES / PUYOS / SCORE と桁スピナー入力（§4.2）/ 記録除外・APM/LPM非表示
// Phase 2: ゲーム内設定パネル（practice_panel.js）/ 時間目標 / リザルトからの巻き戻し
// Phase 3: おじゃま手動/自動投下（本ファイル）/ ツモ順設定（practice_sequence.js）
//
// QUIZ と同じく「単独ディレクトリ ＋ マネージャ1つ」構成。プレーン <script> 方式で
// グローバルスコープを共有する（index.html の ?v= を上げること）。
// ─────────────────────────────────────────────

// 巻き戻しの保持手数（設計 §1.4）。メモリのみ・永続化なし。
const PRACTICE_HISTORY_MAX = 100;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PracticeManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class PracticeManager {
    constructor(rule, goal) {
        this.rule = rule;                 // 'tet' | 'puyo'
        this.goal = goal;                 // { type, value }
        this.gameInstance = null;

        // ─── 巻き戻し履歴 ───────────────────────
        // history[cursor] が「今プレイ中の手の開始時点」のスナップショット。
        // 巻き戻し後にプレイを再開したら、その先（未来）の履歴は切り捨てる。
        this.history = [];
        this.cursor = -1;
        // 復元直後の1回だけ、スナップショット採取をスキップするための一発フラグ
        // （復元処理自身が popMino / _spawnPuyo を通るため、同じ局面を二重に積まない）
        this._skipNextCapture = false;

        this.isGoalAchieved = false;
        this.goalAchievedStats = null;   // 達成した瞬間の成績（リザルトはこれを優先表示）
        this.isFinished = false;         // リザルトへ抜けたあとの多重発火よけ

        // 差し替えたメソッドの復元用
        this._origPopMino = null;
        this._origSpawnPuyo = null;
        this._origGameOver = null;
        this._origBeginGameOver = null;

        this._goalLoopId = null;
        this._keyHandler = null;
        this._origUpdateChainDisplay = null; // puyo + 'puyos'ゴール時のみ使う（下記 attach() 参照）
        this._origUpdateTimeDisplay = null;      // tet。GOAL=TIME のときだけ使う
        this._origUpdateTimeDisplayPuyo = null;  // puyo。GOAL=TIME のときだけ使う
        this._origInitActiveColors = null;       // puyo。色数パネル用（§2.1a の _colorOrder 凍結）
        this._origColorCount = null;             // puyo。パネルで変更した PConfig.colorCount の復元用

        // ゲーム内設定パネル（Phase 2 §6）の現在値。パネル未使用時は既定のまま。
        this.fallLevel = 0; // 0=速度0（Phase 1既定） / tet:1〜15=LEVEL_SPEEDS / puyo:1〜=段階

        // ツモ順設定（Phase 3 §7）。ゲーム開始時点の practiceSequence[rule] を凍結して使う。
        this.sequenceEnabled = false;
        this.seqConfig = null;   // 凍結済みのバッグ列（プレイ中は編集不可）
        this.seqRunner = null;   // {bagOrder, bagPos, itemPos}
        this._origGetNextType = null; // tet
        this._origMakePair = null;    // puyo

        // おじゃま手動/自動投下（Phase 3 §6.2e）
        this.ojama = {
            auto: false,
            amount: (rule === 'puyo') ? 6 : 4,
            intervalSec: 10,
            timerId: null,          // setInterval（自動投下）
            pendingTimeouts: [],    // 予告→着弾の setTimeout（rewind時のゴースト書き込み防止に includes チェックで対処）
        };
    }

    // ─────────────────────────────────────────
    // 開始：ゲームインスタンスにフックを差し込む
    // ─────────────────────────────────────────
    attach(game) {
        this.gameInstance = game;
        const self = this;

        // ─── 自由落下速度0と固定仕様（設計 §1.3 / §8）───
        // Phase 1 では速度は常に0で固定（可変化は Phase 2 の設定パネル）。
        if (this.rule === 'tet') {
            game.gravityDisabled = true;   // 自然落下なし
            game.practiceNoLock = true;    // 接地してもソフトドロップ押下中しか固定タイマーを進めない

            // ─── SPEED を LEVEL 表示に統合（設計 §3.1）───
            // PRACTICEは mode!=='marathon' のため game.level は自動で変化しない（スコア倍率
            // への影響もない）。updateStatsDisplay() が毎回 #level-value を game.level で
            // 上書きするので、直接書き換えるのではなく元の呼び出し直後に上書きする形で差し込む。
            this._origUpdateStatsDisplay = game.updateStatsDisplay;
            game.updateStatsDisplay = function () {
                self._origUpdateStatsDisplay.call(this);
                self._syncLevelDisplay();
            }.bind(game);
        } else {
            game.practiceFallMs = 0;       // 自然落下なし
            game.practiceNoLock = true;

            // ─── 色数パネル用：_colorOrder の凍結（設計 §2.1a / §6.2d）───
            // _initActiveColors() は毎回シャッフルして colorCount ぶん切り詰めるだけで、
            // 切り詰め前の並び（_colorOrder）を保持しない。パネルで色数を変えても
            // 「多い色数が少ない色数を包含する」ようにするため、同じロジックに
            // _colorOrder の保存だけ足して差し替える。
            this._origColorCount = PConfig.colorCount;
            this._origInitActiveColors = game._initActiveColors;
            game._initActiveColors = function () {
                const allColors = [1, 2, 3, 4, 5];
                for (let i = allColors.length - 1; i > 0; i--) {
                    const j = Math.floor(this._random() * (i + 1));
                    [allColors[i], allColors[j]] = [allColors[j], allColors[i]];
                }
                this._colorOrder = allColors;
                this.activeColors = allColors.slice(0, PConfig.colorCount);

                // ─── ツモ順設定との整合（設計 §7.5）───
                // カスタム列で使われている色は、色数設定に関わらず必ず activeColors に
                // 含まれるよう、必要なら colorCount を自動で引き上げる
                // （colorOrder上の最大インデックス+1 まで）。
                if (self.seqConfig && self.rule === 'puyo') {
                    const used = PracticeSequence.usedPuyoColors(self.seqConfig);
                    let neededN = PConfig.colorCount;
                    used.forEach(c => {
                        const idx = this._colorOrder.indexOf(c);
                        if (idx >= 0) neededN = Math.max(neededN, idx + 1);
                    });
                    if (neededN > PConfig.colorCount) {
                        PConfig.colorCount = neededN;
                        this.activeColors = this._colorOrder.slice(0, neededN);
                    }
                }
            }.bind(game);
        }

        // ─── スナップショット地点のフック（設計 §5.1）───
        // 「次のツモが出現する直前」＝ツモ消費前。この地点は操作ミノ/ぷよが未出現なので、
        // 「初期位置にリセットして保存」という決定が自動的に満たされる。
        if (this.rule === 'tet') {
            this._origPopMino = game.popMino;
            game.popMino = function () {
                self._capture();
                self._origPopMino.call(this);
            }.bind(game);

            this._origGameOver = game.gameOver;
            game.gameOver = function (isClear = false) {
                self._onGameOver(() => self._origGameOver.call(this, isClear));
            }.bind(game);
        } else {
            this._origSpawnPuyo = game._spawnPuyo;
            game._spawnPuyo = function () {
                self._capture();
                return self._origSpawnPuyo.call(this);
            }.bind(game);

            this._origBeginGameOver = game._beginGameOver;
            game._beginGameOver = function () {
                self._onGameOver(() => self._origBeginGameOver.call(this));
            }.bind(game);
        }

        // ─── puyo + 'puyos' ゴールの進捗をライブ表示（設計にない追加分） ───
        // puyo の HUD は「LINES」枠を「CHAIN」に転用しているため、そのままでは
        // 累計クリア数の "/N" を出す場所がない。ぷよ数ゴールのときだけラベルを
        // "PUYOS" に変え、連鎖表示のたびに累計クリア数へ上書きする。
        if (this.rule === 'puyo' && this.goal.type === 'puyos') {
            const labelEl = document.getElementById('label-lines');
            if (labelEl) labelEl.textContent = 'PUYOS';
            this._origUpdateChainDisplay = game._updateChainDisplay;
            game._updateChainDisplay = function (chain) {
                self._origUpdateChainDisplay.call(this, chain);
                if (this.linesEl) this.linesEl.textContent = this.clearedPuyos;
            }.bind(game);
        }

        // ─── GOAL=TIME のカウントダウン表示（設計 §4.4）───
        // 達成判定は他のGOALと同じ汎用ループ（_currentGoalMetric）に任せ、ここでは
        // TIME表示を「経過時間」から「残り時間」へ描き替えるだけの見た目の上書きに留める。
        // 各エンジンの時刻表示関数の直後に上書きするので、rAFの実行順に依存しない。
        if (this.goal.type === 'time') {
            const limitMs = this.goal.value * 1000;
            const paintCountdown = (timeEl, elapsedMs, formatFn) => {
                if (!timeEl) return;
                const remain = Math.max(0, limitMs - elapsedMs);
                timeEl.textContent = formatFn(remain);
                const danger = remain > 0 && remain <= 10000;
                timeEl.style.color = danger ? 'var(--danger)' : '';
                timeEl.style.webkitTextFillColor = danger ? 'var(--danger)' : '';
            };
            if (this.rule === 'tet') {
                this._origUpdateTimeDisplay = game.updateTimeDisplay;
                game.updateTimeDisplay = function () {
                    self._origUpdateTimeDisplay.call(this);
                    const elapsed = this.elapsedTime + (this.isTimerRunning ? performance.now() - this.startTime : 0);
                    paintCountdown(document.getElementById('time-value'), elapsed, (ms) => {
                        const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
                        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
                    });
                }.bind(game);
            } else {
                this._origUpdateTimeDisplayPuyo = game._updateTimeDisplay;
                game._updateTimeDisplay = function (ms) {
                    self._origUpdateTimeDisplayPuyo.call(this, ms);
                    paintCountdown(this.timeEl || document.getElementById('time-value'), ms, (remain) => this._formatTime(remain));
                }.bind(game);
            }
        }

        // ─── ツモ順設定（設計 §7）───
        // 準備画面で編集した practiceSequence[rule] をゲーム開始時点で凍結し（プレイ中に
        // エディタ側から書き換わっても影響を受けないように）、getNextType/_makePair を
        // ラップして差し込む（QUIZが同じ2関数を差し替えている実績あり）。
        const seqSrc = (typeof PracticeSequence !== 'undefined') ? PracticeSequence.config(this.rule) : null;
        this.sequenceEnabled = !!(seqSrc && seqSrc.enabled && seqSrc.bags.length);
        if (this.sequenceEnabled) {
            this.seqConfig = JSON.parse(JSON.stringify(seqSrc));
            this.seqRunner = PracticeSequence.createRunner(this.seqConfig);

            if (this.rule === 'tet') {
                this._origGetNextType = game.getNextType;
                game.getNextType = function () {
                    return PracticeSequence.nextTetType(self.seqConfig, self.seqRunner);
                }.bind(game);
            } else {
                this._origMakePair = game._makePair;
                game._makePair = function (excludeColor = null) {
                    const pair = PracticeSequence.nextPuyoPair(self.seqConfig, self.seqRunner, this.activeColors);
                    return pair || self._origMakePair.call(this, excludeColor);
                }.bind(game);
            }
        }

        this._installKeyHandler();
        this._startGoalLoop();

        if (typeof _initPracticePanel === 'function') _initPracticePanel(this);
    }

    // ─────────────────────────────────────────
    // スナップショットと巻き戻し（設計 §5）
    // ─────────────────────────────────────────
    _capture() {
        if (this._skipNextCapture) { this._skipNextCapture = false; return; }
        // ツモ順設定の消費位置（設計 §7.1「カスタム列は巻き戻し対象」）。
        // popMino/_spawnPuyo 実行前＝runner がまだこの手の枠を読んでいない時点の状態を保存する。
        const seqState = this.sequenceEnabled ? PracticeSequence.cloneRunnerState(this.seqRunner) : undefined;
        const line = PracticeSnapshot.capture(this.gameInstance, this.rule, seqState);

        // 巻き戻した先から打ち直したら、それより先の履歴は無効になる
        if (this.cursor < this.history.length - 1) {
            this.history.length = this.cursor + 1;
        }
        this.history.push(line);
        if (this.history.length > PRACTICE_HISTORY_MAX) this.history.shift();
        this.cursor = this.history.length - 1;

        // 着弾直後の反映もここで拾える（applyGarbage() は popMino() の直前に走るため）（設計 §3.2）
        if (this.rule === 'tet') this._renderGarbageGauge();
        this._refreshRewindIndicator();
    }

    // 現在プレイ可能か（巻き戻しを受け付けてよい状態か）
    _isLive() {
        const g = this.gameInstance;
        if (!g || this.isFinished) return false;
        if (this.rule === 'tet') return !g.isPaused && !!g.mino;
        return g.state === 'playing';
    }

    // delta = -1 で1手戻る / +1 で1手進める（巻き戻しの取消）
    step(delta) {
        if (!this._isLive()) return false;
        const next = this.cursor + delta;
        if (next < 0 || next >= this.history.length) return false;
        this.cursor = next;
        this._restoreCurrent();
        return true;
    }

    _restoreCurrent() {
        const g = this.gameInstance;
        const line = this.history[this.cursor];
        this._skipNextCapture = true;
        if (!PracticeSnapshot.restore(g, this.rule, line)) {
            this._skipNextCapture = false;
            return;
        }

        // ツモ順設定の消費位置も一緒に復元する（popMino/_spawnPuyo が次の枠を読む前に必要）
        if (this.sequenceEnabled) {
            const seqState = PracticeSnapshot.restoreSeqState(this.rule, line);
            if (seqState) PracticeSequence.applyRunnerState(this.seqRunner, seqState);
        }

        if (this.rule === 'tet') {
            // 復元は「ツモ消費前」の状態なので、ここで同じミノを出し直す
            g.popMino();
            g.startGravity();
            g.drawAll();
        }
        // puyo は _gs='spawn' に戻してあるので、次フレームの _update が自分で出し直す

        // 巻き戻したら目標達成の判定もやり直す（TIMEは巻き戻し対象外＝時間は進めたままなので除く）。
        // 達成済みの手より前に戻った場合は再び未達成に戻し、再度その場に進めば
        // 通常の goal ループが _onGoalAchieved() を呼び直す（達成表示は出し直る）。
        if (this.goal.type !== 'none' && this.goal.type !== 'time') {
            const stillAchieved = this._currentGoalMetric() >= this.goal.value;
            if (!stillAchieved) {
                this.isGoalAchieved = false;
                this.goalAchievedStats = null;
            } else {
                this.isGoalAchieved = true;
            }
        }
        this._updateGoalDisplay();

        // おじゃまキューは巻き戻し対象外（保留分クリア）なので、ゲージも空の状態を描き直す（設計 §3.2）
        if (this.rule === 'tet') this._renderGarbageGauge();
        this._refreshRewindIndicator();
    }

    // ─────────────────────────────────────────
    // 目標判定（設計 §4）
    // ─────────────────────────────────────────
    _currentGoalMetric() {
        const g = this.gameInstance;
        if (!g) return 0;
        switch (this.goal.type) {
            case 'lines': return g.lines || 0;
            case 'puyos': return g.clearedPuyos || 0;
            case 'score': return g.score || 0;
            case 'time':  return Math.floor(this._elapsedMs() / 1000);
            default:      return 0;
        }
    }

    // 経過時間（ミリ秒）。設計 §1.4 の決定どおり、巻き戻しの対象外（進み続ける）。
    _elapsedMs() {
        const g = this.gameInstance;
        if (!g) return 0;
        if (this.rule === 'tet') {
            return g.elapsedTime + (g.isTimerRunning ? performance.now() - g.startTime : 0);
        }
        return g.elapsed + (g._timerRunning ? performance.now() - g._timerStart : 0);
    }

    _startGoalLoop() {
        if (this.goal.type === 'none') return;
        const tick = () => {
            if (this.isFinished || !this.gameInstance) { this._goalLoopId = null; return; }
            this._goalLoopId = requestAnimationFrame(tick);
            if (this.isGoalAchieved) return;
            if (this._currentGoalMetric() >= this.goal.value) this._onGoalAchieved();
        };
        this._goalLoopId = requestAnimationFrame(tick);
    }

    _onGoalAchieved() {
        this.isGoalAchieved = true;
        this.goalAchievedStats = this._collectStats();
        // 達成表示だけ出して続行する（設計 §4.5-1）。ゲームは止めない。
        if (typeof showFinishOverlay === 'function') {
            showFinishOverlay('finish-overlay', 'finish-text', 'GOAL!', 'finish-clear', 1200, null);
        }
    }

    // 目標値の "/N" 表示（LINES・PUYOS は lines-goal、SCORE は score-goal）
    _updateGoalDisplay() {
        const linesGoalEl = document.getElementById('lines-goal');
        if (linesGoalEl) {
            const showOnLines = (this.rule === 'tet' && this.goal.type === 'lines')
                || (this.rule === 'puyo' && this.goal.type === 'puyos');
            linesGoalEl.textContent = showOnLines ? '/' + this.goal.value : '';
        }
        const scoreGoalEl = document.getElementById('score-goal');
        if (scoreGoalEl) {
            scoreGoalEl.textContent = (this.goal.type === 'score') ? '/' + this.goal.value : '';
        }
    }

    // ─────────────────────────────────────────
    // HUD: SPEED→LEVEL統合（tetのみ・設計 §3.1）
    // ─────────────────────────────────────────
    _syncLevelDisplay() {
        if (this.rule !== 'tet') return;
        const el = document.getElementById('level-value');
        if (el) el.textContent = this.fallLevel;
    }

    // ─────────────────────────────────────────
    // HUD: おじゃまゲージ（tetのみ・versusと同じ見た目。設計 §3.2）
    // 共通エンジンの updateGarbageGauge() はシングル用のDOMを持たないため、
    // PRACTICE側に閉じた描画を独自に持つ（エンジンには一切触らない）。
    // ─────────────────────────────────────────
    _renderGarbageGauge() {
        const gaugeEl = document.getElementById('practice-garbage-gauge');
        const g = this.gameInstance;
        if (!gaugeEl || !g) return;
        gaugeEl.innerHTML = '';

        let readyCount = 0, unreadyCount = 0;
        (g.garbageQueue || []).forEach(o => {
            if (o.internal) return;
            if (o.ready) readyCount += o.amount;
            else unreadyCount += o.amount;
        });

        // 下から積む：ready(赤)を先に、unready(青)を後に
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
    }

    // ─────────────────────────────────────────
    // HUD: 巻き戻しインジケータ（設計 §2.2）
    // ─────────────────────────────────────────
    _refreshRewindIndicator() {
        const backCount = Math.max(0, this.cursor);
        const fwdCount = Math.max(0, this.history.length - 1 - this.cursor);
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('practice-rewind-back-count', backCount);
        set('practice-rewind-fwd-count', fwdCount);
        const backBtn = document.getElementById('practice-rewind-back');
        const fwdBtn = document.getElementById('practice-rewind-fwd');
        if (backBtn) backBtn.classList.toggle('is-disabled', backCount <= 0);
        if (fwdBtn) fwdBtn.classList.toggle('is-disabled', fwdCount <= 0);
    }

    // ─────────────────────────────────────────
    // 終了とリザルト（設計 §4.5）
    // ─────────────────────────────────────────
    _collectStats() {
        const g = this.gameInstance;
        if (this.rule === 'tet') {
            const timeEl = document.getElementById('time-value');
            return {
                score: g.score,
                sub:   g.level,
                count: g.lines,
                time:  timeEl ? timeEl.textContent : '00:00.00',
            };
        }
        return {
            score: g.score,
            sub:   g.chainMax,
            count: g.clearedPuyos,
            time:  g._formatTime(g.elapsed),
        };
    }

    // ポーズメニューの FINISH。目標を達成していれば達成時点の成績を出す。
    finish() {
        if (this.isFinished) return;
        this._showResult(this.isGoalAchieved ? 'goal' : 'finish');
    }

    // ゲームオーバー（詰み）。目標達成済みなら達成時点の値を出す（設計 §4.5-4）。
    _onGameOver(playOriginal) {
        if (this.isFinished) return;
        const g = this.gameInstance;
        if (g && typeof g.playSe === 'function') g.playSe('gameover');
        this._stopEngine();
        const stats = this.goalAchievedStats || this._collectStats();
        if (typeof showFinishOverlay === 'function') {
            showFinishOverlay('finish-overlay', 'finish-text',
                this.isGoalAchieved ? 'FINISH!' : 'GAME OVER',
                this.isGoalAchieved ? 'finish-clear' : 'finish-gameover', 1200,
                () => this._renderResult(this.isGoalAchieved ? 'goal' : 'gameover', stats));
        } else {
            this._renderResult(this.isGoalAchieved ? 'goal' : 'gameover', stats);
        }
    }

    _showResult(kind) {
        const stats = (kind === 'goal' && this.goalAchievedStats)
            ? this.goalAchievedStats : this._collectStats();
        this._stopEngine();
        this._renderResult(kind, stats);
    }

    // エンジンを止める。gameOver() の停止部分と同じことを、
    // 記録提出やリザルト描画を伴わない形で行う。
    _stopEngine() {
        const g = this.gameInstance;
        if (!g) return;
        if (this.rule === 'tet') {
            if (typeof g.stopRenderLoop === 'function') g.stopRenderLoop();
            if (g.timer) { clearInterval(g.timer); g.timer = null; }
            if (g.lockTimer) { clearTimeout(g.lockTimer); g.lockTimer = null; }
            if (g._garbageTimers && g._garbageTimers.length) {
                g._garbageTimers.forEach(t => { if (t.id) clearTimeout(t.id); });
                g._garbageTimers = [];
            }
            g.isPaused = true;
            if (g.isTimerRunning) {
                g.elapsedTime += performance.now() - g.startTime;
                g.isTimerRunning = false;
                if (g.timerReqId) cancelAnimationFrame(g.timerReqId);
            }
        } else {
            if (typeof g.stop === 'function') g.stop(true);
            g.state = 'gameover';
        }
    }

    _renderResult(kind, stats) {
        this.isFinished = true;
        if (this._goalLoopId) { cancelAnimationFrame(this._goalLoopId); this._goalLoopId = null; }
        const panel = document.getElementById('practice-panel-overlay');
        if (panel) panel.classList.remove('active');

        const titleEl = document.getElementById('result-title');
        if (titleEl) {
            if (kind === 'goal') {
                titleEl.textContent = 'CLEARED !';
                titleEl.style.background = 'none';
                titleEl.style.color = 'var(--success)';
                titleEl.style.webkitTextFillColor = 'var(--success)';
            } else {
                titleEl.textContent = (kind === 'gameover') ? 'GAME OVER' : 'FINISH';
                titleEl.style.color = '';
                titleEl.style.background = 'linear-gradient(90deg, var(--accent), var(--accent2))';
                titleEl.style.webkitBackgroundClip = 'text';
                titleEl.style.webkitTextFillColor = 'transparent';
            }
        }

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('result-score', stats.score);
        set('result-level', stats.sub);
        set('result-lines', stats.count);
        set('result-time', stats.time);

        // PRACTICE は記録を残さない（設計 §1.1）ので NEW RECORD / BEST は必ず隠す
        const badge = document.getElementById('result-new-record');
        const bestRow = document.getElementById('result-best-row');
        if (badge) badge.style.display = 'none';
        if (bestRow) bestRow.style.display = 'none';

        // 「巻き戻す」ボタン（設計 §4.5-6・§2.3）。戻れる手が残っているときだけ出し、
        // 残り手数をラベルに出す（「1手しか戻せない」誤解を防ぐ）。
        const rewindBtn = document.getElementById('result-practice-rewind-btn');
        if (rewindBtn) rewindBtn.style.display = (this.cursor > 0) ? '' : 'none';
        const rewindCountEl = document.getElementById('result-practice-rewind-count');
        if (rewindCountEl) rewindCountEl.textContent = this.cursor;

        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(this.rule === 'puyo');
        if (typeof switchPage === 'function') switchPage('result');
    }

    // ─────────────────────────────────────────
    // リザルトからの巻き戻し（設計 §4.5-6・§10 Phase2）
    // 停止済みのエンジンを1手戻し、ゲーム画面へ戻して再開する。
    // 巻き戻し履歴はリザルトを挟んでも生きたままなので、複数回呼べる。
    // ─────────────────────────────────────────
    rewindFromResult() {
        if (!this.isFinished || this.cursor <= 0) return false;
        this.cursor -= 1;
        this.isFinished = false;
        this._restoreCurrent();
        this._resumeEngine();
        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(this.rule === 'puyo');
        if (typeof switchPage === 'function') switchPage('game');
        return true;
    }

    // gameOver()/finish() で完全停止させたエンジンを、カウントダウンなしで再開する。
    // start()（tet）/ start()（puyo）はモード初期化からやり直してしまうため使えない。
    _resumeEngine() {
        const g = this.gameInstance;
        if (this.rule === 'tet') {
            g.isPaused = false;
            g.isCountingDown = false;
            g.startTime = performance.now();
            g.isTimerRunning = true;
            g.startTimerLoop();
            g.startGravity();
            g.startRenderLoop();
        } else {
            g.state = 'playing';
            g.isPaused = false;
            g.lastTime = performance.now();
            g._timerRunning = true;
            g._timerStart = performance.now();
            g._timerTick();
            g._loop();
        }
        this._startGoalLoop();
    }

    // ─────────────────────────────────────────
    // おじゃま手動/自動投下（設計 §6.2e。相殺は既存エンジンが自動で行う＝§2.1b）
    // ─────────────────────────────────────────
    // amount 省略時は現在の設定値を使う（手動SENDボタン・自動タイマーの両方から呼ばれる）
    sendOjama(amount) {
        const g = this.gameInstance;
        if (!g || this.isFinished) return;
        amount = Math.max(1, amount || this.ojama.amount);
        const obj = { amount, holes: [], ready: false };
        g.garbageQueue.push(obj);
        if (this.rule === 'puyo' && typeof g._updateOjamaYokoku === 'function') g._updateOjamaYokoku();
        if (this.rule === 'tet') this._renderGarbageGauge();

        // testGarbage（navigation.js）と同じ「予告→着弾」の猶予（1500ms）。
        // rewind でキューごと差し替わった後にreadyフラグだけ立ってしまわないよう、
        // includes で自分のオブジェクトがまだキューに残っているかを確認してから確定する。
        const id = setTimeout(() => {
            this.ojama.pendingTimeouts = this.ojama.pendingTimeouts.filter(t => t !== id);
            if (g.garbageQueue.includes(obj) && obj.amount > 0) {
                obj.ready = true;
                if (this.rule === 'puyo' && typeof g._updateOjamaYokoku === 'function') g._updateOjamaYokoku();
                if (this.rule === 'tet') this._renderGarbageGauge();
            }
        }, 1500);
        this.ojama.pendingTimeouts.push(id);

        if (typeof _practicePanelRefresh === 'function') _practicePanelRefresh();
    }

    // 自動投下ON/OFF。タイマーは実時間ベースで、パネルの開閉(pause)やrewindを挟んでも
    // クリアせず継続する（設計 §5.5）。ただし「今この瞬間プレイ中でない」ティックは
    // 投げっぱなしにせずスキップする（再開時にまとめて何本も降ってくるのを防ぐ）。
    setOjamaAuto(on) {
        this.ojama.auto = on;
        if (this.ojama.timerId) { clearInterval(this.ojama.timerId); this.ojama.timerId = null; }
        if (on) {
            this.ojama.timerId = setInterval(() => {
                if (!this._isLive()) return;
                this.sendOjama(this.ojama.amount);
            }, this.ojama.intervalSec * 1000);
        }
    }

    // 自動投下の間隔を変更する。タイマーが動いていれば新しい間隔で張り直す
    setOjamaIntervalSec(sec) {
        this.ojama.intervalSec = Math.max(1, Math.min(60, sec));
        if (this.ojama.auto) this.setOjamaAuto(true);
    }

    // ─────────────────────────────────────────
    // 巻き戻しキー（設計 §5.6）
    // ─────────────────────────────────────────
    _installKeyHandler() {
        this._removeKeyHandler();
        const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
        const codesOf = (action, fallback) => {
            const k = keys && keys[action];
            return (k && k.codes && k.codes.length) ? k.codes : [fallback];
        };
        const rewindCodes = codesOf('rewind', 'KeyQ');
        const advanceCodes = codesOf('advance', 'KeyE');

        // インジケータのキー表記を実際の割り当てに合わせる（設計 §2.2）
        const shortLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
        const keysLabelEl = document.getElementById('practice-rewind-keys');
        if (keysLabelEl) keysLabelEl.textContent = shortLabel(rewindCodes[0]) + ' / ' + shortLabel(advanceCodes[0]);

        this._keyHandler = (e) => {
            if (e.repeat) return;
            const gamePage = document.getElementById('game-page');
            if (!gamePage || !gamePage.classList.contains('active')) return;
            if (rewindCodes.includes(e.code)) {
                e.preventDefault();
                this.step(-1);
            } else if (advanceCodes.includes(e.code)) {
                e.preventDefault();
                this.step(+1);
            }
        };
        document.addEventListener('keydown', this._keyHandler);
        this._refreshRewindIndicator();
    }

    _removeKeyHandler() {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
    }

    // ─────────────────────────────────────────
    // 破棄（stopAllGames から呼ばれる）
    // ─────────────────────────────────────────
    destroy() {
        this._removeKeyHandler();
        if (this._goalLoopId) { cancelAnimationFrame(this._goalLoopId); this._goalLoopId = null; }

        // おじゃま自動投下・予告タイマーを止める（設計 §6.2e）
        if (this.ojama.timerId) { clearInterval(this.ojama.timerId); this.ojama.timerId = null; }
        this.ojama.pendingTimeouts.forEach(id => clearTimeout(id));
        this.ojama.pendingTimeouts = [];

        const g = this.gameInstance;
        if (g) {
            // ─── エンジン本体の停止（設計 §7.D）───
            // マネージャを捨てるならエンジンも必ず止める。ここを抜けると、ポーズメニューの
            // RESTART（stopAllGames() を通らない経路）で旧インスタンスが孤児化し、
            // document のキー入力を裏で食い続ける不具合になる。
            if (this.rule === 'tet') {
                if (typeof g.stopRenderLoop === 'function') g.stopRenderLoop();
                if (g.timer) { clearInterval(g.timer); g.timer = null; }
                if (g.lockTimer) { clearTimeout(g.lockTimer); g.lockTimer = null; }
                if (g._keyLoop) { clearInterval(g._keyLoop); g._keyLoop = null; }
                if (g._garbageTimers && g._garbageTimers.length) {
                    g._garbageTimers.forEach(t => { if (t.id) clearTimeout(t.id); });
                    g._garbageTimers = [];
                }
                if (g._keyDownHandler) document.removeEventListener('keydown', g._keyDownHandler);
                if (g._keyUpHandler) document.removeEventListener('keyup', g._keyUpHandler);
                g.isPaused = true;
                if (g.isTimerRunning) {
                    g.isTimerRunning = false;
                    if (g.timerReqId) cancelAnimationFrame(g.timerReqId);
                }
            } else if (typeof g.stop === 'function') {
                g.stop();
            }

            if (this._origPopMino) g.popMino = this._origPopMino;
            if (this._origGameOver) g.gameOver = this._origGameOver;
            if (this._origSpawnPuyo) g._spawnPuyo = this._origSpawnPuyo;
            if (this._origBeginGameOver) g._beginGameOver = this._origBeginGameOver;
            if (this._origUpdateChainDisplay) g._updateChainDisplay = this._origUpdateChainDisplay;
            if (this._origUpdateTimeDisplay) g.updateTimeDisplay = this._origUpdateTimeDisplay;
            if (this._origUpdateTimeDisplayPuyo) g._updateTimeDisplay = this._origUpdateTimeDisplayPuyo;
            if (this._origInitActiveColors) g._initActiveColors = this._origInitActiveColors;
            if (this._origGetNextType) g.getNextType = this._origGetNextType;
            if (this._origMakePair) g._makePair = this._origMakePair;
            if (this._origUpdateStatsDisplay) g.updateStatsDisplay = this._origUpdateStatsDisplay;
            // 練習用に立てたフラグを共通エンジンから外す（VERSUS/ONLINEへ持ち越さない）
            delete g.practiceNoLock;
            delete g.practiceFallMs;
            delete g.practiceFallSpeedMs;
            delete g.practiceNextCount;
            delete g.practiceHoldMode;
            delete g.showGhost;
            delete g._colorOrder;
            if (this.rule === 'tet') {
                g.gravityDisabled = false;
                if (typeof _setHoldOverlayVisible === 'function') _setHoldOverlayVisible(false);
            }
        }
        if (this.rule === 'puyo') {
            const labelEl = document.getElementById('label-lines');
            if (labelEl) labelEl.textContent = 'CHAIN';
            if (typeof this._origColorCount === 'number') PConfig.colorCount = this._origColorCount;
        }
        if (typeof _closePracticePanel === 'function') _closePracticePanel();
        this._origPopMino = this._origGameOver = null;
        this._origSpawnPuyo = this._origBeginGameOver = null;
        this._origUpdateChainDisplay = null;
        this._origUpdateTimeDisplay = this._origUpdateTimeDisplayPuyo = null;
        this._origInitActiveColors = null;
        this._origGetNextType = this._origMakePair = null;
        this._origUpdateStatsDisplay = null;
        this.sequenceEnabled = false;
        this.seqConfig = this.seqRunner = null;
        this.gameInstance = null;
        this.history = [];
        this.cursor = -1;

        document.body.classList.remove('practice-mode');
        const linesGoalEl = document.getElementById('lines-goal');
        if (linesGoalEl) linesGoalEl.textContent = '';
        const scoreGoalEl = document.getElementById('score-goal');
        if (scoreGoalEl) scoreGoalEl.textContent = '';

        // 巻き戻しインジケータ／SPEED表示ブロックを初期状態に戻す（設計 §2・§3.1）
        const rewindBack = document.getElementById('practice-rewind-back');
        const rewindFwd = document.getElementById('practice-rewind-fwd');
        if (rewindBack) rewindBack.classList.add('is-disabled');
        if (rewindFwd) rewindFwd.classList.add('is-disabled');
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('practice-rewind-back-count', 0);
        set('practice-rewind-fwd-count', 0);
        const speedArea = document.getElementById('practice-speed-area');
        if (speedArea) speedArea.classList.remove('is-visible');
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 準備画面（mode-check）の PRACTICE 用オプション行
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 桁スピナー編集モードの状態（§4.2）。null = 非編集。
// { digits: number[], pos: number } — digits は上位桁から並べる。
let _practiceSpinner = null;

// ページを離れるときに編集モードを必ず畳む。開いたまま遷移すると
// FocusNav.suspended が立ちっぱなしになり、全ページでキー操作が止まる。
function _practiceResetSpinner() {
    if (_practiceSpinner) {
        _practiceSpinner = null;
        if (window.FocusNav) window.FocusNav.suspended = false;
    }
    // ツモ順設定エディタ（Phase 3 §7）も同じ理由で必ず畳む
    if (typeof PracticeSequence !== 'undefined') PracticeSequence.closeEditor();
}

function _practiceGoalLabel(type, rule) {
    if (type === 'lines') return 'LINES';
    if (type === 'puyos') return 'PUYOS';
    if (type === 'score') return 'SCORE';
    if (type === 'time') return 'TIME';
    return 'NONE';
}

// VALUE 行の中身（通常表示 / 編集中の桁ボックス / GOAL=NONE時のプレースホルダ）を組み立てる
function _practiceValueHtml() {
    const range = PRACTICE_GOAL_RANGE[practiceGoalType];
    if (!range) return '<div class="practice-value is-disabled">-</div>';
    if (_practiceSpinner) {
        const boxes = _practiceSpinner.digits.map((d, i) =>
            `<span class="practice-digit${i === _practiceSpinner.pos ? ' is-active' : ''}" onclick="_practiceFocusDigit(${i})">${d}</span>`
        ).join('');
        return `<div class="practice-value is-editing">${boxes}</div>`;
    }
    return `<div class="practice-value" onclick="_practiceOpenSpinner()">${practiceGoalValue().toLocaleString('en-US')}</div>`;
}

function renderPracticeModeCheckOptions(mode) {
    const countType = practiceCountGoalType(practiceRule);
    const goalBtn = (type) => `<button class="opt-btn ${practiceGoalType === type ? 'active' : ''}"
        onclick="setPracticeGoalType('${type}')">${_practiceGoalLabel(type, practiceRule)}</button>`;

    // VALUE 行は GOAL=NONE でも折りたたまず常に表示し、"-" で「値なし」を示す（畳むと違和感があるため）。
    // ヒント文も同様に常に同じ高さで出し、無効時は文言を残したまま dim する（設計 §6.5：行数が変わるとガタつく）。
    const isNone = (practiceGoalType === 'none');
    const hint = _practiceSpinner
        ? '0-9 で入力 / ←→ 桁移動 / ↑↓ その桁を増減 / Enter 確定 / Esc 取消'
        : '←→ でプリセット送り、Enter またはクリックで桁ごとに編集';
    const valueRow = `
        <div class="option-row"${isNone ? '' : ' data-nav-row="practice-goal-value"'}>
          <span class="option-label">VALUE</span>
          ${_practiceValueHtml()}
        </div>
        <p class="practice-value-hint${isNone ? ' is-disabled' : ''}">${hint}</p>`;

    return `
      <div class="option-row">
        <span class="option-label">RULE</span>
        <div class="option-toggle" id="practice-rule-toggle">
          <button class="opt-btn ${practiceRule === 'tet' ? 'active' : ''}" onclick="setPracticeRule('tet')">TET</button>
          <button class="opt-btn ${practiceRule === 'puyo' ? 'active' : ''}" onclick="setPracticeRule('puyo')">PUYO</button>
        </div>
      </div>
      <div class="option-row">
        <span class="option-label">GOAL</span>
        <div class="option-toggle" id="practice-goal-toggle">
          ${goalBtn('none')}${goalBtn(countType)}${goalBtn('score')}${goalBtn('time')}
        </div>
      </div>
      ${valueRow}
      ${_practiceSequenceRowHtml()}
    `;
}

// ─── SEQUENCE 行（設計 §7）───────────────────────
// OFF/ON トグル＋（ON時のみ）エディタを開くボタン。
function _practiceSequenceRowHtml() {
    const enabled = (typeof PracticeSequence !== 'undefined') && PracticeSequence.isEnabled(practiceRule);
    // EDIT SEQUENCE ボタンは OFF でも常に表示し、無効時は disabled + dim にする
    // （設計 §6.5：出たり消えたりすると下の要素がガタつくため）。
    return `
      <div class="option-row">
        <span class="option-label">SEQUENCE</span>
        <div class="option-toggle" id="practice-sequence-toggle">
          <button class="opt-btn ${!enabled ? 'active' : ''}" onclick="setPracticeSequenceEnabled(false)">OFF</button>
          <button class="opt-btn ${enabled ? 'active' : ''}" onclick="setPracticeSequenceEnabled(true)">ON</button>
        </div>
      </div>
      <button class="practice-seq-edit-btn${enabled ? '' : ' is-disabled'}"
        ${enabled ? '' : 'disabled'} onclick="openPracticeSequenceEditor()">EDIT SEQUENCE →</button>
    `;
}

// ─── 桁スピナー（§4.2。フィードバックにより一部変更）─────────
// 通常時: ←/→ で 1-2-5系プリセット送り / Enter またはクリックで編集モードへ
// 編集中: 一番左の桁からフォーカス。数字キーはその桁を確定して1つ右へ進む
//         （最終桁では上書きし続ける）。←/→ で桁移動、↑/↓ でその桁を±1、
//         Enter 確定、Esc 取消。
function _practiceStepPreset(delta) {
    const list = PRACTICE_GOAL_PRESETS[practiceGoalType];
    if (!list) return;
    const cur = practiceGoalValue();
    // 現在値がプリセット上にないときは、進む向きの最も近い値へ寄せる
    let idx = list.indexOf(cur);
    if (idx < 0) {
        idx = (delta > 0)
            ? list.findIndex(v => v > cur)
            : (() => { let last = -1; list.forEach((v, i) => { if (v < cur) last = i; }); return last; })();
        if (idx < 0) idx = (delta > 0) ? list.length - 1 : 0;
    } else {
        idx = Math.max(0, Math.min(list.length - 1, idx + delta));
    }
    practiceGoalValues[practiceGoalType] = list[idx];
    renderModeCheck();
}

function _practiceOpenSpinner() {
    const range = PRACTICE_GOAL_RANGE[practiceGoalType];
    if (!range) return; // GOAL=NONE では編集対象がない
    const s = String(practiceGoalValue()).padStart(range.digits, '0').slice(-range.digits);
    // 一番左の桁からフォーカスする
    _practiceSpinner = { digits: s.split('').map(Number), pos: 0 };
    // 編集中は行移動・2D移動・Enter/Escape を FocusNav から奪う
    if (window.FocusNav) window.FocusNav.suspended = true;
    renderModeCheck();
}

// 編集中、桁ボックスをクリックしてそこへフォーカスを移す
function _practiceFocusDigit(i) {
    if (!_practiceSpinner) return;
    _practiceSpinner.pos = i;
    renderModeCheck();
}

function _practiceCloseSpinner(commit) {
    const range = PRACTICE_GOAL_RANGE[practiceGoalType];
    if (commit && _practiceSpinner && range) {
        let v = parseInt(_practiceSpinner.digits.join(''), 10) || 0;
        v = Math.max(range.min, Math.min(range.max, v));
        practiceGoalValues[practiceGoalType] = v;
    }
    _practiceSpinner = null;
    if (window.FocusNav) window.FocusNav.suspended = false;
    renderModeCheck();
}

(function setupPracticeGoalValueNav() {
    if (!window.FocusNav) return;

    window.FocusNav.rowHandlers['practice-goal-value'] = {
        onLeft:     () => _practiceStepPreset(-1),
        onRight:    () => _practiceStepPreset(+1),
        onActivate: () => _practiceOpenSpinner(),
    };

    // 編集モード中だけ働くキーハンドラ。FocusNav より先に拾いたいので capture 段で受ける。
    document.addEventListener('keydown', (e) => {
        if (!_practiceSpinner) return;
        const page = document.getElementById('mode-check-page');
        if (!page || !page.classList.contains('active')) { _practiceCloseSpinner(false); return; }

        const range = PRACTICE_GOAL_RANGE[practiceGoalType];
        const last = range.digits - 1;
        let handled = true;

        if (e.key === 'Enter')            _practiceCloseSpinner(true);
        else if (e.key === 'Escape')      _practiceCloseSpinner(false);
        else if (e.key === 'ArrowLeft')  { _practiceSpinner.pos = Math.max(0, _practiceSpinner.pos - 1); renderModeCheck(); }
        else if (e.key === 'ArrowRight') { _practiceSpinner.pos = Math.min(last, _practiceSpinner.pos + 1); renderModeCheck(); }
        else if (e.key === 'ArrowUp')    { const p = _practiceSpinner.pos; _practiceSpinner.digits[p] = (_practiceSpinner.digits[p] + 1) % 10; renderModeCheck(); }
        else if (e.key === 'ArrowDown')  { const p = _practiceSpinner.pos; _practiceSpinner.digits[p] = (_practiceSpinner.digits[p] + 9) % 10; renderModeCheck(); }
        else if (e.key >= '0' && e.key <= '9') {
            // その桁を確定して1つ右へ進む（最終桁では上書きし続ける）
            _practiceSpinner.digits[_practiceSpinner.pos] = parseInt(e.key, 10);
            _practiceSpinner.pos = Math.min(last, _practiceSpinner.pos + 1);
            renderModeCheck();
        } else {
            handled = false;
        }

        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);
})();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// グローバル公開 API（navigation.js から呼ばれる）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// PRACTICE を開始する。tet/puyo どちらのエンジンも、対応するシングルプレイの
// 開始手順をそのまま使い、PracticeManager がフックを差し込む形で載せる。
function startPracticeGame() {
    _stopPracticeIfActive();

    const rule = practiceRule;
    const goal = { type: practiceGoalType, value: practiceGoalValue() };

    // APM/LPM は非表示（設計 §1.1）
    document.body.classList.add('practice-mode');

    const manager = new PracticeManager(rule, goal);
    window._practiceManager = manager;

    if (rule === 'puyo') {
        window._game = null; // tet インスタンスへの参照を切る

        ['puyo-main-canvas', 'puyo-next-canvas'].forEach(id => {
            const cv = document.getElementById(id);
            const ctx = cv && cv.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
        });

        _switchToPuyoLayout(true);

        window._puyoGame = new PuyoGame();
        GameManager.setInstance('p1', window._puyoGame);
        window._puyoGame.isCpuControlled = false;
        window._puyoGame.isVersusMode = false;
        window._puyoGame.currentMode = 'practice';

        manager.attach(window._puyoGame);
        manager._updateGoalDisplay();

        switchPage('game');
        // start() は内部で stop()→initGame()→カウントダウン。フックは prototype ではなく
        // インスタンスに載せているので、この再初期化でも外れない。
        window._puyoGame.start();
        // start()→initGame()→_setupCanvas() が nextCanvas を既定サイズ(128×259)へ
        // 同期的に上書きするため、attach()内で先に呼んだ resizeNextCanvas() の結果が
        // 消えてしまう。start() 呼び出し（_setupCanvas() までは同期）の直後に取り直す。
        if (typeof window._puyoGame.resizeNextCanvas === 'function') window._puyoGame.resizeNextCanvas();
        return;
    }

    _switchToPuyoLayout(false);

    if (!window._game || typeof window._game.initMainCanvas !== 'function') {
        window._game = new Game();
    }
    GameManager.setInstance('p1', window._game);

    window._game.currentMode = 'practice';
    window._game.isVersusMode = false;
    window._game.canvasPrefix = null;
    window._game.statsPrefix = null;
    window._game._labelsInitialized = false;
    window._game.isCpuControlled = false;
    window._game.initMainCanvas();
    window._game.initNextCanvas();
    window._game.initHoldCanvas();

    manager.attach(window._game);
    manager._updateGoalDisplay();

    switchPage('game');
    setupGlobalCpuPauseKey();
    window._game.start();
}

// リザルト画面の「巻き戻す」ボタン（index.html #result-practice-rewind-btn）から呼ばれる。
function practiceRewindFromResult() {
    if (window._practiceManager) window._practiceManager.rewindFromResult();
}

// ゲーム内の常設インジケータ（⟲/⟳）のクリック操作から呼ばれる（設計 §2.2）。
function practiceRewindStep(delta) {
    if (window._practiceManager) window._practiceManager.step(delta);
}

// stopAllGames() から呼ばれる。フックを外してマネージャを破棄する。
function _stopPracticeIfActive() {
    if (!window._practiceManager) return;
    window._practiceManager.destroy();
    window._practiceManager = null;
}

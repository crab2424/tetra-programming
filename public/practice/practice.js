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

// ─── 即時ツモ変化（設計 Phase5 §9）───
// tet: Mino.typeは 0:I 1:O 2:T 3:J 4:L 5:S 6:Z（core.js）なので、
// 要求サイクル I,T,S,Z,J,L,O をtype値の並びに変換する。
const TET_CYCLE = [0, 2, 5, 6, 3, 4, 1];
const TET_CYCLE_LABEL = ['I', 'O', 'T', 'J', 'L', 'S', 'Z']; // type値→表示ラベル
// puyo: 色番号 1:R 2:B 3:P 4:G 5:Y
// 実際の描画（draw.js _drawPuyo の imageIndex = color - 1、画像は puyo-0=赤/puyo-1=青/
// puyo-2=紫/puyo-3=緑/puyo-4=黄）に合わせた対応表。practice_sequence.jsのPUYO_COLOR_LABELS
// と同じ並びにする必要がある（Phase6実機フィードバックで3〜5番のズレが発覚し修正）。
const PUYO_COLOR_LABEL = { 1: 'R', 2: 'B', 3: 'P', 4: 'G', 5: 'Y' };

// CYCLEのサイクル表はactiveColorsの並び順をそのまま2桁n進数の桁に使うため、
// 並びが局ごとに変わると「次に何色が来るか」を覚え直すことになる。使う色の抽選
// （_colorOrderのシャッフル）は変えず、activeColorsへ入れる直前に正準順(R,B,G,Y,P)
// へ並べ替えるだけにする（設計 Phase7 §7）。
const PUYO_COLOR_RANK = { 1: 0, 2: 1, 4: 2, 5: 3, 3: 4 }; // R=1,B=2,G=4,Y=5,P=3
function sortPuyoColors(list) {
    return list.slice().sort((a, b) => PUYO_COLOR_RANK[a] - PUYO_COLOR_RANK[b]);
}

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
        // GAME OVER/FINISH演出中（isFinishedが立つ前）の締め出し用フラグ（設計 Phase5 §4.2）。
        // isFinishedは showFinishOverlay() のコールバック後にしか立たないため、1200msの
        // 演出中はこのフラグで操作を止める。resumeEngine/rewindFromResultでfalseに戻す。
        this.isEnding = false;

        // 即時ツモ変化（設計 Phase5 §9）。新しいツモが出るたびにリセットされるカウンタ。
        this._cycleCount = 0;

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
        // OFF→ON にした瞬間のNEXT/BAGと色数の退避（設計 Phase6 §6）。
        // ON→OFF に戻したときにここへ書き戻す。巻き戻し・destroy・ゲームオーバーで無効化する。
        this._seqVanilla = null;            // { next, bag? }
        this._seqVanillaColorCount = null;  // puyoのみ

        // おじゃま手動/自動投下（Phase 3 §6.2e）
        this.ojama = {
            auto: false,
            amount: (rule === 'puyo') ? 6 : 4,
            intervalSec: 10,
            holeRate: 70,           // 直列確率(%)。tetのみ有効（設計 Phase5 §8.2）
            timerId: null,          // setInterval（自動投下）
            pendingTimeouts: [],    // 予告→着弾の setTimeout（rewind時のゴースト書き込み防止に includes チェックで対処）
        };
        // AUTO OFF時の即時投下プレビュー（設計 Phase5 §8.3）。パネルを閉じるまでの間、
        // OJAMA AMTを動かすたびに退避した盤面へ戻してから再投下し直す。
        this.ojamaLive = null;

        // 盤面クリアのおじゃま部分削除（Phase 4 §4.2）。パネルの本数/個数指定に使う。
        this.clearAmount = 1;
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
                this.activeColors = sortPuyoColors(allColors.slice(0, PConfig.colorCount));

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
                        this.activeColors = sortPuyoColors(this._colorOrder.slice(0, neededN));
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
                // _capture()内でHUD更新が走るため、リセットは_capture()より前に置く
                // （順序が逆だとCYCLE表示が1手古いままになる。設計 Phase7 §2）
                self._cycleCount = 0; // 新しいツモが出るたびにリセット（設計 Phase5 §9.1）
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
                self._cycleCount = 0; // 新しいツモが出るたびにリセット（設計 Phase5 §9.1・Phase7 §2）
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
        } else if (this.rule === 'puyo') {
            // ─── puyoの「CHAIN」表示をSPEEDに置き換える（実機FB）───
            // 「LINES」枠は元々「CHAIN」（現在の連鎖数、連鎖が起きた時だけ更新）に
            // 転用されていたが、練習中は常時見えるSPEEDのほうが有用なため撤去して置き換える。
            const labelEl = document.getElementById('label-lines');
            if (labelEl) labelEl.textContent = 'SPEED';
            this._origUpdateChainDisplay = game._updateChainDisplay;
            game._updateChainDisplay = function (chain) {
                self._origUpdateChainDisplay.call(this, chain);
                if (this.linesEl) this.linesEl.textContent = _practiceFallLabel(self.fallLevel);
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

        // ─── ツモ順設定（設計 §7・Phase 4 §5.1）───
        // 準備画面で編集した practiceSequence[rule] をゲーム開始時点で凍結し（プレイ中に
        // 準備画面へ戻って弄っても影響を受けないように）、getNextType/_makePair を
        // ラップして差し込む（QUIZが同じ2関数を差し替えている実績あり）。
        // ゲーム内パネルのSEQUENCE編集（applySequenceEdit()）は改めてこの凍結をやり直す。
        const seqSrc = (typeof PracticeSequence !== 'undefined') ? PracticeSequence.config(this.rule) : null;
        this.sequenceEnabled = !!(seqSrc && seqSrc.enabled && seqSrc.bags.length);
        if (this.sequenceEnabled) {
            this.seqConfig = JSON.parse(JSON.stringify(seqSrc));
            this.seqConfig.gen = 0; // 編集世代番号（巻き戻し整合用。設計 §5.1）
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
        // gen は「この時点で使っていた列の世代」の記録（設計 §5.1）。
        const seqState = this.sequenceEnabled
            ? Object.assign(PracticeSequence.cloneRunnerState(this.seqRunner), { gen: this.seqConfig.gen || 0 })
            : undefined;
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
        if (!g || this.isFinished || this.isEnding) return false;
        if (this.rule === 'tet') return !g.isPaused && !!g.mino;
        return g.state === 'playing';
    }

    // GAME OVER/FINISH演出中(isEnding)は設定パネルの開閉タブ・巻き戻しインジケータを
    // クリック経路ごと隠す（設計 Phase5 §4.2）。rewindFromResult() / _resumeEngine() で表示を戻す。
    // カード本体（設計 Phase6 §8でビューポート固定配置に変更）は念のため閉じておく
    // （開いたままisEndingに入ることは togglePracticePanel() のガードにより実質起きない）。
    _hideEndingControls() {
        const tab = document.getElementById('practice-panel-tab');
        if (tab) tab.classList.add('is-hidden');
        document.body.classList.remove('practice-panel-open');
        // REWIND/CYCLEは消さず、暗くして操作だけ封じる（設計 Phase7 §6。演出中に
        // HUDが消えると位置が変わったように見えるとの実機FB）
        ['practice-status-left', 'practice-cycle-area'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('is-inert');
        });
    }
    _showEndingControls() {
        const tab = document.getElementById('practice-panel-tab');
        if (tab) tab.classList.remove('is-hidden');
        ['practice-status-left', 'practice-cycle-area'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('is-inert');
        });
    }

    // delta = -1 で1手戻る / +1 で1手進める（巻き戻しの取消）
    step(delta) {
        if (!this._isLive()) return false;
        const next = this.cursor + delta;
        if (next < 0 || next >= this.history.length) return false;
        this.cursor = next;
        this._restoreCurrent();
        this._flashRewind(delta);
        return true;
    }

    // 盤面中央に「何か移動した」ことを示す一瞬のフラッシュを出す（設計 Phase5 §5）。
    // dir<0: 戻る(⟲REWIND) / dir>0: 進む(⟲ADVANCE)。連打対応のため強制リフローで
    // アニメを毎回リスタートする。
    _flashRewind(dir) {
        const el = document.getElementById('practice-rewind-flash');
        if (!el) return;
        const iconEl = document.getElementById('practice-rewind-flash-icon');
        const textEl = document.getElementById('practice-rewind-flash-text');
        const posEl = document.getElementById('practice-rewind-flash-pos');
        el.classList.toggle('is-advance', dir > 0);
        if (iconEl) iconEl.textContent = (dir > 0) ? '⟳' : '⟲';
        if (textEl) textEl.textContent = (dir > 0) ? 'ADVANCE' : 'REWIND';
        if (posEl) posEl.textContent = this.cursor + ' / ' + Math.max(0, this.history.length - 1);
        el.classList.remove('is-active');
        void el.offsetWidth; // 強制リフロー。外すだけだと連打の2回目以降が光らない
        el.classList.add('is-active');
    }

    // ─────────────────────────────────────────
    // 即時ツモ変化（設計 Phase5 §9）。操作パネルには入れない隠し機能＝REWINDと同じ扱い。
    // 現在操作中のミノ/ぷよのみを固定サイクルで変化させる（NEXT/HOLDには触らない）。
    // ─────────────────────────────────────────
    cycleTsumo() {
        if (this.rule === 'tet') this._cycleTsumoTet();
        else this._cycleTsumoPuyo();
        this._refreshRewindIndicator(); // 「次に出るツモ」表示を更新する（設計 §7.2）
    }

    _cycleTsumoTet() {
        const g = this.gameInstance;
        if (!this._isLive() || !g.mino) return;
        const type = TET_CYCLE[this._cycleCount % TET_CYCLE.length];
        this._cycleCount++;
        const m = new Mino(type);
        m.spawn(); // 出現位置と初期回転（0）をセットする。回転を引き継ぐと型ごとの
                   // 壁蹴りの前提が崩れるため、常に出現時の向きへリセットする。
        m.x = g.mino.x;
        m.y = g.mino.y;
        const prev = g.mino;
        g.mino = m;
        // 形が変わって埋まる場合は上へ逃がす。それでも駄目なら出現位置に戻す。
        let guard = 0;
        while (!g.valid(0, 0) && guard++ < 4) g.mino.y -= 1;
        if (!g.valid(0, 0)) { g.mino = new Mino(type); g.mino.spawn(); }
        if (!g.valid(0, 0)) { g.mino = prev; return; } // 詰んでいるなら何もしない（GAMEOVERにしない）
        // 接地・ロック関連の状態をpopMino()と同じに初期化する（canHoldは変えない＝ツモ未消費）
        g.isGrounded = false;
        g.lowestY = g.mino.y;
        g.moveCount = 0;
        g.lastActionWasRotation = false;
        g.lastRotUsedPoint5 = false;
        if (g.lockTimer) { clearTimeout(g.lockTimer); g.lockTimer = null; }
        g.drawAll();
        this._flashCycle('⟳ ' + TET_CYCLE_LABEL[type]);
    }

    _cycleTsumoPuyo() {
        const g = this.gameInstance;
        if (!this._isLive()) return;
        const n = (g.activeColors || []).length;
        if (!n) return;
        const i = this._cycleCount % (n * n);
        this._cycleCount++;
        // 2桁n進数扱い：上位桁＝軸（下のぷよ）、下位桁＝子（上のぷよ）（設計 §9.3）
        g.pivotColor = g.activeColors[Math.floor(i / n)];
        g.childColor = g.activeColors[i % n];
        if (typeof g._render === 'function') g._render();
        const axisLabel = PUYO_COLOR_LABEL[g.pivotColor] || '?';
        const childLabel = PUYO_COLOR_LABEL[g.childColor] || '?';
        this._flashCycle('⟳ ' + axisLabel + '-' + childLabel);
    }

    // 即時ツモ変化の結果を盤面中央に一瞬出す（§5のREWINDフラッシュとは別の軽量な表示。
    // 連打時の視認性のためopacityのみでtransformは付けない。持続300ms）。
    _flashCycle(text) {
        const el = document.getElementById('practice-cycle-flash');
        if (!el) return;
        const textEl = document.getElementById('practice-cycle-flash-text');
        if (textEl) textEl.textContent = text;
        el.classList.remove('is-active');
        void el.offsetWidth; // 強制リフロー（連打対応）
        el.classList.add('is-active');
    }

    _restoreCurrent() {
        const g = this.gameInstance;
        const line = this.history[this.cursor];
        this.ojamaLive = null; // 巻き戻しで退避済みの盤面が無効になる（設計 Phase5 §8.3）
        this._cycleCount = 0; // 巻き戻し先のツモに合わせてリセット（設計 Phase5 §9.4）
        // SEQUENCE OFF復帰用の退避も、この時点の履歴とは食い違うため無効化する（設計 Phase6 §6.3）
        this._seqVanilla = null;
        this._seqVanillaColorCount = null;
        this._skipNextCapture = true;
        if (!PracticeSnapshot.restore(g, this.rule, line)) {
            this._skipNextCapture = false;
            return;
        }

        // ツモ順設定の消費位置も一緒に復元する（popMino/_spawnPuyo が次の枠を読む前に必要）。
        // ただし gen が現在の列と異なる（＝この局面より後でSEQUENCEを編集した）場合は
        // 古い bagOrder/itemPos を今の列に当てても意味がないため復元しない。
        // runnerはそのまま今の列を使い続ける（設計 §5.1）。
        if (this.sequenceEnabled) {
            const seqState = PracticeSnapshot.restoreSeqState(this.rule, line);
            const curGen = this.seqConfig ? (this.seqConfig.gen || 0) : 0;
            if (seqState && (seqState.gen || 0) === curGen) {
                PracticeSequence.applyRunnerState(this.seqRunner, seqState);
            }
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
    // HUD: SPEED表示（設計 §3.1・実機FBでpuyoも追加）
    // tet: LEVEL枠(#level-value)に統合。puyo: 旧CHAIN枠(#lines-value)を置き換え
    // （GOAL=PUYOSのときはその枠を進捗表示に使っているため触らない）。
    // ─────────────────────────────────────────
    _syncLevelDisplay() {
        if (this.rule === 'tet') {
            const el = document.getElementById('level-value');
            if (el) el.textContent = this.fallLevel;
            return;
        }
        if (this.goal.type === 'puyos') return;
        const el = document.getElementById('lines-value');
        if (el) el.textContent = _practiceFallLabel(this.fallLevel);
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

        // 即時ツモ変化（設計 Phase6 §7）: 次に押したときに出るツモを表示する
        set('practice-cycle-next', this._cycleNextLabel());
        const cycleBtn = document.getElementById('practice-cycle-btn');
        if (cycleBtn) cycleBtn.classList.toggle('is-disabled', !this._isLive());
    }

    // 次に cycleTsumo() を押したときに出る内容のラベル（盤面インジケータ表示用。設計 §7.2）
    _cycleNextLabel() {
        if (this.rule === 'tet') {
            return TET_CYCLE_LABEL[TET_CYCLE[this._cycleCount % TET_CYCLE.length]];
        }
        const g = this.gameInstance;
        const n = (g && g.activeColors || []).length;
        if (!n) return '?-?';
        const i = this._cycleCount % (n * n);
        const axis = g.activeColors[Math.floor(i / n)];
        const child = g.activeColors[i % n];
        return (PUYO_COLOR_LABEL[axis] || '?') + '-' + (PUYO_COLOR_LABEL[child] || '?');
    }

    // ─────────────────────────────────────────
    // ゲーム中の SEQUENCE 編集を反映する（設計 §5.1）
    // 設定パネルの SEQUENCE OFF/ON トグル、および EDIT → エディタの DONE/Esc から呼ばれる。
    // ─────────────────────────────────────────
    applySequenceEdit() {
        const g = this.gameInstance;
        if (!g) return;
        const self = this;
        const seqSrc = (typeof PracticeSequence !== 'undefined') ? PracticeSequence.config(this.rule) : null;
        const wasEnabled = this.sequenceEnabled;
        this.sequenceEnabled = !!(seqSrc && seqSrc.enabled && seqSrc.bags.length);

        if (this.sequenceEnabled) {
            if (!wasEnabled) {
                // OFF→ON: 何も変える前に「元の状態」を退避しておく（設計 Phase6 §6）。
                // OFFへ戻したときにここへ書き戻すことで、SEQUENCEを試す前のNEXT/BAG/色数を
                // 完全に復元できる。
                this._seqVanilla = this._captureVanillaQueue();
                if (this.rule === 'puyo') this._seqVanillaColorCount = PConfig.colorCount;
            }

            const prevGen = (this.seqConfig && this.seqConfig.gen) || 0;
            this.seqConfig = JSON.parse(JSON.stringify(seqSrc));
            this.seqConfig.gen = prevGen + 1; // 編集のたびに世代を進める（巻き戻し整合用）
            // 新しい列の先頭から開始する（途中のbagPos/itemPosは引き継がない。設計 §5.1）。
            // NEXTキューは末尾の_rebuildNextQueue()で丸ごと作り直すため即座に反映される
            // （Phase4-Cでは既存キューを残し遅延反映させていたが、Phase5 §7で即時反映に変更）。
            this.seqRunner = PracticeSequence.createRunner(this.seqConfig);

            if (!wasEnabled) {
                // OFF→ON: フックをここで新規に張る（attach()時点では未設置だったため）
                if (this.rule === 'tet' && !this._origGetNextType) {
                    this._origGetNextType = g.getNextType;
                    g.getNextType = function () {
                        return PracticeSequence.nextTetType(self.seqConfig, self.seqRunner);
                    }.bind(g);
                } else if (this.rule === 'puyo' && !this._origMakePair) {
                    this._origMakePair = g._makePair;
                    g._makePair = function (excludeColor = null) {
                        const pair = PracticeSequence.nextPuyoPair(self.seqConfig, self.seqRunner, this.activeColors);
                        return pair || self._origMakePair.call(this, excludeColor);
                    }.bind(g);
                }
            }

            // puyoの色数自動引き上げ（設計 §7.5）をゲーム中の編集でも再評価する
            if (this.rule === 'puyo') {
                const used = PracticeSequence.usedPuyoColors(this.seqConfig);
                let neededN = PConfig.colorCount;
                used.forEach(c => {
                    const idx = (g._colorOrder || []).indexOf(c);
                    if (idx >= 0) neededN = Math.max(neededN, idx + 1);
                });
                if (neededN > PConfig.colorCount) {
                    PConfig.colorCount = neededN;
                    g.activeColors = sortPuyoColors((g._colorOrder || []).slice(0, neededN));
                }
            }
        } else if (wasEnabled) {
            // ON→OFF: フックを外して通常生成に戻す
            if (this.rule === 'tet' && this._origGetNextType) {
                g.getNextType = this._origGetNextType;
                this._origGetNextType = null;
            } else if (this.rule === 'puyo' && this._origMakePair) {
                g._makePair = this._origMakePair;
                this._origMakePair = null;
            }
            this.seqConfig = null;
            this.seqRunner = null;

            // puyoの色数自動引き上げ（あれば）を、退避時点の値へ戻す（設計 Phase6 §6.5）
            if (this.rule === 'puyo' && this._seqVanillaColorCount != null) {
                PConfig.colorCount = this._seqVanillaColorCount;
                g.activeColors = sortPuyoColors((g._colorOrder || []).slice(0, this._seqVanillaColorCount));
            }
        }

        // ─── 即時反映（設計 Phase5 §7・Phase6 §6）───
        // ONにした場合はNEXTキューを丸ごと作り直して即座に効かせる。
        // OFFにした場合は、退避しておいたNEXT/BAGがあればそれを書き戻す（＝SEQUENCEを
        // 試す前の状態にそのまま戻る）。巻き戻しを挟んでいて退避が無効化されていた場合のみ
        // 従来どおり新規に作り直す。
        if (this.sequenceEnabled || !this._restoreVanillaQueue(wasEnabled ? this._seqVanilla : null)) {
            this._rebuildNextQueue();
        }
        if (!this.sequenceEnabled) { this._seqVanilla = null; this._seqVanillaColorCount = null; }

        if (typeof _practicePanelRefresh === 'function') _practicePanelRefresh();
    }

    // SEQUENCEをONにする直前のNEXT/BAGを退避する（設計 Phase6 §6.2）
    _captureVanillaQueue() {
        const g = this.gameInstance;
        if (!g) return null;
        if (this.rule === 'tet') {
            return { next: g.nextQueue.map(m => m.type), bag: g.bag.slice() };
        }
        return { next: g.nextQueue.map(p => p.slice()) };
    }

    // ON→OFFで退避済みのNEXT/BAGを書き戻す。snapが無ければ何もせずfalseを返す
    // （呼び出し側は_rebuildNextQueue()にフォールバックする。設計 Phase6 §6.2）
    _restoreVanillaQueue(snap) {
        const g = this.gameInstance;
        if (!g || !snap) return false;
        if (this.rule === 'tet') {
            g.nextQueue = snap.next.map(t => new Mino(t));
            g.bag = snap.bag.slice();
            while (g.nextQueue.length < 11) g.nextQueue.push(new Mino(g.getNextType()));
            if (typeof g.drawAll === 'function') g.drawAll();
        } else {
            g.nextQueue = snap.next.map(p => p.slice());
            while (g.nextQueue.length < 20) g.nextQueue.push(g._makePair());
            if (typeof g._renderNext === 'function') g._renderNext();
        }
        return true;
    }

    // NEXTキューを丸ごと作り直す（設計 Phase5 §7.2）。操作中のミノ/ぷよ自体は変えない。
    // 巻き戻し履歴には積まない（手の境界ではないため。§7.4のとおりnextQueue/bagは
    // スナップショットに丸ごと保存されているので、この場で捨てても過去は壊れない）。
    _rebuildNextQueue() {
        const g = this.gameInstance;
        if (!g) return;
        if (this.rule === 'tet') {
            g.nextQueue = [];
            g.bag = [];
            while (g.nextQueue.length < 11) g.nextQueue.push(new Mino(g.getNextType()));
            if (typeof g.drawAll === 'function') g.drawAll();
        } else {
            g.nextQueue = [];
            while (g.nextQueue.length < 20) g.nextQueue.push(g._makePair());
            if (typeof g._renderNext === 'function') g._renderNext();
        }
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
        if (this.isFinished || this.isEnding) return;
        this.isEnding = true;
        this.ojamaLive = null;
        this._seqVanilla = null;
        this._seqVanillaColorCount = null;
        this._hideEndingControls();
        const g = this.gameInstance;
        // 詰んだ瞬間の盤面（tetは被せたミノ／puyoは窒息したぷよ）を1枚描いてから止める。
        // 止めてから描くとrAFが既に切れて最後の1フレームが出ない（設計 Phase5 §4.1）。
        if (this.rule === 'tet') {
            if (typeof g.drawAll === 'function') g.drawAll();
        } else {
            if (typeof g._render === 'function') g._render();
        }
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
        if (this.isFinished || this.isEnding) return;
        this.isEnding = true;
        this.ojamaLive = null;
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
        document.body.classList.remove('practice-panel-open');

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
        this.isEnding = false;
        this._showEndingControls();
        this._restoreCurrent();
        this._resumeEngine();
        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(this.rule === 'puyo');
        if (typeof switchPage === 'function') switchPage('game');
        // game-pageがactiveになった後に光らせる（非activeなDOMではCSSアニメが進行しないため）
        this._flashRewind(-1);
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
        amount = Math.max(0, (amount === undefined ? this.ojama.amount : amount));
        if (amount <= 0) return; // 0は「送らない」（設計 Phase6 §3）

        // AUTO OFF時は予告を挟まず即着弾させる（設計 Phase5 §8.1）。AUTO ONは
        // 従来どおり予告つきの経路を使う（対戦の練習として正しい挙動を維持する）。
        if (!this.ojama.auto) {
            this._dropOjamaNow(amount);
            if (typeof _practicePanelRefresh === 'function') _practicePanelRefresh();
            return;
        }

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

    // 直列確率(§8.2)にもとづいて穴位置の列をholesの末尾からn本目まで継ぎ足す（設計 Phase6 §4）。
    // 既存要素は絶対に書き換えない＝AMTを増減してもすでに使った穴の位置はズレない。
    // tetのgarbage.jsの計算式と同型にすることで、versusと同じ見た目の穴になる。
    _extendHoleList(holes, n) {
        const rate = (this.ojama.holeRate ?? 70) / 100;
        while (holes.length < n) {
            const last = holes.length ? holes[holes.length - 1] : -1;
            let h;
            if (last < 0) h = Math.floor(Math.random() * COLS_COUNT);
            else if (Math.random() < rate) h = last;
            else h = (last + 1 + Math.floor(Math.random() * (COLS_COUNT - 1))) % COLS_COUNT;
            holes.push(h);
        }
        return holes;
    }
    _makeHoleList(n) { return this._extendHoleList([], n); }

    // AUTO OFF時の即時投下本体（設計 Phase5 §8.1・§8.3）。holesOverrideを渡すとその列を
    // そのまま使う（redropOjamaLive経由）。keepLive=trueのときはojamaLiveの退避をやり直さない
    // （既に退避済みの盤面へ戻してから呼ばれるため）。
    _dropOjamaNow(amount, holesOverride, keepLive) {
        const g = this.gameInstance;
        if (!g) return;
        if (!keepLive) {
            this.ojamaLive = {
                field: this._snapshotFieldOnly(),
                minoY: (this.rule === 'tet' && g.mino) ? g.mino.y : null,
                holes: [],
                amount,
            };
        }
        const holes = holesOverride || (this.ojamaLive
            ? this._extendHoleList(this.ojamaLive.holes, amount).slice(0, amount)
            : this._makeHoleList(amount));

        if (this.rule === 'tet') {
            g.garbageQueue.push({ amount, holes, ready: true });
            g.applyGarbage();
            // applyGarbage()は既存ブロックを上へずらして最下段に積むため、操作中のミノも
            // 一緒に持ち上げないと山に埋まって見える（相対位置を保つ＝体感どおり）。
            // ただし出現位置（spawn()のy）より上へは押し出さない（設計 Phase6 実機FB）。
            if (g.mino) {
                const spawnY = (g.mino.type === 0) ? -1 : -2;
                g.mino.y = Math.max(spawnY, g.mino.y - amount);
                let guard = 0;
                while (!g.valid(0, 0) && g.mino.y > spawnY && guard++ < 8) g.mino.y -= 1;
            }
            g.field.markDirty();
            g.drawAll();
            this._renderGarbageGauge();
        } else {
            g.garbageQueue.push({ amount, holes: [], ready: true });
            const prevGs = g._gs;
            const prevDropped = g.hasDroppedOjamaThisTurn;
            if (g._generateOjama()) {
                // アニメを挟まず即時確定させる（パネル操作中＝ポーズ中のため）。
                // 連鎖は誘発させない＝_render()のみ（設計 §4.2と同じ方針）。
                if (g._dropAnim) { g._applyDropAnim(); g._dropAnim = null; }
                g._gs = prevGs; // 'dropping'のまま抜けるとターン進行が壊れる
                // _generateOjama()が立てるhasDroppedOjamaThisTurnをそのままにすると
                // このターンのAUTO由来の落下が抑止されてしまうため元に戻す
                g.hasDroppedOjamaThisTurn = prevDropped;
                g._render();
            }
            if (typeof g._updateOjamaYokoku === 'function') g._updateOjamaYokoku();
        }
    }

    // OJAMA AMTをいじるたびに呼ばれる（設計 Phase5 §8.3）。退避しておいた投下直前の
    // 盤面へ戻してから、穴列を使って再投下する。amount<=0のときは投下前の盤面に戻すだけ
    // ＝投下キャンセル。LIVEは外さない（設計 Phase6 §3）。
    //
    // 穴列の扱い（設計 Phase6 §4・ユーザーからの補足で修正）: 減らした分の穴は
    // 「消えた」ものとして配列から切り捨てる。そのため 4→3→4 のように一度減らしてから
    // 同じ本数へ戻すと、消えていた段（一番下＝最後に足された段）だけ改めて抽選され、
    // 残っていた段（4→3で切り捨てられなかった上の段）は元の穴のまま変わらない。
    redropOjamaLive(amount) {
        if (!this.ojamaLive) return;
        const g = this.gameInstance;
        if (!g) return;
        this._restoreFieldOnly(this.ojamaLive.field);
        if (this.rule === 'tet' && this.ojamaLive.minoY !== null && g.mino) {
            g.mino.y = this.ojamaLive.minoY;
        }
        this.ojamaLive.amount = amount;
        // 減らした分の穴は捨てる。再度増やしたときはその段だけ新規抽選になる
        if (amount < this.ojamaLive.holes.length) this.ojamaLive.holes.length = amount;
        if (amount <= 0) {
            // _restoreFieldOnly()は描画までは行わないため、ここで描き直す
            if (this.rule === 'tet') { g.field.markDirty(); g.drawAll(); this._renderGarbageGauge(); }
            else if (typeof g._render === 'function') g._render();
            return;
        }
        const holes = this._extendHoleList(this.ojamaLive.holes, amount).slice(0, amount);
        this._dropOjamaNow(amount, holes, true);
    }

    // 盤面のみを退避/復元する（PracticeSnapshot.restore()は次のツモ/スコア等まで
    // 巻き戻してしまい手元のミノが消えるため使えない。設計 Phase5 §8.3）。
    _snapshotFieldOnly() {
        const g = this.gameInstance;
        if (this.rule === 'tet') return g.field.blocks.map(b => ({ x: b.x, y: b.y, type: b.type }));
        return g.field.map(row => row.slice());
    }
    _restoreFieldOnly(snap) {
        const g = this.gameInstance;
        if (this.rule === 'tet') {
            g.field = new Field();
            snap.forEach(b => g.field.blocks.push(new Block(b.x, b.y, b.type)));
            g.field.markDirty(); // 忘れると_occ/_fixedCanvasに残像（設計 v5 §5.7の罠）
        } else {
            for (let r = 0; r < snap.length; r++) g.field[r] = snap[r].slice();
        }
    }

    // 自動投下ON/OFF。タイマーは実時間ベースで、パネルの開閉(pause)やrewindを挟んでも
    // クリアせず継続する（設計 §5.5）。ただし「今この瞬間プレイ中でない」ティックは
    // 投げっぱなしにせずスキップする（再開時にまとめて何本も降ってくるのを防ぐ）。
    setOjamaAuto(on) {
        this.ojama.auto = on;
        if (this.ojama.timerId) { clearInterval(this.ojama.timerId); this.ojama.timerId = null; }
        if (on) {
            // 予告つきの経路に切り替わるため、AUTO OFF中のリアルタイム調整プレビューは確定させる
            this.ojamaLive = null;
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

    // 直列確率（設計 Phase5 §8.2）。tetのgarbage.jsが既に読んでいるg.vsGarbageHoleRate
    // にそのまま書き込む＝エンジン改変ゼロで済む（versusの仕組みを間借りする）。
    // puyoには「直列」の概念が無いため呼ばれない（パネル側でtet限定にガード）。
    setOjamaHoleRate(pct) {
        this.ojama.holeRate = Math.max(0, Math.min(100, pct));
        const g = this.gameInstance;
        if (g && this.rule === 'tet') g.vsGarbageHoleRate = this.ojama.holeRate;
    }

    // ─────────────────────────────────────────
    // 盤面クリア：部分削除（設計 Phase5 §4.2）。おじゃま限定はPhase6 §2で撤廃し、
    // 中身を問わず「空でない行/セル」を対象にした（拡張性のため）。
    // 全消し（practiceClearBoard）と同じ扱いで巻き戻し履歴には積まない（§9-1）。
    // ─────────────────────────────────────────
    clearPartial(amount) {
        const g = this.gameInstance;
        if (!g) return;
        this.ojamaLive = null; // 盤面をここで書き換えるため退避済みのプレビューは無効化する
        amount = Math.max(1, amount || 1);
        if (this.rule === 'tet') {
            // 下(yが大きい)から数えてamount行まで、空行はスキップして非空の行を消す。
            const field = g.field;
            let removed = 0;
            let r = ROWS_COUNT - 1;
            while (r >= 0 && removed < amount) {
                const rowBlocks = field.blocks.filter(b => b.y === r);
                const isTarget = rowBlocks.length > 0;
                if (isTarget) {
                    // 通常のライン消去と同じ詰め処理（Field.checkLine()と同型）：
                    // 該当行を除去し、上にあるブロック(y<r)を1段ずつ下げる。
                    field.blocks = field.blocks.filter(b => b.y !== r);
                    field.blocks.filter(b => b.y < r).forEach(b => b.y++);
                    removed++;
                    // 詰め処理で1つ上の内容がこの行へ落ちてきたので、同じrを再チェックする
                } else {
                    r--;
                }
            }
            if (removed > 0) {
                field.markDirty();
                g.drawAll();
            }
        } else {
            // 上(r昇順)・列は左から走査してamount個の空でないセルを0にする。
            const totalRows = PConfig.rows + PConfig.hiddenRows;
            let removed = 0;
            outer:
            for (let r = 0; r < totalRows; r++) {
                for (let c = 0; c < PConfig.cols; c++) {
                    if (removed >= amount) break outer;
                    if (g.field[r][c] !== 0) {
                        g.field[r][c] = 0;
                        removed++;
                    }
                }
            }
            if (removed > 0) {
                // 既存の落下アニメ構築(_buildDropAnim)をそのまま即時確定させる（アニメを挟まない）。
                // 連鎖判定は誘発させない＝_render()のみ（設計 §4.2）。
                if (typeof g._buildDropAnim === 'function') {
                    g._buildDropAnim();
                    if (g._dropAnim) {
                        g._applyDropAnim();
                        g._dropAnim = null;
                    }
                }
                if (typeof g._render === 'function') g._render();
            }
        }
        if (typeof _practicePanelRefresh === 'function') _practicePanelRefresh();
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
        // GAME OVER/FINISH演出中(isEnding)の締め出し対象（設計 Phase5 §4.2）。
        // リスタート/ポーズが素通りすると、止めたはずのエンジンが復活してしまう。
        const restartCodes = codesOf('restart', 'KeyR');
        const pauseCodes = codesOf('pause', 'Escape');
        // 即時ツモ変化（設計 Phase5 §9）。操作パネルには入れないキー専用の隠し機能。
        const cycleCodes = codesOf('cycleTsumo', 'KeyC');
        const holdCodes = codesOf('hold', 'ShiftLeft');

        // インジケータのキー表記を実際の割り当てに合わせる（設計 §2.2）
        const shortLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
        const keysLabelEl = document.getElementById('practice-rewind-keys');
        if (keysLabelEl) keysLabelEl.textContent = shortLabel(rewindCodes[0]) + ' / ' + shortLabel(advanceCodes[0]);
        // 即時ツモ変化のキー表記も同様に実バインドから埋める（設計 Phase6 §7.2）
        const cycleKeysLabelEl = document.getElementById('practice-cycle-keys');
        if (cycleKeysLabelEl) cycleKeysLabelEl.textContent = shortLabel(cycleCodes[0]);

        this._keyHandler = (e) => {
            if (e.repeat) return;
            const gamePage = document.getElementById('game-page');
            if (!gamePage || !gamePage.classList.contains('active')) return;
            // 演出中はリスタート/ポーズをここで奪って止める（本体の入力ハンドラより先に、
            // capture段で登録しているので確実に先取りできる）。
            if ((this.isEnding || this.isFinished) &&
                (restartCodes.includes(e.code) || pauseCodes.includes(e.code))) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            if (rewindCodes.includes(e.code)) {
                e.preventDefault();
                this.step(-1);
            } else if (advanceCodes.includes(e.code)) {
                e.preventDefault();
                this.step(+1);
            } else if (cycleCodes.includes(e.code)) {
                e.preventDefault();
                this.cycleTsumo();
            } else if (holdCodes.includes(e.code)) {
                // ホールドで手元のミノが入れ替わるため、サイクルの起点をやり直す
                // （設計 §9.4）。ホールド自体はここで奪わず本体のハンドラに渡す。
                this._cycleCount = 0;
            }
        };
        // capture段（第3引数true）で登録し、tet/puyoそれぞれの本体キーハンドラより先に奪う。
        document.addEventListener('keydown', this._keyHandler, true);
        this._refreshRewindIndicator();
    }

    _removeKeyHandler() {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler, true);
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
            delete g.vsGarbageHoleRate; // §8.2。versusモードに持ち越さない
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
        set('practice-cycle-next', '');
        const cycleArea = document.getElementById('practice-cycle-area');
        if (cycleArea) cycleArea.classList.remove('is-visible');

        // REWIND/CYCLEのフラッシュ演出を強制的に止める（実機FB）。ページを離れて
        // #game-pageがdisplay:noneになるとCSSアニメが途中で止まったまま.is-activeが
        // 残り続け、RETRYで#game-pageが再表示された瞬間にアニメが最初から再生され、
        // 古いテキスト（前回の巻き戻し手数など）が一瞬見えてしまうため、破棄時に
        // 必ずクラスを外して止める。
        const rewindFlash = document.getElementById('practice-rewind-flash');
        if (rewindFlash) rewindFlash.classList.remove('is-active', 'is-advance');
        const cycleFlash = document.getElementById('practice-cycle-flash');
        if (cycleFlash) cycleFlash.classList.remove('is-active');
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
    // ツモ順設定エディタ（Phase 3 §7）も同じ理由で必ず畳む。ページを離れるのは
    // 「確定」ではないので取消扱いにする（設計 Phase6 §5.3）
    if (typeof PracticeSequence !== 'undefined') PracticeSequence.closeEditor(false);
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
      <button class="practice-help-btn" onclick="openInfoPage('practice-help')">HELP →</button>
    `;
}

// ─── HELPページ（設計 Phase6 §9.4）: KEYS欄を実バインドから埋める ───────
// switchPage()の pageId==='practice-help' 分岐から呼ばれる。
// [data-practice-key="xxx"] のプレースホルダにshortLabel化したキー名を差し込む。
function renderPracticeHelpKeys() {
    const keys = (typeof loadKeys === 'function') ? loadKeys() : null;
    const codesOf = (action, fallback) => {
        const k = keys && keys[action];
        return (k && k.codes && k.codes.length) ? k.codes : [fallback];
    };
    const shortLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
    const set = (action, fallback) => {
        const label = shortLabel(codesOf(action, fallback)[0]);
        document.querySelectorAll('[data-practice-key="' + action + '"]').forEach(el => {
            el.textContent = label;
        });
    };
    set('rewind', 'KeyQ');
    set('advance', 'KeyE');
    set('cycleTsumo', 'KeyC');
    set('practicePanel', 'Tab');
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

// 即時ツモ変化インジケータ（⟳）のクリック操作から呼ばれる（設計 Phase6 §7.2）。
function practiceCycleTsumo() {
    if (window._practiceManager) window._practiceManager.cycleTsumo();
}

// stopAllGames() から呼ばれる。フックを外してマネージャを破棄する。
function _stopPracticeIfActive() {
    if (!window._practiceManager) return;
    window._practiceManager.destroy();
    window._practiceManager = null;
}

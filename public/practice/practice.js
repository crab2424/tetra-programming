// ─────────────────────────────────────────────
// practice.js
// PRACTICEモード（1人用の練習モード）の進行管理
//
// 設計: source_assets/memory/tetlabo-practice-mode-design.md
// このファイルは Phase 1（§10）の範囲を実装する：
//   ・モード追加（準備画面の RULE / GOAL / VALUE）
//   ・自由落下速度0と、それに伴う固定仕様（§8）
//   ・1手ごとの巻き戻し（§5。直列化は practice_snapshot.js）
//   ・目標 LINES / PUYOS / SCORE と桁スピナー入力（§4.2）
//   ・記録除外・APM/LPM非表示
// Phase 2（ゲーム内設定パネル・時間目標・リザルトからの巻き戻し）と
// Phase 3（おじゃま投下・ツモ順設定）は未実装。
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
        } else {
            game.practiceFallMs = 0;       // 自然落下なし
            game.practiceNoLock = true;
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

        this._installKeyHandler();
        this._startGoalLoop();
    }

    // ─────────────────────────────────────────
    // スナップショットと巻き戻し（設計 §5）
    // ─────────────────────────────────────────
    _capture() {
        if (this._skipNextCapture) { this._skipNextCapture = false; return; }
        const line = PracticeSnapshot.capture(this.gameInstance, this.rule);

        // 巻き戻した先から打ち直したら、それより先の履歴は無効になる
        if (this.cursor < this.history.length - 1) {
            this.history.length = this.cursor + 1;
        }
        this.history.push(line);
        if (this.history.length > PRACTICE_HISTORY_MAX) this.history.shift();
        this.cursor = this.history.length - 1;
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

        if (this.rule === 'tet') {
            // 復元は「ツモ消費前」の状態なので、ここで同じミノを出し直す
            g.popMino();
            g.startGravity();
            g.drawAll();
        }
        // puyo は _gs='spawn' に戻してあるので、次フレームの _update が自分で出し直す

        // 巻き戻したら目標達成の判定もやり直す（達成表示は出し直さない＝
        // goalAchievedStats は「最初に達成した瞬間の値」を保つ、という決定に従う）
        this._updateGoalDisplay();
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
            default:      return 0;
        }
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

        if (typeof _switchToPuyoLayout === 'function') _switchToPuyoLayout(this.rule === 'puyo');
        if (typeof switchPage === 'function') switchPage('result');
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

        const g = this.gameInstance;
        if (g) {
            if (this._origPopMino) g.popMino = this._origPopMino;
            if (this._origGameOver) g.gameOver = this._origGameOver;
            if (this._origSpawnPuyo) g._spawnPuyo = this._origSpawnPuyo;
            if (this._origBeginGameOver) g._beginGameOver = this._origBeginGameOver;
            if (this._origUpdateChainDisplay) g._updateChainDisplay = this._origUpdateChainDisplay;
            // 練習用に立てたフラグを共通エンジンから外す（VERSUS/ONLINEへ持ち越さない）
            delete g.practiceNoLock;
            delete g.practiceFallMs;
            if (this.rule === 'tet') g.gravityDisabled = false;
        }
        if (this.rule === 'puyo') {
            const labelEl = document.getElementById('label-lines');
            if (labelEl) labelEl.textContent = 'CHAIN';
        }
        this._origPopMino = this._origGameOver = null;
        this._origSpawnPuyo = this._origBeginGameOver = null;
        this._origUpdateChainDisplay = null;
        this.gameInstance = null;
        this.history = [];
        this.cursor = -1;

        document.body.classList.remove('practice-mode');
        const linesGoalEl = document.getElementById('lines-goal');
        if (linesGoalEl) linesGoalEl.textContent = '';
        const scoreGoalEl = document.getElementById('score-goal');
        if (scoreGoalEl) scoreGoalEl.textContent = '';
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
    if (!_practiceSpinner) return;
    _practiceSpinner = null;
    if (window.FocusNav) window.FocusNav.suspended = false;
}

function _practiceGoalLabel(type, rule) {
    if (type === 'lines') return 'LINES';
    if (type === 'puyos') return 'PUYOS';
    if (type === 'score') return 'SCORE';
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

    // VALUE 行は GOAL=NONE でも折りたたまず常に表示し、"-" で「値なし」を示す（畳むと違和感があるため）
    const isNone = (practiceGoalType === 'none');
    const hint = isNone
        ? ''
        : (_practiceSpinner
            ? '0-9 で入力 / ←→ 桁移動 / ↑↓ その桁を増減 / Enter 確定 / Esc 取消'
            : '←→ でプリセット送り、Enter またはクリックで桁ごとに編集');
    const valueRow = `
        <div class="option-row"${isNone ? '' : ' data-nav-row="practice-goal-value"'}>
          <span class="option-label">VALUE</span>
          ${_practiceValueHtml()}
        </div>
        ${hint ? `<p class="practice-value-hint">${hint}</p>` : ''}`;

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
          ${goalBtn('none')}${goalBtn(countType)}${goalBtn('score')}
        </div>
      </div>
      ${valueRow}
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

// stopAllGames() から呼ばれる。フックを外してマネージャを破棄する。
function _stopPracticeIfActive() {
    if (!window._practiceManager) return;
    window._practiceManager.destroy();
    window._practiceManager = null;
}

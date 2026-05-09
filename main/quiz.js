// ─────────────────────────────────────────────
// quiz.js
// QUIZモード定義・クリア条件チェック・レベル管理
// ─────────────────────────────────────────────

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUIZ レベルデータ定義 (JSONからの読み込み)
// ※ データ自体は /quizlevels/tdata.json と /quizlevels/pdata.json に分離しています。
//
// 各レベルのフォーマット:
// {
//   "id": "tet-1",            // 一意なID
//   "title": "QUIZ 1",        // 表示タイトル
//   "description": "説明文",  // 説明（日本語）
//   "rule": "tet",            // "tet" または "puyo"
//   "allowHold": false,       // (tetのみ) HOLDを許可するかどうか。未指定時はfalse扱い
//
//   // ─── テトリス用フィールド ───
//   // "initialField": 行ごとのブロック配列（上から順）
//   //   各行は長さ10の配列、0=空、1〜7=ブロック種類（色ID）
//   //   行数は任意（最大20行分、下詰めで配置される）
//   "initialField": [ ... ],
//
//   // ─── ぷよ用フィールド ───
//   // "initialPuyoField": 行ごとの配列（上から順）
//   //   各行は長さ6の配列、0=空、1〜5=色、6=おじゃまぷよ
//   "initialPuyoField": [ ... ],
//
//   // ─── NEXT（有限・固定） ───
//   // "nextPieces": テト用ミノタイプの配列 (0=I,1=O,2=T,3=J,4=L,5=S,6=Z)
//   "nextPieces": [ ... ],
//   // "nextPuyoPairs": ぷよ用ペアの配列 [[pivot色, child色], ...]
//   "nextPuyoPairs": [ ... ],
//
//   // ─── クリア条件 ───
//   // "clearCondition": {
//   //   "type": "clearLines"       // n行消去
//   //         | "allClear"       // フィールド全消し
//   //         | "score"          // スコアがn以上
//   //         | "chain"          // n連鎖以上（ぷよ）
//   //   "value": number            // type に対応する値
//   //   "description": "説明"      // クリア条件の説明文
//   // }
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── 外部JSONからレベルデータを読み込む ─────────
let QUIZ_LEVELS = { tet: [], puyo: [] };
let _isQuizLevelsLoaded = false;

async function loadQuizLevels() {
    if (_isQuizLevelsLoaded) return;
    try {
        const [tetRes, puyoRes] = await Promise.all([
            fetch('quizlevels/tdata.json'),
            fetch('quizlevels/pdata.json')
        ]);
        if (tetRes.ok) QUIZ_LEVELS.tet = await tetRes.json();
        if (puyoRes.ok) QUIZ_LEVELS.puyo = await puyoRes.json();
        _isQuizLevelsLoaded = true;
    } catch (e) {
        console.error("QUIZレベルデータの読み込みに失敗しました:", e);
    }
}

// ─── QUIZ用 HOLD禁止斜線オーバーレイ管理 ─────────
function _setHoldOverlayVisible(visible) {
    let overlay = document.getElementById('quiz-hold-overlay');
    const holdCanvas = document.getElementById('hold-canvas');

    if (!holdCanvas) return;

    if (!overlay && visible) {
        const container = holdCanvas.parentElement;
        overlay = document.createElement('div');
        overlay.id = 'quiz-hold-overlay';
        container.appendChild(overlay);
    }

    if (overlay) {
        if (visible) {
            // CSSで設定された hold-canvas の位置・サイズ・角丸を自動で取得して同期
            const t = holdCanvas.offsetTop;
            const l = holdCanvas.offsetLeft;
            const w = holdCanvas.offsetWidth;
            const h = holdCanvas.offsetHeight;
            const br = window.getComputedStyle(holdCanvas).borderRadius;
            
            // キャンバスの枠線（var(--border)）と同じ色で、2px幅のシャープな斜線を引く
            overlay.style.cssText = `
                position: absolute;
                top: ${t}px; 
                left: ${l}px;
                width: ${w}px; 
                height: ${h}px;
                pointer-events: none;
                z-index: 10;
                background: linear-gradient(to top right, transparent calc(50% - 1px), var(--border) calc(50% - 1px), var(--border) calc(50% + 1px), transparent calc(50% + 1px));
                border-radius: ${br};
                display: block;
            `;
        } else {
            overlay.style.display = 'none';
        }
    }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QuizManager : クイズの進行・クリア判定を管理するクラス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class QuizManager {
    constructor() {
        this.currentLevel = null;  
        this.gameInstance = null;  
        this.isClear      = false;
        this.isFailed     = false;
        
        // リセット（元に戻す）用の関数保存用プロパティ
        this._originalPopMino         = null; 
        this._originalGetNextType     = null;
        this._originalHoldCurrentMino = null;
        this._originalDrawHold        = null; 
        this._originalDequeueNext     = null; 
        this._originalMakePair        = null;
        
        this._remainingPieces = []; 
        this._remainingPairs  = []; 
    }

    // ─── ダミーミノの生成（テト用、完全に描画されない透明なミノ） ─────
    _createDummyMino() {
        const dummy = new Mino(0); // ベースは作るが描画させない
        dummy._quizDummy = true;
        const noop = function() {};
        dummy.draw = noop;
        dummy.drawNext = noop;
        dummy.drawHold = noop;
        dummy.drawAt = noop;
        dummy.drawGhost = noop;
        return dummy;
    }

    // ─── クイズ開始 ──────────────────────────────
    start(levelData, gameInstance) {
        this.currentLevel  = levelData;
        this.gameInstance  = gameInstance;
        this.isClear       = false;
        this.isFailed      = false;

        if (levelData.rule === 'tet') {
            this._startTet(levelData, gameInstance);
        } else {
            this._startPuyo(levelData, gameInstance);
        }
    }

    // ─── テトリス用初期化 ─────────────────────────
    _startTet(levelData, game) {
        // 残りNEXTを複製
        this._remainingPieces = [...levelData.nextPieces];

        // フィールドにクイズ初期配置を反映
        this._applyTetField(levelData.initialField, game);

        // NEXTキューを固定ピースで上書き
        game.bag = [];
        game.nextQueue = [];
        for (let i = 0; i < Math.min(5, this._remainingPieces.length); i++) {
            game.nextQueue.push(new Mino(this._remainingPieces[i]));
        }
        // 5個以降は、描画されない完全なダミー（透明）で埋める
        while (game.nextQueue.length < 5) {
            game.nextQueue.push(this._createDummyMino());
        }

        const self = this;
        // モード終了時に復元できるよう保存
        this._originalPopMino = game.popMino;
        this._originalGetNextType = game.getNextType;
        this._originalHoldCurrentMino = game.holdCurrentMino;
        
        let nextPieceIndex = 0;

        game.popMino = function() {
            // 次のミノが出現する直前（前の一手が確定した瞬間）にクリア判定を行う
            if (self._checkClear()) return;

            const currentMino = this.nextQueue[0];
            if (currentMino && currentMino._quizDummy) {
                self._onFailed();
                return;
            }

            // 本来のpopMino相当処理
            this.mino = this.nextQueue.shift();
            this.mino.spawn();

            // 出現位置での致命判定
            if (!this.valid(0, 0)) {
                this.mino.y -= 1;
                if (!this.valid(0, 0)) {
                    this.gameOver();
                    return;
                }
            }

            // 次に補充するピースのインデックスを計算
            nextPieceIndex++;
            const absoluteNextIndex = nextPieceIndex + 4;

            if (absoluteNextIndex < levelData.nextPieces.length) {
                const nextMino = new Mino(levelData.nextPieces[absoluteNextIndex]);
                this.nextQueue.push(nextMino);
            } else {
                // NEXTが枯渇したら透明なダミーを補充
                this.nextQueue.push(self._createDummyMino());
            }

            // HOLD可否の更新
            this.canHold = levelData.allowHold ? true : false;
            this.isGrounded = false;
            this.lowestY = this.mino.y;
            this.moveCount = 0;
            this.lastActionWasRotation = false;
            this.lastRotUsedPoint5 = false;

            if (this.lockTimer) {
                clearTimeout(this.lockTimer);
                this.lockTimer = null;
            }
            this.startGravity();
        }.bind(game);

        game.getNextType = function() {
            return 0;
        };

        // レベルごとのHOLD機能とUI(HTMLレイヤー)の制御
        if (!levelData.allowHold) {
            game.canHold = false;
            game.holdCurrentMino = function() {}; // HOLD処理を無効化
            _setHoldOverlayVisible(true);         // HTML要素でキャンバスに合わせて斜線を表示
        } else {
            game.canHold = true;
            _setHoldOverlayVisible(false);        // 斜線を非表示
        }
    }

    // ─── テト用フィールド初期配置 ─────────────────
    _applyTetField(fieldRows, game) {
        game.field = new Field();
        if (!fieldRows || fieldRows.length === 0) return;

        const startRow = ROWS_COUNT - fieldRows.length;
        fieldRows.forEach((row, rowIdx) => {
            row.forEach((typeId, colIdx) => {
                if (typeId > 0) {
                    const block = new Block(colIdx, startRow + rowIdx, typeId - 1);
                    game.field.blocks.push(block);
                }
            });
        });
    }

    // ─── ぷよ用初期化 ────────────────────────────
    _startPuyo(levelData, puyoGame) {
        this._remainingPairs = [...levelData.nextPuyoPairs];

        // フィールド初期配置
        this._applyPuyoField(levelData.initialPuyoField, puyoGame);

        // ★ フェイルセーフ：ID 7 の描画時にエラーにならないよう、ゲームエンジンの色配列に透明色を定義しておく
        if (typeof PConfig !== 'undefined' && PConfig.colors && !PConfig.colors[7]) {
            PConfig.colors[7] = 'rgba(0,0,0,0)';
        }
        if (puyoGame.colors && !puyoGame.colors[7]) {
            puyoGame.colors[7] = 'rgba(0,0,0,0)';
        }

        // NEXTキューを固定ペアで上書き
        puyoGame.nextQueue = [];
        for (const pair of this._remainingPairs) {
            puyoGame.nextQueue.push([...pair]);
        }
        
        // ★ ダミーペアで最低20個を維持
        // 0(空マス), 1~5(通常ぷよ), 6(おじゃま) は使用済みのため、
        // NEXT表示が綺麗に空白になる「透明なダミーぷよ」として 新規ID 7 を生成して使用する
        while (puyoGame.nextQueue.length < 20) {
            puyoGame.nextQueue.push([7, 7]); 
        }

        const self = this;
        // モード終了時に復元できるよう保存
        this._originalDequeueNext = puyoGame._dequeueNext;
        this._originalMakePair    = puyoGame._makePair;
        
        let pairIndex = 0;

        puyoGame._dequeueNext = function() {
            // 次のぷよが出現する直前にクリア判定
            if (self._checkClear()) {
                return [7, 7]; // ダミー(ID 7)を返して空回りさせる
            }

            const pair = this.nextQueue.shift();

            // センチネル検出（枯渇） → 色IDが7の場合は失敗
            if (pair[0] === 7 || pair[1] === 7) {
                self._onFailed();
                return [7, 7];
            }

            pairIndex++;
            const absIdx = pairIndex + (this.nextQueue.length);
            if (absIdx < levelData.nextPuyoPairs.length) {
                this.nextQueue.push([...levelData.nextPuyoPairs[absIdx]]);
            } else {
                this.nextQueue.push([7, 7]); // ID 7 の透明なダミーを補充
            }

            return pair;
        }.bind(puyoGame);

        puyoGame._makePair = function() {
            return [7, 7]; // 呼ばれても影響がないようダミーぷよを生成
        };
    }

    // ─── ぷよ用フィールド初期配置 ─────────────────
    _applyPuyoField(fieldRows, puyoGame) {
        if (!fieldRows || fieldRows.length === 0) return;
        const totalRows = PConfig.rows + PConfig.hiddenRows; // 17
        for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                puyoGame.field[r][c] = 0;
            }
        }
        const displayStart = PConfig.hiddenRows; // 5
        fieldRows.forEach((row, rowIdx) => {
            const fr = displayStart + rowIdx;
            row.forEach((colorId, colIdx) => {
                if (colorId > 0 && fr < totalRows && colIdx < PConfig.cols) {
                    puyoGame.field[fr][colIdx] = colorId;
                }
            });
        });
    }

    // ─── クリア条件チェック（イベント駆動） ─────────
    _checkClear() {
        if (!this.currentLevel || !this.gameInstance) return false;
        const cond = this.currentLevel.clearCondition;
        const game = this.gameInstance;
        let cleared = false;

        if (this.currentLevel.rule === 'tet') {
            switch (cond.type) {
                case 'clearLines':
                    if (game.lines >= cond.value) cleared = true;
                    break;
                case 'allClear':
                    if (game.field && game.field.blocks.length === 0 && game.lines > 0) cleared = true;
                    break;
                case 'score':
                    if (game.score >= cond.value) cleared = true;
                    break;
            }
        } else {
            // ぷよ
            switch (cond.type) {
                case 'chain':
                    if (game.chainMax >= cond.value) cleared = true;
                    break;
                case 'allClear':
                    if (game.isAllClear) cleared = true;
                    break;
                case 'score':
                    if (game.score >= cond.value) cleared = true;
                    break;
            }
        }

        if (cleared) {
            this._onClear();
            return true;
        }
        return false;
    }

    // ─── クリア時処理 ─────────────────────────────
    _onClear() {
        if (this.isClear || this.isFailed) return;
        this.isClear = true;
        this._stopGame();

        setTimeout(() => {
            if (typeof showQuizResult === 'function') {
                showQuizResult(true, this.currentLevel);
            }
        }, 400);
    }

    // ─── 失敗時処理 ──────────────────────────────
    _onFailed() {
        if (this.isClear || this.isFailed) return;
        this.isFailed = true;
        this._stopGame();

        setTimeout(() => {
            if (typeof showQuizResult === 'function') {
                showQuizResult(false, this.currentLevel);
            }
        }, 400);
    }

    // ─── ゲームインスタンスの停止 ─────────────────
    _stopGame() {
        const game = this.gameInstance;
        if (!game) return;

        if (game instanceof PuyoGame) {
            // ぷよ停止
            if (game._loopId) cancelAnimationFrame(game._loopId);
            game._loopId = null;
            game.state = 'gameover'; // ループを止める
            game._stopTimer();
        } else {
            // テト停止
            if (game.timer) { clearInterval(game.timer); game.timer = null; }
            if (game.lockTimer) { clearTimeout(game.lockTimer); game.lockTimer = null; }
            game.isPaused = true;
            if (game.isTimerRunning) {
                game.elapsedTime += performance.now() - game.startTime;
                game.isTimerRunning = false;
                if (game.timerReqId) cancelAnimationFrame(game.timerReqId);
            }
            if (game._keyDownHandler) document.removeEventListener('keydown', game._keyDownHandler);
            if (game._keyUpHandler)   document.removeEventListener('keyup',   game._keyUpHandler);
            if (game._keyLoop)        { clearInterval(game._keyLoop); game._keyLoop = null; }
        }
    }

    // ─── 後片付け ─────────────────────────────────
    destroy() {
        // 破壊した関数と状態を元のゲームエンジンに復元する（他のモードへの影響を遮断）
        if (this.gameInstance) {
            if (this.currentLevel && this.currentLevel.rule === 'tet') {
                if (this._originalPopMino) this.gameInstance.popMino = this._originalPopMino;
                if (this._originalGetNextType) this.gameInstance.getNextType = this._originalGetNextType;
                if (this._originalHoldCurrentMino) this.gameInstance.holdCurrentMino = this._originalHoldCurrentMino;
                this.gameInstance.canHold = true;
                
                // HTML要素による斜線表示を非表示にする
                _setHoldOverlayVisible(false);
                
                // エラー回避: フィールドが存在する場合のみクリアと再描画を行う
                if (this.gameInstance.field) {
                    this.gameInstance.field.blocks = [];
                    if (typeof this.gameInstance.drawAll === 'function') this.gameInstance.drawAll();
                }
                this.gameInstance.nextQueue = [];
                this.gameInstance.bag = [];
                if (typeof this.gameInstance.drawNext === 'function') this.gameInstance.drawNext();
                if (typeof this.gameInstance.drawHold === 'function') this.gameInstance.drawHold();
                
            } else if (this.currentLevel && this.currentLevel.rule === 'puyo') {
                if (this._originalDequeueNext) this.gameInstance._dequeueNext = this._originalDequeueNext;
                if (this._originalMakePair) this.gameInstance._makePair = this._originalMakePair;
                
                // エラー回避: フィールドが存在する場合のみクリアと再描画を行う
                if (this.gameInstance.field) {
                    for (let r = 0; r < this.gameInstance.field.length; r++) {
                        for (let c = 0; c < this.gameInstance.field[r].length; c++) {
                            this.gameInstance.field[r][c] = 0;
                        }
                    }
                    if (typeof this.gameInstance._render === 'function') this.gameInstance._render();
                }
                this.gameInstance.nextQueue = [];
            }
        }

        this.currentLevel  = null;
        this.gameInstance  = null;
        this.isClear       = false;
        this.isFailed      = false;
        
        // 参照も破棄
        this._originalPopMino = null;
        this._originalGetNextType = null;
        this._originalHoldCurrentMino = null;
        this._originalDequeueNext = null;
        this._originalMakePair = null;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// グローバルインスタンス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
window._quizManager = null;

// ─── QUIZリザルト表示 ─────────────────────────────
function showQuizResult(isSuccess, levelData) {
    const text      = isSuccess ? 'CLEAR!' : 'FAILED...';
    const className = isSuccess ? 'finish-clear' : 'finish-gameover';

    showFinishOverlay('finish-overlay', 'finish-text', text, className, 1200, () => {
        if (typeof switchPage === 'function') {
            _setQuizResultPage(isSuccess, levelData);
            switchPage('quiz-result');
        }
    });
}

function _setQuizResultPage(isSuccess, levelData) {
    const titleEl = document.getElementById('quiz-result-title');
    if (titleEl) {
        if (isSuccess) {
            titleEl.textContent = 'CLEAR!';
            titleEl.style.color = 'var(--success)';
            titleEl.style.webkitTextFillColor = 'var(--success)';
            titleEl.style.background = 'none';
        } else {
            titleEl.textContent = 'FAILED';
            titleEl.style.background = 'linear-gradient(90deg, var(--accent), var(--accent2))';
            titleEl.style.webkitBackgroundClip = 'text';
            titleEl.style.webkitTextFillColor = 'transparent';
        }
    }

    const levelEl = document.getElementById('quiz-result-level');
    if (levelEl && levelData) levelEl.textContent = levelData.title;

    const condEl = document.getElementById('quiz-result-condition');
    if (condEl && levelData) condEl.textContent = levelData.clearCondition.description;

    const statusEl = document.getElementById('quiz-result-status');
    if (statusEl) statusEl.textContent = isSuccess ? 'SUCCESS' : 'FAILED';

    const nextBtn = document.getElementById('quiz-result-next-btn');
    if (nextBtn && levelData) {
        const rule   = levelData.rule;
        const levels = QUIZ_LEVELS[rule] || [];
        const currentIdx = levels.findIndex(l => l.id === levelData.id);
        const hasNext = isSuccess && currentIdx >= 0 && currentIdx < levels.length - 1;

        nextBtn.style.display = hasNext ? 'flex' : 'none';

        if (hasNext) {
            nextBtn.onclick = () => {
                const nextLevel = levels[currentIdx + 1];
                if (typeof startQuizLevel === 'function') {
                    startQuizLevel(nextLevel);
                }
            };
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUIZモード router 連携関数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let currentQuizRule = 'tet'; 
let currentQuizLevel = null;

function setQuizRule(rule) {
    currentQuizRule = rule;
    renderQuizCheck();
}

// ★ 非同期関数に変更し、データをfetchしてから描画するようにしました
async function renderQuizCheck() {
    await loadQuizLevels();

    ['tet', 'puyo'].forEach(r => {
        const btn = document.getElementById(`quiz-rule-${r}`);
        if (btn) btn.classList.toggle('active', r === currentQuizRule);
    });

    const listEl = document.getElementById('quiz-level-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const levels = QUIZ_LEVELS[currentQuizRule] || [];
    levels.forEach((level, idx) => {
        const btn = document.createElement('button');
        btn.className = 'quiz-level-btn';
        btn.dataset.levelId = level.id;

        btn.innerHTML = `
            <span class="quiz-level-num">${idx + 1}</span>
            <div class="quiz-level-info">
                <span class="quiz-level-title">${level.title}</span>
                <span class="quiz-level-desc">${level.description}</span>
            </div>
            <span class="quiz-level-cond">${level.clearCondition.description}</span>
        `;
        btn.onclick = () => {
            currentQuizLevel = level;
            startQuizLevel(level);
        };
        listEl.appendChild(btn);
    });
}

// ─── QUIZレベル開始 ──────────────────────────
async function startQuizLevel(levelData) {
    if (!levelData) return;

    _showQuizFieldHeader(levelData);
    currentQuizLevel = levelData;

    // 既存ゲームを全停止
    if (typeof stopAllGames === 'function') stopAllGames();
    if (window._quizManager) {
        window._quizManager.destroy();
    }
    
    // エラー回避：フィールド(盤面)がすでに存在している場合のみ、残像クリアと再描画を行う
    if (window._game) {
        if (window._game.field) {
            window._game.field.blocks = [];
            if (typeof window._game.drawAll === 'function') window._game.drawAll();
        }
        window._game.nextQueue = [];
        window._game.bag = [];
        if (typeof window._game.drawNext === 'function') window._game.drawNext();
        if (typeof window._game.drawHold === 'function') window._game.drawHold();
    }
    if (window._puyoGame) {
        if (window._puyoGame.field) {
            for (let r = 0; r < window._puyoGame.field.length; r++) {
                if (window._puyoGame.field[r]) window._puyoGame.field[r].fill(0);
            }
            if (typeof window._puyoGame._render === 'function') window._puyoGame._render();
        }
        window._puyoGame.nextQueue = [];
    }

    // マネージャーの再生成
    window._quizManager = new QuizManager();

    // ─── フィールドオーバーレイのヘッダーテキスト更新 ───
    const quizHeaderEl = document.getElementById('quiz-field-header');
    if (quizHeaderEl) {
        const ruleLabel = levelData.rule === 'tet' ? 'TET' : 'PUYO';
        quizHeaderEl.textContent = `QUIZ — ${ruleLabel} — ${levelData.title}`;
    }
    const quizCondEl = document.getElementById('quiz-field-condition');
    if (quizCondEl) {
        quizCondEl.textContent = `GOAL: ${levelData.clearCondition.description}`;
    }

    // ─── ルールに応じてゲームインスタンスを準備 ───
    if (levelData.rule === 'puyo') {
        _switchToPuyoLayout(true);

        if (!window._puyoGame) window._puyoGame = new PuyoGame();
        const pg = window._puyoGame;
        pg.currentMode  = 'quiz';
        pg.isVersusMode = false;
        pg.isCpuControlled = false;

        switchPage('game');

        // initGame してからカウントダウン経由でフィールド初期化
        await new Promise(resolve => pg.initGame(resolve));

        // READY表示時に盤面とNEXTをロード
        window._quizManager.start(levelData, pg);
        // ロードした盤面を画面に即座に反映
        if (typeof pg._render === 'function') pg._render();

        // カウントダウン開始
        runCountdown('countdown-overlay', 'countdown-text', () => {
            pg._startGameplay();
        }, null);

    } else {
        // テトリス
        _switchToPuyoLayout(false);

        if (!window._game || typeof window._game.initMainCanvas !== 'function') {
            window._game = new Game();
        }
        const tg = window._game;
        tg.currentMode  = 'quiz';
        tg.isVersusMode = false;
        tg.canvasPrefix = null;
        tg.statsPrefix  = null;
        tg._labelsInitialized = false;
        tg.isCpuControlled    = false;
        tg.initMainCanvas();
        tg.initNextCanvas();
        tg.initHoldCanvas();

        const evalArea = document.getElementById('eval-area');
        if (evalArea) evalArea.style.display = 'none';

        switchPage('game');

        tg._initGameState();
        tg.setKeyEvent();

        // READY表示時に盤面とNEXTをロード
        window._quizManager.start(levelData, tg);
        // ロードした盤面とNEXTを画面に即座に反映
        if (typeof tg.drawAll === 'function') tg.drawAll();
        if (typeof tg.drawNext === 'function') tg.drawNext();
        if (typeof tg.drawHold === 'function') tg.drawHold();

        // カウントダウン経由で開始
        runCountdown('countdown-overlay', 'countdown-text', () => {
            tg._startGameplay();
        }, null);
    }
}

// ─── QUIZモードのstopAllGamesフック ──────────
function _stopQuizIfActive() {
    if (window._quizManager) {
        window._quizManager.destroy();
        window._quizManager = null;
    }
}

// ─── QUIZフィールドヘッダーの表示/非表示制御 ─────
function _showQuizFieldHeader(levelData) {
    const overlay = document.getElementById('quiz-field-overlay');
    if (!overlay) return;
    if (levelData) {
        overlay.style.display = 'block';
        const ruleLabel = levelData.rule === 'tet' ? 'TET' : 'PUYO';
        const headerEl = document.getElementById('quiz-field-header');
        const condEl   = document.getElementById('quiz-field-condition');
        if (headerEl) headerEl.textContent = `QUIZ — ${ruleLabel} — ${levelData.title}`;
        if (condEl)   condEl.textContent   = `GOAL: ${levelData.clearCondition.description}`;
    } else {
        overlay.style.display = 'none';
    }
}

// ─── _stopQuizIfActive 内でヘッダーも非表示に ────
(function() {
    const _original = window._stopQuizIfActive;
    window._stopQuizIfActive = function() {
        if (typeof _original === 'function') _original();
        _showQuizFieldHeader(null);
    };
})();
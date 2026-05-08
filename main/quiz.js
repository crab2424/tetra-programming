// ─────────────────────────────────────────────
// quiz.js
// QUIZモード定義・クリア条件チェック・レベル管理
// ─────────────────────────────────────────────

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUIZ レベルデータ定義
// 拡張方法: QUIZ_LEVELS_TET / QUIZ_LEVELS_PUYO に要素を追加するだけでOK
//
// 各レベルのフォーマット:
// {
//   id: 'tet-1',            // 一意なID
//   title: 'QUIZ 1',        // 表示タイトル
//   description: '説明文',  // 説明（日本語）
//   rule: 'tet',            // 'tet' または 'puyo'
//
//   // ─── テトリス用フィールド ───
//   // initialField: 行ごとのブロック配列（上から順）
//   //   各行は長さ10の配列、0=空、1〜7=ブロック種類（色ID）
//   //   行数は任意（最大20行分、下詰めで配置される）
//   initialField: [ ... ],
//
//   // ─── ぷよ用フィールド ───
//   // initialPuyoField: 行ごとの配列（上から順）
//   //   各行は長さ6の配列、0=空、1〜5=色、6=おじゃまぷよ
//   initialPuyoField: [ ... ],
//
//   // ─── NEXT（有限・固定） ───
//   // nextPieces: テト用ミノタイプの配列 (0=I,1=O,2=T,3=J,4=L,5=S,6=Z)
//   nextPieces: [ ... ],
//   // nextPuyoPairs: ぷよ用ペアの配列 [[pivot色, child色], ...]
//   nextPuyoPairs: [ ... ],
//
//   // ─── クリア条件 ───
//   // clearCondition: {
//   //   type: 'clearLines'       // n行消去
//   //         | 'allClear'       // フィールド全消し
//   //         | 'score'          // スコアがn以上
//   //         | 'chain'          // n連鎖以上（ぷよ）
//   //   value: number            // type に対応する値
//   //   description: '説明'      // クリア条件の説明文
//   // }
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── テトリスQUIZレベル ───────────────────────
const QUIZ_LEVELS_TET = [
    {
        id: 'tet-1',
        title: 'QUIZ 1',
        description: 'I型1つでラインを消せ！',
        rule: 'tet',
        // 下2行が穴あき（列1だけ空）
        initialField: [
            [5,5,5,5,5,5,5,5,5,0],
            [5,5,5,5,5,5,5,5,5,0],
        ],
        nextPieces: [0], // I型1個
        clearCondition: {
            type: 'clearLines',
            value: 1,
            description: '1ライン消去'
        }
    },
    {
        id: 'tet-2',
        title: 'QUIZ 2',
        description: 'フィールドを全て消せ！',
        rule: 'tet',
        // 下4行が綺麗に詰まっているが、1列分だけ空き（Iミノ2本でパーフェクトクリア）
        initialField: [
            [6,6,6,6,0,6,6,6,6,6],
            [6,6,6,6,0,6,6,6,6,6],
            [6,6,6,6,0,6,6,6,6,6],
            [6,6,6,6,0,6,6,6,6,6],
        ],
        nextPieces: [0, 0], // I型2個
        clearCondition: {
            type: 'allClear',
            value: 0,
            description: 'パーフェクトクリア'
        }
    },
    {
        id: 'tet-3',
        title: 'QUIZ 3',
        description: 'T-Spinを決めろ！',
        rule: 'tet',
        // T-Spinのセットアップ（井戸型）
        initialField: [
            [3,3,0,3,3,3,3,3,3,3],
            [3,3,0,0,3,3,3,3,3,3],
            [3,3,3,0,3,3,3,3,3,3],
            [3,3,0,0,3,3,3,3,3,3],
            [3,3,0,3,3,3,3,3,3,3],
        ],
        nextPieces: [2], // T型1個
        clearCondition: {
            type: 'clearLines',
            value: 2,
            description: '2ライン消去（T-Spin推奨）'
        }
    },
];

// ─── ぷよQUIZレベル ───────────────────────────
const QUIZ_LEVELS_PUYO = [
    {
        id: 'puyo-1',
        title: 'QUIZ 1',
        description: '4つつなげて消せ！',
        rule: 'puyo',
        // 下から3行：3色が混在、あと1個置けば4つ揃う
        initialPuyoField: [
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [1, 0, 0, 0, 0, 0],
            [1, 0, 0, 0, 0, 0],
            [1, 0, 0, 0, 0, 0],
        ],
        // pivot色, child色
        nextPuyoPairs: [[1, 2]],
        clearCondition: {
            type: 'chain',
            value: 1,
            description: '1連鎖以上'
        }
    },
    {
        id: 'puyo-2',
        title: 'QUIZ 2',
        description: '2連鎖を起こせ！',
        rule: 'puyo',
        initialPuyoField: [
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [2, 0, 0, 0, 0, 0],
            [2, 0, 0, 0, 0, 0],
            [2, 1, 0, 0, 0, 0],
            [1, 1, 0, 0, 0, 0],
        ],
        nextPuyoPairs: [[2, 1]],
        clearCondition: {
            type: 'chain',
            value: 2,
            description: '2連鎖以上'
        }
    },
    {
        id: 'puyo-3',
        title: 'QUIZ 3',
        description: '全消しを達成せよ！',
        rule: 'puyo',
        initialPuyoField: [
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [3, 0, 0, 0, 0, 0],
            [3, 3, 0, 0, 0, 0],
            [3, 3, 3, 0, 0, 0],
        ],
        nextPuyoPairs: [[3, 3]],
        clearCondition: {
            type: 'allClear',
            value: 0,
            description: '全消し'
        }
    },
];

// 全レベルをまとめたマップ（rule → levels）
const QUIZ_LEVELS = {
    tet: QUIZ_LEVELS_TET,
    puyo: QUIZ_LEVELS_PUYO,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QuizManager : クイズの進行・クリア判定を管理するクラス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class QuizManager {
    constructor() {
        this.currentLevel = null;  // 現在のレベルデータ
        this.gameInstance = null;  // Game または PuyoGame のインスタンス
        this.isClear      = false;
        this.isFailed     = false;
        this._checkInterval = null;
        this._originalPopMino     = null; // テト用: オリジナルのpopMinoを保存
        this._originalDequeueNext = null; // ぷよ用: オリジナルの_dequeueNextを保存
        this._remainingPieces = []; // テト用: 残りNEXT
        this._remainingPairs  = []; // ぷよ用: 残りNEXT
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
        // 残りNEXTを複製（使い切り検出のため）
        this._remainingPieces = [...levelData.nextPieces];

        // フィールドにクイズ初期配置を反映
        this._applyTetField(levelData.initialField, game);

        // NEXTキューを固定ピースで上書き
        game.bag = [];
        game.nextQueue = [];
        for (let i = 0; i < Math.min(5, this._remainingPieces.length); i++) {
            game.nextQueue.push(new Mino(this._remainingPieces[i]));
        }
        // 5個以降は "使い切り" を示すセンチネル (-1) で埋める
        while (game.nextQueue.length < 5) {
            // センチネル: type=-1 のダミーMinoは後で判定に使う
            const dummy = new Mino(0);
            dummy._quizDummy = true;
            game.nextQueue.push(dummy);
        }

        // popMino をラップして残りNEXT管理とクリア判定を行う
        const self = this;
        const originalPopMino = game.popMino.bind(game);
        this._originalPopMino = originalPopMino;
        let nextPieceIndex = 0; // nextPiecesの次に出す位置

        game.popMino = function() {
            // 現在のミノのインデックスを管理
            // nextQueue は常に5個維持する必要があるため、
            // 使い切り後は新規補充せず、_quizDummy フラグで判別
            const currentMino = this.nextQueue[0];
            if (currentMino && currentMino._quizDummy) {
                // 使い切り → 失敗
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
            // すでに最初に5個セットしているので、nextPieceIndex は shift した分だけ進む
            nextPieceIndex++;
            const absoluteNextIndex = nextPieceIndex + 4; // 先読み4個分のオフセット

            if (absoluteNextIndex < levelData.nextPieces.length) {
                // まだ残りのピースがある
                const nextMino = new Mino(levelData.nextPieces[absoluteNextIndex]);
                this.nextQueue.push(nextMino);
            } else {
                // 使い切り → ダミー補充
                const dummy = new Mino(0);
                dummy._quizDummy = true;
                this.nextQueue.push(dummy);
            }

            this.canHold = true;
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

        // getNextType もオーバーライド（バッグ補充を無効化）
        game.getNextType = function() {
            return 0; // 呼ばれても無害なダミーを返す
        };

        // ─── クリア判定のポーリング ───
        this._startCheckLoop();
        // ホールドを無効化
        game.canHold = false;
        const origHold = game.holdCurrentMino.bind(game);
        this._originalHold = origHold;
        game.holdCurrentMino = function() {
            // QUIZモードではホールド不可
        };
    }

    // ─── テト用フィールド初期配置 ─────────────────
    _applyTetField(fieldRows, game) {
        game.field = new Field();
        if (!fieldRows || fieldRows.length === 0) return;

        // fieldRows は上から順、下詰めでフィールドへ配置
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

        // NEXTキューを固定ペアで上書き
        puyoGame.nextQueue = [];
        for (const pair of this._remainingPairs) {
            puyoGame.nextQueue.push([...pair]);
        }
        // ダミーペアで最低20個を維持（ゲームエンジンが20個要求するため）
        while (puyoGame.nextQueue.length < 20) {
            puyoGame.nextQueue.push([-1, -1]); // センチネル
        }

        // _dequeueNext をラップ
        const self = this;
        const originalDequeue = puyoGame._dequeueNext.bind(puyoGame);
        this._originalDequeueNext = originalDequeue;
        let pairIndex = 0;

        puyoGame._dequeueNext = function() {
            const pair = this.nextQueue.shift();

            // センチネル検出 → 失敗
            if (pair[0] === -1 || pair[1] === -1) {
                self._onFailed();
                // ゲームを止めるため、ダミーペアを返してゲームオーバー処理に任せる
                // 実際には _onFailed内でゲームを停止する
                return [1, 1];
            }

            pairIndex++;
            // 次に補充するペアのインデックス（先読み分を考慮）
            const absIdx = pairIndex + (this.nextQueue.length);
            if (absIdx < levelData.nextPuyoPairs.length) {
                this.nextQueue.push([...levelData.nextPuyoPairs[absIdx]]);
            } else {
                this.nextQueue.push([-1, -1]); // センチネル補充
            }

            return pair;
        }.bind(puyoGame);

        // _makePair もオーバーライド（バッグ補充を無効化）
        puyoGame._makePair = function() {
            return [-1, -1]; // 呼ばれても無害なセンチネルを返す
        };

        // ─── クリア判定のポーリング ───
        this._startCheckLoop();
    }

    // ─── ぷよ用フィールド初期配置 ─────────────────
    _applyPuyoField(fieldRows, puyoGame) {
        if (!fieldRows || fieldRows.length === 0) return;
        // fieldRows は表示行順（上から12行）
        // puyoGame.field は (rows + hiddenRows) 行
        // hiddenRows=5, rows=12 → 合計17行
        const totalRows = PConfig.rows + PConfig.hiddenRows; // 17
        // 初期化
        for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                puyoGame.field[r][c] = 0;
            }
        }
        // fieldRows は表示領域12行分（下詰め）
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

    // ─── クリア判定ループ ─────────────────────────
    _startCheckLoop() {
        if (this._checkInterval) clearInterval(this._checkInterval);
        this._checkInterval = setInterval(() => {
            if (this.isClear || this.isFailed) {
                clearInterval(this._checkInterval);
                return;
            }
            this._checkClear();
        }, 100);
    }

    // ─── クリア条件チェック ───────────────────────
    _checkClear() {
        if (!this.currentLevel || !this.gameInstance) return;
        const cond = this.currentLevel.clearCondition;
        const game = this.gameInstance;
        let cleared = false;

        if (this.currentLevel.rule === 'tet') {
            switch (cond.type) {
                case 'clearLines':
                    if (game.lines >= cond.value) cleared = true;
                    break;
                case 'allClear':
                    // フィールドのブロックが0個かつ少なくとも1手指した後
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
                    // 全消し判定
                    if (game.isAllClear) cleared = true;
                    break;
                case 'score':
                    if (game.score >= cond.value) cleared = true;
                    break;
            }
        }

        if (cleared) {
            this._onClear();
        }
    }

    // ─── クリア時処理 ─────────────────────────────
    _onClear() {
        if (this.isClear || this.isFailed) return;
        this.isClear = true;
        clearInterval(this._checkInterval);
        this._stopGame();

        // 少し待ってからクリア演出
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
        clearInterval(this._checkInterval);
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
        clearInterval(this._checkInterval);
        this._checkInterval = null;
        this.currentLevel  = null;
        this.gameInstance  = null;
        this.isClear       = false;
        this.isFailed      = false;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// グローバルインスタンス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
window._quizManager = null;

// ─── QUIZリザルト表示 ─────────────────────────────
// router.js から呼ばれる（game-page 上に演出を出す）
function showQuizResult(isSuccess, levelData) {
    const text      = isSuccess ? 'CLEAR!' : 'FAILED...';
    const className = isSuccess ? 'finish-clear' : 'finish-gameover';

    showFinishOverlay('finish-overlay', 'finish-text', text, className, 1200, () => {
        // クイズリザルトページへ
        if (typeof switchPage === 'function') {
            // リザルトページのカスタム情報をセット
            _setQuizResultPage(isSuccess, levelData);
            switchPage('quiz-result');
        }
    });
}

// ─── クイズリザルトページのDOM更新 ───────────────
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

    // 「NEXT LEVEL」ボタンの表示制御
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
// （quiz.jsに集約してrouter.jsとの結合を最小化）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── 現在選択中のクイズルール ─────────────────
let currentQuizRule = 'tet'; // 'tet' または 'puyo'
// ─── 現在選択中のクイズレベルデータ ────────────
let currentQuizLevel = null;

// ─── クイズルール変更 ─────────────────────────
function setQuizRule(rule) {
    currentQuizRule = rule;
    renderQuizCheck();
}

// ─── クイズ確認画面のレンダリング ───────────────
function renderQuizCheck() {
    // ルールボタンのハイライト更新
    ['tet', 'puyo'].forEach(r => {
        const btn = document.getElementById(`quiz-rule-${r}`);
        if (btn) btn.classList.toggle('active', r === currentQuizRule);
    });

    // レベルリストの更新
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

    // ★ 修正箇所：無限ループ（スタックオーバーフロー）を回避するため、
    // 関数を後からパッチで上書きするのをやめ、直接ヘッダー表示関数を呼び出します。
    _showQuizFieldHeader(levelData);

    currentQuizLevel = levelData;

    // 既存ゲームを全停止
    if (typeof stopAllGames === 'function') stopAllGames();
    if (window._quizManager) {
        window._quizManager.destroy();
    }
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

        // カウントダウン開始（STARTの瞬間にQuizManagerを適用）
        runCountdown('countdown-overlay', 'countdown-text', () => {
            // フィールドにクイズ配置を上書き
            window._quizManager.start(levelData, pg);
            // ゲームプレイ開始（ぷよ）
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

        // evalエリア非表示
        const evalArea = document.getElementById('eval-area');
        if (evalArea) evalArea.style.display = 'none';

        switchPage('game');

        // カウントダウン経由で開始
        tg._initGameState();
        tg.setKeyEvent();

        runCountdown('countdown-overlay', 'countdown-text', () => {
            // フィールドとNEXTをクイズ用に上書き
            window._quizManager.start(levelData, tg);
            // ゲームプレイ開始（テト）
            tg._startGameplay();
        }, null);
    }
}

// ─── QUIZモードのstopAllGamesフック ──────────
// router.js の stopAllGames() が呼ばれた際に QuizManager も破棄するため
// stopAllGames 末尾で呼ばれるよう router.js 側でフックする
function _stopQuizIfActive() {
    if (window._quizManager) {
        window._quizManager.destroy();
        window._quizManager = null;
    }
}

// ─── QUIZフィールドヘッダーの表示/非表示制御 ─────
// startQuizLevel 内で呼ばれる（ゲームページ切替後に表示する）
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
// 元の _stopQuizIfActive を拡張（同ファイル内で再定義して上書き）
(function() {
    const _original = window._stopQuizIfActive;
    window._stopQuizIfActive = function() {
        if (typeof _original === 'function') _original();
        _showQuizFieldHeader(null);
    };
})();
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
//   // ─── テト用フィールド ───
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
            fetch('quizlevels/tdata.json?' + Date.now()), // キャッシュ対策
            fetch('quizlevels/pdata.json?' + Date.now())  // キャッシュ対策
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
        this._originalSecureMino      = null; // count / ren / tspin / lines 判定用フック
        this._originalRestart         = null; // ショートカット・ポーズ画面からのリスタート用フック
        
        this._remainingPieces = []; 
        this._remainingPairs  = []; 

        // ─── count 条件用：クリア条件を満たした回数カウンター ───
        // tet / puyo 両方の "count" タイプで使用する
        this.clearTimes = 0;

        // ─── tet 専用：secureMino フックから受け取る直前プレイ情報 ───
        // _lastSecureResult は secureMino 実行直後に更新され、_checkClear で参照する
        this._lastSecureResult = {
            tSpinType:    null,  // 'tspin' | 'mini' | null
            linesCleared: 0,     // 消去ライン数
            ren:          0,     // 固定時点の REN（連鎖）カウント（加算前）
        };

        // ★ 追加：secureMino フック中の popMino 呼び出しによる弾切れ判定を遅延させるフラグ
        this._isSecuring      = false;
        this._failedByDummy   = false;
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

    // ─── テト用初期化 ─────────────────────────
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
        this._originalSecureMino = game.secureMino;
        this._originalRestart = game.restart;
        this._originalStart = game.start;
        this._originalGameOver = game.gameOver;

        // ─── gameOver フック ──────────────────────────────────────
        // ミノが詰まるなどでゲームオーバーになった場合も QUIZ の失敗処理に統一する
        game.gameOver = function() {
            if (self.currentLevel && !self.isClear && !self.isFailed) {
                self._onFailed();
            } else {
                if (self._originalGameOver) self._originalGameOver.call(this);
            }
        }.bind(game);

        // ─── restart フック ──────────────────────────────────────
        // プレイ中のショートカットやポーズ画面からのリトライをQUIZモード専用のリトライに統一する
        game.restart = function() {
            if (self.currentLevel) {
                // ポーズ画面・ショートカットキー両経路から呼ばれた場合を考慮し、ポーズ画面を非表示にする
                const pauseOverlay = document.getElementById('pause-overlay');
                if (pauseOverlay) pauseOverlay.classList.remove('active');
                
                startQuizLevel(self.currentLevel);
            } else {
                if (self._originalRestart) self._originalRestart.call(this);
            }
        }.bind(game);

        // ─── start フック ──────────────────────────────────────
        // ショートカットキーが game.restart ではなく game.start を呼ぶ経路でも
        // QUIZモード専用のリトライ処理（盤面・NEXT復元）に統一する
        game.start = function() {
            if (self.currentLevel) {
                const pauseOverlay = document.getElementById('pause-overlay');
                if (pauseOverlay) pauseOverlay.classList.remove('active');

                startQuizLevel(self.currentLevel);
            } else {
                if (self._originalStart) self._originalStart.call(this);
            }
        }.bind(game);

        // ─── secureMino フック ──────────────────────────────────────
        // tet 専用条件（ren / tspin / lines / count）の判定に必要な情報を
        // secureMino 実行後にキャプチャして _lastSecureResult へ保存する。
        // 元の secureMino をラップする形で差し込むことで、
        // 既存の固定・ライン消去・スコア処理には一切影響を与えない。
        game.secureMino = function() {
            // ── ラップ前：今回の固定で使うT-spin判定結果とRENを先取りする ──
            // ※ checkTSpin() は secureMino の内部でも呼ばれるが、
            //    同じ状態で呼ぶので結果は同一（副作用なし）
            const preRen         = this.ren;          // 加算される前の連鎖数
            const preTSpinType   = this.checkTSpin(); // 現在の配置でのT-spin種別

            // ★追加：secureMino の処理中であることを記録（popMinoでの即時FAILEDを防ぐため）
            self._isSecuring = true;

            // ── 元の secureMino を実行（固定・消去・スコア等すべて処理される） ──
            self._originalSecureMino.call(this);

            // ★追加：処理中フラグを解除
            self._isSecuring = false;

            // ── ラップ後：消去ライン数は field.checkLine() が内部で変えた game.lines から逆算 ──
            // secureMino 実行前の lines は self._preLines に保存しておく
            const linesCleared = this.lines - (self._preLines || 0);
            self._preLines = this.lines;

            // 今回の固定情報を記録（_checkClear の各ハンドラから参照される）
            self._lastSecureResult = {
                tSpinType:    preTSpinType,
                linesCleared: linesCleared,
                ren:          preRen,
            };

            // ─── secureMino 直後にクリア条件チェック ───────────────────
            // popMino 側でも直前にチェックするが、
            // count / ren / tspin / lines などは「固定の瞬間」に確定するため
            // ここでも判定を走らせる（2重チェックは _onClear の isClear ガードで防ぐ）
            self._checkClearOnSecure();

            // ★追加：もし _originalSecureMino 内部で popMino が同期的に呼ばれ、弾切れ（ダミー）を引いて
            // FAILED判定が保留されていた場合は、ここで（クリアしていなければ）発動させる。
            if (self._failedByDummy && !self.isClear && !self.isFailed) {
                self._onFailed();
            }

        }.bind(game);

        // ── secureMino フック用：実行前に現在 lines を記録しておく ──
        this._preLines = game.lines;
        
        let nextPieceIndex = 0;

        game.popMino = function() {
            // secureMino フック内の _checkClearOnSecure() でクリア確定済みの場合は
            // ダミー検出・_checkClear を走らせずそのまま抜ける
            if (self.isClear || self.isFailed) return;
            // 次のミノが出現する直前（前の一手が確定した瞬間）にクリア判定を行う
            if (self._checkClear()) return;

            const currentMino = this.nextQueue[0];
            if (currentMino && currentMino._quizDummy) {
                // ★修正：secureMino の内部から同期的に呼ばれた場合は、
                // クリア判定(_checkClearOnSecure)が完了するまでFAILEDを保留する
                if (self._isSecuring) {
                    self._failedByDummy = true;
                } else {
                    self._onFailed();
                }
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
        this._originalDequeueNext   = puyoGame._dequeueNext;
        this._originalMakePair      = puyoGame._makePair;
        this._originalRestart       = puyoGame.restart;
        this._originalStart         = puyoGame.start;
        this._originalBeginGameOver = puyoGame._beginGameOver; // PuyoGame の本体は _beginGameOver

        // ─── _beginGameOver フック ──────────────────────────────────────
        // ぷよが積み上がってゲームオーバーになった場合も QUIZ の失敗処理に統一する
        // ※ PuyoGame のゲームオーバー処理の実体は _beginGameOver() であり gameOver() ではない
        puyoGame._beginGameOver = function() {
            if (self.currentLevel && !self.isClear && !self.isFailed) {
                self._onFailed();
            } else {
                if (self._originalBeginGameOver) self._originalBeginGameOver.call(this);
            }
        }.bind(puyoGame);

        let pairIndex = 0;

        // ─── restart フック ──────────────────────────────────────
        // プレイ中のショートカットやポーズ画面からのリトライをQUIZモード専用のリトライに統一する
        puyoGame.restart = function() {
            if (self.currentLevel) {
                // ポーズ画面・ショートカットキー両経路から呼ばれた場合を考慮し、ポーズ画面を非表示にする
                const pauseOverlay = document.getElementById('pause-overlay');
                if (pauseOverlay) pauseOverlay.classList.remove('active');

                startQuizLevel(self.currentLevel);
            } else {
                if (self._originalRestart) self._originalRestart.call(this);
            }
        }.bind(puyoGame);

        // ─── start フック ──────────────────────────────────────
        // ショートカットキーが puyoGame.restart ではなく puyoGame.start を呼ぶ経路でも
        // QUIZモード専用のリトライ処理（盤面・NEXT復元）に統一する
        puyoGame.start = function() {
            if (self.currentLevel) {
                const pauseOverlay = document.getElementById('pause-overlay');
                if (pauseOverlay) pauseOverlay.classList.remove('active');

                startQuizLevel(self.currentLevel);
            } else {
                if (self._originalStart) self._originalStart.call(this);
            }
        }.bind(puyoGame);

        puyoGame._dequeueNext = function() {
            // クリア／失敗確定済みなら何もしない
            if (self.isClear || self.isFailed) return [7, 7];

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
        
        // ★修正：上揃え（displayStart基準）から下詰め（総行数基準）に変更
        // これにより行数が少ないデータ（レベル6など）でも宙に浮かず一番下に配置されます。
        const startRow = totalRows - fieldRows.length;
        
        fieldRows.forEach((row, rowIdx) => {
            const fr = startRow + rowIdx;
            row.forEach((colorId, colIdx) => {
                // fr >= 0 を追加し、データ行数が多すぎた場合の配列外アクセスも防止
                if (colorId > 0 && fr >= 0 && fr < totalRows && colIdx < PConfig.cols) {
                    puyoGame.field[fr][colIdx] = colorId;
                }
            });
        });
    }

    // ─── クリア条件チェック（イベント駆動） ─────────
    // popMino 直前に呼ばれる汎用チェック（clearLines / allClear / score / chain）
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
                // ─── 以下の条件は secureMino フック側で判定するため、ここでは何もしない ───
                // count / ren / tspin / lines は _checkClearOnSecure() を参照
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
                // count はぷよの場合 _checkClearOnPuyoChain() で判定
            }
        }

        if (cleared) {
            this._onClear();
            return true;
        }
        return false;
    }

    // ─── secureMino 直後のクリア条件チェック（tet 専用条件） ────
    // 対象: count / ren / tspin / lines
    // このメソッドは secureMino ラッパー内から呼ばれる。
    _checkClearOnSecure() {
        if (!this.currentLevel || !this.gameInstance) return;
        if (this.isClear || this.isFailed) return;

        const cond   = this.currentLevel.clearCondition;
        const game   = this.gameInstance;
        const result = this._lastSecureResult;

        // ── tet 専用条件のみ処理 ──
        if (this.currentLevel.rule !== 'tet') return;

        switch (cond.type) {
            // ─── lines: 合計消去ライン数が value 以上でクリア ───────────────
            case 'lines':
                if (game.lines >= cond.value) {
                    this._onClear();
                }
                break;

            // ─── ren: 今回の固定時に ren（連鎖）が value 以上でクリア ─────────
            // ren は「直前の固定でのREN数（加算前）」を使う。
            // ※ linesCleared > 0 の場合のみ REN が進むので、ライン消去ありの場合のみ判定。
            case 'ren':
                if (result.linesCleared > 0 && (result.ren) >= cond.value) {
                    this._onClear();
                }
                break;

            // ─── tspin: T-Spin消去（mini含む）でクリア ──────────────────────
            // value 1 = T-Spin Single（1ライン）
            // value 2 = T-Spin Double（2ライン）
            // value 3 = T-Spin Triple（3ライン）
            // 通常の 1/2/3 ライン消去は不可。mini は tspin として扱う。
            case 'tspin': {
                const isTSpin = (result.tSpinType === 'tspin' || result.tSpinType === 'mini');
                if (isTSpin && result.linesCleared >= cond.value) {
                    this._onClear();
                }
                break;
            }

            // ─── tspinSingle/Double/Triple: miniを除く厳密なT-Spin種別でクリア ─
            // 単体クリア条件として使用。count と組み合わせる場合は
            // clearCondition.type = "count", countCondition = "tspinDouble" を使う。
            case 'tspinSingle': {
                if (result.tSpinType === 'tspin' && result.linesCleared === 1) {
                    this._onClear();
                }
                break;
            }
            case 'tspinDouble': {
                if (result.tSpinType === 'tspin' && result.linesCleared === 2) {
                    this._onClear();
                }
                break;
            }
            case 'tspinTriple': {
                if (result.tSpinType === 'tspin' && result.linesCleared === 3) {
                    this._onClear();
                }
                break;
            }

            // ─── count: 条件を cond.countCondition で指定し、達成するたびに clearTimes++ ─
            // clearTimes が cond.value に達したらクリア。
            // count の場合、cond.countCondition に判定ロジックを記述する:
            //   { "type": "count", "value": 3, "countCondition": "clearLines", "countValue": 1 }
            //   → 1ライン以上消去を3回行うとクリア
            //   { "type": "count", "value": 2, "countCondition": "tspin", "countValue": 1 }
            //   → T-Spin 1ライン以上を2回行うとクリア
            case 'count': {
                let conditionMet = false;
                const cc  = cond.countCondition;  // 内部条件の種類
                const ccv = cond.countValue ?? 1; // 内部条件の閾値（デフォルト1）

                switch (cc) {
                    case 'clearLines':
                        // n ライン以上消去したとき
                        if (result.linesCleared >= ccv) conditionMet = true;
                        break;
                    case 'tspin': {
                        // T-Spin（mini含む）で n ライン以上消去したとき
                        const isTSpin2 = (result.tSpinType === 'tspin' || result.tSpinType === 'mini');
                        if (isTSpin2 && result.linesCleared >= ccv) conditionMet = true;
                        break;
                    }
                    case 'tspinSingle': {
                        // T-Spin Single（miniは除く）: ちょうど1ライン消去
                        if (result.tSpinType === 'tspin' && result.linesCleared === 1) conditionMet = true;
                        break;
                    }
                    case 'tspinDouble': {
                        // T-Spin Double（miniは除く）: ちょうど2ライン消去
                        if (result.tSpinType === 'tspin' && result.linesCleared === 2) conditionMet = true;
                        break;
                    }
                    case 'tspinTriple': {
                        // T-Spin Triple（miniは除く）: ちょうど3ライン消去
                        if (result.tSpinType === 'tspin' && result.linesCleared === 3) conditionMet = true;
                        break;
                    }
                    case 'ren':
                        // REN が n 以上の状態でライン消去したとき
                        if (result.linesCleared > 0 && (result.ren) >= ccv) conditionMet = true;
                        break;
                    case 'allClear':
                        // パーフェクトクリアしたとき（fieldが空 & ライン消去あり）
                        if (game.field && game.field.blocks.length === 0 && result.linesCleared > 0) conditionMet = true;
                        break;
                    case 'score':
                        // スコアが ccv 以上になったとき（累積でも単回でも条件を満たすたびに加算）
                        if (game.score >= ccv) conditionMet = true;
                        break;
                }

                if (conditionMet) {
                    this.clearTimes++;
                    // クリア回数表示を更新（HTMLに quiz-count-display 要素があれば反映）
                    const dispEl = document.getElementById('quiz-count-display');
                    if (dispEl) dispEl.textContent = `${this.clearTimes} / ${cond.value}`;

                    if (this.clearTimes >= cond.value) {
                        this._onClear();
                    }
                }
                break;
            }
        }
    }

    // ─── ぷよ用 count 条件チェック（チェーン確定時に呼ぶ） ─────────
    // PuyoGame 側から _quizManager._checkClearOnPuyoChain(chainCount) の形で呼ぶ想定。
    // （PuyoGame の連鎖確定コールバックに以下の呼び出しを追加する必要がある）
    _checkClearOnPuyoChain(chainCount) {
        if (!this.currentLevel || !this.gameInstance) return;
        if (this.isClear || this.isFailed) return;
        if (this.currentLevel.rule !== 'puyo') return;

        const cond = this.currentLevel.clearCondition;
        if (cond.type !== 'count') return;

        const cc  = cond.countCondition;
        const ccv = cond.countValue ?? 1;
        let conditionMet = false;

        switch (cc) {
            case 'chain':
                // 今回の連鎖数が ccv 以上のとき
                if (chainCount >= ccv) conditionMet = true;
                break;
            case 'allClear':
                if (this.gameInstance.isAllClear) conditionMet = true;
                break;
            case 'score':
                if (this.gameInstance.score >= ccv) conditionMet = true;
                break;
        }

        if (conditionMet) {
            this.clearTimes++;
            const dispEl = document.getElementById('quiz-count-display');
            if (dispEl) dispEl.textContent = `${this.clearTimes} / ${cond.value}`;

            if (this.clearTimes >= cond.value) {
                this._onClear();
            }
        }
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
                // secureMino フックも元に戻す
                if (this._originalSecureMino) this.gameInstance.secureMino = this._originalSecureMino;
                if (this._originalRestart) this.gameInstance.restart = this._originalRestart;
                if (this._originalStart) this.gameInstance.start = this._originalStart;
                if (this._originalGameOver) this.gameInstance.gameOver = this._originalGameOver;
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
                if (this._originalRestart) this.gameInstance.restart = this._originalRestart;
                if (this._originalStart) this.gameInstance.start = this._originalStart;
                if (this._originalBeginGameOver) this.gameInstance._beginGameOver = this._originalBeginGameOver;
                
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
        
        // ─── 追加フィールドのリセット ───
        this.clearTimes        = 0;
        this._lastSecureResult = { tSpinType: null, linesCleared: 0, ren: 0 };
        this._preLines         = 0;
        this._isSecuring       = false;
        this._failedByDummy    = false;

        // 参照も破棄
        this._originalPopMino = null;
        this._originalGetNextType = null;
        this._originalHoldCurrentMino = null;
        this._originalSecureMino = null;
        this._originalDequeueNext = null;
        this._originalMakePair = null;
        this._originalRestart = null;
        this._originalStart = null;
        this._originalGameOver = null;
        this._originalBeginGameOver = null;
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
            const rule   = levelData.rule;
            const levels = QUIZ_LEVELS[rule] || [];
            const currentIdx = levels.findIndex(l => l.id === levelData.id);
            _setQuizResultPage(isSuccess, levelData, currentIdx);
            switchPage('quiz-result');
        }
    });
}

function _setQuizResultPage(isSuccess, levelData, currentIdx) {
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
    if (levelEl && levelData) {
        const ruleLabel  = levelData.rule === 'tet' ? 'TET' : 'PUYO';
        const levelNum   = (currentIdx >= 0) ? currentIdx + 1 : '?';
        const diffStars  = _renderDiffStars(levelData.diff);
        levelEl.innerHTML = `${ruleLabel} - ${levelNum}${diffStars ? `&nbsp;<span style="font-size:0.75em;">${diffStars}</span>` : ""}`;
    }

    const condEl = document.getElementById('quiz-result-condition');
    if (condEl && levelData) condEl.textContent = levelData.clearCondition.description;

    const statusEl = document.getElementById('quiz-result-status');
    if (statusEl) statusEl.textContent = isSuccess ? 'SUCCESS' : 'FAILED';

    const nextBtn = document.getElementById('quiz-result-next-btn');
    if (nextBtn && levelData) {
        const rule   = levelData.rule;
        const levels = QUIZ_LEVELS[rule] || [];
        const hasNext = isSuccess && currentIdx >= 0 && currentIdx < levels.length - 1;

        nextBtn.style.display = hasNext ? 'flex' : 'none';

        if (hasNext) {
            nextBtn.onclick = () => {
                currentQuizLevel = levels[currentIdx + 1];
                if (typeof switchPage === 'function') {
                    startQuizLevel(currentQuizLevel);
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

// ─── 難易度★用スタイルを動的注入 ───────────────
(function _injectDiffStarStyles() {
    if (document.getElementById('quiz-diff-star-styles')) return;
    const style = document.createElement('style');
    style.id = 'quiz-diff-star-styles';
    style.textContent = `
        .quiz-level-btn {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }
        .quiz-level-diff {
            display: block;
            font-size: 9px;
            line-height: 1;
            margin-top: 2px;
            letter-spacing: 1px;
        }
        .diff-star { font-style: normal; }
        .diff-star-filled { color: #f5c542; }
        .diff-star-empty  { color: rgba(255,255,255,0.18); }
    `;
    document.head.appendChild(style);
})();

// ─── 難易度★レンダリングヘルパー ─────────────────
// diff: 数値（未指定時は null→非表示）
// 最大5★、filled/empty で色分けする HTML 文字列を返す
function _renderDiffStars(diff) {
    if (diff == null || diff === undefined) return '';
    const max = 5;
    const filled = Math.max(0, Math.min(max, Math.round(diff)));
    let html = '';
    for (let i = 1; i <= max; i++) {
        html += `<span class="diff-star ${i <= filled ? 'diff-star-filled' : 'diff-star-empty'}">${i <= filled ? '★' : '☆'}</span>`;
    }
    return html;
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
        const diffStars = _renderDiffStars(level.diff);
        btn.innerHTML = `<span class="quiz-level-num">${idx + 1}</span>${diffStars ? `<span class="quiz-level-diff">${diffStars}</span>` : ''}`;
        btn.onclick = () => {
            currentQuizLevel = level;
            // 【変更】ゲームを即座に開始せず、選択したレベルを保持して準備画面（mode-check）へ遷移する
            switchPage('mode-check');
        };
        listEl.appendChild(btn);
    });
}

// ─── QUIZレベル開始 ──────────────────────────
async function startQuizLevel(levelData) {
    if (!levelData) return;

    currentQuizLevel = levelData;

    // 既存ゲームを全停止
    if (typeof stopAllGames === 'function') stopAllGames();
    if (window._quizManager) {
        window._quizManager.destroy();
    }

    // stopAllGames → _stopQuizIfActive により非表示にされた後で表示を復元する
    _showQuizFieldHeader(levelData);
    
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

    // ─── フィールドオーバーレイのヘッダーテキスト更新（pause-quiz-info と同じ構造） ───
    const ruleTitleEl = document.getElementById('quiz-field-info-rule-title');
    const descEl      = document.getElementById('quiz-field-info-desc');
    const goalEl      = document.getElementById('quiz-field-info-goal');
    if (ruleTitleEl || descEl || goalEl) {
        const ruleLabel = levelData.rule === 'tet' ? 'TET' : 'PUYO';
        const levelNum  = (QUIZ_LEVELS[levelData.rule] || []).findIndex(l => l.id === levelData.id) + 1;
        if (ruleTitleEl) ruleTitleEl.textContent = `${ruleLabel} — ${levelNum}`;
        if (descEl)      descEl.textContent      = levelData.description;
        if (goalEl)      goalEl.textContent      = `GOAL: ${levelData.clearCondition.description}`;
    }

    // ─── ルールに応じてゲームインスタンスを準備 ───
    if (levelData.rule === 'puyo') {
        _switchToPuyoLayout(true);

        // QUIZぷよ中はtetインスタンスのキーハンドラを明示的に無効化する
        // （残存ハンドラが pause キーに反応して resume() → startGravity() が暴発するのを防ぐ）
        if (window._game) {
            if (window._game._keyDownHandler) document.removeEventListener('keydown', window._game._keyDownHandler);
            if (window._game._keyUpHandler)   document.removeEventListener('keyup',   window._game._keyUpHandler);
            if (window._game._keyLoop)        { clearInterval(window._game._keyLoop); window._game._keyLoop = null; }
            window._game._keyDownHandler = null;
            window._game._keyUpHandler   = null;
            window._game.isPaused = false; // 残存 isPaused フラグもリセット
        }

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
        // テト
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
        const ruleLabel   = levelData.rule === 'tet' ? 'TET' : 'PUYO';
        const levelNum    = (QUIZ_LEVELS[levelData.rule] || []).findIndex(l => l.id === levelData.id) + 1;
        const ruleTitleEl = document.getElementById('quiz-field-info-rule-title');
        const descEl      = document.getElementById('quiz-field-info-desc');
        const goalEl      = document.getElementById('quiz-field-info-goal');
        if (ruleTitleEl) ruleTitleEl.textContent = `${ruleLabel} — ${levelNum}`;
        if (descEl)      descEl.textContent      = levelData.description;
        if (goalEl)      goalEl.textContent      = `GOAL: ${levelData.clearCondition.description}`;
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
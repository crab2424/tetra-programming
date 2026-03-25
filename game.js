const SATRT_BTN_ID = "start-btn"
const MAIN_CANVAS_ID = "main-canvas"
const NEXT_CANVAS_ID = "next-canvas"
const HOLD_CANVAS_ID = "hold-canvas"
const GAME_SPEED = 500;
const BLOCK_SIZE = 32;
const COLS_COUNT = 10;
const ROWS_COUNT = 20;
const GRAVITY_INTERVAL = 1000; // ミノが1マス落ちる時間（ms）
const VISIBLE_EXTRA_ROW_RATIO = 0.5; // 上に見せる割合（-1行目）
const SCREEN_WIDTH = COLS_COUNT * BLOCK_SIZE;
const SCREEN_HEIGHT = (ROWS_COUNT + VISIBLE_EXTRA_ROW_RATIO) * BLOCK_SIZE;
const NEXT_AREA_SIZE = 160;
const BLOCK_SOURCES = [
    "images/block-0.png",
    "images/block-1.png",
    "images/block-2.png",
    "images/block-3.png",
    "images/block-4.png",
    "images/block-5.png",
    "images/block-6.png"
]

// ─────────────────────────────────────────────
// キーコンフィグ：localStorage から読み込む
// DEFAULT_KEYS は index.html 側でも定義しているが、
// game.js 単体でも動くようにここにも定義する
// ─────────────────────────────────────────────
const _DEFAULT_KEYCONFIG = {
    moveLeft:  { code: 'ArrowLeft',  label: '←' },
    moveRight: { code: 'ArrowRight', label: '→' },
    softDrop:  { code: 'ArrowDown',  label: '↓' },
    hardDrop:  { code: 'Space',      label: 'SPACE' },
    rotateCW:  { code: 'ArrowUp',    label: '↑' },
    rotateCCW: { code: 'KeyZ',       label: 'Z' },
    hold:      { code: 'ShiftLeft',  label: 'SHIFT' },
    pause:     { code: 'Escape',     label: 'ESC' },
};

function loadKeyConfig() {
    try {
        const saved = localStorage.getItem('game_keyconfig');
        if (saved) {
            const parsed = JSON.parse(saved);
            // デフォルト設定に、保存された設定を上書き（足りないキーを補完）
            return { ..._DEFAULT_KEYCONFIG, ...parsed };
        }
    } catch(e) {}
    return JSON.parse(JSON.stringify(_DEFAULT_KEYCONFIG));
}

window.onload = function(){
    Asset.init()
    let game = new Game()
    // グローバルに保持（設定変更後に setKeyEvent を外から呼ぶため）
    window._game = game

    document.getElementById(SATRT_BTN_ID).onclick = function(){
        game.start()
        this.blur()
    }
}

// ─────────────────────────────────────────────
// 素材管理クラス
// ─────────────────────────────────────────────
class Asset{
    static blockImages = []

    static init(callback){
        let loadCnt = 0
        for(let i = 0; i <= 6; i++){
            let img = new Image();
            img.src = BLOCK_SOURCES[i];
            img.onload = function(){
                loadCnt++
                Asset.blockImages.push(img)
                if(loadCnt >= BLOCK_SOURCES.length && callback){
                    callback()
                }
            }
        }
    }
}

// ─────────────────────────────────────────────
// Game クラス
// ─────────────────────────────────────────────
class Game{
    constructor(){
        this.initMainCanvas()
        this.initNextCanvas()
        this.initHoldCanvas()
        this.lockDelay = 600; // 0.6秒
        this.lockTimer = null;
        this.isGrounded = false;
        this.bag = [];
        this.nextQueue = [];
    }

    initMainCanvas(){
        this.mainCanvas = document.getElementById(MAIN_CANVAS_ID);
        this.mainCtx = this.mainCanvas.getContext("2d");
        this.mainCanvas.width = SCREEN_WIDTH;
        this.mainCanvas.height = SCREEN_HEIGHT;

        // ★ 追加：ページ読み込み時（ゲーム開始前）に一度だけグリッドを描画しておく
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
        this.drawGrid(this.mainCtx);
        this.mainCtx.restore();
    }

    initNextCanvas(){
        this.nextCanvas = document.getElementById(NEXT_CANVAS_ID);
        this.nextCtx = this.nextCanvas.getContext("2d");
        this.nextCanvas.width = BLOCK_SIZE * 4;
        this.nextCanvas.height = BLOCK_SIZE * 13.5;
    }

    initHoldCanvas(){
        this.holdCanvas = document.getElementById(HOLD_CANVAS_ID);
        this.holdCtx = this.holdCanvas.getContext("2d");
        this.holdCanvas.width = BLOCK_SIZE * 4;
        this.holdCanvas.height = BLOCK_SIZE * 4;
    }

    // グリッド線を描画する
    drawGrid(ctx) {
        ctx.save();
        // グリッド線の色と太さ（暗い背景に馴染む薄い白）
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'; 
        ctx.lineWidth = 1;

        // 縦線を引く
        for (let x = 0; x <= COLS_COUNT; x++) {
            ctx.beginPath();
            // -1行目の上端（見えている部分）から一番下まで
            ctx.moveTo(x * BLOCK_SIZE, -BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);
            ctx.lineTo(x * BLOCK_SIZE, ROWS_COUNT * BLOCK_SIZE);
            ctx.stroke();
        }

        // 横線を引く（-1行目の区切り線も含むように -1 からスタート）
        for (let y = -1; y <= ROWS_COUNT; y++) {
            ctx.beginPath();
            ctx.moveTo(0, y * BLOCK_SIZE);
            ctx.lineTo(COLS_COUNT * BLOCK_SIZE, y * BLOCK_SIZE);
            ctx.stroke();
        }
        ctx.restore();
    }

    // ゲーム開始
    start(){
        // ★ 7バッグをリセット
        this.bag = [];
        this.nextQueue = [];
        for(let i = 0; i < 5; i++){
            this.nextQueue.push(new Mino(this.getNextType()));
        }
        this.nextMino = null;
        this.field = new Field()
        this.holdMino = null
        this.canHold = true
        this.score = 0
        this.isPaused = false
        this.hidePauseOverlay()
        this.updateScoreDisplay()
        this.popMino()
        this.drawAll()
        clearInterval(this.timer)
        this.startGravity()
        this.setKeyEvent()
    }

    // ポーズ切り替え
    togglePause(){
        if(this.isPaused){
            this.resume()
        } else {
            this.pause()
        }
    }

    pause(){
        if(this.isPaused) return
        this.isPaused = true
        clearInterval(this.timer)
        this.showPauseOverlay()
    }

    resume(){
        if(!this.isPaused) return
        this.isPaused = false
        this.hidePauseOverlay()
        
        // ★重力か猶予タイマーのどちらかを再開させる
        this.checkGroundState();
        if(!this.isGrounded) {
            this.startGravity();
        }
    }

    startGravity(){
        if(this.timer) clearInterval(this.timer)
        this.timer = setInterval(() => this.dropMino(), GRAVITY_INTERVAL)
    }

    showPauseOverlay(){
        document.getElementById('pause-overlay').classList.add('active')
    }

    hidePauseOverlay(){
        document.getElementById('pause-overlay').classList.remove('active')
    }

    // ゲームオーバー処理
    gameOver() {
        this.drawAll();
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
        this.isPaused = true; // キー入力を無効化
        setTimeout(() => alert("ゲームオーバー"), 10);
    }

    getNextType(){
        if(this.bag.length === 0){
            this.bag = [0,1,2,3,4,5,6];
            // シャッフル（Fisher-Yates）
            for(let i = this.bag.length - 1; i > 0; i--){
                const j = Math.floor(Math.random() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    }

    // 新しいミノを出す
    popMino(){
        this.mino = this.nextQueue.shift();
        this.mino.spawn();

        // ★ 追加：出現位置での致命判定
        if (!this.valid(0, 0)) {
            // ★ 修正: -3 などの固定値ではなく、現在の位置から1引く
            this.mino.y -= 1;
            if (!this.valid(0, 0)) {
                this.gameOver();
                return;
            }
        }

        this.nextQueue.push(new Mino(this.getNextType()));
        this.canHold = true

        // 状態・タイマー・カウントの初期化
        this.isGrounded = false;
        this.lowestY = this.mino.y;
        this.moveCount = 0;
        
        if(this.lockTimer){
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
        }
        this.startGravity(); // 重力をリセットして開始

        // ★ 削除：ここにあった if(!this.valid(0, 1)) { ... } は削除
    }

    // SRS回転
    tryRotate(rotDir){
        const isI = this.mino.type === 0
        const from = this.mino.rotation
        const to = (from + (rotDir === 1 ? 1 : 3)) % 4

        const kickTableCW = isI ? {
        '0->1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
        '1->2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
        '2->3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
        '3->0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]]
    } : {
        '0->1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
        '1->2': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
        '2->3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
        '3->0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]
    }

        const kickTableCCW = isI ? {
        '0->3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
        '3->2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
        '2->1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
        '1->0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]]
    } : {
        '0->3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
        '3->2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
        '2->1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
        '1->0': [[0,0],[1,0],[1,-1],[0,2],[1,2]]
    }
        const key = `${from}->${to}`
        const table = rotDir === 1 ? kickTableCW[key] : kickTableCCW[key]

        if(!table) return false

        for(const [dx, dy] of table){
            // 「回転後の形状でキックオフセット(dx,-dy)を加算した位置」を検証する
            // rotDir で回転、moveX/moveY でキックを別々に渡す
            if(this.validRotated(rotDir, dx, -dy)){
                if(rotDir === 1) this.mino.rotate()
                else this.mino.rotateCCW()

                this.mino.x += dx
                this.mino.y += -dy
                this.mino.rotation = to
                return true
            }
        }
        return false
    }

    // 回転後にキックオフセットを加えた位置が有効かどうかを検証
    // （valid/getNewBlocks とは独立した専用メソッド）
    validRotated(rotDir, kickX, kickY){
        const pivot = this.mino.pivot
        const newBlocks = this.mino.blocks.map(block => {
            // 1. pivot 基準で回転
            let relX = block.x - pivot.x
            let relY = block.y - pivot.y
            let rx, ry
            if(rotDir === 1){
                rx = -relY
                ry =  relX
            } else {
                rx =  relY
                ry = -relX
            }
            const rotatedX = Math.round(rx + pivot.x)
            const rotatedY = Math.round(ry + pivot.y)

            // 2. ミノのワールド座標 + キックオフセットを加算
            return {
                x: rotatedX + this.mino.x + kickX,
                y: rotatedY + this.mino.y + kickY
            }
        })

        return newBlocks.every(block =>
            block.x >= 0 &&
            block.x < COLS_COUNT &&
            block.y >= -5 &&
            block.y < ROWS_COUNT &&
            !this.field.has(block.x, block.y)
        )
    }

    // ホールド
    holdCurrentMino(){
        if(!this.canHold) return
        this.canHold = false

        if(this.holdMino === null){
            this.holdMino = new Mino()
            this.holdMino.type = this.mino.type
            this.holdMino.initBlocks()
            this.popMino()
        } else {
            let prevHoldType = this.holdMino.type
            this.holdMino = new Mino()
            this.holdMino.type = this.mino.type
            this.holdMino.initBlocks()
            this.mino = new Mino()
            this.mino.type = prevHoldType
            this.mino.initBlocks()
            this.mino.spawn()
        
            /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            追加: ホールドから出した時の致命判定とタイマーリセット
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
            if (!this.valid(0, 0)) {
                this.mino.y -= 1; // 1列上で再試行
                if (!this.valid(0, 0)) {
                    this.gameOver();
                    return;
                }
            }

            // 状態・タイマー・カウントの初期化（popMinoと同じにする）
            this.isGrounded = false;
            this.lowestY = this.mino.y;
            this.moveCount = 0;
            
            if(this.lockTimer){
                clearTimeout(this.lockTimer);
                this.lockTimer = null;
            }
            this.startGravity();
        }
        this.drawAll()
    }

    // ミノを即座に固定する共通処理
    secureMino(){
        // ★ 追加：固定されるミノがすべて盤面外（y < 0）か判定
        let isAllOutside = this.mino.blocks.every(block => (block.y + this.mino.y) < 0);

        this.mino.blocks.forEach(e => {
            e.x += this.mino.x
            e.y += this.mino.y
        })
        this.field.blocks = this.field.blocks.concat(this.mino.blocks)

        const linesCleared = this.field.checkLine()
        const scoreTable = [0, 100, 300, 500, 800]
        this.score += scoreTable[linesCleared] ?? 0
        this.updateScoreDisplay()

        // ★ 追加：すべて盤面外ならゲームオーバーにして、次のミノは出さない
        if (isAllOutside) {
            this.gameOver();
            return;
        }

        this.popMino()
    }

    // ハードドロップ
    hardDrop(){
        while(this.valid(0, 1)){
            this.mino.y++
        }

        // タイマーを両方停止
        if(this.timer) { clearInterval(this.timer); this.timer = null; }
        if(this.lockTimer){ clearTimeout(this.lockTimer); this.lockTimer = null; }

        this.secureMino()
        this.drawAll()
    }

    updateScoreDisplay(){
        document.getElementById("score-value").textContent = this.score
    }

    getGhostY(){
        let ghostY = this.mino.y
        while(true){
            let newBlocks = this.mino.blocks.map(block => ({
                x: block.x + this.mino.x,
                y: block.y + ghostY + 1
            }))
            let canMove = newBlocks.every(block =>
                block.x >= 0 &&
                block.x < COLS_COUNT &&
                block.y < ROWS_COUNT &&
                !this.field.has(block.x, block.y)
            )
            if(canMove){
                ghostY++
            } else {
                break
            }
        }
        return ghostY
    }

    drawAll(){
        this.mainCtx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT)
        this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height)
        this.holdCtx.clearRect(0, 0, this.holdCanvas.width, this.holdCanvas.height)

        // 上に少し余白を作る（-1行目の一部を表示）
        this.mainCtx.save();
        this.mainCtx.translate(0, BLOCK_SIZE * VISIBLE_EXTRA_ROW_RATIO);

        // ★ ブロックを描画する前にグリッドを描画する
        this.drawGrid(this.mainCtx);

        this.field.drawFixedBlocks(this.mainCtx);

        const ghostY = this.getGhostY()
        if(ghostY !== this.mino.y){
            this.mainCtx.globalAlpha = 0.25
            this.mino.draw(this.mainCtx, ghostY)
            this.mainCtx.globalAlpha = 1.0
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // ★ 追加：NEXT / HOLD 内のミノの縮小率を設定
        const minoScale = 0.8; // 0.8倍（お好みのサイズに変更してください）
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        // Draw next queue vertically
        const spacing = 3; // ミノ間の縦間隔（マス単位）
        this.nextQueue.forEach((mino, i) => {
            this.nextCtx.save();
            // ★変更：スケールに合わせて縦の間隔も調整し、ctx.scale を適用
            this.nextCtx.translate(0, i * spacing * BLOCK_SIZE * minoScale);
            this.nextCtx.scale(minoScale, minoScale);
            mino.drawNext(this.nextCtx);
            this.nextCtx.restore();
        });
        
        this.mino.draw(this.mainCtx)
        this.mainCtx.restore();

        if(this.holdMino){
            this.holdCtx.save(); // ★ 追加
            if(!this.canHold){
                this.holdCtx.globalAlpha = 0.4;
            }
            this.holdCtx.scale(minoScale, minoScale); // ★ 追加
            this.holdMino.drawNext(this.holdCtx);
            this.holdCtx.restore(); // ★ 追加
        }
    }

    dropMino(){
        if(this.valid(0, 1)){
            this.mino.y++;
            this.updateLowestY(); // ★ 追加
        }
        this.checkGroundState();
        this.drawAll();
    }

    // 接地状態をチェックし、重力と固定猶予タイマーを切り替える
    checkGroundState(actionHappened = false, wasGrounded = false) {
        // ★ 接地状態からの操作ならカウントを進める
        if (actionHappened && wasGrounded) {
            this.moveCount++;
        }

        if (!this.valid(0, 1)) {
            // ▼ 接地している場合 ▼
            if (!this.isGrounded) {
                this.isGrounded = true;
                if (this.timer) {
                    clearInterval(this.timer);
                    this.timer = null;
                }
            }

            // ★ カウントが15回以上の場合は即座に強制固定
            if (this.moveCount >= 15) {
                if (this.lockTimer) {
                    clearTimeout(this.lockTimer);
                    this.lockTimer = null;
                }
                this.secureMino();
                // secureMino()内で次のミノが呼ばれ描画されるためここで終了
                return; 
            }

            // まだ余裕がある場合は猶予タイマー開始（またはリセット）
            this.startLockTimer();
        } else {
            // ▼ 空中にいる場合 ▼
            // 15回超えでも空中なら自由に動ける（接地した瞬間に上のブロックで強制固定される）
            if (this.isGrounded) {
                this.isGrounded = false;
                if (this.lockTimer) {
                    clearTimeout(this.lockTimer);
                    this.lockTimer = null;
                }
                this.startGravity(); 
            }
        }
    }

    // 最低Y座標を更新し、更新されたら操作回数をリセットする
    updateLowestY() {
        if (this.mino.y > this.lowestY) {
            this.lowestY = this.mino.y;
            this.moveCount = 0; // 最低位置が更新されたら15カウントをリセット
        }
    }

    // 固定猶予タイマーの起動・リセット
    startLockTimer() {
        if (this.lockTimer) clearTimeout(this.lockTimer);
        this.lockTimer = setTimeout(() => {
            this.lockTimer = null;
            this.secureMino();
            this.drawAll();
        }, this.lockDelay);
    }

    valid(moveX, moveY, rot=0){
        let newBlocks = this.mino.getNewBlocks(moveX, moveY, rot)
        return newBlocks.every(block => {
            return (
                block.x >= 0 &&
                block.y >= -5 &&
                block.x < COLS_COUNT &&
                block.y < ROWS_COUNT &&
                !this.field.has(block.x, block.y)
            )
        })
    }

    // ─────────────────────────────────────────
    // キーイベント（localStorage のキー設定を参照）
    // ─────────────────────────────────────────
    setKeyEvent(){
        // 押されているキーを管理
        this.keyState = {}

        // DAS設定（Delayed Auto Shift）
        this.DAS_DELAY = 150; // ms（初期値0.15秒）

        // ARR設定（左右とソフトドロップを分離）
        this.ARR_INTERVAL = 20;        // 左右移動
        this.SOFTDROP_ARR = GRAVITY_INTERVAL / 20;        // ソフトドロップ
        this._lastSoftDropTime = 0;
        this._leftPressTime = null;
        this._rightPressTime = null;
        this._lastMoveTimeLeft = 0;
        this._lastMoveTimeRight = 0;

        // DCD設定（DAS Cut Delay）
        // 「DASが効いていてARR連続移動中だが壁等で動けない（空振り）」状態で
        // ハードドロップまたは回転を入力した際に発動する遅延。
        // この遅延が終わるまでDASによる左右移動はブロックされる。
        // 左右キーを離すと即座にリセット。
        this.DCD_DELAY = 50;        // ms（0 = 無効、例: 2f≒33ms）
        this._dcdUntil = 0;        // DCD解除時刻（performance.now()基準）
        this._dasBlockedLeft = false;   // 左: DASアクティブだが動けない状態か
        this._dasBlockedRight = false;  // 右: DASアクティブだが動けない状態か

        // 既存のリスナー解除
        if(this._keyDownHandler){
            document.removeEventListener('keydown', this._keyDownHandler)
        }
        if(this._keyUpHandler){
            document.removeEventListener('keyup', this._keyUpHandler)
        }
        if(this._keyLoop){
            clearInterval(this._keyLoop)
        }

        const keys = loadKeyConfig()

        this._keyDownHandler = (e) => {
            const gamePage = document.getElementById('game-page')
            if(!gamePage || !gamePage.classList.contains('active')) return

            // ポーズ
            if(e.code === keys.pause.code){
                e.preventDefault()
                this.togglePause()
                return
            }

            // ポーズ中は他のキー入力を無視
            if(this.isPaused) return

            this.keyState[e.code] = true

            const now = performance.now()
            if(e.code === keys.moveLeft.code && this._leftPressTime === null){
                this._leftPressTime = now
                this._lastMoveTimeLeft = 0
            }
            if(e.code === keys.moveRight.code && this._rightPressTime === null){
                this._rightPressTime = now
                this._lastMoveTimeRight = 0
            }

            // 単発系（押した瞬間のみ）
            if(e.code === keys.hardDrop.code){
                e.preventDefault()
                // DCD発動チェック（ハードドロップ）
                // DASが効いていて動けない状態でハードドロップした場合にDCDを開始する
                if(this.DCD_DELAY > 0 &&
                    (this._dasBlockedLeft || this._dasBlockedRight)){
                    this._dcdUntil = performance.now() + this.DCD_DELAY
                }
                this.hardDrop()
            }
            if(e.code === keys.hold.code){
                e.preventDefault()
                this.holdCurrentMino()
            }
        }

        this._keyUpHandler = (e) => {
            this.keyState[e.code] = false

            if(e.code === keys.moveLeft.code){
                this._leftPressTime = null
                // 左キーを離したら DCD・DASブロック状態を即リセット
                this._dasBlockedLeft = false
                this._dcdUntil = 0
            }
            if(e.code === keys.moveRight.code){
                this._rightPressTime = null
                // 右キーを離したら DCD・DASブロック状態を即リセット
                this._dasBlockedRight = false
                this._dcdUntil = 0
            }
        }

        document.addEventListener('keydown', this._keyDownHandler)
        document.addEventListener('keyup', this._keyUpHandler)

        // 毎フレーム入力処理（同時入力対応）
        this._lastFrameTime = performance.now()
        this._keyLoop = setInterval(() => {
            const gamePage = document.getElementById('game-page')
            if(!gamePage || !gamePage.classList.contains('active')) return
            if(this.isPaused) return

            const nowPerf = performance.now()
            const delta = nowPerf - this._lastFrameTime
            this._lastFrameTime = nowPerf

            let acted = false
            let wasGrounded = this.isGrounded; // ★ 操作前の接地状態を記憶

            const now = nowPerf

            // ─── 左移動（DAS対応） ─────────────────────────────────
            if(this.keyState[keys.moveLeft.code]){
                if(this._leftPressTime !== null){
                    const heldTime = now - this._leftPressTime
                    const inDcd = now < this._dcdUntil

                    // 初回入力（押した瞬間）
                    if(this._lastMoveTimeLeft === 0){
                        if(this.valid(-1, 0)){
                            this.mino.x--
                            acted = true
                        }
                        this._lastMoveTimeLeft = now
                        this._dasBlockedLeft = false
                    }
                    // DAS後の連続移動フェーズ
                    else if(heldTime >= this.DAS_DELAY &&
                            now - this._lastMoveTimeLeft >= this.ARR_INTERVAL){
                        if(!inDcd){
                            if(this.valid(-1, 0)){
                                this.mino.x--
                                acted = true
                                this._dasBlockedLeft = false
                            } else {
                                // DASが効いているが壁等で動けない（空振り）
                                this._dasBlockedLeft = true
                            }
                        }
                        // DCD中でも _lastMoveTimeLeft は更新し続け、
                        // DCD解除後すぐARRが再開できるようにする
                        this._lastMoveTimeLeft = now
                    }
                }
            } else {
                this._dasBlockedLeft = false
            }

            // ─── 右移動（DAS対応） ─────────────────────────────────
            if(this.keyState[keys.moveRight.code]){
                if(this._rightPressTime !== null){
                    const heldTime = now - this._rightPressTime
                    const inDcd = now < this._dcdUntil

                    if(this._lastMoveTimeRight === 0){
                        if(this.valid(1, 0)){
                            this.mino.x++
                            acted = true
                        }
                        this._lastMoveTimeRight = now
                        this._dasBlockedRight = false
                    }
                    else if(heldTime >= this.DAS_DELAY &&
                            now - this._lastMoveTimeRight >= this.ARR_INTERVAL){
                        if(!inDcd){
                            if(this.valid(1, 0)){
                                this.mino.x++
                                acted = true
                                this._dasBlockedRight = false
                            } else {
                                // DASが効いているが壁等で動けない（空振り）
                                this._dasBlockedRight = true
                            }
                        }
                        this._lastMoveTimeRight = now
                    }
                }
            } else {
                this._dasBlockedRight = false
            }

            // ソフトドロップ（専用ARR）
            if(this.keyState[keys.softDrop.code]){
                if(this._lastSoftDropTime === 0 ||
                    now - this._lastSoftDropTime >= this.SOFTDROP_ARR){
                    if(this.valid(0, 1)){
                        this.mino.y++
                        this.updateLowestY(); // ★ 追加：落下したら最低Y更新チェック
                        acted = true
                    }
                    this._lastSoftDropTime = now
                }
            } else {
                this._lastSoftDropTime = 0
            }

            // 回転（即時反応させる）
            if(this.keyState[keys.rotateCW.code]){
                if(!this._rotCWPressed){
                    if(this.tryRotate(1)){
                        this.updateLowestY(); // ★ 追加：キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCWPressed = true
                }
            }
            if(!this.keyState[keys.rotateCW.code]){
                this._rotCWPressed = false
            }

            if(this.keyState[keys.rotateCCW.code]){
                if(!this._rotCCWPressed){
                    if(this.tryRotate(-1)){
                        this.updateLowestY(); // ★ 追加：キック等でY座標が下がった時のため
                        acted = true
                    }
                    this._rotCCWPressed = true
                }
            }
            if(!this.keyState[keys.rotateCCW.code]){
                this._rotCCWPressed = false
            }

            // ─── DCD 発動チェック（回転） ──────────────────────────
            // DASが効いていて動けない（空振り）状態で回転が入力された場合にDCDを開始する
            if(this.DCD_DELAY > 0 && acted){
                const rotActed =
                    (this.keyState[keys.rotateCW.code]  && this._rotCWPressed) ||
                    (this.keyState[keys.rotateCCW.code] && this._rotCCWPressed)
                if(rotActed && (this._dasBlockedLeft || this._dasBlockedRight)){
                    this._dcdUntil = now + this.DCD_DELAY
                }
            }

            // ★ アクションが起きたら接地状態を再評価（15回制限もここで処理される）
            if(acted){
                this.checkGroundState(true, wasGrounded);
                this.drawAll()
            }

        }, 16) // 約60FPS（ARRが効くようにする）
    }
}

// ─────────────────────────────────────────────
// Block クラス
// ─────────────────────────────────────────────
class Block{
    constructor(x, y, type){
        this.x = x
        this.y = y
        if(type >= 0) this.setType(type)
    }

    setType(type){
        this.type = type
        this.image = Asset.blockImages[type]
    }

    draw(offsetX = 0, offsetY = 0, ctx){
        let drawX = this.x + offsetX
        let drawY = this.y + offsetY
        
        // 修正前: drawY >= 0 && ...
        // 修正後: drawY >= -1 && ...
        if(drawX >= 0 && drawX < COLS_COUNT &&
            drawY >= -1 && drawY < ROWS_COUNT){
            ctx.drawImage(
                this.image,
                drawX * BLOCK_SIZE,
                drawY * BLOCK_SIZE,
                BLOCK_SIZE,
                BLOCK_SIZE
            )
        }
    }

    drawNext(ctx){
        let offsetX = 0
        let offsetY = 0
        switch(this.type){
            case 0: offsetX = 0.5; offsetY = 1;   break;
            case 1: offsetX = 0.5; offsetY = 0.5; break;
            default: offsetX = 1;  offsetY = 0.5; break;
        }
        ctx.drawImage(
            this.image,
            (this.x + offsetX) * BLOCK_SIZE,
            (this.y + offsetY) * BLOCK_SIZE,
            BLOCK_SIZE,
            BLOCK_SIZE
        )
    }
}

// ─────────────────────────────────────────────
// Mino クラス
// ─────────────────────────────────────────────
class Mino{
    
    // mino の種類を決定してブロックを初期化
    constructor(type = null){
        this.pivot = { x: 1.5, y: 1.5 }; // デフォルトの回転軸（4x4中心）
        this.type = (type !== null) ? type : Math.floor(Math.random() * 7);
        this.rotation = 0; // 0:上 1:右 2:下 3:左
        this.initBlocks()
    }

    initBlocks(){
        let t = this.type
        switch(t){
            case 0: // I型
                this.blocks = [new Block(0,1,t),new Block(1,1,t),new Block(2,1,t),new Block(3,1,t)]
                this.pivot = { x: 1.5, y: 1.5 }
                break;
            case 1: // O型（回転しないので中心固定）
                this.blocks = [new Block(1,1,t),new Block(2,1,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1.5, y: 1.5 }
                break;
            case 2: // T型
                this.blocks = [new Block(1,1,t),new Block(0,2,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 3: // J型
                this.blocks = [new Block(0,1,t),new Block(0,2,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 4: // L型
                this.blocks = [new Block(2,1,t),new Block(0,2,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 5: // S型
                this.blocks = [new Block(1,1,t),new Block(2,1,t),new Block(0,2,t),new Block(1,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
            case 6: // Z型
                this.blocks = [new Block(0,1,t),new Block(1,1,t),new Block(1,2,t),new Block(2,2,t)]
                this.pivot = { x: 1, y: 2 }
                break;
        }
    }

    spawn(){
        this.x = COLS_COUNT/2 - 2
        // ★ 修正: Iミノ(type:0)はブロック定義が1段高いため、yを1段下げる
        this.y = (this.type === 0) ? -1 : -2;
        this.rotation = 0
    }

    draw(ctx, overrideY = null){
        const drawY = overrideY !== null ? overrideY : this.y
        this.blocks.forEach(block => {
            block.draw(this.x, drawY, ctx)
        })
    }

    drawNext(ctx){
        this.blocks.forEach(block => {
            block.drawNext(ctx)
        })
    }

    // 右回転（時計回り）
    rotate(){
        this.blocks.forEach(block=>{
            let relX = block.x - this.pivot.x
            let relY = block.y - this.pivot.y

            let newX = -relY
            let newY = relX

            block.x = Math.round(newX + this.pivot.x)
            block.y = Math.round(newY + this.pivot.y)
        })
    }

    // 左回転（反時計回り）
    rotateCCW(){
        this.blocks.forEach(block=>{
            let relX = block.x - this.pivot.x
            let relY = block.y - this.pivot.y

            let newX = relY
            let newY = -relX

            block.x = Math.round(newX + this.pivot.x)
            block.y = Math.round(newY + this.pivot.y)
        })
    }

    getNewBlocks(moveX, moveY, rot){
        let newBlocks = this.blocks.map(block=>{
            return new Block(block.x, block.y)
        })
        newBlocks.forEach(block => {
            if(moveX || moveY){
                block.x += moveX
                block.y += moveY
            }
            if(rot === 1 || rot === -1){
                let relX = block.x - this.pivot.x
                let relY = block.y - this.pivot.y

                let newX, newY
                if(rot === 1){
                    newX = -relY
                    newY = relX
                } else {
                    newX = relY
                    newY = -relX
                }

                block.x = Math.round(newX + this.pivot.x)
                block.y = Math.round(newY + this.pivot.y)
            }
            block.x += this.x
            block.y += this.y
        })
        return newBlocks
    }
}

// ─────────────────────────────────────────────
// Field クラス
// ─────────────────────────────────────────────
class Field{
    constructor(){
        this.blocks = []
    }

    drawFixedBlocks(ctx){
        this.blocks.forEach(block => block.draw(0, 0, ctx))
    }

    checkLine(){
        let linesCleared = 0
        for(var r = 0; r < ROWS_COUNT; r++){
            var c = this.blocks.filter(block => block.y === r).length
            if(c === COLS_COUNT){
                this.blocks = this.blocks.filter(block => block.y !== r)
                this.blocks.filter(block => block.y < r).forEach(upper => upper.y++)
                linesCleared++
                r--
            }
        }
        return linesCleared
    }

    has(x, y){
        return this.blocks.some(block => block.x == x && block.y == y)
    }
}
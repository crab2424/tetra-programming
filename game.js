const SATRT_BTN_ID = "start-btn"
const MAIN_CANVAS_ID = "main-canvas"
const NEXT_CANVAS_ID = "next-canvas"
const HOLD_CANVAS_ID = "hold-canvas"
const GAME_SPEED = 500;
const BLOCK_SIZE = 32;
const COLS_COUNT = 10;
const ROWS_COUNT = 20;
const SCREEN_WIDTH = COLS_COUNT * BLOCK_SIZE;
const SCREEN_HEIGHT = ROWS_COUNT * BLOCK_SIZE;
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
};

function loadKeyConfig() {
    try {
        const saved = localStorage.getItem('game_keyconfig');
        if (saved) return JSON.parse(saved);
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
    }

    initMainCanvas(){
        this.mainCanvas = document.getElementById(MAIN_CANVAS_ID);
        this.mainCtx = this.mainCanvas.getContext("2d");
        this.mainCanvas.width = SCREEN_WIDTH;
        this.mainCanvas.height = SCREEN_HEIGHT;
    }

    initNextCanvas(){
        this.nextCanvas = document.getElementById(NEXT_CANVAS_ID);
        this.nextCtx = this.nextCanvas.getContext("2d");
        this.nextCanvas.width = NEXT_AREA_SIZE
        this.nextCanvas.height = NEXT_AREA_SIZE;
    }

    initHoldCanvas(){
        this.holdCanvas = document.getElementById(HOLD_CANVAS_ID);
        this.holdCtx = this.holdCanvas.getContext("2d");
        this.holdCanvas.width = NEXT_AREA_SIZE;
        this.holdCanvas.height = NEXT_AREA_SIZE;
    }

    // ゲーム開始
    start(){
        this.field = new Field()
        this.holdMino = null
        this.canHold = true
        this.score = 0
        this.updateScoreDisplay()
        this.popMino()
        this.drawAll()
        clearInterval(this.timer)
        this.timer = setInterval(() => this.dropMino(), 1000);
        this.setKeyEvent()
    }

    // 新しいミノを出す
    popMino(){
        this.mino = this.nextMino ?? new Mino()
        this.mino.spawn()
        this.nextMino = new Mino()
        this.canHold = true

        if(!this.valid(0, 1)){
            this.drawAll()
            clearInterval(this.timer)
            alert("ゲームオーバー")
        }
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
        }
        this.drawAll()
    }

    // ハードドロップ
    hardDrop(){
        while(this.valid(0, 1)){
            this.mino.y++
        }
        this.dropMino()
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
        this.nextCtx.clearRect(0, 0, NEXT_AREA_SIZE, NEXT_AREA_SIZE)
        this.holdCtx.clearRect(0, 0, NEXT_AREA_SIZE, NEXT_AREA_SIZE)

        this.field.drawFixedBlocks(this.mainCtx)

        const ghostY = this.getGhostY()
        if(ghostY !== this.mino.y){
            this.mainCtx.globalAlpha = 0.25
            this.mino.draw(this.mainCtx, ghostY)
            this.mainCtx.globalAlpha = 1.0
        }

        this.nextMino.drawNext(this.nextCtx)
        this.mino.draw(this.mainCtx)

        if(this.holdMino){
            if(!this.canHold){
                this.holdCtx.globalAlpha = 0.4
            }
            this.holdMino.drawNext(this.holdCtx)
            this.holdCtx.globalAlpha = 1.0
        }
    }

    dropMino(){
        if(this.valid(0, 1)){
            this.mino.y++;
        } else {
            this.mino.blocks.forEach(e => {
                e.x += this.mino.x
                e.y += this.mino.y
            })
            this.field.blocks = this.field.blocks.concat(this.mino.blocks)
            const linesCleared = this.field.checkLine()
            const scoreTable = [0, 100, 300, 500, 800]
            this.score += scoreTable[linesCleared] ?? 0
            this.updateScoreDisplay()
            this.popMino()
        }
        this.drawAll();
    }

    valid(moveX, moveY, rot=0){
        let newBlocks = this.mino.getNewBlocks(moveX, moveY, rot)
        return newBlocks.every(block => {
            return (
                block.x >= 0 &&
                block.y >= -1 &&
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

            this.keyState[e.code] = true

            // 単発系（押した瞬間のみ）
            if(e.code === keys.hardDrop.code){
                e.preventDefault()
                this.hardDrop()
            }
            if(e.code === keys.hold.code){
                e.preventDefault()
                this.holdCurrentMino()
            }
        }

        this._keyUpHandler = (e) => {
            this.keyState[e.code] = false
        }

        document.addEventListener('keydown', this._keyDownHandler)
        document.addEventListener('keyup', this._keyUpHandler)

        // 毎フレーム入力処理（同時入力対応）
        this._keyLoop = setInterval(() => {
            const gamePage = document.getElementById('game-page')
            if(!gamePage || !gamePage.classList.contains('active')) return

            let acted = false

            // 左右移動
            if(this.keyState[keys.moveLeft.code]){
                if(this.valid(-1, 0)){
                    this.mino.x--
                    acted = true
                }
            }
            if(this.keyState[keys.moveRight.code]){
                if(this.valid(1, 0)){
                    this.mino.x++
                    acted = true
                }
            }

            // ソフトドロップ
            if(this.keyState[keys.softDrop.code]){
                if(this.valid(0, 1)){
                    this.mino.y++
                    acted = true
                }
            }

            // 回転（押しっぱなし暴発防止のためフラグで制御）
            if(this.keyState[keys.rotateCW.code]){
                if(!this._rotCWPressed){
                    if(this.valid(0, 0, 1)){
                        this.mino.rotate()
                        acted = true
                    }
                    this._rotCWPressed = true
                }
            } else {
                this._rotCWPressed = false
            }

            if(this.keyState[keys.rotateCCW.code]){
                if(!this._rotCCWPressed){
                    if(this.valid(0, 0, -1)){
                        this.mino.rotateCCW()
                        acted = true
                    }
                    this._rotCCWPressed = true
                }
            } else {
                this._rotCCWPressed = false
            }

            if(acted){
                this.drawAll()
            }

        }, 50) // 入力ポーリング間隔（約20FPS）
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
        if(drawX >= 0 && drawX < COLS_COUNT &&
           drawY >= 0 && drawY < ROWS_COUNT){
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
            case 0: offsetX = 0.5; offsetY = 0;   break;
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
    constructor(){
        this.pivot = { x: 1.5, y: 1.5 }; // デフォルトの回転軸（4x4中心）
        this.type = Math.floor(Math.random() * 7);
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
        this.y = -1
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
                    newX = relY
                    newY = -relX
                } else {
                    newX = -relY
                    newY = relX
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

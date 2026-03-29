// ─────────────────────────────────────────────
// wasm_cpu.js
// JavaScriptとC++(WebAssembly)を繋ぐためのアダプタークラス
// ─────────────────────────────────────────────

class WasmCPU {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.isAutoPlay = true;
        this.currentMino = null;

        // 10列 × 20行 = 200マス分の1次元配列（型付き配列）を用意
        // Uint8Array は1バイト（0〜255）の数値を扱うため、メモリ効率が最高です。
        this.boardBuffer = new Uint8Array(200);
        
        // C++側（WebAssemblyメモリ）のポインタを保持する変数
        this.boardPtr = null;
    }

    start() {
        this.isActive = true;
        this.updateLoop();
    }

    stop() {
        this.isActive = false;
        // メモリリークを防ぐため、Wasm側に確保したメモリを解放する
        if (this.boardPtr !== null && typeof Module !== 'undefined') {
            Module._free(this.boardPtr);
            this.boardPtr = null;
        }
    }

    updateLoop() {
        if (!this.isActive) return;

        // 新しいミノが出現した時だけ、C++に探索を依頼する
        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.searchBestMoveWasm();
        }

        requestAnimationFrame(() => this.updateLoop());
    }

    // ─────────────────────────────────────────────
    // ★ ここが核心部：JSのデータをC++に渡す形に変換する処理
    // ─────────────────────────────────────────────
    searchBestMoveWasm() {
        if (typeof Module === 'undefined' || !Module._searchBestMove) {
            console.warn("Wasmモジュールがまだロードされていません。");
            return;
        }

        // 【1】 盤面データ（2次元の座標オブジェクト）を1次元配列にフラット化
        this.boardBuffer.fill(0); // バッファをリセット（すべて0の空マスにする）

        this.game.field.blocks.forEach(block => {
            // 画面外（y < 0）のブロックは探索に影響しないか、適宜無視する
            if (block.x >= 0 && block.x < 10 && block.y >= 0 && block.y < 20) {
                // (y座標 * 列数) + x座標 で1次元のインデックスを計算
                const index = block.y * 10 + block.x;
                // ブロックがあるマスを 1 にする
                this.boardBuffer[index] = 1; 
            }
        });

        // 【2】 必要なミノのID（type）を数値として取得
        const currentType = this.game.mino.type;
        // ホールドがない場合は -1 を渡してC++側に「空」であることを伝える
        const holdType = this.game.holdMino !== null ? this.game.holdMino.type : -1;
        const next1Type = this.game.nextQueue[0].type;
        const next2Type = this.game.nextQueue[1].type;
        // ホールド可能かどうか（1:可能, 0:不可）
        const canHold = this.game.canHold ? 1 : 0; 

        // 【3】 Wasm（C++）側のメモリ空間に盤面データをコピーする
        if (this.boardPtr === null) {
            // 初回のみ、C++のメモリ上に200バイトの領域を確保し、そのアドレス（ポインタ）を受け取る
            this.boardPtr = Module._malloc(200); 
        }
        // 用意した1次元配列のデータを、C++のメモリ空間（HEAPU8）に一気に書き込む
        Module.HEAPU8.set(this.boardBuffer, this.boardPtr);

        // 【4】 C++の探索関数を呼び出す！
        // C++側では: int searchBestMove(uint8_t* board, int current, int hold, int next1, int next2, int canHold)
        // のように定義しておきます。
        const resultPacked = Module._searchBestMove(
            this.boardPtr,
            currentType,
            holdType,
            next1Type,
            next2Type,
            canHold
        );

        // 【5】 C++からの戻り値を解読してJSで実行する
        this.decodeAndExecute(resultPacked);
    }

    // ─────────────────────────────────────────────
    // C++から返ってきた数値をJavaScriptの操作に変換する
    // ─────────────────────────────────────────────
    decodeAndExecute(packedData) {
        // ※ ここはC++側の設計次第ですが、例えばC++から単一の整数で
        // [Action(1bit)][Rot(2bit)][X(4bit)] のようにビットパックされて返ってくると仮定します。
        
        // 例：データが -1 なら「ゲームオーバーで打つ手なし」
        if (packedData === -1) return;

        const isHold = (packedData >> 6) & 1;
        const rot    = (packedData >> 4) & 3; // 0~3
        const targetX = packedData & 15;      // 0~15

        if (this.isAutoPlay && !this.game.isPaused) {
            if (isHold === 1) {
                setTimeout(() => {
                    if (this.isActive && this.game.mino === this.currentMino) {
                        this.game.holdCurrentMino();
                    }
                }, 700);
            } else {
                // targetXとrotに従って動かす（cpu2.jsの moveMinoTo と同様の処理）
                this.moveMinoTo(this.currentMino.type, rot, targetX);
                setTimeout(() => {
                    if (this.isActive && this.game.mino === this.currentMino) {
                        this.game.hardDrop();
                    }
                }, 700);
            }
        }
    }

    // （以下略：moveMinoToなどはcpu2.jsからそのまま持ってきます）
    moveMinoTo(id, targetRot, targetX) {
        /* 省略 */
    }
}
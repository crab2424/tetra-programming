// ─────────────────────────────────────────────
// tet/rotation.js  ―  Game.prototype mixin
// 回転・ホールド・Tスピン判定
// ※ core.js（class Game 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(Game.prototype, {

    // SRS回転
    // silent=true のときは回転処理・フラグ設定は行うがSEを鳴らさない。
    // CPUのbuildActionQueueはパスを実機上で一度“再生”して状態を求める際に
    // tryRotateを呼ぶ（その後位置はバックアップから復元される）。この再生中の
    // 回転は画面に出ない最終位置近くで評価されるため、SEを鳴らすと出現位置の
    // ミノに対して空中でtspin_rot等が鳴ってしまう。再生時は silent=true を渡す。
    tryRotate(rotDir, silent = false) {
        const isI = this.mino.type === 0
        const from = this.mino.rotation
        const to = (from + (rotDir === 1 ? 1 : 3)) % 4

        const kickTableCW = isI ? {
            '0->1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
            '1->2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
            '2->3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
            '3->0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]
        } : {
            '0->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
            '1->2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
            '2->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
            '3->0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]
        }

        const kickTableCCW = isI ? {
            '0->3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
            '3->2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
            '2->1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
            '1->0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]
        } : {
            '0->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
            '3->2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
            '2->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
            '1->0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
        }
        const key = `${from}->${to}`
        const table = rotDir === 1 ? kickTableCW[key] : kickTableCCW[key]

        if (!table) return false

        for (let i = 0; i < table.length; i++) {
            const [dx, dy] = table[i];
            // 「回転後の形状でキックオフセット(dx,-dy)を加算した位置」を検証する
            // rotDir で回転、moveX/moveY でキックを別々に渡す
            if (this.validRotated(rotDir, dx, -dy)) {
                if (rotDir === 1) this.mino.rotate()
                else this.mino.rotateCCW()

                this.mino.x += dx
                this.mino.y += -dy
                this.mino.rotation = to

                // T-spin判定用フラグを記録
                // キックテーブルの5番目（index=4）がPoint 5（井戸抜け用）
                this.lastRotUsedPoint5 = (i === 4);
                this.lastActionWasRotation = true;
                // 回転後の位置がT-spin判定になる場合は専用SE（人間・CPU共通）。
                // silent（CPUのパス再生中）はSEを抑止する。
                if (!silent) {
                    this.playSe(this.checkTSpin() !== null ? 'tspin_rot' : 'rotate');
                }
                return true
            }
        }
        return false
    },

    // 回転後にキックオフセットを加えた位置が有効かどうかを検証
    // （valid/getNewBlocks とは独立した専用メソッド）
    validRotated(rotDir, kickX, kickY) {
        const pivot = this.mino.pivot
        const newBlocks = this.mino.blocks.map(block => {
            // 1. pivot 基準で回転
            let relX = block.x - pivot.x
            let relY = block.y - pivot.y
            let rx, ry
            if (rotDir === 1) {
                rx = -relY
                ry = relX
            } else {
                rx = relY
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
    },

    // ホールド
    holdCurrentMino() {
        if (!this.canHold) return
        // VS設定：HOLDが無効な場合はホールド操作を受け付けない
        if (this.isVersusMode && this.vsHoldEnabled === false) return
        this.canHold = false
        this.playSe('hold')

        if (this.holdMino === null) {
            this.holdMino = new Mino()
            this.holdMino.type = this.mino.type
            this.holdMino.initBlocks()
            this.popMino()
            this.canHold = false
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
            ホールドから出した時の致命判定とタイマーリセット
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

            if (this.lockTimer) {
                clearTimeout(this.lockTimer);
                this.lockTimer = null;
            }
            this.startGravity();
        }
        // オンライン対戦: ホールド内容を相手へ通知
        if (window.OnlineHooks) window.OnlineHooks.tetHold(this);
        this.drawAll()
    },

    // ─────────────────────────────────────────
    // T-spin判定（ガイドライン 9.1 準拠）
    // 戻り値: 'tspin' | 'mini' | null
    // ─────────────────────────────────────────
    checkTSpin() {
        // T型（type=2）以外は対象外
        if (this.mino.type !== 2) return null;
        // 直前のアクションが回転でなければ対象外
        if (!this.lastActionWasRotation) return null;

        // T型ミノのピボット（中心マス）のフィールド座標
        // ピボットは blocks 定義上 {x:1, y:2}、ミノ位置を加算したワールド座標
        const cx = this.mino.x + this.mino.pivot.x - 0.5; // セル左上基準に変換
        const cy = this.mino.y + this.mino.pivot.y - 0.5;
        // ピボットの中心セル座標（floor で整数化）
        const px = Math.round(cx);
        const py = Math.round(cy);

        // 斜め4隅の座標を調べる
        //  (-1,-1) (+1,-1)
        //  (-1,+1) (+1,+1)
        const corners = [
            { x: px - 1, y: py - 1 }, // 左上
            { x: px + 1, y: py - 1 }, // 右上
            { x: px - 1, y: py + 1 }, // 左下
            { x: px + 1, y: py + 1 }, // 右下
        ];

        // 各隅が「埋まっているか」を判定。
        // 壁（左右）・床（下）の場外は埋まり扱いだが、フィールド上方（y<0）は
        // ミノの出現領域＝開いた空間なので埋まり扱いにしない。これを埋まりにすると、
        // スポーン直後（y=-2）など高い位置で回転した際に上2隅が常に埋まり判定となり、
        // 実際には3隅を満たしていない空中でT-spin成立と誤判定して tspin_rot が鳴る。
        const occupied = corners.map(c =>
            c.x < 0 || c.x >= COLS_COUNT || c.y >= ROWS_COUNT
            || this.field.has(c.x, c.y)
        );
        // occupied[0]=左上, [1]=右上, [2]=左下, [3]=右下

        // ─── 向きに応じてA/B面・C/D面を割り当てる ───
        // ガイドライン図（Page 22）に基づく：
        //   North: A=左上[0], B=右上[1],  C=左下[2], D=右下[3]
        //   East:  A=右上[1], B=右下[3],  C=左上[0], D=左下[2]
        //   South: A=右下[3], B=左下[2],  C=右上[1], D=左上[0]
        //   West:  A=左下[2], B=左上[0],  C=右下[3], D=右上[1]
        let abIdx, cdIdx;
        switch (this.mino.rotation) {
            case 0: // North
                abIdx = [0, 1]; cdIdx = [2, 3]; break;
            case 1: // East
                abIdx = [1, 3]; cdIdx = [0, 2]; break;
            case 2: // South
                abIdx = [3, 2]; cdIdx = [1, 0]; break;
            case 3: // West
                abIdx = [2, 0]; cdIdx = [3, 1]; break;
            default:
                return null;
        }

        const abFilled = abIdx.filter(i => occupied[i]).length; // A・B側の埋まり数
        const cdFilled = cdIdx.filter(i => occupied[i]).length; // C・D側の埋まり数

        // ─── 3隅ルールを最優先で評価する ───
        // Point 5（lastRotUsedPoint5）は T-Spin を保証するものではなく、
        // あくまで「Mini にならない（Mini を T-Spin に昇格させる）」ためのフラグ。
        // 3隅条件を満たさなければ Point 5 使用でも null。

        // A・B側2隅 + C・D側1隅以上 → T-Spin
        if (abFilled === 2 && cdFilled >= 1) {
            return 'tspin';
        }

        // C・D側2隅 + A・B側1隅以上 → 本来 Mini。
        // ただし Point 5 を使った回転なら Mini を T-Spin に昇格させる。
        if (cdFilled === 2 && abFilled >= 1) {
            return this.lastRotUsedPoint5 ? 'tspin' : 'mini';
        }

        return null;
    },
});

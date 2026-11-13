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
    //
    // SRS のキックテーブルは最大5回試行されるため、validRotated は1フレに
    // 最大5回呼ばれる。旧実装は毎回 Array.map で {x,y} を4個生成していた。
    // 配列確保とクロージャを廃して直接ループ＆早期 return に書き換える。
    validRotated(rotDir, kickX, kickY) {
        const pivot = this.mino.pivot
        const px = pivot.x
        const py = pivot.y
        const mx = this.mino.x + kickX
        const my = this.mino.y + kickY
        const blocks = this.mino.blocks
        const field = this.field
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i]
            const relX = b.x - px
            const relY = b.y - py
            let rx, ry
            if (rotDir === 1) { rx = -relY; ry = relX }
            else              { rx =  relY; ry = -relX }
            const wx = Math.round(rx + px) + mx
            const wy = Math.round(ry + py) + my
            if (wx < 0 || wx >= COLS_COUNT) return false
            if (wy < -5 || wy >= ROWS_COUNT) return false
            if (field.has(wx, wy)) return false
        }
        return true
    },

    // ─────────────────────────────────────────
    // 出現（先行回転 IRS・先行ホールド IHS）
    // 設計: source_assets/memory/tet_zone/tetlabo-irs-ihs-design.md
    // 設定が OFF（_irsOn / _ihsOn が false）のときは、今までの「出現位置 → だめなら 1 段上」と同じ動き。
    // ─────────────────────────────────────────

    // このモードでホールドが使えるか（1 手 1 回の canHold は見ない。出現のたびに戻るため）
    _holdAllowed() {
        if (this.holdDisabled) return false                                   // QUIZ・ONLINE の HOLD なし
        if (this.isVersusMode && this.vsHoldEnabled === false) return false   // VS 設定
        if (this.practiceHoldMode === 'off') return false                     // PRACTICE 設定パネル
        return true
    },

    // 先行回転の向き（1=右 / -1=左 / 0=なし）。両方押しているときは回さない
    _irsDir() {
        if (!this._irsOn || !this.keyState) return 0
        const cw = !!this.keyState.rotateCW
        const ccw = !!this.keyState.rotateCCW
        if (cw === ccw) return 0
        return cw ? 1 : -1
    },

    // mino が今の位置で盤面と重ならないか（this.mino でなくてもよい。範囲は valid と同じ）
    _minoFits(mino) {
        const blocks = mino.blocks
        const field = this.field
        for (let i = 0; i < blocks.length; i++) {
            const x = blocks[i].x + mino.x
            const y = blocks[i].y + mino.y
            if (x < 0 || x >= COLS_COUNT) return false
            if (y < -5 || y >= ROWS_COUNT) return false
            if (field.has(x, y)) return false
        }
        return true
    },

    // mino を出現位置に置く。重なるなら 1 段上。どちらもだめなら false。
    //   rotDir=0  向き 0。だめなときは今までどおり 1 段上の位置のまま返す（終了時の絵に使う）
    //   rotDir≠0  キックなしで 1 回まわし、一番下の段が 20 段目（y=0）に来る高さにそろえる。
    //             だめなときは向き 0 に戻して返す
    _placeAtSpawn(mino, rotDir) {
        mino.spawn()
        if (rotDir) {
            if (rotDir === 1) mino.rotate()
            else mino.rotateCCW()
            mino.rotation = rotDir === 1 ? 1 : 3
            let bottom = -Infinity
            for (let i = 0; i < mino.blocks.length; i++) {
                if (mino.blocks[i].y > bottom) bottom = mino.blocks[i].y
            }
            mino.y = -bottom
        }
        if (this._minoFits(mino)) return true
        mino.y -= 1
        if (this._minoFits(mino)) return true
        if (rotDir) {
            mino.initBlocks()
            mino.spawn()
        }
        return false
    },

    // 判定だけ（盤面・ホールド・NEXT は変えない）: type のミノが rotDir の向きで出せるか
    _canSpawnWith(type, rotDir) {
        return this._placeAtSpawn(new Mino(type), rotDir)
    },

    // ミノを出す。出せたら true、出せなければ false（GAME OVER などの後始末は呼び出し側）。
    //   opts.allowIhs  先行ホールドを当ててよい出現か（プレイヤーのホールドで出るミノは false）
    // 先行ホールドが効いたかは this._spawnIhsUsed に残す。
    // PRACTICE の巻き戻しなど「ふつうに進んだのではない出現」は _noSpawnAssist を立てて呼ぶ（どちらも当てない）。
    // 非表示 DCD 明け（_spawnHideEnd）は this._spawnPlan に出し方（横のずれ・待ち中に押したホールド/回転）を置いて呼ぶ。
    _spawnMino(mino, opts) {
        const assist = !this._noSpawnAssist
        const plan = assist ? this._spawnPlan : null
        this._spawnPlan = null
        this._spawnIhsUsed = false

        // 先行ホールド: 押していれば必ずやる（その結果出せなくなっても戻さない）
        const ihsKey = !!(this._ihsOn && this.keyState && this.keyState.hold)
        if (assist && opts && opts.allowIhs && !this._spawnNoIhs
            && (ihsKey || (plan && plan.hold)) && this._holdAllowed()) {
            let out = null
            if (this.holdMino) {
                out = new Mino(this.holdMino.type)
            } else {
                const next = this.nextQueue[0]
                if (next && !next._quizDummy) {
                    out = this.nextQueue.shift()
                    this._refillNext()
                }
            }
            if (out) {
                this.holdMino = new Mino(mino.type)
                mino = out
                this._spawnIhsUsed = true
                this.playSe('hold')
            }
        }

        this.mino = mino

        // 先行回転: 回した向きを先に試し、だめなら向き 0
        let dir = assist ? this._irsDir() : 0
        if (!dir && plan && plan.rot) dir = plan.rot
        let ok
        if (dir && this._placeAtSpawn(mino, dir)) {
            // T-Spin の「直前が回転」には数えない
            this.lastActionWasRotation = false
            this.lastRotUsedPoint5 = false
            // このキーの「押した瞬間」は使い切った扱い（離して押し直すまで回らない）
            if (dir === 1) this._rotCWPressed = true
            else this._rotCCWPressed = true
            this.playSe('rotate')
            ok = true
        } else {
            ok = this._placeAtSpawn(mino, 0)
        }
        // 非表示 DCD 中に動かした横位置を引き継ぐ。入らなければ出現列の方へ 1 列ずつ戻す
        if (ok && plan && plan.dx) this._shiftSpawnX(mino, plan.dx)
        return ok
    },

    _shiftSpawnX(mino, dx) {
        const x0 = mino.x
        const step = dx > 0 ? -1 : 1
        for (let d = dx; d !== 0; d += step) {
            mino.x = x0 + d
            if (this._minoFits(mino)) return
        }
        mino.x = x0
    },

    // ─── 非表示 DCD（設計 §12。暴発対策）───
    // 置いた後の出現で、先行回転・先行ホールドのキーが押されたまま（＝前の操作の残りかもしれない）なら、
    // DCD_DELAY のあいだミノを出さずに待つ（ミノは「まだ出ていない」扱い。重力・固定・ソフトドロップは止まる。
    // 入力は受け付ける）。
    //   DCD 明け          → その時点で押しているキーで先行回転・先行ホールドを当てて出す（出現位置が上がる利点を残す）
    //   残りのキーを全部離した → すぐ出す（離したキーは当てない）
    //   単発の横移動       → 隠れたミノを内部で動かす（出すときに引き継ぐ）
    //   ハードドロップ     → その時点のキーで出し、1 フレーム見せてから落とす（_spawnDropMino）
    //   ホールド・回転を新しく押した → 予約して、出すときに当てる
    // すぐ当てる（待たない）のは: 出せない（致命）とき・DCD が 0・開始の最初のミノ・プレイヤーのホールドで出るミノ。
    // 待ち明けは popMino をもう一度呼ぶ（IHS の待ちと同じく _ihsRescueResume を立てる。外側のフックは二重にしない）
    _spawnHideStart() {
        if (this._ihsRescueResume || this._noSpawnAssist || this._spawnNoIhs) return false
        if (!(this.DCD_DELAY > 0) || this._dcdMino === undefined || !this.keyState) return false
        const cur = this.nextQueue[0]
        if (!cur || cur._quizDummy) return false
        const rot = this._irsDir()
        const hold = !!(this._ihsOn && this.keyState.hold && this._holdAllowed())
        if (!rot && !hold) return false
        // 致命（向き 0 で出せない）は今までどおりすぐ当てる
        if (!this._canSpawnWith(cur.type, 0)) return false

        this._cancelLockTimer()
        if (this.timer) { clearInterval(this.timer); this.timer = null }
        this.mino = null
        this.isGrounded = false
        // rot / hold: 残っているキー（離したら 0 / false）。forceRot / forceHold: 待ち中に新しく押した分
        this._spawnHide = { type: cur.type, rot, hold, dx: 0, forceRot: 0, forceHold: false }
        this._spawnHideTimer = this.clock.schedule(this.DCD_DELAY, () => {
            this._spawnHideTimer = null
            this._spawnHideEnd()
        })
        this.requestRedraw()
        return true
    },

    // 非表示 DCD を終えてミノを出す
    _spawnHideEnd() {
        const h = this._spawnHide
        if (!h) return
        this._spawnHide = null
        if (this._spawnHideTimer) {
            this.clock.cancel(this._spawnHideTimer)
            this._spawnHideTimer = null
        }
        if (this.mino) return
        this._spawnPlan = { dx: h.dx, hold: h.forceHold, rot: h.forceRot }
        this._ihsRescueResume = true
        try { this.popMino() } finally { this._ihsRescueResume = false; this._spawnPlan = null }
        this.requestRedraw()
    },

    // 非表示 DCD 中のハードドロップ: その時点のキーで出して、1 フレーム見せてから落とす（_pollInput の頭）
    _spawnHideDrop() {
        this._spawnHideEnd()
        if (this.mino) this._spawnDropMino = this.mino
    },

    // 非表示 DCD 中にホールドを新しく押した → 先行ホールドとして予約（出すときに当てる）
    _spawnHideHold() {
        if (this._holdAllowed()) this._spawnHide.forceHold = true
    },

    // 隠れたミノ（向き 0・出現位置から dx 列）が入るか
    _spawnHideFits(h, dx) {
        const vm = new Mino(h.type)
        if (!this._placeAtSpawn(vm, 0)) return false
        vm.x += dx
        return this._minoFits(vm)
    },

    // 非表示 DCD 中の毎フレームの処理（_pollInput から。キーの取り込みの後）
    _pollSpawnHide(now) {
        const h = this._spawnHide
        const ks = this.keyState
        if ((h.rot === 1 && !ks.rotateCW) || (h.rot === -1 && !ks.rotateCCW)) h.rot = 0
        if (h.hold && !ks.hold) h.hold = false
        // 単発の横移動（押した瞬間＝lastMoveTime が 0 の印。applyKeyDown がミノのないときに付ける）
        const sides = [['left', -1], ['right', 1]]
        for (let i = 0; i < sides.length; i++) {
            const side = sides[i][0]
            const pressT = side === 'left' ? this._leftPressTime : this._rightPressTime
            const last = side === 'left' ? this._lastMoveTimeLeft : this._lastMoveTimeRight
            if (pressT === null || last !== 0) continue
            if (this._spawnHideFits(h, h.dx + sides[i][1])) {
                h.dx += sides[i][1]
                this.playSe('move')
            }
            this._setLastMoveTime(side, now)
        }
        // 残っていたキーを全部離したらすぐ出す
        if (!h.rot && !h.hold) this._spawnHideEnd()
    },

    // IHS で助かるときの入力猶予（設計 §3.2・独自ルール）。待つと決めたら予約して true を返す。
    //   待つのは: IHS が ON・ホールドが使える・いま押しているキーのままだと出せない・
    //             IHS で出てくるミノなら（向き 0、IRS が ON なら左右の回転でも）出せる、のとき。
    //   回転だけで助かる場合は待たない。待ち明けは popMino をもう一度呼ぶ（1 回の出現で待つのは 1 回）。
    _ihsRescueWait() {
        if (!this._ihsOn || this._noSpawnAssist || this._spawnNoIhs || this._ihsRescueResume) return false
        if (!this.keyState || !this._holdAllowed()) return false
        const cur = this.nextQueue[0]
        if (!cur || cur._quizDummy) return false
        // IHS で出てくるミノ（ホールドにあるミノ。空なら NEXT の次）
        let outType = null
        if (this.holdMino) {
            outType = this.holdMino.type
        } else {
            const next = this.nextQueue[1]
            if (next && !next._quizDummy) outType = next.type
        }
        if (outType === null) return false

        // いま押しているキーのままで出せるなら待たない
        const dir = this._irsDir()
        const typeNow = this.keyState.hold ? outType : cur.type
        if ((dir && this._canSpawnWith(typeNow, dir)) || this._canSpawnWith(typeNow, 0)) return false

        // IHS（＋IRS）なら出せるか
        const rescued = this._canSpawnWith(outType, 0)
            || (this._irsOn && (this._canSpawnWith(outType, 1) || this._canSpawnWith(outType, -1)))
        if (!rescued) return false

        // 待つ: その間ミノはいない（重力・固定は動かない。TIME やおじゃまの猶予は止めない）
        this._cancelLockTimer()
        if (this.timer) { clearInterval(this.timer); this.timer = null }
        this.mino = null
        this.isGrounded = false
        // ゲーム時計の予約（固定猶予と同じ。ポーズ中は時計が止まるので進まない）
        this._ihsRescueTimer = this.clock.schedule(IHS_RESCUE_DELAY_MS, () => {
            this._ihsRescueTimer = null
            if (this.mino) return
            // その時点のキーで出現をやり直す。外側のフック（PRACTICE・QUIZ・ONLINE）は
            // _ihsRescueResume を見て、出現前の処理を二重にしない
            this._ihsRescueResume = true
            try { this.popMino() } finally { this._ihsRescueResume = false }
            this.requestRedraw()
        })
        this.requestRedraw()
        return true
    },

    // ホールド
    holdCurrentMino() {
        // PRACTICE設定パネル：HOLDがFREEのときは1手1回の制約を外す
        const practiceFreeHold = this.practiceHoldMode === 'free'
        if (!this.canHold && !practiceFreeHold) return
        // VS設定：HOLDが無効な場合はホールド操作を受け付けない
        if (this.isVersusMode && this.vsHoldEnabled === false) return
        // PRACTICE設定パネル：HOLDがOFFのときは操作を受け付けない（中身は破棄せず保持）
        if (this.practiceHoldMode === 'off') return
        this.canHold = false
        this.playSe('hold')

        if (this.holdMino === null) {
            this.holdMino = new Mino(this.mino.type)
            // いまホールドしたところなので、出てくるミノに先行ホールドは当てない（先行回転は当たる）
            this._spawnNoIhs = true
            try { this.popMino() } finally { this._spawnNoIhs = false }
            this.canHold = false
        } else {
            let prevHoldType = this.holdMino.type
            this.holdMino = new Mino(this.mino.type)

            /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            ホールドから出した時の致命判定とタイマーリセット
            （出現位置 → 1 段上。先行回転が ON なら回した向きを先に試す）
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
            if (!this._spawnMino(new Mino(prevHoldType), { allowIhs: false })) {
                // ZONE の発動中は終わらせて盤面を下げ、出し直す（tet/zone.js）
                if (!this._zoneRespawnAfterTopOut()) {
                    this.gameOver();
                    return;
                }
            }

            // 状態・タイマー・カウントの初期化（popMinoと同じにする）
            this.isGrounded = false;
            this.lowestY = this.mino.y;
            this.moveCount = 0;

            this._cancelLockTimer();
            this.startGravity();
        }
        this.requestRedraw();
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

// ─────────────────────────────────────────────
// puyo/connect.js  ―  PuyoGame.prototype mixin
// 連結描画ヘルパー
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

Object.assign(PuyoGame.prototype, {

    // ══════════════════════════════════════════════
    // ★ 連結描画ヘルパー
    // ══════════════════════════════════════════════

    /**
     * フィールド座標 (c, r) のぷよが盤面固定されている（連結表示が有効な）状態かどうかを返す
     * 有効：checkErase / erasing / eraseWait（盤面静止中・消去点滅中）
     * 無効：falling / splitting / fixAnim / fixWait5f / dropping / spawnAnim / spawn（操作中・落下中・振動中）
     */
    _isConnectMode() {
        return (
            this._gs === 'checkErase' ||
            this._gs === 'erasing' ||
            this._gs === 'eraseWait' ||
            this._gs === 'dropping'   // ★ 消去後の落下アニメ中（宙浮き期間）も連結有効
        );
    },

    /**
     * フィールド座標 (c, r) のぷよについて上下左右の同色隣接を調べ、
     * 連結画像キー（例: 'puyo-1_2a'）と回転角（ラジアン）を返す。
     * 連結画像を使用しない場合は null を返す。
     *
     * 画像の初期配置（基準方向）: 右向き (x+ 方向)
     * 回転方向: 時計回り（canvas の rotate は時計回りが正）
     *
     * @param {number} c - フィールド列（0〜cols-1）
     * @param {number} r - フィールド行（表示用 0〜rows-1）
     * @param {number} color - ぷよの色（1〜5、6=おじゃまは対象外）
     * @param {boolean} isVibrating - 振動アニメ中かどうか
     * @returns {{ key: string, angle: number } | null}
     */
    _getConnectImageInfo(c, r, color, isVibrating) {
        // ★ 修正：_isConnectMode()の条件を外し、盤面に固定されているぷよは常に連結表示させるようにしました。
        // おじゃまぷよ(color=6)・振動中は連結画像を使わない
        // if (color === 6 || isVibrating || !this._isConnectMode()) return null;
        if (color === 6 || isVibrating) return null;

        const fr = r + PConfig.hiddenRows; // field 配列インデックス

        // 各方向に同色のぷよが隣接しているか判定
        // right=右(+c), down=下(+r), left=左(-c), up=上(-r)
        const checkSame = (dc, dr) => {
            const nc = c + dc;
            const nr = fr + dr;
            if (nc < 0 || nc >= PConfig.cols) return false;
            if (nr < PConfig.hiddenRows || nr >= PConfig.rows + PConfig.hiddenRows) return false;
            if (this.field[nr][nc] !== color) return false;
            // ★ 隣のセルが振動アニメ中（設置直後）なら連結を待機する
            // 　 自分が振動中でないのに隣が振動中の場合、タイミングをそろえるため連結しない
            const neighborIsVibrating = this.activeAnims.some(a => a.fr === nr && a.c === nc);
            if (neighborIsVibrating) return false;
            return true;
        };

        const R = checkSame(1, 0); // 右
        const D = checkSame(0, 1); // 下
        const L = checkSame(-1, 0); // 左
        const U = checkSame(0, -1); // 上

        const count = (R ? 1 : 0) + (D ? 1 : 0) + (L ? 1 : 0) + (U ? 1 : 0);
        const imageIndex = color - 1;

        if (count === 0) {
            // 単体 → 通常画像（連結なし）
            return null;
        }

        if (count === 4) {
            // 全方向連結
            return { key: `puyo-${imageIndex}_4`, angle: 0 };
        }

        if (count === 3) {
            // 3方向連結：欠けている方向が画像の「後ろ」になるよう回転
            // 画像基準：右+上+下（左が欠け）→ 欠け=左のとき angle=0
            // 欠け=下のとき、基準画像を反時計回り90° (右+左+上)
            // 欠け=右のとき 180°
            // 欠け=上のとき 270°
            let angle = 0;
            if (!L) angle = 0;           // 欠け=左
            else if (!U) angle = Math.PI / 2; // 欠け=上
            else if (!R) angle = Math.PI;     // 欠け=右
            else angle = -Math.PI / 2;// 欠け=下
            return { key: `puyo-${imageIndex}_3`, angle };
        }

        if (count === 2) {
            if ((R && L) || (U && D)) {
                // 直線2方向 (2b): 左右 or 上下
                // 画像基準：上下接続（垂直）→ angle=0
                const angle = (L && R) ? Math.PI / 2 : 0;
                return { key: `puyo-${imageIndex}_2b`, angle };
            } else {
                // 直角2方向 (2a): 4パターン
                // 画像基準：右+上（右下コーナー）→ angle=0
                let angle = 0;
                if (R && U) angle = 0;            // 右+上
                else if (D && R) angle = Math.PI / 2;  // 下+右
                else if (L && D) angle = Math.PI;      // 左+下
                else angle = -Math.PI / 2; // 上+左
                return { key: `puyo-${imageIndex}_2a`, angle };
            }
        }

        if (count === 1) {
            // 1方向連結：画像基準=上向き
            let angle = 0;
            if (U) angle = 0;            // 上
            else if (R) angle = Math.PI / 2;  // 右
            else if (D) angle = Math.PI;      // 下
            else angle = -Math.PI / 2; // 左
            return { key: `puyo-${imageIndex}_1`, angle };
        }

        return null;
    },

    /**
     * ★ 宙に浮いているぷよ（_dropAnim内）の連結画像情報取得
     * eraseWait中のみ元の座標（fromR, c）を参照して連結を維持し、droppingになったら連結を切る
     */
    _getDropConnectImageInfo(targetC, targetFromR, color) {
        if (color === 6 || this._gs !== 'eraseWait') return null;

        const checkSame = (dc, dr) => {
            const nc = targetC + dc;
            const nr = targetFromR + dr;

            if (!this._dropAnim) return false;
            const colData = this._dropAnim.find(col => col.c === nc);
            if (!colData) return false;
            const cell = colData.cells.find(c => c.fromR === nr);
            if (!cell) return false;
            return cell.color === color;
        };

        const R = checkSame(1, 0); // 右
        const D = checkSame(0, 1); // 下
        const L = checkSame(-1, 0); // 左
        const U = checkSame(0, -1); // 上

        const count = (R ? 1 : 0) + (D ? 1 : 0) + (L ? 1 : 0) + (U ? 1 : 0);
        const imageIndex = color - 1;

        if (count === 0) return null;

        if (count === 4) return { key: `puyo-${imageIndex}_4`, angle: 0 };

        if (count === 3) {
            let angle = 0;
            if (!L) angle = 0;
            else if (!U) angle = Math.PI / 2;
            else if (!R) angle = Math.PI;
            else angle = -Math.PI / 2;
            return { key: `puyo-${imageIndex}_3`, angle };
        }

        if (count === 2) {
            if ((R && L) || (U && D)) {
                const angle = (L && R) ? Math.PI / 2 : 0;
                return { key: `puyo-${imageIndex}_2b`, angle };
            } else {
                let angle = 0;
                if (R && U) angle = 0;
                else if (D && R) angle = Math.PI / 2;
                else if (L && D) angle = Math.PI;
                else angle = -Math.PI / 2;
                return { key: `puyo-${imageIndex}_2a`, angle };
            }
        }

        if (count === 1) {
            let angle = 0;
            if (U) angle = 0;
            else if (R) angle = Math.PI / 2;
            else if (D) angle = Math.PI;
            else angle = -Math.PI / 2;
            return { key: `puyo-${imageIndex}_1`, angle };
        }

        return null;
    },
});

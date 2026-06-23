// ─────────────────────────────────────────────
// puyo/connect.js  ―  PuyoGame.prototype mixin
// 連結描画ヘルパー
// ※ core.js（class PuyoGame 定義）より後に読み込むこと
// ─────────────────────────────────────────────

// ★ 連結画像キー文字列の事前計算テーブル（6色 × 5パターン）。
//   毎フレーム毎ぷよで `puyo-${i}_2a` のようなテンプレート文字列を生成すると
//   膨大な使い捨て文字列＝GC churn になるため、起動時に一度だけ作って使い回す。
const CONNECT_KEYS = (() => {
    const t = [];
    for (let i = 0; i < 6; i++) {
        t[i] = {
            _4: 'puyo-' + i + '_4',
            _3: 'puyo-' + i + '_3',
            _2b: 'puyo-' + i + '_2b',
            _2a: 'puyo-' + i + '_2a',
            _1: 'puyo-' + i + '_1',
        };
    }
    return t;
})();

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
    // ★ 隣接セル (nc, nr=field行) が同色かつ連結対象かを判定。
    //   旧 checkSame クロージャは呼び出しごとに新規関数オブジェクトを生成し
    //   毎フレーム×ぷよ数だけ GC churn の原因になっていたため、引数渡しの
    //   通常メソッドに外出しした（メソッド呼び出しはアロケーションを伴わない）。
    _connSame(nc, nr, color, cols, hidden, maxR) {
        if (nc < 0 || nc >= cols) return false;
        if (nr < hidden || nr >= maxR) return false;
        if (this.field[nr][nc] !== color) return false;
        // ★ 隣が振動アニメ中（設置直後）なら連結を待機（タイミングをそろえる）。
        //   _render が毎フレーム構築する _animMap で O(1) 判定。
        if (this._animMap) return !this._animMap.has(nr * cols + nc);
        return !this.activeAnims.some(a => a.fr === nr && a.c === nc);
    },

    _getConnectImageInfo(c, r, color, isVibrating) {
        // ★ 修正：_isConnectMode()の条件を外し、盤面に固定されているぷよは常に連結表示させるようにしました。
        // おじゃまぷよ(color=6)・振動中は連結画像を使わない
        if (color === 6 || isVibrating) return null;

        const fr = r + PConfig.hiddenRows; // field 配列インデックス
        const cols = PConfig.cols;
        const hidden = PConfig.hiddenRows;
        const maxR = PConfig.rows + hidden;

        // 各方向に同色のぷよが隣接しているか判定
        // right=右(+c), down=下(+r), left=左(-c), up=上(-r)
        const R = this._connSame(c + 1, fr, color, cols, hidden, maxR); // 右
        const D = this._connSame(c, fr + 1, color, cols, hidden, maxR); // 下
        const L = this._connSame(c - 1, fr, color, cols, hidden, maxR); // 左
        const U = this._connSame(c, fr - 1, color, cols, hidden, maxR); // 上

        const count = (R ? 1 : 0) + (D ? 1 : 0) + (L ? 1 : 0) + (U ? 1 : 0);
        if (count === 0) {
            // 単体 → 通常画像（連結なし）
            return null;
        }

        const keys = CONNECT_KEYS[color - 1];
        // ★ 戻り値オブジェクトはインスタンスで使い回す（呼び出し側 _drawPuyo が
        //   同期的に key/angle を読むため、次の呼び出しまで生存していれば十分）。
        const buf = this._ciBuf || (this._ciBuf = { key: '', angle: 0 });

        if (count === 4) {
            // 全方向連結
            buf.key = keys._4; buf.angle = 0;
            return buf;
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
            buf.key = keys._3; buf.angle = angle;
            return buf;
        }

        if (count === 2) {
            if ((R && L) || (U && D)) {
                // 直線2方向 (2b): 左右 or 上下
                // 画像基準：上下接続（垂直）→ angle=0
                buf.key = keys._2b; buf.angle = (L && R) ? Math.PI / 2 : 0;
                return buf;
            } else {
                // 直角2方向 (2a): 4パターン
                // 画像基準：右+上（右下コーナー）→ angle=0
                let angle = 0;
                if (R && U) angle = 0;            // 右+上
                else if (D && R) angle = Math.PI / 2;  // 下+右
                else if (L && D) angle = Math.PI;      // 左+下
                else angle = -Math.PI / 2; // 上+左
                buf.key = keys._2a; buf.angle = angle;
                return buf;
            }
        }

        // count === 1
        // 1方向連結：画像基準=上向き
        let angle = 0;
        if (U) angle = 0;            // 上
        else if (R) angle = Math.PI / 2;  // 右
        else if (D) angle = Math.PI;      // 下
        else angle = -Math.PI / 2; // 左
        buf.key = keys._1; buf.angle = angle;
        return buf;
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

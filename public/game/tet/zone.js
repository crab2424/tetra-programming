// ─────────────────────────────────────────────
// tet/zone.js  ―  Game.prototype mixin
// ZONE（ライン消去でメーターをため、発動中は消したラインが底へたまる。時間切れで一気に消える）
// 設計: source_assets/memory/tet_zone/tetlabo-zone-design.md
// ※ core.js（class Game 定義）より後に読み込むこと
//
// エンジンには「ZONE という能力」として足す（zoneEnabled が false なら、ここの処理は何も通らない）。
// 時間は全部ゲーム時計（clock.schedule / clock.now）。ポーズ・録画の再生・シークがそのまま効く。
// 終了の演出は描画だけ（エンジンは即時に盤面を下げる。§4.5・Q5）。
// ─────────────────────────────────────────────

const ZONE_QUARTER_LINES_SINGLE = 8;   // シングル: 8 ラインで 1/4（原作の Zone Marathon）。既定値
const ZONE_MS_PER_QUARTER = 5000;      // 1/4 の長さ（満タン 20 秒）。既定値
// 準備画面で選べる値（設計 Q4。既定は上の仮決め）。外から zoneQuarterLinesSetting / zoneQuarterMsSetting で渡す
const ZONE_QUARTER_LINES_OPTIONS = [3, 6, 8, 10, 12];
const ZONE_QUARTER_MS_OPTIONS = [2500, 4000, 5000, 8000, 10000];
const ZONE_TIERS = [4, 8, 12, 16, 18, 20]; // 段数の区切り（数字の色・終了の SE）
// 区切りごとの色（ZONE_TIERS 未満は先頭の色）
const ZONE_TIER_COLORS = ['#e0e0f0', '#71c5f5', '#5af5a0', '#f5e15a', '#f5a05a', '#fa71cd', '#ffffff'];
const ZONE_END_FX_MS = 700;            // 終了の光（描画だけ）

function zoneTierIndex(lines) {
    let i = 0;
    while (i < ZONE_TIERS.length && lines >= ZONE_TIERS[i]) i++;
    return i; // 0 = 4 未満、6 = 20 以上
}

Object.assign(Game.prototype, {

    // 試合の頭（_initGameState）で呼ぶ。終了の予約も取り消す
    _zoneInit() {
        if (this._zoneTimer) this.clock.cancel(this._zoneTimer);
        this._zoneTimer = null;
        // いまはモード ZONE だけ。VERSUS などで使うときはここで立てる（§3）
        this.zoneEnabled = (this.mode === 'zone');
        // 1/4 に必要なライン数・1/4 の長さ（準備画面の設定。未設定・範囲外は既定値）
        this.zoneQuarterLines = ZONE_QUARTER_LINES_OPTIONS.includes(this.zoneQuarterLinesSetting)
            ? this.zoneQuarterLinesSetting : ZONE_QUARTER_LINES_SINGLE;
        this.zoneQuarterMs = ZONE_QUARTER_MS_OPTIONS.includes(this.zoneQuarterMsSetting)
            ? this.zoneQuarterMsSetting : ZONE_MS_PER_QUARTER;
        this.zoneMeter = 0;          // たまったライン数（端数も持つ）
        this.zoneActive = false;
        this.zoneLines = 0;          // 発動中に底へ移した段数
        this.zoneCharge = 0;         // 発動時の 1/4 の数
        this.zoneTimeUp = false;     // 時間は切れたが、いまのミノを置くまで続いている（シングル）
        this.zoneStartAt = 0;
        this.zoneDurationMs = 0;
        this.zoneScorePool = 0;      // 発動中にためた点（終了時に倍率をかけて足す）
        this.zoneLinesTotal = 0;     // 1 局の ZONE 段の合計（lines とは別に数える。§5.4）
        this.zoneBest = 0;           // 1 回の最大
        this.zoneCount = 0;          // 発動した回数
        this._zoneFx = null;         // 終了の光（描画だけ。実時間）
        this._zoneHudSig = null;
        this._zoneHideEndPopup();
        this._zoneSyncHud(true);
    },

    zoneQuarters() {
        return Math.floor(this.zoneMeter / this.zoneQuarterLines);
    },

    // ライン消去でメーターをためる（発動中は足さない。T-Spin などの上乗せはなし。§4.1）
    _zoneAddMeter(n) {
        if (!this.zoneEnabled || this.zoneActive || !(n > 0)) return;
        const before = this.zoneQuarters();
        this.zoneMeter = Math.min(this.zoneQuarterLines * 4, this.zoneMeter + n);
        // 1/4 たまったときは鳴らさない。満タンになったときだけ
        if (before < 4 && this.zoneQuarters() >= 4) this.playSe('zone_full');
    },

    canActivateZone() {
        return !!(this.zoneEnabled && !this.zoneActive && this.zoneQuarters() >= 1
            && this.mino && !this.isPaused && !this.isCountingDown);
    },

    // 発動（操作 zone・CPU は cpuAction('zone')）。発動できたら true
    activateZone() {
        if (!this.canActivateZone()) return false;
        const q = Math.min(4, this.zoneQuarters());
        this.zoneCharge = q;
        this.zoneDurationMs = q * this.zoneQuarterMs;
        this.zoneMeter -= q * this.zoneQuarterLines; // 端数は残して次へ持ち越す
        this.zoneLines = 0;
        this.zoneScorePool = 0;
        this.zoneTimeUp = false;
        this.zoneActive = true;
        this.zoneCount++;
        this.zoneStartAt = this.clock.now();
        this._zoneTimer = this.clock.schedule(this.zoneDurationMs, () => {
            this._zoneTimer = null;
            this._zoneOnTimeUp();
        });
        // 進んでいた固定猶予は取り消す（発動中はソフトドロップ中だけ固定猶予が進む。§4.4。
        // 押したままなら次のフレームの _applyGravityTick が始め直す）
        if (this.lockTimer) {
            this.clock.cancel(this.lockTimer);
            this.lockTimer = null;
        }
        this.moveCount = 0;
        this.playSe('zone_start');
        this._zoneSyncHud(true);
        this.requestRedraw();
        return true;
    },

    _zoneOnTimeUp() {
        if (!this.zoneActive) return;
        // VERSUS はその場で終わる（操作中のミノは持ち越す）。シングルはいまのミノを置くまで続く（§4.5）
        if (this.isVersusMode) {
            this._endZone('time');
            return;
        }
        this.zoneTimeUp = true;
        this._zoneSyncHud(true);
        this.requestRedraw();
    },

    // 残り時間（ms）
    zoneRemainingMs() {
        if (!this.zoneActive) return 0;
        return Math.max(0, this.zoneDurationMs - (this.clock.now() - this.zoneStartAt));
    },

    // 発動中の消去判定（§4.3）。そろった段は消さずに底へ移し、block.zone の印を付ける。
    // 見えている 20 段より上（y < 0）も見る（21 段以上のため）。下の段から順に処理する。戻り値はそろった段数
    _zoneCheckLine() {
        const field = this.field;
        const bs = field.blocks;
        let floorY = ROWS_COUNT - this.zoneLines; // ここから下は ZONE 段
        let minY = floorY;
        for (let i = 0; i < bs.length; i++) if (bs[i].y < minY) minY = bs[i].y;
        let n = 0;
        // 下から上へ。r の段を処理すると r より下（まだそろっていない段）が 1 段上がって r に来るだけなので、次は r-1 を見ればよい
        for (let r = floorY - 1; r >= minY; r--) {
            let c = 0;
            for (let i = 0; i < bs.length; i++) if (bs[i].y === r) c++;
            if (c < COLS_COUNT) continue;
            for (let i = 0; i < bs.length; i++) {
                const b = bs[i];
                if (b.y === r) {
                    b.y = floorY - 1;  // そろった段はそのまま底へ（色は元のまま）
                    b.zone = true;
                } else if (b.y > r && b.y < floorY) {
                    b.y -= 1;          // 消した段より下は 1 段上がる（上の段は動かない）
                }
            }
            floorY--;
            this.zoneLines++;
            n++;
        }
        if (n > 0) field.markDirty();
        return n;
    },

    // 発動中の PC: ZONE 段以外のブロックが 0 個（§4.3）
    _zoneIsPerfectClear() {
        const bs = this.field.blocks;
        for (let i = 0; i < bs.length; i++) if (!bs[i].zone) return false;
        return true;
    },

    // 終了（時間切れ・窒息）。reason: 'time' | 'topout'
    _endZone(reason) {
        if (!this.zoneActive) return;
        if (this._zoneTimer) { this.clock.cancel(this._zoneTimer); this._zoneTimer = null; }
        const n = this.zoneLines;
        const field = this.field;
        // 1. ZONE 段を消し、2. 残りを n 段下げる（操作中のミノは動かさない）
        if (n > 0) {
            field.blocks = field.blocks.filter(b => !b.zone);
            const bs = field.blocks;
            for (let i = 0; i < bs.length; i++) bs[i].y += n;
            field.markDirty();
        }
        // 3. スコア（§5.2）。lines・レベルは変えない（§5.4）
        const mult = 1 + (n >= 8 ? 1 : 0) + (this.zoneCharge === 4 ? 1 : 0);
        const bonus = Math.floor(this.zoneScorePool * mult) + n * 100;
        this.score += bonus;
        this.zoneLinesTotal += n;
        if (n > this.zoneBest) this.zoneBest = n;
        // 4. 状態を戻す
        this.zoneActive = false;
        this.zoneTimeUp = false;
        this.zoneLines = 0;
        this.zoneScorePool = 0;
        this.zoneCharge = 0;
        this.updateStatsDisplay();
        // 落下・固定をふだんに戻す（シングルはミノを置いた後か、出せなかったときなので mino は無い）
        if (this.mino) {
            if (this.valid(0, 1)) {
                this.isGrounded = false;
                this.startGravity();
            } else {
                this.isGrounded = true;
                if (!this.lockTimer) this.startLockTimer();
            }
        }
        // 録画の印（core/replay.js）
        if (this._rec && n > 0) this._rec._mark(this, 'attack', `ZONE ${n} LINES`, n);
        // 6. 表示・SE・演出（描画だけ）
        this.playSe(n >= 16 ? 'zone_end_big' : 'zone_end');
        this._zoneFx = { t: performance.now(), lines: n, reason };
        this._zoneShowEndPopup(n, bonus);
        this._zoneSyncHud(true);
        this.requestRedraw();
    },

    // 出現できなかった（窒息）。発動中なら ZONE を終わらせて、盤面が下がったら同じミノを出し直す。
    // 出し直せたら true（呼び出し側は GAME OVER にしない）。発動していない・盤面が下がらない・それでも出せないなら false
    _zoneRespawnAfterTopOut() {
        if (!this.zoneActive || !this.mino) return false;
        const lowered = this.zoneLines > 0;
        const mino = this.mino;
        this.mino = null; // 出せなかったミノは盤面に無い扱い（_endZone が落下・固定を始めないように）
        this._endZone('topout');
        this.mino = mino;
        if (!lowered) return false;
        // NEXT は進めない（いま出そうとしたミノをもう一度置く）。先行ホールドは済んでいるので二重にしない
        const ihsUsed = this._spawnIhsUsed;
        const ok = this._spawnMino(mino, { allowIhs: false });
        this._spawnIhsUsed = ihsUsed;
        return ok;
    },

    // ─── 画面（HUD）───
    // シングルの盤面だけ（対戦の盤面は VERSUS の段階で）。変わったときだけ DOM を書き換える
    _zoneHudEls() {
        if (this.isVersusMode || this.canvasPrefix) return null;
        if (!this._zoneEls) {
            this._zoneEls = {
                area: document.getElementById('zone-area'),
                segs: Array.from(document.querySelectorAll('#zone-meter .zone-seg-fill')),
                key: document.getElementById('zone-key'),
                sub: document.getElementById('zone-sub'),
                container: document.getElementById('container'),
            };
        }
        return this._zoneEls.area ? this._zoneEls : null;
    },

    _zoneSyncHud(force) {
        const els = this._zoneHudEls();
        if (!els) return;
        const on = !!this.zoneEnabled;
        let fills, sub, ready = false;
        if (!on) {
            fills = [0, 0, 0, 0];
            sub = '';
        } else if (this.zoneActive) {
            // 発動中はメーターがそのまま減っていく（1/4 = 5 秒）
            const rem = this.zoneRemainingMs();
            const per = this.zoneQuarterMs;
            fills = [0, 1, 2, 3].map(i => Math.max(0, Math.min(1, (rem - i * per) / per)));
            sub = this.zoneTimeUp ? 'LAST' : String(Math.ceil(rem / 1000));
        } else {
            // 見た目は 1/4 刻み（内部の端数は出さない。§6.1）
            const q = this.zoneQuarters();
            fills = [0, 1, 2, 3].map(i => (i < q ? 1 : 0));
            ready = q >= 1;
            sub = '';
        }
        const hot = this.zoneActive && this.zoneLines >= 8;
        const sig = `${on}|${this.zoneActive}|${ready}|${hot}|${sub}|${fills.map(f => Math.round(f * 200)).join(',')}`;
        if (!force && sig === this._zoneHudSig) return;
        this._zoneHudSig = sig;
        els.area.style.display = on ? '' : 'none';
        els.area.classList.toggle('is-ready', ready);
        els.area.classList.toggle('is-active', !!this.zoneActive);
        for (let i = 0; i < els.segs.length; i++) {
            els.segs[i].style.transform = `scaleX(${fills[i] || 0})`;
        }
        if (els.key) {
            const k = (typeof loadKeys === 'function') ? (loadKeys().zone || {}) : {};
            els.key.textContent = k.label || '';
        }
        if (els.sub) els.sub.textContent = sub;
        if (els.container) {
            els.container.classList.toggle('zone-active', on && !!this.zoneActive);
            els.container.classList.toggle('zone-hot', on && hot);
        }
    },

    // 盤面中央の「ZONE n LINES / +得点」（描画だけ）
    _zoneShowEndPopup(n, bonus) {
        if (this.isVersusMode || this.canvasPrefix) return;
        const el = document.getElementById('zone-end-popup');
        if (!el) return;
        const linesEl = el.querySelector('.zone-end-lines');
        const scoreEl = el.querySelector('.zone-end-score');
        if (linesEl) {
            linesEl.textContent = `ZONE ${n} LINES`;
            linesEl.style.color = ZONE_TIER_COLORS[zoneTierIndex(n)];
        }
        if (scoreEl) scoreEl.textContent = `+${bonus}`;
        el.classList.remove('show');
        void el.offsetWidth; // アニメをやり直す
        el.classList.add('show');
        clearTimeout(this._zonePopupTimer);
        this._zonePopupTimer = setTimeout(() => el.classList.remove('show'), 2200);
    },

    _zoneHideEndPopup() {
        clearTimeout(this._zonePopupTimer);
        if (this.isVersusMode || this.canvasPrefix) return;
        const el = document.getElementById('zone-end-popup');
        if (el) el.classList.remove('show');
    },

    // ─── 描画（render.js の drawAll から。盤面の座標系＝上に半段の余白を取った後で呼ぶ）───
    _zoneDrawField(ctx) {
        // ZONE 段の中央に段数
        if (this.zoneActive && this.zoneLines > 0) {
            const floorY = ROWS_COUNT - this.zoneLines;
            const top = Math.max(-0.5, floorY);
            const cy = ((top + ROWS_COUNT) / 2) * BLOCK_SIZE;
            const size = Math.min(72, Math.max(26, (ROWS_COUNT - top) * BLOCK_SIZE * 0.7));
            ctx.save();
            ctx.font = `900 ${size}px Orbitron, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 6;
            ctx.strokeStyle = 'rgba(10,10,15,0.85)';
            ctx.strokeText(String(this.zoneLines), SCREEN_WIDTH / 2, cy);
            ctx.fillStyle = ZONE_TIER_COLORS[zoneTierIndex(this.zoneLines)];
            ctx.fillText(String(this.zoneLines), SCREEN_WIDTH / 2, cy);
            ctx.restore();
        }
        // 終了の光（底から上へ消えていく。描画だけなので実時間）
        const fx = this._zoneFx;
        if (fx) {
            const k = (performance.now() - fx.t) / ZONE_END_FX_MS;
            if (k >= 1 || fx.lines <= 0) {
                this._zoneFx = null;
            } else {
                const rows = Math.min(ROWS_COUNT, fx.lines);
                const h = rows * BLOCK_SIZE;
                ctx.save();
                ctx.globalAlpha = (1 - k) * 0.75;
                const grad = ctx.createLinearGradient(0, ROWS_COUNT * BLOCK_SIZE - h * (1 + k), 0, ROWS_COUNT * BLOCK_SIZE);
                grad.addColorStop(0, 'rgba(255,255,255,0)');
                grad.addColorStop(1, 'rgba(255,255,255,1)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, ROWS_COUNT * BLOCK_SIZE - h * (1 + k), SCREEN_WIDTH, h * (1 + k));
                ctx.restore();
                this.requestRedraw();
            }
        }
    },

    // 枠の上（y < -0.5）に出たブロック・ミノを、盤面の上に重ねたキャンバスへ描く（§6.1・Q9）
    _zoneDrawAbove() {
        const cv = this._zoneTopCanvas();
        if (!cv) return;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (!this.zoneEnabled) return;
        // キャンバスの下端 = 盤面の y=-0.5（そこから下は盤面のキャンバスが描く）。y=-5〜-0.5 を受け持つ
        const oy = cv.height + VISIBLE_EXTRA_ROW_RATIO * BLOCK_SIZE; // y=0 の位置
        const draw = (x, y, img, alpha) => {
            if (y >= 0 || x < 0 || x >= COLS_COUNT) return;
            const py = oy + y * BLOCK_SIZE;
            if (py + BLOCK_SIZE <= 0) return;
            ctx.globalAlpha = alpha;
            ctx.drawImage(img, x * BLOCK_SIZE, py, BLOCK_SIZE, BLOCK_SIZE);
        };
        const bs = this.field.blocks;
        for (let i = 0; i < bs.length; i++) {
            const b = bs[i];
            if (b.y < 0) draw(b.x, b.y, b.image, 1);
        }
        if (this.mino) {
            const m = this.mino;
            if (this.showGhost !== false) {
                const gy = this.getGhostY();
                if (gy !== m.y) for (const b of m.blocks) draw(m.x + b.x, gy + b.y, b.image, 0.25);
            }
            for (const b of m.blocks) draw(m.x + b.x, m.y + b.y, b.image, 1);
        }
        ctx.globalAlpha = 1;
    },

    _zoneTopCanvas() {
        if (this.isVersusMode || this.canvasPrefix) return null;
        if (this._zoneTop === undefined) {
            const cv = document.getElementById('zone-top-canvas');
            if (cv) {
                cv.width = SCREEN_WIDTH;
                cv.height = 4.5 * BLOCK_SIZE;
            }
            this._zoneTop = cv || null;
        }
        return this._zoneTop;
    },
});

// ─────────────────────────────────────────────
// cpu4_estimate.js（着手予測オーバーレイ描画 / test モード）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _initEstimateContainer() … 予測表示用のオーバーレイ DOM を用意
//   _renderEstimatePlace()   … bestMoveData の 3 手先までを半透明ぷよで描画
//   _simulateDrop()          … 落下位置のシミュレート（描画用）
//   _createEstimatePuyo()    … 1 個分の予測ぷよ DOM を生成
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU4.prototype, {

    _initEstimateContainer() {
        const canvasId = this.game.canvasPrefix ? `${this.game.canvasPrefix}-puyo-main-canvas` : 'puyo-main-canvas';
        const canvas = document.getElementById(canvasId);
        if (!canvas || !canvas.parentNode) return;

        let containerId = `${canvasId}-estimate-overlay`;
        this.estimateContainer = document.getElementById(containerId);

        if (!this.estimateContainer) {
            this.estimateContainer = document.createElement('div');
            this.estimateContainer.id = containerId;
            this.estimateContainer.style.position = 'absolute';
            this.estimateContainer.style.top = '0';
            this.estimateContainer.style.left = '0';
            this.estimateContainer.style.width = '320px';
            this.estimateContainer.style.height = '656px';
            this.estimateContainer.style.pointerEvents = 'none';
            this.estimateContainer.style.zIndex = '15';
            this.estimateContainer.style.overflow = 'hidden';
            canvas.parentNode.appendChild(this.estimateContainer);
        }
    },

    _renderEstimatePlace() {
        if (!this.estimateContainer) this._initEstimateContainer();
        if (!this.estimateContainer) return;
        this.estimateContainer.innerHTML = '';

        if (!this.isActive || !this.bestMoveData || this.game.isVersusMode) return;

        const simField = Array.from({ length: 17 }, (_, r) => [...this.game.field[r]]);

        const steps = [
            { col: this.bestMoveData.col1, rot: this.bestMoveData.rot1, colors: [this.game.pivotColor, this.game.childColor], name: 'step1' },
            { col: this.bestMoveData.col2, rot: this.bestMoveData.rot2, colors: this.game.nextQueue[0] || [0,0], name: 'step2' },
            { col: this.bestMoveData.col3, rot: this.bestMoveData.rot3, colors: this.game.nextQueue[1] || [0,0], name: 'step3' }
        ];

        for (const step of steps) {
            if (step.col === -1) continue;

            const res = this._simulateDrop(simField, step.col, step.rot);
            if (!res) continue;

            this._createEstimatePuyo(res.pivotCol, res.pivotRow, step.colors[0], step.name);
            this._createEstimatePuyo(res.childCol, res.childRow, step.colors[1], step.name);

            simField[res.pivotRow][res.pivotCol] = step.colors[0];
            simField[res.childRow][res.childCol] = step.colors[1];
        }
    },

    _simulateDrop(field, pc, rot) {
        const DC = [0, 1, 0, -1];
        const cc = pc + DC[rot];

        if (pc < 0 || pc >= 6 || cc < 0 || cc >= 6) return null;

        const getDropRow = (c) => {
            for (let r = 16; r >= 0; r--) {
                if (field[r][c] === 0) return r;
            }
            return -1;
        };

        let pr, cr;
        if (rot === 0) {
            pr = getDropRow(pc);
            if (pr < 0) return null;
            cr = pr - 1;
            if (cr < 0 || field[cr][pc] !== 0) return null;
        } else if (rot === 2) {
            cr = getDropRow(pc);
            if (cr < 0) return null;
            pr = cr - 1;
            if (pr < 0 || field[pr][pc] !== 0) return null;
        } else {
            pr = getDropRow(pc);
            cr = getDropRow(cc);
            if (pr < 0 || cr < 0) return null;
        }

        return { pivotCol: pc, pivotRow: pr, childCol: cc, childRow: cr };
    },

    _createEstimatePuyo(col, row, color, stepClass) {
        if (row < 0 || col < 0 || col >= 6) return;

        const scaleX = 320 / 192;
        const scaleY = 656 / 384;

        const dispWidth = 32 * scaleX;
        const dispHeight = 32 * scaleY;

        const displayRow = row - 5;

        const opacityMap = { 'step1': 0.8, 'step2': 0.5, 'step3': 0.3 };
        const zIndexMap = { 'step1': '6', 'step2': '5', 'step3': '4' };

        const COLORS = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f'];
        const bgColor = COLORS[color - 1] || '#fff';

        const div = document.createElement('div');
        div.className = `cpu-estimate-puyo ${stepClass}`;
        div.style.position = 'absolute';

        div.style.width = `${dispWidth}px`;
        div.style.height = `${dispHeight}px`;
        div.style.left = `${col * dispWidth}px`;
        div.style.top = `${displayRow * dispHeight}px`;

        div.style.borderRadius = '50%';
        div.style.backgroundColor = bgColor;
        div.style.opacity = opacityMap[stepClass];
        div.style.zIndex = zIndexMap[stepClass];
        div.style.boxSizing = 'border-box';
        div.style.border = '2px solid rgba(255,255,255,0.5)';

        this.estimateContainer.appendChild(div);
    },
});

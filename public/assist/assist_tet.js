// ─────────────────────────────────────────────
// assist/assist_tet.js  ―  アシストの tet 側（計算 + 描画）
//   思考は LV7（clys 型探索）の worker（cpu/tet/lv7/wasm/cpu_worker7.js）と直接話す。
//   CPU7 クラスは使わない（TEST 専用の作りが多いため。設計 §4.1）。
//   LV7 は初手しか返さないので、1手ずつ盤面を進めて呼び直し、手の列を作る。
//   見えている NEXT だけを渡す（見えないツモを使った手順は出さない。設計 J2）。
//   操作の経路・回転の向きは自前の BFS（SRS キック込み。game/tet/rotation.js と同じ表）で求める。
// ─────────────────────────────────────────────

(function () {
    const COLS = 10, ROWS = 20, TOP = 5;           // 盤面は y=-5..19
    const BS = 32;                                  // 1マスのpx
    const WORKER_URL_FALLBACK = 'cpu/tet/lv7/wasm/cpu_worker7.js?v=1'; // CPU7.WORKER_URLS[0] と同じ値（再ビルド時は揃える）
    const THINK_FIRST_MS = 70, THINK_NEXT_MS = 40, BEAM_WIDTH = 256;

    const COLORS = [
        [0, 240, 240], [240, 240, 0], [160, 0, 240], [0, 0, 240],
        [240, 160, 0], [0, 240, 0], [240, 0, 0],
    ];

    // ─── ミノの形（Mino を回して得る。エンジンと同じ丸め）───
    const shapeCache = {};
    function shapeOf(type, rot) {
        const key = type * 4 + rot;
        if (shapeCache[key]) return shapeCache[key];
        const m = new Mino(type);
        for (let i = 0; i < rot; i++) m.rotate();
        const blocks = m.blocks.map(b => ({ x: b.x, y: b.y }));
        return (shapeCache[key] = { blocks, pivot: { x: m.pivot.x, y: m.pivot.y } });
    }

    function cellsAt(type, rot, x, y) {
        return shapeOf(type, rot).blocks.map(b => ({ x: b.x + x, y: b.y + y }));
    }

    // ─── 盤面（占有マップ）───
    function gridFromGame(g) {
        const grid = new Uint8Array(COLS * (ROWS + TOP));
        g.field.blocks.forEach(b => {
            if (b.x >= 0 && b.x < COLS && b.y >= -TOP && b.y < ROWS) grid[(b.y + TOP) * COLS + b.x] = 1;
        });
        return grid;
    }
    const occ = (grid, x, y) => x < 0 || x >= COLS || y < -TOP || y >= ROWS || grid[(y + TOP) * COLS + x] === 1;

    function fits(grid, type, rot, x, y) {
        const bl = shapeOf(type, rot).blocks;
        for (let i = 0; i < 4; i++) if (occ(grid, bl[i].x + x, bl[i].y + y)) return false;
        return true;
    }

    // ─── SRS（game/tet/rotation.js の tryRotate と同じ表。[dx, dy_up] で y は反転して足す）───
    const KICK_CW = {
        I: { '0->1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '1->2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
             '2->3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '3->0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]] },
        N: { '0->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '1->2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
             '2->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '3->0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]] },
    };
    const KICK_CCW = {
        I: { '0->3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], '3->2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
             '2->1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], '1->0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]] },
        N: { '0->3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '3->2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
             '2->1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '1->0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]] },
    };

    // 回転を試す。成功なら {x, y, rot, kick}（kick=試した番号。4 が Point5）
    function tryRotate(grid, type, rot, x, y, dir) {
        if (type === 1) return null;                       // O は回転しても同じ形（エンジンもキック表は使うが結果は同じ）
        const to = (rot + (dir === 1 ? 1 : 3)) % 4;
        const tbl = (dir === 1 ? KICK_CW : KICK_CCW)[type === 0 ? 'I' : 'N'][`${rot}->${to}`];
        for (let i = 0; i < tbl.length; i++) {
            const nx = x + tbl[i][0], ny = y - tbl[i][1];
            if (fits(grid, type, to, nx, ny)) return { x: nx, y: ny, rot: to, kick: i };
        }
        return null;
    }

    // ─── T-spin 判定（game/tet/rotation.js の checkTSpin と同じ。Point5 は常に通常扱い）───
    //   戻り値 0=なし 1=通常 2=mini
    function tspinKind(grid, x, y, rot, kick) {
        const p = shapeOf(2, rot).pivot;
        const px = Math.round(x + p.x - 0.5), py = Math.round(y + p.y - 0.5);
        const o = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([dx, dy]) => occ(grid, px + dx, py + dy));
        let ab, cd;
        switch (rot) {
            case 0: ab = [0, 1]; cd = [2, 3]; break;
            case 1: ab = [1, 3]; cd = [0, 2]; break;
            case 2: ab = [3, 2]; cd = [1, 0]; break;
            default: ab = [2, 0]; cd = [3, 1]; break;
        }
        const a = ab.filter(i => o[i]).length, c = cd.filter(i => o[i]).length;
        if (kick === 4) return 1;
        if (a === 2 && c >= 1) return 1;
        if (c === 2 && a >= 1) return 2;
        return 0;
    }

    // ─── 経路探索（BFS）───
    //   状態 = (x, y, rot, last)。last: 0=回転以外 1=回転で来た 2=Point5 の回転で来た
    //   戻り値: 目標姿勢 (tx,ty,trot) までの最短の操作列（1左 2右 3下 4右回転 5左回転）と、
    //   最後の操作が回転だったか。T-spin が成立するなら spin 付きの経路を優先する。
    function findPath(grid, type, tx, ty, trot) {
        const sx = 3, sy = (type === 0) ? -1 : -2;
        if (!fits(grid, type, 0, sx, sy)) return null;
        const key = (x, y, r, l) => ((((x + 4) * 40 + (y + TOP + 4)) * 4 + r) * 3 + l);
        const seen = new Map();
        const q = [];
        const push = (x, y, r, l, from, act) => {
            const k = key(x, y, r, l);
            if (seen.has(k)) return;
            seen.set(k, { x, y, r, l, from, act });
            q.push(k);
        };
        push(sx, sy, 0, 0, null, 0);
        const goals = [];
        for (let h = 0; h < q.length; h++) {
            const node = seen.get(q[h]);
            const { x, y, r } = node;
            if (x === tx && y === ty && r === trot && !fits(grid, type, r, x, y + 1)) goals.push(node);
            if (fits(grid, type, r, x - 1, y)) push(x - 1, y, r, 0, node, 1);
            if (fits(grid, type, r, x + 1, y)) push(x + 1, y, r, 0, node, 2);
            if (fits(grid, type, r, x, y + 1)) push(x, y + 1, r, 0, node, 3);
            for (const dir of [1, -1]) {
                const t = tryRotate(grid, type, r, x, y, dir);
                if (t) push(t.x, t.y, t.rot, t.kick === 4 ? 2 : 1, node, dir === 1 ? 4 : 5);
            }
        }
        if (!goals.length) return null;
        // T なら T-spin 成立の経路を優先、それ以外は最短（BFS 順の先頭）
        let best = goals[0];
        let kind = 0;
        if (type === 2) {
            for (const gl of goals) {
                if (gl.l > 0) {
                    const k = tspinKind(grid, tx, ty, trot, gl.l === 2 ? 4 : 0);
                    if (k > 0 && (k === 1 || kind === 0)) { best = gl; kind = k; if (k === 1) break; }
                }
            }
        }
        const rev = [];
        const poses = [];                                  // 各操作の「前」の姿勢
        for (let n = best; n && n.act; n = n.from) {
            rev.push(n.act);
            poses.push({ x: n.from.x, y: n.from.y, rot: n.from.r });
        }
        return { path: rev.reverse(), poses: poses.reverse(), spin: kind, lastRot: best.l > 0 };
    }

    // 「複雑な手」か：回転を空中で済ませて真下に落とせば入る手は単純。降りてから回す手などが複雑
    function isComplex(grid, type, tx, ty, trot) {
        const sx = 3, sy = (type === 0) ? -1 : -2;
        const seen = new Set();
        const q = [[sx, sy, 0]];
        seen.add(`${sx},${sy},0`);
        for (let h = 0; h < q.length; h++) {
            const [x, y, r] = q[h];
            // ここから真下に落とした姿勢が目標か
            let dy = y;
            while (fits(grid, type, r, x, dy + 1)) dy++;
            if (x === tx && dy === ty && r === trot) return false;
            const nexts = [];
            if (fits(grid, type, r, x - 1, y)) nexts.push([x - 1, y, r]);
            if (fits(grid, type, r, x + 1, y)) nexts.push([x + 1, y, r]);
            for (const dir of [1, -1]) {
                const t = tryRotate(grid, type, r, x, y, dir);
                if (t) nexts.push([t.x, t.y, t.rot]);
            }
            for (const n of nexts) {
                const k = n.join(',');
                if (!seen.has(k)) { seen.add(k); q.push(n); }
            }
        }
        return true;
    }

    // 落とした位置（ハードドロップ）
    function dropY(grid, type, rot, x, y) {
        while (fits(grid, type, rot, x, y + 1)) y++;
        return y;
    }

    // ─── worker ───
    const S = {
        cache: null, inflight: null, worker: null, ready: false, queue: [], pendingReq: null,
        matchRaf: null, plan: null,
    };

    function ensureWorker() {
        if (S.worker) return;
        const url = (window.CPU7 && CPU7.WORKER_URLS && CPU7.WORKER_URLS[0]) || WORKER_URL_FALLBACK;
        S.worker = CpuWorkerPool.acquire(url);
        S.ready = false;
        S.worker.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'ready') {
                S.ready = true;
                if (S.pendingReq) { const r = S.pendingReq; S.pendingReq = null; send(r); }
            } else if (d.type === 'result') {
                const job = S.queue.shift();
                if (job) job.done(d.result);
            }
        };
        S.worker.onerror = (err) => console.error('Assist worker error', err.message);
    }

    function send(req) {
        if (!S.ready) { S.pendingReq = req; return; }   // 準備前は最新の1件だけ覚える
        S.queue.push(req);
        S.worker.postMessage(req.msg);
    }

    function incomingOf(g) {
        let n = 0;
        (g.garbageQueue || []).forEach(q => { if (!q.internal) n += q.amount; });
        return n;
    }

    // 4マス（TETLABO 座標）に一致する (rot, x, y)（cpu7.js _findPose と同じ）
    function findPose(type, cells) {
        const key = (x, y) => x + ',' + y;
        const want = new Set(cells.map(c => key(c.x, c.y)));
        for (let rot = 0; rot < 4; rot++) {
            const bl = shapeOf(type, rot).blocks;
            for (const c of cells) {
                const x = c.x - bl[0].x, y = c.y - bl[0].y;
                if (bl.every(b => want.has(key(b.x + x, b.y + y)))) return { rot, x, y };
            }
        }
        return null;
    }

    const ask = (msg) => new Promise(resolve => send({ msg, done: resolve }));

    // ─── 仮想の局面（計画の各手の前の状態）───
    //   queue[0] が手にあるミノ、以降が見えている NEXT。LV7 は初手しか返さないので、
    //   1手ずつ「仮想上で置いて」次の局面を作り、そこから次の1手を聞く（設計 §10.2）。
    // bagAfter：queue を引いたあとの 7-bag の残り（ビット）。LV7 は queue から bag を逆算するので、
    //   bag の切れ目が分からないと同じミノが続く queue で探索が失敗する（手が返らない）。
    //   見えている範囲の切れ目だけ使い、見えない NEXT の中身は使わない（切れ目の位置は個数だけで決まる）。
    function bagAfterOf(g, queue, hold) {
        const L = g.nextQueue.length, V = queue.length - 1;
        let e = 7 - (g.bag ? g.bag.length : 0) - (L - V);
        while (e <= 0) e += 7;
        if (e >= 7) return 0;                                   // 切れ目ちょうど：次から新しい bag
        const drawn = new Set(queue.slice(Math.max(0, queue.length - e)));
        if (e > queue.length && hold !== -1) drawn.add(hold);   // bag の途中から始まっている：既に引いた分は見えないので HOLD だけ足す
        let bits = 0;
        for (let t = 0; t < 7; t++) if (!drawn.has(t)) bits |= 1 << t;
        return bits;
    }

    function snapshot(g, visible) {
        const queue = [g.mino.type];
        for (let i = 0; i < visible && g.nextQueue[i]; i++) queue.push(g.nextQueue[i].type);
        const hold = g.holdMino ? g.holdMino.type : -1;
        return {
            grid: gridFromGame(g), queue, hold, bagAfter: bagAfterOf(g, queue, hold),
            canHold: !!g.canHold, b2b: g.backToBack ? 1 : 0, ren: g.ren || 0,
        };
    }

    // 仮想で1手置く。step = { type, rot, x, y, hold?, ts? }
    function advance(st, step) {
        const r = placeAndClear(st.grid, cellsAt(step.type, step.rot, step.x, step.y));
        const lines = r.cleared.length;
        let b2b = st.b2b, ren = 0;
        if (lines > 0) { b2b = (lines === 4 || step.ts > 0) ? 1 : 0; ren = st.ren + 1; }
        let queue, hold = st.hold;
        if (step.hold) {
            queue = hold === -1 ? st.queue.slice(2) : st.queue.slice(1);
            hold = st.queue[0];
        } else queue = st.queue.slice(1);
        return { grid: r.grid, queue, hold, bagAfter: st.bagAfter, canHold: true, b2b, ren };
    }

    // raw の各手の前の局面 states[0..n-1] を作る（states[0] = st0）
    function replay(st0, raw) {
        const states = [st0];
        for (let k = 0; k < raw.length - 1; k++) states.push(advance(states[k], raw[k]));
        return states;
    }

    // いまの局面 `act` が、保存した計画のどの手の前か（HOLD 直後の「手に持ち替えた状態」も）を探す
    //   戻り値 { k, held }（held=その手の HOLD を済ませた直後）。無ければ null
    function matchCache(c, act) {
        for (let k = 0; k < c.raw.length; k++) {
            const st = c.states[k], step = c.raw[k];
            if (!sameGrid(st.grid, act.grid)) continue;
            if (st.queue[0] === act.queue[0] && st.hold === act.hold) {
                if (step.hold && !act.canHold) continue;            // 計画は HOLD を求めるが、もう HOLD できない
                return { k, held: false };
            }
            if (step.hold && step.type === act.queue[0] && st.queue[0] === act.hold) return { k, held: true };
        }
        return null;
    }

    // 局面 st から LV7 に次の1手を聞く。first=true は計画の最初の1手（長めに考える）
    async function lv7Next(st, first, serial) {
        // HOLD 済みの局面では HOLD できない。「HOLD に今のミノと同じミノがある」ことにして HOLD を無意味にする
        const holdArg = (!st.canHold) ? st.queue[0] : st.hold;
        const res = await ask({
            type: 'calculate',
            boardBuffer: Uint8Array.from(st.grid),
            queue: new Int32Array(st.queue),
            holdType: holdArg,
            bagAfter: st.bagAfter,
            backToBack: st.b2b,
            ren: st.ren,
            incoming: first ? st.incoming || 0 : 0,
            weights: new Int32Array(0),
            width: BEAM_WIDTH,
            depth: Math.max(1, st.queue.length),
            thinkMs: first ? THINK_FIRST_MS : THINK_NEXT_MS,
        });
        if (Assist.serial !== serial) return null;
        if (!res || res[0] !== 1) return null;
        const type = res[1];
        const cells = [];
        for (let i = 0; i < 4; i++) cells.push({ x: res[2 + i * 2], y: res[3 + i * 2] });
        const pose = findPose(type, cells);
        if (!pose) return null;
        const hold = res[10] === 1;
        if (hold && st.hold === -1 && st.queue.length < 2) return null;
        const step = { type, rot: pose.rot, x: pose.x, y: pose.y, ts: res[16] };
        if (hold) step.hold = true;
        return step;
    }

    // ─── 計画の組み立て ───
    // 盤面を1手進める：ミノを置いてライン消去。戻り値 { grid, cleared(消えた行 y の配列) }
    function placeAndClear(grid, cells) {
        const g2 = Uint8Array.from(grid);
        cells.forEach(c => { if (c.y >= -TOP && c.y < ROWS && c.x >= 0 && c.x < COLS) g2[(c.y + TOP) * COLS + c.x] = 1; });
        const cleared = [];
        for (let y = -TOP; y < ROWS; y++) {
            let full = true;
            for (let x = 0; x < COLS; x++) if (!g2[(y + TOP) * COLS + x]) { full = false; break; }
            if (full) cleared.push(y);
        }
        if (!cleared.length) return { grid: g2, cleared };
        const out = new Uint8Array(g2.length);
        let dst = ROWS - 1;
        for (let y = ROWS - 1; y >= -TOP; y--) {
            if (cleared.includes(y)) continue;
            for (let x = 0; x < COLS; x++) out[(dst + TOP) * COLS + x] = g2[(y + TOP) * COLS + x];
            dst--;
        }
        return { grid: out, cleared };
    }

    const isEmpty = (grid) => { for (let i = 0; i < grid.length; i++) if (grid[i]) return false; return true; };

    // 経路・複雑さ・回転表示用の情報を足す。ymap は「計算上の行 → 画面の行」（消去でずれた分）
    function decorate(grid, step, ymap) {
        const info = findPath(grid, step.type, step.x, step.y, step.rot);
        step.simCells = cellsAt(step.type, step.rot, step.x, step.y);
        const my = (y) => (ymap && ymap[y] !== undefined) ? ymap[y] : y;
        step.cells = step.simCells.map(c => ({ x: c.x, y: my(c.y) }));
        step.ymap = ymap || null;
        if (!info) return step;
        step.spin = info.spin;
        step.lastRot = info.lastRot;
        if (info.lastRot && isComplex(grid, step.type, step.x, step.y, step.rot)) {
            let n = info.path.length, cnt = 0, dir = 0;           // 最後に連続している回転をまとめる
            while (n > 0 && (info.path[n - 1] === 4 || info.path[n - 1] === 5)) {
                if (!dir) dir = info.path[n - 1];
                cnt++; n--;
            }
            if (cnt > 0) step.rotation = { dir: dir === 4 ? 1 : -1, count: cnt, before: info.poses[n] };
        }
        return step;
    }

    // 消去後の ymap を作る（CPU TEST の renderEstimatePlace と同じ考え方）
    function nextYmap(ymap, cleared) {
        if (!cleared.length) return ymap;
        const out = {};
        let dst = ROWS - 1;
        for (let y = ROWS - 1; y >= -TOP; y--) {
            if (cleared.includes(y)) continue;
            out[dst] = ymap[y] !== undefined ? ymap[y] : y;
            dst--;
        }
        for (; dst >= -TOP; dst--) out[dst] = dst;
        return out;
    }

    const TS_NAME = ['', 'TSS', 'TSD', 'TST'];
    const TS_JA = ['', 'シングル', 'ダブル', 'トリプル'];

    // 生の手の列（worker/PC 探索の座標）→ 見どころ付きの計画。見どころが無ければ null。
    //   見どころ = depth 手以内の T-spin（ミニ除く・1ライン以上）か PC。最初に起きる方まで
    function buildFromRaw(grid0, raw, depth, pcOnly, all) {
        let grid = grid0;
        let ymap = {};
        for (let y = -TOP; y < ROWS; y++) ymap[y] = y;
        const steps = [];
        const n = Math.min(raw.length, depth);
        for (let k = 0; k < n; k++) {
            const st = decorate(grid, Object.assign({}, raw[k]), ymap);
            steps.push(st);
            const res = placeAndClear(grid, st.simCells);
            const lines = res.cleared.length;
            const when = k === 0 ? 'この手で' : `${k + 1}手目で`;
            if (!pcOnly && st.type === 2 && st.spin === 1 && lines >= 1 && lines <= 3) {
                return { kind: TS_NAME[lines], text: `${when}Tスピン${TS_JA[lines]}`, steps, hl: k, raw: raw.slice(0, k + 1) };
            }
            if (lines > 0 && isEmpty(res.grid)) {
                return { kind: 'PC', text: `${k + 1}手でパーフェクトクリア`, steps, hl: k, raw: raw.slice(0, k + 1) };
            }
            ymap = nextYmap(ymap, res.cleared);
            grid = res.grid;
        }
        // 見どころが無い：ALL は手の列をそのまま出す（番号は1手目から。強調は1手目だけ）
        return all ? { kind: '', text: '', steps, hl: -1, raw: raw.slice(0, n), forType: raw[0] && raw[0].type } : null;
    }


    // ─── PC（パーフェクトクリア）探索 ───
    //   旧 LV6 には PC 用 worker が無いので JS の DFS で探す（盤面が低い時だけ・時間制限つき）。
    //   置き方は「真下に落とす」位置だけ（滑り込み・T-spin の PC は見ない）。見えている NEXT と HOLD まで。
    const PC_BUDGET_MS = 30;
    const countBlocks = (grid) => { let n = 0; for (let i = 0; i < grid.length; i++) n += grid[i]; return n; };
    function stackHeight(grid) {
        for (let y = -TOP; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) if (grid[(y + TOP) * COLS + x]) return ROWS - y;
        }
        return 0;
    }

    function pcPlacements(grid, type) {
        const out = [], seen = new Set();
        const sy = (type === 0) ? -1 : -2;
        for (let rot = 0; rot < 4; rot++) {
            for (let x = -2; x < COLS; x++) {
                if (!fits(grid, type, rot, x, sy)) continue;
                const y = dropY(grid, type, rot, x, sy);
                const cells = cellsAt(type, rot, x, y);
                const k = cells.map(c => c.x + ',' + c.y).sort().join('|');
                if (seen.has(k)) continue;                  // O/I/S/Z の同形の重複
                seen.add(k);
                out.push({ rot, x, y, cells });
            }
        }
        return out;
    }

    function pcSearch(grid0, curType, holdType, canHold, nexts, maxD) {
        const seq = [curType].concat(nexts);
        const b0 = countBlocks(grid0);
        const deadline = performance.now() + PC_BUDGET_MS;
        let timedOut = false;

        function dfs(grid, idx, hold, canHoldNow, rem, out) {
            if (rem === 0) return isEmpty(grid);
            if (performance.now() > deadline) { timedOut = true; return false; }
            const cap = (countBlocks(grid) + 4 * rem) / 10;
            if (cap !== Math.floor(cap) || stackHeight(grid) > cap) return false;
            const opts = [];
            if (idx < seq.length) opts.push({ type: seq[idx], nidx: idx + 1, nhold: hold, held: false });
            if (canHoldNow) {
                if (hold === -1) {
                    if (idx + 1 < seq.length) opts.push({ type: seq[idx + 1], nidx: idx + 2, nhold: seq[idx], held: true });
                } else if (idx < seq.length && hold !== seq[idx]) {
                    opts.push({ type: hold, nidx: idx + 1, nhold: seq[idx], held: true });
                }
            }
            for (const o of opts) {
                for (const pl of pcPlacements(grid, o.type)) {
                    const res = placeAndClear(grid, pl.cells);
                    out.push({ type: o.type, rot: pl.rot, x: pl.x, y: pl.y, hold: o.held });
                    if (dfs(res.grid, o.nidx, o.nhold, true, rem - 1, out)) return true;
                    out.pop();
                    if (timedOut) return false;
                }
            }
            return false;
        }

        for (let d = 1; d <= Math.min(maxD, seq.length); d++) {
            const total = b0 + 4 * d;
            if (total % 10 || stackHeight(grid0) > total / 10) continue;
            const out = [];
            if (dfs(grid0, 0, holdType, canHold, d, out)) return out;
            if (timedOut) return null;
        }
        return null;
    }

    // 盤面の署名（計画が崩れていないかの確認用）
    const sameGrid = (a, b) => { if (!a || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

    const ov = () => window.AssistOverlay;

    const Tet = {
        reset() {
            S.queue = []; S.pendingReq = null; S.plan = null; S.cache = null; S.inflight = null;
            if (S.matchRaf) { cancelAnimationFrame(S.matchRaf); S.matchRaf = null; }
            if (S.worker) { try { S.worker.terminate(); } catch (e) { /* noop */ } S.worker = null; S.ready = false; }
        },

        // 計画の保存先 S.cache = { raw, states, pc }。いまの局面が保存した計画のどこかに一致すれば、
        // その続きをそのまま使い、足りない手だけ末尾に1手ずつ足す。一致しなければ1手目から作り直す。
        onSpawn(g, cfg, serial) {
            if (!g.mino) return;
            const depth = Assist.effectiveDepth(cfg, g);
            const visible = Assist._visibleNext(g);
            const act = snapshot(g, visible);
            act.incoming = incomingOf(g);
            const all = cfg.mode === 'all';
            const type = g.mino.type;

            let raw = [], states = [act], pc = false;
            const c = S.cache;
            S.cache = null;
            const m = c ? matchCache(c, act) : null;
            if (m) {
                raw = c.raw.slice(m.k);
                pc = c.pc;
                if (m.held) raw[0] = Object.assign({}, raw[0], { hold: false });
                states = replay(act, raw);
            }

            // PC は見つかれば T-spin より優先（盤面が低い時だけ探す。従っている PC の計画があればそのまま）
            if (!pc) {
                const nexts = [];
                for (let i = 0; i < visible; i++) nexts.push(g.nextQueue[i].type);
                const pcRaw = pcSearch(act.grid, type, act.hold, act.canHold, nexts, depth);
                if (pcRaw) { raw = pcRaw; pc = true; states = replay(act, raw); }
            }

            const show = () => {
                const plan = buildFromRaw(act.grid, raw, depth, pc, all);
                if (plan) plan.forType = type;
                S.cache = { raw, states, pc };
                Assist.publish(serial, plan);
                return plan;
            };
            let plan = show();
            S.inflight = serial;

            // 足りない手を1手ずつ足す（1手足すごとに表示を更新）。見どころが見つかった／DEPTH に届いた／NEXT が尽きたら止める
            const extend = async () => {
                ensureWorker();
                while (!pc && raw.length < depth && !(plan && plan.kind) && Assist.serial === serial) {
                    const last = raw.length ? advance(states[raw.length - 1], raw[raw.length - 1]) : act;
                    if (!last.queue.length) break;
                    const step = await lv7Next(last, raw.length === 0, serial);
                    if (!step || Assist.serial !== serial) break;
                    raw = raw.concat(step);
                    states = states.length === raw.length ? states : states.concat(last);
                    plan = show();
                }
                if (S.inflight === serial) S.inflight = null;
            };
            extend();
        },

        // ─── 描画 ───
        draw(ov, plan, g) {
            S.plan = plan;
            Tet._startMatch(g);
            if (!plan || !plan.steps.length) return;
            const svgNs = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(svgNs, 'svg');
            svg.setAttribute('class', 'assist-svg');
            svg.setAttribute('viewBox', `0 0 ${COLS * BS} ${ROWS * BS + BS / 2}`);
            plan.steps.forEach((st, i) => {
                const [r, gn, b] = COLORS[st.type];
                const hi = plan.hl === i;
                const op = i === 0 ? 0.9 : 0.55;
                const bg = i === 0 ? 0.3 : 0.14;
                st.cells.forEach(c => {
                    if (c.y < -1 || c.y >= ROWS) return;
                    const d = document.createElement('div');
                    d.className = 'assist-block' + (hi ? ' is-hi' : '') + (i === 0 ? ' is-first' : '');
                    d.style.left = (c.x * BS) + 'px';
                    d.style.top = ((c.y + 0.5) * BS) + 'px';
                    d.style.borderColor = `rgba(${r},${gn},${b},${hi ? 1 : op})`;
                    d.style.backgroundColor = `rgba(${r},${gn},${b},${bg})`;
                    ov.add(d);
                });
                // 番号バッジ（最も上のブロックの左上）
                const top = st.cells.reduce((a, c) => (c.y < a.y || (c.y === a.y && c.x < a.x)) ? c : a, st.cells[0]);
                const bd = document.createElement('div');
                bd.className = 'assist-badge' + (hi ? ' is-hi' : '');
                bd.textContent = (st.hold ? 'H·' : '') + (i + 1);
                bd.style.left = (top.x * BS + 2) + 'px';
                bd.style.top = ((top.y + 0.5) * BS + 2) + 'px';
                ov.add(bd);
                if (st.rotation) Tet._drawRotation(svg, st, svgNs);
            });
            ov.add(svg);                                        // 点線・矢印は番号やブロックより前面
        },

        // ゴースト（今の落下先）が1手目の目標と一致したら枠を光らせる（設計 J5）
        _startMatch(g) {
            if (S.matchRaf) return;
            const tick = () => {
                S.matchRaf = null;
                const plan = S.plan;
                if (!plan || !Assist.game || Assist.game !== g || !g.mino) return;
                // 計画を作った時と今のミノが違う（出現後に差し替えられた等）なら計算し直す
                if (g.mino.type !== plan.forType && !S.inflight) {
                    plan.forType = g.mino.type;
                    Assist.refresh();
                    S.matchRaf = requestAnimationFrame(tick);
                    return;
                }
                const st = plan.steps[0];
                let match = false;
                if (st && g.mino.type === st.type) {
                    const m = g.mino;
                    const gy = dropY(gridFromGame(g), m.type, m.rotation, m.x, m.y);
                    const cells = cellsAt(m.type, m.rotation, m.x, gy);
                    const key = (c) => c.x + ',' + c.y;
                    const want = new Set(st.cells.map(key));
                    match = cells.every(c => want.has(key(c)));
                }
                if (ov().layer) ov().layer.querySelectorAll('.assist-block.is-first').forEach(b => b.classList.toggle('is-match', match));
                S.matchRaf = requestAnimationFrame(tick);
            };
            S.matchRaf = requestAnimationFrame(tick);
        },

        // 回転前の位置（点線）と回転方向の矢印
        _drawRotation(svg, st, ns) {
            const rt = st.rotation;
            const my = (y) => (st.ymap && st.ymap[y] !== undefined) ? st.ymap[y] : y;
            const before = cellsAt(st.type, rt.before.rot, rt.before.x, rt.before.y).map(c => ({ x: c.x, y: my(c.y) }));
            before.forEach(c => {
                const rc = document.createElementNS(ns, 'rect');
                rc.setAttribute('x', c.x * BS + 3); rc.setAttribute('y', (c.y + 0.5) * BS + 3);
                rc.setAttribute('width', BS - 6); rc.setAttribute('height', BS - 6);
                rc.setAttribute('fill', 'none');
                rc.setAttribute('stroke', 'rgba(255,255,255,0.7)');
                rc.setAttribute('stroke-width', '1.5');
                rc.setAttribute('stroke-dasharray', '3 3');
                svg.appendChild(rc);
            });
            // 矢印：最終位置のピボットまわりの円弧
            const pv = shapeOf(st.type, st.rot).pivot;
            const dy = my(st.y) - st.y;
            const cx = (st.x + pv.x + 0.5) * BS, cy = (st.y + dy + pv.y + 1) * BS; // ピボットのマスの中央
            const R = 12, a0 = -200, a1 = 20;                   // 度。ピボットのマス中央まわりの弧
            const rad = (d) => d * Math.PI / 180;
            const s = rt.dir === 1 ? a0 : a1, e = rt.dir === 1 ? a1 : a0; // 右回転は左→右へ
            const px = (d) => cx + R * Math.cos(rad(d)), py = (d) => cy + R * Math.sin(rad(d));
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', `M ${px(s)} ${py(s)} A ${R} ${R} 0 0 ${rt.dir === 1 ? 1 : 0} ${px(e)} ${py(e)}`);
            path.setAttribute('fill', 'none');
            const halo = path.cloneNode();
            halo.setAttribute('stroke', 'rgba(10,10,15,0.85)');
            halo.setAttribute('stroke-width', '6');
            svg.appendChild(halo);
            path.setAttribute('stroke', '#ffd54a');
            path.setAttribute('stroke-width', '3');
            svg.appendChild(path);
            // 矢じり（終点の接線方向）
            const tdir = rad(e) + (rt.dir === 1 ? Math.PI / 2 : -Math.PI / 2);
            const ex = px(e), ey = py(e), L = 9;
            const head = document.createElementNS(ns, 'polygon');
            const p1 = [ex + L * Math.cos(tdir), ey + L * Math.sin(tdir)];
            const p2 = [ex + L * 0.7 * Math.cos(tdir + 2.5), ey + L * 0.7 * Math.sin(tdir + 2.5)];
            const p3 = [ex + L * 0.7 * Math.cos(tdir - 2.5), ey + L * 0.7 * Math.sin(tdir - 2.5)];
            head.setAttribute('points', `${p1} ${p2} ${p3}`);
            head.setAttribute('fill', '#ffd54a');
            head.setAttribute('stroke', 'rgba(10,10,15,0.85)');
            head.setAttribute('stroke-width', '1.5');
            svg.appendChild(head);
            if (rt.count > 1) {
                const tx = document.createElementNS(ns, 'text');
                tx.setAttribute('x', cx); tx.setAttribute('y', cy + 4);
                tx.setAttribute('fill', '#ffd54a'); tx.setAttribute('font-size', '11'); tx.setAttribute('font-weight', '700');
                tx.setAttribute('stroke', 'rgba(10,10,15,0.85)'); tx.setAttribute('stroke-width', '2'); tx.setAttribute('paint-order', 'stroke');
                tx.setAttribute('text-anchor', 'middle');
                tx.textContent = `×${rt.count}`;
                svg.appendChild(tx);
            }
        },
    };

    // 内部を他ファイル（A2 以降）が使えるように公開
    Tet._k = { S, snapshot, lv7Next, shapeOf, cellsAt, gridFromGame, fits, occ, tryRotate, tspinKind, findPath, isComplex, dropY, decorate, buildFromRaw, placeAndClear, isEmpty, pcSearch, COLS, ROWS, TOP, BS };
    window.AssistTet = Tet;
})();

// ─────────────────────────────────────────────
// assist/assist_tet.js  ―  アシストの tet 側（計算 + 描画）
//   思考は LV7（clys 型探索）の worker（cpu/tet/lv7/wasm/cpu_worker7.js）と直接話す。
//   CPU7 クラスは使わない（TEST 専用の作りが多いため。設計 §4.1）。
//   実戦の LV7（cpu7.js）と同じ入力（内部 NEXT 32 本・bag・幅・締め切り・既定の重み）で初手を聞き、
//   仮想で置いて次の局面からまた聞く、を DEPTH 手ぶん繰り返す（各手が「その局面の LV7 の手」になる。設計 §10.4）。
//   探索には見えない NEXT も使うが、表示する手は見えているミノを置く手だけ（設計 J2）。PC も LV7 に任せる。
//   計画は盤面が計画どおりの間は固定し、足りない手だけ末尾に足す。
//   操作の経路・回転の向きは自前の BFS（SRS キック込み。game/tet/rotation.js と同じ表）で求める。
// ─────────────────────────────────────────────

(function () {
    const COLS = 10, ROWS = 20, TOP = 5;           // 盤面は y=-5..19
    const BS = 32;                                  // 1マスのpx
    const WORKER_URL_FALLBACK = 'cpu/tet/lv7/wasm/cpu_worker7.js?v=1'; // CPU7.WORKER_URLS[0] と同じ値（再ビルド時は揃える）
    // CPU7 の weights.searchWidth / searchDepth / thinkMs と同じ値。重みは渡さない（空 = engine の既定値 = CPU7 の既定値）
    const BEAM_WIDTH = 256, SEARCH_DEPTH = 32, THINK_MS = 80;
    const QUEUE_MAX = 40;                           // cpu_worker7.js の QUEUE_MAX（これより長いキューは切られる）

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
    //   F = いまの手のミノ＋内部 NEXT 全部（ゲームの nextQueue を LV7 と同じだけ継ぎ足したもの）、qi = 手にあるミノの F での位置。
    //   rest = F を引き終えた後の 7-bag の残り（game.bag）。
    function snapshot(g, depth) {
        // LV7 と同じく内部 NEXT を継ぎ足す（表示は先頭のまま、ツモの順は変わらない）。計画の DEPTH 手先でも 32 本読めるだけ足す
        if (typeof g.ensureNextQueue === 'function') g.ensureNextQueue(SEARCH_DEPTH + 1 + depth + 2);
        const F = [g.mino.type];
        for (const m of g.nextQueue) F.push(m.type);
        return {
            F, qi: 0, rest: (g.bag || []).slice(),
            grid: gridFromGame(g), hold: g.holdMino ? g.holdMino.type : -1,
            canHold: !!g.canHold, b2b: g.backToBack ? 1 : 0, ren: g.ren || 0, incoming: incomingOf(g),
        };
    }
    const curOf = (st) => st.F[st.qi];

    // F[st.qi .. e) を LV7 に渡す時の bagAfter（e 本目まで引いた後の 7-bag の残り。ビット）
    //   F の末尾の後の残りが rest なので、そこから 7 本ずつ戻った位置が bag の切れ目
    function bagAfterAt(st, e) {
        const N = st.F.length;
        const lastB = N - ((7 - st.rest.length) % 7);       // F の中で最後の bag の切れ目
        let set;
        if (e > lastB) set = st.F.slice(e).concat(st.rest);
        else set = st.F.slice(e, lastB - 7 * Math.floor((lastB - e) / 7));
        let bits = 0;
        for (const t of set) bits |= 1 << t;
        return bits;                                          // 0 = 切れ目ちょうど（次から新しい bag）
    }

    // 仮想で1手置く。step = { type, rot, x, y, hold?, ts? }
    function advance(st, step) {
        const r = placeAndClear(st.grid, cellsAt(step.type, step.rot, step.x, step.y));
        const lines = r.cleared.length;
        let b2b = st.b2b, ren = 0;
        if (lines > 0) { b2b = (lines === 4 || step.ts > 0) ? 1 : 0; ren = st.ren + 1; }
        let qi = st.qi + 1, hold = st.hold;
        if (step.hold) {
            if (hold === -1) qi++;                            // 空の HOLD に入れて次のミノを置いた
            hold = curOf(st);
        }
        return { F: st.F, qi, rest: st.rest, grid: r.grid, hold, canHold: true, b2b, ren, incoming: st.incoming };
    }

    // 手 step で置くミノの F での位置（HOLD から出したミノは -1＝既に見えている）
    const placedIndex = (st, step) => !step.hold ? st.qi : (st.hold === -1 ? st.qi + 1 : -1);

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
            if (!sameGrid(st.grid, act.grid) || st.b2b !== act.b2b || st.ren !== act.ren) continue;
            if (curOf(st) === curOf(act) && st.hold === act.hold) {
                if (step.hold && !act.canHold) continue;            // 計画は HOLD を求めるが、もう HOLD できない
                return { k, held: false };
            }
            if (step.hold && step.type === curOf(act) && curOf(st) === act.hold) return { k, held: true };
        }
        return null;
    }

    // 局面 st から LV7 に初手を聞く（cpu7.js onMinoSpawned と同じ入力）
    //   HOLD 済みの局面（計画外の HOLD の直後）では HOLD できないので、「HOLD に今のミノと同じミノがある」ことにして HOLD を無意味にする
    async function lv7Next(st, serial) {
        const e = Math.min(st.F.length, st.qi + QUEUE_MAX);
        const res = await ask({
            type: 'calculate',
            boardBuffer: Uint8Array.from(st.grid),
            queue: new Int32Array(st.F.slice(st.qi, e)),
            holdType: st.canHold ? st.hold : curOf(st),
            bagAfter: bagAfterAt(st, e),
            backToBack: st.b2b,
            ren: st.ren,
            incoming: st.incoming,
            weights: new Int32Array(0),
            width: BEAM_WIDTH,
            depth: SEARCH_DEPTH,
            thinkMs: THINK_MS,
        });
        if (Assist.serial !== serial || !res || res[0] !== 1) return null;
        const type = res[1];
        const cells = [];
        for (let i = 0; i < 4; i++) cells.push({ x: res[2 + i * 2], y: res[3 + i * 2] });
        const pose = findPose(type, cells);
        if (!pose) return null;
        const step = { type, rot: pose.rot, x: pose.x, y: pose.y, ts: res[16] };
        if (res[10] === 1) step.hold = true;
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

    // 生の手の列（worker の座標）→ 見どころ付きの計画。
    //   見どころ = depth 手以内で最初に起きる T-spin（ミニ除く・1ライン以上）か PC。
    //   HINT は見どころの手まで（無ければ null）。ALL は見どころの先も depth 手まで並べる（見どころが無くても出す）
    function buildFromRaw(grid0, raw, depth, all) {
        let grid = grid0;
        let ymap = {};
        for (let y = -TOP; y < ROWS; y++) ymap[y] = y;
        const steps = [];
        const n = Math.min(raw.length, depth);
        let hit = null;
        for (let k = 0; k < n; k++) {
            const st = decorate(grid, Object.assign({}, raw[k]), ymap);
            steps.push(st);
            const res = placeAndClear(grid, st.simCells);
            const lines = res.cleared.length;
            if (!hit) {
                const when = k === 0 ? 'この手で' : `${k + 1}手目で`;
                if (st.type === 2 && st.spin === 1 && lines >= 1 && lines <= 3) {
                    hit = { kind: TS_NAME[lines], text: `${when}Tスピン${TS_JA[lines]}`, hl: k };
                } else if (lines > 0 && isEmpty(res.grid)) {
                    hit = { kind: 'PC', text: `${k + 1}手でパーフェクトクリア`, hl: k };
                }
                if (hit && !all) return Object.assign(hit, { steps, raw: raw.slice(0, k + 1) });
            }
            ymap = nextYmap(ymap, res.cleared);
            grid = res.grid;
        }
        if (!all) return null;
        return Object.assign(hit || { kind: '', text: '', hl: -1 }, { steps, raw: raw.slice(0, n) });
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

        // 計画の保存先 S.cache = { raw, states }（states[k] = k 手目の前の仮想局面）。
        //   いまの局面が保存した計画のどこかに一致すれば（盤面・手のミノ・HOLD・BtB・REN）その続きをそのまま使い（固定）、
        //   DEPTH に足りない手だけ末尾に1手ずつ LV7 に聞いて足す。一致しなければ1手目から作り直す。
        //   計画に従っていれば、1ツモにつき LV7 の探索1回（実戦の LV7 と同じ回数）
        onSpawn(g, cfg, serial) {
            if (!g.mino) return;
            const depth = Assist.effectiveDepth(cfg, g);
            const visible = Assist._visibleNext(g);
            const act = snapshot(g, depth);
            const all = cfg.mode === 'all';
            const type = g.mino.type;

            let raw = [];
            const c = S.cache;
            S.cache = null;
            const m = c ? matchCache(c, act) : null;
            if (m) {
                raw = c.raw.slice(m.k);
                if (m.held) raw[0] = Object.assign({}, raw[0], { hold: false });
            }
            let states = replay(act, raw);

            // 表示する手：DEPTH 手まで、かつ見えているミノを置く手が続く間（その先は先読みの控え）
            const shown = () => {
                let n = 0;
                while (n < raw.length && n < depth && placedIndex(states[n], raw[n]) <= visible) n++;
                return n;
            };
            let plan = null;
            const show = () => {
                plan = buildFromRaw(act.grid, raw.slice(0, shown()), depth, all);
                if (plan) plan.forType = type;
                S.cache = { raw, states };
                Assist.publish(serial, plan);
            };
            show();

            // 足りない手を1手ずつ足す（1手足すごとに表示を更新）。HINT は見どころが出たら止める。
            //   ALL は表示する手の先にもう1手（控え）を作っておき、置いた直後に次の手を待たずに出せるようにする。
            //   見えていないミノを置く手は出さないので、その手が1つできたらそこで止める（それが控えになる）
            const target = depth + (all ? 1 : 0);
            S.inflight = serial;
            const extend = async () => {
                ensureWorker();
                while (raw.length < target && shown() === Math.min(raw.length, depth)
                        && !(!all && plan && plan.kind) && Assist.serial === serial) {
                    const last = raw.length ? advance(states[raw.length - 1], raw[raw.length - 1]) : act;
                    const step = await lv7Next(last, serial);
                    if (!step || Assist.serial !== serial) break;
                    raw = raw.concat(step);
                    if (states.length < raw.length) states = states.concat(last);
                    show();
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
    Tet._k = { S, snapshot, bagAfterAt, lv7Next, shapeOf, cellsAt, gridFromGame, fits, occ, tryRotate, tspinKind, findPath, isComplex, dropY, decorate, buildFromRaw, placeAndClear, isEmpty, COLS, ROWS, TOP, BS };
    window.AssistTet = Tet;
})();

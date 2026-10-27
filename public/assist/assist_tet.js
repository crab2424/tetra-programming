// ─────────────────────────────────────────────
// assist/assist_tet.js  ―  アシストの tet 側（計算 + 描画）
//   思考は旧 LV6 のビーム探索 worker（cpu/tet/lv6/wasm/cpu_worker6.js）と直接話す。
//   CPU6 クラスは使わない（TEST 専用の作りが多いため。設計 §4.1）。
//   見えている NEXT より先は 0 で埋めて渡す（見えないツモを使った手順は出さない。設計 J2）。
//   操作の経路・回転の向きは自前の BFS（SRS キック込み。game/tet/rotation.js と同じ表）で求める。
// ─────────────────────────────────────────────

(function () {
    const COLS = 10, ROWS = 20, TOP = 5;           // 盤面は y=-5..19
    const BS = 32;                                  // 1マスのpx
    const WORKER_URL_FALLBACK = 'cpu/tet/lv6/wasm/cpu_worker6.js?v=20'; // CPU6.WORKER_URLS[0] と同じ値

    // 旧 LV6 の既定重み（cpu6.js のコンストラクタと同じ。配列の並びは requestSingleEvaluation 参照）
    const WEIGHTS = [
        100, -55, -560, -20, 4, 3, -2, -24, 72, 36,       // lineClear..touchingBonus
        200, -800, -85,                                   // iWell iWellOver blocksOverHole
        1000, 120, -600,                                  // line4 downstackGood downstackBad
        100,                                              // P1_WEIGHT*100
        2000, 750, 150,                                   // tSlotTsd tSlotReady tSlotTss
        256, 2560, -60, -100,                             // tssClear tsdClear tsdHolePenalty pureHole
        20, 496, -200,                                    // comboBonus btbKeep renCutPenalty
        -100, -300,                                       // tsmMiniPenalty tMinoNoClearPenalty
        100, -400,                                        // tsdSetup tsdSetupOver
        72, -36,                                          // slopeBonus slopePenalty
        100,                                              // centerDip
        6000, 150, 8000, 10, 6000,                        // tstClear b2bHold tSlotTst tSlotReadyFin tSlotReadyTst
    ];

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
        worker: null, ready: false, queue: [], pendingReq: null,
        matchRaf: null, plan: null,
    };

    function ensureWorker() {
        if (S.worker) return;
        const url = (window.CPU6 && CPU6.WORKER_URLS && CPU6.WORKER_URLS[0]) || WORKER_URL_FALLBACK;
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

    function buildMsg(g, visible) {
        const board = new Uint8Array(250);
        g.field.blocks.forEach(b => {
            const by = b.y + TOP;
            if (by >= 0 && by < 25 && b.x >= 0 && b.x < COLS) board[by * COLS + b.x] = 1;
        });
        const nq = (i) => (i < visible && g.nextQueue[i]) ? g.nextQueue[i].type : 0;
        return {
            type: 'calculate',
            boardBuffer: board,
            currentType: g.mino.type,
            holdType: g.holdMino ? g.holdMino.type : -1,
            next1: nq(0), next2: nq(1), next3: nq(2), next4: nq(3), next5: nq(4),
            next6: nq(5), next7: nq(6), next8: nq(7),
            canHold: g.canHold ? 1 : 0,
            weightsArray: new Int32Array(WEIGHTS),
            ren: g.ren || 0,
            backToBack: g.backToBack ? 1 : 0,
            incoming: incomingOf(g),
        };
    }

    // worker の結果 → 手の列 [{type, rot, x, y, hold?}]（最大6手。res[3..] の並びは cpu6.js handleWorkerResult と同じ）
    function decode(res) {
        if (res[0] === -1) return null;
        const at = (i) => (res[i] >= 0 && res[i] <= 6) ? { type: res[i], rot: res[i + 1], x: res[i + 2], y: res[i + 3] - TOP } : null;
        const steps = [at(3), at(8), at(13), at(17), at(21), at(25)].filter(Boolean);
        if (!steps.length) return null;
        if (res[0] === 1) steps[0].hold = true;
        return { steps, tspin1: res[12] };
    }

    // ─── 計画の組み立て ───
    function decorate(grid, step) {
        // 経路・複雑さ・回転表示用の情報を足す
        const info = findPath(grid, step.type, step.x, step.y, step.rot);
        step.cells = cellsAt(step.type, step.rot, step.x, step.y);
        if (!info) return step;
        step.spin = info.spin;
        step.lastRot = info.lastRot;
        if (info.lastRot && isComplex(grid, step.type, step.x, step.y, step.rot)) {
            // 最後に連続している回転をまとめる
            let n = info.path.length, cnt = 0, dir = 0;
            while (n > 0 && (info.path[n - 1] === 4 || info.path[n - 1] === 5)) {
                if (!dir) dir = info.path[n - 1];
                cnt++; n--;
            }
            if (cnt > 0) step.rotation = { dir: dir === 4 ? 1 : -1, count: cnt, before: info.poses[n] };
        }
        return step;
    }

    const ov = () => window.AssistOverlay;

    const Tet = {
        reset() {
            S.queue = []; S.pendingReq = null; S.plan = null;
            if (S.matchRaf) { cancelAnimationFrame(S.matchRaf); S.matchRaf = null; }
            if (S.worker) { try { S.worker.terminate(); } catch (e) { /* noop */ } S.worker = null; S.ready = false; }
        },

        onSpawn(g, cfg, serial) {
            if (!g.mino) return;
            ensureWorker();
            const visible = Assist._visibleNext(g);
            const depth = Assist.effectiveDepth(cfg, g);
            const grid = gridFromGame(g);
            send({
                msg: buildMsg(g, visible),
                done: (res) => {
                    const dec = decode(res);
                    if (!dec) { Assist.publish(serial, null); return; }
                    const plan = Tet.makePlan(g, grid, dec, cfg, depth);
                    Assist.publish(serial, plan);
                },
            });
        },

        // ALL: 先頭の1手だけ。見どころの計画づくりは A2 で足す
        makePlan(g, grid, dec, cfg, depth) {
            const first = decorate(grid, Object.assign({}, dec.steps[0]));
            return { kind: '', steps: [first], hl: -1, text: '', mode: cfg.mode, forType: g.mino.type };
        },

        // ─── 描画 ───
        draw(ov, plan, g) {
            S.plan = plan;
            Tet._startMatch(g);
            if (!plan || !plan.steps.length) return;
            const svgNs = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(svgNs, 'svg');
            svg.setAttribute('class', 'assist-svg');
            svg.setAttribute('viewBox', `0 0 ${COLS * BS} ${(ROWS + 1) * BS}`);
            ov.add(svg);
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
                    d.style.borderColor = hi ? 'var(--assist-color-hi)' : `rgba(${r},${gn},${b},${op})`;
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
        },

        // ゴースト（今の落下先）が1手目の目標と一致したら枠を光らせる（設計 J5）
        _startMatch(g) {
            if (S.matchRaf) return;
            const tick = () => {
                S.matchRaf = null;
                const plan = S.plan;
                if (!plan || !Assist.game || Assist.game !== g || !g.mino) return;
                // 計画を作った時と今のミノが違う（出現後に差し替えられた等）なら計算し直す
                if (g.mino.type !== plan.forType) {
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
            const before = cellsAt(st.type, rt.before.rot, rt.before.x, rt.before.y);
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
            const cx = (st.x + pv.x + 0.5) * BS, cy = (st.y + pv.y + 1) * BS;
            const R = 30, a0 = -150, a1 = -40;                  // 度。上側の弧
            const rad = (d) => d * Math.PI / 180;
            const s = rt.dir === 1 ? a0 : a1, e = rt.dir === 1 ? a1 : a0; // 右回転は左→右へ
            const px = (d) => cx + R * Math.cos(rad(d)), py = (d) => cy + R * Math.sin(rad(d));
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', `M ${px(s)} ${py(s)} A ${R} ${R} 0 0 ${rt.dir === 1 ? 1 : 0} ${px(e)} ${py(e)}`);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', '#ffd54a');
            path.setAttribute('stroke-width', '2.5');
            svg.appendChild(path);
            // 矢じり（終点の接線方向）
            const tdir = rad(e) + (rt.dir === 1 ? Math.PI / 2 : -Math.PI / 2);
            const ex = px(e), ey = py(e), L = 8;
            const head = document.createElementNS(ns, 'polygon');
            const p1 = [ex + L * Math.cos(tdir), ey + L * Math.sin(tdir)];
            const p2 = [ex + L * 0.7 * Math.cos(tdir + 2.5), ey + L * 0.7 * Math.sin(tdir + 2.5)];
            const p3 = [ex + L * 0.7 * Math.cos(tdir - 2.5), ey + L * 0.7 * Math.sin(tdir - 2.5)];
            head.setAttribute('points', `${p1} ${p2} ${p3}`);
            head.setAttribute('fill', '#ffd54a');
            svg.appendChild(head);
            if (rt.count > 1) {
                const tx = document.createElementNS(ns, 'text');
                tx.setAttribute('x', cx); tx.setAttribute('y', cy - R - 4);
                tx.setAttribute('fill', '#ffd54a'); tx.setAttribute('font-size', '11');
                tx.setAttribute('text-anchor', 'middle');
                tx.textContent = `×${rt.count}`;
                svg.appendChild(tx);
            }
        },
    };

    // 内部を他ファイル（A2 以降）が使えるように公開
    Tet._k = { shapeOf, cellsAt, gridFromGame, fits, occ, tryRotate, tspinKind, findPath, isComplex, dropY, decorate, COLS, ROWS, TOP, BS };
    window.AssistTet = Tet;
})();

// ─────────────────────────────────────────────
// assist/assist_puyo.js  ―  アシストの puyo 側（計算 + 描画）
//   HINT: CPU の判断とは無関係に、見えているツモ（最大3手）の置き方を全部試し、
//         CHAIN 連鎖以上を撃てる手順があれば「そこまでの置き場所＋発火点」を出す（設計 D8/D9、§4.2）。
//         途中の手は連鎖が起きない手に限る（起きると形が崩れる）。
//   ALL : 見どころが無い時は puyo LV6 に1手だけ考えさせて今のツモの置き場所を出す（isAutoPlay=false の
//         コントローラ。CPU TEST の「CPU CONTROL OFF」と同じ使い方）。
//   盤面は game.field（17行x6列。上5行が隠し）をそのまま 1 次元配列で扱う。
// ─────────────────────────────────────────────

(function () {
    const COLS = 6, TOTAL = 17, HID = 5;
    const SCALE_X = 320 / 192, SCALE_Y = 656 / 384;       // CPU の予想手表示と同じ換算
    const DC = [0, 1, 0, -1];                              // rot: 0=子が上 1=右 2=下 3=左
    const COLORS = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f']; // 画像の並び（赤青紫緑黄）
    const SEARCH_BUDGET_MS = 40;

    const S = { fixed: null, ctrl: null, ctrlLoading: false, raf: null, lastData: null, want: 0 };

    const idx = (r, c) => r * COLS + c;

    function fieldOf(g) {
        const f = new Int8Array(TOTAL * COLS);
        for (let r = 0; r < TOTAL; r++) for (let c = 0; c < COLS; c++) f[idx(r, c)] = g.field[r][c] || 0;
        return f;
    }

    const eraseCount = (g) => (g.vsEraseCount ?? PConfig.eraseCount);

    // 空きのうち一番下の行（無ければ -1）
    function dropRow(f, c) {
        for (let r = TOTAL - 1; r >= 0; r--) if (f[idx(r, c)] === 0) return r;
        return -1;
    }

    // 「いまの盤面から (col, rot) へ操作で行けるか」の目安：
    //   途中の列の最上段（出現行 row0=fr5）が塞がっていたら横に動けない。2 手回し等の細部は見ない
    function reachable(f, col, rot) {
        const cc = col + DC[rot];
        if (cc < 0 || cc >= COLS) return false;
        const lo = Math.min(2, col, cc), hi = Math.max(2, col, cc);
        for (let c = lo; c <= hi; c++) if (f[idx(HID, c)] !== 0) return false;
        if (rot === 2 && f[idx(HID + 1, col)] !== 0) return false;
        return true;
    }

    // ペアを置く。置けない時 null。戻り値 { f(置いた後), cells:[{r,c,color}x2] }
    function placePair(f, col, rot, colors) {
        if (!reachable(f, col, rot)) return null;
        const cc = col + DC[rot];
        let pr, cr;
        if (rot === 0) {
            pr = dropRow(f, col); if (pr < 0) return null;
            cr = pr - 1;
        } else if (rot === 2) {
            cr = dropRow(f, col); if (cr < 0) return null;
            pr = cr - 1;
        } else {
            pr = dropRow(f, col); cr = dropRow(f, cc);
            if (pr < 0 || cr < 0) return null;
        }
        if (pr < HID || cr < HID) return null;             // 画面の上に出る置き方は出さない
        const f2 = Int8Array.from(f);
        f2[idx(pr, col)] = colors[0];
        f2[idx(cr, cc)] = colors[1];
        // 次のツモが出せない（出現位置が塞がる）盤面は避ける
        if (f2[idx(HID, 2)] !== 0) return null;
        return { f: f2, cells: [{ r: pr, c: col, color: colors[0] }, { r: cr, c: cc, color: colors[1] }] };
    }

    // 連結（同色・上下左右）。start から広げて返す
    function flood(f, r0, c0, seen) {
        const color = f[idx(r0, c0)];
        const out = [], stack = [[r0, c0]];
        seen[idx(r0, c0)] = 1;
        while (stack.length) {
            const [r, c] = stack.pop();
            out.push({ r, c });
            for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const nr = r + dr, nc = c + dc;
                if (nr < HID || nr >= TOTAL || nc < 0 || nc >= COLS) continue;
                if (seen[idx(nr, nc)] || f[idx(nr, nc)] !== color) continue;
                seen[idx(nr, nc)] = 1;
                stack.push([nr, nc]);
            }
        }
        return out;
    }

    // 指定セルから連結を調べ、erase 個以上のグループを返す。cells=null なら盤面全体
    function findGroups(f, erase, cells) {
        const seen = new Uint8Array(f.length), groups = [];
        const visit = (r, c) => {
            if (r < HID || seen[idx(r, c)]) return;
            const col = f[idx(r, c)];
            if (col <= 0 || col === 6) return;
            const g = flood(f, r, c, seen);
            if (g.length >= erase) groups.push(g);
        };
        if (cells) cells.forEach(p => visit(p.r, p.c));
        else for (let r = HID; r < TOTAL; r++) for (let c = 0; c < COLS; c++) visit(r, c);
        return groups;
    }

    function gravity(f) {
        for (let c = 0; c < COLS; c++) {
            let w = TOTAL - 1;
            for (let r = TOTAL - 1; r >= 0; r--) {
                const v = f[idx(r, c)];
                if (v !== 0) { if (w !== r) { f[idx(w, c)] = v; f[idx(r, c)] = 0; } w--; }
            }
        }
    }

    // 連鎖を最後まで解く（f を書き換える）。first=最初に消えるグループ（発火点の判定用）
    function resolve(f, erase, newCells) {
        let chains = 0, first = null;
        let groups = findGroups(f, erase, newCells);       // 直前まで消えるものは無いので新しい2個からだけ見ればよい
        while (groups.length) {
            if (!first) first = groups;
            chains++;
            for (const g of groups) {
                for (const p of g) {
                    f[idx(p.r, p.c)] = 0;
                    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {   // 隣のおじゃまも消える
                        const nr = p.r + dr, nc = p.c + dc;
                        if (nr >= HID && nr < TOTAL && nc >= 0 && nc < COLS && f[idx(nr, nc)] === 6) f[idx(nr, nc)] = 0;
                    }
                }
            }
            gravity(f);
            groups = findGroups(f, erase, null);
        }
        return { chains, first };
    }

    function maxHeight(f) {
        for (let r = HID; r < TOTAL; r++) for (let c = 0; c < COLS; c++) if (f[idx(r, c)]) return TOTAL - r;
        return 0;
    }

    // 手の列を盤面へ順に置いて計画を作る（最後の手で CHAIN 連鎖以上なら見どころ）
    function buildFromRaw(f0, raw, cfg, erase) {
        let f = f0;
        const steps = [];
        for (let k = 0; k < raw.length; k++) {
            const pl = placePair(f, raw[k].col, raw[k].rot, raw[k].colors);
            if (!pl) return null;
            const f2 = Int8Array.from(pl.f);
            const res = resolve(f2, erase, pl.cells);
            steps.push({ col: raw[k].col, rot: raw[k].rot, colors: raw[k].colors, cells: pl.cells });
            if (res.chains > 0) {
                if (res.chains < cfg.chain) return null;
                const inGroup = new Set();
                res.first.forEach(g => g.forEach(p => inGroup.add(p.r + ',' + p.c)));
                const fire = pl.cells.filter(p => inGroup.has(p.r + ',' + p.c));
                const when = k === 0 ? 'この手で' : `${k + 1}手目で`;
                return {
                    kind: `${res.chains} CHAIN`, text: `${when}発火`, steps, hl: k, fire, chains: res.chains,
                    raw: raw.slice(0, k + 1),
                };
            }
            f = pl.f;
        }
        return null;
    }

    // 全探索：depth 手以内に cfg.chain 連鎖以上を撃てる手順（連鎖数が大きい→手数が少ない→低い盤面）
    function search(f0, tsumos, depth, cfg, erase) {
        const deadline = performance.now() + SEARCH_BUDGET_MS;
        let best = null, bestVal = -Infinity, timedOut = false;

        function dfs(f, k, raw) {
            const colors = tsumos[k];
            const sameColor = colors[0] === colors[1];
            for (let rot = 0; rot < 4; rot++) {
                if (sameColor && rot >= 2) break;           // 同色は上下・左右が同じ形
                for (let col = 0; col < COLS; col++) {
                    if (performance.now() > deadline) { timedOut = true; return; }
                    const pl = placePair(f, col, rot, colors);
                    if (!pl) continue;
                    const f2 = Int8Array.from(pl.f);
                    const res = resolve(f2, erase, pl.cells);
                    const step = { col, rot, colors };
                    if (res.chains >= cfg.chain) {
                        const val = res.chains * 1000 - (k + 1) * 100 - maxHeight(pl.f);
                        if (val > bestVal) { bestVal = val; best = raw.concat(step); }
                    } else if (res.chains === 0 && k + 1 < depth) {
                        dfs(pl.f, k + 1, raw.concat(step));
                        if (timedOut) return;
                    }
                }
            }
        }
        dfs(f0, 0, []);
        return best;
    }

    function tsumosOf(g, depth) {
        const out = [[g.pivotColor, g.childColor]];
        for (let i = 0; i < depth - 1 && g.nextQueue[i]; i++) out.push(g.nextQueue[i]);
        return out;
    }

    const sameField = (a, b) => { if (!a || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

    // ─── ALL：puyo LV6 に1手だけ考えさせる ───
    async function ensureController(g) {
        if (S.ctrl && S.ctrl.game === g) return;
        if (S.ctrlLoading) return;
        S.ctrlLoading = true;
        try {
            if (typeof loadCpuScript !== 'function') return;
            const cls = await loadCpuScript(6, 'puyo');
            const Cls = cls || window.PuyoCPU6;
            if (!Cls || Assist.game !== g) return;
            const c = new Cls(g);
            c.isAutoPlay = false;
            c.start();
            S.ctrl = c;
            S.lastData = null;
            watch();
        } catch (e) {
            console.warn('Assist: puyo LV6 を読み込めませんでした', e);
        } finally {
            S.ctrlLoading = false;
        }
    }

    // コントローラの結果が出たら、そのペアの1手目を ALL の置き場所として出す
    function watch() {
        if (S.raf) return;
        const tick = () => {
            S.raf = null;
            const c = S.ctrl, g = Assist.game;
            if (!c || !g || c.game !== g) return;
            const d = c.bestMoveData;
            if (d && d !== S.lastData && g._gs === 'falling' && S.want) {
                S.lastData = d;
                const w = S.want;
                // LV6 の読み筋（1〜3手目）を、見えている NEXT と DEPTH の範囲で並べる
                const cfg = Assist.get();
                const depth = Assist.effectiveDepth(cfg, g);
                const tsumos = tsumosOf(g, depth);
                const erase = eraseCount(g);
                const picks = [[d.col1, d.rot1], [d.col2, d.rot2], [d.col3, d.rot3]];
                let f = fieldOf(g);
                const steps = [];
                for (let k = 0; k < picks.length && k < tsumos.length; k++) {
                    const [col, rot] = picks[k];
                    if (col == null || col < 0) break;
                    const pl = placePair(f, col, rot, tsumos[k]);
                    if (!pl) break;
                    steps.push({ col, rot, colors: tsumos[k], cells: pl.cells });
                    const f2 = Int8Array.from(pl.f);
                    f = resolve(f2, erase, pl.cells).chains > 0 ? f2 : pl.f;
                }
                if (steps.length) Assist.publish(w, { kind: '', text: '', steps, hl: -1, fire: [] });
            }
            S.raf = requestAnimationFrame(tick);
        };
        S.raf = requestAnimationFrame(tick);
    }

    const Puyo = {
        reset() {
            S.fixed = null; S.want = 0; S.lastData = null;
            if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
            if (S.ctrl) { try { S.ctrl.stop(); } catch (e) { /* noop */ } S.ctrl = null; }
        },

        onSpawn(g, cfg, serial) {
            const depth = Assist.effectiveDepth(cfg, g);
            const erase = eraseCount(g);
            const f = fieldOf(g);
            S.want = 0;

            // 提示した手順に従っている間は計画を固定する（設計 D11）。
            //   盤面が予想と少しずれても（おじゃま着弾・置き方の差など）残りの手順がそのまま
            //   CHAIN 以上を撃てるなら、新しい探索に乗り換えずに同じ計画を続ける。
            const fx = S.fixed;
            S.fixed = null;
            if (fx && fx.raw.length > 1
                && g.pivotColor === fx.raw[1].colors[0] && g.childColor === fx.raw[1].colors[1]) {
                const plan = buildFromRaw(f, fx.raw.slice(1), cfg, erase);
                if (plan) { Puyo._remember(plan, f); Assist.publish(serial, plan); return; }
            }

            const raw = search(f, tsumosOf(g, depth), depth, cfg, erase);
            if (raw) {
                const plan = buildFromRaw(f, raw, cfg, erase);
                if (plan) { Puyo._remember(plan, f); Assist.publish(serial, plan); return; }
            }

            // 見どころなし：HINT は何も出さない。ALL は LV6 の1手
            Assist.publish(serial, null);
            if (cfg.mode === 'all') { S.want = serial; ensureController(g); }
        },

        _remember(plan, f) {
            if (plan.raw.length < 2) { S.fixed = null; return; }
            const st = plan.steps[0];
            const f2 = Int8Array.from(f);
            st.cells.forEach(p => { f2[idx(p.r, p.c)] = p.color; });
            S.fixed = { raw: plan.raw, expect: f2 };
        },

        // ─── 描画 ───
        //   本物のゴーストと見分けるため、中身は塗らず枠線だけ（枠の色=ぷよの色）。
        //   重なり順は 発火枠 → ぷよの枠 → 番号（番号が最前面）。
        draw(ov, plan) {
            if (!plan || !plan.steps.length) return;
            const w = 32 * SCALE_X, h = 32 * SCALE_Y;
            const place = (el, p) => {
                el.style.width = w + 'px'; el.style.height = h + 'px';
                el.style.left = (p.c * w) + 'px'; el.style.top = ((p.r - HID) * h) + 'px';
                return el;
            };
            // 発火点のマーク（連鎖の最初の消去に入るぷよ）。ぷよの色で、枠より一回り外側
            (plan.fire || []).forEach(p => {
                if (p.r - HID < 0) return;
                const m = place(document.createElement('div'), p);
                m.className = 'assist-fire';
                m.style.borderColor = COLORS[p.color - 1] || '#fff';
                m.style.boxShadow = `0 0 10px ${COLORS[p.color - 1] || '#fff'}`;
                ov.add(m);
            });
            plan.steps.forEach((st, i) => {
                const hi = plan.hl === i;
                st.cells.forEach(p => {
                    if (p.r - HID < 0) return;
                    const d = place(document.createElement('div'), p);
                    d.className = 'assist-puyo' + (hi ? ' is-hi' : '') + (i === 0 ? ' is-first' : '');
                    d.style.borderColor = COLORS[p.color - 1] || '#fff';
                    d.style.opacity = i === 0 ? 1 : 0.7;
                    ov.add(d);
                });
            });
            // 番号：親・子それぞれのぷよに付ける（ちぎりでも、どの手のぷよか分かる）
            plan.steps.forEach((st, i) => {
                const hi = plan.hl === i;
                st.cells.forEach(p => {
                    if (p.r - HID < 0) return;
                    const bd = document.createElement('div');
                    bd.className = 'assist-badge assist-puyo-badge' + (hi ? ' is-hi' : '');
                    bd.textContent = String(i + 1);
                    bd.style.left = (p.c * w + w / 2 - 8) + 'px';
                    bd.style.top = ((p.r - HID) * h + h / 2 - 8) + 'px';
                    ov.add(bd);
                });
            });
        },
    };

    Puyo._k = { fieldOf, placePair, resolve, search, buildFromRaw };
    window.AssistPuyo = Puyo;
})();

// ─────────────────────────────────────────────
// assist/assist_puyo.js  ―  アシストの puyo 側（計算 + 描画）
//   HINT: CPU の判断とは無関係に、見えているツモ（最大3手）の置き方を全部試し、
//         CHAIN 連鎖以上を撃てる手順があれば「そこまでの置き場所＋発火点」を出す（設計 D8/D9、§4.2）。
//         途中の手は連鎖が起きない手に限る（起きると形が崩れる）。
//   ALL : puyo LV6 に1手ずつ聞いて仮想で置き、DEPTH 手（＋控え1手）連ねる（tet と同じ方式。設計 §10.5）。
//         LV6 の目標連鎖数は CHAIN に置き換え、CHAIN 以上の発火が入った手を強調する。
//   盤面は game.field（17行x6列。上5行が隠し）をそのまま 1 次元配列で扱う。
// ─────────────────────────────────────────────

(function () {
    const COLS = 6, TOTAL = 17, HID = 5;
    const SCALE_X = 320 / 192, SCALE_Y = 656 / 384;       // CPU の予想手表示と同じ換算
    const DC = [0, 1, 0, -1];                              // rot: 0=子が上 1=右 2=下 3=左
    const COLORS = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f']; // 画像の並び（赤青紫緑黄）
    const SEARCH_BUDGET_MS = 40;

    const S = {
        fixed: null,                                       // HINT の固定計画
        cache: null,                                       // ALL の計画 { raw, states }（states[k] = k 手目の前の仮想局面）
        ctrl: null, ctrlLoading: null, wait: [], jobs: [], chainTarget: 0,
        matchRaf: null, matchKey: '', plan: null,
    };

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
    //   trust=true は CPU の手・いまの操作中のペア用：到達の目安と「次のツモが出せるか」を見ない（13段目まで置ける）
    function placePair(f, col, rot, colors, trust) {
        if (!trust && !reachable(f, col, rot)) return null;
        if (col < 0 || col >= COLS || col + DC[rot] < 0 || col + DC[rot] >= COLS) return null;
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
        const top = trust ? HID - 1 : HID;
        if (pr < top || cr < top) return null;             // 画面の上に出る置き方は出さない
        const f2 = Int8Array.from(f);
        f2[idx(pr, col)] = colors[0];
        f2[idx(cr, cc)] = colors[1];
        // 次のツモが出せない（出現位置が塞がる）盤面は避ける
        if (!trust && f2[idx(HID, 2)] !== 0) return null;
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

    // ─── ALL：puyo LV6 に1手ずつ聞いて仮想で置き、DEPTH 手ぶん連ねる（tet の §10.4 と同じ方式。設計 §10.5）───
    //   LV6 のコントローラは盤面の差し替え口として使うだけ（start しない＝自動操作・思考ログ・予想手表示は動かない）。
    //   各手は「仮想の局面を持つゲーム」（本物のゲームを prototype にして field / NEXT / 手のペアだけ上書き）で
    //   _requestCalculation させ、結果は worker から直接受け取る。おじゃま予告・相手の盤面などは本物を見る。
    //   目標連鎖数（weightsArray[32] fireChainCount）は CHAIN に置き換える（CHAIN 以上を撃てるなら撃つ）。
    async function ensureController(g) {
        if (S.ctrl && S.ctrl.__assistGame === g) return S.ctrl;
        if (S.ctrlLoading) return S.ctrlLoading;
        S.ctrlLoading = (async () => {
            try {
                if (typeof loadCpuScript !== 'function') return null;
                const cls = await loadCpuScript(6, 'puyo');
                const Cls = cls || window.PuyoCPU6;
                if (!Cls || Assist.game !== g) return null;
                const c = new Cls(g);
                c.isAutoPlay = false;
                c.__assistGame = g;
                c.worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        c.workerReady = true;
                        flush();
                    } else if (e.data.type === 'result') {
                        c.isCalculating = false;
                        const job = S.jobs.shift();
                        if (job) job.done(e.data.result);
                        flush();
                    }
                };
                const build = c._buildWeightsArray;
                c._buildWeightsArray = function (n) {
                    const w = build.call(this, n);
                    if (S.chainTarget > 0) w[32] = S.chainTarget;
                    return w;
                };
                S.ctrl = c;
                flush();
                return c;
            } catch (e) {
                console.warn('Assist: puyo LV6 を読み込めませんでした', e);
                return null;
            } finally {
                S.ctrlLoading = null;
            }
        })();
        return S.ctrlLoading;
    }

    // 待っている問い合わせを1件ずつ送る（コントローラは1度に1件しか計算しない）
    function flush() {
        const c = S.ctrl;
        if (!c || !c.workerReady || c.isCalculating || !S.wait.length) return;
        const job = S.wait.shift();
        if (Assist.serial !== job.serial) { job.done(null); flush(); return; }
        c.game = job.vg;
        c._requestCalculation(false);
        if (c.isCalculating) S.jobs.push(job);
        else { job.done(null); flush(); }               // 送れなかった（ゲームが playing でない等）
    }

    // 仮想の局面 st（f=盤面, F=ツモ列, qi=手のペアの位置）で LV6 の初手 {col, rot} を聞く
    function lv6Next(g, st, serial) {
        const vg = Object.create(g);
        vg.field = [];
        for (let r = 0; r < TOTAL; r++) vg.field.push(Array.from(st.f.subarray(r * COLS, (r + 1) * COLS)));
        vg.pivotColor = st.F[st.qi][0];
        vg.childColor = st.F[st.qi][1];
        vg.nextQueue = st.F.slice(st.qi + 1);
        return new Promise(resolve => {
            S.wait.push({ vg, serial, done: (res) => {
                if (Assist.serial !== serial || !res || res[0] < 0) { resolve(null); return; }
                resolve({ col: res[0], rot: res[1], colors: st.F[st.qi] });
            } });
            flush();
        });
    }

    // 仮想で1手置く（LV6 の手は回しも込みで届くので到達の目安は見ない）。置けなければ null
    function advance(st, step, erase) {
        const pl = placePair(st.f, step.col, step.rot, step.colors, true);
        if (!pl) return null;
        const f2 = Int8Array.from(pl.f);
        const res = resolve(f2, erase, pl.cells);
        return { st: { f: f2, F: st.F, qi: st.qi + 1 }, pl, res };
    }

    // 生の手の列 → 計画（CHAIN 以上を撃つ最初の手を強調・発火点・文。その先も並べる）
    //   表示の盤面 df は連鎖を消さずに積んだ盤面。連鎖が起きた後の手は、いまの盤面に重ならないよう df の上に積んで描く
    //   （連鎖が始まったら表示は切り替わる。_startMatch）
    function buildAll(st0, raw, cfg, erase) {
        let st = st0, hit = null, df = st0.f;
        const steps = [];
        for (let k = 0; k < raw.length; k++) {
            const a = advance(st, raw[k], erase);
            if (!a) break;
            const dp = placePair(df, raw[k].col, raw[k].rot, raw[k].colors, true);
            df = dp ? dp.f : df;
            steps.push({ col: raw[k].col, rot: raw[k].rot, colors: raw[k].colors, cells: dp ? dp.cells : [] });
            if (!hit && a.res.chains >= cfg.chain) {
                const inGroup = new Set();
                a.res.first.forEach(gr => gr.forEach(p => inGroup.add(p.r + ',' + p.c)));
                const when = k === 0 ? 'この手で' : `${k + 1}手目で`;
                hit = { kind: `${a.res.chains} CHAIN`, text: `${when}発火`, hl: k, chains: a.res.chains,
                    fire: a.pl.cells.filter(p => inGroup.has(p.r + ',' + p.c)) };
            }
            st = a.st;
        }
        if (!steps.length) return null;
        return Object.assign(hit || { kind: '', text: '', hl: -1, fire: [] }, { steps });
    }

    // ALL の計画作り。保存した計画の k 手目の前の局面（盤面・手のペア）といまが一致すればその続きを使い（固定）、
    //   足りない手だけ末尾に足す。表示は見えているペアを置く手だけ、その先にもう1手（控え）を作っておく
    function onSpawnAll(g, cfg, serial, depth, erase) {
        const visible = 1 + Assist._visibleNext(g);
        const act = { f: fieldOf(g), F: [[g.pivotColor, g.childColor]].concat(g.nextQueue.map(p => [p[0], p[1]])), qi: 0 };
        const samePair = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

        let raw = [];
        const c = S.cache;
        S.cache = null;
        if (c) {
            for (let k = 0; k < c.raw.length; k++) {
                if (sameField(c.states[k].f, act.f) && samePair(c.raw[k].colors, act.F[0])) { raw = c.raw.slice(k); break; }
            }
        }
        let states = [act];
        for (let k = 0; k < raw.length - 1; k++) {
            const a = advance(states[k], raw[k], erase);
            if (!a) { raw = raw.slice(0, k + 1); break; }
            states.push(a.st);
        }

        const shown = () => Math.min(raw.length, depth, visible);
        const show = () => {
            S.cache = { raw, states };
            Assist.publish(serial, buildAll(act, raw.slice(0, shown()), cfg, erase));
        };
        if (raw.length) show();
        else Assist.publish(serial, null);

        const target = depth + 1;
        S.chainTarget = cfg.chain;
        (async () => {
            if (!(await ensureController(g))) return;
            while (raw.length < target && shown() === Math.min(raw.length, depth) && Assist.serial === serial) {
                let last = act;
                if (raw.length) {
                    const a = advance(states[raw.length - 1], raw[raw.length - 1], erase);
                    if (!a || a.st.qi >= a.st.F.length || a.st.f[idx(HID, 2)] !== 0) break;   // ツモ切れ・窒息
                    last = a.st;
                }
                const step = await lv6Next(g, last, serial);
                if (!step || Assist.serial !== serial) break;
                raw = raw.concat(step);
                if (states.length < raw.length) states = states.concat(last);
                show();
            }
        })();
    }

    const Puyo = {
        reset() {
            S.fixed = null; S.cache = null; S.plan = null;
            S.wait.forEach(j => j.done(null)); S.jobs.forEach(j => j.done(null));
            S.wait = []; S.jobs = [];
            if (S.matchRaf) { cancelAnimationFrame(S.matchRaf); S.matchRaf = null; }
            if (S.ctrl) {
                S.ctrl.game = S.ctrl.__assistGame;
                try { S.ctrl.stop(); } catch (e) { /* noop */ }
                S.ctrl = null;
            }
        },

        onSpawn(g, cfg, serial) {
            const depth = Assist.effectiveDepth(cfg, g);
            const erase = eraseCount(g);
            const f = fieldOf(g);
            if (cfg.mode === 'all') { S.fixed = null; onSpawnAll(g, cfg, serial, depth, erase); return; }
            S.cache = null;

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

            // 見どころなし：何も出さない
            Assist.publish(serial, null);
        },

        _remember(plan, f) {
            if (plan.raw.length < 2) { S.fixed = null; return; }
            const st = plan.steps[0];
            const f2 = Int8Array.from(f);
            st.cells.forEach(p => { f2[idx(p.r, p.c)] = p.color; });
            S.fixed = { raw: plan.raw, expect: f2 };
        },

        // ─── 描画 ───
        draw(ov, plan, g) {
            S.plan = plan;
            S.matchKey = '';
            S.matched = false;
            S.followKey = '';
            Puyo._startMatch(g);
            if (!plan || !plan.steps.length) return;
            drawSteps(ov, plan.steps, plan.hl, plan.fire, true);
        },
    };

    function hexToRgba(hex, a) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    // 置き場所の描画。本物のゴーストと見分けるため、中身は塗らず枠線だけ（枠の色=ぷよの色）。
    //   重なり順は 発火枠 → ぷよの枠 → 番号（番号が最前面）。
    //   first=true なら1手目を点滅させる（連鎖中の追従表示では点滅させない）
    function drawSteps(ov, steps, hl, fire, first) {
        const w = 32 * SCALE_X, h = 32 * SCALE_Y;
        const place = (el, p) => {
            el.style.width = w + 'px'; el.style.height = h + 'px';
            el.style.left = (p.c * w) + 'px'; el.style.top = ((p.r - HID) * h) + 'px';
            return el;
        };
        // 発火点のマーク（連鎖の最初の消去に入るぷよ）。ぷよの色で、枠より一回り外側
        (fire || []).forEach(p => {
            if (p.r - HID < 0) return;
            const m = place(document.createElement('div'), p);
            m.className = 'assist-fire';
            m.style.borderColor = COLORS[p.color - 1] || '#fff';
            m.style.boxShadow = `0 0 10px ${COLORS[p.color - 1] || '#fff'}`;
            ov.add(m);
        });
        // 設定 GHOST: LINE のときは、アシストが薄い塗り（本物のゴーストが枠線になる）
        const fillStyle = typeof isGhostOutline === 'function' && isGhostOutline();
        steps.forEach((st, i) => {
            const hi = hl === i;
            st.cells.forEach(p => {
                if (p.r - HID < 0) return;
                const d = place(document.createElement('div'), p);
                d.className = 'assist-puyo' + (hi ? ' is-hi' : '') + (first && i === 0 ? ' is-first' : '') + (fillStyle ? ' is-fill' : '');
                const col = COLORS[p.color - 1] || '#fff';
                if (fillStyle) d.style.backgroundColor = hexToRgba(col, i === 0 ? 0.5 : 0.25);
                else d.style.borderColor = col;
                d.style.setProperty('--assist-glow', col);
                d.style.opacity = i === 0 ? 1 : 0.45;  // 2手目以降は薄く（tet と同じ）
                ov.add(d);
            });
        });
        // 番号：親・子それぞれのぷよに付ける（ちぎりでも、どの手のぷよか分かる）
        steps.forEach((st, i) => {
            const hi = hl === i;
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
    }

    // 連鎖中の表示：1手目どおりに置いて連鎖が始まったら、2手目以降を「いまの盤面（消えて落ちる途中）」の上に積み直して
    //   盤面の変化に追従させる（番号は次のツモから 1, 2, …）。1手目と違う所に置いた・続きが無い時は表示を消す
    function drawFollow(g) {
        const ov = window.AssistOverlay;
        if (!ov || !ov.layer) return;
        const plan = S.plan;
        const f = fieldOf(g);
        const key = S.matched && plan && plan.steps.length > 1 ? Array.prototype.join.call(f, '') : 'off';
        if (key === S.followKey) return;
        S.followKey = key;
        ov.clear();
        if (key === 'off') return;
        let df = f;
        const steps = [];
        for (const st of plan.steps.slice(1)) {
            const dp = placePair(df, st.col, st.rot, st.colors, true);
            if (!dp) break;
            df = dp.f;
            steps.push({ cells: dp.cells });
        }
        drawSteps(ov, steps, plan.hl - 1, [], false);
    }

    // いまのペアの落下先（ゴースト）が1手目の目標と一致したら枠を光らせる（tet と同じ。設計 J5）
    //   落下先は列と向きだけで決まる（庇が無い）ので、それが変わった時だけ比べる。
    //   連鎖が始まったら（chainCount>0）連鎖中の表示（drawFollow）に切り替える
    Puyo._startMatch = function (g) {
        if (S.matchRaf) return;
        const tick = () => {
            S.matchRaf = null;
            const plan = S.plan;
            if (!plan || !Assist.game || Assist.game !== g) return;
            if (g.chainCount > 0) {
                drawFollow(g);
                S.matchRaf = requestAnimationFrame(tick);
                return;
            }
            const key = g._gs === 'falling' ? `${g.pivotX},${g.targetRot},${g.pivotColor},${g.childColor}` : '';
            if (key && key !== S.matchKey) {
                S.matchKey = key;
                let match = false;
                const st = plan.steps[0];
                if (st) {
                    const pl = placePair(fieldOf(g), g.pivotX, g.targetRot, [g.pivotColor, g.childColor], true);
                    const want = new Set(st.cells.map(p => `${p.r},${p.c},${p.color}`));
                    match = !!pl && pl.cells.every(p => want.has(`${p.r},${p.c},${p.color}`));
                }
                S.matched = match;
                const layer = window.AssistOverlay?.layer;
                if (layer) layer.querySelectorAll('.assist-puyo.is-first').forEach(b => b.classList.toggle('is-match', match));
            }
            S.matchRaf = requestAnimationFrame(tick);
        };
        S.matchRaf = requestAnimationFrame(tick);
    };

    Puyo._k = { S, fieldOf, placePair, resolve, search, buildFromRaw, buildAll, lv6Next };
    window.AssistPuyo = Puyo;
})();

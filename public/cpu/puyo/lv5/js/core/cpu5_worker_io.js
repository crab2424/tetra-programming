// ─────────────────────────────────────────────
// cpu5_worker_io.js（Worker / Wasm 連携）
//   PuyoCPU5.prototype を拡張する（cpu5.js が class 本体を定義済みであること）。
//
//   _requestCalculation()  … 盤面/NEXT/重みをバッファ化して Worker へ postMessage
//   _handleWorkerResult()  … Wasm の探索結果を受け取り、bestMoveData 反映・着手開始
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU5.prototype, {

    // precompute=true のときは「これから出るペア(nextQueue[0])」を現ペアとして探索する
    // （spawnAnim 時点の前倒し計算）。falling 時の通常計算では pivotColor/childColor を使う。
    _requestCalculation(precompute = false) {
        if (!this.workerReady || this.isCalculating) return;

        const game = this.game;
        if (!game || game.state !== 'playing') return;

        this.isCalculating = true;

        const TOTAL_ROWS = 17;
        const COLS       = 6;
        const boardBuffer = new Uint8Array(TOTAL_ROWS * COLS);

        for (let r = 0; r < TOTAL_ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                boardBuffer[r * COLS + c] = game.field[r][c] || 0;
            }
        }

        const nextPairs = new Int32Array(20);
        const q = game.nextQueue || [];

        // ★ 現ペアとNEXT列の起点。
        //   precompute（spawnAnim/着手前）：まだ _spawnPuyo していないので現ペア＝nextQueue[0]、
        //     以降のNEXTは nextQueue[1..]（queueOffset=1）。
        //   通常（falling/操作中）：現ペア＝pivotColor/childColor、NEXTは nextQueue[0..]（queueOffset=0）。
        let curPair, queueOffset;
        if (precompute && q[0]) {
            curPair     = q[0];
            queueOffset = 1;
        } else {
            curPair     = [game.pivotColor, game.childColor];
            queueOffset = 0;
        }

        nextPairs[0] = curPair[0];
        nextPairs[1] = curPair[1];

        // ★ 実際に見えているNEXTの本数（現在ペアを除く）。
        //   ※ かつて「ここから先は擬似未来ツモで分岐する」境界に使う想定だったが、TETLABO は
        //     内部20NEXTを確定保持するため擬似分岐機構は撤去済み。C++ 側は weightsArray[20] に
        //     渡るものの参照しない（cpu5.cpp で w.knownNextCount に代入されるだけのデッド配線）。
        //     現状は単に未充足NEXTをダミー埋めするためのカウンタとしてのみ機能する。
        let knownNextCount = 0;
        for (let i = 0; i < 9; i++) {
            const qp = q[i + queueOffset];
            if (qp) {
                nextPairs[(i + 1) * 2]     = qp[0];
                nextPairs[(i + 1) * 2 + 1] = qp[1];
                if (knownNextCount === i) knownNextCount = i + 1; // 先頭から連続して既知の本数
            } else {
                nextPairs[(i + 1) * 2]     = (i % 4) + 1;
                nextPairs[(i + 1) * 2 + 1] = ((i + 1) % 4) + 1;
            }
        }

        // ★ 着手予測オーバーレイ(test)が探索と同じペアで描けるよう、使った3手分の色を控える。
        //   precompute 時は pivotColor/childColor がまだ前ツモのままなので、game から読ませない。
        this._estimateColors = [
            [nextPairs[0], nextPairs[1]],
            [nextPairs[2], nextPairs[3]],
            [nextPairs[4], nextPairs[5]],
        ];

        // ★ VERSUS 限定：受け量を「確定(committed)＋予測(anticipated)」の純基準で評価し、
        //   build（本線構築）／fast（カウンター速攻）を自動で切り替える。
        //   ・committed   … 既に自分の garbageQueue に積まれた“これから降る確定おじゃま”（internal含む）。
        //   ・anticipated … 相手がまだ撃っていないが間もなく送ってくる予測量（テト=攻撃ゲージ変換／ぷよ=pendingFire）。
        //   確定が着弾してから降下までは約1秒しか無く、その間に育成→発火は間に合わないため、
        //   発火閾値・モード突入の両方に予測量を加味して“先に”カウンターを仕込む。
        // 思考ログ（_logThink）用：この手の判断の内訳を控える（_updateVersusCounterMode / _updateCounterWait が入れる）
        this._thinkModeFrom = this.cpuMode;
        this._thinkVs       = null;
        this._thinkP2       = null;
        this._thinkP2State  = null;
        const incomingGross = this._getIncomingBaseline();
        this._incomingOjamaGross = incomingGross;
        // H1 催促・H2 対応は思考ごとに _updateVersusCounterMode が入れる（既定＝使わない）
        this._harassMinScore = 0;
        this._harassMinReachScore = 0;
        this._counterKeepReachOn = false;
        this._updateVersusCounterMode(incomingGross);

        // ★ weightsArray を組み立てる（cpu5_weights.js）。発火制御はモード/カウンター側へ移行済み。
        const weightsArray = this._buildWeightsArray(knownNextCount);

        this.worker.postMessage({
            type:           'calculate',
            boardBuffer:    boardBuffer,
            nextPairs:      nextPairs,
            weightsArray:   weightsArray
        });
    },

    _handleWorkerResult(res) {
        this.isCalculating = false;

        this._turnNo = (this._turnNo || 0) + 1;

        if (res[0] === -1) {
            if (this._logEnabled()) console.warn(`${this._logTag(this._turnNo)} 配置候補なし（中央へ落とす）`);
            // 候補なしフォールバック（中央へ素直に落とす）。前倒し計算で falling 前に来た場合も
            // bestMoveData として保持し、着手は _tryStartExecution（falling 限定）に委ねる。
            this.bestMoveData = { col1: 2, rot1: 0, score: 0, col2: -1, rot2: 0, col3: -1, rot3: 0 };
            this._tryStartExecution();
            return;
        }

        // ★ 選択初手への到達操作列(path)を復号する（res[27..29] に 3bit×10/int で packing）。
        //   コード 1=左 2=右 4=回転CW 5=回転CCW（0=終端）。BFS(getAllPlacements)が出した
        //   実機到達経路で、_buildActionQueue がこれを再生して「上部回し」を実現する。
        const path = [];
        if (res.length >= 30) {
            outer:
            for (let w = 0; w < 3; w++) {
                const packed = res[27 + w];
                for (let s = 0; s < 10; s++) {
                    const code = (packed >> (s * 3)) & 0x7;
                    if (code === 0) break outer; // 終端
                    path.push(code);
                }
            }
        }

        // ★ 直近の「理論上いま組める最大潜在連鎖スコア」(res[12]=bestChain) を控える。
        //   VERSUS のカウンター判定で「自分が相殺できるおじゃま量(カバー量)」へ換算するのに使う。
        if (res.length > 12) this._lastBestChain = res[12] || 0;

        this.bestMoveData = {
            col1: res[0], rot1: res[1],
            score: res[2],
            col2: res[3], rot2: res[4],
            col3: res[5], rot3: res[6],
            path: path,
        };

        const evalEl = document.getElementById('eval-value');
        if (evalEl) evalEl.textContent = this.bestMoveData.score;

        if (this.game.currentMode === 'test') {
            this._renderEstimatePlace();
        }

        this._logThink(res);

        // falling 中なら即着手。前倒し計算で falling 前に結果が来た場合は、
        // _updateLoop が falling 突入時に _tryStartExecution を呼んで着手する。
        this._tryStartExecution();
    },

    // ───────────────────────────────────────────────
    // ★ 思考ログ：1手の判断を「見出し1行＋詳細（折りたたみ）」で出す。
    //   見出し＝[側 LV #手数] モード｜発火 or 構築の要点｜受け量。詳細＝探索統計・versus 判断・後打ち判断。
    //   res[7..26][30..32] は build.cpp が書くデバッグ統計（並びは build.cpp outResult の注釈を参照）。
    //   表示する側・展開は cpuLog()（cpu5.js）で切り替える。
    _logThink(res) {
        if (!this._logEnabled()) return;
        const d = res;
        if (!(d.length >= 33) || d[9] < 0) return;   // nCand<0 ＝探索不成立

        const FIRE_REASON = {
            1: '目標到達', 2: '緊急＝本線ほぼ完成', 3: '緊急延命＝最終手段(致死列満杯)',
            4: `催促＝副砲（撃った後の本線潜在 ${d[31]}点／今 ${d[32]}点）`,
        };
        // 到達連鎖[25]=見えた深さ / [26]=出所(1実発火/0潜在)。
        //   潜在＝depthN手後の盤面で「組めば届く」見込み（実発火には別途発火色のツモが必要）。
        const selDepth = d[25];
        const selIsFire = d[26] === 1;
        const selDepthStr = selDepth < 0
            ? '連鎖未到達'
            : selIsFire
                ? (selDepth === 0 ? '実発火・今すぐ' : `実発火・${selDepth}手後`)
                : (selDepth === 0 ? '潜在・現盤面で到達(要発火ツモ)' : `潜在・${selDepth}手後の盤面で到達(要発火ツモ)`);
        const fired = d[15] > 0;
        const reasonStr = FIRE_REASON[d[23]] || '理由不明';

        const from = this._thinkModeFrom, to = this.cpuMode;
        const modeStr = (from && from !== to) ? `★${from}→${to}` : to;
        const p2Str = this._thinkP2State ? `(後打ち:${this._thinkP2State})` : '';
        const act = fired
            ? `★発火 ${d[15]}連鎖 ${d[14]}点（${d[23] === 4 ? '催促' : reasonStr}）`
            : (selDepth < 0
                ? '構築（連鎖未到達）'
                : `構築 到達${d[20]}連鎖(${selIsFire ? '実発火' : '潜在'}・${selDepth}手後)`) +
              (d[24] > 0 ? `／${d[24]}連鎖で整地` : '');
        const inc = this._incomingOjamaGross > 0 ? `｜受け${this._incomingOjamaGross}個` : '';
        const header = `${this._logTag(this._turnNo)} ${modeStr}${p2Str}｜${act}${inc}`;

        const lines = [
            `着手: col=${d[0]} rot=${d[1]}`,
            `探索: nCand=${d[9]} maxDepth=${d[10]} band(同点崩し)=${d[11]}｜PRUNE発動=${d[7]} dedup除去=${d[8]} 致命セル枝刈り=${d[30]}`,
            `選択初手: 到達連鎖selChain=${d[14]} (期待${d[20]}連鎖／${selDepthStr})  base=${d[13]}`,
            `理論上いま撃てる最大: ${d[21]}連鎖 (${d[22]}点)`,
            `差別化: 連鎖を組める初手数 nWithChain=${d[16]}/${d[9]}  bestChain=${d[12]}  base幅(spread)=${d[18]}`,
            `発火: ${fired
                ? `★${d[15]}連鎖を発火（${reasonStr}）`
                : `構築（撃たず）${d[24] > 0 ? `／${d[24]}連鎖で整地` : ''}`}`,
        ];
        if (this._thinkVs) lines.push(this._thinkVs);
        if (this._thinkP2) lines.push(this._thinkP2);

        const cfg = window.__cpuLogCfg || {};
        console[cfg.open ? 'group' : 'groupCollapsed'](header);
        for (const l of lines) console.log(l);
        console.groupEnd();
    },

    // ───────────────────────────────────────────────
    // ★ VERSUS：相手が放った連鎖のグロス着弾量（今降ってくるおじゃま総量）を受け取る。
    //   this.game（＝CPU自身の盤面）の garbageQueue が、相手が sendGarbage で送ってきた
    //   おじゃまをそのまま保持している。表示予告は「相殺後・internal(stage1)除外」だが、
    //   ここでは internal も含めた“これから自分に降ってくる総量”を返す（相手の実火力に相当）。
    //   自分が相殺/着弾で消化すると garbageQueue が減るので、この値も自然に減っていく。
    //   ※ VERSUS 以外（ソロ/テスト）では 0。
    _getIncomingOjamaGross() {
        const game = this.game;
        if (!game || !game.isVersusMode) return 0;
        const q = game.garbageQueue;
        if (!q || q.length === 0) return 0;
        let total = 0;
        for (const g of q) {
            if (g && g.amount > 0) total += g.amount;
        }
        return total;
    },

    // ★ VERSUS：CPU から見た相手インスタンスを返す（CPU は canvasPrefix='cpu' なので相手は window._game）。
    _getOpponentGame() {
        const game = this.game;
        if (!game || !game.isVersusMode) return null;
        return game.canvasPrefix === 'cpu' ? window._game : window._cpuGame;
    },

    // ★ VERSUS：相手がテト（非ぷよ）なら true。相手は PuyoGame のインスタンスでなければテト。
    //   build モードの分岐（build ↔ vsTet）に使う。VERSUS 以外／相手不在では false。
    _isOpponentTet() {
        const opp = this._getOpponentGame();
        return !!opp && !(opp instanceof PuyoGame);
    },

    // ★ VERSUS：相手の garbageQueue に積まれている総量（個）を返す。
    //   相手キューの中身＝CPU が sendGarbage で送り込んだ「自分の発火おじゃま」で、
    //   相手が連鎖を撃つ際は engine._applyOjamaOffset でまずこれを相殺してからでないと
    //   CPU へ届かない。つまり「相手のカウンター火力を吸収する CPU の居座り火力」。
    //   ※ 1v1 では相手キュー＝CPU 送出分のみ。internal/grace 段階も相殺対象なので全量を合算する。
    _getOpponentQueueGross(opp) {
        if (!opp || !opp.garbageQueue || !opp.garbageQueue.length) return 0;
        let total = 0;
        for (const g of opp.garbageQueue) {
            if (g && g.amount > 0) total += g.amount;
        }
        return total;
    },

    // ★ VERSUS：テト相手の「まだ撃っていないが間もなく送ってくる」予測量（個）を返す。
    //   攻撃ゲージ pendingAttack（ライン消去なし設置で放出＝チャージ中は未着弾）を、送信時と同じ
    //   変換テーブル（tet/garbage.js sendGarbage、n>=18 は (n^2-21n+204)/2）でおじゃま個数へ換算。
    //   ※ ぷよ相手の予測（発火中連鎖の全段量）は _updateLoop が控える _oppChainFull を使う（_getIncomingBaseline）。
    _getAnticipatedTetOjama(opp) {
        if (!opp || (opp instanceof PuyoGame)) return 0;
        const gauge = Math.max(0, opp.pendingAttack || 0);
        if (gauge <= 0) return 0;
        const table = [0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68];
        return gauge < table.length
            ? table[gauge]
            : Math.floor((gauge * gauge - 21 * gauge + 204) / 2);
    },

    // ★ VERSUS：ぷよ相手の「いま発火中の連鎖を最後まで打ち切った時の総おじゃま量(個)」を推定する。
    //   連鎖は1段ずつアニメ解決され、火力は連鎖終了まで pendingFire に貯められてから送られる
    //   （engine.js checkErase）。よって途中段で読むと pendingFire はそこまでの段数ぶんしかない。
    //   ここでは相手盤面のコピーに対し残りの連鎖をシミュレートし、全段ぶんのスコア→おじゃま量を出す。
    //   ・段数ボーナスを正しくするため chainCount は相手の現在値から継続する。
    //   ・スコアも相手の累積 attackScore から継続加算する（既に消えた段の火力を含めるため）。
    //   ・点滅中(_erasingCells)の段は attackScore に算入済みだが盤面にまだ残るので、二重計上を避けるため
    //     コピーから先に消して重力を適用してからシミュレートする。
    //   発火していない（settled）盤面は4連結が立たないので 0 を返す（過大評価しない）。
    _estimateOpponentPuyoChainOjama(opp) {
        if (!opp || !opp.field) return 0;
        // ★ PConfig は base.js のトップレベル const（=グローバルレキシカル束縛）。
        //   classic script では const/class は window のプロパティにならないため
        //   window.PConfig は undefined になり、ここで常に return 0 して
        //   「ぷよ相手の発火中連鎖の予測量」が恒久的に 0 になっていた（コンソール予測が常に0）。
        //   同ファイルで bare の PuyoGame が解決できるのと同様、bare の PConfig を直接参照する。
        const PC = PConfig;
        if (!PC) return 0;
        const totalRows = PC.rows + PC.hiddenRows;
        const cols = PC.cols;
        const rate = opp.vsOjamaRate ?? PC.ojamaRate;

        // 盤面コピー
        const f = opp.field.map(row => row.slice());

        // 点滅中の段（算入済み・未消去）はコピーから除去して重力を適用する
        const applyGravity = () => {
            for (let c = 0; c < cols; c++) {
                const stack = [];
                for (let r = totalRows - 1; r >= 0; r--) if (f[r][c] !== 0) stack.push(f[r][c]);
                for (let r = totalRows - 1; r >= 0; r--) {
                    const k = totalRows - 1 - r;
                    f[r][c] = k < stack.length ? stack[k] : 0;
                }
            }
        };

        const cbTab = PC.chainBonusTable, clTab = PC.colorBonusTable, grTab = PC.groupBonusTable;
        const calcGroupsScore = (groups, chainCnt) => {
            let n = 0;
            const usedColors = new Set();
            let groupB = 0;
            for (const g of groups) {
                n += g.length;
                for (const cell of g) usedColors.add(cell.color);
                groupB += grTab[Math.min(g.length, grTab.length - 1)];
            }
            const cb = cbTab[Math.min(Math.max(0, chainCnt - 1), cbTab.length - 1)];
            const colorB = clTab[Math.min(Math.max(0, usedColors.size - 1), clTab.length - 1)];
            const bonus = Math.max(1, cb + colorB + groupB);
            return PC.scoreBase * n * bonus;
        };

        let pendingErasingScore = 0;
        if (opp._erasingCells && opp._erasingCells.length) {
            const erasingGroups = opp.pendingChainGroups || [];
            if (erasingGroups.length > 0 && (opp.pendingFire || 0) === 0 && (opp.generatedOjamaTotal || 0) === 0) {
                pendingErasingScore = calcGroupsScore(erasingGroups, Math.max(1, opp.chainCount || 1));
            }
            for (const cell of opp._erasingCells) {
                if (cell && f[cell.r]) f[cell.r][cell.c] = 0;
            }
            applyGravity();
        }

        let chainCnt = opp.chainCount || 0;
        let score    = (opp.attackScore || 0) + pendingErasingScore;

        for (let iter = 0; iter < 40; iter++) {
            const { groups, ojamaToErase } = opp._findErasableInField(f);
            if (!groups || groups.length === 0) break;
            chainCnt++;

            // _calcChainScore と同じ式でこの段のスコアを算出
            score += calcGroupsScore(groups, chainCnt);

            // 消去して重力
            for (const g of groups) for (const cell of g) if (f[cell.r]) f[cell.r][cell.c] = 0;
            for (const cell of ojamaToErase) if (f[cell.r]) f[cell.r][cell.c] = 0;
            applyGravity();
        }

        return rate > 0 ? Math.floor(score / rate) : 0;
    },

    // ★ VERSUS：カウンター判定の基準受け量＝確定(committed)＋予測(anticipated)。
    //   発火は本来「実際に送られてから」だが、確定着弾→降下まで約1秒しか無く間に合わないため、
    //   予測分も基準に含めて先んじてカウンターを仕込む（ユーザー方針）。
    //
    //   ・ぷよ相手が発火中(_oppChainFull>0)：相殺(engine._applyOjamaOffset)を織り込んだ
    //     「ネット受け量」を計算する。相殺カスケードは次の順で起きる:
    //       ① CPU 自身の未送出火力(pendingFire)が、まず自分の受けキュー(committed)を相殺する。
    //       ② 相殺しきれず余った CPU 火力(leftoverSelfFire)は相手キューへ回り、相手の火力を吸収する。
    //       ③ 既に相手キューに居る CPU 送出分(oppQueueGross)も相手の火力を吸収する。
    //       ④ 相手の残り火力(全段見込み − 既送出分) が ②③の吸収を上回った差分だけが CPU に届く。
    //     例: CPU が先に9連鎖を放つと oppQueueGross が大きく、相手の8連鎖は全て吸収され
    //         anticipated=0（fast に入らない）。相手が11連鎖なら差分のみ anticipated に乗る。
    //   ・それ以外（ぷよ相手が非発火／テト相手）：確定＝キュー総量、予測＝テトゲージ換算 or 0。
    _getIncomingBaseline() {
        const game = this.game;
        if (!game || !game.isVersusMode) return 0;

        const grossQueue   = this._getIncomingOjamaGross();
        const opp          = this._getOpponentGame();
        const oppChainFull = this._oppChainFull || 0;

        let committed, anticipated;
        if (opp && (opp instanceof PuyoGame) && oppChainFull > 0) {
            // ── 相殺カスケード（個単位）──
            const selfFire         = Math.max(0, game.pendingFire || 0);          // CPU 未送出火力
            const oppQueueGross    = this._getOpponentQueueGross(opp);            // CPU 既送出（相手キュー）
            const oppGenerated     = Math.max(0, opp.generatedOjamaTotal || 0);   // 相手が既に送った分

            const committedNet     = Math.max(0, grossQueue - selfFire);          // ①自キュー相殺後
            const leftoverSelfFire = Math.max(0, selfFire - grossQueue);          // ②相手へ回る余剰
            const absorbAtOpp      = oppQueueGross + leftoverSelfFire;            // ②③相手側の吸収力
            const oppRemainingFire = Math.max(0, oppChainFull - oppGenerated);    // 相手の残り火力(二重計上回避)

            committed   = committedNet;
            anticipated = Math.max(0, oppRemainingFire - absorbAtOpp);            // ④届く差分

            // デバッグ内訳（コンソール表示用）
            this._offsetDbg = { selfFire, committedNet, leftoverSelfFire, oppQueueGross, absorbAtOpp, oppChainFull, oppRemainingFire };
        } else {
            anticipated = this._getAnticipatedTetOjama(opp);
            committed   = grossQueue;
            this._offsetDbg = null;
        }

        this._committedOjama   = committed;
        this._anticipatedOjama = anticipated;
        return committed + anticipated;
    },

    // ★ VERSUS：受け取ったグロス着弾量に応じて build ↔ fast(カウンター) を切り替える。
    //   方針（ユーザー要望「相手発火→受けおじゃま量を逆算→上回る連鎖で返す」）:
    //     ・受け量が一定個数（COUNTER_TRIGGER_OJAMA）を超えたら fast(カウンター)へ。
    //       ※ かつては「受け量 > 自分の潜在連鎖カバー」で判定していたが、カバー量の素となる
    //         bestChain は“まだ撃っていない潜在連鎖スコア”ゆえ育成中は過大評価され、
    //         coverage が受け量を恒常的に上回って実質カウンターが発動しなかった。
    //         よって受け量そのもののしきい値判定に変更（カバー量は表示の参考値としてのみ残す）。
    //     ・受け量は「確定(committed=garbageQueue) ＋ 予測(anticipated=相手の未送出火力)」の純基準。
    //       確定着弾→降下まで約1秒しか無く育成→発火が間に合わないため、予測分も基準に含めて
    //       モード突入・発火閾値を先んじて設定する（ユーザー方針）。
    //     ・カウンター時は発火目標を「基準受け量を上回る連鎖」に設定（fireChainCount=0＝段数では撃たず、
    //       受け量超えスコアだけを発火条件にする）。盤面が緊急になれば fast プロファイルの
    //       emergencyFireMinRatio=0 により出せる最大連鎖を緊急発火する。
    //   ヒステリシス：一度カウンターに入ったら受け量が尽きる(0)まで継続し、build へ戻る。
    //   ※ VERSUS 以外では何もしない（手動 setMode を尊重）。
    //   ※ ゲーム側仕様：1回に降るおじゃまは最大30個（ojama.js limit=30）。受け量はキュー総量なので
    //     30 を超えうるが、しきい値はその範囲内の小さな値で十分。
    _updateVersusCounterMode(incomingGross) {
        const game = this.game;
        if (!game || !game.isVersusMode) return;

        // カウンター発動の受け量しきい値（これ「を超えたら」fast へ）。
        //   ★ 相手別に分ける（build↔fast の発動条件を vsTet で独立させる）：
        //     ・対ぷよ(build)：相手の連鎖は相殺で受けやすく、無理に速攻へ振らない＝高め。
        //     ・対テト(vsTet)：おじゃま着弾が早く相殺猶予が乏しい＝低め＝早めにカウンターへ。
        //   ⚠️ 暫定値＝実機で要チューニング（[[feedback-versus-cpu-verification]]）。
        const COUNTER_TRIGGER_OJAMA_VSPUYO = 5;
        const COUNTER_TRIGGER_OJAMA_VSTET  = 6;
        // ★ 派生クラス（puyo lv6＝学習済み重み）が対ぷよの定数だけ差し替える口。lv5 自身は未設定＝上の値のまま。
        const ov = this._counterOverrides || {};
        const COUNTER_TRIGGER_OJAMA = this._isOpponentTet()
            ? COUNTER_TRIGGER_OJAMA_VSTET
            : (ov.triggerVsPuyo ?? COUNTER_TRIGGER_OJAMA_VSPUYO);

        // ★ カウンター発火スコアの相手別倍率（受け量に対しどれだけ上回って返すか）。
        //   fireScoreThreshold = (受け量+1) × rate × margin。
        //     ・対ぷよ(build)：返すこと優先＝ぎりぎり上回れば撃つ（1.0）。
        //     ・対テト(vsTet)：余裕を持って返す＝大きめに上回らせてから撃つ（>1.0）。
        //   ⚠️ 暫定値＝実機で要チューニング（[[feedback-versus-cpu-verification]]）。
        const COUNTER_MARGIN_VSPUYO = 1.0;
        const COUNTER_MARGIN_VSTET  = 1.3;

        const rate = game.vsOjamaRate ?? PConfig.ojamaRate;

        // 自分が今いつでも組める最大潜在連鎖で相殺できるおじゃま量（カバー量）。
        //   ※ 判定には使わず、コンソール表示の参考値としてのみ算出する。
        const coverScore = this._lastBestChain || 0;
        const coverage   = Math.floor(coverScore / rate);

        // ★ 後打ちの活用（提案2）。lv5 は未設定（_vsDecision なし）＝従来どおり。lv6 が有効にする。
        if (this._updateCounterWait(incomingGross, rate)) return;

        let wantCounter;
        if (this._counterActive) {
            wantCounter = incomingGross > 0;                       // 受け量が尽きるまで継続
        } else {
            wantCounter = incomingGross > COUNTER_TRIGGER_OJAMA;   // しきい値超えで発動
        }

        const prevMode = this.cpuMode;

        // 適用したカウンター倍率（ログ表示用。非カウンター時は 1.0）。
        let appliedMargin = 1.0;

        // カウンター（速攻）モードも相手別に分ける：対テトは fastVsTet、対ぷよは fast。
        //   fast↔fastVsTet は cpu5_modes.js で独立した重みプロファイル＝互いに波及しない。
        const counterMode = this._isOpponentTet() ? 'fastVsTet' : 'fast';

        if (wantCounter) {
            if (this.cpuMode !== counterMode) this.setMode(counterMode);
            this._counterActive = true;
            // ★ カウンター閾値：発火スコア閾値を「受け量を上回る連鎖」に設定する。
            //   おじゃま量 incomingGross+1 個ぶんの連鎖スコア = (incomingGross+1) × rate。
            //   段数トリガ(fireChainCount)は切り、この受け量超えスコアだけを発火条件にする。
            //   ★ 相手別倍率：対テトは余裕を持って返す（>1.0）、対ぷよは返す優先（1.0）。
            const margin = this._isOpponentTet() ? COUNTER_MARGIN_VSTET : (ov.marginVsPuyo ?? COUNTER_MARGIN_VSPUYO);
            appliedMargin = margin;
            this.controlWeights.fireChainCount     = 0;
            this.controlWeights.fireScoreThreshold = Math.ceil((incomingGross + 1) * rate * margin);
            this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);
            // ★ H2 対応（対ぷよのみ）：受け量を上回る候補のうち、撃った後の本線潜在が最大の手で返す。
            //   カウンターは fast（lv5 基準）の重みなので、有効かどうかは build の重み（lv6 が設定）から読む。
            const bc = this._buildBaseline && this._buildBaseline.controlWeights;
            this._counterKeepReachOn = !this._isOpponentTet() && !!(bc && bc.counterKeepReach);
        } else {
            // カウンター不要時の本線構築モード：相手がテトなら vsTet、それ以外（ぷよ）は build。
            const buildMode = this._isOpponentTet() ? 'vsTet' : 'build';
            if (this.cpuMode !== buildMode) this.setMode(buildMode);
            this._counterActive = false;
            // ★ H1 催促（対ぷよのみ）：相手が連鎖中でないとき、本線を残したまま撃てる小連鎖を撃つ候補にする。
            //   条件（段数・残す本線の割合）は wasm の fire gate（build.cpp ③）。学習用シミュ player.cpp decide と同じ判断。
            const opp = this._getOpponentGame();
            const minOjama = this.controlWeights.harassMinOjama || 0;
            if (minOjama > 0 && opp instanceof PuyoGame && !(opp.chainCount > 0)) {
                this._harassMinScore = minOjama * rate;
                this._harassMinReachScore = (this.controlWeights.harassMinReach || 0) * rate;
            }
        }

        // ── コンソール表示：モードが実際に切り替わっているか／カウンター閾値を可視化 ──
        //   受け量がある間（またはカウンター継続中・切替発生時）は毎手ログを出す。
        //   受け量0で build のときは静かにする（ログのスパム防止）。
        const modeChanged = (prevMode !== this.cpuMode);
        if (incomingGross > 0 || this._counterActive || modeChanged) {
            const thr       = this.controlWeights.fireScoreThreshold;
            const thrOjama  = rate > 0 ? Math.floor(thr / rate) : 0;
            const committed = this._committedOjama   ?? incomingGross;
            const antic     = this._anticipatedOjama ?? 0;
            const tag       = modeChanged ? `★切替 ${prevMode} → ${this.cpuMode}` : `mode=${this.cpuMode}`;
            // 予測=相手の発火中連鎖を全段打ち切った時の見込みおじゃま総量（途中段でも全段ぶん）。
            //   相殺込みのネット受け量。相殺内訳(_offsetDbg)があれば併記する。
            const od = this._offsetDbg;
            const offsetStr = od
                ? `｜相殺[相手連鎖${od.oppChainFull}−吸収${od.absorbAtOpp}(相手キュー${od.oppQueueGross}+自余剰${od.leftoverSelfFire})＝届く${antic}]`
                : '';
            this._thinkVs = (
                `versus: ${tag}｜ネット受け量=${incomingGross}個(既着弾/確定待ち${committed}+予測${antic}〔全段見込み〕, 発動>${COUNTER_TRIGGER_OJAMA})${offsetStr} / 自カバー(参考)=${coverage}個` +
                (this._counterActive
                    ? `｜カウンター発火閾値=${thr}点(≒${thrOjama}個＝差分+αを上回ったら発火, 倍率×${appliedMargin}${this._isOpponentTet() ? '対テト' : '対ぷよ'}, mode=${this.cpuMode})`
                    : `｜発火閾値=${thr}点(標準)`)
            );
        }
    },

    // ───────────────────────────────────────────────
    // ★ 後打ちの活用（提案2。設計: source_assets/memory/cpu/puyo/lv5-vs-decision-design.md §2）
    //   相手のおじゃまは「相手の連鎖終了で ready → 自分の手の終わりに降る」。よって相手の連鎖中は、
    //   撃たない手が相手の連鎖終了より前に終わる限り降らない。その間は本線(build)の重みで伸ばし、
    //   ・今撃てる最大が受け量×fireIfPct% 以上になったら撃つ（wasm の fire gate＝fireScoreThreshold）
    //   ・間に合わなくなった手（締切）では撃てる最大を撃つ（閾値 1）
    //   有効化は this._vsDecision.p2（lv6 が設定）。相手がテトのときは対象外。
    //   処理したら true を返す（呼び出し元の従来カウンター判定は行わない）。
    //   学習用シミュ（training/puyo-lv5/sim/player.cpp decide）と同じ判断にすること。
    _updateCounterWait(incomingGross, rate) {
        const p2 = this._vsDecision && this._vsDecision.p2;
        if (!p2) return false;
        const opp = this._getOpponentGame();
        if (!opp || !(opp instanceof PuyoGame) || !(opp.chainCount > 0)) return false;
        if (incomingGross < Math.max(1, p2.minIncoming)) return false;
        const remainMs = this._estimateOpponentChainEndMs(opp);
        if (!(remainMs > 0)) return false;

        // 答え合わせ用に「この時点の予測」を控える（_watchOpponentChain が連鎖終了時に実際と比べる）
        if (this._oppChainWatch) this._oppChainWatch.preds.push({ at: performance.now(), remainMs });

        const dropSoon = this._hasDroppableGarbageWithin(p2.turnMs);
        const wait     = !dropSoon && p2.turnMs + p2.safetyMs < remainMs;

        const prevMode = this.cpuMode;
        if (this.cpuMode !== 'build') this.setMode('build');
        this._counterActive = true;   // 撃った後は従来のヒステリシス（受け量が尽きるまでカウンター）
        const cw = this.controlWeights;
        if (wait) {
            cw.fireChainCount     = 0;   // 目標発火は切る（緊急発火は残る）
            cw.fireScoreThreshold = p2.fireIfPct > 0 ? Math.ceil((incomingGross + 1) * rate * p2.fireIfPct / 100) : 0;
        } else {
            cw.fireChainCount     = 1;   // 締切：撃てる最大を撃つ
            cw.fireScoreThreshold = 1;
        }
        this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);

        const thr = cw.fireScoreThreshold;
        this._thinkP2State = wait ? '待つ' : '締切';
        this._thinkP2 = (
            `後打ち: ${wait ? '待つ（伸ばす）' : '締切 → 撃てる最大'}` +
            `｜相手連鎖の残り ${(remainMs / 1000).toFixed(2)}s（1手 ${p2.turnMs}ms+余裕 ${p2.safetyMs}ms${dropSoon ? '・既に降る分あり' : ''}）` +
            `｜受け量=${incomingGross}個` +
            (wait ? `｜即撃ち閾値=${thr}点(≒${Math.floor(thr / rate)}個)` : '') +
            (prevMode !== this.cpuMode ? `｜★切替 ${prevMode} → build` : '')
        );
        return true;
    },

    // ★ ぷよ相手の発火中連鎖が終わる（＝送ったおじゃまが ready になる）までの残り ms。発火中でなければ -1。
    //   ① 今の段階（_gs と各タイマー）の残り ＋ ② 落下を終えた盤面から残りの段を回した時間。
    //   落下中（eraseWait/dropping）のぷよは盤面から外れて _dropAnim にあるので、着地位置に戻して回す。
    _estimateOpponentChainEndMs(opp) {
        if (!opp || !(opp instanceof PuyoGame) || !(opp.chainCount > 0) || !opp.field) return -1;
        const PC  = PConfig;
        const DROP_MS_PER_ROW = 50;                            // engine.js _stepDropAnim（cellSize/50 px/ms）
        const vib = (cycles) => cycles * 4 * PC.vibPhaseMs;   // engine.js _addPuyoAnim
        const f   = opp.field.map(row => row.slice());
        let t;
        switch (opp._gs) {
            case 'erasing': {
                for (const cell of (opp._erasingCells || [])) if (cell && f[cell.r]) f[cell.r][cell.c] = 0;
                const d = this._applyGravityForTiming(f);
                t = Math.max(0, PC.eraseMs - (opp._eraseTimer || 0)) + PC.eraseWaitMs +
                    (d.moved ? d.maxDist * DROP_MS_PER_ROW + vib(d.vibCycles) + PC.fixWait5fMs : 0);
                break;
            }
            case 'eraseWait':
            case 'dropping': {
                const anim = opp._dropAnim;
                let dropRem = 0, cycles = 0;
                if (anim) {
                    const speed = PC.cellSize / DROP_MS_PER_ROW;   // engine.js _stepDropAnim
                    for (const col of anim) {
                        for (const cell of col.cells) {
                            f[cell.toR][col.c] = cell.color;
                            const targetY = (cell.toR - PC.hiddenRows) * PC.cellSize;
                            const py = (cell.py ?? (cell.fromR - PC.hiddenRows) * PC.cellSize);
                            dropRem = Math.max(dropRem, (targetY - py) / speed);
                            if (cell.color !== 6) cycles = Math.max(cycles, (cell.toR - cell.fromR) >= 2 ? 4 : 3);
                        }
                    }
                }
                t = (opp._gs === 'eraseWait' ? Math.max(0, PC.eraseWaitMs - (opp.eraseWaitTimer || 0)) : 0) +
                    (anim ? Math.max(0, dropRem) + vib(cycles) + PC.fixWait5fMs : 0);
                break;
            }
            case 'fixAnim':
                t = Math.max(0, (opp.fixAnimDuration || 0) - (opp.fixAnimTimer || 0)) + PC.fixWait5fMs;
                break;
            case 'fixWait5f':
                t = Math.max(0, PC.fixWait5fMs - (opp.fw5fTimer || 0));
                break;
            case 'checkErase':
                t = 0;
                break;
            default:
                return -1;   // 連鎖は終わっている（spawnAnim など）
        }
        return t + this._puyoChainRemainingMs(f, (fld) => opp._findErasableInField(fld));
    },

    // ★ 予測の答え合わせ：相手ぷよの連鎖を開始〜終了まで見張り、終了時に1行ログを出す。
    //   ・受け量：連鎖を見つけた時の推定(_estimateOpponentPuyoChainOjama) と、実際に生んだ量
    //     （相手の generatedOjamaTotal。連鎖終了の checkErase で 0 に戻るため、連鎖中の最大を取る）。
    //   ・終了時刻：連鎖を見つけた時と、後打ち(p2)で判断した各時点の _estimateOpponentChainEndMs と、実際の終了。
    //     実際の終了＝相手の _gs が連鎖中の段階を抜けたフレーム（RAF 単位なので ±1フレームの誤差を含む）。
    //     差が − ＝予測より早く終わった＝後打ちで待ちすぎる側（おじゃまが降る危険）。
    //   _updateLoop が毎フレーム呼ぶ（VERSUS かつ worker 準備済みのとき）。opp はぷよ相手のときだけ渡る。
    _watchOpponentChain(opp) {
        const CHAIN_GS = ['erasing', 'eraseWait', 'dropping', 'fixAnim', 'fixWait5f', 'checkErase'];
        const inChain = !!opp && opp.chainCount > 0 && CHAIN_GS.includes(opp._gs);
        const w = this._oppChainWatch;
        const now = performance.now();
        if (inChain) {
            if (!w) {
                this._oppChainWatch = {
                    startAt:    now,
                    endEstMs:   this._estimateOpponentChainEndMs(opp),
                    ojamaEst:   this._estimateOpponentPuyoChainOjama(opp),
                    maxGen:     opp.generatedOjamaTotal || 0,
                    maxChain:   opp.chainCount,
                    preds:      [],
                };
            } else {
                w.maxGen   = Math.max(w.maxGen, opp.generatedOjamaTotal || 0);
                w.maxChain = Math.max(w.maxChain, opp.chainCount);
            }
            if (this.game && this.game.isPaused) this._oppChainWatch.paused = true;   // 時間の比較が狂う
            return;
        }
        if (!w) return;
        this._oppChainWatch = null;
        if (!opp || !this._logEnabled()) return;   // 相手が居なくなった（試合終了など）ときは出さない

        const fmtErr = (predEndAt) => {
            const e = Math.round(now - predEndAt);
            return `${e >= 0 ? '+' : ''}${e}ms${e < 0 ? '(早い⚠)' : ''}`;
        };
        const sec = (ms) => (ms / 1000).toFixed(2) + 's';
        const actualMs = now - w.startAt;
        const ojDiff = w.maxGen - w.ojamaEst;
        let line =
            `${this._logTag()} 答え合わせ: 相手の${w.maxChain}連鎖` +
            `｜受け量 予測${w.ojamaEst}個→実際${w.maxGen}個${ojDiff ? `（差${ojDiff > 0 ? '+' : ''}${ojDiff}）` : '（一致）'}` +
            (w.endEstMs >= 0
                ? `｜終了 予測${sec(w.endEstMs)}→実際${sec(actualMs)}（${fmtErr(w.startAt + w.endEstMs)}）`
                : '');
        if (w.preds.length) {
            line += `｜後打ち判断時: ` + w.preds
                .map(p => `残り${sec(p.remainMs)}→${sec(now - p.at)}（${fmtErr(p.at + p.remainMs)}）`)
                .join(' / ');
        }
        if (w.paused) line += '｜途中で一時停止あり（時間は参考外）';
        console.log(line);
    },

    // ★ 次の消去判定を待つ盤面 f から、連鎖が終わる（消えるものが無くなる判定）までの ms（純関数・f を書き換える）。
    //   1段 = eraseMs ＋ eraseWaitMs ＋（落下があれば 落下段数×50 ＋ 振動 ＋ fixWait5fMs）。
    //   findErasable は engine.js _findErasableInField と同じもの（Node の一致テストでもそれを渡す）。
    _puyoChainRemainingMs(f, findErasable) {
        const PC = PConfig;
        const DROP_MS_PER_ROW = 50;   // engine.js _stepDropAnim（cellSize/50 px/ms）
        let t = 0;
        for (let iter = 0; iter < 40; iter++) {
            const { groups, ojamaToErase } = findErasable(f);
            if (!groups || groups.length === 0) break;
            for (const g of groups) for (const cell of g) f[cell.r][cell.c] = 0;
            for (const cell of ojamaToErase) f[cell.r][cell.c] = 0;
            const d = this._applyGravityForTiming(f);
            t += PC.eraseMs + PC.eraseWaitMs;
            if (d.moved) t += d.maxDist * DROP_MS_PER_ROW + d.vibCycles * 4 * PC.vibPhaseMs + PC.fixWait5fMs;
        }
        return t;
    },

    // 全段の重力。落下アニメの時間計算用に {moved, maxDist, vibCycles} を返す（engine.js _buildDropAnim と同じ落下量）。
    _applyGravityForTiming(f) {
        const PC = PConfig;
        const totalRows = PC.rows + PC.hiddenRows;
        let moved = false, maxDist = 0, vibCycles = 0;
        for (let c = 0; c < PC.cols; c++) {
            let emptyBelow = 0;
            for (let r = totalRows - 1; r >= 0; r--) {
                const v = f[r][c];
                if (v === 0) { emptyBelow++; continue; }
                if (emptyBelow === 0) continue;
                moved = true;
                maxDist = Math.max(maxDist, emptyBelow);
                if (v !== 6) vibCycles = Math.max(vibCycles, emptyBelow >= 2 ? 4 : 3);
                f[r + emptyBelow][c] = v;
                f[r][c] = 0;
            }
        }
        return { moved, maxDist, vibCycles };
    },

    // 自分のおじゃまキューに「ms 後の手の終わりまでに降れる」量があるか（ready かつ 非表示期間がそれまでに明ける）
    _hasDroppableGarbageWithin(ms) {
        const q = this.game && this.game.garbageQueue;
        if (!q) return false;
        return q.some(g => g && g.ready && g.amount > 0 && (!g.internal || (g.internalTimer ?? 0) <= ms));
    },

    // bestMoveData があり、操作可能(falling)かつ未着手なら着手を開始する。
    // 前倒し計算（spawnAnim 中に結果到着）では falling になるまで着手を保留する。
    _tryStartExecution() {
        if (!this.isAutoPlay || !this.isActive || !this.bestMoveData) return;
        if (!this.game || this.game.isPaused) return;
        if (this.game._gs !== 'falling') return;
        if (this.isExecutingAction) return;
        this._executeMove(this.bestMoveData.col1, this.bestMoveData.rot1, this.bestMoveData.path);
    },
});

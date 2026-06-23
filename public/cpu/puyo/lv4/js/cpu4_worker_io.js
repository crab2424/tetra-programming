// ─────────────────────────────────────────────
// cpu4_worker_io.js（Worker / Wasm 連携）
//   PuyoCPU4.prototype を拡張する（cpu4.js が class 本体を定義済みであること）。
//
//   _requestCalculation()  … 盤面/NEXT/重みをバッファ化して Worker へ postMessage
//   _handleWorkerResult()  … Wasm の探索結果を受け取り、bestMoveData 反映・着手開始
// ─────────────────────────────────────────────

Object.assign(window.PuyoCPU4.prototype, {

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
        //     渡るものの参照しない（cpu4.cpp で w.knownNextCount に代入されるだけのデッド配線）。
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
        const incomingGross = this._getIncomingBaseline();
        this._incomingOjamaGross = incomingGross;
        this._updateVersusCounterMode(incomingGross);

        // ★ weightsArray を組み立てる（cpu4_weights.js）。発火制御はモード/カウンター側へ移行済み。
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

        if (res[0] === -1) {
            console.warn('PuyoCPU: 配置候補なし');
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

        // falling 中なら即着手。前倒し計算で falling 前に結果が来た場合は、
        // _updateLoop が falling 突入時に _tryStartExecution を呼んで着手する。
        this._tryStartExecution();
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

        // カウンター発動の受け量しきい値（これ「を超えたら」発動）。
        const COUNTER_TRIGGER_OJAMA = 5;

        const rate = game.vsOjamaRate ?? PConfig.ojamaRate;

        // 自分が今いつでも組める最大潜在連鎖で相殺できるおじゃま量（カバー量）。
        //   ※ 判定には使わず、コンソール表示の参考値としてのみ算出する。
        const coverScore = this._lastBestChain || 0;
        const coverage   = Math.floor(coverScore / rate);

        let wantCounter;
        if (this._counterActive) {
            wantCounter = incomingGross > 0;                       // 受け量が尽きるまで継続
        } else {
            wantCounter = incomingGross > COUNTER_TRIGGER_OJAMA;   // しきい値超えで発動
        }

        const prevMode = this.cpuMode;

        if (wantCounter) {
            if (this.cpuMode !== 'fast') this.setMode('fast');
            this._counterActive = true;
            // ★ カウンター閾値：発火スコア閾値を「受け量を上回る連鎖」に設定する。
            //   おじゃま量 incomingGross+1 個ぶんの連鎖スコア = (incomingGross+1) × rate。
            //   段数トリガ(fireChainCount)は切り、この受け量超えスコアだけを発火条件にする。
            this.controlWeights.fireChainCount     = 0;
            this.controlWeights.fireScoreThreshold = (incomingGross + 1) * rate;
            this.weights = Object.assign({}, this.rewardWeights, this.evalWeights, this.controlWeights);
        } else {
            if (this.cpuMode !== 'build') this.setMode('build');
            this._counterActive = false;
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
            console.log(
                `[cpu4 versus] ${tag}｜ネット受け量=${incomingGross}個(既着弾/確定待ち${committed}+予測${antic}〔全段見込み〕, 発動>${COUNTER_TRIGGER_OJAMA})${offsetStr} / 自カバー(参考)=${coverage}個` +
                (this.cpuMode === 'fast'
                    ? `｜カウンター発火閾値=${thr}点(≒${thrOjama}個＝差分+αを上回ったら発火)`
                    : `｜発火閾値=${thr}点(標準)`)
            );
        }
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

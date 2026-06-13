// ─────────────────────────────────────────────
// build/build.cpp — 「build（連鎖を組む）」モードの探索本体
// ─────────────────────────────────────────────
#include "build/build.h"
#include "core/chain.h"
#include "eval/eval.h"
#include "search/node.h"

#include <algorithm>
#include <climits>
#include <vector>

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 期待連鎖スコア選択（Ama search_multi 移植・核心①）
//   複数の擬似未来ツモ列でビーム探索し、各初手の subtree で実際に到達できた
//   最大連鎖スコアをキュー横断で合算 → 「期待連鎖スコア」として初手評価へ加算する。
//   既存の累積eval（盤面評価＋発火報酬）は初手の baseScore として保持し、その上に
//   expChainWeight×期待連鎖スコアを上乗せして初手を選ぶ。expChainWeight==0 のときは
//   この関数は呼ばれない（従来の累積eval最大選択のまま）。
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/beam.cpp search_multi
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 以下は「上限（コンパイル時の配列サイズ／ループ天井）」。実際に使う本数・深さ・幅は
// JS から渡す w.expBranch / w.expMaxDepth / w.expBeamW で実行時に絞れる（速度調整用）。
static const int EXP_BRANCH   = 6;   // 擬似未来ツモ列の本数 上限（Ama準拠の6固定bag）
static const int EXP_MAXDEPTH = 8;   // 期待連鎖探索の深さ 上限
static const int EXP_MAXCAND  = 24;  // 初手candidate最大数（6列×4回転）

// Ama get_queue_random と同じ6本の固定bag（色順を無視した全ペア種網羅）。
// id 0..3 を実色 1..4 にマップして使う。
static const uint8_t EXP_BAG[EXP_BRANCH][4] = {
    {0,1,2,3},{0,2,1,3},{0,3,1,2},{1,2,0,3},{1,3,0,2},{2,3,0,1}
};

struct ExpCandidate {
    int col, rot;
    int depth0Score;                  // 初手単独の評価（フォールバック用）
    long long bestAccum;              // 既存ビーム相当の累積eval最大（深い手まで考慮した baseScore）
    int col2, rot2, col3, rot3;       // 表示用の先読み（最深ノードを辿って取得）
    long long expSum;                 // キュー横断の連鎖スコア合算（期待連鎖スコア×本数）

    // ── 表示用先読み(col2/col3)を辿るための補助 ──
    //   col2/col3 を「累積eval最大ノード」に紐付けると、初手が連鎖を発火したとき
    //   depth0 ノードが累積最大になり col2/col3=-1 のまま残る（estimateがstep1だけになる）。
    //   そこで選択用の bestAccum とは分離し、表示は「実際に最も深く辿れたノード」から拾う。
    int dispDepth;                    // col2/col3 を捕捉したノードの深さ（深いほど優先）
    long long dispScore;              // 同深さ内での比較用（累積eval最大を採用）
};

static int expBeamWidth(int depth, int cfgWidth) {
    // depth0 は全初手をシードするため広く、以降は性能予算で絞る（連鎖記録は枝刈り前に行う）。
    if (depth == 0) return EXP_MAXCAND;  // 全初手を必ず展開
    // cfgWidth>0 なら depth>=1 をその値で一律に絞る（JSで速度調整）。0 は従来のテーパ。
    if (cfgWidth > 0) return cfgWidth;
    if (depth == 1) return 12;
    if (depth == 2) return 8;
    if (depth == 3) return 6;
    return 5;
}

static void runExpectedChainSelection(
    const BitBoard& baseBoard,
    int* nextPairs,
    const EvalWeights& w,
    int* outResult
) {
    // ── 速度調整パラメータ（JSから設定。0/未指定なら上限＝従来の重い設定）──
    int branchCount = (w.expBranch   > 0) ? std::min(w.expBranch,   EXP_BRANCH)   : EXP_BRANCH;
    int maxDepth    = (w.expMaxDepth > 0) ? std::min(w.expMaxDepth, EXP_MAXDEPTH) : EXP_MAXDEPTH;
    int cfgWidth    = w.expBeamW;   // 0=従来テーパ / >0=depth>=1 を一律この幅に

    // 既知ツモのペア数（現在ペア=depth0 を含む）。これ以降の depth は擬似bagで分岐する。
    int knownPairs = 1 + std::max(0, std::min(w.knownNextCount, maxDepth - 1));

    ExpCandidate cands[EXP_MAXCAND];
    int  nCand = 0;
    int  fmLookup[EXP_MAXCAND * 4];   // key = col*4+rot → fm index（-1=未登録）
    for (int i = 0; i < EXP_MAXCAND * 4; i++) fmLookup[i] = -1;

    // ── 1段ぶんビームを進める共通処理 ──
    //   chainTarget[fm] にこの段で到達した連鎖スコアの最大を記録。
    //   registerFirst: depth0 で初手candidateを登録。captureBase: baseScore/先読みを確定。
    auto stepDepth = [&](std::vector<SearchNode>& cur, int pivot, int child, int depth,
                         long long* chainTarget, bool registerFirst, bool captureBase) {
        std::vector<SearchNode> nextNodes;
        int beamWidth = expBeamWidth(depth, cfgWidth);

        for (const auto& node : cur) {
            std::vector<PairPlacement> placements = getAllPlacements(node.board);
            if (placements.empty()) {
                SearchNode deathNode = node;
                deathNode.accumulatedScore -= 999999;
                nextNodes.push_back(deathNode);
                continue;
            }

            bool isEmergencyPre = false;
            int avgH = 0, col2H = 0;
            for (int c = 0; c < COLS; c++) {
                int h = 0;
                for (int r = HIDDEN; r < TOTAL_ROWS; r++) if (node.board.get(c, r) != 0) h++;
                avgH += h;
                if (c == 2) col2H = h;
            }
            avgH /= COLS;
            if (avgH >= w.emergencyHeight || col2H >= 9) isEmergencyPre = true;

            PotentialInfo prePot = calcChainPotential(node.board);

            for (const auto& p : placements) {
                BitBoard nb = applyPlacement(node.board, p, (uint8_t)pivot, (uint8_t)child);
                ChainResult chain = simulateChain(nb);

                int scoreRaw = evaluateBoard(nb, chain, w, prePot, isEmergencyPre);
                // ★ ちぎり(tear)ペナルティ：配置時1回（評価値ではなく配置コスト）。
                //   scoreRaw に足し込むことで、以降の p1Weight/深さ減衰を eval と同様に受ける。
                if (w.tearWeight != 0) scoreRaw += placementTear(p) * w.tearWeight;
                int score = scoreRaw;
                if (depth == 0) score = score * w.p1Weight / 100;
                for (int i = 0; i < depth; i++) score = (score * 9) / 10;

                SearchNode nn = node;
                nn.board = nb;
                nn.accumulatedScore += score;

                int fm;
                if (registerFirst) {
                    int key = p.col * 4 + p.rot;
                    if (key < 0 || key >= EXP_MAXCAND * 4) continue;
                    fm = fmLookup[key];
                    if (fm < 0) {
                        if (nCand >= EXP_MAXCAND) continue;
                        fm = nCand++;
                        fmLookup[key] = fm;
                        cands[fm].col = p.col; cands[fm].rot = p.rot;
                        cands[fm].depth0Score = score;
                        cands[fm].bestAccum = LLONG_MIN;
                        cands[fm].col2 = -1; cands[fm].rot2 = -1;
                        cands[fm].col3 = -1; cands[fm].rot3 = -1;
                        cands[fm].expSum = 0;
                        cands[fm].dispDepth = -1;
                        cands[fm].dispScore = LLONG_MIN;
                    }
                    nn.firstMoveIndex = fm;
                    nn.col1 = p.col; nn.rot1 = p.rot;
                } else {
                    fm = node.firstMoveIndex;
                    if (depth == 1)      { nn.col2 = p.col; nn.rot2 = p.rot; }
                    else if (depth == 2) { nn.col3 = p.col; nn.rot3 = p.rot; }
                }

                if (fm >= 0 && chain.score > 0 && (long long)chain.score > chainTarget[fm]) {
                    chainTarget[fm] = chain.score;
                }

                nextNodes.push_back(nn);
            }
        }

        std::sort(nextNodes.begin(), nextNodes.end(), [](const SearchNode& a, const SearchNode& b) {
            return a.accumulatedScore > b.accumulatedScore;
        });
        if ((int)nextNodes.size() > beamWidth) nextNodes.resize(beamWidth);
        cur = nextNodes;

        // baseScore（深い手まで考慮した累積eval最大）と表示用先読みを確定
        if (captureBase) {
            for (const auto& nd : cur) {
                int fm = nd.firstMoveIndex;
                if (fm < 0 || fm >= nCand) continue;

                // ① 選択用 baseScore：累積eval最大（従来どおり）。
                if ((long long)nd.accumulatedScore > cands[fm].bestAccum) {
                    cands[fm].bestAccum = nd.accumulatedScore;
                }

                // ② 表示用先読み col2/col3：累積最大ではなく「最も深く辿れたノード」を採用する。
                //   col2/col3 は depth1/depth2 を通過したノードにのみ載る（節点が経路として保持）。
                //   累積最大に紐付けると初手発火時に depth0 が勝ち col2/col3=-1 のまま残るため分離。
                //   深さ優先（深いほど確かな先読み）／同深さなら累積eval最大を採用する。
                if (depth > cands[fm].dispDepth ||
                    (depth == cands[fm].dispDepth && (long long)nd.accumulatedScore > cands[fm].dispScore)) {
                    cands[fm].dispDepth = depth;
                    cands[fm].dispScore = nd.accumulatedScore;
                    cands[fm].col2 = nd.col2; cands[fm].rot2 = nd.rot2;
                    cands[fm].col3 = nd.col3; cands[fm].rot3 = nd.rot3;
                }
            }
        }
    };

    // ── ① 既知ツモのプレフィックスを1回だけ計算（全キュー共通・最も広い前半層をここで消化）──
    long long prefixChain[EXP_MAXCAND];
    for (int i = 0; i < EXP_MAXCAND; i++) prefixChain[i] = 0;

    std::vector<SearchNode> prefixNodes;
    { SearchNode root; root.board = baseBoard; prefixNodes.push_back(root); }

    bool prefixDead = false;
    for (int depth = 0; depth < knownPairs && depth < maxDepth; depth++) {
        stepDepth(prefixNodes, nextPairs[depth * 2], nextPairs[depth * 2 + 1], depth,
                  prefixChain, /*registerFirst=*/depth == 0, /*captureBase=*/true);
        if (prefixNodes.empty() || prefixNodes[0].accumulatedScore < -900000) { prefixDead = true; break; }
    }

    // プレフィックスで到達した連鎖は全キューに共通 → 本数ぶん合算
    for (int fm = 0; fm < nCand; fm++) cands[fm].expSum += (long long)branchCount * prefixChain[fm];

    // ── ② プレフィックスの先から、各キューは擬似bagで尾部だけ分岐 ──
    if (!prefixDead) {
        for (int branch = 0; branch < branchCount; branch++) {
            const uint8_t* bag = EXP_BAG[branch];

            long long branchChain[EXP_MAXCAND];
            for (int i = 0; i < EXP_MAXCAND; i++) branchChain[i] = 0;

            std::vector<SearchNode> cur = prefixNodes; // 共通プレフィックスから複製
            for (int depth = knownPairs; depth < maxDepth; depth++) {
                int idx = depth - knownPairs;          // bagストリーム上の位置
                int pivot, child;
                if ((idx & 1) == 0) { pivot = bag[0] + 1; child = bag[1] + 1; }
                else                { pivot = bag[2] + 1; child = bag[3] + 1; }

                // 尾部の baseScore 更新は1本目(branch0)のみ（最も妥当な未来）で行う
                stepDepth(cur, pivot, child, depth, branchChain,
                          /*registerFirst=*/false, /*captureBase=*/branch == 0);
                if (cur.empty() || cur[0].accumulatedScore < -900000) break;
            }

            for (int fm = 0; fm < nCand; fm++) cands[fm].expSum += branchChain[fm];
        }
    }

    // ── 初手選択：baseScore(累積eval) + expChainWeight×期待連鎖スコア ──
    int bestFm = -1;
    long long bestVal = LLONG_MIN;
    for (int fm = 0; fm < nCand; fm++) {
        long long base = (cands[fm].bestAccum == LLONG_MIN) ? cands[fm].depth0Score : cands[fm].bestAccum;
        long long expAvg = cands[fm].expSum / branchCount;  // 期待連鎖スコア（本数で割る）
        long long val = base + (long long)w.expChainWeight * expAvg / 100;
        if (val > bestVal) { bestVal = val; bestFm = fm; }
    }

    if (bestFm >= 0) {
        outResult[0] = cands[bestFm].col;
        outResult[1] = cands[bestFm].rot;
        outResult[2] = (int)bestVal;
        outResult[3] = cands[bestFm].col2;
        outResult[4] = cands[bestFm].rot2;
        outResult[5] = cands[bestFm].col3;
        outResult[6] = cands[bestFm].rot3;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 通常ビーム探索（確定NEXTのみ。expChainWeight==0 のときの本命経路）
//   NEXTは内部で20本確定しているので擬似ツモ不要＝ nextPairs[0..9] の10ペアを使った
//   純粋な確定ビーム。深さ・幅は w.mainMaxDepth / w.mainBeamW で速度調整できる。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static void runMainBeamSearch(
    const BitBoard& baseBoard,
    int* nextPairs,
    const EvalWeights& w,
    int* outResult
) {
    std::vector<SearchNode> currentNodes;
    SearchNode rootNode;
    rootNode.board = baseBoard;
    currentNodes.push_back(rootNode);

    // 確定的な先読み深さ・幅（JSから設定。0/未指定なら従来の重い設定）。
    //   nextPairs は10ペア(20int)ぶんしか無いので深さは最大10にクランプする。
    const int MAX_DEPTH = (w.mainMaxDepth > 0) ? std::min(w.mainMaxDepth, 10) : 10;
    const int mainW      = w.mainBeamW;   // 0=従来テーパ(d0:10,d1:8,d2:6,d>=3:4) / >0=depth>=1を一律この幅

    for (int depth = 0; depth < MAX_DEPTH; depth++) {
        std::vector<SearchNode> nextNodes;
        int pivot = nextPairs[depth * 2];
        int child = nextPairs[depth * 2 + 1];

        int beamWidth;
        if (depth == 0)        beamWidth = 10;               // 初手は広めに維持
        else if (mainW > 0)    beamWidth = mainW;            // depth>=1 を一律指定幅
        else if (depth == 1)   beamWidth = 8;
        else if (depth == 2)   beamWidth = 6;
        else                   beamWidth = 4;

        for (const auto& node : currentNodes) {
            std::vector<PairPlacement> placements = getAllPlacements(node.board);
            if (placements.empty()) {
                SearchNode deathNode = node;
                deathNode.accumulatedScore -= 999999;
                nextNodes.push_back(deathNode);
                continue;
            }

            // ★ 配置前（連鎖前）の盤面で緊急事態かどうかを判定する
            bool isEmergencyPre = false;
            int avgH = 0;
            int col2H = 0;
            for (int c = 0; c < COLS; c++) {
                int h = 0;
                for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
                    if (node.board.get(c, r) != 0) h++;
                }
                avgH += h;
                if (c == 2) col2H = h;
            }
            avgH /= COLS;
            if (avgH >= w.emergencyHeight || col2H >= 9) {
                isEmergencyPre = true;
            }

            PotentialInfo prePot = calcChainPotential(node.board);

            for (const auto& p : placements) {
                BitBoard nb = applyPlacement(node.board, p, (uint8_t)pivot, (uint8_t)child);
                ChainResult chain = simulateChain(nb);

                // ★ 配置後の盤面（nb）を渡す。報酬の差分計算には事前計算済みの prePot を使う
                int scoreRaw = evaluateBoard(nb, chain, w, prePot, isEmergencyPre);
                // ★ ちぎり(tear)ペナルティ：配置時1回（評価値ではなく配置コスト）。
                if (w.tearWeight != 0) scoreRaw += placementTear(p) * w.tearWeight;

                int score = scoreRaw;
                if (depth == 0) score = score * w.p1Weight / 100;
                for(int i = 0; i < depth; i++) score = (score * 9) / 10;

                SearchNode nextNode = node;
                nextNode.board = nb;
                nextNode.accumulatedScore += score;

                if (depth == 0) {
                    nextNode.col1 = p.col; nextNode.rot1 = p.rot;
                } else if (depth == 1) {
                    nextNode.col2 = p.col; nextNode.rot2 = p.rot;
                } else if (depth == 2) {
                    nextNode.col3 = p.col; nextNode.rot3 = p.rot;
                }

                nextNodes.push_back(nextNode);
            }
        }

        std::sort(nextNodes.begin(), nextNodes.end(), [](const SearchNode& a, const SearchNode& b) {
            return a.accumulatedScore > b.accumulatedScore;
        });

        if ((int)nextNodes.size() > beamWidth) {
            nextNodes.resize(beamWidth);
        }
        currentNodes = nextNodes;

        if (!currentNodes.empty() && currentNodes[0].accumulatedScore < -900000) {
            break;
        }
    }

    if (!currentNodes.empty()) {
        const auto& bestNode = currentNodes.front();
        outResult[0] = bestNode.col1;
        outResult[1] = bestNode.rot1;
        outResult[2] = bestNode.accumulatedScore;
        outResult[3] = bestNode.col2;
        outResult[4] = bestNode.rot2;
        outResult[5] = bestNode.col3;
        outResult[6] = bestNode.rot3;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// build モードのエントリ：期待連鎖スコア選択 or 通常ビームに振り分ける。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
void searchBuildMode(
    const BitBoard& baseBoard,
    int* nextPairs,
    const EvalWeights& w,
    int* outResult
) {
    // ★ 期待連鎖スコア選択（Ama search_multi 移植）。重みが非0のときのみ有効。
    //   0 のときは従来の累積eval最大ビーム選択にフォールバックする。
    if (w.expChainWeight != 0) {
        runExpectedChainSelection(baseBoard, nextPairs, w, outResult);
        return;
    }
    runMainBeamSearch(baseBoard, nextPairs, w, outResult);
}

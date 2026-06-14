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
#include <unordered_map>

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 潜在連鎖スコア選択（Ama search_multi 移植・核心①／TETLABO向け確定NEXT版）
//
//   ★ TETLABO は内部で 20 個の NEXT をあらかじめ確定保持している。よって Ama 原典の
//     「擬似ランダム未来ツモ列(6本bag)で分岐して期待値平均」は不要＝確定NEXTを1本の
//     ビームで深く読むだけでよい（擬似bag/branch機構は撤去した）。
//
//   各初手 candidate の subtree を走査し、各ノードで quiescence が返す
//   「今撃てば出る最大連鎖スコア」(potChain) と、実際に発火した連鎖スコアの大きい方を
//   キュー横断で巻き上げる → その初手から到達できる最大連鎖スコア chainTarget[fm]。
//
//   ★ 初手選択は「連鎖スコア主体」（Ama「最終選択は連鎖スコア」）：
//     到達連鎖スコア chainTarget が最大の初手を選ぶ。base(構築品質eval)は順位付け
//     （ビーム生存）と、到達連鎖が近接する初手間の同点崩しにのみ使う。
//     近接判定の許容幅(band)は w.expChainWeight を流用（連鎖スコア単位。0=厳密最大）。
//
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/beam.cpp search_multi
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static const int EXP_MAXDEPTH = 8;   // 確定NEXTビームの深さ 上限
static const int EXP_MAXCAND  = 24;  // 初手candidate最大数（6列×4回転）

struct ExpCandidate {
    int col, rot;
    int depth0Score;                  // 初手単独の評価（フォールバック用）
    long long bestAccum;              // 累積eval最大（構築品質 base。順位付け/同点崩し用）
    int col2, rot2, col3, rot3;       // 表示用の先読み（最深ノードを辿って取得）
    long long chainTarget;            // この初手から到達できる最大連鎖スコア（潜在＋実発火）
    int chainTargetChains;            // ↑chainTarget に対応する連鎖『段数』（デバッグ期待連鎖数）
    int chainTargetDepth;             // ↑chainTarget を達成したビーム深さ（=何手後。depth0=今そのまま発火）

    // ── 表示用先読み(col2/col3)を辿るための補助 ──
    //   col2/col3 を「累積eval最大ノード」に紐付けると、初手が連鎖を発火したとき
    //   depth0 ノードが累積最大になり col2/col3=-1 のまま残る（estimateがstep1だけになる）。
    //   そこで選択用の bestAccum とは分離し、表示は「実際に最も深く辿れたノード」から拾う。
    int dispDepth;                    // col2/col3 を捕捉したノードの深さ（深いほど優先）
    long long dispScore;              // 同深さ内での比較用（累積eval最大を採用）

    // ── 発火トリガ用：この初手を「今そのまま置いたら」実発火する連鎖（depth0 の実結果）──
    int  fireChains;                  // 今撃てる連鎖段数（0=この初手では発火しない）
    long long fireScore;             // 今撃てる連鎖スコア
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
    // ── 速度調整パラメータ（JSから設定。0/未指定なら上限）──
    int maxDepth = (w.expMaxDepth > 0) ? std::min(w.expMaxDepth, EXP_MAXDEPTH) : EXP_MAXDEPTH;
    int cfgWidth = w.expBeamW;   // 0=従来テーパ / >0=depth>=1 を一律この幅に

    ExpCandidate cands[EXP_MAXCAND];
    int  nCand = 0;
    int  fmLookup[EXP_MAXCAND * 4];   // key = col*4+rot → fm index（-1=未登録）
    for (int i = 0; i < EXP_MAXCAND * 4; i++) fmLookup[i] = -1;

    // ── デバッグカウンタ（outResult[7..] に出して JS 側で可視化する。リリース時は撤去）──
    int dbgPrune = 0;   // PRUNE で捨てたノード数
    int dbgDedup = 0;   // 置換表(dedup)で除去したノード数

    // ── 1段ぶんビームを進める共通処理 ──
    //   各ノードで quiescence の潜在連鎖スコア／実発火スコアを chainTarget[fm] に巻き上げる。
    //   registerFirst: depth0 で初手candidateを登録。captureBase: base/先読みを確定。
    auto stepDepth = [&](std::vector<SearchNode>& cur, int pivot, int child, int depth,
                         bool registerFirst, bool captureBase) {
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

                // ★ 配置後盤面の「今撃てば出る最大連鎖スコア」(potChain)を eval と同じ
                //   quiescence シミュから受け取る（追加コストなし）。
                int potChain = 0, potChainCount = 0;
                int scoreRaw = evaluateBoard(nb, chain, w, prePot, isEmergencyPre, &potChain, &potChainCount);
                // ★ ちぎり(tear)ペナルティ：配置時1回（評価値ではなく配置コスト）。
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
                        cands[fm].chainTarget = 0;
                        cands[fm].chainTargetChains = 0;
                        cands[fm].chainTargetDepth = -1;
                        cands[fm].dispDepth = -1;
                        cands[fm].dispScore = LLONG_MIN;
                        cands[fm].fireChains = 0;
                        cands[fm].fireScore = 0;
                    }
                    // ★ 発火トリガ用：この初手を「今そのまま置いた」ときの実発火連鎖を記録。
                    //   depth0 の chain は現ペアを置いた瞬間の連鎖結果＝「今撃てる連鎖」。
                    cands[fm].fireChains = chain.chains;
                    cands[fm].fireScore  = chain.score;
                    nn.firstMoveIndex = fm;
                    nn.col1 = p.col; nn.rot1 = p.rot;
                } else {
                    fm = node.firstMoveIndex;
                    if (depth == 1)      { nn.col2 = p.col; nn.rot2 = p.rot; }
                    else if (depth == 2) { nn.col3 = p.col; nn.rot3 = p.rot; }
                }

                // ★ 連鎖スコアの巻き上げ：潜在(potChain)と実発火(chain.score)の大きい方。
                //   実発火盤面(collapse後)の potChain は小さいが、撃った連鎖そのものは
                //   chain.score で拾う＝「撃つ手・組む手」を統一して到達連鎖として評価。
                if (fm >= 0) {
                    long long reach = std::max((long long)potChain, (long long)chain.score);
                    if (reach > cands[fm].chainTarget) {
                        cands[fm].chainTarget = reach;
                        // 到達連鎖の段数も同じ出所（実発火 chain.chains か 潜在 potChainCount）で更新
                        cands[fm].chainTargetChains =
                            (chain.score >= potChain) ? chain.chains : potChainCount;
                        // この到達連鎖を達成したビーム深さ（=この初手を含め何手目で組み上がるか）。
                        //   depth0=今そのまま置いた瞬間／depthN=N手後の盤面でその連鎖に届く。
                        cands[fm].chainTargetDepth = depth;
                    }
                }

                // ★ 発火枝刈り（ama PRUNE）：実際に大連鎖を発火したノードは到達連鎖を記録済み。
                //   depth>=1 で閾値以上なら次層に伝播させない（崩れた盤面で枠を浪費しない）。
                if (w.pruneChainScore > 0 && depth >= 1 && chain.score >= w.pruneChainScore) {
                    dbgPrune++;
                    continue;
                }

                nextNodes.push_back(nn);
            }
        }

        // ★ 置換表（ama Layer::add）：同一盤面に複数経路で到達したら accumulatedScore 最大の
        //   1ノードだけ残す。限られたビーム幅を多様な盤面に使えるようにする。
        {
            std::unordered_map<uint64_t, int> seen;
            seen.reserve(nextNodes.size() * 2);
            std::vector<SearchNode> uniq;
            uniq.reserve(nextNodes.size());
            for (const auto& nd : nextNodes) {
                uint64_t hkey = hashBoard(nd.board);
                auto it = seen.find(hkey);
                if (it == seen.end()) {
                    seen.emplace(hkey, (int)uniq.size());
                    uniq.push_back(nd);
                } else if (nd.accumulatedScore > uniq[it->second].accumulatedScore) {
                    uniq[it->second] = nd;
                }
            }
            dbgDedup += (int)(nextNodes.size() - uniq.size());
            nextNodes.swap(uniq);
        }

        std::sort(nextNodes.begin(), nextNodes.end(), [](const SearchNode& a, const SearchNode& b) {
            return a.accumulatedScore > b.accumulatedScore;
        });
        if ((int)nextNodes.size() > beamWidth) nextNodes.resize(beamWidth);
        cur = nextNodes;

        // base（深い手まで考慮した累積eval最大）と表示用先読みを確定
        if (captureBase) {
            for (const auto& nd : cur) {
                int fm = nd.firstMoveIndex;
                if (fm < 0 || fm >= nCand) continue;

                if ((long long)nd.accumulatedScore > cands[fm].bestAccum) {
                    cands[fm].bestAccum = nd.accumulatedScore;
                }

                // 表示用先読み col2/col3：累積最大ではなく「最も深く辿れたノード」を採用する。
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

    // ── 確定NEXTを1本のビームで深さ maxDepth まで読む（擬似分岐なし）──
    std::vector<SearchNode> beam;
    { SearchNode root; root.board = baseBoard; beam.push_back(root); }

    for (int depth = 0; depth < maxDepth; depth++) {
        stepDepth(beam, nextPairs[depth * 2], nextPairs[depth * 2 + 1], depth,
                  /*registerFirst=*/depth == 0, /*captureBase=*/true);
        if (beam.empty() || beam[0].accumulatedScore < -900000) break;
    }

    // ── 初手選択：連鎖スコア主体（base は同点崩し）──
    //   ① 到達連鎖スコア chainTarget の最大 bestChain を求める。
    //   ② bestChain との差が band 以内の初手の中で base(構築品質) 最大を選ぶ。
    //      band=w.expChainWeight（連鎖スコア単位）。bestChain==0（まだ連鎖が組めない序盤）
    //      なら全初手が band 内＝base のみで選ぶ（構築品質最大＝素直に積む）。
    long long band = (w.expChainWeight > 0) ? w.expChainWeight : 0;

    long long bestChain = 0;
    for (int fm = 0; fm < nCand; fm++) {
        if (cands[fm].chainTarget > bestChain) bestChain = cands[fm].chainTarget;
    }
    long long chainFloor = bestChain - band;

    int bestFm = -1;
    long long bestBase = LLONG_MIN;
    int dbgFireChains = 0;   // 発火した連鎖段数（0=発火せず＝育成）。デバッグ outResult[15]
    int dbgFireReason = 0;   // 発火理由 0=育成(発火せず) / 1=目標到達 / 2=緊急(盤面整理)。outResult[23]
    // ── デバッグ[21][22]用：理論上「今この瞬間に撃てる最大連鎖」（実行動とは独立）──
    //   全候補のうち今そのまま置けば実発火する手の最大スコア。育成中でも >0 になり、
    //   「撃てるのに育成している」のか「そもそも撃てない」のかを切り分けられる。
    int       fireFmAny   = -1;   // 今撃てる最大連鎖の初手（-1=どの初手でも発火しない）
    long long fireBestAny = -1;   // その実発火スコア
    // ── デバッグ集計（スケール/差別化の可視化用）──
    long long maxBase = LLONG_MIN, minBase = LLONG_MAX;
    int nWithChain = 0;            // chainTarget>0（連鎖を組める）初手の数
    long long selBase = 0, selChain = 0;
    int selChainChains = 0;        // 選択初手の到達連鎖の段数（期待連鎖数。デバッグ）
    int selChainDepth = -1;        // 選択初手の到達連鎖を達成した深さ（=何手後。デバッグ）
    // デバッグ集計（スケール/差別化）は全候補で先に取る
    for (int fm = 0; fm < nCand; fm++) {
        long long base = (cands[fm].bestAccum == LLONG_MIN) ? cands[fm].depth0Score : cands[fm].bestAccum;
        if (base > maxBase) maxBase = base;
        if (base < minBase) minBase = base;
        if (cands[fm].chainTarget > 0) nWithChain++;
    }
    // ── 初手選択（連鎖主体：到達連鎖が bestChain の band 以内の初手だけを base で比較）──
    //   育成こぼし抑制：今そのまま置くと growthFireForbidChains 段「以上」を発火する初手は
    //   育成選択から除外する（pass0=フィルタ有り）。band内の全候補がこぼす場合のみ pass1 で
    //   フィルタを外して再選択し、手が必ず1つ残るようにする（[[何も置けない]]を防ぐ）。
    for (int pass = 0; pass < 2 && bestFm < 0; pass++) {
        bool filter = (pass == 0 && w.growthFireForbidChains > 0);
        for (int fm = 0; fm < nCand; fm++) {
            if (cands[fm].chainTarget < chainFloor) continue;
            if (filter && cands[fm].fireChains >= w.growthFireForbidChains) continue;
            long long base = (cands[fm].bestAccum == LLONG_MIN) ? cands[fm].depth0Score : cands[fm].bestAccum;
            if (base > bestBase) {
                bestBase = base; bestFm = fm;
                selBase = base; selChain = cands[fm].chainTarget;
                selChainChains = cands[fm].chainTargetChains;
                selChainDepth  = cands[fm].chainTargetDepth;
            }
        }
    }

    // ── ★ 発火トリガ（fire gate）──
    //   ここまでで bestFm は「育成（撃たずに最大連鎖へ伸ばす）」初手。ama型はこのままだと
    //   永遠に積み続けるので、下記いずれかが成立したら『今そのまま置けば実発火する初手』に上書きする。
    //     ① 目標連鎖到達：今撃てる連鎖が fireChainCount 段以上（育てた本線を一定サイズで放つ）
    //     ② 緊急回避：盤面が緊急（致死列高 or 平均高さ emergencyHeight 到達）なら出せる最大連鎖を即発火
    //   発火時は「今撃てる連鎖スコア最大の初手」を採る（① では目標段数を満たす候補の中から）。
    //   どちらも未成立、または発火可能な初手が無ければ育成（bestFm）のまま。
    {
        // 盤面緊急判定（baseBoard。stepDepth 内の isEmergencyPre と同じ基準）
        //   col2H（致死列＝第3列の高さ）は窒息寸前の延命発火[37]でも使うため外で保持。
        bool emergency = false;
        int col2H = 0;
        if (w.fireEmergency) {
            int avgH = 0;
            for (int c = 0; c < COLS; c++) {
                int h = 0;
                for (int r = HIDDEN; r < TOTAL_ROWS; r++) if (baseBoard.get(c, r) != 0) h++;
                avgH += h;
                if (c == 2) col2H = h;
            }
            avgH /= COLS;
            if (avgH >= w.emergencyHeight || col2H >= 9) emergency = true;
        }

        // 「今撃てる」最大連鎖の初手（緊急発火用＋デバッグ[21][22]用。上のスコープで宣言済み）と、
        //  目標段数を満たす最大連鎖の初手（目標発火用）
        int  fireFmTgt = -1;    long long fireBestTgt = -1;     // 目標段数到達のうち最大スコア
        for (int fm = 0; fm < nCand; fm++) {
            if (cands[fm].fireChains <= 0) continue;            // この初手では発火しない
            if (cands[fm].fireScore > fireBestAny) { fireBestAny = cands[fm].fireScore; fireFmAny = fm; }
            // ① 目標発火の成立条件（和集合）：目標段数到達 OR 連鎖スコアが閾値到達のどちらかで発火対象。
            //   段数だけだと「段数は浅いが点数の大きい連鎖」を撃ち逃すため、スコア側も OR で見る。
            bool tgtByCount = (w.fireChainCount    > 0 && cands[fm].fireChains >= w.fireChainCount);
            bool tgtByScore = (w.fireScoreThreshold > 0 && cands[fm].fireScore  >= w.fireScoreThreshold);
            if (tgtByCount || tgtByScore) {
                if (cands[fm].fireScore > fireBestTgt) { fireBestTgt = cands[fm].fireScore; fireFmTgt = fm; }
            }
        }

        int fireFm = -1;
        if (fireFmTgt >= 0)               { fireFm = fireFmTgt; dbgFireReason = 1; } // ① 目標連鎖に到達 → 発火
        else if (emergency && fireFmAny >= 0) {
            // ② 緊急回避。ただし無条件に最大即発火を撃つと、本線がまだ未完成のとき
            //   「部分連鎖／横の暴発」で組み上げた本線を巻き込んで壊す。これを防ぐため：
            //   (a) 潜在比ガード[36]：今撃てる最大連鎖 fireBestAny が本線潜在 bestChain の
            //       emergencyFireMinRatio% 以上＝本線がほぼ完成している時のみ発火を許す。
            //   (b) 窒息寸前の延命[37]：致死列 col2H が emergencyHardCol2 段以上なら、
            //       比ガードを無視して延命のため出せる最大を即発火（最終手段）。
            bool ratioOk = (w.emergencyFireMinRatio <= 0) || (bestChain <= 0) ||
                           (fireBestAny * 100 >= bestChain * (long long)w.emergencyFireMinRatio);
            bool hard    = (w.emergencyHardCol2 > 0 && col2H >= w.emergencyHardCol2);
            if (ratioOk)    { fireFm = fireFmAny; dbgFireReason = 2; } // 緊急（本線がほぼ完成→発火）
            else if (hard)  { fireFm = fireFmAny; dbgFireReason = 3; } // 緊急延命（最終手段＝制限無視）
            // どちらも不成立＝本線を守って育成継続（bestFm のまま撃たない）
        }

        if (fireFm >= 0) {
            bestFm = fireFm;
            selChain = cands[fireFm].fireScore;   // 表示は実発火スコア
            selChainChains = cands[fireFm].fireChains; // 表示の期待連鎖数も実発火段数に合わせる
            selChainDepth  = 0;                   // 発火は今そのまま置く＝0手後
            dbgFireChains = cands[fireFm].fireChains; // デバッグ：発火した連鎖段数
        }
    }

    if (bestFm >= 0) {
        outResult[0] = cands[bestFm].col;
        outResult[1] = cands[bestFm].rot;
        outResult[2] = (int)selChain;          // 合計scoreは「到達連鎖スコア」を表示（eval-value表示用）
        outResult[3] = cands[bestFm].col2;
        outResult[4] = cands[bestFm].rot2;
        outResult[5] = cands[bestFm].col3;
        outResult[6] = cands[bestFm].rot3;
    }

    // ── デバッグ出力（outResult[7..19]）。JS worker が console.log で可視化する ──
    //   観点①scale: selChain(選択初手の到達連鎖) と selBase / base幅(maxBase-minBase)。
    //   観点②PRUNE/dedup: dbgPrune/dbgDedup が >0 なら実際に発動。
    //   観点③差別化: nWithChain と bestChain/maxChain で初手間の連鎖記録差を見る。
    outResult[7]  = dbgPrune;                                      // PRUNE 発動数
    outResult[8]  = dbgDedup;                                      // dedup 除去数
    outResult[9]  = nCand;                                         // 初手候補数
    outResult[10] = maxDepth;                                      // 探索深さ
    outResult[11] = (int)band;                                     // 同点崩しband（連鎖スコア単位）
    outResult[12] = (int)bestChain;                               // 全候補の到達連鎖スコア最大
    outResult[13] = (int)selBase;                                 // 選択初手の base
    outResult[14] = (int)selChain;                                // 選択初手の到達連鎖スコア
    outResult[15] = dbgFireChains;                               // 発火した連鎖段数（0=育成）
    outResult[16] = nWithChain;                                   // 連鎖を組める初手数
    outResult[17] = (int)bestChain;                              // = maxChain（互換のため重複）
    outResult[18] = (int)((maxBase == LLONG_MIN) ? 0 : (maxBase - minBase)); // base のばらつき幅
    outResult[19] = 1;                                           // branchCount（確定NEXTなので常に1）
    // ── 追加デバッグ[20..22]：潜在(到達連鎖)と「理論上いま撃てる最大連鎖」の乖離を可視化 ──
    //   selChain(到達連鎖スコア) は潜在見込み＝伸ばした先の連鎖。これに対し、全候補のうち
    //   『今そのまま置けば実発火する手の最大連鎖』(fireFmAny/fireBestAny)を併記する。
    //   実際に撃つか否かは「発火:」が示すので、ここは実行動と独立した「撃とうと思えば撃てる最大」。
    //   ＞0 なのに「発火:育成」なら "撃てるが育成中"、＝0 なら "そもそも撃てない" と切り分く。
    outResult[20] = selChainChains;                              // 選択初手の到達連鎖の段数（期待連鎖数）
    outResult[21] = (fireFmAny >= 0) ? cands[fireFmAny].fireChains : 0;  // 理論上いま撃てる最大連鎖の段数
    outResult[22] = (fireFmAny >= 0) ? (int)fireBestAny : 0;             // 同・実発火スコア
    outResult[23] = dbgFireReason;   // 発火理由 0=育成 / 1=目標到達 / 2=緊急(盤面整理)
    outResult[24] = (bestFm >= 0) ? cands[bestFm].fireChains : 0;  // 選択(着手)初手を今置くと実際にこぼれる連鎖段数
    // ── 追加デバッグ[25]：選択初手の到達連鎖を達成した深さ（=何手後に発火/組み上がるか）──
    //   depth0=今そのまま発火／-1=連鎖未到達(育てる候補が無い)。selChainChains(段数)と併読する。
    outResult[25] = selChainDepth;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// build モードのエントリ。
//   TETLABO は内部で 20 NEXT を確定保持するため擬似ツモ分岐は不要。確定NEXTを1本の
//   ビームで深く読み、各初手の到達連鎖スコア(potChain/実発火)を巻き上げて
//   「連鎖スコア主体・base同点崩し」で初手を選ぶ。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
void searchBuildMode(
    const BitBoard& baseBoard,
    int* nextPairs,
    const EvalWeights& w,
    int* outResult
) {
    runExpectedChainSelection(baseBoard, nextPairs, w, outResult);
}

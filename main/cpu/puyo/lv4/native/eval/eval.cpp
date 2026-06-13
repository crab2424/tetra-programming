// ─────────────────────────────────────────────
// eval/eval.cpp — 盤面評価（評価値・報酬・統合）
// ─────────────────────────────────────────────
#include "eval/eval.h"
#include "eval/shape.h"
#include "eval/form.h"

#include <algorithm>
#include <cmath>

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 【評価値】盤面状態スコア計算（毎ターン加算）
//   配置後の盤面状態のみを見て評価する。報酬パラメータは含まない。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcEvalScore(const BitBoard& b, const EvalWeights& w, const int heights[COLS]) {
    int score = 0;

    // 高さペナルティ（3列目は特に重要）
    if (heights[2] >= 8) score += (heights[2] - 7) * w.heightPenalty;
    for (int c = 0; c < COLS; c++) {
        if (heights[c] >= 10) score += (heights[c] - 9) * (w.heightPenalty / 3);
    }

    // 隣接列の高さ差ペナルティ
    for (int c = 0; c < COLS - 1; c++) {
        int diff = std::abs(heights[c] - heights[c+1]);
        score += diff * w.heightDiffPenalty;
    }

    // ── Ama 由来の盤面形状評価（加算式・各重み0で無効化）──
    if (w.shapeWeight != 0) score += getShape(heights) * w.shapeWeight;
    if (w.wellWeight  != 0) score += getWell(heights)  * w.wellWeight;
    if (w.bumpWeight  != 0) score += getBump(heights)  * w.bumpWeight;
    if (w.sideWeight  != 0) score += getSide(heights)  * w.sideWeight;  // 致死列を相対的に低く保つbias

    // 2連結/3連結（3連結は発火直前形に近いので別重み）
    if (w.link2Weight != 0 || w.link3Weight != 0) {
        int l2, l3;
        getLink23(b, l2, l3);
        score += l2 * w.link2Weight;
        score += l3 * w.link3Weight;
    }

    // quiescence による連鎖ポテンシャル評価（連鎖の組みやすさを毎ターン誘導）
    score += calcQuiescenceEval(b, heights, w);

    // Ama 由来の関係性 form テンプレート（GTR/SGTR/FRON の相対マッチ・毎ターン）
    if (w.formWeight != 0) score += calcAmaFormScore(b, heights) * w.formWeight;

    return score;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 【報酬】配置による変化スコア計算（1手限り）
//   配置前後の差分として初めて現れた変化にのみ加算する。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
static int calcRewardScore(
    const BitBoard& postBoard,          // 配置後の盤面
    const ChainResult& chain,           // 配置後の連鎖結果
    const EvalWeights& w,
    const PotentialInfo& prePot,        // 配置前のポテンシャル
    bool isEmergencyPre,                // ★ 配置前の盤面で判定した緊急事態フラグ
    int currentIgnitionThreshold,
    int currentIgnitionScoreThreshold
) {
    int score = 0;
    bool isIgnitionMode = (prePot.maxChains >= currentIgnitionThreshold || prePot.maxScore >= currentIgnitionScoreThreshold);

    // ── chainBonus / erasedBonus ──
    // 連鎖は配置により初めて発生するので前後差分は不要。発火条件に応じて1回だけ加算。
    if (chain.chains > 0) {
        bool triggersIgnition = (chain.chains >= currentIgnitionThreshold || chain.score >= currentIgnitionScoreThreshold);
        bool fulfillsPotential = isIgnitionMode && (chain.chains >= prePot.maxChains || chain.score >= prePot.maxScore);

        if (triggersIgnition || fulfillsPotential) {
            int effectiveChains = std::max(chain.chains, prePot.maxChains);
            score += (effectiveChains * effectiveChains * effectiveChains) * w.chainBonus * 10;
            score += (chain.score / 100) * w.chainBonus;
            score += chain.totalErased * std::abs(w.erasedBonus);
        } else if (isEmergencyPre || postBoard.isEmptyAll()) {
            score += (chain.chains * chain.chains) * w.chainBonus * 5;
            score += (chain.score / 100) * w.chainBonus / 2;
            score += chain.totalErased * std::abs(w.erasedBonus);

            // ★ 緊急事態時は、連鎖後に3列目（致死列）の高さが低いほど特大ボーナスを与える
            if (isEmergencyPre) {
                int postH2 = 0;
                for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
                    if (postBoard.get(2, r) != 0) postH2++;
                }
                int col2_reduction = std::max(0, 12 - postH2);
                score += col2_reduction * 20000;
            }
        } else if (isIgnitionMode) {
            PotentialInfo postPot = calcChainPotential(postBoard);
            bool keepsPotential = (postPot.maxChains >= currentIgnitionThreshold || postPot.maxScore >= currentIgnitionScoreThreshold);
            if (keepsPotential && postPot.isSafe) {
                score += chain.totalErased * std::abs(w.erasedBonus);
            } else {
                score -= (chain.chains * chain.chains) * 5000;
            }
        } else {
            score -= (chain.chains * chain.chains) * 5000;
        }
    }

    // ── zenkeshiBonus ──
    // 配置後に全消しが成立した場合のみ1回加算。
    if (postBoard.isEmptyAll()) score += w.zenkeshiBonus;

    // ── chainPotentialBonus ──
    // 配置後のポテンシャルを計算し、配置前からの増加分（差分）に対して報酬を与える。
    if (chain.chains == 0) {
        // 連鎖が起きなかった場合のみ（連鎖時はchainBonusで評価済み）
        PotentialInfo postPot = calcChainPotential(postBoard);
        int postPotScore = postPot.maxScore;
        int postPotChains = postPot.maxChains;
        // 差分：配置後が配置前を上回った分だけ報酬
        int potChainGain = postPotChains - prePot.maxChains;
        int potScoreGain = postPotScore  - prePot.maxScore;

        if (isIgnitionMode) {
            bool keepsPotential = (postPotChains >= currentIgnitionThreshold || postPotScore >= currentIgnitionScoreThreshold);
            if (keepsPotential) {
                if (postPot.isSafe) {
                    // ポテンシャルを維持できているので、絶対値でも報酬を与える（維持自体に価値がある）
                    score += (postPotChains * postPotChains) * w.chainPotentialBonus * 5;
                    score += (postPotScore / 1000) * w.chainPotentialBonus;
                } else {
                    score -= 10000;
                }
            } else {
                score -= 10000;
            }
        } else {
            if (postPotChains > 0 || postPotScore > 0) {
                if (postPot.isSafe) {
                    if (postPotChains >= currentIgnitionThreshold || postPotScore >= currentIgnitionScoreThreshold) {
                        // 発火閾値に到達した場合は大きな報酬（絶対値＋差分）
                        score += (postPotChains * postPotChains) * w.chainPotentialBonus * 5;
                        score += (postPotScore / 1000) * w.chainPotentialBonus * 2;
                        score += std::max(0, potChainGain) * w.chainPotentialBonus;
                        score += std::max(0, potScoreGain / 1000) * w.chainPotentialBonus;
                    } else {
                        // 閾値未満は差分のみ報酬
                        score += std::max(0, potChainGain) * w.chainPotentialBonus;
                        score += std::max(0, potScoreGain / 1000) * w.chainPotentialBonus;
                    }
                } else {
                    // 発火点が不安定な場合は半額
                    score += std::max(0, potChainGain) * (w.chainPotentialBonus / 2);
                }
            }
        }
    }

    return score;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 盤面評価関数
//   報酬（1手限り）と評価値（毎ターン）を合算して返す。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
int evaluateBoard(
    const BitBoard& postBoard,          // 配置後の盤面
    const ChainResult& chain,
    const EvalWeights& w,
    const PotentialInfo& prePot,        // 配置前のポテンシャル（searchBestMove側で計算済み）
    bool isEmergencyPre                 // ★ 配置前の盤面で判定した緊急事態フラグ
) {
    // ── 配置後の高さを計算（評価値・緊急報酬で共用）
    int heights[COLS];
    for (int c = 0; c < COLS; c++) {
        heights[c] = 0;
        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            if (postBoard.get(c, r) != 0) heights[c]++;
        }
    }

    // ── 発火閾値（緊急時は緩和）
    // ★ 連鎖前の判定（isEmergencyPre）を使用する
    int currentIgnitionThreshold      = isEmergencyPre ? 1 : w.ignitionThreshold;
    int currentIgnitionScoreThreshold = isEmergencyPre ? 0 : w.ignitionScoreThreshold;

    // ── 【報酬】1手限りの変化に対するスコア
    int rewardScore = calcRewardScore(
        postBoard, chain, w,
        prePot,
        isEmergencyPre,
        currentIgnitionThreshold, currentIgnitionScoreThreshold
    );

    // ── 【評価値】配置後の盤面状態スコア（毎ターン）
    int evalScore = calcEvalScore(postBoard, w, heights);

    return rewardScore + evalScore;
}

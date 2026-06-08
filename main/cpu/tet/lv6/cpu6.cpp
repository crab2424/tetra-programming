// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// cpu6: WASM エントリポイント（ビームサーチ本体とJSとの境界）
//   盤面/評価/配置列挙は board / eval / tslot / placement に分離済み。
//   このファイルは SearchState とビームサーチのループ、JSへ渡す結果の整形のみを担う。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE   // ネイティブ単体テスト用：emscripten 非依存でコンパイル可能にする
#endif

#include <stdint.h>
#include <cstdlib>
#include <algorithm>
#include <vector>

#include "common.h"
#include "board.h"
#include "weights.h"
#include "eval.h"
#include "placement.h"

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* my_malloc(size_t size) { return malloc(size); }

EMSCRIPTEN_KEEPALIVE
void my_free(void* ptr) { free(ptr); }

struct SearchState {
    int first_action;
    int hold_mino;
    int next_idx;

    int p1_score;
    int total_score;
    // ★変更：n手目の枝切りキー = 最新盤面評価値 + 1手目からの累積報酬
    // cumulative_event_score : 1手目から現在手までの evalPlacementEvent の累積和
    // beam_score             : 枝切り・最終選択に使うスコア (= 最新 stateScore + cumulative_event_score)
    int cumulative_event_score;
    int beam_score;
    Board board;

    bool has_p[8];      // ★深さ8対応: 6→8 に拡張
    Placement p[8];     // ★深さ8対応: 6→8 に拡張
    int step_score[8];  // ★深さ8対応: 6→8 に拡張
    int p_id[8];        // ★深さ8対応: 6→8 に拡張

    int max_height;

    int ren;
    bool backToBack;

    // ★pick_move(生存)用：1手目を実行した直後の中央列(3,4,5)の最大高さと、その1手の攻撃量(おじゃま相殺ぶん)
    //   着弾おじゃまincomingがある時、これらを使って「中央が天井(20)を超えないか」を判定する。
    int first_center_h;
    int first_attack;

    SearchState() {
        first_action = -1;
        hold_mino = -1;
        next_idx = 0;
        p1_score = 0;
        total_score = 0;
        cumulative_event_score = 0;
        beam_score = 0;
        max_height = 0;
        ren = 0;
        backToBack = false;
        first_center_h = 0;
        first_attack = 0;
        for(int i = 0; i < 8; ++i) {  // ★深さ8対応: 6→8
            has_p[i] = false;
            step_score[i] = 0;
            p_id[i] = -1;
        }
    }
};

// weightsArray[37] を EvalWeights へ展開する。メンバ順は weightsArray のインデックスと一致。
static inline EvalWeights unpackWeights(const int* weightsArray) {
    return EvalWeights {
        weightsArray[0], weightsArray[1], weightsArray[2], weightsArray[3], weightsArray[4],
        weightsArray[5], weightsArray[6], weightsArray[7], weightsArray[8], weightsArray[9],
        weightsArray[10], weightsArray[11], weightsArray[12], weightsArray[13], weightsArray[14],
        weightsArray[15], weightsArray[16], weightsArray[17], weightsArray[18], weightsArray[19],
        weightsArray[20], weightsArray[21], weightsArray[22], weightsArray[23],
        weightsArray[24], weightsArray[25], weightsArray[26], weightsArray[27], weightsArray[28],
        weightsArray[29], weightsArray[30], weightsArray[31], weightsArray[32],
        weightsArray[33], // centerDip
        weightsArray[34], // tstClear ★Phase1追加
        weightsArray[35], // b2bHold ★追加[35]
        weightsArray[36]  // tSlotTst ★Phase3追加[36]
    };
}

EMSCRIPTEN_KEEPALIVE
void evaluateSinglePlacementWasm(
    uint8_t* boardData, int minoType, int rot, int x, int y,
    int* weightsArray, int* outResult,
    int ren, int backToBack, int tSpinType
) {
    ensurePrecalc();

    Board baseBoard;
    for(int i = 0; i < 250; i++) {
        if (boardData[i]) baseBoard.set(i % 10, i / 10);
    }

    EvalWeights w = unpackWeights(weightsArray);

    // ★分割対応：配置前盤面の評価値（baseScore）を evalBoardState で取得
    int baseMaxHeight = 0;
    // 単発評価(表示/デバッグ用)はNEXT情報を持たないため upcomingT=1 を仮定
    int baseScore = evalBoardState(baseBoard, w, 1, &baseMaxHeight);

    GridBlock blocks[4];
    for(int i=0; i<4; i++) {
        blocks[i].x = PRECALC_MINO_BLOCKS[minoType][rot][i].x + x;
        blocks[i].y = PRECALC_MINO_BLOCKS[minoType][rot][i].y + y;
    }

    Board simBoard = baseBoard;
    for(int i=0; i<4; i++) {
        simBoard.set(blocks[i].x, blocks[i].y);
    }

    PlacementInfo info = calcPlacementInfo(baseBoard, blocks);
    Board beforeClearBoard = simBoard; // ライン消去前の盤面を保存（downstack判定用）
    int cleared = simBoard.checkLineAndClear();

    // ★分割対応：配置後盤面の評価値（stateScore）を evalBoardState で取得
    int stateScore = evalBoardState(simBoard, w, 1, nullptr);

    // ★分割対応：配置イベントの報酬（eventScore）を evalPlacementEvent で取得
    int eventScore = evalPlacementEvent(
        simBoard, beforeClearBoard, cleared, info.isFullyGrounded, info.touchingCount,
        tSpinType, ren, backToBack != 0, blocks, baseMaxHeight, w
    );

    // ★分割後：stepScore = 評価値 * p1Weight + 報酬
    int stepScore = stateScore * w.p1Weight / 100 + eventScore;

    bool hasBlockOutside = false;
    for(int i=0; i<4; i++) {
        if(blocks[i].y < 0) {
            hasBlockOutside = true;
            break;
        }
    }
    if (hasBlockOutside) stepScore -= 100000000;

    if (baseMaxHeight <= 14) {
        if (minoType == 2 && cleared == 0) stepScore += w.tMinoNoClearPenalty;
    }

    outResult[0] = stepScore;
    outResult[1] = stepScore - baseScore;
}

EMSCRIPTEN_KEEPALIVE
void searchBestMoveWasm(
    uint8_t* boardData, int currentType, int holdType, int next1, int next2, int next3, int next4, int next5,
    int next6, int next7, int next8, // ★深さ8対応: NEXTを5→8本に拡張
    int canHold,
    int* weightsArray, int* outResult,
    int ren, int backToBack,
    int incoming // ★着弾予定のおじゃまライン数（生存判定 pick_move 用）。0なら通常選択
){
    ensurePrecalc();

    for(int i = 0; i < 43; i++) outResult[i] = -1;
    for(int i = 36; i < 43; i++) outResult[i] = 0;

    Board baseBoard;
    for(int i = 0; i < 250; i++) {
        if (boardData[i]) baseBoard.set(i % 10, i / 10);
    }

    EvalWeights w = unpackWeights(weightsArray);

    // ★深さ8対応: current + next1..next8 + 終端0 = 10要素
    // （holdが空の開幕でインデックスが1ずれるため、深さ8で最大 index=8 を参照する）
    int next_queue[10] = { currentType, next1, next2, next3, next4, next5, next6, next7, next8, 0 };
    auto getSpawnY = [](int type) { return type == 0 ? 4 : 3; };

    // ★Phase2: ある手番から先に「見えているTの本数」を数える（next_queue[from..8] + hold）。
    //   T-slot(TSD/TSS)先読み・TSDセットアップの上限に使う（Tが来ないのに土台を作らせない）。
    auto countUpcomingT = [&](int from, int hold) -> int {
        int n = 0;
        for (int i = (from < 0 ? 0 : from); i <= 8; i++) if (next_queue[i] == 2) n++;
        if (hold == 2) n++;
        return n;
    };

    int baseMaxHeight = 0;
    // ★分割対応：初期盤面の評価値を evalBoardState で取得（初期盤面の upcomingT は全可視キュー+hold）
    int baseScore = evalBoardState(baseBoard, w, countUpcomingT(0, holdType), &baseMaxHeight);

    std::vector<SearchState> final_states;
    std::vector<SearchState> current_states;
    std::vector<SearchState> next_states_N;
    std::vector<SearchState> next_states_L;

    const size_t BEAM_WIDTH = 24; // ★探索拡張: 8→12→48（TST能動化のため幅優先、予算〜100ms/手）
    const int P1_WEIGHT_PCT = w.p1Weight;

    final_states.reserve(128);
    current_states.reserve(BEAM_WIDTH * 2);
    next_states_N.reserve(2048);
    next_states_L.reserve(2048);

    auto expandState = [&](const SearchState& s, int piece, int new_hold, int new_next_idx, int step_num, bool is_first, int first_action) -> int {
        std::vector<Placement> p_list = getAllPlacements(is_first ? baseBoard : s.board, piece, getSpawnY(piece));

        if (p_list.empty()) {
            SearchState dead_s = s;
            dead_s.total_score -= 100000000 * (7 - step_num);
            if (is_first) dead_s.first_action = first_action;
            final_states.push_back(dead_s);
            return 0;
        }

        int pushed_count = 0;
        for(size_t j = 0; j < p_list.size(); j++) {
            const auto& p = p_list[j];

            bool hasBlockOutside = false;
            for(int k=0; k<4; k++) {
                if(p.blocks[k].y < 0) {
                    hasBlockOutside = true;
                    break;
                }
            }

            Board simBoard = is_first ? baseBoard : s.board;
            for(int k=0; k<4; k++) {
                simBoard.set(p.blocks[k].x, p.blocks[k].y);
            }
            Board beforeClearBoard = simBoard; // ライン消去前の盤面を保存（downstack判定用）
            simBoard.checkLineAndClear();

            int cur_ren = is_first ? ren : s.ren;
            bool cur_btb = is_first ? (backToBack != 0) : s.backToBack;

            int current_max_height = 0;
            // ★分割対応：評価値（盤面の良さ）を evalBoardState で取得
            // ★Phase2: この手番以降に使えるTの本数を T-slot 先読みに渡す（placed後の new_next_idx / new_hold 基準）
            int stateScore = evalBoardState(simBoard, w, countUpcomingT(new_next_idx, new_hold), &current_max_height);

            // ★分割対応：報酬（その1手のイベント）を evalPlacementEvent で取得
            int prevHeight = is_first ? baseMaxHeight : s.max_height;
            int eventScore = evalPlacementEvent(
                simBoard, beforeClearBoard, p.linesCleared, p.isFullyGrounded, p.touchingCount,
                p.tSpinType, cur_ren, cur_btb, p.blocks, prevHeight, w
            );

            // ★BtB状態の更新（b2bHold静的ボーナスを stateScore に乗せるため先に算出）
            int next_ren = (p.linesCleared > 0) ? (cur_ren + 1) : 0;
            bool isBtBAction = (p.linesCleared >= 4) || (p.tSpinType > 0 && p.linesCleared > 0);
            bool next_btb = cur_btb;
            if (p.linesCleared > 0) next_btb = isBtBAction;

            // ★#3: 配置後もBtBを保持している盤面への静的ボーナス（CC back_to_back相当）。
            //   盤面評価の一部として stateScore に加算 → stepScore/beam_score 双方へ自然に伝播する。
            //   ※イベント報酬 btbKeep(消去時の一回限り) とは別軸の「BtBを抱えている価値」。
            if (next_btb) stateScore += w.b2bHold;

            // ★#2: T浪費ペナルティ（常時・高さ減衰）。Tをスピンにも消去にも使わず置く手を罰する。
            //   低盤面=満額（Tはスピン用に温存）、高盤面=減衰0（掘りでTを使うのを許容）。CC wasted_t の高さ折衷版。
            //   旧実装は prevHeight<=10 の崖（11以上は無罰）→ 10→18 で線形に減衰する常時罰へ変更。
            int tWastePenalty = 0;
            if (piece == 2 && p.tSpinType == 0 && p.linesCleared == 0) {
                int f = (18 - prevHeight) * 100 / 8; // height<=10:100%, >=18:0%
                if (f > 100) f = 100;
                if (f < 0)   f = 0;
                tWastePenalty = w.tMinoNoClearPenalty * f / 100;
            }

            // ★分割後：stepScore = 評価値 * p1Weight（1手目のみ）+ 報酬（total_score 用、従来互換で保持）
            int stepScore = is_first ? (stateScore * P1_WEIGHT_PCT / 100 + eventScore) : (stateScore + eventScore);

            // ★変更：枝切り・最終選択に使う beam_score を計算
            // beam_score = 最新盤面評価値 + 1手目からの累積報酬の和
            // (n-1手目までの盤面評価値は含まない)
            int cur_cumulative_event = (is_first ? 0 : s.cumulative_event_score) + eventScore;
            // 1手目のみ p1Weight を盤面評価値に掛ける（以降は生の stateScore）
            int cur_beam_score = stateScore + cur_cumulative_event;

            if (hasBlockOutside) stepScore -= 100000000 * (7 - step_num);
            stepScore += tWastePenalty; // ★#2: 常時適用（高さ減衰込み）
            if (prevHeight <= 10) {
                if (cur_ren > 0 && cur_ren <= 2 && p.linesCleared == 0) stepScore += w.renCutPenalty;
            }

            // ★変更：ペナルティ系も beam_score に反映する
            if (hasBlockOutside) cur_beam_score -= 100000000 * (7 - step_num);
            cur_beam_score += tWastePenalty; // ★#2: 常時適用（高さ減衰込み）
            if (prevHeight <= 10) {
                if (cur_ren > 0 && cur_ren <= 2 && p.linesCleared == 0) cur_beam_score += w.renCutPenalty;
            }

            SearchState next_s = s;
            next_s.hold_mino = new_hold;
            next_s.next_idx = new_next_idx;
            next_s.ren = next_ren;
            next_s.backToBack = next_btb;
            next_s.max_height = current_max_height;
            next_s.cumulative_event_score = cur_cumulative_event;
            next_s.beam_score = cur_beam_score;
            if (is_first) {
                next_s.first_action = first_action;
                next_s.p1_score = stateScore; // ★分割対応：旧 score → stateScore に変更
                // ★pick_move(生存)用：この1手を実行した直後(simBoard=配置+ライン消去後)の
                //   中央列(3,4,5)の最大高さと、その1手の攻撃量を記録する。子ノードへはコピーで継承される。
                int center_h = 0;
                for (int cx = 3; cx <= 5; cx++) {
                    for (int y = 0; y < ROWS; y++) {
                        if ((simBoard.rows[y] >> cx) & 1) { // 上から最初に埋まっている行
                            int h = ROWS - y;
                            if (h > center_h) center_h = h;
                            break;
                        }
                    }
                }
                next_s.first_center_h = center_h;
                next_s.first_attack = estimateAttack(p.linesCleared, p.tSpinType, cur_btb, cur_ren);
            }
            next_s.total_score += stepScore;
            next_s.board = simBoard;
            next_s.p[step_num - 1] = p;
            next_s.has_p[step_num - 1] = true;
            next_s.step_score[step_num - 1] = stepScore;
            next_s.p_id[step_num - 1] = piece;

            if (hasBlockOutside) {
                final_states.push_back(next_s);
            } else {
                if (p.linesCleared > 0) next_states_L.push_back(next_s);
                else next_states_N.push_back(next_s);
                pushed_count++;
            }
        }
        return pushed_count;
    };

    auto trimAndMerge = [&]() {
        // ★変更：枝切りの比較キーを total_score → beam_score に変更
        // beam_score = 最新盤面評価値 + 1手目からの累積報酬（n-1手目以前の盤面評価値を含まない）
        if(next_states_N.size() > BEAM_WIDTH) {
            std::partial_sort(next_states_N.begin(), next_states_N.begin() + BEAM_WIDTH, next_states_N.end(),
                [](const SearchState& a, const SearchState& b){ return a.beam_score > b.beam_score; });
            next_states_N.resize(BEAM_WIDTH);
        }
        if(next_states_L.size() > BEAM_WIDTH) {
            std::partial_sort(next_states_L.begin(), next_states_L.begin() + BEAM_WIDTH, next_states_L.end(),
                [](const SearchState& a, const SearchState& b){ return a.beam_score > b.beam_score; });
            next_states_L.resize(BEAM_WIDTH);
        }

        current_states.clear();
        for (const auto& s : next_states_N) current_states.push_back(s);
        for (const auto& s : next_states_L) current_states.push_back(s);

        next_states_N.clear();
        next_states_L.clear();
    };

    SearchState initial_state;
    initial_state.ren = ren;
    initial_state.backToBack = (backToBack != 0);
    initial_state.max_height = baseMaxHeight;

    expandState(initial_state, next_queue[0], holdType, 1, 1, true, 0);

    if(canHold == 1) {
        int piece;
        int new_hold = next_queue[0];
        int new_next_idx;
        if(holdType != -1) {
            piece = holdType;
            new_next_idx = 1;
        } else {
            piece = next_queue[1];
            new_next_idx = 2;
        }
        expandState(initial_state, piece, new_hold, new_next_idx, 1, true, 1);
    }

    trimAndMerge();

    for (int depth = 1; depth < 8; depth++) { // ★探索拡張: 深さ 6→8
        int step_num = depth + 1;
        next_states_N.clear();
        next_states_L.clear();

        for (const auto& state : current_states) {
            int cur_mino = state.next_idx < 9 ? next_queue[state.next_idx] : 0; // ★深さ8対応: 境界 6→9

            expandState(state, cur_mino, state.hold_mino, state.next_idx + 1, step_num, false, -1);

            if (state.hold_mino != -1 && state.hold_mino != cur_mino) {
                expandState(state, state.hold_mino, cur_mino, state.next_idx + 1, step_num, false, -1);
            }
        }

        if (next_states_N.empty() && next_states_L.empty()) break;

        trimAndMerge();
    }

    for (const auto& state : current_states) {
        final_states.push_back(state);
    }

    int bestTotalScore = -2000000000;
    const SearchState* bestState = nullptr;

    // ★変更：最終的な最善手選択も beam_score（最新盤面評価値 + 累積報酬）で判断
    for(const auto& state : final_states) {
        if(state.beam_score > bestTotalScore) {
            bestTotalScore = state.beam_score;
            bestState = &state;
        }
    }

    // ────────────────────────────────────────────────
    // ★Cold Clear の pick_move 相当：着弾おじゃま(incoming)で天井(20)を超える危険があるなら、
    //   評価値が多少落ちても「中央が埋まらない手（消去/掘り手）」を優先採用する。
    //   - safe判定: incoming - その手の攻撃量 + 1手目後の中央列最大高さ <= 20
    //   - safeな手が在れば、その中で beam_score 最大を採用
    //   - 1つもsafeでなければ、攻撃量(spike)最大の手にフォールバック（同点は beam_score 優先）
    //   incoming<=0 のときは全手safe扱い＝従来どおり beam_score 最大が選ばれる。
    // ────────────────────────────────────────────────
    if (incoming > 0 && bestState != nullptr) {
        const SearchState* bestSafe = nullptr;   int bestSafeScore = -2000000000;
        const SearchState* bestSpike = nullptr;  int bestSpikeAtk = -1; int bestSpikeScore = -2000000000;
        for (const auto& state : final_states) {
            bool safe = (incoming - state.first_attack + state.first_center_h <= 20);
            if (safe && state.beam_score > bestSafeScore) {
                bestSafeScore = state.beam_score;
                bestSafe = &state;
            }
            if (state.first_attack > bestSpikeAtk ||
                (state.first_attack == bestSpikeAtk && state.beam_score > bestSpikeScore)) {
                bestSpikeAtk = state.first_attack;
                bestSpikeScore = state.beam_score;
                bestSpike = &state;
            }
        }
        if (bestSafe != nullptr)       bestState = bestSafe;
        else if (bestSpike != nullptr) bestState = bestSpike;
    }

    if(bestState) {
        outResult[0] = bestState->first_action;
        outResult[1] = bestState->p1_score;
        outResult[2] = bestState->p1_score - baseScore;

        outResult[3] = bestState->p_id[0]; outResult[4] = bestState->p[0].rot; outResult[5] = bestState->p[0].x; outResult[6] = bestState->p[0].y; outResult[7] = bestState->p[0].spawnY;

        outResult[12] = bestState->p[0].tSpinType;

        if(bestState->has_p[1]) { outResult[8] = bestState->p_id[1]; outResult[9] = bestState->p[1].rot; outResult[10] = bestState->p[1].x; outResult[11] = bestState->p[1].y; }
        if(bestState->has_p[2]) { outResult[13] = bestState->p_id[2]; outResult[14] = bestState->p[2].rot; outResult[15] = bestState->p[2].x; outResult[16] = bestState->p[2].y; }
        if(bestState->has_p[3]) { outResult[17] = bestState->p_id[3]; outResult[18] = bestState->p[3].rot; outResult[19] = bestState->p[3].x; outResult[20] = bestState->p[3].y; }
        if(bestState->has_p[4]) { outResult[21] = bestState->p_id[4]; outResult[22] = bestState->p[4].rot; outResult[23] = bestState->p[4].x; outResult[24] = bestState->p[4].y; }
        if(bestState->has_p[5]) { outResult[25] = bestState->p_id[5]; outResult[26] = bestState->p[5].rot; outResult[27] = bestState->p[5].x; outResult[28] = bestState->p[5].y; }

        outResult[29] = bestState->total_score;
        outResult[30] = bestState->step_score[0];
        outResult[31] = bestState->has_p[1] ? bestState->step_score[1] : 0;
        outResult[32] = bestState->has_p[2] ? bestState->step_score[2] : 0;
        outResult[33] = bestState->has_p[3] ? bestState->step_score[3] : 0;
        outResult[34] = bestState->has_p[4] ? bestState->step_score[4] : 0;
        outResult[35] = bestState->has_p[5] ? bestState->step_score[5] : 0;

        int finalPath[64];
        int finalPathLen = 0;

        if (bestState->first_action == 1) {
            finalPath[finalPathLen++] = 7;
        }
        for (int i = 0; i < bestState->p[0].pathLength && finalPathLen < 64; i++) {
            finalPath[finalPathLen++] = bestState->p[0].path[i];
        }

        for (int i = 0; i < finalPathLen; i++) {
            int idx = i / 10;
            int shift = (i % 10) * 3;
            outResult[36 + idx] |= (finalPath[i] & 0x7) << shift;
        }
    }
}
} // extern "C"

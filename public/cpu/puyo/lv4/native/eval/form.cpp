// ─────────────────────────────────────────────
// eval/form.cpp — Ama 由来の「関係性 form テンプレート」（相対方式）
//   原典: source_assets/puyoAI/ama-beam/ai/search/beam/form.{h,cpp}
//
//     - dform[y][x] … セルに付ける「ラベル番号」(色ではなく役割ID)。0=don't care。
//                     Ama 同様、上の行から記述し、読み出し時に上下反転する(y=0が下)。
//     - matrix[i][j] … ラベル i と j が「同色であるべき(+)/異色であるべき(-)」かの関係行列。
//   盤面の実関係(同色=+1/異色=-1)と matrix の符号が一致すれば加点、矛盾で即失格(-100)。
//   絶対座標・色の取り方に依存しないため、土台が左右にずれても評価できる。
// ─────────────────────────────────────────────
#include "eval/form.h"

namespace amaform {
    constexpr int FH   = 6;   // form の高さ（盤面下から6段だけ見る）
    constexpr int NLAB = 8;   // ラベル 0..7（GTR/SGTR/FRON が使う範囲）

    struct FormData {
        uint8_t dform[FH][COLS];   // Ama の dform をそのまま（行0=上）。lab() で上下反転
        int8_t  matrix[NLAB][NLAB];
        // 盤面下からの積み高さ y（y=0=下）に対応するラベル
        inline uint8_t lab(int y, int x) const { return dform[FH - 1 - y][x]; }
    };

    // GTR（form.h GTR() と同一）
    constexpr FormData GTR = {
        {
            { 0, 0, 0, 0, 0, 0 },
            { 4, 4, 4, 0, 0, 0 },
            { 3, 3, 3, 4, 0, 0 },
            { 1, 2, 5, 0, 0, 0 },
            { 1, 1, 2, 5, 0, 0 },
            { 2, 2, 5, 0, 0, 0 }
        },
        {
            { 0,  0,  0,  0,  0,  0,  0,  0 },
            { 0,  1, -1, -1,  0,  0,  0,  0 },
            { 0, -1,  1, -1,  0, -1,  0,  0 },
            { 0, -1, -1,  2, -1, -1,  0,  0 },
            { 0,  0,  0, -1,  0,  0,  0,  0 },
            { 0,  0, -1, -1,  0,  0,  0,  0 },
            { 0,  0,  0,  0,  0,  0,  0,  0 },
            { 0,  0,  0,  0,  0,  0,  0,  0 }
        }
    };

    // SGTR（form.h SGTR() と同一）
    constexpr FormData SGTR = {
        {
            { 0, 0, 0, 0, 0, 0 },
            { 5, 5, 5, 0, 0, 0 },
            { 4, 4, 4, 5, 0, 0 },
            { 1, 1, 3, 6, 0, 0 },
            { 1, 2, 2, 3, 6, 0 },
            { 2, 3, 3, 6, 0, 0 }
        },
        {
            { 0,  0,  0,  0,  0,  0,  0,  0 },
            { 0,  1, -1, -1, -1,  0,  0,  0 },
            { 0, -1,  1, -1,  0,  0,  0,  0 },
            { 0, -1, -1,  1, -1,  0, -1,  0 },
            { 0, -1,  0, -1,  2, -1,  0,  0 },
            { 0,  0,  0,  0, -1,  0,  0,  0 },
            { 0,  0,  0, -1,  0,  0,  0,  0 },
            { 0,  0,  0,  0,  0,  0,  0,  0 }
        }
    };

    // FRON（form.h FRON() と同一）
    constexpr FormData FRON = {
        {
            { 0, 0, 0, 0, 0, 0 },
            { 5, 5, 5, 0, 0, 0 },
            { 4, 4, 4, 5, 0, 0 },
            { 1, 1, 3, 6, 0, 0 },
            { 1, 2, 2, 7, 0, 0 },
            { 3, 3, 2, 3, 6, 0 }
        },
        {
            { 0,  0,  0,  0,  0,  0,  0,  0 },
            { 0,  1, -1, -1, -1,  0,  0,  0 },
            { 0, -1,  1, -1,  0,  0,  0, -1 },
            { 0, -1, -1,  1, -1,  0, -1,  0 },
            { 0, -1,  0, -1,  2, -1,  0,  0 },
            { 0,  0,  0,  0, -1,  0,  0,  0 },
            { 0,  0,  0, -1,  0,  0,  0,  0 },
            { 0,  0, -1,  0,  0,  0,  0,  0 }
        }
    };
}

// 1テンプレートの一致度（Ama form::evaluate のスカラ移植）。矛盾があれば -100 を返す。
static int amaFormEvaluate(const BitBoard& b, const int heights[COLS], const amaform::FormData& p) {
    using namespace amaform;
    int result = 0;
    const int ERROR = -100;

    for (int x0 = 0; x0 < COLS; ++x0) {
        for (int y0 = 0; y0 < FH; ++y0) {
            if (heights[x0] <= y0) break;          // 積まれていない高さは見ない
            uint8_t l0 = p.lab(y0, x0);
            if (l0 == 0) continue;                 // don't care セル
            uint8_t c0 = b.get(x0, (TOTAL_ROWS - 1) - y0);   // 下から y0 段目の実セル

            for (int x1 = x0; x1 < COLS; ++x1) {
                for (int y1 = 0; y1 < FH; ++y1) {
                    if (heights[x1] <= y1) break;
                    uint8_t l1 = p.lab(y1, x1);
                    if (l1 == 0) continue;
                    if (x0 == x1 && y0 >= y1) continue;     // 同一ペアの重複を避ける

                    int pattern_rel = p.matrix[l0][l1];
                    if (pattern_rel == 0) continue;

                    uint8_t c1 = b.get(x1, (TOTAL_ROWS - 1) - y1);
                    int field_rel = (c0 == c1) ? 1 : -1;    // 盤面の実関係（同色=+1/異色=-1）

                    if (field_rel * pattern_rel > 0) result += field_rel * pattern_rel;
                    else return ERROR;                       // 関係が矛盾＝このテンプレ失格
                }
            }
        }
    }
    return result;
}

// GTR/SGTR/FRON のうち最も一致するテンプレを採用（Ama eval.cpp と同じ max 選択）。
// おじゃまが土台下部(左4列・下4段)にあるとフォーム照合を無効化(=0)する点も Ama 準拠。
int calcAmaFormScore(const BitBoard& b, const int heights[COLS]) {
    for (int c = 0; c < 4; ++c) {
        for (int r = TOTAL_ROWS - 4; r < TOTAL_ROWS; ++r) {
            if (b.get(c, r) == 6) return 0;        // おじゃま混入時は形を強要しない
        }
    }
    int best = -100;
    int s;
    s = amaFormEvaluate(b, heights, amaform::GTR);  if (s > best) best = s;
    s = amaFormEvaluate(b, heights, amaform::SGTR); if (s > best) best = s;
    s = amaFormEvaluate(b, heights, amaform::FRON); if (s > best) best = s;
    return best;
}

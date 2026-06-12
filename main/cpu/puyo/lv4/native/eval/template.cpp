// ─────────────────────────────────────────────
// eval/template.cpp — 旧式テンプレート一致スコア
// ─────────────────────────────────────────────
#include "eval/template.h"

#include <algorithm>

static int getTemplateScore(const BitBoard& b, const uint8_t* pattern, int templateBonus, bool isGtr) {
    uint8_t colorOfGroup[8] = {0};
    bool broken = false;
    int matchScore = 0;
    const int TEMPLATE_TOP_ROW = 8;

    for (int row = 0; row < 4; row++) {
        for (int col = 0; col < COLS; col++) {
            int idx = row * COLS + col;
            uint8_t g = pattern[idx];
            if (g == 0) continue;

            int r = (TEMPLATE_TOP_ROW + row) + HIDDEN;
            if (r < 0 || r >= TOTAL_ROWS) continue;

            uint8_t c = b.get(col, r);
            if (c >= 1 && c <= 5) {
                int weight = 1;

                if (isGtr && col < 3 && row >= 1) {
                    weight = 10;

                    if (row == 3 && col < 2) {
                        weight = 50;
                    }
                }

                if (g == 6) {
                    matchScore += weight;
                } else {
                    if (colorOfGroup[g] != 0 && colorOfGroup[g] != c) {
                        broken = true; break;
                    }
                    colorOfGroup[g] = c;
                    matchScore += weight;
                }
            } else if (c == 6) {
                broken = true; break;
            }
        }
        if (broken) break;
    }

    if (broken) return 0;

    for (int row = 0; row < 4; row++) {
        for (int col = 0; col < COLS; col++) {
            uint8_t g1 = pattern[row * COLS + col];
            if (g1 == 0 || g1 == 6) continue;
            uint8_t c1 = colorOfGroup[g1];
            if (c1 == 0) continue;

            if (col + 1 < COLS) {
                uint8_t g2 = pattern[row * COLS + col + 1];
                if (g2 >= 1 && g2 <= 5 && g1 != g2 && colorOfGroup[g2] != 0 && c1 == colorOfGroup[g2]) {
                    broken = true; break;
                }
            }
            if (row + 1 < 4) {
                uint8_t g2 = pattern[(row + 1) * COLS + col];
                if (g2 >= 1 && g2 <= 5 && g1 != g2 && colorOfGroup[g2] != 0 && c1 == colorOfGroup[g2]) {
                    broken = true; break;
                }
            }
        }
        if (broken) break;
    }

    if (broken) return 0;
    return matchScore * templateBonus;
}

int calcTemplateScore(const BitBoard& b, const uint8_t* gtrPattern, const uint8_t* keyPattern, int templateBonus) {
    if (templateBonus <= 0) return 0;
    int scoreGtr = getTemplateScore(b, gtrPattern, templateBonus, true);
    int scoreKey = getTemplateScore(b, keyPattern, templateBonus, false);
    return std::max(scoreGtr, scoreKey);
}

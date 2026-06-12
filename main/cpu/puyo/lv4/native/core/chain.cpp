// ─────────────────────────────────────────────
// core/chain.cpp — 連鎖シミュレーションとポテンシャル計算
// ─────────────────────────────────────────────
#include "core/chain.h"

#include <algorithm>
#include <cstring>
#include <vector>

// スコア計算用テーブル（本ファイル内のみで使用）
static const int SCORE_BASE = 10;
static const int CHAIN_BONUS_TABLE[] = {0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512};
static const int COLOR_BONUS_TABLE[] = {0, 3, 6, 12, 24};
static const int GROUP_BONUS_TABLE[] = {0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10};

ChainResult simulateChain(BitBoard& b) {
    ChainResult res = {0, 0, 0, 0};
    static bool visited[TOTAL_ROWS][COLS];

    while (true) {
        memset(visited, 0, sizeof(visited));
        std::vector<std::pair<int,int>> toErase;
        std::vector<std::pair<int,int>> toEraseOjama;
        bool found = false;

        int stepErasedPuyo = 0;
        int usedColorBitmask = 0;
        int groupBonusSum = 0;

        for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                if (visited[r][c]) continue;
                uint8_t color = b.get(c, r);
                if (color == 0 || color == 6) continue;

                std::vector<std::pair<int,int>> group;
                std::vector<std::pair<int,int>> queue;
                queue.push_back({r, c});
                visited[r][c] = true;

                while (!queue.empty()) {
                    auto [cr, cc] = queue.back();
                    queue.pop_back();
                    group.push_back({cr, cc});

                    const int dr[] = {-1, 1,  0, 0};
                    const int dc[] = { 0, 0, -1, 1};
                    for (int d = 0; d < 4; d++) {
                        int nr = cr + dr[d];
                        int nc = cc + dc[d];
                        if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                        if (visited[nr][nc]) continue;
                        if (b.get(nc, nr) != color) continue;
                        visited[nr][nc] = true;
                        queue.push_back({nr, nc});
                    }
                }

                if ((int)group.size() >= 4) {
                    found = true;
                    if ((int)group.size() > res.maxGroup) res.maxGroup = (int)group.size();
                    res.totalErased += (int)group.size();

                    stepErasedPuyo += (int)group.size();
                    usedColorBitmask |= (1 << color);
                    int gSize = (int)group.size();
                    int gbIdx = std::min(gSize, 11);
                    groupBonusSum += GROUP_BONUS_TABLE[gbIdx];

                    for (auto& cell : group) toErase.push_back(cell);
                }
            }
        }

        if (!found) break;

        for (auto& cell : toErase) {
            const int dr[] = {-1, 1,  0, 0};
            const int dc[] = { 0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = cell.first + dr[d];
                int nc = cell.second + dc[d];
                if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                if (b.get(nc, nr) == 6) {
                    toEraseOjama.push_back({nr, nc});
                }
            }
        }

        res.chains++;

        int cbIdx = std::min(std::max(0, res.chains - 1), 18);
        int cb = CHAIN_BONUS_TABLE[cbIdx];

        int colorCount = 0;
        for (int i = 1; i <= 5; i++) {
            if (usedColorBitmask & (1 << i)) colorCount++;
        }
        int colorIdx = std::min(std::max(0, colorCount - 1), 4);
        int colorB = COLOR_BONUS_TABLE[colorIdx];

        int bonus = std::max(1, cb + colorB + groupBonusSum);
        res.score += SCORE_BASE * stepErasedPuyo * bonus;

        for (auto& p : toErase) b.set(p.second, p.first, 0);
        for (auto& p : toEraseOjama) b.set(p.second, p.first, 0);

        b.applyGravity();
    }

    return res;
}

PotentialInfo calcChainPotential(const BitBoard& b) {
    PotentialInfo best = {0, 0, -1, -1, 0, false};
    for (int col = 0; col < COLS; col++) {
        int r = calcDropRow(b, col);
        if (r < 0) continue;

        for (uint8_t color = 1; color <= 5; color++) {
            BitBoard tmp = b;
            tmp.set(col, r + HIDDEN, color);
            ChainResult res = simulateChain(tmp);

            if (res.score > best.maxScore || (res.score == best.maxScore && res.chains > best.maxChains)) {
                best.maxScore = res.score;
                best.maxChains = res.chains;
                best.triggerCol = col;
                best.triggerRow = r;
                best.triggerColor = color;
            }
        }
    }

    if (best.maxChains > 0 || best.maxScore > 0) {
        int c = best.triggerCol;
        int r = best.triggerRow;
        bool upSafe    = b.isEmpty(c, r - 1);
        bool leftSafe  = b.isEmpty(c - 1, r);
        bool rightSafe = b.isEmpty(c + 1, r);
        best.isSafe = (upSafe || leftSafe || rightSafe);
    }

    return best;
}

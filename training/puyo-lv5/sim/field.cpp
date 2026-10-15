// ─────────────────────────────────────────────
// sim/field.cpp — 盤面処理（消去判定・連鎖スコア・重力）
//   engine.js の _findErasableInField / _calcChainScore / _buildDropAnim を移植。
// ─────────────────────────────────────────────
#include "sim.h"

#include <algorithm>
#include <cstring>

namespace sim {

// PConfig.chainBonusTable = [0, 8, 16] + min(999, 32*(i+1)) (i=0..35)
static int chainBonus(int idx) {
    static const int T[39] = {
        0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512,
        544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 960, 992, 999, 999, 999, 999, 999
    };
    return T[std::min(idx, 38)];
}
static const int COLOR_BONUS[5]  = {0, 3, 6, 12, 24};
static const int GROUP_BONUS[12] = {0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10};

void Field::clear() { std::memset(v, 0, sizeof(v)); }

bool Field::empty() const {
    for (int r = 0; r < TOTAL_ROWS; r++)
        for (int c = 0; c < COLS; c++)
            if (v[r][c] != 0) return false;
    return true;
}

void findErasable(const Field& f, std::vector<std::vector<Cell>>& groups, std::vector<Cell>& ojama) {
    groups.clear();
    ojama.clear();
    bool visited[TOTAL_ROWS][COLS] = {};
    static const int DR[4] = {-1, 1, 0, 0};
    static const int DC[4] = { 0, 0, -1, 1};
    std::vector<Cell> group, queue;

    for (int r = HIDDEN; r < TOTAL_ROWS; r++) {
        for (int c = 0; c < COLS; c++) {
            if (visited[r][c]) continue;
            uint8_t color = f.v[r][c];
            if (color == 0 || color == 6) continue;
            group.clear();
            queue.clear();
            queue.push_back({r, c});
            visited[r][c] = true;
            for (size_t qi = 0; qi < queue.size(); qi++) {
                Cell cur = queue[qi];
                group.push_back(cur);
                for (int d = 0; d < 4; d++) {
                    int nr = cur.r + DR[d], nc = cur.c + DC[d];
                    if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                    if (visited[nr][nc] || f.v[nr][nc] != color) continue;
                    visited[nr][nc] = true;
                    queue.push_back({nr, nc});
                }
            }
            if ((int)group.size() >= ERASE_COUNT) groups.push_back(group);
        }
    }

    bool ojSeen[TOTAL_ROWS][COLS] = {};
    for (const auto& g : groups) {
        for (const auto& cell : g) {
            for (int d = 0; d < 4; d++) {
                int nr = cell.r + DR[d], nc = cell.c + DC[d];
                if (nr < HIDDEN || nr >= TOTAL_ROWS || nc < 0 || nc >= COLS) continue;
                if (f.v[nr][nc] == 6 && !ojSeen[nr][nc]) {
                    ojSeen[nr][nc] = true;
                    ojama.push_back({nr, nc});
                }
            }
        }
    }
}

int chainStepScore(const std::vector<std::vector<Cell>>& groups, const Field& f, int chainCount) {
    int n = 0, colorMask = 0, groupB = 0;
    for (const auto& g : groups) {
        n += (int)g.size();
        for (const auto& cell : g) colorMask |= 1 << f.v[cell.r][cell.c];
        groupB += GROUP_BONUS[std::min((int)g.size(), 11)];
    }
    int colors = __builtin_popcount(colorMask);
    int cb = chainBonus(std::max(0, chainCount - 1));
    int colorB = COLOR_BONUS[std::min(std::max(0, colors - 1), 4)];
    int bonus = std::max(1, cb + colorB + groupB);
    return 10 * n * bonus;   // PConfig.scoreBase = 10
}

DropInfo applyGravity(Field& f) {
    DropInfo info = {false, 0, 0};
    for (int c = 0; c < COLS; c++) {
        int emptyBelow = 0;
        for (int r = TOTAL_ROWS - 1; r >= 0; r--) {
            uint8_t v = f.v[r][c];
            if (v == 0) { emptyBelow++; continue; }
            if (emptyBelow == 0) continue;
            info.moved = true;
            info.maxDist = std::max(info.maxDist, emptyBelow);
            if (v != 6) info.vibCycles = std::max(info.vibCycles, emptyBelow >= 2 ? 4 : 3);
            f.v[r + emptyBelow][c] = v;
            f.v[r][c] = 0;
        }
    }
    return info;
}

long long simulateRemainingChain(Field f, int chainCountStart, int* outChains) {
    std::vector<std::vector<Cell>> groups;
    std::vector<Cell> oj;
    long long total = 0;
    int chains = chainCountStart;
    while (true) {
        findErasable(f, groups, oj);
        if (groups.empty()) break;
        chains++;
        total += chainStepScore(groups, f, chains);
        for (const auto& g : groups) for (const auto& cell : g) f.v[cell.r][cell.c] = 0;
        for (const auto& cell : oj) f.v[cell.r][cell.c] = 0;
        applyGravity(f);
    }
    if (outChains) *outChains = chains - chainCountStart;
    return total;
}

} // namespace sim

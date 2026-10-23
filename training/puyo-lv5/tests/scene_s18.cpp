// 局面テスト（lv6-vstet-design.md §18.1）：実機で「3連鎖で返さずに6列目へ置いた」局面を native の探索に入れる。
//   使い方: scene_s18 <weights.txt> <seed>   weights.txt は weightsArray（97個）を空白区切りで。
//   現ツモ 赤赤・NEXT 赤赤/緑緑 は固定、その先（見えていない手）は seed の乱数。受け 8個（ready）。
//   出力: 列 回転 発火段数 発火理由 dbgFlags
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include "core/bitboard.h"
#include "core/weights.h"
#include "build/build.h"

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: scene_s18 weights.txt seed\n"); return 2; }
    int wa[W_ARRAY_LEN_S18] = {0};
    FILE* f = std::fopen(argv[1], "r");
    if (!f) return 2;
    for (int i = 0; i < W_ARRAY_LEN_S18; i++) if (std::fscanf(f, "%d", &wa[i]) != 1) break;
    std::fclose(f);
    uint32_t seed = (uint32_t)std::strtoul(argv[2], nullptr, 10);

    // 列は左から、各列は下から（R 赤 G 緑 P 紫 Y 黄 O おじゃま）
    const char* cols[COLS] = {"PRRYYGGPRROR", "PRGYORRRGGGY", "PYPROOO", "RYOGGP", "OY", "GP"};
    auto code = [](char c) -> uint8_t {
        switch (c) { case 'R': return 1; case 'G': return 2; case 'P': return 3; case 'Y': return 4; default: return 6; }
    };
    BitBoard b;
    for (int c = 0; c < COLS; c++)
        for (int k = 0; cols[c][k]; k++) b.set(c, TOTAL_ROWS - 1 - k, code(cols[c][k]));

    int next[20];
    next[0] = 1; next[1] = 1;   // 現ツモ 赤赤
    next[2] = 1; next[3] = 1;   // NEXT1 赤赤
    next[4] = 2; next[5] = 2;   // NEXT2 緑緑
    uint32_t x = seed * 2654435761u + 12345u;
    for (int i = 6; i < 20; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; next[i] = 1 + (int)(x % 4); }

    wa[74] = 8;    // 初手の後に降る（ready）
    wa[75] = 0;
    wa[76] = 70;   // レート
    EvalWeights w = weightsFromArray(wa);
    int out[40] = {0};
    searchBuildMode(b, next, w, out);
    std::printf("%d %d %d %d %d\n", out[0], out[1], out[15], out[23], out[33]);
    return 0;
}

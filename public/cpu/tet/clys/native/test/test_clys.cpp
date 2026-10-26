// clys_wasm.cpp のネイティブ動作確認（空盤面・T-slot 盤面で clysSearch を数回呼び、時間と手を表示）
//   g++ -std=c++20 -O2 -I.. ../clys_wasm.cpp ../core/*.cpp ../ai/*.cpp test_clys.cpp -o /tmp/test_clys
#include <cstdio>
#include <cstdint>
#include <cstring>
extern "C" void clysSearch(const uint8_t*, const int32_t*, int32_t, int32_t, int32_t, int32_t,
    int32_t, int32_t, int32_t, int32_t, int32_t, int32_t, int32_t*, int32_t);

static void run(const char* name, const uint8_t* board, const int32_t* q, int hold, int thinkMs)
{
    int32_t out[96];
    clysSearch(board, q, 11, 9, hold, 26, 0, 0, 0, thinkMs, 500, 3, out, 96);
    printf("%s: ok=%d type=%d hold=%d cells=", name, out[0], out[1], out[10]);
    for (int i = 0; i < 4; ++i) printf("(%d,%d)", out[2 + i * 2], out[3 + i * 2]);
    printf(" visit=%d nodes=%d depth=%d ms=%d path=", out[11], out[12], out[13], out[14]);
    for (int i = 0; i < out[15]; ++i) printf("%d", out[16 + i]);
    printf("\n");
}

int main()
{
    uint8_t board[250];
    // 7-bag 2袋分（2袋目は T S Z I まで引いた＝残り O L J＝bagAfter 26）
    int32_t q[11] = { 0, 1, 2, 3, 4, 5, 6, 2, 5, 6, 0 };
    memset(board, 0, sizeof board);
    run("empty", board, q, -1, 100);

    // T-slot（TSD）盤面：下2段に x=4 の穴、その上の段に屋根
    memset(board, 0, sizeof board);
    for (int x = 0; x < 10; ++x) {
        if (x != 4) board[24 * 10 + x] = 1;
        if (x < 3 || x > 5) board[23 * 10 + x] = 1;
    }
    board[22 * 10 + 3] = 1; board[22 * 10 + 2] = 1; board[22 * 10 + 1] = 1; board[22 * 10 + 0] = 1;
    int32_t qt[11] = { 2, 1, 0, 3, 4, 5, 6, 2, 5, 6, 0 };
    run("tslot", board, qt, -1, 100);

    // 高い盤面（各列 14 段、x=9 が空き）
    memset(board, 0, sizeof board);
    for (int yi = 11; yi < 25; ++yi) for (int x = 0; x < 9; ++x) board[yi * 10 + x] = 1;
    run("high", board, q, 2, 100);
    return 0;
}

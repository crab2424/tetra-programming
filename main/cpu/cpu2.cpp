#include <emscripten.h>
#include <stdint.h>

extern "C" {

// JSから呼ばれる関数
EMSCRIPTEN_KEEPALIVE
int searchBestMove(uint8_t* board, int currentType, int holdType, int next1Type, int next2Type, int canHold) {
    
    // board[0] は座標(0,0)、 board[15] は座標(5,1) のブロックの有無(0 or 1)が入っている
    
    // ここでC++による爆速シミュレーションを行う
    // ...

    // 結果（ホールドするかどうか、回転数、X座標）を1つの整数にまとめてJSに返す
    int result = 0;
    // ... ビット演算でパックする処理 ...
    return result;
}

}
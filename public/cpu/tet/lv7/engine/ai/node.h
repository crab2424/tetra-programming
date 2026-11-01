#pragma once

#include "../core/state.h"
#include "garbage.h"

namespace node
{

struct Score
{
    i32 action = 0;
    i32 eval = 0;
};

struct Data
{
    State state = State();
    Score score = Score();
    Lock lock = Lock();
    i32 index = -1;
    i32 sent = 0;      // root からここまでの火力の累計（L1・L2 で incoming と相殺）
    u8 depth = 0;      // root から何手目か（T3 の予告の手の番号）
    garbage::Queue gq; // T3：まだ上がっていない予告（Configs::plan が有効なときだけ使う）
};

inline bool operator < (const Score& a, const Score& b)
{
    return a.action + a.eval < b.action + b.eval;
};

inline bool operator < (const node::Data& a, const node::Data& b)
{
    return a.score < b.score;
};

};
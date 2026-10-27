#pragma once

#include "../core/state.h"

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
    i32 parent = -1;   // 読み筋（Configs::pv）用：前の層での親の位置（記録した順）
    move::Placement placement = move::Placement(); // 読み筋用：この層で置いた手
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
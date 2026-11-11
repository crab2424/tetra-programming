#pragma once

// TETLABO lv7: 探索の中で予告のおじゃまを手ごとに相殺・着弾させる（T3。設計 lv7-threat-design.md §5.3）
//   ノードは予告の列を持つ。設置のたびに garbage.js と同じ順で
//     ① その手の火力で、届いている分を相殺（ready の古い順 → 未 ready の古い順）
//     ② 余りは、まだ届いていない分（相手がこれから撃つ見込みの分）を減らす（相手の火力は、まず相手に届いた私の火力を消すため）
//     ③ ready になった分を盤面に上げる（vsGarbageDamageOnClear が既定 ON なので消去した手でも）
//   手の番号は root から数えた設置の数（1＝いまのミノ）。穴の列は root ごとの擬似乱数（1段目は乱数、2段目から 70% で同じ列）

#include "../core/board.h"

namespace garbage
{

constexpr i32 MAX = 8;

struct Queue
{
    u8 n = 0;
    u8 amount[MAX] = { 0 };
    u8 arrive[MAX] = { 0 };   // この番号の手から自分のキューに入っている（0＝root で届いている）
    u8 ready[MAX] = { 0 };    // この番号の手の設置の後から上がる

    u64 hash() const;
    // 古い順に足す。いっぱいなら最後の件にまとめる
    void push(i32 amount, i32 arrive, i32 ready);
};

struct Plan
{
    bool active = false;
    Queue root;
    u64 seed = 0;
};

// depth 手目の設置の後の処理。上がった段数を返す
i32 after_lock(Board& board, Queue& q, i32 attack, i32 depth, u64 seed);

};

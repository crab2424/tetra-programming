#pragma once

// TETLABO lv7: 相手の火力の見積もり（設計 source_assets/memory/cpu/tet/lv7-threat-design.md §3）
//   方法 A estimate：相手の盤面で小さいビーム（評価は自分と同じ重み）を見える NEXT だけ回し、手ごとの火力を出す
//   方法 B ren     ：消去する置き方だけを全部数える REN 探索。見える NEXT の先は 7-bag どおりの並べ替え（モンテカルロ）で補う
//   火力は相手の State::margin の表で数える（-1 は未突入の表）

#include "beam.h"

#include <unordered_map>
#include <unordered_set>

namespace threat
{

constexpr i32 K = 8;          // 方法 A：手ごとの火力を持つ手数（見える NEXT は最大 7 本）
constexpr i32 R = 20;         // 方法 B：手ごとの火力を持つ手数

struct Beam
{
    i32 depth = 0;            // 読めた手数
    i32 a[K] = { 0 };         // 最善の筋（最後の層のキー最大）で j+1 手目までに撃った火力の累計
    i32 m[K] = { 0 };         // j+1 手目までに撃てる火力の累計の最大（その層で作った子のうち）
    u64 nodes = 0;
};

struct Ren
{
    i32 vis_len = 0;          // 見える NEXT だけで続けられる REN の手数（消去の連続数）の最大
    i32 vis_atk = 0;          // そのときの火力の累計の最大
    i32 mc_runs = 0;          // 並べ替えを回した通り数（入口の判定で飛ばしたら 0）
    i32 mc_len_mean10 = 0;    // 通りごとの最大の手数の平均 × 10
    i32 mc_len_max = 0;
    i32 mc_atk_mean10 = 0;    // 通りごとの最大の火力の平均 × 10
    i32 mc_atk_max = 0;
    i32 r[R] = { 0 };         // j+1 手目までに撃つ火力の累計（並べ替えがあれば通りの平均、無ければ見える分）
    u64 gen = 0;              // 生成した置き方の数
};

Beam estimate(State root, const std::vector<piece::Type>& queue, const eval::Weight& w, size_t width, double deadline_ms);

// bag_after：queue を引いた後の bag。seed は並べ替えの乱数（同じ入力なら native と wasm で同じ結果）
Ren ren(State root, const std::vector<piece::Type>& queue, Bag bag_after, size_t width, i32 samples, i32 ext, u64 seed,
        double deadline_ms);

};

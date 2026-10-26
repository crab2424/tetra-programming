#pragma once

// TETLABO lv6 の評価。原作（clys, MIT, (c) 2024 citrus610）からの変更点
//   ・nlohmann/json による重みの読み込みを外し、JS から int 配列で受け取る（from_array。並びは WEIGHT_LEN の表）
//   ・原作の癖を直すスイッチ（pc_next_own・transition_weighted。0 で原作どおり）
//   ・T-spin mini（Lock::mini）は通常の消去として報酬を数える
//   設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md §2

#include "node.h"

namespace eval
{

struct Weight
{
    i32 height;
    i32 well;
    std::array<i32, 10> height_map;
    std::array<i32, 10> well_map;
    i32 bump;
    i32 transition;
    i32 hole_a;
    i32 hole_b;
    i32 cover;
    std::array<i32, 4> tslot;
    i32 bonus_b2b;
    i32 bonus_ren;
    i32 scale;

    i32 pc;
    i32 pc_next;
    std::array<i32, 3> tspin;
    std::array<i32, 4> clear;
    i32 b2b;
    std::array<i32, 5> ren;
    i32 feed;
    i32 order;
    i32 delay;
    i32 waste_T;
    i32 waste_I;

    // ── TETLABO lv6 の追加（0 で原作どおり）──
    i32 pc_next_own;          // 1=pc_next の形に w.pc_next を掛ける（原作は w.pc を掛けていた）
    i32 transition_weighted;  // 1=transition に w.transition を掛ける（原作は重みを掛けずに +1/切り替わり）
    i32 select_best;          // 1=初手を「最後の層のキー最大」で選ぶ（0=原作の visit）
};

// 重み配列の長さと並び（cpu6.js の weightsArray と一致させる。追加は必ず末尾に）
//   [0] height [1] well [2..11] height_map [12..21] well_map [22] bump [23] transition [24] hole_a [25] hole_b
//   [26] cover [27..30] tslot [31] bonus_b2b [32] bonus_ren [33] scale [34] pc [35] pc_next [36..38] tspin
//   [39..42] clear [43] b2b [44..48] ren [49] feed [50] order [51] delay [52] waste_T [53] waste_I
//   [54] pc_next_own [55] transition_weighted [56] select_best
constexpr i32 WEIGHT_LEN = 57;

Weight from_array(const i32* a, i32 n);

// 原作 config.json の値（配列の並び）
extern const i32 DEFAULT_WEIGHTS[WEIGHT_LEN];

void evaluate(node::Data& node, node::Data& parent, move::Placement placement, const std::vector<piece::Type>& queue, const Weight& w);

std::pair<i32, i32> get_well(Board& board, i32 heights[10]);

i32 get_bump(i32 heights[10], i32 well_x);

i32 get_transition(Board& board, i32 well_x);

std::pair<i32, i32> get_hole(Board& board, i32 heights[10], i32 well_x);

i32 get_cover(Board& board, i32 heights[10]);

move::Placement get_structure(Board& board, i32 heights[10]);

void get_donation(Board& board, i32 heights[10], i32 depth, i32 tslot[4]);

bool get_pc_next(Board& board, i32 heights[10], piece::Type next);

i32 get_pc_able(Board& board, i32 heights[10]);

bool get_pc_split(Board& board, i32 height);

bool get_pc_fillable(Board& board, i32 height);

bool get_pc_parity(Board& board, i32 need, i32 next, const std::vector<piece::Type>& queue, const piece::Type& hold);


};
#pragma once

// TETLABO lv7 の評価。原作（clys, MIT, (c) 2024 citrus610）からの変更点
//   ・nlohmann/json による重みの読み込みを外し、JS から int 配列で受け取る（from_array。並びは WEIGHT_LEN の表）
//   ・原作の癖を直すスイッチ（pc_next_own・transition_weighted。0 で原作どおり）
//   ・T-spin mini（Lock::mini）は通常の消去として報酬を数える
//   ・P2 の候補 L1〜L5（[57..63]。すべて 0 で無効＝P1 と同じ結果）。設計 §2.3・§7
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

    // ── TETLABO lv7 の追加（0 で原作どおり）──
    i32 pc_next_own;          // 1=pc_next の形に w.pc_next を掛ける（原作は w.pc を掛けていた）
    i32 transition_weighted;  // 1=transition に w.transition を掛ける（原作は重みを掛けずに +1/切り替わり）
    i32 select_best;          // 1=初手を「最後の層のキー最大」で選ぶ（0=原作の visit）

    // ── P2 の候補（0 で無効）。rem＝root の incoming − 経路でここまでに送った火力（下限 0）──
    i32 inc_height;           // L2 rem 1段あたり（eval・scale 前。高さの減点と同じ向きなら負）
    i32 inc_danger_h;         // L2 >0 のとき「最大高さ＋rem」がこれを超えた段数に inc_danger を掛ける
    i32 inc_danger;           // L2 上の超過1段あたり
    i32 ren_danger_h;         // L1 >0 のとき REN の報酬（w.ren）を満額にするのは「配置前の最大高さ＋rem ≥ これ」の危険時だけ
    i32 ren_calm_pct;         // L1 平時の REN の報酬の割合（%）
    i32 t_lookahead;          // L3 >0 のとき T-slot の寄付の T の本数を「HOLD＋確定 NEXT の先 t_lookahead 本の T の数」で数える（原作は bag 推定）
    i32 nl_split;             // L5 >0 のとき、ビームを「最後の手で消去あり（L）」と「なし（N）」に分け、L に幅のこの % を割り当てる

    // ── 相手の火力の見積もり（T0。lv7-threat-design.md §3・§5.4）。lv7Search2 の ctx に相手があるときだけ使う ──
    i32 threat_width;         // >0 のとき相手の盤面でこの幅のビームを回す（方法 A）。0 は相手を読まない
    i32 threat_ms;            // 方法 A の締め切り（ms、0 なら 5）
    i32 ren_width;            // >0 のとき REN 探索（方法 B）をこの幅で回す。0 は回さない
    i32 ren_samples;          // 方法 B：見える NEXT の先のツモの並べ替えの通り数（0 なら 16）
    i32 ren_ext;              // 方法 B：並べ替えで足す本数（0 なら 12）
    i32 opp_ms;               // 相手の1手の ms（固定。0 なら 330）
    i32 my_ms;                // 自分の1手の ms（固定。0 なら 330）
    i32 margin_own;           // 1＝自分の探索の火力も ctx のマージン段の表で数える（0 は未突入の表のまま）
    i32 ren_ms;               // 方法 B の締め切り（ms、0 なら 15。方法 A の後から数える）

    // ── T3：探索の中で予告を相殺・着弾させる（lv7-threat-design.md §5.3）──
    i32 garbage_in_search;    // 1＝届いている予告（ctx）を探索の中で手ごとに相殺・着弾
    i32 threat_in_search;     // 1＝REN の合図があるとき REN 探索の r[j] を、2＝いつも方法 A の a[j]（＋合図があれば r[j] の大きい方）を、相手がこれから撃つ予告として着弾させる
    i32 threat_pct;           // 上の見積もりに掛ける割合（%、0 なら 100）
    i32 threat_ren_gate;      // REN の合図：REN 探索の手数（並べ替えの平均、無ければ見える分）がこれ以上（0 なら 7）
    i32 plan_danger_h;        // >0 のとき、T3 を効かせるのは「いまの最大の高さ＋探索に入れる予告の合計 ≥ これ」の危ないときだけ

    // ── T4：撃つ／撃たない（lv7-threat-design.md §6.2・§13）──
    i32 press;                // 相手が消しきれずに着弾する見込みの段 1段あたりの行動の報酬（方法 A の m[j] を相手の相殺の力とみる）
    i32 press_h;              // >0 のとき press を効かせるのは「相手の最大の高さ＋相手の予告 ≥ これ」のときだけ
    i32 danger_ren_pct;       // >0 のとき、T3 が効いている（危ない）探索では REN の報酬（ren・bonus_ren）をこの % にする
    i32 danger_clear;         // T3 が効いている探索で、T-spin でない 1〜3 ライン消しの行動に足す（負なら減点）
};

// 重み配列の長さと並び（cpu7.js の WEIGHT_KEYS と一致させる。追加は必ず末尾に）
//   [0] height [1] well [2..11] height_map [12..21] well_map [22] bump [23] transition [24] hole_a [25] hole_b
//   [26] cover [27..30] tslot [31] bonus_b2b [32] bonus_ren [33] scale [34] pc [35] pc_next [36..38] tspin
//   [39..42] clear [43] b2b [44..48] ren [49] feed [50] order [51] delay [52] waste_T [53] waste_I
//   [54] pc_next_own [55] transition_weighted [56] select_best
//   [57] inc_height [58] inc_danger_h [59] inc_danger [60] ren_danger_h [61] ren_calm_pct [62] t_lookahead [63] nl_split
//   [64] threat_width [65] threat_ms [66] ren_width [67] ren_samples [68] ren_ext [69] opp_ms [70] my_ms [71] margin_own [72] ren_ms
//   [73] garbage_in_search [74] threat_in_search [75] threat_pct [76] threat_ren_gate [77] plan_danger_h
//   [78] press [79] press_h [80] danger_ren_pct [81] danger_clear
//   （L4 row transitions は [55]=1 と [23] で足りる：get_transition は列の隣どうしの XOR＝行方向の切り替わり）
constexpr i32 WEIGHT_LEN = 82;

Weight from_array(const i32* a, i32 n);

// 原作 config.json の値（配列の並び）
extern const i32 DEFAULT_WEIGHTS[WEIGHT_LEN];

// incoming：root の予告のおじゃま（段）。node.sent（経路の火力の累計）と合わせて L1・L2 に使う
void evaluate(node::Data& node, node::Data& parent, move::Placement placement, const std::vector<piece::Type>& queue, const Weight& w, i32 incoming = 0);

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
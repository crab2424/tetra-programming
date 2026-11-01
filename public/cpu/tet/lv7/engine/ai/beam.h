#pragma once

// TETLABO lv7 の探索。原作（clys, MIT, (c) 2024 citrus610）の beam::search をもとに、確定 NEXT 前提で単純にしたもの。
//   ・ランダムなツモ（モンテカルロの branch）を外し、渡されたキュー（確定 NEXT）だけで深さ depth まで読む
//   ・締め切り時刻（ms）を層ごとに確かめる（wasm では1手ごとに同期で呼ぶ）
//   ・w.nl_split>0 なら各層を「最後の手で消去あり（L）／なし（N）」の2つのビームに分ける（旧 lv6 の N/L。設計 §2.3 L5）
//   ・初手は原作どおり visit（各層でビームに残った子孫の数）で選ぶ。w.select_best=1 なら最後の層のキー最大
//   設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md §1

#include "layer.h"
#include "eval.h"

namespace beam
{

// T4：送った火力のうち、相手が消しきれずに着弾する見込みの段に報酬を出す
//   着弾の見込み（d 手目まで）＝ max(0, 送った火力の累計 − incoming − cap[d])。cap[d] は d 手目の火力が相手で ready になるまでに
//   相手が撃てる火力（方法 A の m[j]、相手に届いている予告ぶんは先に引く）
struct Press
{
    bool active = false;
    i32 reward = 0;
    i32 cap[65] = { 0 };
};

struct Configs
{
    size_t width = 500;
    size_t depth = 32;
    i32 incoming = 0;          // root の予告のおじゃま（段）。評価の L1・L2 に渡す
    garbage::Plan plan;        // T3：探索の中で相殺・着弾させる予告（active でなければ今までどおり）
    Press press;               // T4
};

struct Candidate
{
    move::Placement placement = move::Placement();
    size_t visit = 0;
    i32 best = INT32_MIN;      // この初手から来た最後の層のノードのキーの最大（select_best 用）
};

struct Result
{
    std::vector<Candidate> candidates;
    u64 nodes = 0;             // 実際に展開したノード数
    u32 depth = 0;             // 読み終えた深さ
    bool decided = false;      // 子が全部同じ初手から来て打ち切った
};

// plan が有効なら、子ごとに設置の後の予告の相殺・着弾（garbage::after_lock）を済ませてから callback を呼ぶ
u32 expand(
    const std::vector<piece::Type>& queue,
    node::Data& node,
    const std::function<void(node::Data&, move::Placement)>& callback,
    const garbage::Plan* plan = nullptr
);

Result search(
    State state,
    std::vector<piece::Type> queue,
    const eval::Weight& w,
    Configs configs,
    double deadline_ms
);

// 経過時間の時計（ms）。wasm は emscripten_get_now、ネイティブは steady_clock
double now_ms();

bool is_queue_valid(const std::vector<piece::Type>& queue, Bag bag);

};

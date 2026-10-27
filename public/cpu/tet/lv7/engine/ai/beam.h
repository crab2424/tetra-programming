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

struct Configs
{
    size_t width = 500;
    size_t depth = 32;
    i32 incoming = 0;          // root の予告のおじゃま（段）。評価の L1・L2 に渡す
    // 読み筋モード（アシスト用 lv7Plan）。各層の (親, 手) を Result::hist に残し、初手が決まっても打ち切らない。
    //   HOLD が空でも最後の1本を（HOLD なしで）置く層を足す（その層は visit に数えない）
    bool pv = false;
};

// 読み筋モードで各層に残す記録
struct PvEntry
{
    i32 parent = -1;           // 前の層の記録での位置
    i32 index = -1;            // 初手（candidates の番号）
    i32 key = 0;               // action + eval
    move::Placement placement = move::Placement();
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
    std::vector<std::vector<PvEntry>> hist; // 読み筋モード：層ごとの記録（hist[0] = 初手の層）
};

u32 expand(
    const std::vector<piece::Type>& queue,
    node::Data& node,
    const std::function<void(node::Data&, move::Placement)>& callback
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

#pragma once

#include "piece.h"
#include "bag.h"
#include "board.h"
#include "move.h"

#include "../lib/xxh3.h"

// Ren combo table
// TETLABO lv7: scoring.js（マージン未突入）に合わせた。index＝この消去を含めた連続消去数。
//   scoring.js は加算前の ren r で 2〜3:+1、4〜5:+2、6〜7:+3、8〜12:+4、13〜:+5（原作は 12 で +5 になっていた）
constexpr i32 REN_LUT[] = { 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4, 5 };

// Lock data after placing a piece
struct Lock
{
    u8 clear = 0;
    u8 attack = 0;
    bool tspin = false;      // T-spin（mini を除く）
    bool mini = false;       // T-spin mini（TETLABO lv7。rotation.js checkTSpin の 'mini'）
    bool softdrop = false;
};

// Tetris game state
class State
{
public:
    Board board;
    piece::Type hold;
    Bag bag;
    u8 next;
    u8 b2b;
    u8 ren;
    // TETLABO lv7: 火力表のマージン段（-1＝未突入の表、0〜5＝scoring.js のマージン中の表）。ハッシュには含めない
    i8 margin;
    // TETLABO lv7: ZONE の発動中か（消去は Board::clear_zone。ハッシュには含めない）。
    //   発動中はそろった段が全部底の ZONE 段なので、ZONE 段の数は置く前の盤面から数えられる
    bool zone = false;
public:
    State() : board(Board()), hold(piece::Type::NONE), bag(Bag()), next(0), b2b(0), ren(0), margin(-1) {};
    State(Board board, piece::Type hold, Bag bag, u8 next, u8 b2b, u8 ren) : board(board), hold(hold), bag(bag), next(next), b2b(b2b), ren(ren), margin(-1) {};
public:
    Lock advance(move::Placement& placement, const std::vector<piece::Type>& queue);
    Lock lock(move::Placement& placement);
    // マージン中（margin 0〜5）の火力。lock の後に呼ぶ（b2b・ren は消去の後の値）
    i32 get_margin_attack(const Lock& lock, bool pc) const;
public:
    u64 get_hash();
public:
    void print();
};
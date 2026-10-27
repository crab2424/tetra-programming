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
public:
    State() : board(Board()), hold(piece::Type::NONE), bag(Bag()), next(0), b2b(0), ren(0) {};
    State(Board board, piece::Type hold, Bag bag, u8 next, u8 b2b, u8 ren) : board(board), hold(hold), bag(bag), next(next), b2b(b2b), ren(ren) {};
public:
    Lock advance(move::Placement& placement, const std::vector<piece::Type>& queue);
    Lock lock(move::Placement& placement);
public:
    u64 get_hash();
public:
    void print();
};
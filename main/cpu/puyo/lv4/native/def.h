// ─────────────────────────────────────────────
// def.h — 盤面の基本定数（全ファイル共通）
//   ぷよCPU lv4。1マス3ビットのビットボードで扱う。
// ─────────────────────────────────────────────
#pragma once

constexpr int COLS       = 6;
constexpr int ROWS       = 12;
constexpr int HIDDEN     = 5;
constexpr int TOTAL_ROWS = ROWS + HIDDEN;

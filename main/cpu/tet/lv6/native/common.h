#pragma once
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// common: 盤面の基本定数・ミノ形状テンプレート・事前計算テーブル
// 全モジュールが依存する最下層。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const int COLS = 10;
const int ROWS = 25; // ★変更：JS側のy=-5に対応するため画面を25行に拡張 (内部的には 0~24)

struct GridBlock { int x, y; };

struct MinoData {
    GridBlock blocks[4];
    float pivotX, pivotY;
};

extern const MinoData MINO_TEMPLATES[7];

// ★最適化：BFS内での無駄な演算を省くため、全ミノの座標を起動時に事前計算してテーブル化
extern GridBlock PRECALC_MINO_BLOCKS[7][4][4];

void ensurePrecalc();

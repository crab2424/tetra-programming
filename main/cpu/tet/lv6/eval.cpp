#include "eval.h"
#include "tslot.h"
#include <algorithm>
#include <cmath>
#include <utility>

// ────────────────────────────────────────────────
// 【評価値】evalBoardState
// 配置後の盤面を見て「現在の盤面の良さ・悪さ」を返す。
// これは毎ステップ加算される値であり、盤面が変わらない限り同じ値が出続ける。
// 含む要素：穴・高さ・段差・flat・Iウェル・TSD形状・下り坂・TSDセットアップ・blocksOverHole
// ────────────────────────────────────────────────
int evalBoardState(const Board& b, const EvalWeights& w, int upcomingT, int* outMaxHeight) {
    int score = 0;

    // ★最適化：ビットボードから一瞬で各列の高さを算出
    uint32_t cols[COLS];
    int heights[COLS];
    int maxHeight = calcHeights(b, cols, heights);

    // 呼び出し元に高さを引き継ぐ
    if (outMaxHeight != nullptr) *outMaxHeight = maxHeight;

    // 高さペナルティ
    if(maxHeight >= 12) score += (maxHeight - 11) * (maxHeight - 11) * w.heightLimit;
    if(maxHeight >= 16) score += maxHeight * maxHeight * w.heightLimit;

    // ★追加：ゆるやかな下り坂の評価
    // 左側 (x=0,1,2,3)
    //float l_y1 = heights[0], l_y2 = heights[1] - l_y1, l_y3 = heights[2] - l_y1, l_y4 = heights[3] - l_y1;
    //float l_cond1 =  -(2.0f * l_y2 + l_y3) / 2.0f;
    //float l_cond2 = l_y4 - (l_y2 + l_y3) / 3.0f;
    //if (l_cond1 >= 0.0f && l_cond2 <= 2.0f) {
    //    score += w.slopeBonus;
    //} else if (maxHeight <= 10){
    //    score += (int)((l_cond1) * (l_cond1) * w.slopePenalty);
    //    score += (int)((l_cond2) * (l_cond2) * w.slopePenalty);
    //}

    // 右側 (x=9,8,7,6)
    //float r_y1 = heights[9], r_y2 = heights[8] - r_y1, r_y3 = heights[7] - r_y1, r_y4 = heights[6] - r_y1;
    //float r_cond1 =  -(2.0f * r_y2 + r_y3) / 2.0f;
    //float r_cond2 = r_y4 - (r_y2 + r_y3) / 3.0f;
    //if (r_cond1 >= 0.0f && r_cond2 <= 2.0f) {
    //    score += w.slopeBonus;
    //} else if (maxHeight <= 10){
    //    score += (int)((r_cond1) * (r_cond1) * w.slopePenalty);
    //    score += (int)((r_cond2) * (r_cond2) * w.slopePenalty);
    //}

    // ★最適化：I-Well判定のループ外への切り出しをビット演算で完全一括処理
    bool hasIWellInRow[ROWS] = {false};
    for (int cy = 1; cy < ROWS - 1; cy++) {
        uint16_t row_up  = b.rows[cy-1];
        uint16_t row_mid = b.rows[cy];
        uint16_t row_down = b.rows[cy+1];
        uint16_t empty_mask = (~row_up) & (~row_mid) & (~row_down) & 0x3FF;
        uint16_t solid_mask = row_up & row_mid & row_down;
        uint16_t left_solid  = (solid_mask << 1) | 1;      // 左壁を含む
        uint16_t right_solid = (solid_mask >> 1) | 0x200;  // 右壁を含む
        if (empty_mask & left_solid & right_solid) {
            hasIWellInRow[cy] = true;
        }
    }

    // TSDスロット地形のスキャン（穴・blocksOverHole の判定で「TSD空間は穴ではない」と扱うためのマスク生成）
    // ★Phase2: 旧 tsd.count/multiplier ベースのスコアリングは廃止し、評価は evalTSlotChain（cutout先読み）へ移行。
    //   ここでのスキャンはマスク(isTSDRowForBlocksOverHole / ignoreMask)を作る目的のみで残す。
    bool isTSDRowForBlocksOverHole[ROWS] = {false};
    uint32_t ignoreMask = 0; // 穴として数えない行のビットマスク

    // ★最適化: 全セル走査の代わりに列高さウィンドウ候補のみ評価(forEachTSDSlot)。全スロット分マークする。
    forEachTSDSlot(b, heights, [&](int cx, int cy) {
        if (hasIWellInRow[cy]) return;
        isTSDRowForBlocksOverHole[cy]     = true;
        isTSDRowForBlocksOverHole[cy + 1] = true;
        if (maxHeight <= 10) {
            ignoreMask |= (1 << cy);
            ignoreMask |= (1 << (cy + 1));
        }
    });

    if (maxHeight <= 10) {
        for(int x = 0; x < COLS; x++) {
            int leftDiff  = (x == 0)       ? 999 : heights[x-1] - heights[x];
            int rightDiff = (x == COLS-1)  ? 999 : heights[x+1] - heights[x];
            if(leftDiff >= 4 && rightDiff >= 4) {
                int startY = ROWS - heights[x];
                for (int dy = 0; dy < 4; dy++) {
                    if (startY + dy >= 0 && startY + dy < ROWS) {
                        ignoreMask |= (1 << (startY + dy));
                    }
                }
            }
        }
    }

    // ★最適化：holesのループをビット演算と popcount で一撃で計算
    int holes = 0;
    for (int x = 0; x < COLS; x++) {
        if (cols[x] == 0) continue;
        int first_y = __builtin_ctz(cols[x]);
        uint32_t filled = cols[x] | ignoreMask;
        uint32_t mask = ~((1 << first_y) - 1);
        filled |= ~mask;                         // ブロック上空を 1 にして穴判定から消す
        filled |= ~((1 << ROWS) - 1);            // 盤面外を 1 にする
        holes += 32 - __builtin_popcount(filled); // 残った 0 の数が穴の数
    }
    score += holes * w.hole;
    if (holes > 0) score += (holes * holes) * (w.hole / 2);

    // ★最適化：pureHole も盤面の多重ループを消滅させ、ビット演算に置換
    int pureHolesCount = 0;
    for(int y = 0; y < ROWS; y++) {
        uint16_t row  = b.rows[y];
        uint16_t empty = (~row) & 0x3FF;
        uint16_t up    = (y == 0)       ? 0x3FF : b.rows[y-1];
        uint16_t down  = (y == ROWS-1)  ? 0x3FF : b.rows[y+1];
        uint16_t left_wall  = (row << 1) | 1;
        uint16_t right_wall = (row >> 1) | 0x200;
        uint16_t pure = empty & up & down & left_wall & right_wall;
        pureHolesCount += __builtin_popcount(pure);
    }
    score += pureHolesCount * w.pureHole;
    if (pureHolesCount > 0) score += pureHolesCount * w.pureHole;

    // 段差評価
    int step1Count = 0, step2Count = 0, step3PlusCount = 0;
    for(int x = 0; x < COLS - 1; x++) {
        int diff = std::abs(heights[x] - heights[x+1]);
        if(diff == 0)      score += w.flat;
        else if(diff == 1) step1Count++;
        else if(diff == 2) step2Count++;
        else               step3PlusCount += diff;
    }
    score += (step1Count <= 2) ? (step1Count * w.step1Good) : (step1Count * w.step1Bad);
    score += step2Count * w.step2;
    score += step3PlusCount * w.step3Plus;

    // Iウェル評価
    // 最下段まで連続している場合のみスコアに反映（中断したウェルは無視）
    int totalIWellScore = 0;
    for(int x = 0; x < COLS; x++) {
        int continuousEmpty = 0;
        for(int y = 0; y < ROWS; y++) {
            if(__builtin_popcount(b.rows[y]) == 9 && !((b.rows[y] >> x) & 1)) {
                continuousEmpty++;
            } else {
                continuousEmpty = 0;
            }
        }
        // ループ終了後のcontinuousEmptyは最下段を含む連続深さ（0なら底に届いていない）
        if(continuousEmpty > 0) {
            int wellScore = (continuousEmpty <= 10) ? continuousEmpty * w.iWell
                                                    : 10 * w.iWell + (continuousEmpty - 10) * w.iWellOver;
            if (x <= 1 || x >= 8) totalIWellScore -= wellScore / 4;
            else                   totalIWellScore += wellScore;
        }
    }
    score += totalIWellScore;

    // ★最適化：totalBlocksOverLowestHole もループと条件分岐を消し去り、ビット演算に置換
    uint32_t tsdr_mask = 0;
    for (int y = 0; y < ROWS; y++) if (isTSDRowForBlocksOverHole[y]) tsdr_mask |= (1 << y);

    int totalBlocksOverLowestHole = 0;
    for (int x = 0; x < COLS; x++) {
        uint32_t c = cols[x];
        if (c == 0) continue;
        int firstBlockY = __builtin_ctz(c);
        uint32_t inv = ~c & ((1 << ROWS) - 1);
        inv &= ~((1 << (firstBlockY + 1)) - 1); // 最初のブロックより上空を無視
        if (inv != 0) {
            int lowestHoleY = 31 - __builtin_clz(inv); // 一番下にある穴の位置を特定
            // 高さ13以上はTSD地形の行も穴の上のブロックとしてカウント（危機的状況の検知）
            uint32_t valid_blocks = (maxHeight <= 12) ? (c & ~tsdr_mask) : c;
            valid_blocks &= ((1 << lowestHoleY) - 1);  // 穴より上空のブロックだけを残す
            totalBlocksOverLowestHole += __builtin_popcount(valid_blocks);
        }
    }
    score += totalBlocksOverLowestHole * w.blocksOverHole;

    // ★Phase2: T-slot 先読み評価（TSD/TSS チェーン, cutout シミュレート）
    //   来るTの本数(upcomingT)を上限に、実際に回し入れられる TSD/TSS を最大2回先読みして加点。
    //   盤面が汚い（穴・蓋が多い）ほど TSD 追求を抑制し掘りへ誘導する減衰は従来通り維持する。
    // ★修正(回帰対応): upcomingT は実質下限1にクランプ。ビームの最終スコアは最深ノードの盤面評価を
    //   使うが、深いノードは可視キューのTを消費して upcomingT=0 になりやすく、それだと TSD の価値が
    //   選択スコアから消えて「TSDを全く建設しない」状態になっていた。TSD建設誘導は常時ONにする。
    int effUpcomingT = std::max(upcomingT, 1);
    int tSlotCap = std::min(effUpcomingT, 2);
    if (tSlotCap >= 1) {
        int rawTSlot = evalTSlotChain(b, tSlotCap, w);
        int dirtPenalty = holes * 10 + totalBlocksOverLowestHole * 4;
        int tsdFactor = std::max(10, 100 - dirtPenalty);
        score += rawTSlot * tsdFactor / 100;
    }

    // TSDセットアップ評価
    int tsdSetupCount = 0;
    // ★新実装：より厳密なTSDセットアップ形状を以下の3条件で判定する
    // 空白マス(x, y)を起点として：
    // 条件1: (x-1,y), (x+1,y), (x,y+1) がすべて空白
    // 条件2: 4隅 A(x-1,y-1) B(x+1,y-1) C(x-1,y+1) D(x+1,y+1) のうち、
    //        2-1: AC埋まりBD空白 / 2-2: CD埋まりAB空白 / 2-3: BD埋まりAC空白 のいずれか
    // 条件3: E(x-2,y+1) F(x+2,y+1) G(x-2,y+2) H(x-1,y+3) I(x+2,y+2) J(x+1,y+3) を使い、
    //        2-1達成時: F空白 かつ (I or J 埋まり)
    //        2-2達成時: E or F 埋まり
    //        2-3達成時: E空白 かつ (G or H 埋まり)
    //
    // ビットボード座標系: y=0が盤面最上段、y=ROWS-1が最下段
    // has(x,y): x<0 || x>=COLS || y>=ROWS → true(壁扱い), y<0 → false(空扱い)
    {
        // セルの空白判定ヘルパー（範囲外は壁＝埋まり扱い）
        auto isFilled = [&](int cx, int cy) -> bool {
            if (cx < 0 || cx >= COLS) return true;  // 壁は埋まり扱い
            if (cy < 0) return false;                 // 盤面上空は空扱い
            if (cy >= ROWS) return true;              // 盤面下端以下は埋まり扱い
            return (b.rows[cy] & (1 << cx)) != 0;
        };
        // auto isEmpty = [&](int cx, int cy) -> bool {
        //     return !isFilled(cx, cy);
        // };

        // x: 1~COLS-2（左右隣が盤面内に収まる範囲）
        // y: 0~ROWS-4（y+3まで参照するため下限を確保）
        for (int y = 0; y < ROWS - 1; y++) {
            // 条件1の空白マス(x,y)の候補をビット演算で絞り込む
            // (x,y), (x-1,y), (x+1,y), (x,y+1) がすべて空白
            // → row[y] の各ビットが 0、かつ row[y+1] も対応ビットが 0、かつ左右ビットも 0
            uint16_t cand = (~b.rows[y]) & (~b.rows[y+1]) & 0x3FF; // (x,y)と(x,y+1)が空白
            // 左右隣 (x-1,y) と (x+1,y) が空白: row[y] の左右シフトとAND
            uint16_t row_y = b.rows[y];
            uint16_t left_empty  = ~(row_y << 1) & 0x3FF; // ビットx-1が空 → ビットxを残す
            uint16_t right_empty = ~(row_y >> 1) & 0x3FF; // ビットx+1が空 → ビットxを残す
            cand &= left_empty & right_empty;
            // 端の列（x=0, x=COLS-1）は左右参照が壁になるため除外
            cand &= 0x1FE; // bit1~bit8 (x=1~8) のみ有効

            if (!cand) continue; // この行に候補がなければスキップ

            for (int x = 1; x < COLS - 1; x++) {
                if (!((cand >> x) & 1)) continue; // 条件1を満たさない列はスキップ

                // 4隅の埋まり状態
                bool A = isFilled(x-1, y-1); // 左上
                bool B = isFilled(x+1, y-1); // 右上
                bool C = isFilled(x-1, y+1); // 左下
                bool D = isFilled(x+1, y+1); // 右下

                // 条件2の判定
                bool cond2_1 = ( A &&  C && !B && !D); // 2-1: AC埋まりBD空白
                bool cond2_2 = ( C &&  D && !A && !B); // 2-2: CD埋まりAB空白
                bool cond2_3 = ( B &&  D && !A && !C); // 2-3: BD埋まりAC空白

                if (!cond2_1 && !cond2_2 && !cond2_3) continue;

                // 参照点 E~J の埋まり状態
                bool E = isFilled(x-2, y+1);
                bool F = isFilled(x+2, y+1);
                bool G = isFilled(x-2, y+2);
                bool H = isFilled(x-1, y+3);
                bool I = isFilled(x+2, y+2);
                bool J = isFilled(x+1, y+3);
                bool K = isFilled(x-2, y-3);
                bool L = isFilled(x+2, y-3);

                // 条件3の判定
                bool cond3 = false;
                if (cond2_1) cond3 = (!F && (I || J)); // 2-1: F空白かつ(IまたはJ埋まり)
                if (cond2_2) cond3 = ( (E && !K) ||  (F && !L));        // 2-2: EまたはF埋まり
                if (cond2_3) cond3 = (!E && (G || H)); // 2-3: E空白かつ(GまたはH埋まり)

                if (cond3) tsdSetupCount++;
            }
        }
    }
    // ★Phase2: 来るTの本数を超えるセットアップは作っても使えないため上限を制限。
    //   ただし下限1にクランプ（effUpcomingT）し、TSD土台の建設誘導は常時残す（回帰対応）。
    if (tsdSetupCount > effUpcomingT) tsdSetupCount = effUpcomingT;
    if (tsdSetupCount > 0) {
        if (tsdSetupCount <= 2) score += tsdSetupCount * w.tsdSetup;
        else                    score += tsdSetupCount * w.tsdSetupOver;
    }

    // ★追加：凹みが中央にある評価（centerDip）
    // 各列の高さを低い順にソートし、下位3列が列3~6の範囲内ならボーナス、範囲外ならペナルティ
    // 最低列に1.0倍、下位2・3番目に0.1倍の倍率をかける
    {
        // (高さ, 列インデックス) のペアを作り、高さ昇順でソート
        std::pair<int,int> heightIdx[COLS];
        for (int x = 0; x < COLS; x++) heightIdx[x] = {heights[x], x};
        std::sort(heightIdx, heightIdx + COLS,
            [](const std::pair<int,int>& a, const std::pair<int,int>& b){ return a.first < b.first; });

        // 下位3列（高さが低い＝最も凹んでいる列）を対象とする
        // 倍率：1位(最低)=1.0、2位=0.1、3位=0.1
        const float multipliers[3] = { 1.0f, 0.01f, 0.01f };
        for (int rank = 0; rank < 3; rank++) {
            int col = heightIdx[rank].second;
            bool isCenterCol = (col >= 3 && col <= 6); // 列3~6が中央
            int sign = isCenterCol ? 1 : -1;
            score += (int)(sign * multipliers[rank] * w.centerDip);
        }
    }

    return score;
}

// ────────────────────────────────────────────────
// 【報酬】evalPlacementEvent
// その1手を置いたことで「今回だけ」発生したイベントを評価する（1回限り加算）。
// 含む要素：ライン消去・4-LINES・Tスピン(TSS/TSD/TST)・BtB・コンボ・接地ボーナス・ダウンスタック
// ────────────────────────────────────────────────
int evalPlacementEvent(
    const Board& afterBoard,
    const Board& beforeClearBoard,
    int linesCleared, bool isGrounded, int touchingCount,
    int tSpinType, int ren, bool backToBack,
    const GridBlock* droppedBlocks,
    int prevMaxHeight,
    const EvalWeights& w
) {
    int score = 0;

    // ── ライン消去スコア ──
    if (linesCleared > 0) score += (linesCleared - 2) * w.lineClear;
    if (linesCleared >= 4) score += w.line4;

    // ── ダウンスタック（穴に蓋をせず掘れたかを評価） ──
    // 盤面にholeが存在し、1〜3ライン消去が発生した場合のみ処理する。
    // A: 消去最下段の1つ下の行の空白位置 / B: 消去最上段の1つ上の行のブロック位置。
    // 消去後はBの行がAの真上に落ちる。Aの空白の上にBのブロックが乗る(=穴に蓋)ならbad、乗らなければgood。
    if (linesCleared >= 1 && linesCleared <= 3) {
        // 消去前盤面にholeが存在するか（あるブロックの下に空白があるか）を上から走査して判定
        bool hasHole = false;
        uint16_t filledAbove = 0;
        for (int y = 0; y < ROWS; y++) {
            uint16_t row = beforeClearBoard.rows[y] & 0x3FF;
            if ((~row) & filledAbove & 0x3FF) { hasHole = true; break; }
            filledAbove |= row;
        }

        if (hasHole) {
            // 消去ライン(満杯=0x3FF)の最上段(最小y)・最下段(最大y)を特定
            int clearTopY = -1, clearBottomY = -1;
            for (int y = 0; y < ROWS; y++) {
                if (beforeClearBoard.rows[y] == 0x3FF) {
                    if (clearTopY == -1) clearTopY = y;
                    clearBottomY = y;
                }
            }

            // A: 消去最下段の1つ下の行の空白位置（盤面外は満杯扱い＝空白なし）
            uint16_t rowA   = (clearBottomY + 1 < ROWS) ? beforeClearBoard.rows[clearBottomY + 1] : 0x3FF;
            uint16_t emptyA = (~rowA) & 0x3FF;

            // B: 消去最上段の1つ上の行のブロック位置（盤面外はブロックなし扱い）
            uint16_t rowB   = (clearTopY - 1 >= 0) ? beforeClearBoard.rows[clearTopY - 1] : 0;
            uint16_t blockB = rowB & 0x3FF;

            // 消去後、Aの空白の真上にBのブロックが来る(overlap)か
            uint16_t overlap = emptyA & blockB;

            if (overlap != 0) score += w.downstackBad;   // 穴に蓋をしてしまう
            else              score += w.downstackGood;  // 穴を埋めずきれいに掘れた
        }
    }

    // ── 接地・接触ボーナス ──
    if (isGrounded) {
        score += w.groundedBonus;
        score += touchingCount * w.touchingBonus;
    } else {
        score -= 3 * w.groundedBonus;
    }

    // ── Tスピン消去ボーナス / ミニTスピンペナルティ ──
    if (tSpinType == 1) {
        if (linesCleared == 1)      score += w.tssClear;
        else if (linesCleared == 2) score += w.tsdClear;
        else if (linesCleared >= 3) score += w.tstClear; // ★Phase1: TST(3ライン)
    } else if (tSpinType == 2) {
        score += w.tsmMiniPenalty;
    }

    // ── BtB（バックトゥバック）維持・破壊 ──
    if (linesCleared > 0) {
        bool isBtBAction = (linesCleared >= 4) || (tSpinType > 0 && linesCleared > 0);
        if (isBtBAction) {
            score += w.btbKeep;
            if (backToBack) score += w.btbKeep; // BtB継続ボーナス
        } else {
            score -= w.btbKeep;
            if (backToBack) score -= w.btbKeep * 2; // BtB破壊ペナルティ
        }
    }

    // ── コンボボーナス ──
    if (ren > 0 && prevMaxHeight >= 10) score += (ren - 2) * (ren) * w.comboBonus;
    if (ren > 4)                        score += ren * ren * w.comboBonus;

    return score;
}

// ────────────────────────────────────────────────
// 【生存判定用】estimateAttack
// その1手で相手へ送る火力(=自分の着弾おじゃまを相殺できる量)を概算する。
// src/game/tet/scoring.js の「マージン未突入」固定テーブルに準拠（厳密値ではなく生存判定用の近似）。
//   linesCleared: 消去ライン数 / tSpinType: 0=なし 1=通常Tスピン 2=ミニ
//   b2bBefore: 配置前のBtB状態 / renBefore: 配置前のコンボ数(=火力計算上の currentRenForGarbage)
// ────────────────────────────────────────────────
int estimateAttack(int linesCleared, int tSpinType, bool b2bBefore, int renBefore) {
    if (linesCleared <= 0) return 0;
    int g = 0;
    if (tSpinType == 1) {            // 通常Tスピン: TSS=2, TSD=4, TST=6
        g = linesCleared * 2;
    } else if (tSpinType == 2) {     // ミニTスピン: 基本火力0扱い
        g = 0;
    } else {                         // 通常消し
        if (linesCleared == 2) g = 1;
        else if (linesCleared == 3) g = 2;
        else if (linesCleared == 4) g = 4;
        // single(1ライン)は0
    }
    // BtBボーナス（BtB対象手をBtB中に出した場合 +1）
    bool isB2BAction = (linesCleared >= 4) || (tSpinType == 1 && linesCleared > 0);
    if (b2bBefore && isB2BAction) g += 1;
    // RENボーナス（固定テーブル。renBefore=加算前のコンボ数）
    int r = renBefore;
    if (r == 2 || r == 3)      g += 1;
    else if (r == 4 || r == 5) g += 2;
    else if (r == 6 || r == 7) g += 3;
    else if (r >= 8 && r <= 12) g += 4;
    else if (r >= 13)          g += 5;
    return g;
}

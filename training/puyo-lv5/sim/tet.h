// ─────────────────────────────────────────────
// sim/tet.h — テトのプレイヤー（異種戦シミュの相手役 テト CPU lv5／テト同士の対戦 lv4・lv5・lv6）
//
//   本番 JS（public/game/tet/{board,scoring,garbage,rotation}.js・public/cpu/tet/lv5/cpu5.js）のうち
//   勝敗に効くものを ms 時間で移植する。探索は本番 cpu5.cpp をそのまま呼ぶ（sim/tet_cpu5.cpp）。
//   設計: source_assets/memory/cpu/puyo/lv6-vstet-design.md §6・§7
//         テト同士: source_assets/memory/cpu/tet/lv5-terrain-design.md §4
//
//   座標は CPU と同じ「内部座標」：盤面 10×25、行0=最上段（本番 y=-5）、行5..24=可視20段。
// ─────────────────────────────────────────────
#pragma once

#include <stdint.h>
#include <functional>
#include <vector>

namespace tsim {

constexpr int TCOLS = 10;
constexpr int TROWS = 25;
constexpr int THIDDEN = 5;
constexpr int TET_W_LEN = 33;        // 旧 lv5（sim/frozen/cpu5_v1.cpp）の weightsArray
constexpr int TET_W_LEN5 = 47;       // 新 lv5（本番 cpu5.js onMinoSpawned の weightsArray。[33..] は地形強化 T1〜T6）
constexpr int TET_W_LEN4 = 24;       // cpu4.js の weightsArray
constexpr int TET_W_LEN6 = 55;       // cpu6.js の weightsArray（[39..] は lv6 強化 B1〜B9、設計 lv6-boost-design.md §3。[50..51] は相殺外し lv6-tankable-design.md。[52..54] は REN 偏重の是正・PC lv6-style-design.md）
constexpr int TET_W_MAX = 64;        // TetPlayer::weights の枠（レベルごとの長さは tetWeightsLen）
constexpr int TET_OUT_LEN = 43;      // searchBestMoveWasm の outResult

// ── 時間（cpu5.js。lv4/lv6 は tetLevelTiming）──
constexpr double T_ACTION_MS    = 45.0;   // actionDelay（executeAction の開始待ち・回転・左右1列）
constexpr double T_HARDDROP_MS  = 150.0;  // harddropDelay（ハードドロップの後）
constexpr double T_GARBAGE_READY_FROM_TET_MS = 1500.0;  // テト→テト（garbage.js sendGarbage）
constexpr double T_SOFTDROP_MS  = 50.0;   // levelSpeed/20（VERSUS は Level 1 = 1000ms）
constexpr double T_NOMOVE_MS    = 700.0;  // 置き場所が無いときのその場ハードドロップ
constexpr double T_GARBAGE_READY_FROM_PUYO_MS = 1000.0; // ぷよ→テトは段階式（ここでは未使用。T2）

// レベル番号：4=lv4、5=新 lv5（本番 cpu5.cpp）、6=lv6、15=旧 lv5（固定版 sim/frozen/cpu5_v1.cpp）。
//   TetPlayer の既定は 15（ぷよの対テト学習の相手役は旧 lv5 のまま。設計 lv5-terrain-design.md §7-3）。
constexpr int TET_LV5_OLD = 15;
// 26＝lv6＋PC 探索（本番 pc6.cpp を native で呼ぶ。sim/tet_pc6.cpp）。7＝参考AI clys（sim/tet_clys.cpp）。
//   設計 source_assets/memory/cpu/tet/clys-port-design.md §6
constexpr int TET_LV6_PC = 26;
constexpr int TET_CLYS = 7;
// 36＝lv6 の新しい探索（本番 public/cpu/tet/lv6/engine。sim/tet_cpu6n.cpp）。設計 lv6-phase1-search-design.md
constexpr int TET_LV6N = 36;

// 思考時間のモデル化（既定オフ＝従来どおり探索は 0ms）。オンにすると、探索（PC 探索・ビーム・clys）に
//   実際にかかった時間 × scale を、設置の後の待ち（harddropDelay）と重ねて操作開始を遅らせる（cpu6.js の
//   「HD 後に次のミノを探索 → tryFinish で実行」の流れ）。スレッドを立てる前に呼ぶこと
void setTetModelThink(bool on, double scale);

// 旧 lv5 の重み（固定）・新 lv5 の重み（本番 cpu5.js の this.weights、weightsArray の順）
extern const int TET_LV5_WEIGHTS[TET_W_LEN];
extern const int TET_LV5N_WEIGHTS[TET_W_LEN5];
extern const int TET_LV4_WEIGHTS[TET_W_LEN4];   // 本番 cpu4.js
extern const int TET_LV6_WEIGHTS[TET_W_LEN6];   // 本番 cpu6.js

// レベル（4/5/6）ごとの既定値
struct TetLevelTiming { double actionMs, harddropMs; };
TetLevelTiming tetLevelTiming(int level);   // cpu4/5/6.js の actionDelay / harddropDelay
void setTetLevelTiming(int level, double actionMs, double harddropMs);   // 差し替え（0 以下で本番の値に戻す）
int        tetWeightsLen(int level);
const int* tetDefaultWeights(int level);

// ── 探索（旧 lv5：sim/tet_cpu5.cpp。新 lv5：sim/tet_cpu5n.cpp）──
void cpuSearchLv5(const uint8_t board[250], int cur, int hold, const int next[5], int canHold,
                  const int* weights, int ren, int b2b, int out[TET_OUT_LEN]);
void cpuSearch(const uint8_t board[250], int cur, int hold, const int next[5], int canHold,
               const int weights[TET_W_LEN], int ren, int b2b, int out[TET_OUT_LEN]);
// lv4（sim/tet_cpu4.cpp）・lv6（sim/tet_cpu6.cpp。PC 探索は無し）
void cpuSearchLv4(const uint8_t board[250], int cur, int hold, const int next[5], int canHold,
                  const int* weights, int out[TET_OUT_LEN]);
void cpuSearchLv6(const uint8_t board[250], int cur, int hold, const int next[8], int canHold,
                  const int* weights, int ren, int b2b, int incoming, int out[TET_OUT_LEN]);
// lv6 の幅・深さ・NEXT 本数を指定する版（本番 cpu6.cpp searchBestMoveExt。lv6-learning-design.md Phase 0）
void cpuSearchLv6Ext(const uint8_t board[250], int cur, int hold, const int* next, int nNext, int canHold,
                     const int* weights, int ren, int b2b, int incoming, int width, int depth, int out[TET_OUT_LEN]);
long long lv6NodeCount();   // このスレッドで lv6 が展開した配置の累計
// lv6 の PC 探索（sim/tet_pc6.cpp）。pieces = current＋NEXT10、out は 256 int（pc6.cpp の形式）
void cpuSearchPC6(const uint8_t board[250], const int pieces[11], int hold, int canHold, int maxDepth, int maxTimeMs,
                  int out[256]);
// clys（sim/tet_clys.cpp）。引数・出力は public/cpu/tet/clys/native/clys_wasm.cpp の clysSearch と同じ
void cpuSearchClys(const uint8_t board[250], const int* queueAll, int nAll, int nSearch, int hold, int bagAfter,
                   int b2b, int ren, int incoming, int thinkMs, int width, int branch, int* out, int outLen);
void cpuSearchClysEx(const uint8_t board[250], const int* queueAll, int nAll, int nSearch, int hold, int bagAfter,
                     int b2b, int ren, int incoming, int thinkMs, int width, int branch, int depth, int* out, int outLen);
unsigned long long clysNodeCount();   // このスレッドで clys が実際に展開したノードの累計
// lv6 の新しい探索（sim/tet_cpu6n.cpp）。引数・出力は public/cpu/tet/lv6/engine/lv6_wasm.cpp の lv6Search と同じ
void cpuSearchLv6n(const uint8_t board[250], const int* queue, int nQueue, int hold, int bagAfter, int b2b, int ren,
                   int incoming, const int* weights, int nWeights, int width, int depth, int thinkMs, int* out,
                   int outLen);
const int* lv6nDefaultWeights();
int lv6nWeightsLen();
void pieceBlocks(int type, int rot, int outXY[8]);     // PRECALC_MINO_BLOCKS（本番 Mino と同じ形）
void kickTable(int type, int fromRot, int dir, int outKicks[10]);  // 内部座標の (dx,dy)×5
void initTetShapes();
int  tetGaugeToOjama(int gauge);   // garbage_router.ts tetGaugeToOjama   // ミノの形の表を作る（スレッドを立てる前に1回）

// 7種袋の乱数（本番 Math.random の代わり。シードで再現できればよい）
struct TRng {
    uint32_t s;
    explicit TRng(uint32_t seed = 1) : s(seed ? seed : 1) {}
    double next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (double)s / 4294967296.0; }
};

// テトのおじゃまキュー要素（garbage.js garbageQueue）
struct TGarbage {
    int    id = 0;
    int    amount;
    std::vector<int> holes;
    bool   ready;
    double readyAt;        // この時刻で ready になる（猶予タイマー）
    double internalUntil;  // ぷよから届く stage1（internal）の終わり
};

// 1回の設置の結果（ログ・集計用）
struct TLockEvent {
    double t;
    int    type, lines, tspin;   // tspin: 0=なし 1=tspin 2=mini
    bool   pc, b2b;
    int    ren;                  // 加算前の REN
    int    puyoAttack;           // 対ぷよゲージに足した量（相殺後）
    int    tetAttack;            // 内部火力（テト用ライン）
};

struct TSendEvent { double t; int gauge; int ojama; };

// 集計
struct TetStats {
    int pieces = 0, holds = 0, lines = 0, tspins = 0, tsMini = 0, tetrises = 0, pcs = 0, b2bs = 0;
    int maxRen = 0;
    long long gaugeSent = 0, ojamaSent = 0;      // 対ぷよに放出したゲージ・おじゃま個数
    long long tetAttack = 0;                      // 内部火力の合計（テト同士なら送るライン）
    int teleports = 0;                            // moveToTargetX の「塞がれて目標へ瞬間移動」（本番の癖）
    int routeMiss = 0;                            // 操作列を実行した結果が探索の初手の位置（4マス）と違った回数（移植の確認用）
    int routeInstant = 0, routePath = 0, routeFull = 0, noMove = 0;
    int garbageLinesTaken = 0;
    long long linesReceived = 0;                  // ぷよ（テト同士ならテト）から届いたライン（相殺前）
    long long tetSent = 0;                        // テト同士：相殺の後で相手へ送ったライン
    // T-spin の内訳（消去あり・mini を除く）と PC 探索・思考時間（clys 比較 §6）
    int tss = 0, tsd = 0, tst = 0;
    int pcSearches = 0, pcFound = 0, pcAborted = 0, pcMoves = 0;
    double pcSearchMs = 0, thinkMs = 0, waitMs = 0;   // PC 探索の合計・全探索の合計・それで延びた待ちの合計
    int maxSpike = 0;                             // 消去が続いた間に送った火力（内部火力）の最大
    // REN の長さ（画面の「N REN」＝連続消去数−1）ごとの回数と、REN ボーナスで出した火力（lv6-style-design.md）
    int ren1 = 0, ren2to5 = 0, ren6plus = 0;
    long long renAtk = 0;
    long long nodes = 0;                          // 探索で展開したノード数（lv6・clys。lv6-learning-design.md Phase 0）
    // lv6n：探索が予測した T-spin の種類（消去ありの手だけ）と、ゲームが判定した種類が違った回数（Phase 1 の確認用）
    int tsPred = 0, tsPredMiss = 0, tsUnpred = 0;
};

class TetPlayer {
public:
    // 盤面
    uint16_t rows[TROWS];
    // ミノ
    int cur = -1, hold = -1;
    bool canHold = true;
    std::vector<int> queue;      // NEXT（先頭が次）
    std::vector<int> bag;
    TRng rng;
    // 状態
    int ren = 0;
    bool b2b = false;
    bool dead = false;
    double now = 0;              // 次に CPU が動ける時刻（executeAction の時刻）
    // 対戦設定
    int marginTimeMs = 96000;    // <0 で無効
    int holeRatePercent = 70;
    bool damageOnClear = true;
    // 攻撃（対ぷよ）
    int pendingAttack = 0;       // ゲージ（送信用）
    int pendingInternal = 0;     // 内部火力（相殺用）
    std::vector<TGarbage> garbageQueue;
    // CPU のレベル（4/5/6）と操作時間。setLevel で既定値（本番の重み・時間）に揃える
    int level = TET_LV5_OLD;
    double actionMs = T_ACTION_MS, harddropMs = T_HARDDROP_MS;
    // テト同士（相手がテト）：受けの上限なし・消去時に即送信（board.js secureMino のテト同士の分岐）
    bool vsTet = false;
    // 操作開始の揺らぎ（executeAction の待ちに 0〜jitterMs を足す）。本番は setTimeout・Worker 往復の揺れで
    //   同じレベル同士でも鏡写しにならないが、シミュは決定的なので、同じ重み同士だと全局が同じ展開になる。既定0
    double jitterMs = 0;
    // 重み（先頭 tetWeightsLen(level) 個を使う）
    int weights[TET_W_MAX];
    // 記録
    TetStats st;
    std::vector<TLockEvent> locks;
    std::vector<TSendEvent> sends;
    bool keepLog = false;
    // lv6 の PC 探索（level 26 で on）・clys の設定
    bool pcEnabled = false;
    int clysThinkMs = 100, clysWidth = 500, clysBranch = 3, clysNext = 8;
    // ★Phase 0（lv6-learning-design.md）：確定 NEXT の内部保持数（本番 lifecycle.js は 11）・clys の深さの上限、
    //   lv6 の幅・深さ・NEXT 本数（本番 16・8・8。違う値なら searchBestMoveExt を使う）
    int queueLen = 11, clysDepth = 32;
    int lv6Width = 16, lv6Depth = 8, lv6Next = 8;
    // 思考時間の倍率（setTetModelThink の scale にさらに掛ける。実機 wasm の速さに合わせる用）。
    //   pcThinkScale は PC 探索だけの倍率（上限 300/100ms で頭打ち＝倍率を掛けた後に上限で切る）
    double thinkScale = 1.0, pcThinkScale = 1.0;

    // seed＝ツモの乱数（VERSUS は両者共通のツモ）、holeSeed＝テト同士で送るおじゃまの穴（0 なら seed から作る）
    explicit TetPlayer(uint32_t seed, uint32_t holeSeed = 0);
    void setLevel(int lv);
    void start(double t0);               // 最初のミノを出す
    // 1手進める（HOLD を含めて1つ設置するまで）。設置した時刻を返す。dead なら負
    double step();
    // 対戦用に step を2つに分けたもの。plan＝探索して操作を決め、設置する時刻を返す（盤面は変えない。HOLD はここで済ませる）。
    //   commit＝その時刻に設置する（相殺・おじゃまの適用・次のミノ）。plan と commit の間に届いたおじゃまも本番どおり効く。
    double plan();
    void   commit();
    bool   planned() const { return hasPlan_; }
    double plannedT() const { return lockT_; }

    // ぷよ→テト（puyo ojama.js sendGarbage → deliverLocalStaged）：500ms 非表示 → 送り手の連鎖終了で確定。id を返す
    int  receiveFromPuyo(int lines, double now);
    void confirmFromPuyo(const std::vector<int>& ids);
    // テト→ぷよの送信（消去なしの設置でゲージを放出した時刻と個数）
    std::function<void(double, int)> onSend;
    // テト→テトの送信（相殺の後に残ったライン数と、送る側で決めた穴の列）
    std::function<void(double, int, const std::vector<int>&)> onSendTet;
    void receiveFromTet(int lines, const std::vector<int>& holes, double now);   // 1500ms 後に ready
    int  incomingLines() const;          // cpu6.js getIncomingGarbage（internal を除く予告の合計）
    int  marginStep(double t) const;     // -1=マージン前、0..5
    int  stackHeight() const;            // 一番上のブロックの高さ（0..25）

    // テスト用：探索の入出力を残す
    struct SearchCase { uint8_t board[250]; int cur, hold, next[8], canHold, ren, b2b, incoming; int out[TET_OUT_LEN]; };
    std::vector<SearchCase>* traceCases = nullptr;

    // ぷよ→テトのおじゃまを積む（T2 で使う。ここでは単体テスト用に直接）
    void pushGarbageLines(int lines, double readyAt);

private:
    int  nextType();
    TRng holeRng;                        // テト同士で送るおじゃまの穴（ツモの乱数と分ける＝両者のツモ列を揃える）
    TRng jitRng;                         // jitterMs 用
    double jit() { return jitterMs > 0 ? jitRng.next() * jitterMs : 0.0; }
    void search(SearchCase& sc);         // レベルごとの探索の呼び分け
    bool spawn(int type);                // 出現（本番 popMino の判定）。false=Block Out
    bool valid(int type, int rot, int x, int y) const;
    bool canDrop(int type, int rot, int x, int y0, int y1) const;  // canDropStraightFromTo
    bool tryRotate(int dir);
    void lockPiece(double t);            // secureMino
    int  checkTSpin() const;
    void applyGarbage();
    void releaseAttack(double t, bool cleared, int puyoAtk, int tetAtk);

    // 操作中のミノ
    int px = 0, py = 0, prot = 0;
    bool lastRot = false, lastPoint5 = false;
    // plan → commit
    bool hasPlan_ = false, planNoMove_ = false;
    double lockT_ = 0;
    int nextGarbageId_ = 1;
    // 探索で決めずに置く手（clys の HOLD 後の1手・PC 手順の残り）
    struct Decision { int id, rot, x, y, tspin; bool useHold, fromPC; std::vector<int> path; };
    std::vector<Decision> pending_;
    uint16_t pcExpected_[TROWS];
    double thinkRef_ = 0;                // 探索を始めた時刻（直前の設置・HOLD）
    int predTs_ = -1;                    // lv6n が予測したこの手の T-spin（0/1/2、-1=予測なし）
    int spikeRun_ = 0;
    int clearRun_ = 0;   // 続いている消去の数（REN の長さの集計用）
    bool shouldSearchPC() const;
    bool pcStepValid(const Decision& d) const;
    void pcAdvanceExpected(const Decision& d);
    bool findPose(int id, const int cellsXY[8], int& rot, int& x, int& y) const;
    std::vector<int> holesFor(int lines) { return holesFor(lines, rng); }
    std::vector<int> holesFor(int lines, TRng& r);
};

} // namespace tsim

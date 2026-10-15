// ─────────────────────────────────────────────
// sim/sim.h — ぷよ VERSUS 対戦シミュレータ（lv5 学習用）
//
//   本番 JS エンジン（public/game/puyo/{engine,ojama,lifecycle,draw}.js）のうち
//   「勝敗に効くもの」をイベント駆動（ms 時間）で移植する。演出（描画・SE）は捨てる。
//   CPU の探索は本番と同じ native ソース（public/cpu/puyo/lv5/native）をそのまま呼ぶ。
//   設計: source_assets/memory/cpu/puyo/lv5-training-design.md
// ─────────────────────────────────────────────
#pragma once

#include <stdint.h>
#include <string>
#include <vector>

#include "def.h"   // COLS / ROWS / HIDDEN / TOTAL_ROWS（native と共通）

namespace sim {

// ── 時間定数（public/core/base.js PConfig と CPU 操作遅延 cpu5.js）──
constexpr double SPAWN_ANIM_MS    = 62.0;                 // spawnAnimMs
constexpr double THINK_DELAY_MS   = 100.0;                // PuyoCPU5.thinkDelay
constexpr double ACTION_DELAY_MS  = 50.0;                 // PuyoCPU5.actionDelay
constexpr double VIB_PHASE_MS     = 1000.0 / 60.0 * 1.2;  // vibPhaseMs（振動1フェーズ）
constexpr double VIB_CYCLE_MS     = 4.0 * VIB_PHASE_MS;   // 振動1サイクル（_addPuyoAnim: cycles*4*vibPhaseMs）
constexpr double FIX_WAIT_MS      = 1000.0 / 60.0 * 5.0;  // fixWait5fMs
constexpr double ERASE_MS         = 28.0 * 16.67;         // eraseMs
constexpr double ERASE_WAIT_MS    = 270.0;                // eraseWaitMs
constexpr double DROP_MS_PER_ROW  = 50.0;                 // _stepDropAnim: cellSize/50 px/ms
constexpr double SPLIT_MS_PER_ROW = 500.0 / 6.0;          // splitDropSpeed
constexpr double INTERNAL_MS      = 500.0;                // ojama.js sendGarbage INTERNAL_MS
constexpr int    FIX_CYCLES       = 2;                    // _calcFixCycles（CPU はソフトドロップ無し）
constexpr int    SPLIT_FIX_CYCLES = 3;                    // splitting 着地の振動
constexpr int    ZENKESHI_BONUS   = 2100;
constexpr int    OJAMA_LIMIT      = 30;                   // _generateOjama limit
constexpr int    ERASE_COUNT      = 4;
constexpr int    NEXT_KEEP        = 20;                   // 内部 NEXT 保持数

// ── 重みパラメータ（Python ↔ C++ の受け渡し単位）──
constexpr int W_LEN  = 43;                 // cpu5_weights.js _buildWeightsArray の要素数
constexpr int PP_LEN = W_LEN * 2 + 2;      // build[43] + fast[43] + counterTrigger + counterMargin×1000

struct PolicyParams {
    int    build[W_LEN];      // 本線構築（build）の weightsArray
    int    fast[W_LEN];       // カウンター（fast）の weightsArray（学習中は固定＝D2）
    int    counterTrigger;    // COUNTER_TRIGGER_OJAMA_VSPUYO（受け量がこれを「超えたら」fast）
    double counterMargin;     // COUNTER_MARGIN_VSPUYO（fireScoreThreshold の倍率）
    static PolicyParams fromPacked(const int* p);
};

// ── 対戦設定（public/config/vs_settings.js の既定値）──
struct GameSettings {
    int    ojamaRate    = 70;
    int    colorCount   = 4;
    int    marginTimeMs = 96000;   // <0 で無効
    double maxGameMs    = 600000;  // これを超えたら引き分け
};

// ── 乱数（public/app/versus.js createSeededRandom の xorshift32 を JS の int32 演算どおりに）──
struct JsRng {
    int32_t s;
    explicit JsRng(uint32_t seed = 1) : s((int32_t)seed) {}
    double next() {
        s ^= (int32_t)((uint32_t)s << 13);
        s ^= (s >> 17);                       // JS の >> は算術シフト
        s ^= (int32_t)((uint32_t)s << 5);
        return (double)(uint32_t)s / 4294967296.0;
    }
    int nextInt(int n) { return (int)(next() * n); }   // Math.floor(r * n)
};

// ── 盤面（JS field と同じ: 行0=最上段, 0..4=隠し, 5..16=可視）──
struct Cell { int r, c; };
struct Field {
    uint8_t v[TOTAL_ROWS][COLS];
    void clear();
    bool empty() const;
};

struct DropInfo {
    bool   moved;       // 1マスでも落ちたか（_buildDropAnim が作られるか）
    int    maxDist;     // 最大落下段数（アニメ時間）
    int    vibCycles;   // 落下後の振動サイクル最大（0=色ぷよの落下無し）
};

// 消去判定（engine.js _findErasableInField と同じ。可視段のみ・おじゃまは隣接で巻き込み）
void findErasable(const Field& f, std::vector<std::vector<Cell>>& groups, std::vector<Cell>& ojama);
// 1段の連鎖スコア（engine.js _calcChainScore の add）
int  chainStepScore(const std::vector<std::vector<Cell>>& groups, const Field& f, int chainCount);
// 重力（全17段）。落下アニメ情報を返す（engine.js _buildDropAnim と同じ落下量）
DropInfo applyGravity(Field& f);
// 盤面のコピーで残り連鎖を最後まで回したスコア合計と段数（chainCountStart から継続）
long long simulateRemainingChain(Field f, int chainCountStart, int* outChains = nullptr);

// ── おじゃまキュー要素（ojama.js garbageQueue の {amount, ready, internal}）──
struct Garbage {
    int    id;
    int    amount;
    bool   ready;
    double internalUntil;   // この時刻までは stage1（internal・着弾不可）
};

struct PlayerStats {
    int       turns = 0;
    int       maxChain = 0;
    long long maxChainScore = 0;
    long long ojamaSent = 0;       // 相殺後に相手へ送った量
    long long ojamaReceived = 0;   // 実際に盤面へ降った量
    int       firstBigChainTurn = -1;   // ひとり用: targetChain 以上の初発火ターン
    int       counterTurns = 0;    // fast（カウンター）で打ったターン数
};

// ── 記録（負け方の分析用。Player::trace が nullptr の学習時は何もしない）──
// 発火点の生死：1列の上に同色を 1〜maxAdd 個足して起こせる最大連鎖（ツモに依らない「撃てる状態」の指標）
struct Ignite { int chains = 0; long long score = 0; int need = 0; };
Ignite bestIgnition(const Field& f, int maxAdd = 3);

struct TraceTurn {             // decide()（spawnAnim 開始時の思考）ごとの盤面と思考結果
    double t; int turn; int mode;          // mode 0=build 1=fast（カウンター）
    int incoming, queue;                   // 受け量（確定＋予測）／おじゃまキュー総量
    int fire, reason;                      // この手で撃つ段数（0=育成）／発火理由（build.cpp dbg[23]）
    int fireableChains, fireableScore;     // 現ペアを置けば撃てる最大（dbg[21][22]）
    int potChains, potScore;               // 選択初手の到達連鎖（dbg[20]）／全候補の到達連鎖最大（dbg[12]）
    Ignite ign;                            // bestIgnition
    int puyos, ojama, h[COLS];
};
struct TraceFire {             // 1回の連鎖（発火〜連鎖終了）
    double tStart = 0, tEnd = 0;
    int turn = 0, mode = 0, reason = 0, chains = 0;
    long long score = 0;
    int offset = 0, sent = 0;              // 相殺した量／相手へ送った量
    int queueBefore = 0;                   // 発火時点のおじゃまキュー
    int puyosBefore = 0, ojamaBefore = 0, puyosAfter = 0, ojamaAfter = 0;
    std::vector<std::vector<int>> steps;   // 段ごとの消えたグループのサイズ
    std::vector<int> stepColors;           // 段ごとの色数
    std::vector<int> stepOjamaErased;      // 段ごとに巻き込んで消えたおじゃま
    std::string board;                     // 発火直前の盤面（17×6, '0'..'6'）
};
struct TraceDrop { double t; int turn, amount; Ignite before, after; };
struct PlayerTrace {
    std::vector<TraceTurn> turns;
    std::vector<TraceFire> fires;
    std::vector<TraceDrop> drops;
    std::string finalBoard;
};
std::string boardString(const Field& f);

class Player {
public:
    enum Phase { SPAWN, PLACE, CHECK, ERASED, SPAWN_ANIM_END, DEAD };

    Player(const PolicyParams& pp, const GameSettings& gs, uint32_t seed);

    double nextT() const { return t_; }
    bool   dead()  const { return phase_ == DEAD; }
    void   step(Player* opp);          // t_ の時刻にある遷移を1つ処理する
    int    rateAt(double t) const;     // マージンタイム込みのおじゃまレート

    // ひとり用の設定
    int targetChain = 0;

    PlayerTrace* trace = nullptr;   // 分析用の記録先（nullptr=記録しない）

    PlayerStats stats;

    // ── 相手から参照される状態（JS で CPU が読む値）──
    int  chainCount = 0;
    long long chainFullOjama = 0;   // 発火中連鎖を全段打ち切った時の総おじゃま見込み（_oppChainFull）
    int  generatedOjamaTotal = 0;
    int  pendingFire = 0;
    std::vector<Garbage> garbageQueue;
    int  queueSum() const;

    // 相手からの受信（sendGarbage → deliverLocalStaged）
    int  receiveGarbage(int amount, double now);
    void confirmGarbage(const std::vector<int>& ids);

    Field field;

    // テスト用：ツモ列（初期 NEXT 生成後に n 個取り出した順）。他の乱数消費を挟まない
    std::vector<std::pair<int,int>> debugPairSequence(int n);

private:
    friend struct SimTest;   // tests/test_ojama.cpp
    void decide(Player* opp);
    void applyOffset(int amount, Player* opp, double now);
    bool generateOjama();
    void chainEnd(Player* opp);

    const PolicyParams& pp_;
    GameSettings gs_;
    JsRng rng_;
    int   activeColors_[5];
    int   nColors_;
    std::vector<std::pair<int,int>> next_;   // nextQueue
    double t_ = 0;
    Phase  phase_ = SPAWN;
    bool   firstTurn_ = true;

    long long attackScore_ = 0;
    bool  hasDroppedOjamaThisTurn_ = false;
    bool  counterActive_ = false;
    std::vector<int> sentThisTurn_;
    std::vector<std::vector<Cell>> pendingGroups_;
    std::vector<Cell> pendingOjamaCells_;
    int   nextGarbageId_ = 1;

    // 決定済みの着手（spawnAnim 開始時に前倒し計算）
    int   decCol_ = -1, decRot_ = -1;
    bool  decided_ = false;
    int   curPivot_ = 0, curChild_ = 0;
    int   turnChainScore_ = 0;
    int   lastMode_ = 0, lastReason_ = 0;   // 記録用：直近の decide() のモード・発火理由
    bool  fireOpen_ = false;                // 記録用：trace->fires.back() が連鎖中
    long long turnChainScoreSum_ = 0;

    std::pair<int,int> makePair(int excludeColor);
    void initNextQueue();
};

// ── 対局 ──
struct MatchResult {
    int    winner;        // 0=A勝ち 1=B勝ち -1=引き分け
    double durationMs;
    PlayerStats a, b;
};
MatchResult runMatch(const PolicyParams& a, const PolicyParams& b, uint32_t seed, const GameSettings& gs,
                     PlayerTrace* ta = nullptr, PlayerTrace* tb = nullptr);

struct SoloResult {
    PlayerStats st;
    bool   died;
    double durationMs;
};
SoloResult runSolo(const PolicyParams& p, uint32_t seed, int maxTurns, int targetChain, const GameSettings& gs,
                   PlayerTrace* tr = nullptr, int harassTurn = 0, int harassAmount = 0);

} // namespace sim

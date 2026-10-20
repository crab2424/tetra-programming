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

namespace tsim { class TetPlayer; struct TetStats; }   // 異種戦のテト側（sim/tet.h）

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
constexpr int W_LEN  = 62;                 // cpu5_weights.js _buildWeightsArray の要素数
constexpr int EXT_LEN = 16;                // 試作中の対戦判断（ext[]）。0 埋め＝無効＝現行 lv5 と同じ
constexpr int PP_LEN = W_LEN * 2 + 2 + EXT_LEN; // build[62] + fast[62] + counterTrigger + counterMargin×1000 + ext[16]

// ext[] の添字（設計: source_assets/memory/cpu/puyo/lv5-vs-decision-design.md）
enum ExtIndex {
    X_P1_ENABLE = 0,     // 提案1 相手を見た発火判断 1/0
    X_P1_ALPHA,          // 目標到達でも「自分の火力 ≥ α% × 相手の起こせる火力」の時だけ撃つ（%）
    X_P1_KILL_RATIO,     // 目標未達でも「相手の起こせる火力 ≤ k% × 自分の火力」なら撃つ（%。0=無効）
    X_P1_KILL_MIN,       // ↑の最低火力（おじゃま個数）
    X_P2_ENABLE,         // 提案2 後打ちの活用 1/0
    X_P2_SAFETY_MS,      // 待てる時間の安全マージン（ms）
    X_P2_MIN_INCOMING,   // 待つのは「相手の発火中連鎖で届く量」がこれ以上の時（個）
    X_P2_WAIT_FAST,      // 待つ間の重み 0=build / 1=fast
    X_P2_TURN_MS,        // 撃たない1手の所要時間の見積もり（ms。0=既定 560）
    X_P2_FIRE_IF_PCT,    // 待つ手の発火閾値＝pct% × (受け量+1) × rate（今撃てる最大が届けば撃つ。0=撃たない）
    X_P2_NO_SPILL,       // 待つ間は育成手のこぼれ（小連鎖の暴発）を禁止 1/0
    X_P1_USE_THREAT,     // 相手の火力に「相手の見えている NEXT 2手で届く連鎖」も使う 1/0
};

struct PolicyParams {
    int    build[W_LEN];      // 本線構築（build）の weightsArray
    int    fast[W_LEN];       // カウンター（fast）の weightsArray（学習中は固定＝D2）
    int    counterTrigger;    // COUNTER_TRIGGER_OJAMA_VSPUYO（受け量がこれを「超えたら」fast）
    double counterMargin;     // COUNTER_MARGIN_VSPUYO（fireScoreThreshold の倍率）
    int    ext[EXT_LEN];      // 試作中の対戦判断（ExtIndex）
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
// 次の消去判定を待つ盤面から、連鎖が終わる（消えるものが無い判定）までの ms
//   （本番 cpu5_worker_io.js _puyoChainRemainingMs と同じ計算。tests/test_parity.py で照合）
double chainRemainingMs(Field f);
// 盤面のコピーで残り連鎖を最後まで回したスコア合計と段数（chainCountStart から継続）
long long simulateRemainingChain(Field f, int chainCountStart, int* outChains = nullptr);

// ── おじゃまキュー要素（ojama.js garbageQueue の {amount, ready, internal}）──
struct Garbage {
    int    id;
    int    amount;
    bool   ready;
    double internalUntil;   // この時刻までは stage1（internal・着弾不可）
    double readyAt = 1e18;  // テトから届いたもの：この時刻で ready（deliverLocalWithReadyTimer 1000ms）。ぷよからは confirm で ready
};

struct PlayerStats {
    int       turns = 0;
    int       maxChain = 0;
    long long maxChainScore = 0;
    long long ojamaSent = 0;       // 相殺後に相手へ送った量
    long long ojamaReceived = 0;   // 実際に盤面へ降った量
    int       firstBigChainTurn = -1;   // ひとり用: targetChain 以上の初発火ターン
    int       counterTurns = 0;    // fast（カウンター）で打ったターン数
    int       waitTurns = 0;       // 提案2：相手の連鎖中に撃たずに伸ばしたターン数
    int       p1Holds = 0;         // 提案1：目標到達だが相手が返せるので撃たなかったターン数（試作 ext と P [61] の両方）
    int       p1Kills = 0;         // 提案1：目標未達だが相手が返せないので撃ったターン数
    long long tetLinesSent = 0;    // 異種戦：テトへ送ったライン（相殺後）
    long long freeOffsets = 0;     // 異種戦：段の点で受けを全部消し、その段の点を丸ごと攻撃に使えた回数（ただの相殺）
    long long offsetByScore = 0;   // 異種戦：段の点で相殺したおじゃま個数
};

// ── 記録（負け方の分析用。Player::trace が nullptr の学習時は何もしない）──
// 発火点の生死：1列の上に同色を 1〜maxAdd 個足して起こせる最大連鎖（ツモに依らない「撃てる状態」の指標）
struct Ignite { int chains = 0; long long score = 0; int need = 0; int col = -1, color = 0; };
Ignite bestIgnition(const Field& f, int maxAdd = 3);
// 有効ぷよ量の指標：bestIgnition の連鎖を実際に回して、絡まない色ぷよ（残り）と途中段の余剰を数える。
//   colored=盤面の色ぷよ / leftover=その連鎖の後に残る色ぷよ（無駄ぷよ＋次の種）/
//   excess=最終段以外の各段で4個を超えて消えた数。発火できない盤面は leftover=colored・excess=0。
struct BoardWaste { int colored = 0, leftover = 0, excess = 0; };
BoardWaste boardWaste(const Field& f, const Ignite& ign);

struct TraceTurn {             // decide()（spawnAnim 開始時の思考）ごとの盤面と思考結果
    double t; int turn; int mode;          // mode 0=build 1=fast（カウンター） 2=後打ちで待つ 3=締切 4=地形優先の対応（T）
    int incoming, queue;                   // 受け量（確定＋予測）／おじゃまキュー総量
    int fire, reason;                      // この手で撃つ段数（0=育成）／発火理由（build.cpp dbg[23]）
    int fireableChains, fireableScore;     // 現ペアを置けば撃てる最大（dbg[21][22]）
    int potChains, potScore;               // 選択初手の到達連鎖（dbg[20]）／全候補の到達連鎖最大（dbg[12]）
    Ignite ign;                            // bestIgnition
    int puyos, ojama, h[COLS];
    double oppEnd;                         // 相手の発火中連鎖の終了予測時刻（-1=発火中でない）
    BoardWaste waste;                      // ign の連鎖で見た有効ぷよ量（色ぷよ・残り・余剰）
    int mainChains = 0, mainPuyos = 0;     // quiescence の本線 M の段数・色ぷよ数（G1）
    int subScore = 0, subAllowed = 0;      // 副砲 S の点／G1・G2 を満たし E2b を足す状態か
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
    // 相手から見える NEXT（盤面に置かれる前の2ペア）。pairs[4] = {p1,c1,p2,c2}
    void visibleNext(int* pairs) const {
        pairs[0] = next_[0].first; pairs[1] = next_[0].second;
        pairs[2] = next_[1].first; pairs[3] = next_[1].second;
    }
    // 発火中の連鎖が終わる（＝送ったおじゃまが ready になる）時刻。発火中でなければ -1
    double chainEndTime() const;
    // 自分のキューに「次の手の終わりに降る」おじゃまがあるか（ready かつ非表示期間明け・時刻 t で）
    bool hasDroppableAt(double t) const;

    // 相手からの受信（sendGarbage → deliverLocalStaged）
    int  receiveGarbage(int amount, double now);
    // 異種戦：テトからの受信（tet/garbage.js sendGarbage → deliverLocalWithReadyTimer 1000ms。非表示期間なし）
    void receiveFromTet(int amount, double now);
    // 異種戦：相手をテトにする（nullptr＝ぷよ相手／ひとり用）
    tsim::TetPlayer* tet = nullptr;
    // テスト用（tests/test_tet_attack.py）：状態を入れて _resolveTetAttack を1回呼ぶ。戻り値＝この段のライン
    int testResolveTet(int chainCountIn, double carry, bool zen, int add, int n, const std::vector<Garbage>& q,
                       double* outCarry, bool* outZen);
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
    void refreshReady();                    // テトから届いたおじゃまの猶予タイマー
    void resolveTetAttack(int add, int n);  // ojama.js _resolveTetAttack（消去の瞬間）
    void applyOffsetTet(int amount, int tetAmount, double now);   // _applyOjamaOffset（相手がテト）
    double tetCarry_ = 0;                   // tetAttackCarry
    bool  hasTetZenkeshi_ = false;
    int   tetPending_ = 0;                  // tetPendingFire
    int   tetCalcAdd_ = 0, tetCalcN_ = 0;   // 点滅時に控える消去点・個数
    std::vector<int> sentTetThisTurn_;

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

// 異種戦：ぷよ（PolicyParams：build=vsTet・fast=fastVsTet の重み）対 テト CPU lv5
struct VsTetResult {
    int    winner;        // 0=ぷよ勝ち 1=テト勝ち -1=引き分け
    double durationMs;
    PlayerStats puyo;
    int    tetPieces, tetLines, tetTspins, tetTetrises, tetB2bs;
    long long tetOjamaSent, tetGaugeSent, tetLinesReceived;
    int    tetGarbageTaken, tetFinalHeight;
};
VsTetResult runMatchVsTet(const PolicyParams& puyo, uint32_t seed, const GameSettings& gs, bool puyoFirst,
                          PlayerTrace* tp = nullptr);

struct SoloResult {
    PlayerStats st;
    bool   died;
    double durationMs;
};
SoloResult runSolo(const PolicyParams& p, uint32_t seed, int maxTurns, int targetChain, const GameSettings& gs,
                   PlayerTrace* tr = nullptr, int harassTurn = 0, int harassAmount = 0);

} // namespace sim

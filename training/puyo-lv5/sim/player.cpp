// ─────────────────────────────────────────────
// sim/player.cpp — 1プレイヤーの状態機械（イベント駆動・ms）＋ lv5 の JS 側ポリシー
//
//   状態遷移は engine.js _update の switch(_gs) を、イベント時刻で表したもの:
//     SPAWN          … _spawnPuyo（NEXT を1つ取り出す）→ CPU 操作（thinkDelay + actionDelay×操作数）
//     PLACE          … quickDrop 着地（ちぎりは splitting）→ 振動 → fixWait5f
//     CHECK          … checkErase（連鎖あり→ERASED / なし→連鎖終了処理）
//     ERASED         … 点滅終了＝消去の瞬間（相殺・送信）→ eraseWait → 落下 → 振動 → fixWait5f
//     SPAWN_ANIM_END … spawnAnim 終了（chainCount=0）→ SPAWN
//   CPU の思考は spawnAnim 開始時に前倒しで行う（cpu5.js _updateLoop の precompute）。
//   ポリシー（モード切替・受け量推定）は cpu5_worker_io.js の移植。
// ─────────────────────────────────────────────
#include "sim.h"
#include "tet.h"

#include "core/bitboard.h"
#include "core/weights.h"
#include "build/build.h"
#include "eval/shape.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace sim {

PolicyParams PolicyParams::fromPacked(const int* p) {
    PolicyParams pp;
    std::memcpy(pp.build, p, sizeof(int) * W_LEN);
    std::memcpy(pp.fast, p + W_LEN, sizeof(int) * W_LEN);
    pp.counterTrigger = p[2 * W_LEN];
    pp.counterMargin  = p[2 * W_LEN + 1] / 1000.0;
    std::memcpy(pp.ext, p + 2 * W_LEN + 2, sizeof(int) * EXT_LEN);
    return pp;
}

static void toBitBoard(const Field& f, BitBoard& b) {
    b.fromArray(&f.v[0][0]);   // JS boardBuffer と同じ r*COLS+c 配置
}
static void fromBitBoard(const BitBoard& b, Field& f) {
    for (int r = 0; r < TOTAL_ROWS; r++)
        for (int c = 0; c < COLS; c++)
            f.v[r][c] = b.get(c, r);
}

Player::Player(const PolicyParams& pp, const GameSettings& gs, uint32_t seed)
    : pp_(pp), gs_(gs), rng_(seed) {
    field.clear();
    // lifecycle.js _initActiveColors（Fisher-Yates で5色から colorCount 色）
    int all[5] = {1, 2, 3, 4, 5};
    for (int i = 4; i > 0; i--) {
        int j = rng_.nextInt(i + 1);
        std::swap(all[i], all[j]);
    }
    nColors_ = std::max(1, std::min(5, gs_.colorCount));
    for (int i = 0; i < nColors_; i++) activeColors_[i] = all[i];
    initNextQueue();
}

std::pair<int,int> Player::makePair(int excludeColor) {
    int avail[5], n = 0;
    for (int i = 0; i < nColors_; i++)
        if (activeColors_[i] != excludeColor) avail[n++] = activeColors_[i];
    int c1 = avail[rng_.nextInt(n)];
    int c2 = avail[rng_.nextInt(n)];
    return {c1, c2};
}

// engine.js _initNextQueue
void Player::initNextQueue() {
    next_.clear();
    auto p1 = makePair(-1);
    next_.push_back(p1);
    int unused[5], nu = 0;
    for (int i = 0; i < nColors_; i++) {
        int c = activeColors_[i];
        if (c != p1.first && c != p1.second) unused[nu++] = c;
    }
    int exclude = -1;
    if (nu > 0) exclude = unused[rng_.nextInt(nu)];
    next_.push_back(makePair(exclude));
    while ((int)next_.size() < NEXT_KEEP) next_.push_back(makePair(-1));
}

std::vector<std::pair<int,int>> Player::debugPairSequence(int n) {
    std::vector<std::pair<int,int>> out;
    for (int i = 0; i < n; i++) {
        out.push_back(next_.front());
        next_.erase(next_.begin());
        while ((int)next_.size() < NEXT_KEEP) next_.push_back(makePair(-1));
    }
    return out;
}

int Player::rateAt(double t) const {
    if (gs_.marginTimeMs < 0 || t < gs_.marginTimeMs) return gs_.ojamaRate;
    static const int TABLE[11] = {52, 34, 25, 16, 12, 8, 6, 4, 3, 2, 1};
    int step = (int)((t - gs_.marginTimeMs) / 16000.0);
    return TABLE[std::min(step, 10)];
}

int Player::queueSum() const {
    int s = 0;
    for (const auto& g : garbageQueue) s += g.amount;
    return s;
}

double Player::chainEndTime() const {
    if (chainCount <= 0) return -1;
    Field f = field;
    double t;
    auto stepAfterErase = [&](double t0) {
        DropInfo di = applyGravity(f);
        double tt = t0 + ERASE_WAIT_MS;
        if (di.moved) tt += di.maxDist * DROP_MS_PER_ROW + di.vibCycles * VIB_CYCLE_MS + FIX_WAIT_MS;
        return tt;
    };
    if (phase_ == ERASED) {          // 点滅中：消える組はまだ盤面にある。t_ が消去の瞬間
        for (const auto& g : pendingGroups_) for (const auto& c : g) f.v[c.r][c.c] = 0;
        for (const auto& c : pendingOjamaCells_) f.v[c.r][c.c] = 0;
        t = stepAfterErase(t_);
    } else if (phase_ == CHECK) {    // 落下・振動の後、t_ に次の消去判定
        t = t_;
    } else {
        return -1;                   // 連鎖は終わっている（spawnAnim 中など）
    }
    return t + chainRemainingMs(f);
}

bool Player::hasDroppableAt(double t) const {
    for (const auto& g : garbageQueue)
        if (g.ready && g.amount > 0 && t >= g.internalUntil) return true;
    return false;
}

int Player::receiveGarbage(int amount, double now) {
    Garbage g;
    g.id = nextGarbageId_++;
    g.amount = amount;
    g.ready = false;
    g.internalUntil = now + INTERNAL_MS;
    garbageQueue.push_back(g);
    return g.id;
}

void Player::receiveFromTet(int amount, double now) {
    Garbage g;
    g.id = nextGarbageId_++;
    g.amount = amount;
    g.ready = false;
    g.internalUntil = now;       // 非表示期間なし
    g.readyAt = now + 1000.0;    // 異種戦（テト→ぷよ）は 1000ms 後に降下可能
    garbageQueue.push_back(g);
}

void Player::refreshReady() {
    for (auto& g : garbageQueue)
        if (!g.ready && t_ >= g.readyAt) g.ready = true;
}

void Player::confirmGarbage(const std::vector<int>& ids) {
    for (int id : ids)
        for (auto& g : garbageQueue)
            if (g.id == id) g.ready = true;
}

// ojama.js _applyOjamaOffset（火力補正 1.0 前提）。ready → 未 ready の順に相殺し、残りを相手へ。
void Player::applyOffset(int amount, Player* opp, double now) {
    if (amount <= 0) return;
    int remaining = amount;
    for (int pass = 0; pass < 2 && remaining > 0; pass++) {
        bool wantReady = (pass == 0);
        for (auto& g : garbageQueue) {
            if (remaining <= 0) break;
            if (g.ready != wantReady || g.amount <= 0) continue;
            int take = std::min(g.amount, remaining);
            g.amount -= take;
            remaining -= take;
        }
    }
    garbageQueue.erase(std::remove_if(garbageQueue.begin(), garbageQueue.end(),
                                      [](const Garbage& g) { return g.amount <= 0; }),
                       garbageQueue.end());
    if (trace && fireOpen_) trace->fires.back().offset += amount - remaining;
    if (remaining > 0 && opp) {
        sentThisTurn_.push_back(opp->receiveGarbage(remaining, now));
        stats.ojamaSent += remaining;
        if (trace && fireOpen_) trace->fires.back().sent += remaining;
    }
}

// ojama.js _generateOjama（ready かつ internal 明けのものだけ、最大30個）。降ったら true。
bool Player::generateOjama() {
    int drop = 0;
    for (auto& g : garbageQueue) {
        if (drop >= OJAMA_LIMIT) break;
        if (!g.ready || t_ < g.internalUntil || g.amount <= 0) continue;
        int take = std::min(g.amount, OJAMA_LIMIT - drop);
        g.amount -= take;
        drop += take;
    }
    garbageQueue.erase(std::remove_if(garbageQueue.begin(), garbageQueue.end(),
                                      [](const Garbage& g) { return g.amount <= 0; }),
                       garbageQueue.end());
    if (drop <= 0) return false;
    TraceDrop td;
    if (trace) { td.t = t_; td.turn = stats.turns; td.amount = drop; td.before = bestIgnition(field); }

    int rows = drop / COLS, fractions = drop % COLS;
    for (int i = 0; i < rows; i++)
        for (int c = 0; c < COLS; c++) field.v[HIDDEN - 1 - i][c] = 6;
    if (fractions > 0) {
        int r = HIDDEN - 1 - rows;
        int cols[COLS], nc = 0;
        while (nc < fractions) {   // 端数列：重複しない列を乱数で（受信 holes 無しのぷよ経路）
            int avail[COLS], na = 0;
            for (int c = 0; c < COLS; c++) {
                bool used = false;
                for (int k = 0; k < nc; k++) if (cols[k] == c) used = true;
                if (!used) avail[na++] = c;
            }
            cols[nc++] = avail[rng_.nextInt(na)];
        }
        for (int i = 0; i < fractions; i++) field.v[r][cols[i]] = 6;
    }
    stats.ojamaReceived += drop;
    hasDroppedOjamaThisTurn_ = true;
    DropInfo di = applyGravity(field);
    if (trace) { td.after = bestIgnition(field); trace->drops.push_back(td); }
    // dropping（おじゃまは振動なし）→ fixAnim(0) → fixWait5f → checkErase
    t_ += di.maxDist * DROP_MS_PER_ROW + di.vibCycles * VIB_CYCLE_MS + FIX_WAIT_MS;
    phase_ = CHECK;
    return true;
}

// ojama.js _resolveTetAttack（相手がテト。火力補正 1.0 前提）。段ごとに点からラインを決め、tetPending_ に足す。
//   受けがあれば点で相殺する。段の点で受けを全部消せて、持ち越し分だけでは足りなかったときは、
//   その段の消去点を丸ごと攻撃に使う（本番の「異種戦におけるぷよの優位拡大のための仕様」）。
void Player::resolveTetAttack(int add, int n) {
    static const int SCORE_TABLE[7][2] = {{7, 13300}, {6, 5320}, {5, 2240}, {4, 1120}, {3, 700}, {2, 420}, {1, 210}};
    static const int PUYO_TABLE[4][2] = {{4, 14}, {3, 12}, {2, 9}, {1, 8}};
    const double rate = rateAt(t_);
    pendingFire = 0;   // 二重相殺を防ぐ
    double baseCarry = tetCarry_;
    if (chainCount == 1 && hasTetZenkeshi_) baseCarry += ZENKESHI_BONUS;   // 落下点数（tetDropScore）は CPU では 0
    double currentA = baseCarry + add;
    const int pendingOj = queueSum();
    double scoreForAttack = currentA;
    double carryOver = 0;
    if (pendingOj > 0) {
        const double req = pendingOj * rate;
        if (currentA >= req) {
            garbageQueue.clear();
            stats.offsetByScore += pendingOj;
            if (baseCarry < req) { scoreForAttack = add; stats.freeOffsets++; }
            else scoreForAttack = currentA - req;
        } else {
            int offsetCount = (int)std::floor(currentA / rate);
            carryOver = std::fmod(currentA, rate);
            stats.offsetByScore += offsetCount;
            for (int pass = 0; pass < 2 && offsetCount > 0; pass++)
                for (auto& g : garbageQueue) {
                    if (offsetCount <= 0) break;
                    if (g.ready != (pass == 0) || g.amount <= 0) continue;
                    int take = std::min(g.amount, offsetCount);
                    g.amount -= take;
                    offsetCount -= take;
                }
            garbageQueue.erase(std::remove_if(garbageQueue.begin(), garbageQueue.end(),
                                              [](const Garbage& g) { return g.amount <= 0; }),
                               garbageQueue.end());
            scoreForAttack = 0;
        }
    }
    currentA = scoreForAttack;
    int lines = 0;
    double used = 0;
    for (const auto& th : SCORE_TABLE) {
        double req = th[1] / 70.0 * rate;
        if (currentA >= req) { lines = th[0]; used = req; break; }
    }
    int addLines = 0;
    for (const auto& pt : PUYO_TABLE) if (n >= pt[1]) { addLines = pt[0]; break; }
    int total = lines + (lines >= 1 ? addLines : 0);
    if (hasTetZenkeshi_) { total += 2; hasTetZenkeshi_ = false; }
    tetCarry_ = currentA - used;
    if (pendingOj > 0 && scoreForAttack == 0) tetCarry_ = carryOver;
    if (total > 0) tetPending_ += total;
}

int Player::testResolveTet(int chainCountIn, double carry, bool zen, int add, int n, const std::vector<Garbage>& q,
                           double* outCarry, bool* outZen) {
    chainCount = chainCountIn;
    tetCarry_ = carry;
    hasTetZenkeshi_ = zen;
    garbageQueue = q;
    tetPending_ = 0;
    resolveTetAttack(add, n);
    *outCarry = tetCarry_;
    *outZen = hasTetZenkeshi_;
    return tetPending_;
}

// ojama.js _applyOjamaOffset（相手がテト）。ぷよ火力で相殺し、減った割合だけテトへのラインも減らして送る。
void Player::applyOffsetTet(int amount, int tetAmount, double now) {
    const int original = std::max(0, amount);
    int remaining = original;
    for (int pass = 0; pass < 2 && remaining > 0; pass++)
        for (auto& g : garbageQueue) {
            if (remaining <= 0) break;
            if (g.ready != (pass == 0) || g.amount <= 0) continue;
            int take = std::min(g.amount, remaining);
            g.amount -= take;
            remaining -= take;
        }
    garbageQueue.erase(std::remove_if(garbageQueue.begin(), garbageQueue.end(),
                                      [](const Garbage& g) { return g.amount <= 0; }),
                       garbageQueue.end());
    if (trace && fireOpen_) trace->fires.back().offset += original - remaining;
    int send = 0;
    if (original > 0) send = (int)std::ceil(tetAmount * (double)remaining / original);
    else if (tetAmount > 0) send = tetAmount;
    if (send > 0) {
        sentTetThisTurn_.push_back(tet->receiveFromPuyo(send, now));
        stats.tetLinesSent += send;
        if (trace && fireOpen_) trace->fires.back().sent += send;
    }
}

int vtKillScore(int tetHeight, int queuedLines, int tetInternal, int pct, int rate) {
    // 4個消しだけの n 連鎖の点と、その連鎖でテトへ送るライン（_resolveTetAttack・レート70・受け無し）
    static const int SCORE[20] = {0, 40, 360, 1000, 2280, 4840, 8680, 13800, 20200, 27880, 36840,
                                  47080, 58600, 71400, 85480, 100840, 117480, 135400, 154600, 175080};
    static const int LINES[20] = {0, 0, 1, 4, 8, 13, 18, 24, 30, 36, 43, 49, 56, 63, 70, 77, 84, 91, 98, 105};
    int need = (20 - tetHeight) - queuedLines + tetInternal;
    need = (int)std::ceil(std::max(1, need) * pct / 100.0);
    int n = 1;
    while (n < 19 && LINES[n] < need) n++;
    return (int)std::ceil(SCORE[n] * (double)rate / 70.0);
}

// cpu5_worker_io.js _getIncomingBaseline + _updateVersusCounterMode + _buildWeightsArray → searchBuildMode
void Player::decide(Player* opp) {
    const int rate = rateAt(t_);

    int incoming = 0;
    if (opp) {
        int gross = queueSum();
        if (opp->chainCount > 0 && opp->chainFullOjama > 0) {
            int selfFire       = std::max(0, pendingFire);
            int oppQueueGross  = opp->queueSum();
            int oppGenerated   = std::max(0, opp->generatedOjamaTotal);
            int committedNet   = std::max(0, gross - selfFire);
            int leftover       = std::max(0, selfFire - gross);
            int absorbAtOpp    = oppQueueGross + leftover;
            int oppRemaining   = (int)std::max(0LL, opp->chainFullOjama - oppGenerated);
            int anticipated    = std::max(0, oppRemaining - absorbAtOpp);
            incoming = committedNet + anticipated;
        } else {
            incoming = gross;
        }
    } else if (tet) {
        // 相手がテト：確定＝キュー総量、予測＝相手の攻撃ゲージを個数に換算（_getAnticipatedTetOjama）
        incoming = queueSum() + tsim::tetGaugeToOjama(std::max(0, tet->pendingAttack));
    }

    const int* X = pp_.ext;

    // ── 提案2 後打ちの活用（本番 cpu5_worker_io.js _updateCounterWait と同じ判断）──
    //   相手のおじゃまは「相手の連鎖終了で ready → 自分の手の終わりに降る」。撃たない手が
    //   相手の連鎖終了より前に終わる限り降らないので、その間は本線の重みで伸ばし、
    //   今撃てる最大が受け量×fireIfPct% に届いたら撃つ（fireScoreThreshold）。
    //   間に合わなくなった手（締切）では出せる最大を撃つ。
    //   ※ X_P2_WAIT_FAST / X_P2_NO_SPILL は試作のみ（本番には無い。既定0）。
    int waitMode = 0;   // 0=従来 / 1=待つ（伸ばす） / 2=締切（最大を撃つ）
    if (opp && X[X_P2_ENABLE] && opp->chainCount > 0 && incoming >= std::max(1, X[X_P2_MIN_INCOMING])) {
        double tEnd = opp->chainEndTime();
        if (tEnd > t_) {
            double turnMs = X[X_P2_TURN_MS] > 0 ? X[X_P2_TURN_MS] : 560.0;
            bool dropNow = hasDroppableAt(t_ + turnMs);           // 既に降る分がある＝待てない
            waitMode = (!dropNow && t_ + turnMs + X[X_P2_SAFETY_MS] < tEnd) ? 1 : 2;
        }
    }

    bool wantCounter = false;
    if (waitMode == 0) {
        wantCounter = (opp || tet) && (counterActive_ ? incoming > 0 : incoming > pp_.counterTrigger);
        counterActive_ = wantCounter;
    } else {
        counterActive_ = true;   // 撃った後は従来のヒステリシスに戻す
    }

    // ── T 地形優先の対応（本番 cpu5_worker_io.js _updateVersusCounterMode と同じ判断。§13.5）──
    //   受け量が小さい（≦ build の [58]）カウンターの場面は、fast に入らず build の重みのまま、
    //   wasm の fire gate が「残りのおじゃまが降った後の地形」が最大の手（受ける・軽減・返す）を選ぶ。
    const bool terrain = opp && waitMode == 0 && wantCounter && pp_.build[58] > 0 && incoming <= pp_.build[58];

    int wa[W_LEN];
    if (terrain) {
        std::memcpy(wa, pp_.build, sizeof(wa));
        stats.counterTurns++;
    } else if (waitMode == 1) {
        std::memcpy(wa, X[X_P2_WAIT_FAST] ? pp_.fast : pp_.build, sizeof(wa));
        wa[32] = 0;   // 目標発火を切る（緊急発火は残す）
        wa[34] = X[X_P2_FIRE_IF_PCT] > 0
                     ? (int)std::ceil((incoming + 1) * (double)rate * X[X_P2_FIRE_IF_PCT] / 100.0) : 0;
        if (X[X_P2_NO_SPILL]) wa[35] = 1;   // 育成手のこぼれを全面禁止（本線の暴発を防ぐ）
        stats.waitTurns++;
    } else if (waitMode == 2) {
        std::memcpy(wa, pp_.build, sizeof(wa));
        wa[32] = 1;   // 撃てる最大を撃つ
        wa[34] = 1;
        stats.counterTurns++;
    } else if (wantCounter) {
        std::memcpy(wa, pp_.fast, sizeof(wa));
        wa[32] = 0;   // fireChainCount: 段数では撃たない
        if (tet && X[X_VT_COUNTER_PCT] > 0) {
            // ④ 対テト：受け量ちょうどを点で消せれば、その段の点は丸ごと攻撃になる（ただの相殺）＝上乗せ不要。
            //   相殺できるのは届いた分（キュー）だけなので、X_VT_QUEUE_ONLY ならゲージ換算を入れない。
            int base = X[X_VT_QUEUE_ONLY] ? queueSum() : incoming;
            wa[34] = (int)std::ceil(std::max(1, base) * (double)rate * X[X_VT_COUNTER_PCT] / 100.0);
        } else {
            wa[34] = (int)std::ceil((incoming + 1) * (double)rate * pp_.counterMargin);
        }
        stats.counterTurns++;
    } else {
        std::memcpy(wa, pp_.build, sizeof(wa));
        if (tet && X[X_VT_KILL_PCT] > 0) {   // A 撃って倒せるか（§12）
            int queued = 0;
            for (const auto& g : tet->garbageQueue) queued += g.amount;
            wa[62] = vtKillScore(tet->stackHeight(), queued, tet->pendingInternal, X[X_VT_KILL_PCT], rate);
            wa[63] = X[X_VT_KILL_HOLD_PCT];
            wa[64] = X[X_VT_KILL_FIRE];
        }
        if (tet) wa[65] = X[X_VT_STRICT];      // B 整地だけの1連鎖を撃たない（§12）
        if (tet && X[X_VT_DECAY_START_S] > 0 && t_ >= X[X_VT_DECAY_START_S] * 1000.0) {
            // ③ 対テト：経過時間で本線の目標発火を下げる（テトのマージンで火力が増える前に撃つ）
            static const int CHAIN4_SCORE[20] = {0, 40, 360, 1000, 2280, 4840, 8680, 13800, 20200, 27880, 36840,
                                                 47080, 58600, 71400, 85480, 100840, 117480, 135400, 154600, 175080};
            int step = X[X_VT_DECAY_STEP_S] > 0 ? X[X_VT_DECAY_STEP_S] : 10;
            int lo = X[X_VT_DECAY_MIN] > 0 ? X[X_VT_DECAY_MIN] : 3;
            int k = 1 + (int)((t_ - X[X_VT_DECAY_START_S] * 1000.0) / (step * 1000.0));
            if (wa[32] > lo) wa[32] = std::max(lo, wa[32] - k);
            if (wa[32] > 0 && wa[34] > 0) wa[34] = std::min(wa[34], CHAIN4_SCORE[std::min(wa[32], 19)]);
        }
    }
    wa[20] = 9;   // knownNextCount（C++ 側は未参照）

    // ── H1 催促・H2 対応（本番 cpu5_worker_io.js _updateVersusCounterMode と同じ判断）──
    //   [46][49] は思考ごとの入力。build の重みに保存した値を、使う局面でだけ渡す。
    //   H1：build の本線構築中（待ち・カウンターでない）かつ相手が連鎖中でないとき、催促の最低点＝個数×レート。
    //       撃った後に残す本線の絶対量 [50] も個数×レート。
    //   H2：カウンター（fast）中だけ。fast の重みは lv5 基準なので、有効かどうかは build から読む。
    {
        const int* B = pp_.build;
        bool harass = opp && waitMode == 0 && !wantCounter && opp->chainCount == 0 && B[46] > 0;
        wa[46] = harass ? B[46] * rate : 0;
        wa[47] = B[47];
        wa[48] = B[48];
        wa[49] = (!tet && waitMode == 0 && wantCounter && !terrain) ? B[49] : 0;   // H1/H2/T/P は対ぷよのみ
        if (tet && wantCounter) wa[49] = X[X_VT_KEEP_REACH];                        // ② 対テトの H2（既定0）
        wa[50] = tet ? 0 : B[50] * rate;
        wa[57] = terrain ? incoming : 0;
        wa[58] = B[58];
        wa[59] = terrain ? rate : 0;
        // P 相手を見て撃つ（本番 _updateVersusCounterMode と worker の _ignitionScoreWasm と同じ。§13.6）：
        //   build の本線構築中で相手が連鎖中でないとき、相手のすぐ起こせる火力を入れる。
        const bool p1n = opp && waitMode == 0 && !wantCounter && opp->chainCount == 0 && B[61] > 0;
        wa[61] = p1n ? B[61] : 0;
        wa[60] = 0;
        if (p1n) {
            BitBoard ob;
            toBitBoard(opp->field, ob);
            wa[60] = ignitionAfterOjama(ob, 0);
        }
    }

    // nextPairs: 現ペア＝nextQueue[0]（前倒し計算）＋ NEXT 9 本
    int nextPairs[20];
    for (int i = 0; i < 10; i++) {
        nextPairs[i * 2]     = next_[i].first;
        nextPairs[i * 2 + 1] = next_[i].second;
    }

    BitBoard bb;
    toBitBoard(field, bb);
    int out[40];
    for (int i = 0; i < 40; i++) out[i] = -1;

    // ── 提案1（試作）相手を見た発火判断：build の本線構築時だけ ──
    //   目標発火を切って一度探索し（育成手＋「今撃てる最大」out[21][22] が分かる）、
    //   撃つ条件が成立したら目標を「撃てる最大」に下げて探索し直す（発火時だけ2回目）。
    bool p1 = opp && X[X_P1_ENABLE] && waitMode == 0 && !wantCounter && opp->chainCount == 0;
    if (p1) {
        const int tgtCount = wa[32], tgtScore = wa[34];
        wa[32] = 0;
        wa[34] = 0;
        EvalWeights w0 = weightsFromArray(wa);
        searchBuildMode(bb, nextPairs, w0, out);
        long long mine = std::max(0, out[22]);
        long long oppIgn = bestIgnition(opp->field).score;
        if (X[X_P1_USE_THREAT]) {
            // 相手の見えている NEXT 2手で届く連鎖（到達連鎖 out[12]）。深さ2の軽い探索
            int on[20], ow[W_LEN], oo[40];
            opp->visibleNext(on);
            for (int i = 4; i < 20; i++) on[i] = (i % 4) + 1;
            std::memcpy(ow, pp_.build, sizeof(ow));
            ow[23] = 2;
            ow[32] = 0; ow[34] = 0;
            for (int i = 0; i < 40; i++) oo[i] = -1;
            BitBoard ob;
            toBitBoard(opp->field, ob);
            EvalWeights wo = weightsFromArray(ow);
            searchBuildMode(ob, on, wo, oo);
            oppIgn = std::max(oppIgn, (long long)std::max(0, oo[12]));
        }
        bool target = (tgtCount > 0 && out[21] >= tgtCount) || (tgtScore > 0 && mine >= tgtScore);
        bool safe   = mine * 100 >= (long long)X[X_P1_ALPHA] * oppIgn;
        bool kill   = X[X_P1_KILL_RATIO] > 0 && mine >= (long long)X[X_P1_KILL_MIN] * rate &&
                      oppIgn * 100 <= (long long)X[X_P1_KILL_RATIO] * mine;
        if (target && !safe) stats.p1Holds++;
        if (mine > 0 && ((target && safe) || kill)) {
            if (!target) stats.p1Kills++;
            wa[32] = 1;
            wa[34] = 1;
            for (int i = 0; i < 40; i++) out[i] = -1;
            EvalWeights w1 = weightsFromArray(wa);
            searchBuildMode(bb, nextPairs, w1, out);
        }
    } else {
        EvalWeights w = weightsFromArray(wa);
        searchBuildMode(bb, nextPairs, w, out);
    }

    if (out[33] > 0 && (out[33] & (1 << 13))) stats.p1Holds++;   // P で目標発火を保留した
    lastMode_ = terrain ? 4 : waitMode == 1 ? 2 : waitMode == 2 ? 3 : wantCounter ? 1 : 0;   // 記録用 2=待つ 3=締切/即撃ち 4=地形優先の対応
    lastReason_ = out[23];
    if (trace) {
        TraceTurn tt;
        tt.t = t_; tt.turn = stats.turns + 1; tt.mode = lastMode_;
        tt.incoming = incoming; tt.queue = queueSum();
        tt.fire = out[15]; tt.reason = out[23];
        tt.fireableChains = out[21]; tt.fireableScore = out[22];
        tt.potChains = out[20]; tt.potScore = out[12];
        tt.ign = bestIgnition(field);
        tt.waste = boardWaste(field, tt.ign);
        tt.oppEnd = (opp && opp->chainCount > 0) ? opp->chainEndTime() : -1;
        tt.puyos = tt.ojama = 0;
        for (int c = 0; c < COLS; c++) {
            int h = 0;
            for (int r = 0; r < TOTAL_ROWS; r++) {
                uint8_t v = field.v[r][c];
                if (v == 0) continue;
                if (v == 6) tt.ojama++; else tt.puyos++;
                if (r >= HIDDEN) h++;
            }
            tt.h[c] = h;
        }
        {   // 本線 M・副砲 S（build の重みで見た G1/G2 の状態）
            EvalWeights wb = weightsFromArray(pp_.build);
            MainSubInfo ms;
            int pot = 0;
            calcQuiescenceEval(bb, tt.h, wb, &pot, nullptr, &ms);
            tt.mainChains = ms.mainChains; tt.mainPuyos = ms.mainPuyos;
            tt.subScore = ms.subScore; tt.subAllowed = ms.subAllowed ? 1 : 0;
        }
        trace->turns.push_back(tt);
    }

    if (out[0] < 0) { decCol_ = 2; decRot_ = 0; }   // _handleWorkerResult の候補なしフォールバック
    else            { decCol_ = out[0]; decRot_ = out[1]; }
    decided_ = true;
}

void Player::chainEnd(Player* opp) {
    const int rate = rateAt(t_);
    const bool zenkeshiNow = chainCount > 0 && field.empty();   // この回で _confirmSentGarbage に渡す isZenkeshi
    if (chainCount > 0) {
        if (!hasDroppedOjamaThisTurn_) {   // 1ターンで2回通る（おじゃま落下後）ので統計は初回だけ
            if (chainCount > stats.maxChain) stats.maxChain = chainCount;
            if (turnChainScore_ > stats.maxChainScore) stats.maxChainScore = turnChainScore_;
            if (targetChain > 0 && chainCount >= targetChain && stats.firstBigChainTurn < 0)
                stats.firstBigChainTurn = stats.turns;
        }
        attackScore_ %= rate;
        generatedOjamaTotal = 0;
        if (pendingFire > 0) { applyOffset(pendingFire, opp, t_); pendingFire = 0; }
        if (trace && fireOpen_) {
            TraceFire& tf = trace->fires.back();
            tf.tEnd = t_; tf.chains = chainCount; tf.score = turnChainScore_;
            for (int r = 0; r < TOTAL_ROWS; r++)
                for (int c = 0; c < COLS; c++) {
                    uint8_t v = field.v[r][c];
                    if (v == 6) tf.ojamaAfter++; else if (v) tf.puyosAfter++;
                }
            fireOpen_ = false;
        }
    }
    if (!tet && chainCount > 0 && field.empty()) pendingFire += ZENKESHI_BONUS / rate;   // 対テトの pendingFire は次の消去で捨てられる

    if (!hasDroppedOjamaThisTurn_ && queueSum() > 0) {
        if (generateOjama()) return;
    }

    if (opp) opp->confirmGarbage(sentThisTurn_);
    sentThisTurn_.clear();
    if (tet) {   // _confirmSentGarbage（相手がテト）
        tet->confirmFromPuyo(sentTetThisTurn_);
        sentTetThisTurn_.clear();
        tetCarry_ = std::fmod(tetCarry_, (double)rate);
        if (zenkeshiNow) hasTetZenkeshi_ = true;
    }

    if (field.v[HIDDEN][2] != 0) { phase_ = DEAD; return; }   // 致命判定（_isCellEmpty(2, 0)）

    phase_ = SPAWN_ANIM_END;
    decide(opp);                 // spawnAnim 開始時の前倒し計算
    t_ += SPAWN_ANIM_MS;
}

void Player::step(Player* opp) {
    if (tet) refreshReady();
    switch (phase_) {
    case SPAWN_ANIM_END:
        chainCount = 0;
        chainFullOjama = 0;
        phase_ = SPAWN;
        [[fallthrough]];
    case SPAWN: {
        if (field.v[HIDDEN][2] != 0) { phase_ = DEAD; return; }
        if (!decided_) decide(opp);   // 初手は spawn 時に計算（前倒しなし）
        decided_ = false;

        auto pair = next_.front();
        next_.erase(next_.begin());
        while ((int)next_.size() < NEXT_KEEP) next_.push_back(makePair(-1));
        curPivot_ = pair.first;
        curChild_ = pair.second;
        hasDroppedOjamaThisTurn_ = false;
        turnChainScore_ = 0;
        stats.turns++;

        BitBoard bb;
        toBitBoard(field, bb);
        std::vector<PairPlacement> pls = getAllPlacements(bb);
        const PairPlacement* chosen = nullptr;
        for (const auto& p : pls) if (p.col == decCol_ && p.rot == decRot_) { chosen = &p; break; }
        if (!chosen) for (const auto& p : pls) if (p.col == 2 && p.rot == 0) { chosen = &p; break; }
        if (!chosen) { phase_ = DEAD; return; }

        BitBoard nb = applyPlacement(bb, *chosen, (uint8_t)curPivot_, (uint8_t)curChild_);
        fromBitBoard(nb, field);
        // 操作: thinkDelay 後に1手目、以降 actionDelay ごと、最後に quickDrop
        t_ += THINK_DELAY_MS + ACTION_DELAY_MS * chosen->pathLen;
        // 着地（PLACE）の時間もここでまとめて積む
        int split = (chosen->col != chosen->childCol) ? std::abs(chosen->pivotRow - chosen->childRow) : 0;
        if (split > 0) {
            double s = split * SPLIT_MS_PER_ROW;
            t_ += s + std::max(SPLIT_FIX_CYCLES * VIB_CYCLE_MS, FIX_CYCLES * VIB_CYCLE_MS - s);
        } else {
            t_ += FIX_CYCLES * VIB_CYCLE_MS;
        }
        t_ += FIX_WAIT_MS;
        phase_ = CHECK;
        return;
    }
    case PLACE:   // SPAWN で処理済み（未使用）
        phase_ = CHECK;
        return;
    case CHECK: {
        findErasable(field, pendingGroups_, pendingOjamaCells_);
        if (pendingGroups_.empty()) { chainEnd(opp); return; }
        const int rate = rateAt(t_);
        if (chainCount == 0) {
            // 相手 CPU が見る「発火中連鎖の全段見込み」（_estimateOpponentPuyoChainOjama → _oppChainFull）
            long long rest = simulateRemainingChain(field, 0);
            chainFullOjama = (attackScore_ + rest) / rate;
        }
        if (trace) {
            if (chainCount == 0) {
                TraceFire tf;
                tf.tStart = t_; tf.turn = stats.turns; tf.mode = lastMode_; tf.reason = lastReason_;
                tf.queueBefore = queueSum();
                tf.board = boardString(field);
                for (int r = 0; r < TOTAL_ROWS; r++)
                    for (int c = 0; c < COLS; c++) {
                        uint8_t v = field.v[r][c];
                        if (v == 6) tf.ojamaBefore++; else if (v) tf.puyosBefore++;
                    }
                trace->fires.push_back(std::move(tf));
                fireOpen_ = true;
            }
            TraceFire& tf = trace->fires.back();
            std::vector<int> sizes;
            int mask = 0;
            for (const auto& g : pendingGroups_) {
                sizes.push_back((int)g.size());
                mask |= 1 << field.v[g[0].r][g[0].c];
            }
            tf.steps.push_back(sizes);
            tf.stepColors.push_back(__builtin_popcount(mask));
            tf.stepOjamaErased.push_back((int)pendingOjamaCells_.size());
        }
        chainCount++;
        int add = chainStepScore(pendingGroups_, field, chainCount);
        if (tet) {   // _calcChainScore：消去の瞬間の _resolveTetAttack に渡す素材
            int n = 0;
            for (const auto& g : pendingGroups_) n += (int)g.size();
            tetCalcAdd_ = add;
            tetCalcN_ = add > 0 ? n : 0;
        }
        turnChainScore_ += add;
        attackScore_ += add;
        int total = (int)(attackScore_ / rate);
        int newly = total - generatedOjamaTotal;
        generatedOjamaTotal = total;
        if (newly > 0) pendingFire += newly;
        t_ += ERASE_MS;
        phase_ = ERASED;
        return;
    }
    case ERASED: {
        for (const auto& g : pendingGroups_) for (const auto& c : g) field.v[c.r][c.c] = 0;
        for (const auto& c : pendingOjamaCells_) field.v[c.r][c.c] = 0;
        DropInfo di = applyGravity(field);
        rng_.next();   // draw.js _prepareChainTextDOM が連鎖1段ごとに乱数を1回消費する（ツモがずれる）
        if (tet) {
            resolveTetAttack(tetCalcAdd_, tetCalcN_);   // pendingFire を捨て、点で相殺してラインを決める
            if (queueSum() > 0 && pendingFire == 0) pendingFire = 1;
            if (pendingFire > 0 || tetPending_ > 0) { applyOffsetTet(pendingFire, tetPending_, t_); pendingFire = 0; tetPending_ = 0; }
        } else {
        if (queueSum() > 0 && pendingFire == 0) pendingFire = 1;   // 受けがあれば最低1個相殺
        if (pendingFire > 0) { applyOffset(pendingFire, opp, t_); pendingFire = 0; }
        }
        t_ += ERASE_WAIT_MS;
        if (di.moved) t_ += di.maxDist * DROP_MS_PER_ROW + di.vibCycles * VIB_CYCLE_MS + FIX_WAIT_MS;
        phase_ = CHECK;
        return;
    }
    case DEAD:
        return;
    }
}

// ── 対局 ──
MatchResult runMatch(const PolicyParams& a, const PolicyParams& b, uint32_t seed, const GameSettings& gs,
                     PlayerTrace* ta, PlayerTrace* tb) {
    Player pa(a, gs, seed), pb(b, gs, seed);   // VERSUS は両者同じシード（versus.js sharedSeed）
    pa.trace = ta;
    pb.trace = tb;
    Player* P[2] = {&pa, &pb};
    MatchResult res;
    res.winner = -1;
    double now = 0;
    while (true) {
        int i = (P[0]->nextT() <= P[1]->nextT()) ? 0 : 1;
        Player* p = P[i];
        Player* o = P[1 - i];
        now = p->nextT();
        if (now > gs.maxGameMs) { res.winner = -1; break; }
        p->step(o);
        if (p->dead()) {
            // 同時刻に相手も死ぬか（同フレーム内）を確認
            while (!o->dead() && o->nextT() <= now) o->step(p);
            res.winner = o->dead() ? -1 : (1 - i);
            break;
        }
    }
    res.durationMs = now;
    if (ta) ta->finalBoard = boardString(pa.field);
    if (tb) tb->finalBoard = boardString(pb.field);
    res.a = pa.stats;
    res.b = pb.stats;
    return res;
}

// ── 異種戦（ぷよ 対 テト CPU lv5）──
//   テトは「設置の時刻」をイベントにする（plan で操作と時刻を決め、その時刻に commit）。
//   同時刻はどちらを先にするかを puyoFirst で選ぶ（学習・検証は両方で打ち消す）。
VsTetResult runMatchVsTet(const PolicyParams& puyo, uint32_t seed, const GameSettings& gs, bool puyoFirst,
                          PlayerTrace* tp) {
    Player pl(puyo, gs, seed);
    tsim::TetPlayer tp2(seed * 2654435761u + 12345u);
    tp2.marginTimeMs = gs.marginTimeMs;
    pl.trace = tp;
    pl.tet = &tp2;
    tp2.onSend = [&](double t, int oj) { pl.receiveFromTet(oj, t); };
    tp2.start(0);
    VsTetResult res{};
    res.winner = -1;
    double now = 0;
    while (true) {
        if (!tp2.dead && !tp2.planned()) tp2.plan();
        if (tp2.dead) { res.winner = 0; now = tp2.now; break; }   // HOLD で出したミノが出せない
        double tt = (tp2.dead || !tp2.planned()) ? 1e18 : tp2.plannedT();
        double pt = pl.nextT();
        bool puyoTurn = puyoFirst ? (pt <= tt) : (pt < tt);
        now = puyoTurn ? pt : tt;
        if (now > gs.maxGameMs) { res.winner = -1; break; }
        if (puyoTurn) {
            pl.step(nullptr);
            if (pl.dead()) {
                if (!tp2.dead && tp2.planned() && tp2.plannedT() <= now) tp2.commit();
                res.winner = tp2.dead ? -1 : 1;
                break;
            }
        } else {
            tp2.commit();
            if (tp2.dead) {
                while (!pl.dead() && pl.nextT() <= now) pl.step(nullptr);
                res.winner = pl.dead() ? -1 : 0;
                break;
            }
        }
        if (tp2.dead) { res.winner = pl.dead() ? -1 : 0; break; }
    }
    res.durationMs = now;
    if (tp) tp->finalBoard = boardString(pl.field);
    res.puyo = pl.stats;
    const tsim::TetStats& s = tp2.st;
    res.tetPieces = s.pieces; res.tetLines = s.lines; res.tetTspins = s.tspins; res.tetTetrises = s.tetrises;
    res.tetB2bs = s.b2bs; res.tetOjamaSent = s.ojamaSent; res.tetGaugeSent = s.gaugeSent;
    res.tetLinesReceived = s.linesReceived; res.tetGarbageTaken = s.garbageLinesTaken;
    res.tetFinalHeight = tp2.stackHeight();
    return res;
}

SoloResult runSolo(const PolicyParams& p, uint32_t seed, int maxTurns, int targetChain, const GameSettings& gs,
                   PlayerTrace* tr, int harassTurn, int harassAmount) {
    Player pl(p, gs, seed);
    pl.targetChain = targetChain;
    pl.trace = tr;
    SoloResult r;
    bool harassed = false;
    // maxTurns 手目の連鎖まで解決し、次の手を置いた時点（turns > maxTurns）で打ち切る
    while (!pl.dead()) {
        // 分析用：harassTurn 手目を置いた時点で harassAmount 個のおじゃまを予告に入れる（確定済み）。
        //   その手の連鎖終了時（500ms の非表示が明けていれば）に着弾する。カウンター判断は無い（相手なし）。
        if (!harassed && harassAmount > 0 && pl.stats.turns >= harassTurn) {
            pl.confirmGarbage({pl.receiveGarbage(harassAmount, pl.nextT() - INTERNAL_MS)});
            harassed = true;
        }
        pl.step(nullptr);
        if (pl.stats.turns > maxTurns) break;
    }
    if (tr) tr->finalBoard = boardString(pl.field);
    r.st = pl.stats;
    if (r.st.turns > maxTurns) r.st.turns = maxTurns;
    r.died = pl.dead();
    r.durationMs = pl.nextT();
    return r;
}

} // namespace sim

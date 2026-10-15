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

#include "core/bitboard.h"
#include "core/weights.h"
#include "build/build.h"

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

int Player::receiveGarbage(int amount, double now) {
    Garbage g;
    g.id = nextGarbageId_++;
    g.amount = amount;
    g.ready = false;
    g.internalUntil = now + INTERNAL_MS;
    garbageQueue.push_back(g);
    return g.id;
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
    if (remaining > 0 && opp) {
        sentThisTurn_.push_back(opp->receiveGarbage(remaining, now));
        stats.ojamaSent += remaining;
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
    // dropping（おじゃまは振動なし）→ fixAnim(0) → fixWait5f → checkErase
    t_ += di.maxDist * DROP_MS_PER_ROW + di.vibCycles * VIB_CYCLE_MS + FIX_WAIT_MS;
    phase_ = CHECK;
    return true;
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
    }

    bool wantCounter = opp && (counterActive_ ? incoming > 0 : incoming > pp_.counterTrigger);
    counterActive_ = wantCounter;

    int wa[W_LEN];
    if (wantCounter) {
        std::memcpy(wa, pp_.fast, sizeof(wa));
        wa[32] = 0;   // fireChainCount: 段数では撃たない
        wa[34] = (int)std::ceil((incoming + 1) * (double)rate * pp_.counterMargin);
        stats.counterTurns++;
    } else {
        std::memcpy(wa, pp_.build, sizeof(wa));
    }
    wa[20] = 9;   // knownNextCount（C++ 側は未参照）

    // nextPairs: 現ペア＝nextQueue[0]（前倒し計算）＋ NEXT 9 本
    int nextPairs[20];
    for (int i = 0; i < 10; i++) {
        nextPairs[i * 2]     = next_[i].first;
        nextPairs[i * 2 + 1] = next_[i].second;
    }

    BitBoard bb;
    toBitBoard(field, bb);
    EvalWeights w = weightsFromArray(wa);
    int out[40];
    for (int i = 0; i < 40; i++) out[i] = -1;
    searchBuildMode(bb, nextPairs, w, out);

    if (out[0] < 0) { decCol_ = 2; decRot_ = 0; }   // _handleWorkerResult の候補なしフォールバック
    else            { decCol_ = out[0]; decRot_ = out[1]; }
    decided_ = true;
}

void Player::chainEnd(Player* opp) {
    const int rate = rateAt(t_);
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
    }
    if (chainCount > 0 && field.empty()) pendingFire += ZENKESHI_BONUS / rate;

    if (!hasDroppedOjamaThisTurn_ && queueSum() > 0) {
        if (generateOjama()) return;
    }

    if (opp) opp->confirmGarbage(sentThisTurn_);
    sentThisTurn_.clear();

    if (field.v[HIDDEN][2] != 0) { phase_ = DEAD; return; }   // 致命判定（_isCellEmpty(2, 0)）

    phase_ = SPAWN_ANIM_END;
    decide(opp);                 // spawnAnim 開始時の前倒し計算
    t_ += SPAWN_ANIM_MS;
}

void Player::step(Player* opp) {
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
        chainCount++;
        int add = chainStepScore(pendingGroups_, field, chainCount);
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
        if (queueSum() > 0 && pendingFire == 0) pendingFire = 1;   // 受けがあれば最低1個相殺
        if (pendingFire > 0) { applyOffset(pendingFire, opp, t_); pendingFire = 0; }
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
MatchResult runMatch(const PolicyParams& a, const PolicyParams& b, uint32_t seed, const GameSettings& gs) {
    Player pa(a, gs, seed), pb(b, gs, seed);   // VERSUS は両者同じシード（versus.js sharedSeed）
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
    res.a = pa.stats;
    res.b = pb.stats;
    return res;
}

SoloResult runSolo(const PolicyParams& p, uint32_t seed, int maxTurns, int targetChain, const GameSettings& gs) {
    Player pl(p, gs, seed);
    pl.targetChain = targetChain;
    SoloResult r;
    // maxTurns 手目の連鎖まで解決し、次の手を置いた時点（turns > maxTurns）で打ち切る
    while (!pl.dead()) {
        pl.step(nullptr);
        if (pl.stats.turns > maxTurns) break;
    }
    r.st = pl.stats;
    if (r.st.turns > maxTurns) r.st.turns = maxTurns;
    r.died = pl.dead();
    r.durationMs = pl.nextT();
    return r;
}

} // namespace sim

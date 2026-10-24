// ─────────────────────────────────────────────
// sim/api.cpp — Python(ctypes) から呼ぶ C ABI ＋ スレッドプール
//   1ジョブ=1局。ジョブは std::atomic のカウンタで各スレッドに配る。
//   探索側の作業バッファは thread_local 化済み（native/core,eval）なのでスレッド並列で安全。
// ─────────────────────────────────────────────
#include "sim.h"
#include "tet.h"

#include <algorithm>
#include <atomic>
#include <climits>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using namespace sim;

namespace {

template <class F>
void parallelFor(int n, int nThreads, F fn) {
    if (nThreads <= 0) nThreads = (int)std::max(1u, std::thread::hardware_concurrency());
    nThreads = std::min(nThreads, std::max(1, n));
    std::atomic<int> next(0);
    auto worker = [&]() {
        while (true) {
            int i = next.fetch_add(1);
            if (i >= n) break;
            fn(i);
        }
    };
    if (nThreads == 1) { worker(); return; }
    std::vector<std::thread> ts;
    for (int t = 0; t < nThreads; t++) ts.emplace_back(worker);
    for (auto& t : ts) t.join();
}

int clampInt(long long v) { return (int)std::min<long long>(v, INT_MAX); }

GameSettings makeSettings(int ojamaRate, int colorCount, int marginTimeMs, double maxGameMs) {
    GameSettings gs;
    gs.ojamaRate = ojamaRate;
    gs.colorCount = colorCount;
    gs.marginTimeMs = marginTimeMs;
    gs.maxGameMs = maxGameMs;
    return gs;
}

// ── 記録の JSON 化（分析用 sim_trace_matches）──
void jIgn(std::string& o, const Ignite& g) {
    o += "[" + std::to_string(g.chains) + "," + std::to_string(g.score) + "," + std::to_string(g.need) + "]";
}
template <class T>
void jArr(std::string& o, const std::vector<T>& v) {
    o += "[";
    for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += std::to_string(v[i]); }
    o += "]";
}
std::string jNum(double v) { char b[32]; std::snprintf(b, sizeof b, "%.1f", v); return b; }

void jTrace(std::string& o, const PlayerTrace& tr, const PlayerStats& st) {
    o += "{\"turnsPlayed\":" + std::to_string(st.turns) + ",\"sentTotal\":" + std::to_string(st.ojamaSent) +
         ",\"recvTotal\":" + std::to_string(st.ojamaReceived) + ",\"finalBoard\":\"" + tr.finalBoard + "\"" +
         ",\"waitTurns\":" + std::to_string(st.waitTurns) + ",\"p1Holds\":" + std::to_string(st.p1Holds) +
         ",\"p1Kills\":" + std::to_string(st.p1Kills);
    // turns: [t, turn, mode, incoming, queue, fire, reason, fireableChains, fireableScore, potChains, potScore,
    //         ign, puyos, ojama, h, oppEnd, [colored, leftover, excess], [mainChains, mainPuyos, subScore, subAllowed]]
    o += ",\"turns\":[";
    for (size_t i = 0; i < tr.turns.size(); i++) {
        const auto& x = tr.turns[i];
        if (i) o += ",";
        o += "[" + jNum(x.t) + "," + std::to_string(x.turn) + "," + std::to_string(x.mode) + "," +
             std::to_string(x.incoming) + "," + std::to_string(x.queue) + "," + std::to_string(x.fire) + "," +
             std::to_string(x.reason) + "," + std::to_string(x.fireableChains) + "," +
             std::to_string(x.fireableScore) + "," + std::to_string(x.potChains) + "," +
             std::to_string(x.potScore) + ",";
        jIgn(o, x.ign);
        o += "," + std::to_string(x.puyos) + "," + std::to_string(x.ojama) + ",";
        jArr(o, std::vector<int>(x.h, x.h + COLS));
        o += "," + jNum(x.oppEnd) + ",";
        jArr(o, std::vector<int>{x.waste.colored, x.waste.leftover, x.waste.excess});
        o += ",";
        jArr(o, std::vector<int>{x.mainChains, x.mainPuyos, x.subScore, x.subAllowed});
        o += "]";
    }
    o += "],\"fires\":[";
    for (size_t i = 0; i < tr.fires.size(); i++) {
        const auto& f = tr.fires[i];
        if (i) o += ",";
        o += "{\"t0\":" + jNum(f.tStart) + ",\"t1\":" + jNum(f.tEnd) + ",\"turn\":" + std::to_string(f.turn) +
             ",\"mode\":" + std::to_string(f.mode) + ",\"reason\":" + std::to_string(f.reason) +
             ",\"chains\":" + std::to_string(f.chains) + ",\"score\":" + std::to_string(f.score) +
             ",\"offset\":" + std::to_string(f.offset) + ",\"sent\":" + std::to_string(f.sent) +
             ",\"queue\":" + std::to_string(f.queueBefore) +
             ",\"pb\":" + std::to_string(f.puyosBefore) + ",\"ob\":" + std::to_string(f.ojamaBefore) +
             ",\"pa\":" + std::to_string(f.puyosAfter) + ",\"oa\":" + std::to_string(f.ojamaAfter) +
             ",\"steps\":[";
        for (size_t k = 0; k < f.steps.size(); k++) { if (k) o += ","; jArr(o, f.steps[k]); }
        o += "],\"colors\":";
        jArr(o, f.stepColors);
        o += ",\"ojErased\":";
        jArr(o, f.stepOjamaErased);
        o += ",\"board\":\"" + f.board + "\"}";
    }
    o += "],\"drops\":[";
    for (size_t i = 0; i < tr.drops.size(); i++) {
        const auto& d = tr.drops[i];
        if (i) o += ",";
        o += "[" + jNum(d.t) + "," + std::to_string(d.turn) + "," + std::to_string(d.amount) + ",";
        jIgn(o, d.before);
        o += ",";
        jIgn(o, d.after);
        o += "]";
    }
    o += "]}";
}

} // namespace

extern "C" {

int sim_abi_version() { return 2; }
int sim_pp_len() { return PP_LEN; }

// 対局バッチ。pa/pb は各ジョブの PolicyParams（packed, PP_LEN 個ずつ）。
//   outInt[j*12 + k]: 0=勝者(0=A,1=B,-1=引分) 1=turnsA 2=turnsB 3=maxChainA 4=maxChainB
//                     5=maxScoreA 6=maxScoreB 7=sentA 8=sentB 9=recvA 10=recvB 11=counterTurnsA
//   outDur[j]: ゲーム内経過 ms
void sim_run_matches(int nJobs, const int* pa, const int* pb, const uint32_t* seeds,
                     int ojamaRate, int colorCount, int marginTimeMs, double maxGameMs,
                     int nThreads, int* outInt, double* outDur) {
    GameSettings gs = makeSettings(ojamaRate, colorCount, marginTimeMs, maxGameMs);
    parallelFor(nJobs, nThreads, [&](int j) {
        PolicyParams A = PolicyParams::fromPacked(pa + (size_t)j * PP_LEN);
        PolicyParams B = PolicyParams::fromPacked(pb + (size_t)j * PP_LEN);
        MatchResult r = runMatch(A, B, seeds[j], gs);
        int* o = outInt + (size_t)j * 12;
        o[0] = r.winner;
        o[1] = r.a.turns;          o[2] = r.b.turns;
        o[3] = r.a.maxChain;       o[4] = r.b.maxChain;
        o[5] = clampInt(r.a.maxChainScore); o[6] = clampInt(r.b.maxChainScore);
        o[7] = clampInt(r.a.ojamaSent);     o[8] = clampInt(r.b.ojamaSent);
        o[9] = clampInt(r.a.ojamaReceived); o[10] = clampInt(r.b.ojamaReceived);
        o[11] = r.a.counterTurns;
        outDur[j] = r.durationMs;
    });
}

// 異種戦バッチ（ぷよ 対 テト CPU lv5）。pp は各ジョブのぷよの PolicyParams（build=vsTet・fast=fastVsTet）。
//   puyoFirst[j]=1 なら同時刻はぷよを先に処理する。out[j*30 + k]:
//    0 勝者(0=ぷよ,1=テト,-1=引分) 1 時間ms 2 ぷよ手数 3 ぷよ最大連鎖 4 ぷよ最大連鎖点 5 ぷよ→テトのライン
//    6 ぷよが受けた（降った）おじゃま 7 ぷよのカウンター手数 8 ただの相殺の回数 9 段の点で相殺した個数
//   10 テト手数 11 テトライン 12 テト TSD 等 13 テトリス 14 B2B 15 テト→ぷよのおじゃま 16 ゲージ
//   17 テトに届いたライン 18 テトにせり上がったライン 19 テトの最終の高さ
//   20 ぷよのちぎり回数（発火を除く） 21 ちぎりの量（段数+1）の合計
//   22 §17 D 危険と判定した手数 23 危険で撃った手数（反撃・相殺・軽減）
//   24 §18 G 安全な火力を確かめた手数 25 撃たないと埋まるので撃った手数
//   26 §18 H1 構えを確かめた手数 27 構えのために手を変えた手数 28 育成の手のままで満たした手数 29 危険で [106]% で探した手数
void sim_run_vstet(int nJobs, const int* pp, const uint32_t* seeds, const int* puyoFirst,
                   int ojamaRate, int colorCount, int marginTimeMs, double maxGameMs,
                   int nThreads, double* out) {
    GameSettings gs = makeSettings(ojamaRate, colorCount, marginTimeMs, maxGameMs);
    tsim::initTetShapes();
    parallelFor(nJobs, nThreads, [&](int j) {
        PolicyParams P = PolicyParams::fromPacked(pp + (size_t)j * PP_LEN);
        VsTetResult r = runMatchVsTet(P, seeds[j], gs, puyoFirst[j] != 0);
        double* o = out + (size_t)j * 30;
        for (int k = 0; k < 30; k++) o[k] = 0;
        o[0] = r.winner; o[1] = r.durationMs; o[2] = r.puyo.turns; o[3] = r.puyo.maxChain;
        o[4] = (double)r.puyo.maxChainScore; o[5] = (double)r.puyo.tetLinesSent; o[6] = (double)r.puyo.ojamaReceived;
        o[7] = r.puyo.counterTurns; o[8] = (double)r.puyo.freeOffsets; o[9] = (double)r.puyo.offsetByScore;
        o[10] = r.tetPieces; o[11] = r.tetLines; o[12] = r.tetTspins; o[13] = r.tetTetrises; o[14] = r.tetB2bs;
        o[15] = (double)r.tetOjamaSent; o[16] = (double)r.tetGaugeSent; o[17] = (double)r.tetLinesReceived;
        o[18] = r.tetGarbageTaken; o[19] = r.tetFinalHeight;
        o[20] = r.puyo.tears; o[21] = (double)r.puyo.tearUnits;
        o[22] = r.puyo.dangerTurns; o[23] = r.puyo.dangerFires;
        o[24] = r.puyo.safeChecks; o[25] = r.puyo.safeFires;
        o[26] = r.puyo.standbyChecks; o[27] = r.puyo.standbyChanges;
        o[28] = r.puyo.standbyOk; o[29] = r.puyo.standbyDanger;
    });
}

// テスト用：_resolveTetAttack の1段（tests/test_tet_attack.py が本番 JS と照合する）。
//   in: rate, chainCount, carry, zen, add, n, nq, 続いて (amount, ready)×nq
//   out: [lines, carry, zen, キュー残り合計, ready の残り, 未 ready の残り]
void sim_tet_resolve_case(const double* in, double* out) {
    static const PolicyParams pp{};
    GameSettings gs = makeSettings((int)in[0], 4, -1, 1e9);
    Player p(pp, gs, 1);
    std::vector<Garbage> q;
    int nq = (int)in[6];
    for (int i = 0; i < nq; i++) {
        Garbage g{};
        g.id = i + 1;
        g.amount = (int)in[7 + i * 2];
        g.ready = in[8 + i * 2] != 0;
        g.internalUntil = 0;
        q.push_back(g);
    }
    double carry;
    bool zen;
    out[0] = p.testResolveTet((int)in[1], in[2], in[3] != 0, (int)in[4], (int)in[5], q, &carry, &zen);
    out[1] = carry;
    out[2] = zen ? 1 : 0;
    int sum = 0, r = 0, u = 0;
    for (const auto& g : p.garbageQueue) { sum += g.amount; (g.ready ? r : u) += g.amount; }
    out[3] = sum; out[4] = r; out[5] = u;
}

// 記録付き対局バッチ（分析用・遅い）。1局1行の JSON（JSONL）を outPath に書く。戻り値=書いた局数。
//   各行: {"job","seed","winner"(0=A,1=B,-1=引分),"dur","A":{trace},"B":{trace}}
int sim_trace_matches(int nJobs, const int* pa, const int* pb, const uint32_t* seeds,
                      int ojamaRate, int colorCount, int marginTimeMs, double maxGameMs,
                      int nThreads, const char* outPath) {
    GameSettings gs = makeSettings(ojamaRate, colorCount, marginTimeMs, maxGameMs);
    std::vector<std::string> lines(nJobs);
    parallelFor(nJobs, nThreads, [&](int j) {
        PolicyParams A = PolicyParams::fromPacked(pa + (size_t)j * PP_LEN);
        PolicyParams B = PolicyParams::fromPacked(pb + (size_t)j * PP_LEN);
        PlayerTrace ta, tb;
        MatchResult r = runMatch(A, B, seeds[j], gs, &ta, &tb);
        std::string& o = lines[j];
        o = "{\"job\":" + std::to_string(j) + ",\"seed\":" + std::to_string(seeds[j]) +
            ",\"winner\":" + std::to_string(r.winner) + ",\"dur\":" + jNum(r.durationMs) + ",\"A\":";
        jTrace(o, ta, r.a);
        o += ",\"B\":";
        jTrace(o, tb, r.b);
        o += "}\n";
    });
    FILE* fp = std::fopen(outPath, "w");
    if (!fp) return -1;
    for (const auto& l : lines) std::fwrite(l.data(), 1, l.size(), fp);
    std::fclose(fp);
    return nJobs;
}

// 記録付き異種戦（分析用・遅い）。ぷよ側の記録を1局1行の JSONL に書く（設計 lv6-vstet-design §10.1）。
//   各行: {"job","seed","first","winner"(0=ぷよ,1=テト,-1=引分),"dur","P":{trace}}
int sim_trace_vstet(int nJobs, const int* pp, const uint32_t* seeds, const int* puyoFirst,
                    int ojamaRate, int colorCount, int marginTimeMs, double maxGameMs,
                    int nThreads, const char* outPath) {
    GameSettings gs = makeSettings(ojamaRate, colorCount, marginTimeMs, maxGameMs);
    tsim::initTetShapes();
    std::vector<std::string> lines(nJobs);
    parallelFor(nJobs, nThreads, [&](int j) {
        PolicyParams P = PolicyParams::fromPacked(pp + (size_t)j * PP_LEN);
        PlayerTrace tr;
        VsTetResult r = runMatchVsTet(P, seeds[j], gs, puyoFirst[j] != 0, &tr);
        std::string& o = lines[j];
        o = "{\"job\":" + std::to_string(j) + ",\"seed\":" + std::to_string(seeds[j]) +
            ",\"first\":" + std::to_string(puyoFirst[j]) +
            ",\"winner\":" + std::to_string(r.winner) + ",\"dur\":" + jNum(r.durationMs) +
            ",\"tetLinesSent\":" + std::to_string(r.puyo.tetLinesSent) +
            ",\"tetGarbageTaken\":" + std::to_string(r.tetGarbageTaken) +
            ",\"tetFinalHeight\":" + std::to_string(r.tetFinalHeight) + ",\"P\":";
        jTrace(o, tr, r.puyo);
        o += "}\n";
    });
    FILE* fp = std::fopen(outPath, "w");
    if (!fp) return -1;
    for (const auto& l : lines) std::fwrite(l.data(), 1, l.size(), fp);
    std::fclose(fp);
    return nJobs;
}

// 記録付きひとり用（分析用）。harassTurn 手目に harassAmount 個のおじゃまを降らせる（0=降らせない）。
//   各行: {"job","seed","died","dur","P":{trace}}
int sim_trace_solo(int nJobs, const int* p, const uint32_t* seeds, int maxTurns, int harassTurn,
                   int harassAmount, int colorCount, int nThreads, const char* outPath) {
    GameSettings gs = makeSettings(70, colorCount, -1, 1e18);
    std::vector<std::string> lines(nJobs);
    parallelFor(nJobs, nThreads, [&](int j) {
        PolicyParams P = PolicyParams::fromPacked(p + (size_t)j * PP_LEN);
        PlayerTrace tr;
        SoloResult r = runSolo(P, seeds[j], maxTurns, 0, gs, &tr, harassTurn, harassAmount);
        std::string& o = lines[j];
        o = "{\"job\":" + std::to_string(j) + ",\"seed\":" + std::to_string(seeds[j]) +
            ",\"died\":" + std::to_string(r.died ? 1 : 0) + ",\"dur\":" + jNum(r.durationMs) + ",\"P\":";
        jTrace(o, tr, r.st);
        o += "}\n";
    });
    FILE* fp = std::fopen(outPath, "w");
    if (!fp) return -1;
    for (const auto& l : lines) std::fwrite(l.data(), 1, l.size(), fp);
    std::fclose(fp);
    return nJobs;
}

// ひとり用バッチ（おじゃま無し）。p は各ジョブの PolicyParams。
//   outInt[j*6 + k]: 0=turns 1=maxChain 2=maxChainScore 3=firstBigChainTurn(-1=未達) 4=died 5=0
void sim_run_solo(int nJobs, const int* p, const uint32_t* seeds, int maxTurns, int targetChain,
                  int colorCount, int nThreads, int* outInt) {
    GameSettings gs = makeSettings(70, colorCount, -1, 1e18);
    parallelFor(nJobs, nThreads, [&](int j) {
        PolicyParams P = PolicyParams::fromPacked(p + (size_t)j * PP_LEN);
        SoloResult r = runSolo(P, seeds[j], maxTurns, targetChain, gs);
        int* o = outInt + (size_t)j * 6;
        o[0] = r.st.turns;
        o[1] = r.st.maxChain;
        o[2] = clampInt(r.st.maxChainScore);
        o[3] = r.st.firstBigChainTurn;
        o[4] = r.died ? 1 : 0;
        o[5] = 0;
    });
}

// ── JS 一致テスト用 ──
void sim_rng_values(uint32_t seed, int n, double* out) {
    JsRng r(seed);
    for (int i = 0; i < n; i++) out[i] = r.next();
}

// 初期化（色シャッフル→NEXT生成）後、n 個取り出したツモ列（pivot, child の順で 2n 個）
void sim_pair_sequence(uint32_t seed, int colorCount, int n, int* out) {
    static int zero[PP_LEN] = {};
    PolicyParams pp = PolicyParams::fromPacked(zero);
    GameSettings gs;
    gs.colorCount = colorCount;
    Player pl(pp, gs, seed);
    auto seq = pl.debugPairSequence(n);
    for (int i = 0; i < n; i++) { out[i * 2] = seq[i].first; out[i * 2 + 1] = seq[i].second; }
}

// 盤面（17×6, r*COLS+c）の連鎖を最後まで回す。out[0]=スコア合計 out[1]=段数
void sim_chain(const uint8_t* board, long long* out) {
    Field f;
    std::memcpy(f.v, board, sizeof(f.v));
    int chains = 0;
    out[0] = simulateRemainingChain(f, 0, &chains);
    out[1] = chains;
}

// 盤面（17×6, r*COLS+c・次の消去判定を待つ状態）から連鎖が終わるまでの ms
void sim_chain_time(const uint8_t* board, double* out) {
    Field f;
    std::memcpy(f.v, board, sizeof(f.v));
    out[0] = chainRemainingMs(f);
}

} // extern "C"

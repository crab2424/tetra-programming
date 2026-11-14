// ─────────────────────────────────────────────
// lv7_wasm.cpp — テト CPU lv7（新しい探索）の入口
//   探索・評価・手生成・経路は clys（https://github.com/citrus610/clys, MIT, (c) 2024 citrus610）をもとにした
//   engine/ 以下。確定 NEXT だけで深さ depth まで読み、締め切り thinkMs で打ち切る。
//   設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md
//   lv7Search2 は ctx（相手の状態・予告の時刻表・マージン段）を足した入口（lv7-threat-design.md §4）
//
// 座標: TETLABO は y=-5（隠し最上段）〜19（床）、盤面バッファは (y+5)*10+x の 250 バイト。
//       engine は y=0 が床の列ビットボード。engine の y = 19 − TETLABO の y。
// ミノ番号: TETLABO I0 O1 T2 J3 L4 S5 Z6 ／ engine I0 J1 L2 O3 S4 T5 Z6
// ─────────────────────────────────────────────

#include "ai/beam.h"
#include "ai/path.h"
#include "ai/threat.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define LV7_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define LV7_EXPORT
#endif

namespace
{

constexpr i32 TET_TO_ENGINE[7] = { 0, 3, 5, 1, 2, 4, 6 };
constexpr i32 ENGINE_TO_TET[7] = { 0, 3, 4, 1, 5, 2, 6 };

piece::Type to_engine(i32 t)
{
    if (t < 0 || t > 6) return piece::Type::NONE;
    return piece::Type(TET_TO_ENGINE[t]);
}

i32 to_tet(piece::Type t)
{
    if (t == piece::Type::NONE) return -1;
    return ENGINE_TO_TET[static_cast<u8>(t)];
}

// 経路：path::find（出現位置からの最短操作。T-spin の置き場所は最後が回転の経路）を TETLABO の操作番号に直す。
//   1=左 2=右 3=SD（1段） 4=CW 5=CCW 6=HD。DOWN（底まで落とす）は落ちた段数ぶんの SD。届かなければ 0 を返す
i32 build_path(Board board, move::Placement placement, i32* out, i32 cap)
{
    auto inputs = path::find(board, placement, false);

    path::Node node;
    node.position = move::Placement(4, 19, piece::Rotation::UP, placement.type);
    if (node.position.is_colliding(board)) node.position.y = 20;

    i32 len = 0;
    bool reached = false;

    for (auto input : inputs) {
        i32 code = 0;
        i32 repeat = 1;

        switch (input)
        {
        case path::Input::LEFT: node.move_left(board); code = 1; break;
        case path::Input::RIGHT: node.move_right(board); code = 2; break;
        case path::Input::CW: node.move_cw(board); code = 4; break;
        case path::Input::CCW: node.move_ccw(board); code = 5; break;
        case path::Input::DOWN: {
            i32 y = node.position.y;
            node.move_down(board);
            code = 3;
            repeat = y - node.position.y;
            break;
        }
        case path::Input::DROP: code = 6; reached = true; break;
        default: break;
        }

        for (i32 k = 0; k < repeat && code != 0 && len < cap; ++k) {
            out[len++] = code;
        }

        if (reached) break;
    }

    node.move_down(board);
    node.position.normalize();
    if (!reached || len >= cap || !(node.position == placement)) {
        return 0;
    }
    return len;
}

// 盤面（(y+5)*10+x の 250 個、0=空）・HOLD・b2b・ren・bag（queue を引いた後）から探索の root を作る
template <class Cell>
State make_root(const Cell* board, const i32* queueIn, i32 nQueue, i32 hold, i32 bagAfter, i32 b2b, i32 ren,
                std::vector<piece::Type>& queue)
{
    State state = State();

    // ZONE: 先頭の値が 100 以上なら発動中（100 + ZONE 段の数。cpu/tet/cpu_zone.js stampBoard）。
    //   ZONE 段は盤面の底にそろった段として入っているので、数は State::lock が盤面から数える
    state.zone = board[0] >= 100;

    for (i32 yi = 0; yi < 25; ++yi) {
        for (i32 x = 0; x < 10; ++x) {
            if (state.zone && yi == 0 && x == 0) continue;
            if (board[yi * 10 + x]) {
                state.board[x] |= 1ULL << (24 - yi);
            }
        }
    }

    state.hold = to_engine(hold);
    state.b2b = u8(std::clamp(b2b, 0, 2));
    state.ren = u8(std::clamp(ren, 0, 255));
    state.next = 0;

    // bag：キューの後の残り → 逆順に戻して current の前の bag にする（clys tbp と同じ）
    Bag bag;
    bag.data = 0;
    for (i32 t = 0; t < 7; ++t) {
        if (bagAfter & (1 << t)) bag.data |= 1 << TET_TO_ENGINE[t];
    }
    if (bag.data == 0) bag.data = 0b1111111;
    for (i32 i = nQueue - 1; i >= 0; --i) {
        bag.deupdate(to_engine(queueIn[i]));
    }
    state.bag = bag;

    queue.clear();
    for (i32 i = 0; i < nQueue; ++i) {
        queue.push_back(to_engine(queueIn[i]));
    }

    return state;
}

// ctx（i32 配列、lv7-threat-design.md §4.4）
//   [0] 版（1） [1] 相手あり（0/1） [2] 相手のいまのミノ [3] 相手の HOLD [4] 相手の NEXT 本数 n [5..11] 相手の NEXT（最大 7）
//   [12] 相手の b2b [13] 相手の ren [14] 相手の予告の合計 [15] 相手のマージン段（-1＝未突入） [16] 自分のマージン段
//   [17] 相手の bag（見える NEXT を引いた後。TETLABO 番号のビット、0＝次から新しい bag） [18] 自分の予告の件数 g
//   [19..] 件ごとに 4 つ：量・ready（0/1）・ready までの ms・穴の列（-1＝不明。今は使わない）
//   その後ろに相手の盤面 250 個（0/1）
constexpr i32 CTX_VERSION = 1;
constexpr i32 CTX_GARBAGE = 19;
constexpr i32 CTX_GARBAGE_MAX = 16;

struct Ctx
{
    bool valid = false;
    bool has_opp = false;
    i32 opp_queue[8] = { 0 };   // いまのミノ＋見える NEXT
    i32 opp_n = 0;
    i32 opp_hold = -1, opp_b2b = 0, opp_ren = 0, opp_incoming = 0, opp_margin = -1, opp_bag = 0;
    i32 my_margin = -1;
    const i32* opp_board = nullptr;
    i32 g = 0;                  // 自分の予告の件数
    i32 g_amount[CTX_GARBAGE_MAX] = { 0 }, g_ready[CTX_GARBAGE_MAX] = { 0 }, g_ms[CTX_GARBAGE_MAX] = { 0 };
};

Ctx parse_ctx(const i32* ctx, i32 len)
{
    Ctx c;
    if (!ctx || len < CTX_GARBAGE || ctx[0] != CTX_VERSION) return c;

    const i32 g = std::clamp(ctx[18], 0, CTX_GARBAGE_MAX);
    const i32 board_at = CTX_GARBAGE + 4 * g;
    if (len < board_at) return c;

    c.valid = true;
    c.my_margin = std::clamp(ctx[16], -1, 5);
    c.g = g;
    for (i32 i = 0; i < g; ++i) {
        c.g_amount[i] = std::max(ctx[CTX_GARBAGE + 4 * i], 0);
        c.g_ready[i] = ctx[CTX_GARBAGE + 4 * i + 1];
        c.g_ms[i] = std::max(ctx[CTX_GARBAGE + 4 * i + 2], 0);
    }

    if (ctx[1] != 1 || len < board_at + 250 || ctx[2] < 0 || ctx[2] > 6) return c;

    c.has_opp = true;
    c.opp_queue[0] = ctx[2];
    c.opp_n = 1;
    const i32 n = std::clamp(ctx[4], 0, 7);
    for (i32 i = 0; i < n; ++i) {
        if (ctx[5 + i] < 0 || ctx[5 + i] > 6) break;
        c.opp_queue[c.opp_n++] = ctx[5 + i];
    }
    c.opp_hold = ctx[3];
    c.opp_b2b = ctx[12];
    c.opp_ren = ctx[13];
    c.opp_incoming = std::max(ctx[14], 0);
    c.opp_margin = std::clamp(ctx[15], -1, 5);
    c.opp_bag = ctx[17];
    c.opp_board = ctx + board_at;
    return c;
}

// out[96..] に相手の見積もりを書く（outLen ≥ 160 のとき）
//   [96] ビット 1=相手あり 2=方法 A 4=方法 B 8=並べ替えを回した  [97] 方法 A の読めた手数
//   [98..105] a[1..8]（最善の筋の火力の累計） [106..113] m[1..8]（撃てる火力の累計の最大）
//   [114] 見積もりにかかった時間（0.1ms 単位） [115] 方法 A のノード数
//   [116] 見える分の REN の手数 [117] その火力 [118] 並べ替えの通り数 [119] REN の手数の平均×10 [120] 最大
//   [121] 火力の平均×10 [122] 最大 [123] 方法 B の生成数  [124] T3 で探索に入れた予告の件数 [125] その合計
//   [126] T4 ビット 1=press を効かせた 2=危ないときの重みに差し替えた
//   [128..147] r[1..20]（REN 探索の手ごとの火力の累計）
constexpr i32 OUT_THREAT = 96;
constexpr i32 OUT_THREAT_LEN = 160;

struct Threat
{
    bool beam = false, ren = false;
    threat::Beam b;
    threat::Ren r;
    u64 seed = 0;
};

Threat estimate_threat(const Ctx& c, const eval::Weight& w, double start, double end, i32* out)
{
    Threat t;
    out[OUT_THREAT] = 1;

    std::vector<piece::Type> queue;
    State opp = make_root(c.opp_board, c.opp_queue, c.opp_n, c.opp_hold, c.opp_bag, c.opp_b2b, c.opp_ren, queue);
    opp.margin = i8(c.opp_margin);

    if (w.threat_width > 0) {
        const double deadline = std::min(end, start + (w.threat_ms > 0 ? w.threat_ms : 5));
        auto b = threat::estimate(opp, queue, w, size_t(w.threat_width), deadline);
        t.beam = true;
        t.b = b;
        out[OUT_THREAT] |= 2;
        out[97] = b.depth;
        for (i32 j = 0; j < threat::K; ++j) {
            out[98 + j] = b.a[j];
            out[106 + j] = b.m[j];
        }
        out[115] = i32(std::min<u64>(b.nodes, INT32_MAX));
    }

    if (w.ren_width > 0) {
        const double deadline = std::min(end, beam::now_ms() + (w.ren_ms > 0 ? w.ren_ms : 15));
        // 並べ替えの乱数は相手の局面から決める（同じ局面なら native でも wasm でも同じ結果）
        u64 seed = opp.get_hash();
        for (auto t : queue) seed = seed * 31 + u64(t) + 1;
        Bag after = opp.bag;
        for (auto t : queue) after.update(t);
        auto r = threat::ren(opp, queue, after, size_t(w.ren_width), w.ren_samples > 0 ? w.ren_samples : 16,
                             w.ren_ext > 0 ? w.ren_ext : 12, seed, deadline);
        t.ren = true;
        t.r = r;
        out[OUT_THREAT] |= 4 | (r.mc_runs > 0 ? 8 : 0);
        out[116] = r.vis_len;
        out[117] = r.vis_atk;
        out[118] = r.mc_runs;
        out[119] = r.mc_len_mean10;
        out[120] = r.mc_len_max;
        out[121] = r.mc_atk_mean10;
        out[122] = r.mc_atk_max;
        out[123] = i32(std::min<u64>(r.gen, INT32_MAX));
        for (i32 j = 0; j < threat::R; ++j) out[128 + j] = r.r[j];
    }

    out[114] = i32((beam::now_ms() - start) * 10);
    t.seed = opp.get_hash();
    return t;
}

// T3：探索の中で相殺・着弾させる予告（§5.3）。手の番号は「自分の何手目の設置の後か」（1＝いまのミノ）
//   届いている分：ready なら 1 手目の後、未 ready なら ready までの ms を自分の1手の ms で割った手の後
//   相手がこれから撃つ分：相手の j 手目の火力の増え（相手に届いている予告ぶんは相手が先に相殺に使う）を、
//     j × 相手の1手 ms で届き、＋1500ms で ready として入れる
garbage::Plan make_plan(const Ctx& c, const eval::Weight& w, const Threat& t, u64 seed)
{
    garbage::Plan plan;
    const i32 my_ms = w.my_ms > 0 ? w.my_ms : 330;
    const i32 opp_ms = w.opp_ms > 0 ? w.opp_ms : 330;
    const auto moves = [&] (i32 ms) { return std::max(1, (ms + my_ms - 1) / my_ms); };

    if (w.garbage_in_search && c.valid) {
        for (i32 i = 0; i < c.g; ++i) {
            plan.root.push(c.g_amount[i], 0, c.g_ready[i] ? 1 : moves(c.g_ms[i]));
        }
    }

    if (w.threat_in_search > 0 && c.has_opp && (t.beam || t.ren)) {
        const i32 gate = w.threat_ren_gate > 0 ? w.threat_ren_gate : 7;
        const bool ren_sign = t.ren && (t.r.mc_runs > 0 ? t.r.mc_len_mean10 >= gate * 10 : t.r.vis_len >= gate);
        const i32 pct = w.threat_pct > 0 ? w.threat_pct : 100;
        i32 prev = 0;
        for (i32 j = 1; j <= threat::R; ++j) {
            i32 cum = 0;
            if (ren_sign) cum = t.r.r[j - 1];
            if (w.threat_in_search >= 2 && t.beam) cum = std::max(cum, t.b.a[std::min(j, threat::K) - 1]);
            const i32 net = std::max(cum * pct / 100 - c.opp_incoming, 0);
            if (net > prev) {
                plan.root.push(net - prev, moves(j * opp_ms), moves(j * opp_ms + 1500));
                prev = net;
            }
        }
    }

    plan.active = plan.root.n > 0;
    plan.seed = seed;
    return plan;
}

// 危ないときだけ T3 を効かせる（plan_danger_h）：いまの最大の高さ＋予告の合計
bool plan_is_danger(const garbage::Plan& plan, State& state, const eval::Weight& w)
{
    if (w.plan_danger_h <= 0) return true;
    i32 heights[10];
    state.board.get_heights(heights);
    i32 total = 0;
    for (i32 i = 0; i < plan.root.n; ++i) total += plan.root.amount[i];
    return *std::max_element(heights, heights + 10) + total >= w.plan_danger_h;
}

// T4：相手が危ないか（press_h）：相手の最大の高さ＋相手の予告
bool opp_danger(const Ctx& c, const eval::Weight& w)
{
    if (w.press_h <= 0) return true;
    i32 h = 0;
    for (i32 i = 0; i < 250 && h == 0; ++i) {
        if (c.opp_board[i]) h = 20 - (i / 10 - 5);
    }
    return h + c.opp_incoming >= w.press_h;
}

// T4：d 手目の火力が相手で ready になる（d × 自分の1手 ms ＋ 1500ms）までに相手が撃てる火力。
//   方法 A の m[j]（j＝その時刻までの相手の手数）。読めた手数より先は最後の値から手数に比例して伸ばす。
//   相手に届いている予告（私が送った分）は相手が先に相殺に使うので引く
beam::Press make_press(const Ctx& c, const eval::Weight& w, const Threat& t)
{
    beam::Press p;
    p.active = true;
    p.reward = w.press;
    const i32 my_ms = w.my_ms > 0 ? w.my_ms : 330;
    const i32 opp_ms = w.opp_ms > 0 ? w.opp_ms : 330;
    const i32 depth = std::clamp(t.b.depth, 1, threat::K);
    for (i32 d = 0; d <= 64; ++d) {
        const i32 j = (d * my_ms + 1500) / opp_ms;
        i32 m = 0;
        if (j >= 1) m = j <= depth ? t.b.m[j - 1] : t.b.m[depth - 1] * j / depth;
        p.cap[d] = std::max(m - c.opp_incoming, 0);
    }
    return p;
}

// D0（lv7-dodge-design.md §3）：相殺外しの決まりが成り立つかの記録だけ。手の選び方は変えない。
//   outLen ≥ OUT_D0_LEN のとき（シミュだけ。本番の worker は 160）、選んだ手が「消去して予告を相殺する手」で
//   この手で上がる予告があれば、消去しない手のうち visit 最大の手（alt）を置いてその分を上げた盤面を調べて out[160..] に書く。
//   火力は ctx の自分のマージン段の表（本当のゲームの火力）で数える
//   [160] ビット 1=調べた（ready あり・選んだ手が消去・火力 > 0） 2=alt あり
//   [161] 選んだ手の火力 A [162] その消去数 [163] この手で上がる予告の合計 R（ready か、ready まで自分の1手の ms 以内） [164] 選んだ手の visit [165] alt の visit
//   [166] alt の生存判定の値（中央列の高さ＋incoming、上げる前） [167] alt の後 R を上げた最大の高さ [168] その中央列の高さ
//   [169] R を上げた盤面で次のミノか HOLD で出せる火力の最大 [170] 上げない盤面での同じ値
//   [171] 選んだ手の後の最大の高さ＋相殺しきれず上がる分（max(R − A, 0)） [172] 初手の候補数 [173] そのうち消去しない手の数
//   [174] 選んだ手の種類 ビット 1=T-spin 2=4-LINES 4=mini [175] D0 にかかった時間（0.01ms 単位）
constexpr i32 OUT_D0 = 160;
constexpr i32 OUT_D0_LEN = 176;

i32 max_attack_next(const State& s, const std::vector<piece::Type>& queue)
{
    piece::Type types[2] = { piece::Type::NONE, piece::Type::NONE };
    if (s.next < queue.size()) types[0] = queue[s.next];
    if (s.hold != piece::Type::NONE) types[1] = s.hold;
    else if (size_t(s.next) + 1 < queue.size()) types[1] = queue[s.next + 1];

    i32 best = 0;
    for (i32 k = 0; k < 2; ++k) {
        if (types[k] == piece::Type::NONE || (k == 1 && types[1] == types[0])) continue;
        auto moves = move::generate(s.board, types[k]);
        for (auto& m : moves) {
            State c = s;
            auto lock = c.lock(m);
            best = std::max<i32>(best, lock.attack);
        }
    }
    return best;
}

void record_d0(const State& root, const std::vector<piece::Type>& queue, const beam::Result& result, size_t best,
               i32 incoming, const Ctx& ctx, const eval::Weight& w, i32* out)
{
    const double t0 = beam::now_ms();
    // この手の設置で上がる分：ready か、ready まで自分の1手の ms 以内（make_plan で 1 手目の後に上がる分と同じ）
    const i32 my_ms = w.my_ms > 0 ? w.my_ms : 330;
    i32 ready = 0;
    for (i32 i = 0; i < ctx.g; ++i) {
        if (ctx.g_ready[i] || ctx.g_ms[i] <= my_ms) ready += ctx.g_amount[i];
    }

    State base = root;
    base.margin = i8(ctx.my_margin);

    State sb = base;
    auto pb = result.candidates[best].placement;
    auto lb = sb.advance(pb, queue);
    if (ready <= 0 || lb.clear == 0 || lb.attack == 0) return;

    out[OUT_D0] = 1;
    out[OUT_D0 + 1] = lb.attack;
    out[OUT_D0 + 2] = lb.clear;
    out[OUT_D0 + 3] = ready;
    out[OUT_D0 + 4] = i32(std::min<size_t>(result.candidates[best].visit, INT32_MAX));
    {
        i32 h[10];
        sb.board.get_heights(h);
        out[OUT_D0 + 11] = *std::max_element(h, h + 10) + std::max(ready - i32(lb.attack), 0);
    }
    out[OUT_D0 + 12] = i32(result.candidates.size());
    out[OUT_D0 + 14] = (lb.tspin ? 1 : 0) | (lb.clear == 4 ? 2 : 0) | (lb.mini ? 4 : 0);

    // 消去しない手のうち visit 最大（同じなら候補の並びで先の手）
    i32 alt = -1, n_noclear = 0;
    State sa;
    for (size_t i = 0; i < result.candidates.size(); ++i) {
        State s = base;
        auto p = result.candidates[i].placement;
        auto l = s.advance(p, queue);
        if (l.clear > 0) continue;
        ++n_noclear;
        if (alt < 0 || result.candidates[i].visit > result.candidates[size_t(alt)].visit) {
            alt = i32(i);
            sa = s;
        }
    }
    out[OUT_D0 + 13] = n_noclear;

    if (alt >= 0) {
        out[OUT_D0] |= 2;
        out[OUT_D0 + 5] = i32(std::min<size_t>(result.candidates[size_t(alt)].visit, INT32_MAX));
        i32 h[10];
        sa.board.get_heights(h);
        out[OUT_D0 + 6] = *std::max_element(h + 3, h + 7) + incoming;
        out[OUT_D0 + 10] = max_attack_next(sa, queue);

        // R を上げる（1回の着弾。穴は garbage::after_lock と同じ決め方）
        garbage::Queue q;
        q.push(ready, 0, 1);
        garbage::after_lock(sa.board, q, 0, 1, root.board.cols[0] * 31 + root.board.cols[9] + u64(ready));
        sa.board.get_heights(h);
        out[OUT_D0 + 7] = *std::max_element(h, h + 10);
        out[OUT_D0 + 8] = *std::max_element(h + 3, h + 7);
        out[OUT_D0 + 9] = max_attack_next(sa, queue);
    }
    out[OUT_D0 + 15] = i32((beam::now_ms() - t0) * 100);
}

void search(
    const u8* board, const i32* queueIn, i32 nQueue, i32 hold, i32 bagAfter,
    i32 b2b, i32 ren, i32 incoming, const i32* weights, i32 nWeights,
    i32 width, i32 depth, i32 thinkMs, const Ctx& ctx, i32* out, i32 outLen)
{
    const double start = beam::now_ms();

    for (i32 i = 0; i < outLen; ++i) out[i] = 0;

    std::vector<piece::Type> queue;
    State state = make_root(board, queueIn, nQueue, hold, bagAfter, b2b, ren, queue);

    const eval::Weight w = eval::from_array(weights, nWeights);

    if (ctx.valid && w.margin_own) state.margin = i8(ctx.my_margin);

    // 相手の見積もり（締め切りの内側で先に。残りの時間で自分の探索）。T0 では出力するだけで、手の選び方には使わない
    Threat threat;
    if (ctx.has_opp && (w.threat_width > 0 || w.ren_width > 0) && outLen >= OUT_THREAT_LEN) {
        threat = estimate_threat(ctx, w, start, start + thinkMs, out);
    }

    // 経路は out[18..] に。lv7Search2 で見積もりの欄（[96..]）があるときはその手前まで
    const i32 path_end = (ctx.valid && outLen >= OUT_THREAT_LEN) ? OUT_THREAT : outLen;

    beam::Configs configs;
    configs.width = size_t(std::max(width, 1));
    configs.depth = size_t(std::clamp(depth, 1, 64));
    configs.incoming = std::max(incoming, 0);
    if (ctx.valid && (w.garbage_in_search || w.threat_in_search > 0)) {
        configs.plan = make_plan(ctx, w, threat, state.get_hash() ^ threat.seed);
        if (!plan_is_danger(configs.plan, state, w)) configs.plan.active = false;
        if (outLen >= OUT_THREAT_LEN) {
            // [124] 探索に入れた予告の件数 [125] その合計
            i32 total = 0;
            for (i32 i = 0; i < configs.plan.root.n; ++i) total += configs.plan.root.amount[i];
            out[124] = configs.plan.active ? configs.plan.root.n : 0;
            out[125] = total;
        }
    }

    // T4（§13）：危ないとき（T3 が効いている）の重みの差し替えと、相手に着弾する見込みへの報酬
    eval::Weight ws = w;
    i32 t4_flags = 0;
    if (configs.plan.active && (w.danger_ren_pct > 0 || w.danger_clear != 0)) {
        if (w.danger_ren_pct > 0) {
            for (auto& r : ws.ren) r = r * w.danger_ren_pct / 100;
            ws.bonus_ren = ws.bonus_ren * w.danger_ren_pct / 100;
        }
        for (i32 i = 0; i < 3; ++i) ws.clear[i] += w.danger_clear;
        t4_flags |= 2;
    }
    if (w.press != 0 && ctx.has_opp && threat.beam && opp_danger(ctx, w)) {
        configs.press = make_press(ctx, w, threat);
        t4_flags |= 1;
    }
    if (outLen >= OUT_THREAT_LEN) out[126] = t4_flags;

    auto result = beam::search(state, queue, ws, configs, start + thinkMs);

    if (result.candidates.empty()) {
        out[14] = i32(beam::now_ms() - start);
        return;
    }

    // 選び方：visit の多い順（select_best なら最後の層のキーの大きい順）
    std::vector<size_t> order(result.candidates.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&] (size_t a, size_t b) {
        const auto& ca = result.candidates[a];
        const auto& cb = result.candidates[b];
        if (w.select_best && !result.decided) return ca.best > cb.best;
        return ca.visit > cb.visit;
    });

    // 生存判定：中央列の高さ＋incoming−火力−消去数 ≤ 20 を満たす最初の手（clys Engine::request）
    size_t best = order[0];
    for (size_t k = 0; k < order.size(); ++k) {
        auto simulate = state;
        auto placement = result.candidates[order[k]].placement;
        auto lock = simulate.advance(placement, queue);

        i32 heights[10];
        simulate.board.get_heights(heights);

        i32 height_center_max = *std::max_element(heights + 3, heights + 7);

        if (height_center_max + incoming - lock.attack - lock.clear <= 20) {
            best = order[k];
            break;
        }
    }

    auto placement = result.candidates[best].placement;

    out[0] = 1;
    out[1] = to_tet(placement.type);
    for (i32 i = 0; i < 4; ++i) {
        out[2 + i * 2] = placement.x + piece::get_offset_x(placement.type, placement.r, i);
        out[3 + i * 2] = 19 - (placement.y + piece::get_offset_y(placement.type, placement.r, i));
    }
    out[10] = placement.type != queue[0];
    out[11] = i32(std::min<size_t>(result.candidates[best].visit, INT32_MAX));
    out[12] = i32(std::min<u64>(result.nodes, INT32_MAX));
    out[13] = i32(result.depth);
    out[15] = result.candidates[best].best == INT32_MIN ? 0 : result.candidates[best].best;
    {
        auto b = state.board;
        out[16] = placement.get_tspin_type(b);
    }

    out[17] = path_end > 18 ? build_path(state.board, placement, out + 18, path_end - 18) : 0;
    out[14] = i32(beam::now_ms() - start);

    if (ctx.valid && outLen >= OUT_D0_LEN) record_d0(state, queue, result, best, incoming, ctx, w, out);
}

}

extern "C" {

LV7_EXPORT void* lv7_malloc(int size) { return malloc(size); }
LV7_EXPORT void lv7_free(void* p) { free(p); }

// board     : 250 バイト（(y+5)*10+x、0=空）
// queue     : current＋確定 NEXT（TETLABO のミノ番号）。探索は先頭から depth＋1 本まで
// nQueue    : queue の本数
// hold      : HOLD のミノ（-1 = 空）
// bagAfter  : queue を引いた後の bag の残り（TETLABO 番号のビット。0 = 次から新しい bag）
// weights   : 重み（eval::WEIGHT_LEN 個。足りない分は既定値）
// width / depth / thinkMs : ビーム幅・深さの上限・締め切り（ms）
// out (i32) : [0] 1=手あり [1] 置くミノ [2..9] 4マスの (x,y)（TETLABO 座標） [10] HOLD するか [11] visit
//             [12] 展開したノード数 [13] 読んだ深さ [14] 経過 ms [15] 初手のキー（評価値）[16] T-spin（0/1/2=mini）
//             [17] path 長 [18..] path（1〜6）
LV7_EXPORT void lv7Search(
    const u8* board, const i32* queueIn, i32 nQueue, i32 hold, i32 bagAfter,
    i32 b2b, i32 ren, i32 incoming, const i32* weights, i32 nWeights,
    i32 width, i32 depth, i32 thinkMs, i32* out, i32 outLen)
{
    search(board, queueIn, nQueue, hold, bagAfter, b2b, ren, incoming, weights, nWeights, width, depth, thinkMs,
           Ctx(), out, outLen);
}

// lv7Search ＋ ctx（相手の状態・予告の時刻表・マージン段。並びは parse_ctx の上の表）。設計 lv7-threat-design.md §4.4
//   ctxLen = 0 なら lv7Search と同じ結果。out が 160 個以上なら [96..] に相手の見積もり（estimate_threat の上の表）、
//   経路は [18..95]
LV7_EXPORT void lv7Search2(
    const u8* board, const i32* queueIn, i32 nQueue, i32 hold, i32 bagAfter,
    i32 b2b, i32 ren, i32 incoming, const i32* weights, i32 nWeights,
    i32 width, i32 depth, i32 thinkMs, const i32* ctx, i32 ctxLen, i32* out, i32 outLen)
{
    search(board, queueIn, nQueue, hold, bagAfter, b2b, ren, incoming, weights, nWeights, width, depth, thinkMs,
           parse_ctx(ctx, ctxLen), out, outLen);
}

}

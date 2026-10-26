// ─────────────────────────────────────────────
// clys_wasm.cpp
// clys（https://github.com/citrus610/clys, MIT, (c) 2024 citrus610）を TETLABO の CPU として
// wasm から呼ぶ入口。原作 ai/ai.cpp の Engine（別スレッドの anytime 探索＋request の生存判定）を、
// 1手ごとに同期で thinkMs まで探索する形に置き換えたもの。
// 設計: source_assets/memory/cpu/tet/clys-port-design.md
//
// 座標: TETLABO は y=-5（隠し最上段）〜19（床）、盤面バッファは (y+5)*10+x の 250 バイト。
//       clys は y=0 が床の列ビットボード。clys の y = 19 − TETLABO の y。
// ミノ番号: TETLABO I0 O1 T2 J3 L4 S5 Z6 ／ clys I0 J1 L2 O3 S4 T5 Z6
// ─────────────────────────────────────────────

#include "ai/beam.h"
#include "ai/path.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define CLYS_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define CLYS_EXPORT
#endif

namespace
{

constexpr i32 TET_TO_CLYS[7] = { 0, 3, 5, 1, 2, 4, 6 };
constexpr i32 CLYS_TO_TET[7] = { 0, 3, 4, 1, 5, 2, 6 };

piece::Type to_clys(i32 t)
{
    if (t < 0 || t > 6) return piece::Type::NONE;
    return piece::Type(TET_TO_CLYS[t]);
}

i32 to_tet(piece::Type t)
{
    if (t == piece::Type::NONE) return -1;
    return CLYS_TO_TET[static_cast<u8>(t)];
}

// 原作 config.json の値
eval::Weight default_weight()
{
    eval::Weight w;
    w.height = -50;
    w.well = 50;
    w.height_map = { 10, 10, 0, -5, -10, -10, -5, 0, 10, 10 };
    w.well_map = { -100, -150, 0, 50, 100, 100, 50, 0, -150, -100 };
    w.bump = -25;
    w.transition = -20;
    w.hole_a = -400;
    w.hole_b = -200;
    w.cover = -20;
    w.tslot = { 100, 200, 250, 500 };
    w.bonus_b2b = 200;
    w.bonus_ren = 200;
    w.scale = 1024;
    w.pc = 2000;
    w.pc_next = 1000;
    w.tspin = { 50, 400, 750 };
    w.clear = { -400, -300, -200, 250 };
    w.b2b = 100;
    w.ren = { 180, 450, 1000, 1500, 2000 };
    w.feed = -100;
    w.order = 100;
    w.delay = -25;
    w.waste_T = -150;
    w.waste_I = -100;
    return w;
}

bool seeded = false;

}

extern "C" {

CLYS_EXPORT void* my_malloc(int size) { return malloc(size); }
CLYS_EXPORT void my_free(void* p) { free(p); }

// board     : 250 バイト（(y+5)*10+x、0=空）
// queueAll  : current＋内部 NEXT（TETLABO のミノ番号）。bag を戻すのに全部使う
// nAll      : queueAll の本数
// nSearch   : 探索に渡す本数（current を含む。原作はこれより先を bag に合うランダムなツモで補う）
// hold      : HOLD のミノ（-1 = 空）
// bagAfter  : queueAll を引いた後の bag の残り（TETLABO 番号のビット。0 = 次から新しい bag）
// out (i32) : [0] 1=手あり [1] 置くミノ [2..9] 4マスの (x,y) [10] HOLD するか [11] visit
//             [12] nodes [13] depth [14] 経過 ms [15] path 長 [16..] path（1=左 2=右 3=SD 4=CW 5=CCW 6=HD）
CLYS_EXPORT void clysSearch(
    const u8* board, const i32* queueAll, i32 nAll, i32 nSearch, i32 hold, i32 bagAfter,
    i32 b2b, i32 ren, i32 incoming, i32 thinkMs, i32 width, i32 branch, i32* out, i32 outLen)
{
    const double start = beam::now_ms();

    if (!seeded) {
        srand(u32(start * 1000.0));
        seeded = true;
    }

    for (i32 i = 0; i < outLen; ++i) out[i] = 0;

    State state = State();

    for (i32 yi = 0; yi < 25; ++yi) {
        for (i32 x = 0; x < 10; ++x) {
            if (board[yi * 10 + x]) {
                state.board[x] |= 1ULL << (24 - yi);
            }
        }
    }

    state.hold = to_clys(hold);
    state.b2b = u8(std::clamp(b2b, 0, 2));
    state.ren = u8(std::clamp(ren, 0, 255));
    state.next = 0;

    // bag：キューの後の残り → 逆順に戻して current の前の bag にする（原作 tbp と同じ）
    Bag bag;
    bag.data = 0;
    for (i32 t = 0; t < 7; ++t) {
        if (bagAfter & (1 << t)) bag.data |= 1 << TET_TO_CLYS[t];
    }
    if (bag.data == 0) bag.data = 0b1111111;
    for (i32 i = nAll - 1; i >= 0; --i) {
        bag.deupdate(to_clys(queueAll[i]));
    }
    state.bag = bag;

    std::vector<piece::Type> queue;
    for (i32 i = 0; i < std::min(nAll, nSearch); ++i) {
        queue.push_back(to_clys(queueAll[i]));
    }

    beam::Configs configs;
    configs.width = size_t(std::max(width, 1));
    configs.depth = 32;
    configs.branch = size_t(std::max(branch, 1));

    auto result = beam::search(state, Lock(), queue, default_weight(), configs, start + thinkMs);

    if (result.candidates.empty()) {
        out[14] = i32(beam::now_ms() - start);
        return;
    }

    // visit の多い順に、生存判定（中央列の高さ＋incoming−火力−消去数 ≤ 20）を満たす最初の手（原作 Engine::request）
    std::sort(
        result.candidates.begin(),
        result.candidates.end(),
        [&] (const beam::Candidate& a, const beam::Candidate& b) { return b < a; }
    );

    size_t best = 0;

    for (size_t i = 0; i < result.candidates.size(); ++i) {
        auto simulate = state;
        auto lock = simulate.advance(result.candidates[i].placement, queue);

        i32 heights[10];
        simulate.board.get_heights(heights);

        i32 height_center_max = *std::max_element(heights + 3, heights + 7);

        if (height_center_max + incoming - lock.attack - lock.clear <= 20) {
            best = i;
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
    out[11] = i32(result.candidates[best].visit);
    out[12] = i32(result.nodes);
    out[13] = i32(result.depth);

    // 経路：原作 path::find（出現位置からの最短操作）を再生し、TETLABO の操作番号に直す。
    // DOWN（底まで落とす）は落ちた段数ぶんの SD にする。届かない手なら path 長 0（JS 側で横移動＋HD）
    auto inputs = path::find(state.board, placement, false);

    path::Node node;
    node.position = move::Placement(4, 19, piece::Rotation::UP, placement.type);
    if (node.position.is_colliding(state.board)) node.position.y = 20;

    i32 len = 0;
    const i32 cap = outLen - 16;
    bool reached = false;

    for (auto input : inputs) {
        i32 code = 0;
        i32 repeat = 1;

        switch (input)
        {
        case path::Input::LEFT:
            node.move_left(state.board);
            code = 1;
            break;
        case path::Input::RIGHT:
            node.move_right(state.board);
            code = 2;
            break;
        case path::Input::CW:
            node.move_cw(state.board);
            code = 4;
            break;
        case path::Input::CCW:
            node.move_ccw(state.board);
            code = 5;
            break;
        case path::Input::DOWN: {
            i32 y = node.position.y;
            node.move_down(state.board);
            code = 3;
            repeat = y - node.position.y;
            break;
        }
        case path::Input::DROP:
            code = 6;
            reached = true;
            break;
        default:
            break;
        }

        for (i32 k = 0; k < repeat && code != 0 && len < cap; ++k) {
            out[16 + len] = code;
            len += 1;
        }

        if (reached) break;
    }

    // 再生した最終位置が選んだ手と一致しなければ path は使わない
    node.move_down(state.board);
    node.position.normalize();
    if (!reached || len >= cap || !(node.position == placement)) {
        len = 0;
    }

    out[15] = len;
    out[14] = i32(beam::now_ms() - start);
}

}

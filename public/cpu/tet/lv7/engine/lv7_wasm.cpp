// ─────────────────────────────────────────────
// lv7_wasm.cpp — テト CPU lv7（新しい探索）の入口
//   探索・評価・手生成・経路は clys（https://github.com/citrus610/clys, MIT, (c) 2024 citrus610）をもとにした
//   engine/ 以下。確定 NEXT だけで深さ depth まで読み、締め切り thinkMs で打ち切る。
//   設計: source_assets/memory/cpu/tet/lv6-phase1-search-design.md
//
// 座標: TETLABO は y=-5（隠し最上段）〜19（床）、盤面バッファは (y+5)*10+x の 250 バイト。
//       engine は y=0 が床の列ビットボード。engine の y = 19 − TETLABO の y。
// ミノ番号: TETLABO I0 O1 T2 J3 L4 S5 Z6 ／ engine I0 J1 L2 O3 S4 T5 Z6
// ─────────────────────────────────────────────

#include "ai/beam.h"
#include "ai/path.h"

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
    const double start = beam::now_ms();

    for (i32 i = 0; i < outLen; ++i) out[i] = 0;

    State state = State();

    for (i32 yi = 0; yi < 25; ++yi) {
        for (i32 x = 0; x < 10; ++x) {
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

    std::vector<piece::Type> queue;
    for (i32 i = 0; i < nQueue; ++i) {
        queue.push_back(to_engine(queueIn[i]));
    }

    const eval::Weight w = eval::from_array(weights, nWeights);

    beam::Configs configs;
    configs.width = size_t(std::max(width, 1));
    configs.depth = size_t(std::clamp(depth, 1, 64));
    configs.incoming = std::max(incoming, 0);

    auto result = beam::search(state, queue, w, configs, start + thinkMs);

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

    out[17] = outLen > 18 ? build_path(state.board, placement, out + 18, outLen - 18) : 0;
    out[14] = i32(beam::now_ms() - start);
}

}

#include "beam.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace beam
{

// ノードを展開する（いまのミノと HOLD のミノの全配置）。子の数を返す
u32 expand(
    const std::vector<piece::Type>& queue,
    node::Data& node,
    const std::function<void(node::Data&, move::Placement)>& callback
)
{
    u32 nodes = 0;

    piece::Type pieces[2] = { queue[node.state.next], node.state.hold };

    if (pieces[1] == piece::Type::NONE) {
        pieces[1] = queue[node.state.next + 1];
    }

    if (pieces[0] == pieces[1]) {
        pieces[1] = piece::Type::NONE;
    }

    for (i32 p = 0; p < 2; ++p) {
        if (pieces[p] == piece::Type::NONE) {
            break;
        }

        auto locks = move::generate(node.state.board, pieces[p]);

        for (auto& placement : locks) {
            auto child = node;
            child.lock = child.state.advance(placement, queue);
            callback(child, placement);
        }

        nodes += u32(locks.size());
    }

    return nodes;
};

Result search(
    State state,
    std::vector<piece::Type> queue,
    const eval::Weight& w,
    Configs configs,
    double deadline_ms
)
{
    auto result = Result();

    if (queue.size() < 2 || !beam::is_queue_valid(queue, state.bag)) {
        return result;
    }

    auto root = node::Data {
        .state = state,
        .score = { 0, 0 },
        .lock = Lock(),
        .index = -1
    };

    root.state.next = 0;

    std::array<Layer, 2> layers = {
        Layer(configs.width),
        Layer(configs.width)
    };

    // 初手の候補
    result.nodes += beam::expand(
        queue,
        root,
        [&] (node::Data& child, move::Placement placement) {
            auto candidate = beam::Candidate();
            candidate.placement = placement;
            child.index = i32(result.candidates.size());
            eval::evaluate(child, root, placement, queue, w);
            result.candidates.push_back(candidate);
            // 原作は push_back（重複除去なし）。幅が初手の数より小さいと原作は sort_heap を壊れた heap に
            // かけていたので、ここでは add（重複除去＋上位 width 個）にする
            layers[0].add(child);
        }
    );

    if (result.candidates.empty()) {
        return result;
    }

    result.depth = 1;

    // 読める深さ：キューの本数（HOLD が空なら1本多く使う）と configs.depth の小さい方
    const size_t max_layers = std::min(
        configs.depth,
        queue.size() - (root.state.hold == piece::Type::NONE)
    );

    auto mark_last = [&] (Layer& layer) {
        for (auto& node : layer.data) {
            auto& c = result.candidates[node.index];
            c.best = std::max(c.best, node.score.action + node.score.eval);
        }
    };

    // 締め切り：前の層にかかった時間ぶん次の層も掛かるとみて、締め切りを越えそうなら次の層に入らない
    double layer_ms = 0.0;
    double t_layer = beam::now_ms();

    while (result.depth < max_layers) {
        const double now = beam::now_ms();
        if (result.depth > 1) layer_ms = now - t_layer;
        t_layer = now;
        if (now + layer_ms >= deadline_ms) {
            break;
        }

        Layer& parents = layers[(result.depth - 1) & 1];
        Layer& children = layers[result.depth & 1];

        parents.sort();

        for (auto& node : parents.data) {
            result.nodes += beam::expand(queue, node, [&] (node::Data& child, move::Placement placement) {
                eval::evaluate(child, node, placement, queue, w);
                children.add(child);
            });
        }

        parents.clear();

        if (children.data.empty()) {
            break;
        }

        i32 index = -1;
        bool same = true;

        for (auto& node : children.data) {
            result.candidates[node.index].visit += 1;
            if (index == -1) index = node.index;
            else if (index != node.index) same = false;
        }

        result.depth += 1;

        if (same) {
            // 子が全部同じ初手から来た：その初手で決まり
            result.decided = true;
            for (auto& c : result.candidates) c.best = INT32_MIN;
            result.candidates[index].visit += configs.width * configs.depth;
            result.candidates[index].best = 0;
            return result;
        }
    }

    mark_last(layers[(result.depth - 1) & 1]);

    return result;
};

double now_ms()
{
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
#endif
};

// キューが 7-bag に合うか
bool is_queue_valid(const std::vector<piece::Type>& queue, Bag bag)
{
    for (auto p : queue) {
        if (!bag.get(p)) {
            return false;
        }

        bag.update(p);
    }

    return true;
};

};

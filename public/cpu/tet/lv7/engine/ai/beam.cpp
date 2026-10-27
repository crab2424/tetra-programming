#include "beam.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace beam
{

namespace
{

// 1つの層。nl_split>0 なら消去なし（n）と消去あり（l）の2つのビームに分け、そうでなければ n だけを使う
struct Beam
{
    Layer n;
    Layer l;
    bool split;

    Beam(size_t width, i32 nl_split)
        : n(nl_split > 0 ? std::max<size_t>(width - width * size_t(std::min(nl_split, 100)) / 100, 1) : width)
        , l(nl_split > 0 ? std::max<size_t>(width * size_t(std::min(nl_split, 100)) / 100, 1) : 1)
        , split(nl_split > 0) {}

    void add(node::Data& node)
    {
        if (this->split && node.lock.clear > 0) this->l.add(node);
        else this->n.add(node);
    }

    void sort() { this->n.sort(); this->l.sort(); }
    void clear() { this->n.clear(); this->l.clear(); }
    bool empty() const { return this->n.data.empty() && this->l.data.empty(); }

    template <class F>
    void for_each(F&& f)
    {
        for (auto& node : this->n.data) f(node);
        for (auto& node : this->l.data) f(node);
    }
};

}

// ノードを展開する（いまのミノと HOLD のミノの全配置）。子の数を返す
u32 expand(
    const std::vector<piece::Type>& queue,
    node::Data& node,
    const std::function<void(node::Data&, move::Placement)>& callback
)
{
    u32 nodes = 0;

    // 読み筋モードの最後の層：キューを使い切った（空の HOLD から HOLD した）ノードは先が無い
    if (node.state.next >= queue.size()) {
        return 0;
    }

    piece::Type pieces[2] = { queue[node.state.next], node.state.hold };

    if (pieces[1] == piece::Type::NONE) {
        // HOLD が空で次の1本が無ければ HOLD はできない（読み筋モードの最後の層だけ。通常は max_layers で届かない）
        pieces[1] = node.state.next + 1 < queue.size() ? queue[node.state.next + 1] : piece::Type::NONE;
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
            child.sent += child.lock.attack;
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

    if (queue.size() < (configs.pv ? 1u : 2u) || !beam::is_queue_valid(queue, state.bag)) {
        return result;
    }

    auto root = node::Data {
        .state = state,
        .score = { 0, 0 },
        .lock = Lock(),
        .index = -1
    };

    root.state.next = 0;

    std::array<Beam, 2> layers = {
        Beam(configs.width, w.nl_split),
        Beam(configs.width, w.nl_split)
    };

    // 初手の候補
    result.nodes += beam::expand(
        queue,
        root,
        [&] (node::Data& child, move::Placement placement) {
            auto candidate = beam::Candidate();
            candidate.placement = placement;
            child.index = i32(result.candidates.size());
            child.placement = placement;
            eval::evaluate(child, root, placement, queue, w, configs.incoming);
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
    const size_t base_layers = std::min(
        configs.depth,
        queue.size() - (root.state.hold == piece::Type::NONE)
    );
    // 読み筋モードは HOLD が空でも最後の1本を置く層を足す（HOLD を使わなかった筋だけが伸びる。visit には数えない）
    const size_t max_layers = configs.pv ? std::min(configs.depth, queue.size()) : base_layers;

    // 読み筋モード：層を記録する（子の parent はこの記録での位置）
    auto record = [&] (Beam& layer) {
        std::vector<PvEntry> v;
        layer.for_each([&] (node::Data& node) {
            v.push_back({ node.parent, node.index, node.score.action + node.score.eval, node.placement });
        });
        result.hist.push_back(std::move(v));
    };

    auto mark_last = [&] (Beam& layer) {
        layer.for_each([&] (node::Data& node) {
            auto& c = result.candidates[node.index];
            c.best = std::max(c.best, node.score.action + node.score.eval);
        });
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

        Beam& parents = layers[(result.depth - 1) & 1];
        Beam& children = layers[result.depth & 1];

        parents.sort();
        if (configs.pv) record(parents);

        i32 pos = 0;
        parents.for_each([&] (node::Data& node) {
            const i32 parent = pos++;
            result.nodes += beam::expand(queue, node, [&] (node::Data& child, move::Placement placement) {
                child.parent = parent;
                child.placement = placement;
                eval::evaluate(child, node, placement, queue, w, configs.incoming);
                children.add(child);
            });
        });

        parents.clear();

        if (children.empty()) {
            break;
        }

        i32 index = -1;
        bool same = true;
        const bool bonus = result.depth >= base_layers;   // 読み筋モードで足した層

        if (!bonus) {
            children.for_each([&] (node::Data& node) {
                result.candidates[node.index].visit += 1;
                if (index == -1) index = node.index;
                else if (index != node.index) same = false;
            });
        }

        result.depth += 1;

        if (same && !configs.pv) {
            // 子が全部同じ初手から来た：その初手で決まり
            result.decided = true;
            for (auto& c : result.candidates) c.best = INT32_MIN;
            result.candidates[index].visit += configs.width * configs.depth;
            mark_last(children);   // EVAL 表示用（選ぶ手は visit で決まり）
            return result;
        }
    }

    mark_last(layers[(result.depth - 1) & 1]);
    if (configs.pv && result.hist.size() < result.depth) record(layers[(result.depth - 1) & 1]);

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

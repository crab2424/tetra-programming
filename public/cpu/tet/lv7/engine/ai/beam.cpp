#include "beam.h"
#include <bit>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace beam
{

bool g_no_hold = false;

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

// T4：着弾の見込みが増えた分だけ行動の報酬を足す
void apply_press(node::Data& child, const Configs& configs)
{
    if (!configs.press.active) return;
    const i32 d = std::min<i32>(child.depth, 64);
    const i32 total = std::max(std::max(child.sent - configs.incoming, 0) - configs.press.cap[d], 0);
    if (total > child.landed) {
        child.score.action += (total - child.landed) * configs.press.reward;
        child.landed = i16(std::min(total, 32767));
    }
}

}

// ノードを展開する（いまのミノと HOLD のミノの全配置）。子の数を返す
u32 expand(
    const std::vector<piece::Type>& queue,
    node::Data& node,
    const std::function<void(node::Data&, move::Placement)>& callback,
    const garbage::Plan* plan,
    const Configs* configs,
    bool is_root
)
{
    u32 nodes = 0;

    piece::Type pieces[2] = { queue[node.state.next], node.state.hold };

    if (g_no_hold) {
        pieces[1] = piece::Type::NONE; // HOLD なしの試合: いまのミノだけ
    }
    else if (pieces[1] == piece::Type::NONE) {
        pieces[1] = queue[node.state.next + 1];
    }

    if (pieces[0] == pieces[1]) {
        pieces[1] = piece::Type::NONE;
    }

    for (i32 p = 0; p < 2; ++p) {
        if (pieces[p] == piece::Type::NONE) {
            break;
        }

        std::vector<move::Placement> locks;
        if (configs && configs->spawn_rules) {
            if (is_root && !configs->root_planned) {
                // root のミノはもう出ている（先行回転で出ていればその位置から）。ホールドはふつうのホールド＝向き 0 だけ
                if (configs->root_ihs) {
                    // 先行ホールドで出ている: 出ているのはホールド側（pieces[1]）。引いたミノ（pieces[0]）はもうホールドの中
                    if (p == 1) locks = configs->root_start ? move::generate(node.state.board, pieces[1], &configs->start)
                                                            : move::generate(node.state.board, pieces[1]);
                }
                else if (p == 0) locks = configs->root_start ? move::generate(node.state.board, pieces[0], &configs->start)
                                                        : move::generate(node.state.board, pieces[0]);
                else if (configs->root_hold) locks = move::generate(node.state.board, pieces[1]);
            }
            else {
                // これから出すミノ: 向き 0 で出せなければ先行回転。ホールドのミノは先行ホールドで出せる（いまのミノを出さずに）
                locks = move::generate_spawn(node.state.board, pieces[p], true);
            }
        }
        else {
            locks = move::generate(node.state.board, pieces[p]);
        }

        for (auto& placement : locks) {
            auto child = node;
            child.lock = child.state.advance(placement, queue);
            child.sent += child.lock.attack;
            child.depth = u8(std::min(i32(node.depth) + 1, 255));
            if (plan && plan->active && child.gq.n > 0) {
                garbage::after_lock(child.state.board, child.gq, child.lock.attack, child.depth, plan->seed, child.lock.clear > 0);
            }
            callback(child, placement);
        }

        nodes += u32(locks.size());
    }

    return nodes;
};

i32 zone_rows(const Board& board)
{
    return std::countr_one(Board(board).get_clear_mask());
};

namespace
{
constexpr i32 ZONE_LETHAL = 19;     // ZONE の後に残る段＋予告がこれ以上なら終点にしない（cpu_zone.js lethalHeight）
constexpr i32 ZONE_END_COMP = 50;   // 終点のキーに足す、残りの深さ 1 あたり（同じ段数なら早く終えるほうを選ぶ）
}

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
    if (configs.plan.active) root.gq = configs.plan.root;
    const garbage::Plan* plan = configs.plan.active ? &configs.plan : nullptr;

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
            eval::evaluate(child, root, placement, queue, w, configs.incoming);
            apply_press(child, configs);
            result.candidates.push_back(candidate);
            // 原作は push_back（重複除去なし）。幅が初手の数より小さいと原作は sort_heap を壊れた heap に
            // かけていたので、ここでは add（重複除去＋上位 width 個）にする
            layers[0].add(child);
        },
        plan, &configs, true
    );

    if (result.candidates.empty()) {
        return result;
    }

    // §22: ZONE の終点を覚える（向き 0 で出せないノード。後が安全なときだけ）
    auto record_end = [&] (node::Data& node) {
        if (!configs.zone || node.index < 0) return;
        if (size_t(node.state.next) >= queue.size()) return;
        if (!move::spawn_blocked(node.state.board, queue[node.state.next])) return;
        i32 h[10];
        Board b = node.state.board;
        b.get_heights(h);
        const i32 zr = zone_rows(b);
        // ZONE が終わると、終了時の火力でまず予告を相殺する（game/tet/zone.js）
        const i32 rem = std::max(configs.incoming - node.sent - eval::zone_table_at(zr), 0);
        if (*std::max_element(h, h + 10) - zr + rem >= ZONE_LETHAL) return;
        auto& c = result.candidates[size_t(node.index)];
        const i32 key = node.score.action + node.score.eval + ZONE_END_COMP * std::max(i32(configs.depth) - i32(node.depth), 0);
        if (zr > c.end_lines || (zr == c.end_lines && key > c.end_key)) {
            c.end_lines = zr;
            c.end_key = key;
            c.end_depth = node.depth;
        }
    };

    result.depth = 1;

    // 読める深さ：キューの本数（HOLD が空なら1本多く使う）と configs.depth の小さい方
    size_t max_layers = std::min(
        configs.depth,
        queue.size() - (!g_no_hold && root.state.hold == piece::Type::NONE)
    );
    // §22: ZONE の時間切れの先は読まない
    if (configs.zone && configs.zone_moves_left > 0) max_layers = std::min(max_layers, size_t(configs.zone_moves_left));

    auto mark_last = [&] (Beam& layer) {
        layer.for_each([&] (node::Data& node) {
            auto& c = result.candidates[node.index];
            c.best = std::max(c.best, node.score.action + node.score.eval);
            if (configs.zone) {
                result.live_max = std::max(result.live_max, zone_rows(node.state.board));
                record_end(node);
            }
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

        parents.for_each([&] (node::Data& node) {
            record_end(node);
            const u32 made = beam::expand(queue, node, [&] (node::Data& child, move::Placement placement) {
                eval::evaluate(child, node, placement, queue, w, configs.incoming);
                apply_press(child, configs);
                children.add(child);
            }, plan, &configs, false);
            result.nodes += made;
            // §22: 続けられる枝（子を作れた）の段数も「生きた枝」に数える。最後の層が空でも live_max が残るように
            if (configs.zone && made > 0) result.live_max = std::max(result.live_max, zone_rows(node.state.board));
        });

        parents.clear();

        if (children.empty()) {
            break;
        }

        i32 index = -1;
        bool same = true;

        children.for_each([&] (node::Data& node) {
            result.candidates[node.index].visit += 1;
            if (index == -1) index = node.index;
            else if (index != node.index) same = false;
        });

        result.depth += 1;

        if (same && !configs.zone) {
            // 子が全部同じ初手から来た：その初手で決まり
            result.decided = true;
            for (auto& c : result.candidates) c.best = INT32_MIN;
            result.candidates[index].visit += configs.width * configs.depth;
            mark_last(children);   // EVAL 表示用（選ぶ手は visit で決まり）
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

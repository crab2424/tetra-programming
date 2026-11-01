#include "threat.h"

namespace threat
{

namespace
{

struct TNode
{
    node::Data d;
    i32 hist[K] = { 0 };
};

i32 key(const node::Data& d) { return d.score.action + d.score.eval; }

// 読める手数：HOLD が空なら1本多く使う（beam::search と同じ）
size_t max_layers(const State& s, const std::vector<piece::Type>& queue, size_t cap)
{
    const size_t n = queue.size() - (s.hold == piece::Type::NONE ? 1 : 0);
    return std::min(n, cap);
}

// 並べ替えの乱数（std の分布は実装で結果が変わるので使わない）
struct Rng
{
    u64 s;
    u64 next() { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return s; }
    u32 below(u32 n) { return u32(this->next() % n); }
};

}

Beam estimate(State root, const std::vector<piece::Type>& queue, const eval::Weight& w, size_t width, double deadline_ms)
{
    Beam result;
    if (queue.size() < 2) return result;

    root.next = 0;
    std::vector<TNode> layer(1);
    layer[0].d.state = root;

    const size_t layers = max_layers(root, queue, K);

    for (size_t depth = 1; depth <= layers; ++depth) {
        if (depth > 1 && beam::now_ms() >= deadline_ms) break;

        std::vector<TNode> children;
        std::unordered_map<u64, size_t> seen;
        i32 best_sent = 0;

        for (auto& parent : layer) {
            result.nodes += beam::expand(queue, parent.d, [&] (node::Data& child, move::Placement placement) {
                eval::evaluate(child, parent.d, placement, queue, w, 0);
                best_sent = std::max(best_sent, child.sent);

                const u64 hash = child.state.get_hash();
                auto found = seen.find(hash);
                if (found != seen.end()) {
                    if (key(children[found->second].d) >= key(child)) return;
                    children[found->second].d = child;
                    std::copy(parent.hist, parent.hist + K, children[found->second].hist);
                    children[found->second].hist[depth - 1] = child.sent;
                    return;
                }

                TNode t;
                t.d = child;
                std::copy(parent.hist, parent.hist + K, t.hist);
                t.hist[depth - 1] = child.sent;
                seen.insert({ hash, children.size() });
                children.push_back(t);
            });
        }

        if (children.empty()) break;

        if (children.size() > width) {
            // stable_sort：同じキーの並びも決まる（native と wasm で同じ結果にする）
            std::stable_sort(children.begin(), children.end(),
                [] (const TNode& a, const TNode& b) { return key(a.d) > key(b.d); });
            children.resize(width);
        }

        result.m[depth - 1] = std::max(best_sent, depth > 1 ? result.m[depth - 2] : 0);
        result.depth = i32(depth);
        layer.swap(children);
    }

    if (result.depth > 0) {
        const TNode* best = &layer[0];
        for (auto& t : layer) if (key(t.d) > key(best->d)) best = &t;
        for (i32 j = 0; j < result.depth; ++j) result.a[j] = best->hist[j];
    }

    // 読めなかった手は最後の値のまま（累計なので）
    for (i32 j = std::max(result.depth, 1); j < K; ++j) {
        result.a[j] = result.a[j - 1];
        result.m[j] = result.m[j - 1];
    }

    return result;
};

namespace
{

struct RNode
{
    State s;
    i32 atk = 0;
    i32 len = 0;
};

struct RenRun
{
    i32 len = 0;
    i32 atk = 0;
    i32 cum[R] = { 0 };       // j+1 手目までの火力の累計の最大
    bool complete = true;     // 締め切りで途中で止めていない
};

// 消去が続く置き方だけを幅 width でキューが尽きるまで
RenRun ren_beam(const State& root, const std::vector<piece::Type>& queue, size_t width, u64& gen, double deadline_ms)
{
    RenRun run;
    std::vector<RNode> layer(1);
    layer[0].s = root;
    layer[0].s.next = 0;

    for (i32 depth = 1; !layer.empty(); ++depth) {
        if (depth > 1 && beam::now_ms() >= deadline_ms) { run.complete = false; break; }

        std::vector<RNode> children;
        std::unordered_set<u64> seen;

        for (auto& n : layer) {
            if (size_t(n.s.next) + 1 >= queue.size()) continue;

            piece::Type pieces[2] = { queue[n.s.next], n.s.hold == piece::Type::NONE ? queue[n.s.next + 1] : n.s.hold };
            if (pieces[0] == pieces[1]) pieces[1] = piece::Type::NONE;

            for (auto p : pieces) {
                if (p == piece::Type::NONE) continue;
                auto placements = move::generate(n.s.board, p);
                gen += placements.size();

                for (auto placement : placements) {
                    RNode c = n;
                    auto lock = c.s.advance(placement, queue);
                    if (lock.clear == 0) continue;
                    if (!seen.insert(c.s.get_hash()).second) continue;
                    c.len += 1;
                    c.atk += lock.attack;
                    run.len = std::max(run.len, c.len);
                    run.atk = std::max(run.atk, c.atk);
                    if (depth <= R) run.cum[depth - 1] = std::max(run.cum[depth - 1], c.atk);
                    children.push_back(c);
                }
            }
        }

        if (children.size() > width) {
            std::stable_sort(children.begin(), children.end(),
                [] (const RNode& a, const RNode& b) { return a.atk > b.atk; });
            children.resize(width);
        }

        layer.swap(children);
    }

    for (i32 j = 1; j < R; ++j) run.cum[j] = std::max(run.cum[j], run.cum[j - 1]);
    return run;
}

}

Ren ren(State root, const std::vector<piece::Type>& queue, Bag bag_after, size_t width, i32 samples, i32 ext, u64 seed,
        double deadline_ms)
{
    Ren result;
    if (queue.size() < 2) return result;

    const RenRun vis = ren_beam(root, queue, width, result.gen, deadline_ms);
    result.vis_len = vis.len;
    result.vis_atk = vis.atk;
    std::copy(vis.cum, vis.cum + R, result.r);

    // 入口の判定：見える分で REN が 3 以上続くか、相手が REN 中（ren ≥ 2）のときだけ先のツモを補う
    if (samples <= 0 || ext <= 0 || (vis.len < 3 && root.ren < 2)) return result;

    Rng rng { seed | 1 };
    i64 sum_len = 0, sum_atk = 0;
    i64 sum_cum[R] = { 0 };

    for (i32 s = 0; s < samples; ++s) {
        if (beam::now_ms() >= deadline_ms) break;

        // 見える分の後を 7-bag どおりに ext 本
        auto q = queue;
        Bag bag = bag_after;
        while (i32(q.size()) < i32(queue.size()) + ext) {
            piece::Type rest[7];
            i32 n = 0;
            for (i32 t = 0; t < 7; ++t) if (bag.get(piece::Type(t))) rest[n++] = piece::Type(t);
            for (i32 i = n - 1; i > 0; --i) std::swap(rest[i], rest[rng.below(u32(i + 1))]);
            for (i32 i = 0; i < n && i32(q.size()) < i32(queue.size()) + ext; ++i) {
                q.push_back(rest[i]);
                bag.update(rest[i]);
            }
        }

        const RenRun run = ren_beam(root, q, width, result.gen, deadline_ms);
        if (!run.complete) break;

        result.mc_runs += 1;
        sum_len += run.len;
        sum_atk += run.atk;
        result.mc_len_max = std::max(result.mc_len_max, run.len);
        result.mc_atk_max = std::max(result.mc_atk_max, run.atk);
        for (i32 j = 0; j < R; ++j) sum_cum[j] += run.cum[j];
    }

    if (result.mc_runs > 0) {
        result.mc_len_mean10 = i32(sum_len * 10 / result.mc_runs);
        result.mc_atk_mean10 = i32(sum_atk * 10 / result.mc_runs);
        for (i32 j = 0; j < R; ++j) result.r[j] = i32((sum_cum[j] + result.mc_runs / 2) / result.mc_runs);
    }

    return result;
};

};

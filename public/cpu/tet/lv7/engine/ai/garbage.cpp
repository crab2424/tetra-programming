#include "garbage.h"

namespace garbage
{

namespace
{

u64 mix(u64 x)
{
    x += 0x9e3779b97f4a7c15ULL;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}

}

u64 Queue::hash() const
{
    if (this->n == 0) return 0;
    u64 h = 0x51ed27f1e2b1c3a5ULL;
    for (i32 i = 0; i < this->n; ++i) {
        h = mix(h ^ (u64(this->amount[i]) | u64(this->arrive[i]) << 8 | u64(this->ready[i]) << 16));
    }
    return h;
}

void Queue::push(i32 amount, i32 arrive, i32 ready)
{
    if (amount <= 0) return;
    arrive = std::clamp(arrive, 0, 255);
    ready = std::clamp(ready, 0, 255);
    if (this->n > 0 && (this->n == MAX || (this->arrive[this->n - 1] == arrive && this->ready[this->n - 1] == ready))) {
        auto& a = this->amount[this->n - 1];
        a = u8(std::min(i32(a) + amount, 255));
        return;
    }
    this->amount[this->n] = u8(std::min(amount, 255));
    this->arrive[this->n] = u8(arrive);
    this->ready[this->n] = u8(ready);
    this->n += 1;
}

i32 after_lock(Board& board, Queue& q, i32 attack, i32 depth, u64 seed)
{
    if (q.n == 0) return 0;

    // ① 届いている分を相殺：ready の古い順 → 未 ready の古い順
    for (i32 pass = 0; pass < 2 && attack > 0; ++pass) {
        for (i32 i = 0; i < q.n && attack > 0; ++i) {
            if (q.arrive[i] > depth || q.amount[i] == 0) continue;
            const bool is_ready = q.ready[i] <= depth;
            if (is_ready != (pass == 0)) continue;
            const i32 c = std::min<i32>(attack, q.amount[i]);
            q.amount[i] = u8(q.amount[i] - c);
            attack -= c;
        }
    }

    // ② 余りは、まだ届いていない分を早い順に減らす
    for (i32 i = 0; i < q.n && attack > 0; ++i) {
        if (q.arrive[i] <= depth || q.amount[i] == 0) continue;
        const i32 c = std::min<i32>(attack, q.amount[i]);
        q.amount[i] = u8(q.amount[i] - c);
        attack -= c;
    }

    // ③ ready の分を上げる（古い順。1回の着弾の中で1段目は乱数、2段目から 70% で前の段と同じ列）
    i32 lines = 0;
    i32 hole = -1;
    u64 r = mix(seed ^ (u64(depth) << 32));
    u16 rows[64];
    for (i32 i = 0; i < q.n; ++i) {
        if (q.arrive[i] > depth || q.ready[i] > depth || q.amount[i] == 0) continue;
        for (i32 k = 0; k < q.amount[i] && lines < 40; ++k) {
            r = mix(r);
            if (hole < 0) hole = i32(r % 10);
            else if ((r >> 20) % 100 >= 70) hole = (hole + 1 + i32((r >> 40) % 9)) % 10;
            rows[lines++] = u16(0x3FF & ~(1u << hole));
        }
        q.amount[i] = 0;
    }

    if (lines > 0) {
        // 列ごとに下から lines 段を差し込む（rows[0] が一番上に来る段＝先に上がった段が上）
        for (i32 x = 0; x < 10; ++x) {
            u64 fill = 0;
            for (i32 k = 0; k < lines; ++k) {
                if (rows[k] & (1u << x)) fill |= 1ULL << (lines - 1 - k);
            }
            board.cols[x] = (lines >= 64 ? 0 : board.cols[x] << lines) | fill;
        }
    }

    // 空になった件を詰める（ハッシュを揃えるため）
    i32 m = 0;
    for (i32 i = 0; i < q.n; ++i) {
        if (q.amount[i] == 0) continue;
        q.amount[m] = q.amount[i];
        q.arrive[m] = q.arrive[i];
        q.ready[m] = q.ready[i];
        ++m;
    }
    for (i32 i = m; i < q.n; ++i) q.amount[i] = q.arrive[i] = q.ready[i] = 0;
    q.n = u8(m);

    return lines;
}

};

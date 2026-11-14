#include "state.h"

// Advances the game state
Lock State::advance(move::Placement& placement, const std::vector<piece::Type>& queue)
{
    auto current = queue[this->next];

    if (placement.type != current) {
        auto pre_hold = this->hold;
        this->hold = current;

        if (pre_hold == piece::Type::NONE) {
            this->bag.update(current);
            this->next++;
            current = queue[this->next];
        }
    }

    this->bag.update(current);
    this->next++;

    return this->lock(placement);
};

// Places the piece into the board and return the action's data
Lock State::lock(move::Placement& placement)
{
    Lock lock = Lock();

    lock.softdrop = !placement.is_above_stack(this->board);
    // TETLABO lv7: T-spin の判定は rotation.js checkTSpin と同じ（直前が回転・前2隅＋後ろ1隅で T-spin、
    //   後ろ2隅＋前1隅は mini、ただし Point 5 の回転なら T-spin）。原作は3隅だけを見ていた
    i32 ts = placement.get_tspin_type(this->board);
    lock.tspin = ts == 1;
    lock.mini = ts == 2;

    const i32 zone_rows = this->zone ? std::countr_one(this->board.get_clear_mask()) : 0;

    placement.place(this->board);

    lock.clear = this->zone ? this->board.clear_zone(zone_rows) : this->board.clear();

    if (lock.clear > 0) {
        if (lock.tspin) {
            lock.attack = lock.clear * 2;
            this->b2b++;
        }
        else if (lock.clear == 4) {
            lock.attack = 4;
            this->b2b++;
        }
        else if (lock.mini) {
            // scoring.js：mini は通常消しの表（1ライン 0、2ライン 1）で、BtB は続く
            lock.attack = lock.clear - 1;
            this->b2b++;
        }
        else {
            lock.attack = lock.clear - 1;
            this->b2b = 0;
        }

        this->ren++;

        lock.attack += this->b2b > 1;
        lock.attack += REN_LUT[std::min(this->ren, u8(std::size(REN_LUT) - 1))];

        if (this->board.is_empty()) {
            lock.attack = 10;
        }

        if (this->margin >= 0) {
            lock.attack = u8(this->get_margin_attack(lock, this->board.is_empty()));
        }
    }
    else {
        this->ren = 0;
    }

    this->b2b = std::min(this->b2b, u8(2));

    return lock;
};

// TETLABO lv7: scoring.js のマージン中の表（段 0〜5。32 秒ごとに1段）。b2b・ren は消去の後の値
i32 State::get_margin_attack(const Lock& lock, bool pc) const
{
    static constexpr i32 LINES[4][6] = { { 0, 0, 1, 1, 1, 2 }, { 1, 1, 2, 2, 3, 4 }, { 2, 2, 3, 4, 5, 6 }, { 4, 5, 5, 6, 8, 10 } };
    static constexpr i32 TSPIN[3][6] = { { 2, 2, 3, 4, 5, 6 }, { 4, 5, 5, 6, 8, 10 }, { 6, 7, 8, 10, 12, 16 } };
    static constexpr i32 BTB[6] = { 1, 1, 2, 2, 3, 4 };
    static constexpr i32 PC[6] = { 12, 13, 14, 15, 16, 18 };
    static constexpr i32 REN_ADD[6] = { 0, 0, 0, 1, 1, 1 };

    if (lock.clear == 0) return 0;

    const i32 ms = std::clamp(i32(this->margin), 0, 5);
    if (pc) return PC[ms];

    // mini は通常の消去の表（scoring.js の tSpinType 'mini' は lines の表）
    i32 attack = (lock.tspin && lock.clear <= 3) ? TSPIN[lock.clear - 1][ms] : LINES[std::min<i32>(lock.clear, 4) - 1][ms];

    if (this->b2b > 1) attack += BTB[ms];

    // scoring.js の r は加算前の ren（＝この消去を含めた連続消去数 − 1）
    const i32 r = i32(this->ren) - 1;
    if (r >= 13) attack += 5 + REN_ADD[ms];
    else if (r >= 8) attack += 4 + REN_ADD[ms];
    else if (r >= 6) attack += 3 + REN_ADD[ms];
    else if (r >= 4) attack += 2 + REN_ADD[ms];
    else if (r >= 2) attack += 1 + REN_ADD[ms];

    return attack;
};

// Hashes the state using xxh3 and return an u64
u64 State::get_hash()
{
    u8 buffer[84] = { 0 };

    memcpy(buffer, this->board.cols, 80);
    buffer[80] = this->bag.data;
    buffer[81] = static_cast<u8>(this->hold);
    buffer[82] = this->b2b;
    buffer[83] = this->ren;

    return xxh3_64((const void*)buffer, 84);
};

void State::print()
{
    printf("Board:\n");
    this->board.print();
    this->bag.print();
    printf("Hold:    %c\n", piece::to_char(this->hold));
    printf("Next:    %d\n", this->next);
    printf("B2b:     %d\n", this->b2b);
    printf("Ren:     %d\n", this->ren);
};
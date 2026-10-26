#include "move.h"

namespace move
{

Placement::Placement(u16 hash)
{
    this->x = hash & 0b1111;
    this->y = (hash >> 4) & 0b111111;
    this->r = piece::Rotation((hash >> 10) & 0b11);
    this->type = piece::Type((hash >> 12) & 0b1111);
};

bool Placement::operator == (const Placement& other)
{
    return
        this->x == other.x &&
        this->y == other.y &&
        this->r == other.r &&
        this->type == other.type;
};

bool Placement::operator != (const Placement& other)
{
    return !(*this == other);
};

bool Placement::is_colliding(Board& board)
{
    for (i32 i = 0; i < 4; ++i) {
        i8 cell_x = this->x + piece::get_offset_x(this->type, this->r, i);
        i8 cell_y = this->y + piece::get_offset_y(this->type, this->r, i);

        if (board.is_occupied(cell_x, cell_y)) {
            return true;
        }
    }

    return false;
};

bool Placement::is_tspin(Board& board)
{
    if (this->type == piece::Type::T) {
        switch (this->r)
        {
        case piece::Rotation::UP:
            return board.is_occupied(this->x + 1, this->y + 1) && board.is_occupied(this->x - 1, this->y + 1) && (board.is_occupied(this->x + 1, this->y - 1) || board.is_occupied(this->x - 1, this->y - 1));
        case piece::Rotation::RIGHT:
            return board.is_occupied(this->x + 1, this->y + 1) && (board.is_occupied(this->x + 1, this->y - 1) + board.is_occupied(this->x - 1, this->y - 1) + board.is_occupied(this->x - 1, this->y + 1) >= 2);
        case piece::Rotation::DOWN:
            return board.is_occupied(this->x - 1, this->y - 1) && board.is_occupied(this->x + 1, this->y - 1) && (board.is_occupied(this->x - 1, this->y + 1) || board.is_occupied(this->x + 1, this->y + 1));
        case piece::Rotation::LEFT:
            return board.is_occupied(this->x - 1, this->y + 1) && (board.is_occupied(this->x - 1, this->y - 1) + board.is_occupied(this->x + 1, this->y - 1) + board.is_occupied(this->x + 1, this->y + 1) >= 2);
        }
    }

    return false;
};

i32 Placement::get_tspin_type(Board& board)
{
    if (this->type != piece::Type::T || this->spin == 0) {
        return 0;
    }

    // 4隅（y は上が +）。rotation.js と同じく、壁・床は埋まり扱い（盤面の上端より上は clys の盤面に無い）
    const bool ul = board.is_occupied(this->x - 1, this->y + 1);
    const bool ur = board.is_occupied(this->x + 1, this->y + 1);
    const bool dl = board.is_occupied(this->x - 1, this->y - 1);
    const bool dr = board.is_occupied(this->x + 1, this->y - 1);

    // A・B＝T の凸側の2隅、C・D＝反対側
    i32 ab = 0, cd = 0;

    switch (this->r)
    {
    case piece::Rotation::UP:    ab = ul + ur; cd = dl + dr; break;
    case piece::Rotation::RIGHT: ab = ur + dr; cd = ul + dl; break;
    case piece::Rotation::DOWN:  ab = dl + dr; cd = ul + ur; break;
    case piece::Rotation::LEFT:  ab = ul + dl; cd = ur + dr; break;
    }

    if (ab == 2 && cd >= 1) {
        return 1;
    }

    if (cd == 2 && ab >= 1) {
        return this->spin == 2 ? 1 : 2;
    }

    return 0;
};

bool Placement::is_above_stack(Board& board)
{
    for (i32 i = 0; i < 4; ++i) {
        i8 cell_x = this->x + piece::get_offset_x(this->type, this->r, i);
        i8 cell_y = this->y + piece::get_offset_y(this->type, this->r, i);

        if (cell_y < 64 - std::countl_zero(board[cell_x])) {
            return false;
        }
    }

    return true;
};

Placement Placement::get_normalize()
{
    auto piece = *this;
    piece.normalize();

    return piece;
};

u16 Placement::get_hash()
{
    u16 hash = 0;

    hash |= this->x & 0b1111;
    hash |= (this->y & 0b111111) << 4;
    hash |= (static_cast<u16>(this->r) & 0b11) << 10;
    hash |= (static_cast<u16>(this->type) & 0b1111) << 12;

    return hash;
};

void Placement::place(Board& board)
{
    for (int i = 0; i < 4; ++i) {
        i8 cell_x = this->x + piece::get_offset_x(this->type, this->r, i);
        i8 cell_y = this->y + piece::get_offset_y(this->type, this->r, i);

        board[cell_x] |= (1ULL << cell_y);
    }
};

void Placement::normalize()
{
    switch (this->type)
    {
    case piece::Type::I:
        switch (this->r)
        {
        case piece::Rotation::UP:
            break;
        case piece::Rotation::RIGHT:
            break;
        case piece::Rotation::DOWN:
            this->r = piece::Rotation::UP;
            --this->x;
            break;
        case piece::Rotation::LEFT:
            this->r = piece::Rotation::RIGHT;
            ++this->y;
            break;
        default:
            break;
        }
        break;
    case piece::Type::S:
        switch (r)
        {
        case piece::Rotation::UP:
            break;
        case piece::Rotation::RIGHT:
            break;
        case piece::Rotation::DOWN:
            this->r = piece::Rotation::UP;
            --this->y;
            break;
        case piece::Rotation::LEFT:
            this->r = piece::Rotation::RIGHT;
            --this->x;
            break;
        default:
            break;
        }
        break;
    case piece::Type::Z:
        switch (r)
        {
        case piece::Rotation::UP:
            break;
        case piece::Rotation::RIGHT:
            break;
        case piece::Rotation::DOWN:
            this->r = piece::Rotation::UP;
            --this->y;
            break;
        case piece::Rotation::LEFT:
            this->r = piece::Rotation::RIGHT;
            --this->x;
            break;
        default:
            break;
        }
        break;
    default:
        break;
    }
};

void Placement::print()
{
    printf("type: %c\n", piece::to_char(this->type));
    printf("x: %d\n", this->x);
    printf("y: %d\n", this->y);
    printf("r: %d\n", static_cast<u8>(this->r));
};

bool Map::get(i8 x, i8 y, piece::Rotation r)
{
    if (x < 0 || x >= 10 || y < 0 || y >= 40) {
        return true;
    }

    return this->data[static_cast<i8>(r)][x] & (1ULL << y);
};

void Map::set(i8 x, i8 y, piece::Rotation r)
{
    assert(x >= 0 && x < 10);
    assert(y >= 0 && x < 40);

    this->data[static_cast<i8>(r)][x] |= 1ULL << y;
};

void Map::unset(i8 x, i8 y, piece::Rotation r)
{
    assert(x >= 0 && x < 10);
    assert(y >= 0 && x < 40);

    this->data[static_cast<i8>(r)][x] &= ~(1ULL << y);
};

void Map::clear()
{
    memset(this->data, 0, sizeof(u64) * 4 * 10);
};

bool move_right(Placement& piece, Map& collision)
{
    if (!collision.get(piece.x + 1, piece.y, piece.r)) {
        piece.x += 1;
        return true;
    }

    return false;
};

bool move_left(Placement& piece, Map& collision)
{
    if (!collision.get(piece.x - 1, piece.y, piece.r)) {
        piece.x -= 1;
        return true;
    }

    return false;
};

bool move_cw(Placement& piece, Map& collision)
{
    piece::Rotation new_r;

    switch (piece.r)
    {
    case piece::Rotation::UP:
        new_r = piece::Rotation::RIGHT;
        break;
    case piece::Rotation::RIGHT:
        new_r = piece::Rotation::DOWN;
        break;
    case piece::Rotation::DOWN:
        new_r = piece::Rotation::LEFT;
        break;
    case piece::Rotation::LEFT:
        new_r = piece::Rotation::UP;
        break;
    }

    return move::move_rotate(piece, new_r, collision);
};

bool move_ccw(Placement& piece, Map& collision)
{
    piece::Rotation new_r;

    switch (piece.r)
    {
    case piece::Rotation::UP:
        new_r = piece::Rotation::LEFT;
        break;
    case piece::Rotation::LEFT:
        new_r = piece::Rotation::DOWN;
        break;
    case piece::Rotation::DOWN:
        new_r = piece::Rotation::RIGHT;
        break;
    case piece::Rotation::RIGHT:
        new_r = piece::Rotation::UP;
        break;
    }

    return move::move_rotate(piece, new_r, collision);
};

i32 move_rotate_kick(Placement& piece, piece::Rotation new_r, Map& collision)
{
    i8 srs_index = piece.type != piece::Type::I;

    for (i32 i = 0; i < 5; ++i) {
        i8 offset_x = get_srs_x(srs_index, piece.r, i) - get_srs_x(srs_index, new_r, i);
        i8 offset_y = get_srs_y(srs_index, piece.r, i) - get_srs_y(srs_index, new_r, i);

        if (!collision.get(piece.x + offset_x, piece.y + offset_y, new_r)) {
            piece.x += offset_x;
            piece.y += offset_y;
            piece.r = new_r;
            return i;
        }
    }

    return -1;
};

bool move_rotate(Placement& piece, piece::Rotation new_r, Map& collision)
{
    i8 srs_index = piece.type != piece::Type::I;

    for (i32 i = 0; i < 5; ++i) {
        i8 offset_x = get_srs_x(srs_index, piece.r, i) - get_srs_x(srs_index, new_r, i);
        i8 offset_y = get_srs_y(srs_index, piece.r, i) - get_srs_y(srs_index, new_r, i);

        if (!collision.get(piece.x + offset_x, piece.y + offset_y, new_r)) {
            piece.x += offset_x;
            piece.y += offset_y;
            piece.r = new_r;
            return true;
        }
    }

    return false;
};

void move_drop(Placement& piece, Map& collision)
{
    u64 col = collision.data[static_cast<i8>(piece.r)][piece.x];

    piece.y = 64 - std::countl_zero(col & ((1ULL << piece.y) - 1));
};

// Check if the board is convex
// If the board is convex, we know that there are no tucks available
bool is_convex(const Board& board, const Map& map_collision)
{
    i32 height = 64;

    for (i32 i = 0; i < 10; ++i) {
        height = std::min(height, 64 - std::countl_zero(board.cols[i]));
    }

    for (i32 r = 0; r < 4; ++r) {
        for (i32 x = 0; x < 10; ++x) {
            u64 col = map_collision.data[r][x] >> height;

            if (col & (col + 1)) {
                return false;
            }
        }
    }

    return true;
};

// Move generation using depth first search
std::vector<Placement> generate(const Board& board, piece::Type type)
{
    std::vector<Placement> result;
    result.reserve(128);

    auto locked = Map();
    auto visited = Map();
    auto collision = Map();
    auto spin = Map();
    auto spin5 = Map();
    // TETLABO lv6: T の置き場所に「回転で着くか」の印を付けて返す
    auto mark_spin = [&] (std::vector<Placement>& out) {
        if (type != piece::Type::T) return;
        for (auto& p : out) {
            p.spin = spin.get(p.x, p.y, p.r) ? (spin5.get(p.x, p.y, p.r) ? 2 : 1) : 0;
        }
    };

    // Check for fast mode
    // If the search board is low enough, we know that can reach any columns using hard drop
    // This removes the need to simulate piece from the starting positions
    bool fast = true;

    for (i32 i = 0; i < 10; ++i) {
        if (64 - std::countl_zero(board.cols[i]) > 16) {
            fast = false;
            break;
        }
    }

    // Create collision map
    for (i8 r = 0; r < 4; ++r) {
        for (i8 i = 0; i < 4; ++i) {
            i8 offset_x = piece::get_offset_x(type, piece::Rotation(r), i);
            i8 offset_y = piece::get_offset_y(type, piece::Rotation(r), i);

            for (i8 x = 0; x < 10; ++x) {
                u64 c = ~0ULL;

                if (x + offset_x >= 0 && x + offset_x < 10) {
                    c = board.cols[x + offset_x];

                    if (offset_y < 0) {
                        c = ~((~c) << (-offset_y));
                    }
                    else {
                        c = c >> offset_y;
                    }
                }

                collision.data[r][x] |= c;
            }
        }
    }

    // Move generation for board with no tucks
    if (fast && move::is_convex(board, collision)) {
        for (i8 r = 0; r < 4; ++r) {
            for (i8 x = 0; x < 10; ++x) {
                if (collision.data[r][x] & (1ULL << 19)) {
                    continue;
                }

                result.push_back(
                    Placement(
                        x,
                        64 - std::countl_zero(collision.data[r][x]),
                        piece::Rotation(r),
                        type
                    )
                );
            }

            if (type == piece::Type::O) {
                break;
            }

            if ((type == piece::Type::I || type == piece::Type::S || type == piece::Type::Z) && r > 0) {
                break;
            }
        }

        return result;
    }

    // Move generation for low board with some tucks
    if (fast) {
        // Populate the sky
        // Since we know that we can reach all columns above the stack, we set them as visited so that we don't have to check for them later
        // This will make us miss mid-air tucks, but those are bad and rare enough anyway
        for (i8 r = 0; r < 4; ++r) {
            for (i8 x = 0; x < 10; ++x) {
                visited.data[r][x] = ~((1ULL << (64 - std::countl_zero(collision.data[r][x]))) - 1);
            }
        }

        // Dropping pieces
        Placement dropped[40];
        i32 dropped_count = 0;

        for (i8 r = 0; r < 4; ++r) {
            for (i8 x = 0; x < 10; ++x) {
                if (collision.data[r][x] & (1ULL << 19)) {
                    continue;
                }

                dropped[dropped_count] = Placement(x, 64 - std::countl_zero(collision.data[r][x]), piece::Rotation(r), type);
                dropped_count += 1;
            }

            if (type == piece::Type::O) {
                break;
            }
        }

        // Check for tucks
        for (i32 i = 0; i < dropped_count; ++i) {
            move::expand(dropped[i], collision, visited, locked, result, spin, spin5);
        }

        mark_spin(result);
        return result;
    }

    // Move generation from the starting position
    Placement init = Placement(i8(4), i8(19), piece::Rotation::UP, type);

    if (collision.data[0][4] & (1ULL << 19)) {
        init.y += 1;

        if (collision.data[0][4] & (1ULL << 20)) {
            return {};
        }
    }

    move::expand(init, collision, visited, locked, result, spin, spin5);

    mark_spin(result);
    return result;
};

void expand(const Placement& piece, Map& collision, Map& visited, Map& locked, std::vector<Placement>& result,
            Map& spin, Map& spin5)
{
    // Drop
    auto drop = piece;

    move::move_drop(drop, collision);

    if (drop.y <= move::get_lock_height(drop.type, drop.r)) {
        auto lock = drop;
        lock.normalize();
        
        if (!locked.get(lock.x, lock.y, lock.r)) {
            locked.set(lock.x, lock.y, lock.r);
            result.push_back(lock);
        }
    }

    if (drop.y != piece.y && !visited.get(drop.x, drop.y, drop.r)) {
        visited.set(drop.x, drop.y, drop.r);
        move::expand(drop, collision, visited, locked, result, spin, spin5);
    }

    // Right
    auto right = piece;

    if (move::move_right(right, collision) && !visited.get(right.x, right.y, right.r)) {
        visited.set(right.x, right.y, right.r);
        move::expand(right, collision, visited, locked, result, spin, spin5);
    }

    // Left
    auto left = piece;

    if (move::move_left(left, collision) && !visited.get(left.x, left.y, left.r)) {
        visited.set(left.x, left.y, left.r);
        move::expand(left, collision, visited, locked, result, spin, spin5);
    }

    if (piece.type == piece::Type::O) {
        return;
    }

    // Clockwise / Counter clockwise
    // TETLABO lv6: 回転した先が接地していれば「回転で着く置き場所」として印を付ける（visited かどうかに関係なく）
    static const piece::Rotation CW_OF[4] = { piece::Rotation::RIGHT, piece::Rotation::DOWN, piece::Rotation::LEFT, piece::Rotation::UP };
    static const piece::Rotation CCW_OF[4] = { piece::Rotation::LEFT, piece::Rotation::UP, piece::Rotation::RIGHT, piece::Rotation::DOWN };
    for (i32 dir = 0; dir < 2; ++dir) {
        auto rot = piece;
        piece::Rotation new_r = dir == 0 ? CW_OF[static_cast<u8>(piece.r)] : CCW_OF[static_cast<u8>(piece.r)];
        i32 kick = move::move_rotate_kick(rot, new_r, collision);

        if (kick < 0) {
            continue;
        }

        if (piece.type == piece::Type::T && collision.get(rot.x, rot.y - 1, rot.r)) {
            spin.set(rot.x, rot.y, rot.r);
            if (kick == 4) {
                spin5.set(rot.x, rot.y, rot.r);
            }
        }

        if (!visited.get(rot.x, rot.y, rot.r)) {
            visited.set(rot.x, rot.y, rot.r);
            move::expand(rot, collision, visited, locked, result, spin, spin5);
        }
    }
};

};
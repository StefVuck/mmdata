#include "tuned_lane.hpp"

#include <cstring>
#include <stdexcept>

using namespace itch;

TunedLane::TunedLane(size_t order_capacity_log2)
    : table_(new Order[size_t(1) << order_capacity_log2]()),
      mask_((size_t(1) << order_capacity_log2) - 1),
      books_(65536),
      positions_(65536),
      symbols_(65536),
      outbox_(kOutboxSlots * kOuchLen) {
    for (size_t i = 0; i < kOutboxSlots; ++i) {
        uint8_t* o = outbox_.data() + i * kOuchLen;
        std::memset(o, ' ', kOuchLen);
        o[0] = 'O';
        std::memcpy(o + 1, "MM", 2);
        std::memset(o + 32, 0, 4);
        std::memcpy(o + 36, "MMDTYPN", 7);
        std::memset(o + 43, 0, 4);
        o[47] = 'N';
        o[48] = 'R';
    }
}

bool TunedLane::frame(Cursor& c) {
    if (c.pos == 0) {
        if (be64(c.packet + 10) != c.expected_seq) throw std::runtime_error("sequence gap");
        c.remaining = be16(c.packet + 18);
        c.pos = kMoldHeader;
    }
    if (c.remaining == 0) return false;
    const uint16_t len = be16(c.packet + c.pos);
    c.msg = c.packet + c.pos + 2;
    c.msg_len = len;
    c.pos += 2u + len;
    --c.remaining;
    return true;
}

void TunedLane::decode(const Cursor& c) {
    const uint8_t* p = c.msg;
    m_.type = char(p[0]);
    m_.locate = be16(p + 1);
    switch (m_.type) {
        case 'A':
        case 'F':
            m_.ref = be64(p + off::kRef);
            m_.side = char(p[off::kAddSide]);
            m_.shares = be32(p + off::kAddShares);
            m_.price = be32(p + off::kAddPrice);
            break;
        case 'E':
        case 'C':
        case 'X':
            m_.ref = be64(p + off::kRef);
            m_.shares = be32(p + off::kExecShares);
            break;
        case 'D':
            m_.ref = be64(p + off::kRef);
            break;
        case 'U':
            m_.ref = be64(p + off::kRef);
            m_.new_ref = be64(p + off::kReplaceNewRef);
            m_.shares = be32(p + off::kReplaceShares);
            m_.price = be32(p + off::kReplacePrice);
            break;
        case 'R':
            std::memcpy(symbols_[m_.locate].data(), p + off::kStock, 8);
            break;
        default:
            break;
    }
}

TunedLane::Order* TunedLane::find(uint64_t ref) {
    for (size_t i = slot(ref);; i = (i + 1) & mask_) {
        Order* o = &table_[i];
        if (o->ref == ref) return o;
        if (o->ref == 0) return nullptr;
    }
}

TunedLane::Order* TunedLane::insert(uint64_t ref) {
    for (size_t i = slot(ref);; i = (i + 1) & mask_) {
        Order* o = &table_[i];
        if (o->ref == 0 || o->ref == ref) {
            o->ref = ref;
            return o;
        }
    }
}

// Backward-shift deletion keeps probe chains short without tombstones.
void TunedLane::erase(Order* o) {
    size_t hole = size_t(o - table_.get());
    size_t i = hole;
    for (;;) {
        i = (i + 1) & mask_;
        Order& next = table_[i];
        if (next.ref == 0) break;
        const size_t home = slot(next.ref);
        if (((i - home) & mask_) >= ((i - hole) & mask_)) {
            table_[hole] = next;
            hole = i;
        }
    }
    table_[hole].ref = 0;
}

void TunedLane::apply(uint16_t locate, char side, uint32_t price, int64_t delta, bool* cleared) {
    Book& b = books_[locate];
    const bool bid = side == 'B';
    std::vector<Level>& lv = bid ? b.bids.levels : b.asks.levels;
    size_t i = 0;
    const size_t n = lv.size();
    if (bid) {
        while (i < n && lv[i].price > price) ++i;
    } else {
        while (i < n && lv[i].price < price) ++i;
    }
    if (i < n && lv[i].price == price) {
        lv[i].qty += uint64_t(delta);
        if (lv[i].qty == 0) {
            lv.erase(lv.begin() + long(i));
            if (cleared) *cleared = true;
        }
    } else if (delta > 0) {
        lv.insert(lv.begin() + long(i), Level{price, uint64_t(delta)});
    }
}

void TunedLane::reduce(uint64_t ref, uint32_t shares, bool execution) {
    Order* o = find(ref);
    if (!o) return;
    const uint32_t take = shares < o->shares ? shares : o->shares;
    bool cleared = false;
    apply(o->locate, o->side, o->price, -int64_t(take), &cleared);
    o->shares -= take;
    if (execution) {
        exec_cleared_ = cleared;
        exec_side_ = o->side;
        exec_locate_ = o->locate;
    }
    if (o->shares == 0) erase(o);
}

void TunedLane::book() {
    exec_cleared_ = false;
    switch (m_.type) {
        case 'A':
        case 'F': {
            Order* o = insert(m_.ref);
            o->price = m_.price;
            o->shares = m_.shares;
            o->locate = m_.locate;
            o->side = m_.side;
            apply(m_.locate, m_.side, m_.price, m_.shares, nullptr);
            break;
        }
        case 'E':
        case 'C':
            reduce(m_.ref, m_.shares, true);
            break;
        case 'X':
            reduce(m_.ref, m_.shares, false);
            break;
        case 'D':
            reduce(m_.ref, 0xffffffffu, false);
            break;
        case 'U': {
            Order* old = find(m_.ref);
            if (!old) break;
            const char side = old->side;
            const uint16_t locate = old->locate;
            reduce(m_.ref, 0xffffffffu, false);
            Order* o = insert(m_.new_ref);
            o->price = m_.price;
            o->shares = m_.shares;
            o->locate = locate;
            o->side = side;
            apply(locate, side, m_.price, m_.shares, nullptr);
            break;
        }
        case 'R': {
            Book& b = books_[m_.locate];
            b.bids.levels.reserve(256);
            b.asks.levels.reserve(256);
            break;
        }
        default:
            break;
    }
}

bool TunedLane::signal() {
    if (!exec_cleared_) return false;
    const Book& b = books_[exec_locate_];
    const std::vector<Level>& same = exec_side_ == 'B' ? b.bids.levels : b.asks.levels;
    if (same.empty()) return false;
    intent_ = Intent{exec_locate_, char(exec_side_ == 'B' ? 'S' : 'B'), same[0].price, kOrderShares};
    return true;
}

bool TunedLane::risk() {
    const int64_t signed_qty = intent_.side == 'B' ? int64_t(intent_.shares) : -int64_t(intent_.shares);
    int64_t& pos = positions_[intent_.locate];
    const int64_t next = pos + signed_qty;
    if (next > kPositionLimit || next < -kPositionLimit) return false;
    pos = next;
    return true;
}

void TunedLane::encode() {
    ++sent_;
    uint8_t* o = outbox_.data() + ((sent_ - 1) & (kOutboxSlots - 1)) * kOuchLen;
    // Token: "MM" then the order number, left-aligned in 14 bytes as the naive lane writes it.
    char digits[20];
    int n = 0;
    for (size_t v = sent_; v; v /= 10) digits[n++] = char('0' + v % 10);
    std::memset(o + 3, ' ', 12);
    for (int i = 0; i < n; ++i) o[3 + i] = uint8_t(digits[n - 1 - i]);
    o[15] = uint8_t(intent_.side);
    const uint32_t shares = __builtin_bswap32(intent_.shares);
    std::memcpy(o + 16, &shares, 4);
    std::memcpy(o + 20, symbols_[intent_.locate].data(), 8);
    const uint32_t price = __builtin_bswap32(intent_.price);
    std::memcpy(o + 28, &price, 4);
}

#include "naive_lane.hpp"

#include <cmath>
#include <cstdlib>
#include <stdexcept>

uint64_t NaiveLane::read_be(size_t offset, size_t width) const {
    uint64_t v = 0;
    for (size_t i = 0; i < width; ++i) v = (v << 8) | current_.at(offset + i);
    return v;
}

bool NaiveLane::frame(Cursor& c) {
    if (c.pos == 0) {
        std::string session(reinterpret_cast<const char*>(c.packet), 10);
        if (session.empty()) throw std::runtime_error("bad session");
        uint64_t seq = 0;
        for (int i = 0; i < 8; ++i) seq = (seq << 8) | c.packet[10 + i];
        if (seq != c.expected_seq) throw std::runtime_error("sequence gap");
        c.remaining = uint16_t((c.packet[18] << 8) | c.packet[19]);
        c.pos = kMoldHeader;
    }
    if (c.remaining == 0) return false;
    const uint16_t len = uint16_t((c.packet[c.pos] << 8) | c.packet[c.pos + 1]);
    c.msg = c.packet + c.pos + 2;
    c.msg_len = len;
    c.pos += 2u + len;
    --c.remaining;
    current_.assign(c.msg, c.msg + len);
    return true;
}

void NaiveLane::decode(const Cursor&) {
    const char type = char(current_.at(0));
    auto symbol = [&](size_t off) {
        std::string s;
        for (size_t i = 0; i < 8; ++i) {
            const char ch = char(current_.at(off + i));
            if (ch != ' ') s += ch;
        }
        return s;
    };

    std::unique_ptr<Message> m;
    switch (type) {
        case 'R': {
            auto d = std::make_unique<Directory>();
            d->stock = symbol(11);
            m = std::move(d);
            break;
        }
        case 'A':
        case 'F': {
            auto a = std::make_unique<AddOrder>();
            a->ref = read_be(11, 8);
            a->side = char(current_.at(19));
            a->shares = uint32_t(read_be(20, 4));
            a->stock = symbol(24);
            a->price = uint32_t(read_be(32, 4));
            m = std::move(a);
            break;
        }
        case 'E':
        case 'C': {
            auto e = std::make_unique<Executed>();
            e->ref = read_be(11, 8);
            e->shares = uint32_t(read_be(19, 4));
            m = std::move(e);
            break;
        }
        case 'X': {
            auto x = std::make_unique<Cancel>();
            x->ref = read_be(11, 8);
            x->shares = uint32_t(read_be(19, 4));
            m = std::move(x);
            break;
        }
        case 'D': {
            auto d = std::make_unique<Delete>();
            d->ref = read_be(11, 8);
            m = std::move(d);
            break;
        }
        case 'U': {
            auto u = std::make_unique<Replace>();
            u->ref = read_be(11, 8);
            u->new_ref = read_be(19, 8);
            u->shares = uint32_t(read_be(27, 4));
            u->price = uint32_t(read_be(31, 4));
            m = std::move(u);
            break;
        }
        default:
            m = std::make_unique<Other>();
    }
    m->type = type;
    m->locate = uint16_t(read_be(1, 2));
    m->timestamp = read_be(5, 6);
    message_ = std::move(m);
}

void NaiveLane::add_to_level(const std::string& stock, char side, uint32_t price, int64_t delta) {
    Book& b = books_[stock];
    if (side == 'B') {
        b.bids[price] += uint64_t(delta);
        if (b.bids[price] == 0) b.bids.erase(price);
    } else {
        b.asks[price] += uint64_t(delta);
        if (b.asks[price] == 0) b.asks.erase(price);
    }
}

void NaiveLane::reduce(uint64_t ref, uint32_t shares, bool execution) {
    auto it = orders_.find(ref);
    if (it == orders_.end()) return;
    Order& o = it->second;
    const uint32_t take = std::min(shares, o.shares);
    add_to_level(o.stock, o.side, o.price, -int64_t(take));
    o.shares -= take;
    if (execution) {
        const Book& b = books_[o.stock];
        const bool cleared = o.side == 'B' ? b.bids.find(o.price) == b.bids.end()
                                           : b.asks.find(o.price) == b.asks.end();
        last_.valid = true;
        last_.cleared = cleared;
        last_.stock = o.stock;
        last_.side = o.side;
    }
    if (o.shares == 0) orders_.erase(it);
}

void NaiveLane::book() {
    last_ = LastExec{};
    Message* m = message_.get();
    if (auto* d = dynamic_cast<Directory*>(m)) {
        symbols_[d->locate] = d->stock;
        books_[d->stock];
    } else if (auto* a = dynamic_cast<AddOrder*>(m)) {
        orders_[a->ref] = Order{a->stock, a->side, a->price, a->shares};
        add_to_level(a->stock, a->side, a->price, a->shares);
    } else if (auto* e = dynamic_cast<Executed*>(m)) {
        reduce(e->ref, e->shares, true);
    } else if (auto* x = dynamic_cast<Cancel*>(m)) {
        reduce(x->ref, x->shares, false);
    } else if (auto* d = dynamic_cast<Delete*>(m)) {
        reduce(d->ref, 0xffffffffu, false);
    } else if (auto* u = dynamic_cast<Replace*>(m)) {
        auto it = orders_.find(u->ref);
        if (it == orders_.end()) return;
        Order old = it->second;
        reduce(u->ref, 0xffffffffu, false);
        orders_[u->new_ref] = Order{old.stock, old.side, u->price, u->shares};
        add_to_level(old.stock, old.side, u->price, u->shares);
    }
}

bool NaiveLane::signal() {
    if (!last_.valid || !last_.cleared) return false;
    const Book& b = books_.at(last_.stock);

    std::vector<std::pair<uint32_t, uint64_t>> bids(b.bids.begin(), b.bids.end());
    std::vector<std::pair<uint32_t, uint64_t>> asks(b.asks.begin(), b.asks.end());
    double bid_depth = 0, ask_depth = 0;
    for (size_t i = 0; i < bids.size() && i < 5; ++i) bid_depth += double(bids[i].second);
    for (size_t i = 0; i < asks.size() && i < 5; ++i) ask_depth += double(asks[i].second);
    const double imbalance = (bid_depth - ask_depth) / std::max(1.0, bid_depth + ask_depth);
    if (std::isnan(imbalance)) return false;

    if (last_.side == 'B') {
        if (bids.empty()) return false;
        intent_ = Intent{0, 'S', bids.front().first, kOrderShares};
    } else {
        if (asks.empty()) return false;
        intent_ = Intent{0, 'B', asks.front().first, kOrderShares};
    }
    intent_stock_ = last_.stock;
    return true;
}

bool NaiveLane::risk() {
    const int64_t signed_qty = intent_.side == 'B' ? int64_t(intent_.shares) : -int64_t(intent_.shares);
    int64_t& pos = positions_[intent_stock_];
    if (std::llabs(pos + signed_qty) > kPositionLimit) return false;
    pos += signed_qty;
    return true;
}

void NaiveLane::encode() {
    auto be = [](std::string& s, uint64_t v, int width) {
        for (int i = width - 1; i >= 0; --i) s += char((v >> (i * 8)) & 0xff);
    };
    auto padded = [](std::string s, size_t width) {
        while (s.size() < width) s += ' ';
        return s.substr(0, width);
    };
    std::string out;
    out += 'O';
    out += padded("MM" + std::to_string(sent_.size() + 1), 14);
    out += intent_.side;
    be(out, intent_.shares, 4);
    out += padded(intent_stock_, 8);
    be(out, intent_.price, 4);
    be(out, 0, 4);
    out += "MMDT";
    out += 'Y';
    out += 'P';
    out += 'N';
    be(out, 0, 4);
    out += 'N';
    out += 'R';
    sent_.push_back(std::move(out));
}

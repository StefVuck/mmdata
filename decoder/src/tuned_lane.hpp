#pragma once

#include <array>
#include <memory>
#include <vector>

#include "lane.hpp"

// Same behaviour as NaiveLane: fixed-offset loads, a POD message on the stack, an open-addressed
// order table sized up front, flat best-first level arrays and a pre-filled order template.
class TunedLane {
public:
    explicit TunedLane(size_t order_capacity_log2 = 22);

    bool frame(Cursor& c);
    void decode(const Cursor& c);
    void book();
    bool signal();
    bool risk();
    void encode();

    size_t orders_sent() const { return sent_; }
    const uint8_t* last_order() const { return outbox_.data() + ((sent_ - 1) & (kOutboxSlots - 1)) * kOuchLen; }

private:
    struct Decoded {
        char type;
        char side;
        uint16_t locate;
        uint32_t shares;
        uint32_t price;
        uint64_t ref;
        uint64_t new_ref;
    };
    struct Order {
        uint64_t ref;
        uint32_t price;
        uint32_t shares;
        uint16_t locate;
        char side;
    };
    struct Level {
        uint32_t price;
        uint64_t qty;
    };
    struct Side {
        std::vector<Level> levels;  // best first
    };
    struct Book {
        Side bids, asks;
    };

    static constexpr size_t kOuchLen = 49;
    static constexpr size_t kOutboxSlots = 1024;

    Order* find(uint64_t ref);
    Order* insert(uint64_t ref);
    void erase(Order* o);
    // ITCH references are issued in sequence and most orders die young, so indexing by the low
    // bits keeps the live region of the table contiguous and hot in cache.
    size_t slot(uint64_t ref) const { return size_t(ref) & mask_; }
    void apply(uint16_t locate, char side, uint32_t price, int64_t delta, bool* cleared);
    void reduce(uint64_t ref, uint32_t shares, bool execution);

    Decoded m_{};
    std::unique_ptr<Order[]> table_;
    size_t mask_;
    std::vector<Book> books_;
    std::vector<int64_t> positions_;
    std::vector<std::array<char, 8>> symbols_;

    bool exec_cleared_ = false;
    char exec_side_ = 0;
    uint16_t exec_locate_ = 0;
    Intent intent_{};

    std::vector<uint8_t> outbox_;
    size_t sent_ = 0;
};

#pragma once

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "lane.hpp"

// Idiomatic, readable, and slow: heap-allocated polymorphic messages, node-based maps keyed
// by strings, bounds-checked byte-by-byte parsing and string-built orders.
class NaiveLane {
public:
    bool frame(Cursor& c);
    void decode(const Cursor& c);
    void book();
    bool signal();
    bool risk();
    void encode();

    const std::vector<std::string>& sent() const { return sent_; }

private:
    struct Message {
        virtual ~Message() = default;
        char type = 0;
        uint16_t locate = 0;
        uint64_t timestamp = 0;
    };
    struct Directory : Message { std::string stock; };
    struct AddOrder : Message { uint64_t ref; char side; uint32_t shares; std::string stock; uint32_t price; };
    struct Executed : Message { uint64_t ref; uint32_t shares; };
    struct Cancel : Message { uint64_t ref; uint32_t shares; };
    struct Delete : Message { uint64_t ref; };
    struct Replace : Message { uint64_t ref; uint64_t new_ref; uint32_t shares; uint32_t price; };
    struct Other : Message {};

    struct Order {
        std::string stock;
        char side;
        uint32_t price;
        uint32_t shares;
    };
    struct Book {
        std::map<uint32_t, uint64_t, std::greater<uint32_t>> bids;
        std::map<uint32_t, uint64_t> asks;
    };
    struct LastExec {
        bool valid = false;
        bool cleared = false;
        std::string stock;
        char side = 0;
    };

    uint64_t read_be(size_t offset, size_t width) const;
    void add_to_level(const std::string& stock, char side, uint32_t price, int64_t delta);
    void reduce(uint64_t ref, uint32_t shares, bool execution);

    std::vector<uint8_t> current_;
    std::unique_ptr<Message> message_;
    std::unordered_map<uint16_t, std::string> symbols_;
    std::unordered_map<uint64_t, Order> orders_;
    std::unordered_map<std::string, Book> books_;
    LastExec last_;
    std::string intent_stock_;
    Intent intent_{};
    std::map<std::string, int64_t> positions_;
    std::vector<std::string> sent_;
};

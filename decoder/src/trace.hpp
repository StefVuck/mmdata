#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "feed.hpp"
#include "lane.hpp"

// Layout is documented in docs/trace-format.md.
struct BookEvent {
    uint32_t message;
    uint8_t kind;  // 0 level quantity changed, 1 trade print
    char side;
    uint32_t price;
    uint32_t qty;
};

enum TraceFlags : uint32_t { kCountersMeasured = 1, kCountersRdpmc = 2, kTimingAveraged = 4 };

struct TraceInput {
    const Feed* feed;
    std::vector<const Recording*> lanes;
    std::vector<std::string> lane_names;
    std::vector<BookEvent> book;
    uint32_t flags;
    double tsc_ghz;
    uint16_t hero_locate;
    uint32_t hero_message;
    uint32_t ring_slots;
    float timer_ns;  // one tick of the timer the stages were measured with
};

void write_trace(const std::string& path, const TraceInput& in);

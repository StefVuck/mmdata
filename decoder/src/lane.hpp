#pragma once

#include <cstdint>
#include <vector>

#include "counters.hpp"
#include "feed.hpp"
#include "itch.hpp"

enum Stage : int { kFrame, kDecode, kBook, kSignal, kRisk, kEncode, kStageCount };

enum Outcome : uint8_t { kNone = 0, kRejected = 1, kSent = 2 };

struct Recording {
    explicit Recording(size_t messages)
        : ticks(messages * kStageCount), counts(messages * kStageCount * kCounterCount), outcome(messages) {}
    std::vector<uint32_t> ticks;
    std::vector<uint16_t> counts;
    std::vector<uint8_t> outcome;
};

// Walks one MoldUDP64 packet. The lane does the actual parsing inside its frame stage.
struct Cursor {
    const uint8_t* packet;
    uint32_t length;
    uint32_t pos = 0;
    uint16_t remaining = 0;
    uint64_t expected_seq = 0;
    const uint8_t* msg = nullptr;
    uint16_t msg_len = 0;
};

// What a strategy order looks like before the lane encodes it.
struct Intent {
    uint16_t locate;
    char side;
    uint32_t price;
    uint32_t shares;
};

constexpr uint32_t kOrderShares = 100;
constexpr int64_t kPositionLimit = 2000;

struct NullProbe {
    void begin() {}
    void end(Recording&, size_t, int) {}
};

struct TscProbe {
    uint32_t overhead = 0;
    uint64_t t0 = 0;
    void begin() { t0 = tsc_begin(); }
    void end(Recording& r, size_t msg, int stage) {
        const uint64_t d = tsc_end() - t0;
        r.ticks[msg * kStageCount + stage] = d > overhead ? uint32_t(d - overhead) : 0;
    }
};

struct PmcProbe {
    const PmcSet* set;
    uint64_t c0[kCounterCount];
    void begin() {
        asm volatile("" ::: "memory");
        set->read(c0);
        asm volatile("" ::: "memory");
    }
    void end(Recording& r, size_t msg, int stage) {
        asm volatile("" ::: "memory");
        uint64_t c1[kCounterCount];
        set->read(c1);
        uint16_t* out = &r.counts[(msg * kStageCount + stage) * kCounterCount];
        for (int i = 0; i < kCounterCount; ++i) {
            const uint64_t d = c1[i] - c0[i];
            out[i] = d > 0xffff ? 0xffff : uint16_t(d);
        }
    }
};

template <class Lane, class Probe>
void run_lane(const Feed& feed, Lane& lane, Probe& probe, Recording& rec) {
    size_t msg = 0;
    uint64_t seq = 1;
    for (const Packet& p : feed.packets) {
        Cursor c{feed.bytes.data() + p.offset, p.length};
        c.expected_seq = seq;
        seq += p.count;
        for (;;) {
            probe.begin();
            if (!lane.frame(c)) break;
            probe.end(rec, msg, kFrame);

            probe.begin();
            lane.decode(c);
            probe.end(rec, msg, kDecode);

            probe.begin();
            lane.book();
            probe.end(rec, msg, kBook);

            probe.begin();
            const bool fire = lane.signal();
            probe.end(rec, msg, kSignal);

            uint8_t outcome = kNone;
            if (fire) {
                probe.begin();
                const bool ok = lane.risk();
                probe.end(rec, msg, kRisk);
                outcome = kRejected;
                if (ok) {
                    probe.begin();
                    lane.encode();
                    probe.end(rec, msg, kEncode);
                    outcome = kSent;
                }
            }
            rec.outcome[msg] = outcome;
            ++msg;
        }
    }
}

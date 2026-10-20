#pragma once

#include <cstdint>

#if defined(__x86_64__) || defined(__i386__)
#include <x86intrin.h>

inline uint64_t tsc_begin() {
    asm volatile("" ::: "memory");
    _mm_lfence();
    const uint64_t t = __rdtsc();
    _mm_lfence();
    asm volatile("" ::: "memory");
    return t;
}

inline uint64_t tsc_end() {
    asm volatile("" ::: "memory");
    unsigned aux;
    const uint64_t t = __rdtscp(&aux);
    _mm_lfence();
    asm volatile("" ::: "memory");
    return t;
}

#elif defined(__aarch64__)

// The generic timer. On Apple Silicon it runs at 24 MHz, about 42 ns a tick, which is coarser
// than most pipeline stages; see timer_is_coarse() for how main copes with that.
inline uint64_t tsc_begin() {
    uint64_t v;
    asm volatile("isb\n\tmrs %0, cntvct_el0" : "=r"(v) : : "memory");
    return v;
}

inline uint64_t tsc_end() { return tsc_begin(); }

#else
#include <chrono>

inline uint64_t tsc_begin() {
    asm volatile("" ::: "memory");
    const auto t = std::chrono::steady_clock::now().time_since_epoch();
    asm volatile("" ::: "memory");
    return uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(t).count());
}

inline uint64_t tsc_end() { return tsc_begin(); }

#endif

// Timer ticks per nanosecond, measured against the system clock.
double calibrate_tsc_ghz();

// A tick longer than a couple of nanoseconds can't resolve a single stage, so samples have to
// be averaged over many passes instead of taking the fastest.
inline bool timer_is_coarse(double ticks_per_ns) { return ticks_per_ns < 0.5; }

enum Counter { kL1dMiss, kLlcRef, kLlcMiss, kBranchMiss, kCounterCount };

// The four counters needed to place a stall in the memory hierarchy:
//   served by L2   = L1D misses - LLC references (an LLC reference is an L2 miss on Intel)
//   served by L3   = LLC references - LLC misses
//   served by DRAM = LLC misses
// Only available on Linux, through perf_event_open.
class PmcSet {
public:
    PmcSet() = default;
    PmcSet(const PmcSet&) = delete;
    PmcSet& operator=(const PmcSet&) = delete;
    ~PmcSet();

    bool open(const char** error);
    bool uses_rdpmc() const { return rdpmc_; }
    void read(uint64_t out[kCounterCount]) const;

private:
    [[maybe_unused]] int fds_[kCounterCount] = {-1, -1, -1, -1};
    [[maybe_unused]] void* pages_[kCounterCount] = {};
    bool rdpmc_ = false;
};

bool pin_to_cpu(int cpu);

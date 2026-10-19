#pragma once

#include <cstdint>
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

double calibrate_tsc_ghz();

enum Counter { kL1dMiss, kLlcRef, kLlcMiss, kBranchMiss, kCounterCount };

// The four counters we need to place a stall in the memory hierarchy:
//   served by L2   = L1D misses - LLC references (an LLC reference is an L2 miss on Intel)
//   served by L3   = LLC references - LLC misses
//   served by DRAM = LLC misses
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
    int fds_[kCounterCount] = {-1, -1, -1, -1};
    void* pages_[kCounterCount] = {};
    bool rdpmc_ = false;
};

bool pin_to_cpu(int cpu);

#include "counters.hpp"

#include <linux/perf_event.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>

double calibrate_tsc_ghz() {
    using clock = std::chrono::steady_clock;
    const auto w0 = clock::now();
    const uint64_t t0 = tsc_begin();
    while (clock::now() - w0 < std::chrono::milliseconds(200)) {
    }
    const uint64_t t1 = tsc_end();
    const auto w1 = clock::now();
    const double ns = std::chrono::duration<double, std::nano>(w1 - w0).count();
    return double(t1 - t0) / ns;
}

namespace {

perf_event_attr make_attr(uint32_t type, uint64_t config, bool leader) {
    perf_event_attr a;
    std::memset(&a, 0, sizeof a);
    a.size = sizeof a;
    a.type = type;
    a.config = config;
    a.exclude_kernel = 1;
    a.exclude_hv = 1;
    a.disabled = leader ? 1 : 0;
    a.pinned = leader ? 1 : 0;
    return a;
}

uint64_t read_mmap_counter(const perf_event_mmap_page* pc) {
    uint32_t seq;
    uint64_t count;
    do {
        seq = pc->lock;
        asm volatile("" ::: "memory");
        const uint32_t idx = pc->index;
        count = uint64_t(pc->offset);
        if (pc->cap_user_rdpmc && idx) {
            const uint32_t width = pc->pmc_width;
            int64_t pmc = int64_t(__rdpmc(int(idx - 1)));
            pmc <<= 64 - width;
            pmc >>= 64 - width;
            count += uint64_t(pmc);
        }
        asm volatile("" ::: "memory");
    } while (pc->lock != seq);
    return count;
}

}  // namespace

PmcSet::~PmcSet() {
    const long page = sysconf(_SC_PAGESIZE);
    for (int i = 0; i < kCounterCount; ++i) {
        if (pages_[i]) munmap(pages_[i], size_t(page));
        if (fds_[i] >= 0) close(fds_[i]);
    }
}

bool PmcSet::open(const char** error) {
    const uint64_t l1d_read_miss = PERF_COUNT_HW_CACHE_L1D | (PERF_COUNT_HW_CACHE_OP_READ << 8) |
                                   (PERF_COUNT_HW_CACHE_RESULT_MISS << 16);
    const perf_event_attr attrs[kCounterCount] = {
        make_attr(PERF_TYPE_HW_CACHE, l1d_read_miss, true),
        make_attr(PERF_TYPE_HARDWARE, PERF_COUNT_HW_CACHE_REFERENCES, false),
        make_attr(PERF_TYPE_HARDWARE, PERF_COUNT_HW_CACHE_MISSES, false),
        make_attr(PERF_TYPE_HARDWARE, PERF_COUNT_HW_BRANCH_MISSES, false),
    };
    for (int i = 0; i < kCounterCount; ++i) {
        perf_event_attr a = attrs[i];
        fds_[i] = int(syscall(SYS_perf_event_open, &a, 0, -1, i == 0 ? -1 : fds_[0], 0));
        if (fds_[i] < 0) {
            *error = std::strerror(errno);
            return false;
        }
    }

    const long page = sysconf(_SC_PAGESIZE);
    rdpmc_ = true;
    for (int i = 0; i < kCounterCount; ++i) {
        void* p = mmap(nullptr, size_t(page), PROT_READ, MAP_SHARED, fds_[i], 0);
        if (p == MAP_FAILED) {
            rdpmc_ = false;
            continue;
        }
        pages_[i] = p;
    }

    ioctl(fds_[0], PERF_EVENT_IOC_RESET, PERF_IOC_FLAG_GROUP);
    ioctl(fds_[0], PERF_EVENT_IOC_ENABLE, PERF_IOC_FLAG_GROUP);

    if (rdpmc_) {
        for (int i = 0; i < kCounterCount; ++i) {
            const auto* pc = static_cast<const perf_event_mmap_page*>(pages_[i]);
            if (!pc->cap_user_rdpmc) rdpmc_ = false;
        }
    }
    return true;
}

void PmcSet::read(uint64_t out[kCounterCount]) const {
    if (rdpmc_) {
        for (int i = 0; i < kCounterCount; ++i)
            out[i] = read_mmap_counter(static_cast<const perf_event_mmap_page*>(pages_[i]));
        return;
    }
    // Fallback: a syscall per read. It disturbs the cache, so the numbers are less clean.
    for (int i = 0; i < kCounterCount; ++i) {
        uint64_t v = 0;
        if (::read(fds_[i], &v, sizeof v) != sizeof v) v = 0;
        out[i] = v;
    }
}

bool pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    return sched_setaffinity(0, sizeof set, &set) == 0;
}

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "counters.hpp"
#include "feed.hpp"
#include "itch.hpp"
#include "lane.hpp"
#include "naive_lane.hpp"
#include "trace.hpp"
#include "tuned_lane.hpp"

namespace {

struct Options {
    std::string input;
    std::string output = "trace.bin";
    std::string hero;
    size_t max_messages = 0;
    int cpu = -1;
    bool counters = true;
    int repeat = 0;
    bool average = false;
    long hero_message = -1;
};

void usage() {
    std::fprintf(stderr,
                 "usage: mmdecode --input FILE.itch [--out trace.bin] [--hero SYMBOL]\n"
                 "                [--hero-message INDEX] [--max-messages N] [--cpu N] [--repeat N]\n"
                 "                [--average] [--no-counters]\n");
    std::exit(2);
}

Options parse(int argc, char** argv) {
    Options o;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) usage();
            return argv[++i];
        };
        if (a == "--input") o.input = next();
        else if (a == "--out") o.output = next();
        else if (a == "--hero") o.hero = next();
        else if (a == "--max-messages") o.max_messages = std::stoul(next());
        else if (a == "--cpu") o.cpu = std::stoi(next());
        else if (a == "--repeat") o.repeat = std::max(1, std::stoi(next()));
        else if (a == "--hero-message") o.hero_message = std::stol(next());
        else if (a == "--average") o.average = true;
        else if (a == "--no-counters") o.counters = false;
        else usage();
    }
    if (o.input.empty()) usage();
    return o;
}

uint32_t measure_probe_overhead() {
    uint64_t best = ~0ull;
    for (int i = 0; i < 100000; ++i) {
        const uint64_t t0 = tsc_begin();
        const uint64_t t1 = tsc_end();
        best = std::min(best, t1 - t0);
    }
    return uint32_t(best);
}

double measure_mean_overhead() {
    const int n = 200000;
    uint64_t sum = 0;
    for (int i = 0; i < n; ++i) {
        const uint64_t t0 = tsc_begin();
        sum += tsc_end() - t0;
    }
    return double(sum) / n;
}

// In averaging mode, recorded ticks are picoseconds, so fractions of a coarse tick survive.
constexpr double kPicosPerNs = 1000;

struct Timing {
    bool average;
    int repeat;
    uint32_t min_overhead;
    double mean_overhead;
    double ticks_per_ns;
};

uint16_t pick_hero(const Feed& feed, const std::string& wanted) {
    if (!wanted.empty()) {
        for (size_t i = 0; i < feed.symbols.size(); ++i)
            if (feed.symbols[i] == wanted) return uint16_t(i);
        std::fprintf(stderr, "hero symbol %s not in the stock directory\n", wanted.c_str());
        std::exit(1);
    }
    std::vector<uint32_t> activity(65536);
    for (size_t i = 0; i < feed.message_count(); ++i)
        if (!feed.symbols[feed.msg_locate[i]].empty()) ++activity[feed.msg_locate[i]];
    return uint16_t(std::max_element(activity.begin(), activity.end()) - activity.begin());
}

// A plain book for the hero symbol only, to feed the order book terrain.
std::vector<BookEvent> hero_book_events(const Feed& feed, uint16_t hero) {
    struct Order { char side; uint32_t price; uint32_t shares; };
    std::unordered_map<uint64_t, Order> orders;
    std::map<uint32_t, uint64_t> levels[2];
    std::vector<BookEvent> out;

    auto change = [&](uint32_t msg, char side, uint32_t price, int64_t delta) {
        auto& lv = levels[side == 'B' ? 0 : 1];
        uint64_t& q = lv[price];
        q += uint64_t(delta);
        out.push_back(BookEvent{msg, 0, side, price, uint32_t(std::min<uint64_t>(q, 0xffffffffu))});
        if (q == 0) lv.erase(price);
    };
    auto reduce = [&](uint32_t msg, uint64_t ref, uint32_t shares, bool trade) {
        auto it = orders.find(ref);
        if (it == orders.end()) return;
        const uint32_t take = std::min(shares, it->second.shares);
        if (trade) out.push_back(BookEvent{msg, 1, it->second.side, it->second.price, take});
        change(msg, it->second.side, it->second.price, -int64_t(take));
        it->second.shares -= take;
        if (it->second.shares == 0) orders.erase(it);
    };

    uint32_t msg = 0;
    for (const Packet& p : feed.packets) {
        const uint8_t* q = feed.bytes.data() + p.offset + kMoldHeader;
        for (uint16_t k = 0; k < p.count; ++k, ++msg) {
            const uint16_t len = itch::be16(q);
            const uint8_t* m = q + 2;
            q += 2 + len;
            if (itch::locate(m) != hero) continue;
            using namespace itch::off;
            switch (m[0]) {
                case 'A':
                case 'F': {
                    const Order o{char(m[kAddSide]), itch::be32(m + kAddPrice), itch::be32(m + kAddShares)};
                    orders[itch::be64(m + kRef)] = o;
                    change(msg, o.side, o.price, o.shares);
                    break;
                }
                case 'E':
                case 'C':
                    reduce(msg, itch::be64(m + kRef), itch::be32(m + kExecShares), true);
                    break;
                case 'X':
                    reduce(msg, itch::be64(m + kRef), itch::be32(m + kCancelShares), false);
                    break;
                case 'D':
                    reduce(msg, itch::be64(m + kRef), 0xffffffffu, false);
                    break;
                case 'U': {
                    auto it = orders.find(itch::be64(m + kRef));
                    if (it == orders.end()) break;
                    const char side = it->second.side;
                    reduce(msg, it->first, 0xffffffffu, false);
                    const Order o{side, itch::be32(m + kReplacePrice), itch::be32(m + kReplaceShares)};
                    orders[itch::be64(m + kReplaceNewRef)] = o;
                    change(msg, side, o.price, o.shares);
                    break;
                }
                case 'P':
                    out.push_back(BookEvent{msg, 1, char(m[kAddSide]), itch::be32(m + kAddPrice), itch::be32(m + kAddShares)});
                    break;
                default:
                    break;
            }
        }
    }
    return out;
}

// Each pass starts from a fresh lane. With a fine timer (rdtsc), the fastest of N passes per
// message and stage removes interrupts and other noise that would otherwise read as stalls.
// With a coarse one (Apple Silicon's 24 MHz counter), each reading is a whole number of ~42 ns
// ticks, but where a stage starts relative to the tick boundary varies from pass to pass, so
// the mean of many passes converges on the true time. Only clear outliers (an interrupt, a
// page fault) are dropped first: trimming any more would bias short stages towards zero.
template <class Lane, class... Args>
Recording timed(const Feed& feed, const Timing& tm, Args... args) {
    const size_t cells = feed.message_count() * kStageCount;
    Recording out(feed.message_count());
    std::vector<uint32_t> passes;
    if (tm.average) passes.resize(cells * size_t(tm.repeat));
    else std::fill(out.ticks.begin(), out.ticks.end(), ~0u);

    for (int r = 0; r < tm.repeat; ++r) {
        Lane lane(args...);
        Recording rec(feed.message_count());
        TscProbe probe;
        probe.overhead = tm.average ? 0 : tm.min_overhead;
        run_lane(feed, lane, probe, rec);
        if (tm.average) std::copy(rec.ticks.begin(), rec.ticks.end(), passes.begin() + long(r * cells));
        else for (size_t i = 0; i < cells; ++i) out.ticks[i] = std::min(out.ticks[i], rec.ticks[i]);
        out.outcome = rec.outcome;
    }

    if (tm.average) {
        std::vector<uint32_t> v(size_t(tm.repeat));
        const uint32_t slack = uint32_t(std::ceil(2 + 20 * tm.ticks_per_ns));
        for (size_t c = 0; c < cells; ++c) {
            for (int r = 0; r < tm.repeat; ++r) v[size_t(r)] = passes[size_t(r) * cells + c];
            std::nth_element(v.begin(), v.begin() + long(v.size() / 2), v.end());
            const uint32_t limit = v[v.size() / 2] + slack;
            uint64_t sum = 0, kept = 0;
            for (uint32_t x : v) {
                if (x > limit) continue;
                sum += x;
                ++kept;
            }
            if (sum == 0) {
                out.ticks[c] = 0;
                continue;
            }
            const double ns = (double(sum) / double(kept) - tm.mean_overhead) / tm.ticks_per_ns;
            out.ticks[c] = ns > 0 ? uint32_t(std::lround(ns * kPicosPerNs)) : 0;
        }
    }
    return out;
}

template <class Lane, class... Args>
void counted(const Feed& feed, const PmcSet& pmc, Recording& into, Args... args) {
    Lane lane(args...);
    Recording rec(feed.message_count());
    PmcProbe probe{&pmc, {}};
    run_lane(feed, lane, probe, rec);
    into.counts = std::move(rec.counts);
}

// How long each message waits behind earlier ones on a single core: arrivals come from the
// feed, service times from the recording.
std::vector<double> queue_wait(const Feed& feed, const Recording& r, double ghz) {
    std::vector<double> w(feed.message_count());
    double free_at = 0;
    for (size_t i = 0; i < w.size(); ++i) {
        const double arrive = double(feed.packets[feed.msg_packet[i]].arrival_ns);
        const double start = std::max(arrive, free_at);
        double service = 0;
        for (int s = 0; s < kStageCount; ++s) service += r.ticks[i * kStageCount + s] / ghz;
        w[i] = start - arrive;
        free_at = start + service;
    }
    return w;
}

// The best story is an order the tuned lane handles at once while the naive lane is still
// working through a burst: a few microseconds behind, not milliseconds.
uint32_t pick_hero_message(const Feed& feed, uint16_t hero, const Recording& naive, const Recording& tuned, double ghz) {
    const std::vector<double> wn = queue_wait(feed, naive, ghz);
    const std::vector<double> wt = queue_wait(feed, tuned, ghz);
    const size_t n = feed.message_count();
    uint32_t best = ~0u;
    double best_score = 1e300;
    for (size_t i = 0; i < n; ++i) {
        if (feed.msg_locate[i] != hero || tuned.outcome[i] != kSent || wt[i] > 30) continue;
        const double score = wn[i] < 300 ? 1e6 - wn[i] : std::fabs(std::log(wn[i] / 4000.0));
        if (score < best_score) {
            best_score = score;
            best = uint32_t(i);
        }
    }
    if (best != ~0u) return best;
    for (size_t i = 0; i < n; ++i)
        if (feed.msg_locate[i] == hero && tuned.outcome[i] == kSent) return uint32_t(i);
    return ~0u;
}

double percentile(std::vector<uint32_t> v, double p) {
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    return v[size_t(p * double(v.size() - 1))];
}

void summarise(const char* name, const Recording& r, size_t messages, double ghz, bool counters) {
    static const char* stages[kStageCount] = {"frame", "decode", "book", "signal", "risk", "encode"};
    std::printf("\n%s lane\n  %-8s %10s %10s %10s", name, "stage", "p50 ns", "p99 ns", "max ns");
    if (counters) std::printf(" %9s %9s %9s %9s", "L1D miss", "LLC ref", "LLC miss", "br miss");
    std::printf("\n");
    for (int s = 0; s < kStageCount; ++s) {
        std::vector<uint32_t> t;
        uint64_t c[kCounterCount] = {};
        for (size_t m = 0; m < messages; ++m) {
            const bool ran = s < kRisk || r.outcome[m] == kSent || (s == kRisk && r.outcome[m] != kNone);
            if (!ran) continue;
            t.push_back(r.ticks[m * kStageCount + s]);
            for (int k = 0; k < kCounterCount; ++k) c[k] += r.counts[(m * kStageCount + s) * kCounterCount + k];
        }
        std::printf("  %-8s %10.1f %10.1f %10.1f", stages[s], percentile(t, 0.5) / ghz, percentile(t, 0.99) / ghz,
                    t.empty() ? 0.0 : *std::max_element(t.begin(), t.end()) / ghz);
        if (counters)
            std::printf(" %9llu %9llu %9llu %9llu", (unsigned long long)c[0], (unsigned long long)c[1],
                        (unsigned long long)c[2], (unsigned long long)c[3]);
        std::printf("\n");
    }
}

}  // namespace

int main(int argc, char** argv) {
    const Options opt = parse(argc, argv);
    if (opt.cpu >= 0 && !pin_to_cpu(opt.cpu)) std::fprintf(stderr, "warning: could not pin to cpu %d\n", opt.cpu);

    FeedOptions fo;
    fo.max_messages = opt.max_messages;
    const Feed feed = load_feed(opt.input, fo);
    const size_t n = feed.message_count();
    if (n == 0) {
        std::fprintf(stderr, "no messages in %s\n", opt.input.c_str());
        return 1;
    }
    std::printf("feed: %zu messages in %zu MoldUDP64 packets\n", n, feed.packets.size());

    const double tick_ghz = calibrate_tsc_ghz();
    const bool average = opt.average || timer_is_coarse(tick_ghz);
    const Timing tm{average, opt.repeat > 0 ? opt.repeat : (average ? 25 : 3), measure_probe_overhead(),
                    measure_mean_overhead(), tick_ghz};
    // Recorded ticks per nanosecond: timer ticks normally, picoseconds when averaging.
    const double ghz = average ? kPicosPerNs : tick_ghz;
    std::printf("timer: %.3f ticks/ns (%.2f ns a tick), probe overhead %.2f ticks\n", tick_ghz, 1 / tick_ghz,
                tm.mean_overhead);
    if (average)
        std::printf("timing: averaging %d passes per message%s\n", tm.repeat,
                    timer_is_coarse(tick_ghz) ? ", since one tick is longer than most stages" : "");
    else
        std::printf("timing: fastest of %d passes per message\n", tm.repeat);

    Recording naive = timed<NaiveLane>(feed, tm);
    Recording tuned = timed<TunedLane>(feed, tm, size_t(22));

    uint32_t flags = 0;
    if (opt.counters) {
        PmcSet pmc;
        const char* err = "";
        if (pmc.open(&err)) {
            flags |= kCountersMeasured;
            if (pmc.uses_rdpmc()) flags |= kCountersRdpmc;
            counted<NaiveLane>(feed, pmc, naive);
            counted<TunedLane>(feed, pmc, tuned, size_t(22));
            std::printf("counters: measured via %s\n", pmc.uses_rdpmc() ? "rdpmc" : "read()");
        } else {
            std::printf("counters: unavailable (%s); the viewer will infer stalls from timing\n", err);
        }
    }

    size_t mismatches = 0;
    for (size_t i = 0; i < n; ++i) mismatches += naive.outcome[i] != tuned.outcome[i];
    if (mismatches) std::fprintf(stderr, "warning: lanes disagree on %zu messages\n", mismatches);

    const uint16_t hero = pick_hero(feed, opt.hero);
    std::vector<BookEvent> book = hero_book_events(feed, hero);

    const uint32_t hero_message = opt.hero_message >= 0 ? uint32_t(opt.hero_message)
                                                        : pick_hero_message(feed, hero, naive, tuned, ghz);

    size_t sent = 0;
    for (size_t i = 0; i < n; ++i) sent += tuned.outcome[i] == kSent;
    std::printf("hero: %s (locate %u), %zu book events, hero message %d, %zu orders sent\n",
                feed.symbols[hero].c_str(), hero, book.size(), hero_message == ~0u ? -1 : int(hero_message), sent);

    const bool counters = flags & kCountersMeasured;
    summarise("naive", naive, n, ghz, counters);
    summarise("tuned", tuned, n, ghz, counters);

    TraceInput in{&feed, {&naive, &tuned}, {"naive", "tuned"}, std::move(book), flags, ghz, hero, hero_message};
    write_trace(opt.output, in);
    std::printf("\nwrote %s\n", opt.output.c_str());
    return mismatches ? 3 : 0;
}

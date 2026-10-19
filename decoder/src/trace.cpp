#include "trace.hpp"

#include <cstdio>
#include <cstring>
#include <stdexcept>

namespace {

class Writer {
public:
    explicit Writer(const std::string& path) : f_(std::fopen(path.c_str(), "wb")) {
        if (!f_) throw std::runtime_error("cannot write " + path);
    }
    ~Writer() { std::fclose(f_); }
    template <class T>
    void put(const T& v) { raw(&v, sizeof v); }
    void raw(const void* p, size_t n) {
        if (n && std::fwrite(p, 1, n, f_) != n) throw std::runtime_error("short write");
        written_ += n;
    }
    void pad_to(size_t align) {
        static const uint8_t zeros[16] = {};
        while (written_ % align) raw(zeros, 1);
    }
    size_t written() const { return written_; }

private:
    FILE* f_;
    size_t written_ = 0;
};

}  // namespace

void write_trace(const std::string& path, const TraceInput& in) {
    const Feed& feed = *in.feed;
    const uint32_t messages = uint32_t(feed.message_count());
    Writer w(path);

    uint8_t header[128] = {};
    std::memcpy(header, "MMTRACE1", 8);
    auto put32 = [&](int off, uint32_t v) { std::memcpy(header + off, &v, 4); };
    put32(8, 1);
    put32(12, uint32_t(in.lanes.size()));
    put32(16, kStageCount);
    put32(20, in.flags);
    std::memcpy(header + 24, &in.tsc_ghz, 8);
    put32(32, messages);
    put32(36, uint32_t(feed.packets.size()));
    put32(40, uint32_t(in.book.size()));
    put32(44, in.hero_message);
    std::memset(header + 48, ' ', 8);
    const std::string& hero = feed.symbols[in.hero_locate];
    std::memcpy(header + 48, hero.data(), hero.size() < 8 ? hero.size() : 8);
    std::memcpy(header + 56, &in.hero_locate, 2);
    uint32_t symbol_count = 0;
    for (const auto& s : feed.symbols) symbol_count += !s.empty();
    put32(60, symbol_count);
    put32(96, in.ring_slots);
    for (size_t i = 0; i < in.lane_names.size() && i < 2; ++i)
        std::memcpy(header + 64 + i * 16, in.lane_names[i].data(), in.lane_names[i].size() < 15 ? in.lane_names[i].size() : 15);
    w.raw(header, sizeof header);

    uint32_t first = 0;
    for (const Packet& p : feed.packets) {
        w.put(p.arrival_ns);
        w.put(first);
        w.put(p.count);
        w.put(uint16_t(p.length));
        first += p.count;
    }

    for (uint32_t i = 0; i < messages; ++i) {
        w.put(feed.msg_packet[i]);
        w.put(feed.msg_type[i]);
        w.put(uint8_t(feed.msg_locate[i] == in.hero_locate ? 1 : 0));
        w.put(feed.msg_locate[i]);
    }

    for (const Recording* r : in.lanes) {
        w.raw(r->ticks.data(), r->ticks.size() * sizeof(uint32_t));
        if (in.flags & kCountersMeasured) w.raw(r->counts.data(), r->counts.size() * sizeof(uint16_t));
        w.raw(r->outcome.data(), r->outcome.size());
        w.pad_to(4);
    }

    for (const BookEvent& e : in.book) {
        w.put(e.message);
        w.put(e.kind);
        w.put(e.side);
        w.put(uint16_t(0));
        w.put(e.price);
        w.put(e.qty);
    }

    for (size_t loc = 0; loc < feed.symbols.size(); ++loc) {
        const std::string& s = feed.symbols[loc];
        if (s.empty()) continue;
        char name[8];
        std::memset(name, ' ', 8);
        std::memcpy(name, s.data(), s.size() < 8 ? s.size() : 8);
        w.put(uint16_t(loc));
        w.raw(name, 8);
    }
}

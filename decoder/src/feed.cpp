#include "feed.hpp"

#include <cstdio>
#include <stdexcept>

#include "itch.hpp"

namespace {

std::vector<uint8_t> read_file(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) throw std::runtime_error("cannot open " + path);
    std::vector<uint8_t> out;
    uint8_t buf[1 << 16];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.insert(out.end(), buf, buf + n);
    std::fclose(f);
    return out;
}

void put_be16(std::vector<uint8_t>& v, uint16_t x) {
    v.push_back(uint8_t(x >> 8));
    v.push_back(uint8_t(x));
}

void put_be64(std::vector<uint8_t>& v, uint64_t x) {
    for (int i = 7; i >= 0; --i) v.push_back(uint8_t(x >> (i * 8)));
}

std::string trim_symbol(const uint8_t* p) {
    std::string s(reinterpret_cast<const char*>(p), 8);
    while (!s.empty() && s.back() == ' ') s.pop_back();
    return s;
}

}  // namespace

Feed load_feed(const std::string& path, const FeedOptions& opt) {
    const std::vector<uint8_t> raw = read_file(path);
    Feed feed;
    feed.symbols.resize(65536);
    feed.bytes.reserve(raw.size() + raw.size() / 8);

    uint64_t seq = 1;
    size_t packet_start = 0;
    uint16_t packet_count = 0;
    uint64_t last_ts = 0;

    auto close_packet = [&] {
        if (packet_count == 0) return;
        uint8_t* hdr = feed.bytes.data() + packet_start;
        hdr[18] = uint8_t(packet_count >> 8);
        hdr[19] = uint8_t(packet_count);
        Packet p;
        p.offset = uint32_t(packet_start);
        p.length = uint32_t(feed.bytes.size() - packet_start);
        p.arrival_ns = last_ts;
        p.count = packet_count;
        feed.packets.push_back(p);
        seq += packet_count;
        packet_count = 0;
    };

    auto open_packet = [&] {
        packet_start = feed.bytes.size();
        const char session[10] = {'M', 'M', 'D', 'A', 'T', 'A', '0', '0', '0', '1'};
        feed.bytes.insert(feed.bytes.end(), session, session + 10);
        put_be64(feed.bytes, seq);
        put_be16(feed.bytes, 0);
    };

    size_t pos = 0;
    while (pos + 2 <= raw.size()) {
        const uint16_t len = itch::be16(raw.data() + pos);
        if (len == 0 || pos + 2 + len > raw.size()) break;
        const uint8_t* m = raw.data() + pos + 2;
        pos += 2 + len;
        if (len < itch::kHeader) continue;

        const uint64_t ts = itch::timestamp(m);
        const size_t current = packet_count ? feed.bytes.size() - packet_start : 0;
        const bool split = packet_count == 0 || current + 2 + len > opt.max_packet_bytes ||
                           ts > last_ts + opt.max_gap_ns || packet_count == 0xffff;
        if (split) {
            close_packet();
            open_packet();
        }
        put_be16(feed.bytes, len);
        feed.bytes.insert(feed.bytes.end(), m, m + len);
        ++packet_count;
        last_ts = ts;

        const char type = char(m[0]);
        const uint16_t loc = itch::locate(m);
        if (type == 'R' && len >= 19) feed.symbols[loc] = trim_symbol(m + itch::off::kStock);
        uint64_t ref = 0;
        if (len >= 19 && (type == 'A' || type == 'F' || type == 'E' || type == 'C' || type == 'X' ||
                          type == 'D' || type == 'U' || type == 'P'))
            ref = itch::be64(m + itch::off::kRef);

        feed.msg_packet.push_back(uint32_t(feed.packets.size()));
        feed.msg_ts.push_back(ts);
        feed.msg_locate.push_back(loc);
        feed.msg_type.push_back(uint8_t(type));
        feed.msg_ref.push_back(ref);

        if (opt.max_messages && feed.msg_ts.size() >= opt.max_messages) break;
    }
    close_packet();
    return feed;
}

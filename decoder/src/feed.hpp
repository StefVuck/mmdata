#pragma once

#include <cstdint>
#include <string>
#include <vector>

// The historical ITCH file is a stream of length-prefixed messages. We repackage it into
// MoldUDP64 packets, as it would arrive on the wire, so the decoder sees real framing.
constexpr int kMoldHeader = 20;  // session[10] sequence[8] count[2]

struct Packet {
    uint32_t offset;
    uint32_t length;
    uint64_t arrival_ns;  // ns since midnight, the timestamp of the last message it carries
    uint16_t count;
};

struct Feed {
    std::vector<uint8_t> bytes;
    std::vector<Packet> packets;
    std::vector<uint32_t> msg_packet;
    std::vector<uint64_t> msg_ts;
    std::vector<uint16_t> msg_locate;
    std::vector<uint8_t> msg_type;
    std::vector<uint64_t> msg_ref;
    std::vector<std::string> symbols;  // indexed by stock locate

    size_t message_count() const { return msg_ts.size(); }
};

struct FeedOptions {
    size_t max_messages = 0;
    size_t max_packet_bytes = 1400;
    uint64_t max_gap_ns = 500;
};

Feed load_feed(const std::string& path, const FeedOptions& opt);

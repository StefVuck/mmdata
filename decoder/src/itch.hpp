#pragma once

#include <cstdint>
#include <cstring>

// Nasdaq TotalView-ITCH 5.0. Offsets are from the start of the message (the type byte).
namespace itch {

inline uint16_t be16(const uint8_t* p) { uint16_t v; std::memcpy(&v, p, 2); return __builtin_bswap16(v); }
inline uint32_t be32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return __builtin_bswap32(v); }
inline uint64_t be64(const uint8_t* p) { uint64_t v; std::memcpy(&v, p, 8); return __builtin_bswap64(v); }
inline uint64_t be48(const uint8_t* p) { return (uint64_t(be16(p)) << 32) | be32(p + 2); }

inline uint16_t locate(const uint8_t* m) { return be16(m + 1); }
inline uint64_t timestamp(const uint8_t* m) { return be48(m + 5); }

constexpr int kHeader = 11;

namespace off {
constexpr int kStock = 11;          // R: stock directory
constexpr int kRef = 11;            // A F E C X D P
constexpr int kAddSide = 19;
constexpr int kAddShares = 20;
constexpr int kAddStock = 24;
constexpr int kAddPrice = 32;
constexpr int kExecShares = 19;     // E C
constexpr int kExecPrice = 32;      // C
constexpr int kCancelShares = 19;   // X
constexpr int kReplaceNewRef = 19;  // U
constexpr int kReplaceShares = 27;
constexpr int kReplacePrice = 31;
}  // namespace off

// Price is an integer in units of 1/10000 dollar.
constexpr uint32_t kTick = 100;

}  // namespace itch

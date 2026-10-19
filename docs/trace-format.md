# Trace format

`mmdecode` writes a single little-endian binary file that the viewer loads as `trace.bin`. It is laid out in columns so the browser can wrap most sections in typed arrays without copying. Sections follow each other with no gaps except where padding is noted.

## Header (128 bytes)

| Offset | Type | Field |
|---|---|---|
| 0 | char[8] | magic, `MMTRACE1` |
| 8 | u32 | version, currently 1 |
| 12 | u32 | lane count (2: naive, tuned) |
| 16 | u32 | stage count (6: frame, decode, book, signal, risk, encode) |
| 20 | u32 | flags: bit 0 counters measured, bit 1 counters read with `rdpmc` |
| 24 | f64 | TSC frequency in GHz, used to turn ticks into nanoseconds |
| 32 | u32 | message count *M* |
| 36 | u32 | packet count *P* |
| 40 | u32 | book event count *B* |
| 44 | u32 | hero message index, or `0xffffffff` for none |
| 48 | char[8] | hero symbol, space padded |
| 56 | u16 | hero stock locate |
| 60 | u32 | symbol count *Y* |
| 64 | char[16] | lane 0 name |
| 80 | char[16] | lane 1 name |
| 96 | u32 | ring buffer size in packets, 0 for unbounded |
| 100 | | reserved, zero |

## Packets (*P* × 16 bytes)

Each MoldUDP64 packet the feed was split into: `u64` arrival time in nanoseconds since midnight (the exchange timestamp of the last message it carries), `u32` index of its first message, `u16` message count and `u16` packet length in bytes.

## Messages (*M* × 8 bytes)

`u32` packet index, `u8` ITCH message type (ASCII), `u8` flags (bit 0 set when the message is for the hero symbol) and `u16` stock locate.

## Lanes

For each lane in turn:

1. Ticks: *M* × stage count `u32`, message-major. TSC ticks spent in each stage with the probe overhead removed. A stage that did not run (risk and encode, unless the signal fired) is zero. Each value is the fastest of `--repeat` passes, which strips out interrupts and other noise.
2. Counters, present only when flag bit 0 is set: *M* × stage count × 4 `u16`, saturating at 65535. The four counters per stage are L1D read misses, LLC references, LLC misses and branch misses. On Intel an LLC reference is an L2 miss, so the viewer attributes `L1D − LLC ref` to L2, `LLC ref − LLC miss` to L3 and `LLC miss` to DRAM.
3. Outcome: *M* `u8`. 0 means no signal, 1 means the signal fired but risk rejected it, and 2 means an order was sent.
4. Zero padding up to a 4-byte boundary.

## Book events (*B* × 16 bytes)

The hero symbol's book, replayed by a plain reference implementation: `u32` message index, `u8` kind (0 a price level's quantity changed, 1 a trade printed), `u8` side (`B` or `S`), 2 bytes padding, `u32` price in 1/10000 dollars and `u32` quantity (the level's new total for kind 0, the shares traded for kind 1).

## Symbols (*Y* × 10 bytes)

`u16` stock locate followed by the symbol as `char[8]`, space padded, for every symbol in the stock directory.

# Microsecond in Slow Motion

Watch one market data packet become a trade.

This project follows a single Nasdaq TotalView-ITCH packet from the exchange's matching engine, down 100 metres of fibre, through a layer 1 switch and a network card, into a CPU core, and out again as an order. It runs as a Three.js film in five acts, and every nanosecond spent in our own software is measured, not animated.

The software part is real. `mmdecode` is a C++ ITCH decoder with two builds of the same trading pipeline side by side. The naive lane is the idiomatic version: polymorphic heap-allocated messages, `std::map` books keyed by strings, and orders built with `std::string`. The tuned lane is what a latency engineer would write: fixed-offset loads, a flat order table, best-first level arrays and a pre-filled order template. Both read the same feed and must reach the same decisions; the decoder warns and exits with a non-zero status if they ever disagree. Every stage of every message is timed with `rdtsc`, and where the machine allows it, hardware counters record the cache misses and branch mispredicts behind each stall.

## The five acts

1. **The exchange.** A data centre hall, the matching engine and the trade that starts it all. The execution leaves as a multicast packet.
2. **The fibre.** The camera rides alongside the pulse through the cross-connect, including the spool of extra fibre that exchanges use to give every firm the same cable length.
3. **The switch.** A layer 1 switch repeats the signal to every subscriber in five nanoseconds, while a conventional switch above it is still buffering the frame.
4. **The network card.** Light becomes current, the Ethernet, IP and UDP headers peel away, the ITCH messages spill out and are written over PCIe straight into a ring buffer that one core spins on.
5. **The core.** The naive and tuned lanes process the same packet. Cache misses drop into wells whose depth is proportional to latency (L2, L3, DRAM); branch mispredicts shatter and rewind. The receipt along the bottom totals tick to trade for both lanes, and then free play hands the dilation slider to whoever is watching.

The slow-motion factor is always on screen. In Act V it runs from real time, where a burst at the open is a solid beam, down to a billion times slower, where individual stalls play out over seconds.

## Quick start

You need a C++17 compiler, CMake, Python 3 and Node 20 or later.

```sh
make            # builds the decoder, generates synthetic ITCH, writes web/public/trace.bin, builds the site
make dev        # serves the viewer at http://localhost:5173
```

A trace generated from the synthetic feed is committed in `web/public/trace.bin`, so `cd web && npm install && npx vite` is enough to look at it without building anything. Add `?trace=synthetic` to the URL for a trace generated in the browser that includes illustrative counter values, which is useful for seeing the branch-mispredict effect on a machine without hardware counters.

For recording a particular moment, `?act=5&beat=tuned&advance=4` opens Act V at the start of the named beat and fast-forwards four seconds; add `&hud=0` to hide the overlay. Beat names are in each act's script.

Keyboard controls: Space pauses, the arrow keys move between acts, 1 to 5 jump to an act, H hides the overlay for a clean recording, F toggles the follow camera, N jumps to the next order in free play, and R replays from the start.

## Using real Nasdaq data

Nasdaq publishes sample TotalView-ITCH 5.0 files covering full trading days. They are several gigabytes each, so cut out the window you want first. The slicer replays everything before the window to rebuild the live books, then writes those orders as Add Order messages ahead of the window, so the books are correct from the first message.

```sh
tools/fetch_itch.sh 01302019.NASDAQ_ITCH50.gz
python3 tools/slice_itch.py data/01302019.NASDAQ_ITCH50.gz --start 09:29:59.950 --ms 200 --out data/open.itch
make trace ITCH=data/open.itch DECODE_FLAGS="--hero AAPL --cpu 3"
```

Leave out `--symbols` on the slicer to keep the whole market, which gives a much better beam at real time. Slicing a full day in Python takes several minutes.

## How the measurements work

`mmdecode` repackages the historical file into MoldUDP64 packets, grouping messages that arrived within 500 ns of each other, so the decoder sees real framing. Each lane is run from a fresh start several times (`--repeat`, default 3) with `rdtsc` around every stage, and the fastest time for each message and stage is kept. The probe overhead, measured up front, is subtracted.

When `perf_event_open` is available, a separate pass reads four counters per stage with `rdpmc`: L1D read misses, LLC references, LLC misses and branch misses. Timing and counting are separate passes because reading counters perturbs the timing. The viewer converts the counts into stalls in the right level of the hierarchy. Where a stall happens within a stage, and how long each one is drawn, is illustrative: totals come from the hardware, but memory-level parallelism means misses overlap, so the drawn stalls are scaled to fit inside the measured stage time.

Without counters (in a VM or a container, or with `--no-counters`), the viewer infers stalls from how far each stage's time sits above that stage's typical time, and says so in the corner of the screen. Branch mispredicts cannot be inferred this way and are not shown.

The viewer schedules each lane as a single core: a message starts when it has arrived and the previous message has finished. Arrival times are the exchange timestamps from the feed. That is how the naive lane builds a queue during a burst while the tuned lane keeps up.

Everything outside our software (fibre, switch, network card, PCIe and the transmit path) uses typical published figures from `web/src/journey.js`. The receipt hatches those segments so nobody mistakes them for measurements. Change them to match your own setup.

For the cleanest numbers, run on bare metal with the decoder pinned to an isolated core (`--cpu`), and set `kernel.perf_event_paranoid` to 2 or lower so user-space counters are allowed.

## Layout

| Path | What it is |
|---|---|
| `decoder/` | `mmdecode`: feed loading, the two lanes, probes and the trace writer |
| `tools/` | synthetic ITCH generator, Nasdaq fetch and slice scripts |
| `web/src/acts/` | one module per act |
| `web/src/core/` | the Act V pipeline renderer and order book terrain |
| `web/src/timing.js` | turns a trace into per-lane schedules and stall events |
| `docs/trace-format.md` | the binary format the decoder writes and the viewer reads |

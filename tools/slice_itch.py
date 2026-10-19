#!/usr/bin/env python3
"""Cut a time window out of a full-day Nasdaq TotalView-ITCH 5.0 file.

A raw window is not enough on its own: executions and cancels in it refer to orders added
hours earlier. So the slicer replays everything before the window to rebuild the live books, emit those
live orders as Add Order messages just before the window opens, then copy the window verbatim.
The result decodes into correct books from its first message.

Example, 200 ms from the open for three symbols:
    python3 tools/slice_itch.py 01302019.NASDAQ_ITCH50.gz --start 09:29:59.950 --ms 200 \
        --symbols AAPL,MSFT,NVDA --out data/open.itch
Leave out --symbols to keep the whole market (much more data, much better beam).
"""

import argparse
import gzip
import struct
import sys
import time

BOOK_TYPES = b"AFECXDU"


def parse_clock(s):
    h, m, rest = s.split(":")
    sec = float(rest)
    return int((int(h) * 3600 + int(m) * 60) * 1e9 + round(sec * 1e9))


def read_messages(f):
    read = f.read
    while True:
        head = read(2)
        if len(head) < 2:
            return
        (n,) = struct.unpack(">H", head)
        body = read(n)
        if len(body) < n:
            return
        yield body


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="ITCH 5.0 file, optionally .gz")
    ap.add_argument("--start", default="09:29:59.950", help="window start, HH:MM:SS.fff")
    ap.add_argument("--ms", type=float, default=200, help="window length in milliseconds")
    ap.add_argument("--symbols", default="", help="comma separated; empty keeps every symbol")
    ap.add_argument("--out", default="data/slice.itch")
    args = ap.parse_args()

    start = parse_clock(args.start)
    end = start + int(args.ms * 1e6)
    wanted = {s.strip().upper() for s in args.symbols.split(",") if s.strip()}
    opener = gzip.open if args.input.endswith(".gz") else open

    keep = set()  # stock locates kept
    orders = {}  # ref -> [locate, side, shares, price, stock8]
    header_msgs = []
    window = []
    seen = 0
    t0 = time.time()

    with opener(args.input, "rb") as f:
        for m in read_messages(f):
            seen += 1
            if seen % 5_000_000 == 0:
                print(f"  {seen / 1e6:.0f}M messages, {len(orders)} live orders, {time.time() - t0:.0f}s",
                      file=sys.stderr)
            kind = m[0:1]
            locate = struct.unpack_from(">H", m, 1)[0]
            ts = int.from_bytes(m[5:11], "big")

            if kind == b"R":
                stock = m[11:19].decode().strip()
                if not wanted or stock in wanted:
                    keep.add(locate)
                    header_msgs.append(m)
                continue
            if kind == b"S" and ts < start:
                header_msgs.append(m)
                continue
            if ts >= end:
                break
            if locate and locate not in keep:
                continue
            if ts >= start:
                window.append(m)
                continue
            if kind not in BOOK_TYPES or not kind:
                continue

            ref = struct.unpack_from(">Q", m, 11)[0]
            if kind in b"AF":
                side, shares, stock, price = struct.unpack_from(">cI8sI", m, 19)
                orders[ref] = [locate, side, shares, price, stock]
            elif kind in b"ECX":
                o = orders.get(ref)
                if o:
                    o[2] -= struct.unpack_from(">I", m, 19)[0]
                    if o[2] <= 0:
                        del orders[ref]
            elif kind == b"D":
                orders.pop(ref, None)
            elif kind == b"U":
                o = orders.pop(ref, None)
                if o:
                    new_ref, shares, price = struct.unpack_from(">QII", m, 19)
                    orders[new_ref] = [o[0], o[1], shares, price, o[4]]

    snap_ts = start - 1000
    with open(args.out, "wb") as out:
        def emit(body):
            out.write(struct.pack(">H", len(body)) + body)

        for m in header_msgs:
            emit(m)
        for ref, (locate, side, shares, price, stock) in sorted(orders.items()):
            emit(struct.pack(">cHH", b"A", locate, 0) + snap_ts.to_bytes(6, "big")
                 + struct.pack(">QcI8sI", ref, side, shares, stock, price))
        for m in window:
            emit(m)

    print(f"read {seen} messages; wrote {len(header_msgs)} header, {len(orders)} snapshot adds, "
          f"{len(window)} window messages to {args.out}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate a synthetic ITCH 5.0 file around the 09:30 open.

The output uses the same length-prefixed framing as Nasdaq's historical files, so the decoder
cannot tell it apart. Tickers are invented. The order flow is shaped to look like an open:
a quiet pre-market, a burst at 09:30:00 that decays, clustered arrivals, level-clearing sweeps
and constant quote refreshes.
"""

import argparse
import bisect
import math
import random
import struct

OPEN_NS = 34200 * 1_000_000_000

SYMBOLS = [
    "NOVA", "ORCA", "KITE", "LUMA", "PRSM", "QBIT", "RAVN", "SOLR", "TIDE", "VELA",
    "WREN", "XENO", "YARD", "ZEST", "ARCX", "BOLT", "CRUX", "DUNE", "EMBR", "FERN",
    "GLYF", "HALO", "IRIS", "JADE", "KOAN", "LYNX", "MIRA", "NEXA", "OPAL", "PIKE",
]


class Writer:
    def __init__(self):
        self.out = bytearray()
        self.count = 0

    def emit(self, body):
        self.out += struct.pack(">H", len(body)) + body
        self.count += 1


def header(kind, locate, ts):
    return struct.pack(">cHH", kind.encode(), locate, 0) + ts.to_bytes(6, "big")


def stock8(sym):
    return sym.ljust(8).encode()


class Book:
    def __init__(self, sym, locate, mid_cents):
        self.sym = sym
        self.locate = locate
        self.mid = mid_cents
        self.levels = {"B": {}, "S": {}}  # price -> list of [ref, shares]
        self.orders = {}  # ref -> (side, price)

    def prices(self, side):
        return sorted(self.levels[side], reverse=(side == "B"))

    def best(self, side):
        p = self.prices(side)
        return p[0] if p else None


class Generator:
    def __init__(self, seed, scale):
        self.rng = random.Random(seed)
        self.w = Writer()
        self.next_ref = 1000
        self.scale = scale
        self.books = []
        self.surging = False
        weights = [1.0 / (i + 1) ** 0.9 for i in range(len(SYMBOLS))]
        total = sum(weights)
        self.cum = []
        acc = 0.0
        for wgt in weights:
            acc += wgt / total
            self.cum.append(acc)

    # Gaps between messages inside a burst; during the opening surge they tighten.
    def gap(self, lo, hi):
        g = self.rng.randint(lo, hi)
        return max(1, int(g * 0.12)) if self.surging else g

    def ref(self):
        self.next_ref += self.rng.randint(1, 4)
        return self.next_ref

    def lot(self):
        return 100 * min(20, 1 + int(self.rng.expovariate(0.45)))

    def add(self, b, side, price, ts):
        ref = self.ref()
        shares = self.lot()
        b.levels[side].setdefault(price, []).append([ref, shares])
        b.orders[ref] = (side, price)
        self.w.emit(header("A", b.locate, ts) + struct.pack(">Qc", ref, side.encode())
                    + struct.pack(">I", shares) + stock8(b.sym) + struct.pack(">I", price * 100))

    def remove_shares(self, b, ref, shares):
        side, price = b.orders[ref]
        queue = b.levels[side][price]
        for entry in queue:
            if entry[0] == ref:
                entry[1] -= shares
                if entry[1] <= 0:
                    queue.remove(entry)
                    del b.orders[ref]
                break
        if not queue:
            del b.levels[side][price]

    def shares_of(self, b, ref):
        side, price = b.orders[ref]
        for r, s in b.levels[side][price]:
            if r == ref:
                return s
        return 0

    def system(self, code, ts):
        self.w.emit(header("S", 0, ts) + code.encode())

    def directory(self, b, ts):
        body = (header("R", b.locate, ts) + stock8(b.sym) + b"QN" + struct.pack(">I", 100)
                + b"NCZ PN 1N" + struct.pack(">I", 0) + b"N")
        assert len(body) == 39
        self.w.emit(body)

    def near_touch_price(self, b, side):
        best = b.best(side)
        if best is None:
            best = b.mid - 1 if side == "B" else b.mid + 1
        depth = int(self.rng.expovariate(0.6))
        if self.rng.random() < 0.15:
            depth = -1  # improve the touch
        price = best - depth if side == "B" else best + depth
        other = b.best("S" if side == "B" else "B")
        if other is not None:
            price = min(price, other - 1) if side == "B" else max(price, other + 1)
        return max(1, price)

    def refill(self, b, ts):
        for side in "BS":
            while len(b.levels[side]) < 4:
                worst = b.prices(side)[-1] if b.levels[side] else (b.mid if side == "B" else b.mid)
                price = worst - 1 if side == "B" else worst + 1
                self.add(b, side, price, ts)
                ts += self.gap(30, 120)
        return ts

    def quote_refresh(self, b, ts):
        for _ in range(self.rng.randint(1, 6)):
            ts += self.gap(20, 250)
            side = self.rng.choice("BS")
            refs = [r for r, (s, _) in b.orders.items() if s == side]
            roll = self.rng.random()
            if refs and roll < 0.35:
                ref = self.rng.choice(refs)
                self.w.emit(header("D", b.locate, ts) + struct.pack(">Q", ref))
                self.remove_shares(b, ref, 10 ** 9)
            elif refs and roll < 0.5:
                ref = self.rng.choice(refs)
                have = self.shares_of(b, ref)
                if have > 100:
                    cut = 100 * self.rng.randint(1, have // 100 - 1) if have > 200 else 100
                    self.w.emit(header("X", b.locate, ts) + struct.pack(">QI", ref, cut))
                    self.remove_shares(b, ref, cut)
            elif refs and roll < 0.68:
                ref = self.rng.choice(refs)
                self.remove_shares(b, ref, 10 ** 9)
                new = self.ref()
                price = self.near_touch_price(b, side)
                shares = self.lot()
                b.levels[side].setdefault(price, []).append([new, shares])
                b.orders[new] = (side, price)
                self.w.emit(header("U", b.locate, ts) + struct.pack(">QQII", ref, new, shares, price * 100))
            else:
                self.add(b, side, self.near_touch_price(b, side), ts)
        return ts

    def sweep(self, b, ts):
        aggressor = self.rng.choice("BS")
        resting = "S" if aggressor == "B" else "B"
        want = self.lot() * self.rng.randint(1, 6)
        match = 10_000_000 + self.w.count
        while want > 0 and b.levels[resting]:
            price = b.best(resting)
            queue = b.levels[resting][price]
            ref, shares = queue[0]
            take = min(want, shares)
            match += 1
            self.w.emit(header("E", b.locate, ts) + struct.pack(">QIQ", ref, take, match))
            self.remove_shares(b, ref, take)
            want -= take
            ts += self.gap(5, 40)
        if b.levels["B"] and b.levels["S"]:
            b.mid = (b.best("B") + b.best("S")) // 2
        return self.refill(b, ts)

    def hidden_trade(self, b, ts):
        side = self.rng.choice("BS")
        price = b.mid
        self.w.emit(header("P", b.locate, ts) + struct.pack(">Qc", 0, side.encode())
                    + struct.pack(">I", self.lot()) + stock8(b.sym)
                    + struct.pack(">IQ", price * 100, 20_000_000 + self.w.count))
        return ts

    def rate(self, t_ns):
        t = t_ns / 1e9
        if t < 0:
            return 20_000 * self.scale
        # The opening cross and the first moments of continuous trading arrive as a surge.
        surge = 2_600_000 if t < 0.003 else 0
        return (40_000 + 220_000 * math.exp(-t / 0.05) + surge) * self.scale

    def run(self, pre_ms, post_ms):
        rng = self.rng
        t = OPEN_NS - int(pre_ms * 1e6) - 2_000_000
        self.system("O", t)
        for i, sym in enumerate(SYMBOLS):
            b = Book(sym, i + 1, rng.randint(1000, 30000))
            self.books.append(b)
            t += rng.randint(500, 2000)
            self.directory(b, t)
        for b in self.books:
            for side in "BS":
                for depth in range(10):
                    price = b.mid - 1 - depth if side == "B" else b.mid + 1 + depth
                    for _ in range(rng.randint(1, 3)):
                        t += rng.randint(200, 800)
                        self.add(b, side, price, t)

        t = OPEN_NS - int(pre_ms * 1e6)
        end = OPEN_NS + int(post_ms * 1e6)
        opened = False
        while t < end:
            if not opened and t >= OPEN_NS:
                self.system("Q", OPEN_NS)
                opened = True
            self.surging = 0 <= t - OPEN_NS < 3_000_000
            b = self.books[bisect.bisect_left(self.cum, rng.random())]
            roll = rng.random()
            if roll < 0.5:
                t = self.quote_refresh(b, t)
            elif roll < 0.72:
                t = self.quote_refresh(b, t)
                t = self.refill(b, t)
            elif roll < 0.86 or t < OPEN_NS:
                t = self.refill(b, t)
                for _ in range(rng.randint(1, 3)):
                    t += self.gap(20, 200)
                    self.add(b, rng.choice("BS"), self.near_touch_price(b, rng.choice("BS")), t)
            elif roll < 0.97:
                t = self.sweep(b, t)
            else:
                t = self.hidden_trade(b, t)
            t += int(rng.expovariate(self.rate(t - OPEN_NS) / 1e9)) + 1
        return self.w


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/synthetic.itch")
    ap.add_argument("--seed", type=int, default=930)
    ap.add_argument("--pre-ms", type=float, default=40)
    ap.add_argument("--post-ms", type=float, default=160)
    ap.add_argument("--scale", type=float, default=1.0, help="multiplies the message rate")
    args = ap.parse_args()

    w = Generator(args.seed, args.scale).run(args.pre_ms, args.post_ms)
    with open(args.out, "wb") as f:
        f.write(w.out)
    print(f"wrote {w.count} messages ({len(w.out)} bytes) to {args.out}")


if __name__ == "__main__":
    main()

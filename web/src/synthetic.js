// An illustrative trace generated in the browser, with plausible counter values. Used when no
// trace.bin is present, or with ?trace=synthetic. The HUD labels it as illustrative.

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = [['A', 0.36], ['D', 0.24], ['X', 0.08], ['U', 0.14], ['E', 0.13], ['C', 0.01], ['P', 0.04]];
// Per stage: [base ns, L1 miss rate, LLC ref rate, LLC miss rate, branch miss rate]
const PROFILE = [
  [[14, 0.3, 0.05, 0.01, 0.2], [45, 1.5, 0.3, 0.05, 0.6], [140, 6, 2.5, 0.6, 1.4],
   [6, 0.4, 0.1, 0.02, 0.3], [40, 2, 0.6, 0.1, 0.5], [150, 3, 0.5, 0.05, 1.2]],
  [[6, 0.05, 0.01, 0, 0.02], [15, 0.1, 0.02, 0, 0.08], [26, 1.2, 0.5, 0.12, 0.25],
   [4, 0.02, 0, 0, 0.05], [6, 0.1, 0.02, 0, 0.05], [13, 0.1, 0.02, 0, 0.03]],
];

function poisson(rng, mean) {
  if (mean <= 0) return 0;
  let k = 0, p = 1;
  const l = Math.exp(-mean);
  do { k++; p *= rng(); } while (p > l && k < 60);
  return k - 1;
}

export function syntheticTrace(seed = 930) {
  const rng = mulberry32(seed);
  const n = 30000;
  const S = 6;
  const ghz = 3.0;

  const packetArrival = [], packetFirst = [], packetCount = [], packetBytes = [];
  const msgPacket = new Uint32Array(n), msgType = new Uint8Array(n), msgHero = new Uint8Array(n), msgLocate = new Uint16Array(n);
  let t = 34200e9 - 20e6;
  let i = 0;
  while (i < n) {
    const sinceOpen = (t - 34200e9) / 1e9;
    const rate = sinceOpen < 0 ? 60e3 : 120e3 + 900e3 * Math.exp(-sinceOpen / 0.05);
    t += Math.max(30, -Math.log(1 - rng()) * (1e9 / rate));
    const count = Math.min(n - i, 1 + Math.floor(-Math.log(1 - rng()) * 2.2));
    packetArrival.push(Math.round(t));
    packetFirst.push(i);
    packetCount.push(count);
    packetBytes.push(20 + count * 36);
    for (let k = 0; k < count; k++, i++) {
      msgPacket[i] = packetArrival.length - 1;
      let r = rng(), type = 'A';
      for (const [ty, w] of TYPES) { if (r < w) { type = ty; break; } r -= w; }
      msgType[i] = type.charCodeAt(0);
      msgLocate[i] = rng() < 0.35 ? 1 : 2 + Math.floor(rng() * 40);
      msgHero[i] = msgLocate[i] === 1 ? 1 : 0;
    }
  }

  const outcome = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const ch = String.fromCharCode(msgType[k]);
    if ((ch === 'E' || ch === 'C') && rng() < 0.3) outcome[k] = rng() < 0.9 ? 2 : 1;
  }

  const lanes = PROFILE.map((profile, l) => {
    const ticks = new Uint32Array(n * S);
    const counts = new Uint16Array(n * S * 4);
    for (let k = 0; k < n; k++) {
      for (let s = 0; s < S; s++) {
        if (s >= 4 && (outcome[k] === 0 || (s === 5 && outcome[k] === 1))) continue;
        const [base, l1r, refr, missr, brr] = profile[s];
        const burst = rng() < 0.04 ? 4 : 1;
        const miss = poisson(rng, missr * burst);
        const ref = miss + poisson(rng, (refr - missr) * burst);
        const l1 = ref + poisson(rng, (l1r - refr) * burst);
        const br = poisson(rng, brr);
        const b = (k * S + s) * 4;
        counts[b] = l1; counts[b + 1] = ref; counts[b + 2] = miss; counts[b + 3] = br;
        const ns = base * (0.85 + 0.3 * rng()) + 0.7 * (miss * 90 + (ref - miss) * 14 + (l1 - ref) * 4) + br * 6;
        ticks[k * S + s] = Math.round(ns * ghz);
      }
    }
    return { name: l ? 'tuned' : 'naive', ticks, counts, outcome };
  });

  // A simple book for the hero symbol so the terrain has something to draw.
  const ev = { message: [], kind: [], side: [], price: [], qty: [] };
  const levels = [new Map(), new Map()];
  let mid = 1873400;
  const push = (m, kind, side, price, qty) => {
    ev.message.push(m); ev.kind.push(kind); ev.side.push(side.charCodeAt(0)); ev.price.push(price); ev.qty.push(qty);
  };
  for (let k = 0; k < n; k++) {
    if (!msgHero[k]) continue;
    const side = rng() < 0.5 ? 'B' : 'S';
    const lv = levels[side === 'B' ? 0 : 1];
    const ch = String.fromCharCode(msgType[k]);
    const dist = 1 + Math.floor(-Math.log(1 - rng()) * 4);
    const price = side === 'B' ? mid - dist * 100 : mid + dist * 100;
    if (ch === 'A' || ch === 'U') {
      const q = (lv.get(price) || 0) + 100 * (1 + Math.floor(rng() * 8));
      lv.set(price, q);
      push(k, 0, side, price, q);
    } else if (ch === 'D' || ch === 'X') {
      const q = Math.max(0, (lv.get(price) || 0) - 100 * (1 + Math.floor(rng() * 4)));
      lv.set(price, q);
      push(k, 0, side, price, q);
    } else if (ch === 'E' || ch === 'C' || ch === 'P') {
      const prices = [...lv.keys()].filter((p) => lv.get(p) > 0).sort((a, b) => (side === 'B' ? b - a : a - b));
      if (!prices.length) continue;
      const best = prices[0];
      const take = Math.min(lv.get(best), 100 * (1 + Math.floor(rng() * 6)));
      push(k, 1, side, best, take);
      lv.set(best, lv.get(best) - take);
      push(k, 0, side, best, lv.get(best));
      if (lv.get(best) === 0) mid += side === 'B' ? -100 : 100;
    }
  }

  let hero = -1;
  for (let k = Math.floor(n * 0.3); k < n && hero < 0; k++) if (msgHero[k] && outcome[k] === 2) hero = k;

  const symbols = new Map([[1, 'NOVA']]);
  const names = ['ORCA', 'KITE', 'LUMA', 'PRSM', 'QBIT', 'RAVN', 'SOLR', 'TIDE', 'VELA', 'WREN'];
  for (let k = 2; k < 42; k++) symbols.set(k, names[k % names.length] + (k > 11 ? String.fromCharCode(65 + (k % 26)) : ''));

  return {
    source: 'synthetic',
    flags: 1,
    counters: true,
    rdpmc: false,
    tscGhz: ghz,
    stageCount: S,
    messageCount: n,
    packetTotal: packetArrival.length,
    packetArrival: Float64Array.from(packetArrival),
    packetFirst: Uint32Array.from(packetFirst),
    packetCount: Uint16Array.from(packetCount),
    packetBytes: Uint16Array.from(packetBytes),
    msgPacket, msgType, msgHero, msgLocate,
    lanes,
    book: {
      message: Uint32Array.from(ev.message), kind: Uint8Array.from(ev.kind), side: Uint8Array.from(ev.side),
      price: Uint32Array.from(ev.price), qty: Uint32Array.from(ev.qty),
    },
    symbols,
    heroMessage: hero,
    heroSymbol: 'NOVA',
    heroLocate: 1,
  };
}

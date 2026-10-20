import { LEVELS, BRANCH_NS, WIRE } from './journey.js';

// Turns the trace into a single-core schedule per lane: each message starts when it has
// arrived and the previous message is done, then runs its stages back to back. Arrival times
// come from the exchange timestamps; service times are what the decoder measured.

export const KIND_L2 = 0;
export const KIND_L3 = 1;
export const KIND_DRAM = 2;
export const KIND_BRANCH = 3;
export const KIND_NS = [LEVELS[0].ns, LEVELS[1].ns, LEVELS[2].ns, BRANCH_NS];

export const SINK_NS = 40;
export const TX_NS = WIRE.txNs;

const MAX_EVENTS_PER_STAGE = 6;
const STALL_BUDGET = 0.8;

export const PHASE_NONE = 0;
export const PHASE_QUEUED = 1;
export const PHASE_STAGE = 2;
export const PHASE_SINK = 3;
export const PHASE_TX = 4;

function hash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function lowerBound(arr, x, n = arr.length) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

class LaneSchedule {
  constructor(timeline, index) {
    const trace = timeline.trace;
    const lane = trace.lanes[index];
    const n = trace.messageCount;
    const S = trace.stageCount;
    this.index = index;
    this.timeline = timeline;
    this.trace = trace;
    this.lane = lane;
    this.S = S;
    this.n = n;
    this.start = new Float64Array(n);
    this.done = new Float64Array(n);
    this.exit = new Float64Array(n);
    this.rel = new Float32Array(n * (S + 1));
    this.outcome = lane.outcome;
    this.cache = new Map();

    // Packets wait in a ring buffer of fixed size, as on the network card. One that arrives
    // while the ring is full is dropped: it never reaches the software at all.
    const k = 1 / trace.tscGhz;
    const slots = trace.ringSlots || 0;
    this.slots = slots;
    this.dropped = new Uint8Array(n);
    const ringIn = [], ringOut = [], dropAt = [], dropMsgs = [];
    let head = 0, prev = -Infinity, lastStart = -Infinity, droppedSoFar = 0;
    for (let p = 0; p < trace.packetTotal; p++) {
      const first = trace.packetFirst[p], count = trace.packetCount[p];
      const a = timeline.arrive[first];
      while (head < ringOut.length && ringOut[head] <= a) head++;
      if (slots && ringOut.length - head >= slots) {
        for (let i = first; i < first + count; i++) {
          this.dropped[i] = 1;
          this.start[i] = this.done[i] = this.exit[i] = lastStart === -Infinity ? a : lastStart;
        }
        droppedSoFar += count;
        dropAt.push(a);
        dropMsgs.push(droppedSoFar);
        continue;
      }
      for (let i = first; i < first + count; i++) {
        const s = Math.max(a, prev);
        this.start[i] = s;
        lastStart = s;
        let cum = 0;
        for (let st = 0; st < S; st++) {
          this.rel[i * (S + 1) + st] = cum;
          cum += lane.ticks[i * S + st] * k;
        }
        this.rel[i * (S + 1) + S] = cum;
        this.done[i] = s + cum;
        this.exit[i] = this.done[i] + (lane.outcome[i] === 2 ? TX_NS : SINK_NS);
        prev = this.done[i];
      }
      ringIn.push(a);
      ringOut.push(prev);
    }
    this.ringIn = Float64Array.from(ringIn);
    this.ringOut = Float64Array.from(ringOut);
    this.dropAt = Float64Array.from(dropAt);
    this.dropMsgs = Uint32Array.from(dropMsgs);
    this.end = prev + TX_NS;
    // exit[] is not monotonic because sent orders linger longer; keep a running max for search.
    this.exitMax = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) { m = Math.max(m, this.exit[i]); this.exitMax[i] = m; }

    this.baseline = trace.counters ? null : this.measureBaseline();
  }

  // Packets sitting in the ring at time t, and packets and messages dropped so far.
  ringDepth(t) {
    return lowerBound(this.ringIn, t + 1e-9) - lowerBound(this.ringOut, t + 1e-9);
  }

  droppedBy(t) {
    const k = lowerBound(this.dropAt, t + 1e-9);
    return { packets: k, messages: k ? this.dropMsgs[k - 1] : 0 };
  }

  stageNs(i, s) {
    const b = i * (this.S + 1) + s;
    return this.rel[b + 1] - this.rel[b];
  }

  measureBaseline() {
    const out = [];
    const stride = Math.max(1, Math.floor(this.n / 8000));
    for (let s = 0; s < this.S; s++) {
      const v = [];
      for (let i = 0; i < this.n; i += stride) {
        const d = this.stageNs(i, s);
        if (d > 0) v.push(d);
      }
      v.sort((a, b) => a - b);
      out.push(v.length ? v[Math.floor(v.length * 0.25)] : 0);
    }
    return out;
  }

  // Index of the message being processed at time t (or the last one finished).
  servingAt(t) {
    return lowerBound(this.start, t + 1e-9) - 1;
  }

  firstVisible(t) {
    return lowerBound(this.exitMax, t);
  }

  missCounts(i, s) {
    const c = this.lane.counts;
    const b = (i * this.S + s) * 4;
    const l1 = c[b], ref = c[b + 1], miss = c[b + 2], br = c[b + 3];
    return [Math.max(0, l1 - ref), Math.max(0, ref - miss), miss, br];
  }

  inferredCounts(i, s) {
    let excess = this.stageNs(i, s) - this.baseline[s];
    const counts = [0, 0, 0, 0];
    let guard = 0;
    while (excess >= 3 && guard++ < 12) {
      if (excess >= 70) { counts[KIND_DRAM]++; excess -= KIND_NS[KIND_DRAM]; }
      else if (excess >= 12) { counts[KIND_L3]++; excess -= KIND_NS[KIND_L3]; }
      else { counts[KIND_L2]++; excess -= KIND_NS[KIND_L2]; }
    }
    return counts;
  }

  // Stall events for one message, grouped by stage. Totals come from the counters (or are
  // inferred from timing); where inside the stage each one falls is illustrative.
  stalls(i) {
    let ev = this.cache.get(i);
    if (ev) return ev;
    if (this.cache.size > 30000) this.cache.clear();
    ev = [];
    for (let s = 0; s < this.S; s++) {
      const dur = this.stageNs(i, s);
      const list = [];
      ev.push(list);
      if (dur <= 0) continue;
      const counts = this.trace.counters ? this.missCounts(i, s) : this.inferredCounts(i, s);
      const items = [];
      let slots = MAX_EVENTS_PER_STAGE;
      for (const kind of [KIND_DRAM, KIND_L3, KIND_BRANCH, KIND_L2]) {
        const c = counts[kind];
        if (!c || slots <= 0) continue;
        const m = Math.min(c, slots, kind === KIND_DRAM ? 3 : 2);
        slots -= m;
        for (let j = 0; j < m; j++) items.push({ kind, count: c / m, ns: KIND_NS[kind] * (c / m) });
      }
      if (!items.length) continue;
      const nominal = items.reduce((a, x) => a + x.ns, 0);
      const scale = Math.min(1, (dur * STALL_BUDGET) / nominal);
      const stallTotal = nominal * scale;
      const compute = dur - stallTotal;
      for (let j = items.length - 1; j > 0; j--) {
        const r = Math.floor(hash(i, s, j) * (j + 1));
        [items[j], items[r]] = [items[r], items[j]];
      }
      let before = 0;
      const base = this.rel[i * (this.S + 1) + s];
      items.forEach((it, j) => {
        const frac = (j + 0.25 + 0.5 * hash(i, s, j + 17)) / items.length;
        const len = it.ns * scale;
        const t0 = base + frac * compute + before;
        list.push({ kind: it.kind, count: it.count, frac, t0, t1: t0 + len, len });
        before += len;
      });
    }
    this.cache.set(i, ev);
    return ev;
  }

  // Where message i is at time t. Fills and returns `out` to avoid allocating per frame.
  locate(i, t, out) {
    out.phase = PHASE_NONE;
    if (this.dropped[i]) return out;
    const arrive = this.timeline.arrive[i];
    if (t < arrive) return out;
    const start = this.start[i];
    if (t < start) {
      out.phase = PHASE_QUEUED;
      out.ahead = i - this.servingAt(t) - 1;
      return out;
    }
    const done = this.done[i];
    if (t >= done) {
      const exit = this.exit[i];
      if (t >= exit) return out;
      out.phase = this.outcome[i] === 2 ? PHASE_TX : PHASE_SINK;
      out.u = (t - done) / (exit - done);
      out.lastStage = this.outcome[i] === 0 ? 3 : this.outcome[i] === 1 ? 4 : 5;
      return out;
    }
    const r = t - start;
    const b = i * (this.S + 1);
    let s = 0;
    while (s < this.S - 1 && r >= this.rel[b + s + 1]) s++;
    const s0 = this.rel[b + s];
    const dur = this.rel[b + s + 1] - s0;
    out.phase = PHASE_STAGE;
    out.stage = s;
    out.event = null;
    out.u = 0;
    const events = this.stalls(i)[s];
    let stallBefore = 0, stallTotal = 0;
    for (const e of events) {
      stallTotal += e.len;
      if (r >= e.t1) stallBefore += e.len;
      else if (r >= e.t0) { out.event = e; out.u = (r - e.t0) / e.len; stallBefore += r - e.t0; }
    }
    const compute = dur - stallTotal;
    out.frac = compute > 0 ? Math.min(1, (r - s0 - stallBefore) / compute) : (r - s0) / Math.max(dur, 1e-9);
    if (out.event) out.frac = out.event.frac;
    return out;
  }
}

export class Timeline {
  constructor(trace) {
    this.trace = trace;
    const n = trace.messageCount;
    this.t0 = trace.packetArrival[0];
    this.arrive = new Float64Array(n);
    for (let i = 0; i < n; i++) this.arrive[i] = trace.packetArrival[trace.msgPacket[i]] - this.t0;
    this.lanes = trace.lanes.map((_, l) => new LaneSchedule(this, l));
    this.duration = Math.max(...this.lanes.map((l) => l.end));

    let hero = trace.heroMessage;
    if (hero < 0) hero = Math.floor(n * 0.4);
    this.hero = hero;
    this.heroPacket = trace.msgPacket[hero];
    this.heroPacketFirst = trace.packetFirst[this.heroPacket];
    this.heroPacketCount = trace.packetCount[this.heroPacket];
    this.heroArrive = this.arrive[hero];
    this.heroStats = this.lanes.map((ls) => {
      const stages = [];
      for (let s = 0; s < ls.S; s++) stages.push(ls.stageNs(hero, s));
      return {
        queue: ls.start[hero] - this.heroArrive,
        stages,
        start: ls.start[hero],
        done: ls.done[hero],
      };
    });

    this.openTime = 34200e9 - this.t0;
  }

  // Clock time for display: "09:30:00.012 345 678".
  clock(t) {
    const ns = Math.round(this.t0 + t);
    const sec = Math.floor(ns / 1e9);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const frac = String(ns % 1e9).padStart(9, '0');
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}.${frac.slice(0, 3)} ${frac.slice(3, 6)} ${frac.slice(6)}`;
  }
}

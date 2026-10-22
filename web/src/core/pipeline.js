import * as THREE from 'three';
import { glow, label, wireBox, solidBox, polyline, fmtNs } from '../fx.js';
import { LEVELS, STAGE_TITLES, TYPE_COLORS, LANE_COLORS } from '../journey.js';
import {
  KIND_L2, KIND_L3, KIND_DRAM, KIND_BRANCH, PHASE_NONE, PHASE_QUEUED, PHASE_STAGE, PHASE_SINK, PHASE_TX,
} from '../timing.js';

// Act V is laid out as a motherboard, seen from above. Distances are to scale with latency:
// one unit is one nanosecond of travel, so a stall is a real round trip to wherever the data
// lives. L2 sits beside the core (~2 units), L3 across the die (~7), and DRAM on the DIMMs
// out past the memory controller (~45).
export const TRACK_Y = 1.05;
const CORE_Z = [-5.5, 5.5];
const SIDE = [-1, 1];
const STAGE_X0 = -11.2;
const STAGE_PITCH = 2.5;
const STAGE_W = 2;
const L2_OFFSET = 2.2;
const L3_SLICES = Array.from({ length: 8 }, (_, k) => -10.5 + k * 2.8);
const IMC = new THREE.Vector3(12.5, 1.3, 0);
const DIMM_X = [34, 36.5, 39, 41.5];
const DIMM_HALF = 14;
const ROOT = new THREE.Vector3(-14.5, 1.3, 0);
const SLOT = new THREE.Vector3(-21, 1.2, 15);
const TRACE_Y = 0.05;
// The PCIe lanes on the board, which the outgoing order follows to the card.
const pcieTrace = (k, y = TRACE_Y) => [
  new THREE.Vector3(ROOT.x - 1, y, -1.5 + k * 0.4),
  new THREE.Vector3(ROOT.x - 2 - k * 0.3, y, -1.5 + k * 0.4),
  new THREE.Vector3(ROOT.x - 2 - k * 0.3, y, SLOT.z - 2.2 + k * 0.1),
  new THREE.Vector3(SLOT.x - 1 - k * 0.9, y, SLOT.z - 0.7),
];
export const NIC_PORT = new THREE.Vector3(-35, 2.2, 15);
const QUEUE_X = -11.4;
const QUEUE_STEP = 0.14;
const QUEUE_SHOWN = 150;
const SAMPLES = 5;
const MAX_HEADS = 9000;
const MAX_SEGS = 40000;
const MAX_FETCH = 600;
const MAX_PER_LANE = 900;

export const stageX = (s) => STAGE_X0 + s * STAGE_PITCH;

const typeColor = new Map();
function colorFor(code) {
  let c = typeColor.get(code);
  if (!c) {
    c = new THREE.Color(TYPE_COLORS[String.fromCharCode(code)] ?? TYPE_COLORS.default);
    typeColor.set(code, c);
  }
  return c;
}
const GOLD = new THREE.Color(0xffc44d);
const GREY = new THREE.Color(0x6f7d92);
const RED = new THREE.Color(0xff3b4f);
const WHITE = new THREE.Color(0xffffff);
const LEVEL_COLORS = LEVELS.map((l) => new THREE.Color(l.color));

function hash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Walks a polyline by distance; `lens` holds the cumulative length at each point.
function along(pts, lens, s, out) {
  const total = lens[lens.length - 1];
  s = Math.max(0, Math.min(total, s));
  let k = 1;
  while (k < pts.length - 1 && lens[k] < s) k++;
  const seg = lens[k] - lens[k - 1];
  return out.lerpVectors(pts[k - 1], pts[k], seg > 0 ? (s - lens[k - 1]) / seg : 0);
}

function lengths(pts) {
  const out = [0];
  for (let k = 1; k < pts.length; k++) out.push(out[k - 1] + pts[k].distanceTo(pts[k - 1]));
  return out;
}

export class Pipeline {
  constructor(timeline, scene) {
    this.timeline = timeline;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.laneVisible = [true, true];
    this.laneOffset = [0, 0];
    this.focus = timeline.hero;

    this.buildBoard();
    this.buildDie();
    this.buildMemory();
    this.buildIo();
    this.buildParticles();

    this.txPaths = CORE_Z.map((zc, lane) => {
      const side = SIDE[lane];
      const end = stageX(5) + STAGE_W;
      const edge = zc + side * 2.9;
      const pts = [
        new THREE.Vector3(end, TRACK_Y, zc),
        new THREE.Vector3(end + 0.7, TRACK_Y, edge),
        new THREE.Vector3(ROOT.x + 1.6, TRACK_Y, edge),
        new THREE.Vector3(ROOT.x + 1.6, TRACK_Y, side * 2.4),
        ROOT.clone(),
        ...pcieTrace(lane ? 5 : 2, 0.25),
        new THREE.Vector3(SLOT.x - 1 - (lane ? 5 : 2) * 0.9, 1.6, SLOT.z + 0.4),
        NIC_PORT.clone().setZ(SLOT.z + 0.4),
      ];
      return { pts, lens: lengths(pts) };
    });

    this.st = { phase: 0 };
    this.p = new THREE.Vector3();
    this.q = new THREE.Vector3();
    this.base = new THREE.Vector3();
    this.dest = new THREE.Vector3();
    this.mid = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.m = new THREE.Matrix4();
    this.quat = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    this.X = new THREE.Vector3(1, 0, 0);
    this.c = new THREE.Color();
    this.dramPts = [new THREE.Vector3(), IMC, new THREE.Vector3()];
    this.focusPos = [new THREE.Vector3(), new THREE.Vector3()];
    this.focusAlive = [false, false];
    this.focusState = [null, null];
  }

  addLabel(html, cls, x, y, z, centre) {
    const l = label(html, cls, true);
    l.position.set(x, y, z);
    if (centre) l.center.set(...centre);
    this.group.add(l);
    return l;
  }

  buildBoard() {
    const g = this.group;
    const board = new THREE.Mesh(new THREE.BoxGeometry(110, 0.2, 80),
      new THREE.MeshStandardMaterial({ color: 0x03140e, roughness: 0.75, metalness: 0.2 }));
    board.position.set(4, -0.1, 4);
    g.add(board);
    g.add(new THREE.HemisphereLight(0x8fb0e0, 0x020409, 1.2));

    // Decorative traces fill the board so it reads as a PCB rather than a void.
    const rnd = (k) => hash(k, 7, 11);
    for (let k = 0; k < 140; k++) {
      const x0 = -48 + rnd(k) * 104, z0 = -34 + rnd(k + 999) * 76;
      if (Math.abs(x0) < 18 && Math.abs(z0) < 14) continue;
      const dx = (rnd(k + 3) - 0.5) * 18, dz = (rnd(k + 5) - 0.5) * 12;
      g.add(polyline([new THREE.Vector3(x0, 0.04, z0), new THREE.Vector3(x0 + dx, 0.04, z0),
        new THREE.Vector3(x0 + dx + dz * 0.5, 0.04, z0 + dz)], 0x1f6f4a, 0.18));
    }
  }

  buildDie() {
    const g = this.group;
    const pkg = new THREE.Mesh(new THREE.BoxGeometry(34, 0.4, 26),
      new THREE.MeshStandardMaterial({ color: 0x0c1220, roughness: 0.5, metalness: 0.5, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
    pkg.position.set(-0.5, 0.2, 0);
    g.add(pkg);
    const die = solidBox(28, 0.15, 19, 0x5b8cff, { edge: 0.5, tint: 0.08 });
    die.position.set(-0.5, 0.475, 0);
    g.add(die);
    this.minor = [];
    this.minor.push(this.addLabel('CPU package', 'label', -16.5, 0.5, 13, [0, 0]));

    this.stations = [[], []];
    CORE_Z.forEach((zc, lane) => {
      const color = LANE_COLORS[lane];
      const side = SIDE[lane];
      const tile = solidBox(16.4, 0.15, 5.2, color, { edge: 0.5, tint: 0.1 });
      tile.position.set(-3.6, 0.625, zc);
      g.add(tile);
      for (let s = 0; s < 6; s++) {
        const box = wireBox(STAGE_W, 0.5, 1.3, color, 0.45, 0);
        box.position.set(stageX(s) + STAGE_W / 2, TRACK_Y, zc);
        g.add(box);
        this.stations[lane].push(box);
      }
      const l1 = solidBox(15, 0.1, 0.35, 0x3fd8ff, { edge: 0.45 });
      l1.position.set(-3.6, 0.75, zc + side * 1.0);
      g.add(l1);
      const l2 = solidBox(15, 0.3, 0.9, LEVELS[0].color, { edge: 0.6 });
      l2.position.set(-3.6, 0.85, zc + side * L2_OFFSET);
      g.add(l2);
      this.addLabel(`${lane ? 'Core 3 · tuned build' : 'Core 2 · naive build'}`, `label big ${lane ? 'tuned' : 'naive'}`,
        -12, 1.2, zc + side * 1.6, [1, 0.5]);
      const l2Label = this.addLabel('L2<span class="ns">~4 ns</span>', 'label level', 4.6, 0.9, zc + side * L2_OFFSET, [0, 0.5]);
      l2Label.element.style.color = '#4f9dff';
      const l1Label = this.addLabel('L1d<span class="ns">~1 ns</span>', 'label level', 4.6, 0.9, zc + side * 1.0, [0, 0.5]);
      l1Label.element.style.color = '#3fd8ff';
      this.minor.push(l2Label, l1Label);
      const q = this.addLabel('', `label ring ${lane ? 'tuned' : 'naive'}`, ROOT.x - 2.5, 1.3, side * 4, [1, 0.5]);
      this.stations[lane].queueLabel = q;
    });

    this.slices = L3_SLICES.map((x) => {
      const s = solidBox(2.3, 0.25, 3.2, LEVELS[1].color, { edge: 0.55 });
      s.position.set(x, 0.675, 0);
      this.group.add(s);
      return s;
    });
    this.addLabel('L3, shared<span class="ns">~14 ns · the ring buffer lands here</span>', 'label level', 2.5, 1.1, 0)
      .element.style.color = '#8a6bff';

    this.stageLabels = [];
    for (let s = 0; s < 6; s++) {
      const l = this.addLabel('', 'label', stageX(s) + STAGE_W / 2, 0.9, CORE_Z[1] + 3.6, [0.5, 0]);
      this.stageLabels.push(l);
    }
  }

  buildMemory() {
    const g = this.group;
    const imc = solidBox(2.2, 0.4, 7, 0xff4fd8, { edge: 0.7 });
    imc.position.copy(IMC).setY(0.75);
    g.add(imc);
    this.minor.push(this.addLabel('Memory controller', 'label', IMC.x, 1.4, 4.4, [0.5, 0]));
    DIMM_X.forEach((x, k) => {
      const dimm = solidBox(0.9, 3.2, DIMM_HALF * 2, 0xff4fd8, { edge: 0.55, tint: 0.1 });
      dimm.position.set(x, 1.6, 0);
      g.add(dimm);
      for (let c = 0; c < 9; c++) {
        const chip = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.2, 2.2), new THREE.MeshStandardMaterial({ color: 0x15101c, roughness: 0.6 }));
        chip.position.set(x, 1.5, -12 + c * 3);
        g.add(chip);
      }
      for (let lane = 0; lane < 6; lane++) {
        const z = -2.5 + lane;
        g.add(polyline([new THREE.Vector3(IMC.x + 1.1, TRACE_Y, z), new THREE.Vector3(20 + k, TRACE_Y, z),
          new THREE.Vector3(26 + k, TRACE_Y, z * (1 + k * 0.9)), new THREE.Vector3(x, TRACE_Y, z * (1 + k * 0.9))], 0xffc44d, 0.16));
      }
    });
    this.addLabel('DDR5 DIMMs<span class="ns">~90 ns away</span>', 'label level', DIMM_X[1] + 1.25, 3.8, -DIMM_HALF - 1)
      .element.style.color = '#ff4fd8';
  }

  buildIo() {
    const g = this.group;
    const root = solidBox(2, 0.4, 6, 0x3fd8ff, { edge: 0.7 });
    root.position.copy(ROOT).setY(0.75);
    g.add(root);
    this.minor.push(this.addLabel('PCIe root complex', 'label cyan', ROOT.x, 1.4, -4.2));
    for (let k = 0; k < 8; k++) {
      g.add(polyline(pcieTrace(k), 0x3fd8ff, k === 2 || k === 5 ? 0.45 : 0.2));
    }
    const slot = solidBox(16, 0.6, 1.2, 0x5b8cff, { edge: 0.5 });
    slot.position.set(SLOT.x - 6, 0.3, SLOT.z);
    g.add(slot);
    const card = solidBox(15, 4, 0.25, 0x3fffb0, { edge: 0.6, tint: 0.1 });
    card.position.set(SLOT.x - 6, 2.6, SLOT.z);
    g.add(card);
    const sfp = solidBox(1.6, 0.8, 1, 0x9fd8ff, { edge: 0.8 });
    sfp.position.copy(NIC_PORT);
    g.add(sfp);
    this.addLabel('Network card', 'label big', SLOT.x - 6, 5.4, SLOT.z);
    this.orderLabel = this.addLabel('', 'label gold', NIC_PORT.x, 3.4, NIC_PORT.z + 1.4);
    this.minor.push(this.orderLabel);
  }

  buildParticles() {
    const head = new THREE.IcosahedronGeometry(0.16, 1);
    this.heads = new THREE.InstancedMesh(head, glow(0xffffff, 1), MAX_HEADS);
    this.segs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow(0xffffff, 0.9), MAX_SEGS);
    this.fetch = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow(0xffffff, 0.5), MAX_FETCH);
    this.orders = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.32, 0), glow(0xffffff, 1), 400);
    for (const m of [this.heads, this.segs, this.fetch, this.orders]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, WHITE);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
    }
    // One marker per core, so the featured message can be picked out on both.
    this.halos = [0, 1].map((lane) => {
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), glow(LANE_COLORS[lane], 1, { side: THREE.DoubleSide }));
      halo.rotation.x = -Math.PI / 2;
      this.group.add(halo);
      const l = label('', `label hero ${lane ? 'tuned' : 'naive'}`);
      l.position.set(0, 0, lane ? 0.9 : -0.9);
      l.center.set(0.5, lane ? 0 : 1);
      halo.add(l);
      halo.userData.label = l;
      return halo;
    });
  }

  // Where a stall sends a message: the L2 beside its core, a slice of L3, or a DIMM.
  stallTarget(e, i, stage, baseX, lane, out) {
    const h = hash(i, stage, Math.round(e.t0 * 16));
    const zc = CORE_Z[lane];
    if (e.kind === KIND_L2) return out.set(baseX, 1.25, zc + SIDE[lane] * L2_OFFSET);
    if (e.kind === KIND_L3) {
      let k = 0;
      while (k < L3_SLICES.length - 1 && L3_SLICES[k + 1] < baseX) k++;
      k = Math.max(0, Math.min(L3_SLICES.length - 1, k + Math.round((h - 0.5) * 4)));
      return out.set(L3_SLICES[k], TRACK_Y, (hash(i, stage, 3) - 0.5) * 2.4);
    }
    return out.set(DIMM_X[Math.floor(h * DIMM_X.length)], 3.5, (hash(i, stage, 5) - 0.5) * (DIMM_HALF * 1.8));
  }

  // Position of message i in a lane at time t. Returns false when it isn't on screen.
  place(ls, lane, i, t, out) {
    const st = ls.locate(i, t, this.st);
    const zc = CORE_Z[lane];
    st.hidden = false;
    st.brightness = 1;
    st.scale = 1;
    st.away = false;
    switch (st.phase) {
      case PHASE_NONE:
        return false;
      case PHASE_QUEUED: {
        const k = Math.min(st.ahead, QUEUE_SHOWN);
        out.set(QUEUE_X + k * QUEUE_STEP, TRACK_Y, SIDE[lane] * (0.8 + (i % 3) * 0.2));
        st.scale = 0.6;
        st.brightness = 0.55;
        return true;
      }
      case PHASE_STAGE: {
        const base = this.base.set(stageX(st.stage) + st.frac * STAGE_W, TRACK_Y, zc);
        out.copy(base);
        const e = st.event;
        if (!e) return true;
        if (e.kind === KIND_BRANCH) {
          const g = st.u < 0.5 ? st.u * 2 : 0;
          out.x += g * 1.1;
          out.y += g * 1.2;
          st.hidden = st.u >= 0.5;
          return true;
        }
        // Out and back, lingering at the far end while the data arrives.
        const f = Math.sin(Math.PI * st.u);
        const dest = this.stallTarget(e, i, st.stage, base.x, lane, this.dest);
        if (e.kind === KIND_DRAM) {
          const pts = this.dramPts;
          pts[0].copy(base);
          pts[2].copy(dest);
          const l1 = base.distanceTo(IMC), l2 = IMC.distanceTo(dest);
          const s = f * (l1 + l2);
          if (s < l1) out.lerpVectors(base, IMC, s / l1);
          else out.lerpVectors(IMC, dest, (s - l1) / l2);
        } else {
          out.lerpVectors(base, dest, f);
        }
        st.away = true;
        return true;
      }
      case PHASE_SINK: {
        // Finished with nothing to do: shrinks to a grey dot where it ended and fades out.
        const x0 = stageX(st.lastStage) + STAGE_W;
        out.set(x0 + 0.3, TRACK_Y, zc);
        st.brightness = 0.8 * (1 - st.u);
        st.scale = 0.55 * (1 - st.u) + 0.15;
        return true;
      }
      case PHASE_TX: {
        const path = this.txPaths[lane];
        along(path.pts, path.lens, st.u * path.lens[path.lens.length - 1], out);
        st.brightness = st.u > 0.95 ? (1 - st.u) * 20 : 1;
        return true;
      }
    }
    return false;
  }

  segment(mesh, n, a, b, thickness, color) {
    this.dir.subVectors(b, a);
    const len = this.dir.length();
    if (len < 1e-3) return false;
    this.dir.divideScalar(len);
    this.mid.addVectors(a, b).multiplyScalar(0.5);
    this.quat.setFromUnitVectors(this.X, this.dir);
    this.scale.set(len, thickness, thickness);
    this.m.compose(this.mid, this.quat, this.scale);
    mesh.setMatrixAt(n, this.m);
    mesh.setColorAt(n, color);
    return true;
  }

  // laneOffset shifts one core's clock against the other, to replay them side by side.
  update(tIn, trailNs, wallTime) {
    const tl = this.timeline;
    let nh = 0, ns = 0, nf = 0, no = 0;
    const heads = this.heads, segs = this.segs, fetch = this.fetch;
    const p = this.p, q = this.q, c = this.c;
    let sentTotal = 0;

    for (let lane = 0; lane < tl.lanes.length; lane++) {
      this.focusAlive[lane] = false;
      this.focusState[lane] = null;
      if (!this.laneVisible[lane]) continue;
      const t = tIn + this.laneOffset[lane];
      const ls = tl.lanes[lane];
      const lo = ls.firstVisible(t - trailNs);
      let hi = 0;
      {
        let a = 0, b = tl.arrive.length;
        while (a < b) { const mid = (a + b) >> 1; if (tl.arrive[mid] <= t) a = mid + 1; else b = mid; }
        hi = a - 1;
      }
      const serving = ls.servingAt(t);
      const queued = Math.max(0, hi - serving);
      const visibleQueueEnd = Math.min(hi, serving + QUEUE_SHOWN + 40);
      const span = Math.max(0, Math.min(serving, hi) - lo + 1);
      const stride = Math.max(1, Math.ceil(span / MAX_PER_LANE));
      const drawn = span / stride;
      const detail = drawn < 400;
      // Many overlapping streaks would saturate, so dim each one as the crowd grows.
      const density = Math.min(1, 8 / Math.max(1, drawn));
      const S = ls.S;
      const times = this.times || (this.times = []);

      const draw = (i) => {
        const arrive = tl.arrive[i];
        const exit = ls.exit[i];
        const b = Math.min(t, exit);
        const a = Math.max(t - trailNs, arrive);
        if (b < a) return;
        const alive = b === t;
        const code = tl.trace.msgType[i];
        const isFocus = i === this.focus;
        const base = ls.outcome[i] === 2 && t > ls.done[i] ? GOLD : colorFor(code);
        // Sample at the message's own key moments so a long trail follows its real path
        // between the stations and out to memory instead of cutting corners.
        times.length = 0;
        times.push(b);
        if (b > a) {
          const add = (x) => { if (x > a && x < b) times.push(x); };
          const s0 = ls.start[i];
          const rb = i * (S + 1);
          add(s0);
          for (let s = 1; s <= S; s++) add(s0 + ls.rel[rb + s]);
          if (detail) {
            for (const list of ls.stalls(i)) {
              for (const e of list) {
                for (const f of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) add(s0 + e.t0 + e.len * f);
              }
            }
          }
          if (ls.outcome[i] === 2) {
            const lens = this.txPaths[lane].lens;
            const total = lens[lens.length - 1];
            const tx = ls.exit[i] - ls.done[i];
            for (const l of lens) add(ls.done[i] + (tx * l) / total);
          }
          for (let k = 1; k < SAMPLES; k++) add(b - ((b - a) * k) / SAMPLES);
          times.push(a);
          times.sort((x, y) => y - x);
        }
        let prevOk = false;
        for (let k = 0; k < times.length; k++) {
          const ts = times[k];
          const ok = this.place(ls, lane, i, ts, q);
          const st = this.st;
          if (ok && k === 0 && alive) {
            if (st.phase === PHASE_TX) {
              if (no < 400) {
                this.m.makeRotationY(wallTime * 3).setPosition(q);
                this.m.scale(this.scale.setScalar(isFocus ? 1.4 : 1));
                this.orders.setMatrixAt(no, this.m);
                this.orders.setColorAt(no++, c.copy(GOLD).multiplyScalar(1.6 * st.brightness));
              }
            } else if (!st.hidden && nh < MAX_HEADS) {
              const sc = (isFocus ? 1.5 : 1) * st.scale;
              this.m.makeScale(sc, sc, sc).setPosition(q);
              heads.setMatrixAt(nh, this.m);
              if (isFocus) c.copy(WHITE);
              else if (st.phase === PHASE_SINK) c.copy(GREY);
              else if (st.phase === PHASE_QUEUED) c.copy(base).lerp(GREY, 0.5);
              else c.copy(base);
              c.multiplyScalar((isFocus ? 1.6 : 1.4) * st.brightness);
              heads.setColorAt(nh++, c);
            }
            if (isFocus) {
              this.focusPos[lane].copy(q);
              this.focusAlive[lane] = true;
              this.focusState[lane] = {
                phase: st.phase,
                stage: st.phase === PHASE_STAGE ? st.stage : -1,
                kind: st.phase === PHASE_STAGE && st.event ? st.event.kind : null,
              };
            }
            if (st.phase === PHASE_STAGE && st.event) {
              const e = st.event;
              if (e.kind === KIND_BRANCH && st.u >= 0.5) {
                const r = (st.u - 0.5) * 2;
                for (let f = 0; f < 6 && nh < MAX_HEADS; f++) {
                  const ang = (f / 6) * Math.PI * 2;
                  const spread = 1 - r;
                  this.mid.set(q.x + 1.1 * spread + Math.cos(ang) * 0.5 * spread, q.y + 1.2 * spread + Math.sin(ang) * 0.5 * spread, q.z);
                  this.m.makeScale(0.35, 0.35, 0.35).setPosition(this.mid);
                  heads.setMatrixAt(nh, this.m);
                  heads.setColorAt(nh++, c.setRGB(1, 0.35, 0.3).multiplyScalar(1.6));
                }
              } else if (st.away && nf < MAX_FETCH) {
                // A tether back to the stage that is waiting on this data.
                if (this.segment(fetch, nf, this.base, q, 0.04, c.copy(LEVEL_COLORS[e.kind]).multiplyScalar(0.7))) nf++;
              }
            }
          }
          if (ok && prevOk && ns < MAX_SEGS && st.phase !== PHASE_QUEUED) {
            const age = (t - ts) / Math.max(trailNs, 1e-9);
            c.copy(isFocus ? WHITE : base).multiplyScalar((isFocus ? 1.2 : 1.2 * density) * Math.max(0, 1 - age) * st.brightness);
            if (p.distanceTo(q) < 80 && this.segment(segs, ns, p, q, isFocus ? 0.1 : 0.05, c)) ns++;
          }
          if (ok) p.copy(q);
          prevOk = ok;
        }
      };

      for (let i = lo; i <= Math.min(serving, hi); i += stride) draw(i);
      if (stride > 1 && this.focus >= lo && this.focus <= serving && (this.focus - lo) % stride) draw(this.focus);
      if (serving + 1 <= visibleQueueEnd) {
        for (let i = Math.max(serving + 1, lo); i <= visibleQueueEnd; i++) draw(i);
      }
      if (this.focus > visibleQueueEnd && this.focus <= hi) draw(this.focus);

      // Dropped packets fall off the ring buffer in red.
      if (ls.slots) {
        const show = Math.max(trailNs, 60);
        let a = 0, b = tl.arrive.length;
        while (a < b) { const mid = (a + b) >> 1; if (tl.arrive[mid] < t - show) a = mid + 1; else b = mid; }
        let drawn = 0;
        for (let i = a; i <= hi && drawn < 300; i++) {
          if (!ls.dropped[i]) continue;
          const u = (t - tl.arrive[i]) / show;
          q.set(QUEUE_X - 0.6 - u * 2.5 - (i % 5) * 0.15, TRACK_Y + 0.4 - u * u * 6, SIDE[lane] * (1.2 + (i % 3) * 0.3));
          const sc = 0.8 * (1 - u * 0.5);
          this.m.makeScale(sc, sc, sc).setPosition(q);
          if (nh < MAX_HEADS) {
            heads.setMatrixAt(nh, this.m);
            heads.setColorAt(nh++, c.copy(RED).multiplyScalar(1.8 * (1 - u)));
          }
          drawn++;
        }
      }

      const st = this.stations[lane];
      const depth = ls.slots ? ls.ringDepth(t) : queued;
      const lost = ls.slots ? ls.droppedBy(t) : { packets: 0, messages: 0 };
      const fill = ls.slots ? Math.min(1, depth / ls.slots) : 0;
      const qHtml = ls.slots
        ? `Ring buffer ${depth.toLocaleString()} / ${ls.slots.toLocaleString()} packets<div class="meter${fill >= 1 ? ' full' : ''}"><i style="width:${(fill * 100).toFixed(1)}%"></i></div>`
          + (lost.packets ? `<span class="dropped">dropped ${lost.packets.toLocaleString()} packets · ${lost.messages.toLocaleString()} messages</span>` : '')
        : (queued > 0 ? `queue ${queued.toLocaleString()}` : '');
      if (st.queueLabel.userData.html !== qHtml) {
        st.queueLabel.element.innerHTML = qHtml;
        st.queueLabel.userData.html = qHtml;
      }
      {
        let a = 0, b = ls.done.length;
        while (a < b) { const mid = (a + b) >> 1; if (ls.done[mid] <= t) a = mid + 1; else b = mid; }
        if (lane === 1) sentTotal = this.sentBefore(lane, a);
      }
      const cur = serving >= 0 && serving < ls.n && t < ls.done[serving] ? serving : -1;
      for (let s = 0; s < st.length; s++) {
        let active = false;
        if (cur >= 0) {
          const r = t - ls.start[cur];
          const rb = cur * (ls.S + 1);
          active = r >= ls.rel[rb + s] && r < ls.rel[rb + s + 1];
        }
        st[s].userData.edges.material.opacity = active ? 1 : 0.4;
      }
    }

    heads.count = nh;
    segs.count = ns;
    fetch.count = nf;
    this.orders.count = no;
    for (const m of [heads, segs, fetch, this.orders]) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }

    const orders = `Orders out (tuned)<span class="ns">${sentTotal.toLocaleString()}</span>`;
    if (this.orderLabel.element.innerHTML !== orders) this.orderLabel.element.innerHTML = orders;

    this.halos.forEach((halo, lane) => {
      halo.visible = this.focusAlive[lane];
      if (!halo.visible) return;
      halo.position.copy(this.focusPos[lane]);
      halo.scale.setScalar(1 + 0.15 * Math.sin(wallTime * 6));
    });
    this.updateStageLabels();
  }

  sentBefore(lane, idx) {
    if (!this.sentPrefix) {
      this.sentPrefix = this.timeline.lanes.map((ls) => {
        const a = new Uint32Array(ls.n + 1);
        for (let i = 0; i < ls.n; i++) a[i + 1] = a[i] + (ls.outcome[i] === 2 ? 1 : 0);
        return a;
      });
    }
    return this.sentPrefix[lane][idx];
  }

  // Phones get the scene without the clutter: no minor labels, no per-stage timers.
  setCompact(on, showRings = true) {
    this.compact = on;
    for (const l of this.minor) l.visible = !on;
    for (const l of this.stageLabels) l.visible = !on;
    for (const st of this.stations) st.queueLabel.visible = !on || showRings;
  }

  updateStageLabels() {
    const tl = this.timeline;
    const f = this.focus;
    this.stageLabels.forEach((l, s) => {
      if (this.compact) {
        const html = STAGE_TITLES[s];
        if (l.userData.html !== html) { l.element.innerHTML = html; l.userData.html = html; }
        return;
      }
      const parts = tl.lanes.map((ls, lane) => {
        const d = ls.stageNs(f, s);
        return `<span style="color:${lane ? 'var(--tuned)' : 'var(--naive)'}">${d > 0 ? fmtNs(d) : '·'}</span>`;
      });
      const html = `${STAGE_TITLES[s]}<span class="ns">${parts.join(' &nbsp;')}</span>`;
      if (l.userData.html !== html) {
        l.element.innerHTML = html;
        l.userData.html = html;
      }
    });
    const type = String.fromCharCode(tl.trace.msgType[f]);
    const sym = tl.trace.symbols.get(tl.trace.msgLocate[f]) || '';
    const what = f === tl.hero ? `Featured · ${type} · ${sym}` : `${type} · ${sym}`;
    this.halos.forEach((halo, lane) => {
      const text = `${what} · ${lane ? 'tuned' : 'naive'}`;
      const el = halo.userData.label.element;
      if (el.textContent !== text) el.textContent = text;
    });
  }
}

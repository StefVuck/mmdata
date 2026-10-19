import * as THREE from 'three';
import { glow, label, lineMaterial, wireBox, polyline, fmtNs } from '../fx.js';
import { LEVELS, STAGE_TITLES, TYPE_COLORS, LANE_COLORS } from '../journey.js';
import {
  KIND_L2, KIND_L3, KIND_DRAM, KIND_BRANCH, PHASE_NONE, PHASE_QUEUED, PHASE_STAGE, PHASE_SINK, PHASE_TX,
} from '../timing.js';

// Act V is laid out as a motherboard, seen from above. Distances are to scale with latency:
// one unit is one nanosecond of travel, so a stall is a real round trip to wherever the data
// lives. L2 sits beside the core (~2 units), L3 across the die (~7), and DRAM on the DIMMs
// out past the memory controller (~45).
export const TRACK_Y = 0.9;
const CORE_Z = [-5.5, 5.5];
const SIDE = [-1, 1];
const STAGE_X0 = -11.2;
const STAGE_PITCH = 2.5;
const STAGE_W = 2;
const L2_OFFSET = 2.2;
const L3_SLICES = Array.from({ length: 8 }, (_, k) => -10.5 + k * 2.8);
const IMC = new THREE.Vector3(12.5, TRACK_Y, 0);
const DIMM_X = [34, 36.5, 39, 41.5];
const DIMM_HALF = 14;
const ROOT = new THREE.Vector3(-14.5, TRACK_Y, 0);
const SLOT = new THREE.Vector3(-27, 1.2, 24);
export const NIC_PORT = new THREE.Vector3(-39, 2.2, 24);
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
    this.focus = timeline.hero;

    this.buildBoard();
    this.buildDie();
    this.buildMemory();
    this.buildIo();
    this.buildParticles();

    this.txPaths = CORE_Z.map((z) => {
      const end = stageX(5) + STAGE_W;
      const pts = [
        new THREE.Vector3(end, TRACK_Y, z),
        new THREE.Vector3(end + 0.8, TRACK_Y, z * 0.4),
        new THREE.Vector3(ROOT.x + 2, TRACK_Y, z * 0.15),
        ROOT.clone(),
        new THREE.Vector3(ROOT.x - 4, 0.3, ROOT.z + 6),
        SLOT.clone(),
        NIC_PORT.clone(),
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
      g.add(polyline([new THREE.Vector3(x0, 0.01, z0), new THREE.Vector3(x0 + dx, 0.01, z0),
        new THREE.Vector3(x0 + dx + dz * 0.5, 0.01, z0 + dz)], 0x1f6f4a, 0.18));
    }
  }

  buildDie() {
    const g = this.group;
    const pkg = new THREE.Mesh(new THREE.BoxGeometry(34, 0.4, 26),
      new THREE.MeshStandardMaterial({ color: 0x0c1220, roughness: 0.5, metalness: 0.5 }));
    pkg.position.set(-0.5, 0.2, 0);
    g.add(pkg);
    const die = wireBox(28, 0.2, 19, 0x5b8cff, 0.5, 0.03);
    die.position.set(-0.5, 0.5, 0);
    g.add(die);
    this.addLabel('CPU package', 'label', -16.5, 0.5, 13, [0, 0]);

    this.stations = [[], []];
    CORE_Z.forEach((zc, lane) => {
      const color = LANE_COLORS[lane];
      const side = SIDE[lane];
      const tile = wireBox(16.4, 0.3, 5.2, color, 0.45, 0.02);
      tile.position.set(-3.6, 0.65, zc);
      g.add(tile);
      for (let s = 0; s < 6; s++) {
        const box = wireBox(STAGE_W, 0.5, 1.3, color, 0.65, 0.02);
        box.position.set(stageX(s) + STAGE_W / 2, TRACK_Y, zc);
        g.add(box);
        this.stations[lane].push(box);
      }
      const l1 = wireBox(15, 0.12, 0.35, 0x3fd8ff, 0.35, 0.05);
      l1.position.set(-3.6, 0.75, zc + side * 1.0);
      g.add(l1);
      const l2 = wireBox(15, 0.35, 0.9, LEVELS[0].color, 0.6, 0.06);
      l2.position.set(-3.6, 0.8, zc + side * L2_OFFSET);
      g.add(l2);
      this.addLabel(`${lane ? 'Core 3 · tuned build' : 'Core 2 · naive build'}`, `label big ${lane ? 'tuned' : 'naive'}`,
        -12, 1.2, zc + side * 1.6, [1, 0.5]);
      this.addLabel('L2<span class="ns">~4 ns</span>', 'label level', 4.6, 0.9, zc + side * L2_OFFSET, [0, 0.5])
        .element.style.color = '#4f9dff';
      this.addLabel('L1d<span class="ns">~1 ns</span>', 'label level', 4.6, 0.9, zc + side * 1.0, [0, 0.5])
        .element.style.color = '#3fd8ff';
      const q = this.addLabel('', `label ${lane ? 'tuned' : 'naive'}`, QUEUE_X, 1.3, side * 1.0, [1, 0.5]);
      this.stations[lane].queueLabel = q;
    });

    this.slices = L3_SLICES.map((x) => {
      const s = wireBox(2.3, 0.3, 3.2, LEVELS[1].color, 0.55, 0.04);
      s.position.set(x, 0.75, 0);
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
    const imc = wireBox(2.2, 0.4, 7, 0xff4fd8, 0.7, 0.06);
    imc.position.copy(IMC).setY(0.8);
    g.add(imc);
    this.addLabel('Memory controller', 'label', IMC.x, 1.4, 4.4, [0.5, 0]);
    DIMM_X.forEach((x, k) => {
      const dimm = wireBox(0.9, 3.2, DIMM_HALF * 2, 0xff4fd8, 0.55, 0.03);
      dimm.position.set(x, 1.6, 0);
      g.add(dimm);
      for (let c = 0; c < 9; c++) {
        const chip = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.2, 2.2), new THREE.MeshStandardMaterial({ color: 0x15101c, roughness: 0.6 }));
        chip.position.set(x, 1.5, -12 + c * 3);
        g.add(chip);
      }
      for (let lane = 0; lane < 6; lane++) {
        const z = -2.5 + lane;
        g.add(polyline([new THREE.Vector3(IMC.x + 1.1, 0.02, z), new THREE.Vector3(20 + k, 0.02, z),
          new THREE.Vector3(26 + k, 0.02, z * (1 + k * 0.9)), new THREE.Vector3(x, 0.02, z * (1 + k * 0.9))], 0xffc44d, 0.16));
      }
    });
    this.addLabel('DDR5 DIMMs<span class="ns">~90 ns away</span>', 'label level', DIMM_X[1] + 1.25, 3.8, -DIMM_HALF - 1)
      .element.style.color = '#ff4fd8';
  }

  buildIo() {
    const g = this.group;
    const root = wireBox(2, 0.4, 6, 0x3fd8ff, 0.7, 0.06);
    root.position.copy(ROOT).setY(0.8);
    g.add(root);
    this.addLabel('PCIe root complex', 'label cyan', ROOT.x, 1.4, -4.2);
    for (let k = 0; k < 8; k++) {
      g.add(polyline([new THREE.Vector3(ROOT.x - 1, 0.02, -1.5 + k * 0.4), new THREE.Vector3(ROOT.x - 4 - k * 0.2, 0.02, 2 + k * 0.4),
        new THREE.Vector3(SLOT.x + 6, 0.02, SLOT.z - 1.4 + k * 0.4), new THREE.Vector3(SLOT.x, 0.02, SLOT.z - 1.4 + k * 0.4)], 0x3fd8ff, 0.2));
    }
    const slot = wireBox(16, 0.6, 1.2, 0x5b8cff, 0.5, 0.04);
    slot.position.set(SLOT.x - 6, 0.3, SLOT.z);
    g.add(slot);
    const card = wireBox(15, 4, 0.25, 0x3fffb0, 0.6, 0.04);
    card.position.set(SLOT.x - 6, 2.6, SLOT.z);
    g.add(card);
    const sfp = wireBox(1.6, 0.8, 1, 0x9fd8ff, 0.8, 0.08);
    sfp.position.copy(NIC_PORT);
    g.add(sfp);
    this.addLabel('Network card', 'label big', SLOT.x - 6, 5.4, SLOT.z);
    this.orderLabel = this.addLabel('', 'label gold', NIC_PORT.x, 3.4, NIC_PORT.z + 1.4);
  }

  buildParticles() {
    const head = new THREE.IcosahedronGeometry(0.16, 1);
    this.heads = new THREE.InstancedMesh(head, glow(0xffffff, 1), MAX_HEADS);
    this.segs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow(0xffffff, 0.9), MAX_SEGS);
    this.fetch = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow(0xffffff, 0.5), MAX_FETCH);
    for (const m of [this.heads, this.segs, this.fetch]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, WHITE);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
    }
    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), glow(0xffffff, 0.9, { side: THREE.DoubleSide }));
    this.halo.rotation.x = -Math.PI / 2;
    this.group.add(this.halo);
    this.focusLabel = label('', 'label hero');
    this.focusLabel.position.set(0, 0, -0.9);
    this.halo.add(this.focusLabel);
  }

  // Where a stall sends a message: the L2 beside its core, a slice of L3, or a DIMM.
  stallTarget(e, i, stage, baseX, lane, out) {
    const h = hash(i, stage, Math.round(e.t0 * 16));
    const zc = CORE_Z[lane];
    if (e.kind === KIND_L2) return out.set(baseX, TRACK_Y, zc + SIDE[lane] * L2_OFFSET);
    if (e.kind === KIND_L3) {
      let k = 0;
      while (k < L3_SLICES.length - 1 && L3_SLICES[k + 1] < baseX) k++;
      k = Math.max(0, Math.min(L3_SLICES.length - 1, k + Math.round((h - 0.5) * 4)));
      return out.set(L3_SLICES[k], TRACK_Y, (hash(i, stage, 3) - 0.5) * 2.4);
    }
    return out.set(DIMM_X[Math.floor(h * DIMM_X.length)], 2.2, (hash(i, stage, 5) - 0.5) * (DIMM_HALF * 1.8));
  }

  // Position of message i in a lane at time t. Returns false when it isn't on screen.
  place(ls, lane, i, t, out) {
    const st = ls.locate(i, t, this.st);
    const zc = CORE_Z[lane];
    st.hidden = false;
    st.brightness = 1;
    st.away = false;
    switch (st.phase) {
      case PHASE_NONE:
        return false;
      case PHASE_QUEUED: {
        const k = Math.min(st.ahead, QUEUE_SHOWN);
        out.set(QUEUE_X + k * QUEUE_STEP, TRACK_Y, SIDE[lane] * (0.8 + (i % 3) * 0.2));
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
        const x0 = stageX(st.lastStage) + STAGE_W;
        out.set(x0 + 0.2 + st.u * 0.5, TRACK_Y + st.u * st.u * 2.5, zc);
        st.brightness = 1 - st.u;
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

  update(t, trailNs, wallTime) {
    const tl = this.timeline;
    let nh = 0, ns = 0, nf = 0;
    const heads = this.heads, segs = this.segs, fetch = this.fetch;
    const p = this.p, q = this.q, c = this.c;
    let sentTotal = 0;

    for (let lane = 0; lane < tl.lanes.length; lane++) {
      this.focusAlive[lane] = false;
      this.focusState[lane] = null;
      if (!this.laneVisible[lane]) continue;
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
            if (!st.hidden && nh < MAX_HEADS) {
              const sc = isFocus ? 1.5 : 1;
              this.m.makeScale(sc, sc, sc).setPosition(q);
              heads.setMatrixAt(nh, this.m);
              c.copy(isFocus ? WHITE : base).multiplyScalar((isFocus ? 1.6 : 1.4) * st.brightness);
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

      const st = this.stations[lane];
      const qText = queued > 0 ? `queue ${queued.toLocaleString()}` : '';
      if (st.queueLabel.element.textContent !== qText) st.queueLabel.element.textContent = qText;
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
        st[s].userData.fill.material.opacity = active ? 0.12 : 0.02;
      }
    }

    heads.count = nh;
    segs.count = ns;
    fetch.count = nf;
    for (const m of [heads, segs, fetch]) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }

    const orders = `Orders out (tuned)<span class="ns">${sentTotal.toLocaleString()}</span>`;
    if (this.orderLabel.element.innerHTML !== orders) this.orderLabel.element.innerHTML = orders;

    const lane = this.focusAlive[1] ? 1 : this.focusAlive[0] ? 0 : -1;
    this.halo.visible = lane >= 0;
    if (lane >= 0) {
      this.halo.position.copy(this.focusPos[lane]);
      this.halo.scale.setScalar(1 + 0.15 * Math.sin(wallTime * 6));
    }
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

  updateStageLabels() {
    const tl = this.timeline;
    const f = this.focus;
    this.stageLabels.forEach((l, s) => {
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
    const text = f === tl.hero ? `Ours · ${type} · ${sym}` : `${type} · ${sym}`;
    if (this.focusLabel.element.textContent !== text) this.focusLabel.element.textContent = text;
  }
}

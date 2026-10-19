import * as THREE from 'three';
import { glow, label, lineMaterial, wireBox, fmtNs } from '../fx.js';
import { LEVELS, STAGE_TITLES, TYPE_COLORS, LANE_COLORS, LANE_TITLES } from '../journey.js';
import {
  KIND_BRANCH, KIND_NS, PHASE_NONE, PHASE_QUEUED, PHASE_STAGE, PHASE_SINK, PHASE_TX,
} from '../timing.js';

export const STAGE_PITCH = 7;
export const STAGE_W = 4.4;
export const LANE_Z = [-4.5, 4.5];
export const EGRESS_X = 46;
export const DEPTH_PER_NS = 0.55;
const QUEUE_X = -1.6;
const QUEUE_STEP = 0.3;
const QUEUE_SHOWN = 150;
const SAMPLES = 5;
const MAX_HEADS = 9000;
const MAX_SEGS = 40000;
const MAX_SHAFTS = 600;
const MAX_PER_LANE = 900;

export const stageX = (s) => s * STAGE_PITCH;
export const depthOf = (kind) => KIND_NS[kind] * DEPTH_PER_NS;

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

export class Pipeline {
  constructor(timeline, scene) {
    this.timeline = timeline;
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.laneVisible = [true, true];
    this.focus = timeline.hero;

    this.buildStrata();
    this.buildLanes();
    this.buildParticles();

    this.st = { phase: 0 };
    this.p = new THREE.Vector3();
    this.q = new THREE.Vector3();
    this.mid = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.m = new THREE.Matrix4();
    this.quat = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    this.X = new THREE.Vector3(1, 0, 0);
    this.c = new THREE.Color();
    this.focusPos = [new THREE.Vector3(), new THREE.Vector3()];
    this.focusAlive = [false, false];
    this.focusState = [null, null];
  }

  buildStrata() {
    const x0 = -16, x1 = 50, z0 = -9.5, z1 = 9.5;
    const strata = [{ id: 'L1', ns: 1, color: 0x3fd8ff, note: 'hit, no stall' }, ...LEVELS];
    strata.forEach((lv, k) => {
      const y = -lv.ns * DEPTH_PER_NS;
      const pts = [];
      const step = k === 3 ? 2 : 4;
      for (let x = x0; x <= x1; x += step) pts.push(new THREE.Vector3(x, y, z0), new THREE.Vector3(x, y, z1));
      for (let z = z0; z <= z1 + 0.01; z += step * 0.95) pts.push(new THREE.Vector3(x0, y, z), new THREE.Vector3(x1, y, z));
      const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMaterial(lv.color, [0.04, 0.07, 0.08, 0.16][k]));
      this.group.add(grid);
      if (k > 0) {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), glow(lv.color, k === 3 ? 0.03 : 0.012, { side: THREE.DoubleSide }));
        plane.rotation.x = -Math.PI / 2;
        plane.position.set((x0 + x1) / 2, y, 0);
        this.group.add(plane);
      }
      const l = label(`${lv.id}<span class="ns">~${lv.ns} ns${lv.note ? ' · ' + lv.note : ''}</span>`, 'label level', true);
      l.element.style.color = `#${new THREE.Color(lv.color).getHexString()}`;
      l.position.set(x0 - 0.5, y + 0.2, z1);
      l.center.set(1, 0.5);
      this.group.add(l);
    });
  }

  buildLanes() {
    const S = this.timeline.trace.stageCount;
    this.stations = [[], []];
    this.stageLabels = [];
    LANE_Z.forEach((z, lane) => {
      const color = LANE_COLORS[lane];
      for (let s = 0; s < S; s++) {
        const box = wireBox(STAGE_W, 1.5, 2.2, color, 0.5, 0.015);
        box.position.set(stageX(s) + STAGE_W / 2, 0, z);
        this.group.add(box);
        this.stations[lane].push(box);
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(EGRESS_X - QUEUE_X + 46, 0.02, 0.02), glow(color, 0.25));
      rail.position.set((EGRESS_X + QUEUE_X - 46) / 2, -0.76, z);
      this.group.add(rail);
      const ring = wireBox(1.2, 1.5, 2.2, 0x8a6bff, 0.6, 0.05);
      ring.position.set(QUEUE_X + 0.4, 0, z);
      this.group.add(ring);

      const egress = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.06, 12, 64), glow(0xffc44d, 0.8));
      egress.rotation.y = Math.PI / 2;
      egress.position.set(EGRESS_X, 0, z);
      this.group.add(egress);

      const name = label(`${LANE_TITLES[lane]} lane`, `label big ${lane ? 'tuned' : 'naive'}`);
      name.position.set(-14, 1.6, z);
      this.group.add(name);
      const q = label('', `label ${lane ? 'tuned' : 'naive'}`);
      q.position.set(-8, 1.2, z);
      this.group.add(q);
      const out = label('', 'label gold', true);
      out.position.set(EGRESS_X, lane ? 1.6 : 2.6, z);
      this.group.add(out);
      this.stations[lane].queueLabel = q;
      this.stations[lane].outLabel = out;
    });
    const ringLabel = label('Ring buffer', 'label');
    ringLabel.position.set(QUEUE_X + 0.4, 1.3, 0);
    this.group.add(ringLabel);

    for (let s = 0; s < S; s++) {
      const l = label('', 'label', true);
      l.position.set(stageX(s) + STAGE_W / 2, 2.2, 0);
      this.group.add(l);
      this.stageLabels.push(l);
    }
  }

  buildParticles() {
    const head = new THREE.IcosahedronGeometry(0.17, 1);
    this.heads = new THREE.InstancedMesh(head, glow(0xffffff, 1), MAX_HEADS);
    this.segs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow(0xffffff, 0.9), MAX_SEGS);
    this.shafts = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), glow(0xffffff, 0.5), MAX_SHAFTS);
    for (const m of [this.heads, this.segs, this.shafts]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, WHITE);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
    }
    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), glow(0xffffff, 0.9, { side: THREE.DoubleSide }));
    this.group.add(this.halo);
    this.focusLabel = label('', 'label hero');
    this.focusLabel.position.set(0, 0.9, 0);
    this.halo.add(this.focusLabel);
  }

  // Position of message i in a lane at time t. Returns false when it isn't on screen.
  place(ls, lane, i, t, out) {
    const st = ls.locate(i, t, this.st);
    const z = LANE_Z[lane];
    st.hidden = false;
    st.brightness = 1;
    switch (st.phase) {
      case PHASE_NONE:
        return false;
      case PHASE_QUEUED: {
        const k = Math.min(st.ahead, QUEUE_SHOWN);
        const extra = st.ahead > QUEUE_SHOWN ? Math.log2(1 + (st.ahead - QUEUE_SHOWN) / 40) * 1.5 : 0;
        out.set(QUEUE_X - k * QUEUE_STEP - extra, 0, z + ((i % 3) - 1) * 0.22);
        return true;
      }
      case PHASE_STAGE: {
        out.set(stageX(st.stage) + st.frac * STAGE_W, 0, z);
        const e = st.event;
        if (e) {
          if (e.kind === KIND_BRANCH) {
            const g = st.u < 0.5 ? st.u * 2 : 0;
            out.x += g * 1.6;
            out.y += g * 1.3;
            st.hidden = st.u >= 0.5;
          } else {
            out.y = -depthOf(e.kind) * Math.sin(Math.PI * st.u);
          }
        }
        return true;
      }
      case PHASE_SINK: {
        const x0 = stageX(st.lastStage) + STAGE_W;
        out.set(x0 + 0.3 + st.u * 0.8, st.u * st.u * 2.5, z);
        st.brightness = 1 - st.u;
        return true;
      }
      case PHASE_TX: {
        const x0 = stageX(5) + STAGE_W;
        out.set(x0 + st.u * (EGRESS_X - x0), 0, z);
        st.brightness = st.u > 0.95 ? (1 - st.u) * 20 : 1;
        return true;
      }
    }
    return false;
  }

  update(t, trailNs, wallTime) {
    const tl = this.timeline;
    let nh = 0, ns = 0, nsh = 0;
    const heads = this.heads, segs = this.segs, shafts = this.shafts;
    const p = this.p, q = this.q, c = this.c;

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
      // Many overlapping streaks would saturate to white, so dim each one as the crowd grows.
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
        // Sample at the message's own key moments so a long trail follows the real path
        // through the stations (and down the wells) instead of cutting corners.
        times.length = 0;
        times.push(b);
        if (b > a) {
          const add = (x) => { if (x > a && x < b) times.push(x); };
          const s0 = ls.start[i];
          const base = i * (S + 1);
          add(s0);
          for (let s = 1; s <= S; s++) add(s0 + ls.rel[base + s]);
          if (detail) {
            for (const list of ls.stalls(i)) {
              for (const e of list) { add(s0 + e.t0); add(s0 + e.t0 + e.len / 2); add(s0 + e.t1); }
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
              c.copy(isFocus ? WHITE : base).multiplyScalar((isFocus ? 2.2 : 2) * st.brightness);
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
            if (st.phase === PHASE_STAGE && st.event && nsh < MAX_SHAFTS) {
              const e = st.event;
              if (e.kind === KIND_BRANCH) {
                if (st.u >= 0.5) {
                  const r = (st.u - 0.5) * 2;
                  for (let f = 0; f < 6 && nh < MAX_HEADS; f++) {
                    const ang = (f / 6) * Math.PI * 2;
                    const spread = 1 - r;
                    this.mid.set(q.x + 1.6 * spread + Math.cos(ang) * 0.7 * spread, q.y + 1.3 * spread + Math.sin(ang) * 0.7 * spread, q.z);
                    this.m.makeScale(0.35, 0.35, 0.35).setPosition(this.mid);
                    heads.setMatrixAt(nh, this.m);
                    c.setRGB(1, 0.35, 0.3).multiplyScalar(2.5);
                    heads.setColorAt(nh++, c);
                  }
                }
              } else {
                const d = depthOf(e.kind);
                this.m.makeScale(0.05, d, 0.05).setPosition(this.mid.set(q.x, -d / 2, q.z));
                shafts.setMatrixAt(nsh, this.m);
                c.copy(LEVEL_COLORS[e.kind]).multiplyScalar(0.6);
                shafts.setColorAt(nsh++, c);
              }
            }
          }
          if (ok && prevOk && ns < MAX_SEGS && st.phase !== PHASE_QUEUED) {
            this.dir.subVectors(p, q);
            const len = this.dir.length();
            if (len > 1e-3 && len < 60) {
              this.dir.divideScalar(len);
              this.mid.addVectors(p, q).multiplyScalar(0.5);
              this.quat.setFromUnitVectors(this.X, this.dir);
              const th = isFocus ? 0.12 : 0.06;
              this.scale.set(len, th, th);
              this.m.compose(this.mid, this.quat, this.scale);
              segs.setMatrixAt(ns, this.m);
              const age = (t - ts) / Math.max(trailNs, 1e-9);
              c.copy(isFocus ? WHITE : base).multiplyScalar((isFocus ? 1.4 : 1.4 * density) * Math.max(0, 1 - age) * st.brightness);
              segs.setColorAt(ns++, c);
            }
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
      st.queueLabel.element.textContent = queued > 0 ? `queue ${queued.toLocaleString()}` : '';
      let sent = 0;
      {
        let a = 0, b = ls.done.length;
        while (a < b) { const mid = (a + b) >> 1; if (ls.done[mid] <= t) a = mid + 1; else b = mid; }
        sent = this.sentBefore(lane, a);
      }
      st.outLabel.element.innerHTML = `Orders out <span class="ns">${sent.toLocaleString()}</span>`;
      const cur = serving >= 0 && serving < ls.n && t < ls.done[serving] ? serving : -1;
      for (let s = 0; s < st.length; s++) {
        let active = false;
        if (cur >= 0) {
          const r = t - ls.start[cur];
          const b = cur * (ls.S + 1);
          active = r >= ls.rel[b + s] && r < ls.rel[b + s + 1];
        }
        st[s].userData.fill.material.opacity = active ? 0.06 : 0.012;
      }
    }

    heads.count = nh;
    segs.count = ns;
    shafts.count = nsh;
    for (const m of [heads, segs, shafts]) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }

    const lane = this.focusAlive[1] ? 1 : this.focusAlive[0] ? 0 : -1;
    this.halo.visible = lane >= 0;
    if (lane >= 0) {
      this.halo.position.copy(this.focusPos[lane]);
      this.halo.lookAt(this.halo.position.x, this.halo.position.y, this.halo.position.z + 10);
      this.halo.scale.setScalar(1 + 0.15 * Math.sin(wallTime * 6));
    }
    this.updateStageLabels(t);
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

  updateStageLabels(t) {
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

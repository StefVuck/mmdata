import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { Follow, smooth, lerp, fmtNs, fmtDilation, dust } from '../fx.js';
import { Pipeline, EGRESS_X } from '../core/pipeline.js';
import { BookTerrain } from '../core/terrain.js';
import { CodeCard } from '../code.js';
import { TX_NS } from '../timing.js';
import { STAGES, STAGE_TITLES, TYPE_NAMES, WIRE, FIBRE_NS_PER_M } from '../journey.js';

const TRAIL_WALL = 0.35;
const CAMERAS = {
  overview: { pos: [15, 12, 31], look: [19, -3, 0] },
  wells: { pos: [19, -6, 64], look: [19, -22, 0] },
  book: { pos: [64, 9.5, 23], look: [64, 0.5, -4] },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class CoreAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 1.1;
    this.bloomThreshold = 0.22;
    const s = this.scene;
    s.background = new THREE.Color(0x02030a);
    s.fog = new THREE.FogExp2(0x02030a, 0.0065);
    s.add(dust(2500, 0.06, new THREE.Vector3(140, 120, 70), 0x6f8fb8, 0.25));

    const tl = this.timeline;
    this.pipeline = new Pipeline(tl, s);
    this.terrain = new BookTerrain(tl, s, new THREE.Vector3(64, -0.75, 8));
    this.follow = new Follow(this.camera, 2.4);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();

    const hero = tl.hero;
    const [naive, tuned] = tl.lanes;
    this.tStart = tl.heroArrive - 4;
    this.t = this.tStart;
    const dil = (simNs, wall, lo, hi) => clamp((wall * 1e9) / Math.max(simNs, 1e-6), lo, hi);
    const ttt = (lane) => this.tickToTrade(lane);

    this.script = new Script([
      { id: 'arrive', hold: 6, dilation: () => dil(tuned.done[hero] - this.tStart, 14, 2e7, 2e9), snapDilation: true,
        caption: () => `Inside core 3. Our packet's ${tl.heroPacketCount} messages land in the ring buffer. Two builds of our software read the same feed: a <span style="color:var(--naive)">naive</span> lane and a <span style="color:var(--tuned)">tuned</span> lane.` },
      { id: 'tuned', sim: () => tuned.done[hero] - this.tStart, dilation: () => dil(tuned.done[hero] - this.tStart, 14, 2e7, 2e9),
        caption: () => (tuned.stalls(hero).some((l) => l.length)
          ? 'Each drop into the wells below is a cache miss. The depth is how far the core had to go for its data: L2, L3, or all the way out to DRAM.'
          : 'Everything the tuned lane needs is already in L1, so our message never leaves the track. Behind it, the naive lane keeps diving into the wells below: L2, L3, or all the way out to DRAM.') },
      { id: 'out', sim: TX_NS, dilation: 1e8,
        caption: () => `Signal fired, risk passed, order encoded. <b>Tick to trade, tuned: ${fmtNs(ttt(1))}</b> from the exchange's packet to our order on the wire.` },
      { id: 'naive', sim: () => Math.max(1, naive.done[hero] + TX_NS - this.t), dilation: () => dil(naive.done[hero] + TX_NS - this.t, 11, 1e3, 2e9),
        caption: () => (naive.start[hero] - tl.heroArrive > 50
          ? `Meanwhile the naive lane is still chewing through the burst that arrived before our packet. It reaches our message ${fmtNs(naive.start[hero] - tl.heroArrive)} after it landed.`
          : 'The naive lane gets to the same message, but every stage takes longer.') },
      { id: 'verdict', hold: 8, dilation: 1e6,
        caption: () => `Same packet, same machine, same answer. Naive: <b>${fmtNs(ttt(0))}</b>. Tuned: <b>${fmtNs(ttt(1))}</b>. Behind them, the order book for ${tl.trace.heroSymbol} as the tuned lane saw it.` },
    ], 1e8);

    this.mode = 'script';
    this.camMode = 'follow';
    this.freeDilation = 1e8;
    this.buildControls();
    this.inspector = document.getElementById('inspector');
    this.code = new CodeCard();
    this.codeStage = 0;
    this.showCode = true;
    this.lastInspect = 0;
  }

  tickToTrade(lane) {
    const tl = this.timeline;
    const ls = tl.lanes[lane];
    const wire = (WIRE.fibreMetres + WIRE.patchMetres) * FIBRE_NS_PER_M + WIRE.switchNs + WIRE.opticPhyNs + WIRE.macNs + WIRE.pcieNs + WIRE.pollNs;
    return wire + (ls.done[tl.hero] - tl.heroArrive) + TX_NS;
  }

  buildControls() {
    const root = document.getElementById('controls');
    this.controls = root;
    root.innerHTML = `
      <h3>Free play</h3>
      <div class="ctl-row"><label>Slow-mo</label><input id="ctl-dil" type="range" min="0" max="9.3" step="0.01"><span class="val" id="ctl-dil-val"></span></div>
      <div class="ctl-row"><label>Time</label><input id="ctl-time" type="range" min="0" max="1000" step="1"><button id="ctl-play" class="chip">Pause</button></div>
      <div class="ctl-row"><label>Lanes</label><div class="chips"><button class="chip lane-0 on" data-lane="0">Naive</button><button class="chip lane-1 on" data-lane="1">Tuned</button></div></div>
      <div class="ctl-row"><label>Camera</label><div class="chips">
        <button class="chip" data-cam="follow">Follow</button><button class="chip" data-cam="overview">Overview</button>
        <button class="chip" data-cam="wells">Wells</button><button class="chip" data-cam="book">Book</button></div></div>
      <div class="ctl-row"><label></label><div class="chips"><button class="chip" id="ctl-next">Next order</button><button class="chip" id="ctl-hero">Our message</button><button class="chip" id="ctl-replay">Replay journey</button></div></div>
      <div class="ctl-row"><label>Panel</label><div class="chips"><button class="chip on" data-panel="code">Code</button><button class="chip" data-panel="numbers">Numbers</button></div></div>`;
    const dil = root.querySelector('#ctl-dil');
    dil.addEventListener('input', () => { this.freeDilation = 10 ** Number(dil.value); });
    const time = root.querySelector('#ctl-time');
    time.addEventListener('input', () => { this.t = (Number(time.value) / 1000) * this.timeline.duration; this.follow.snap = false; });
    root.querySelector('#ctl-play').addEventListener('click', () => { this.ctx.director.paused = !this.ctx.director.paused; });
    root.querySelectorAll('[data-lane]').forEach((b) => b.addEventListener('click', () => {
      const l = Number(b.dataset.lane);
      this.pipeline.laneVisible[l] = !this.pipeline.laneVisible[l];
      b.classList.toggle('on', this.pipeline.laneVisible[l]);
    }));
    root.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => this.setCamera(b.dataset.cam)));
    root.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => this.setPanel(b.dataset.panel === 'code')));
    root.querySelector('#ctl-next').addEventListener('click', () => this.nextOrder());
    root.querySelector('#ctl-hero').addEventListener('click', () => {
      this.pipeline.focus = this.timeline.hero;
      this.t = this.tStart;
      this.freeDilation = 1e8;
      this.setCamera('follow');
    });
    root.querySelector('#ctl-replay').addEventListener('click', () => this.ctx.director.go(0, { portal: false }));
    this.dilInput = dil;
    this.timeInput = time;
    this.playBtn = root.querySelector('#ctl-play');
  }

  setPanel(code) {
    this.showCode = code;
    this.controls.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('on', (b.dataset.panel === 'code') === code));
  }

  setCamera(mode) {
    this.camMode = mode;
    this.controls.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', b.dataset.cam === mode));
  }

  nextOrder() {
    const ls = this.timeline.lanes[1];
    let i = Math.max(0, ls.servingAt(this.t) + 1);
    while (i < ls.n && ls.outcome[i] !== 2) i++;
    if (i >= ls.n) return;
    this.pipeline.focus = i;
    this.t = this.timeline.arrive[i] - 2;
    this.freeDilation = 1e8;
    this.setCamera('follow');
  }

  enter() {
    super.enter();
    this.mode = 'script';
    this.t = this.tStart;
    this.pipeline.focus = this.timeline.hero;
    this.terrain.reset();
    this.follow.snap = true;
    this.camMode = 'follow';
    this.controls.hidden = true;
    this.inspector.hidden = true;
    this.code.setVisible(false);
  }

  exit() {
    super.exit();
    this.controls.hidden = true;
    this.inspector.hidden = true;
    this.code.setVisible(false);
  }

  startFree() {
    this.mode = 'free';
    this.freeDilation = this.script.dilation;
    this.controls.hidden = false;
    this.setCamera(this.camMode === 'follow' ? 'book' : this.camMode);
  }

  key(e) {
    if (e.code === 'KeyF') this.setCamera(this.camMode === 'follow' ? 'overview' : 'follow');
    if (e.code === 'KeyN' && this.mode === 'free') this.nextOrder();
  }

  get finished() {
    return false;
  }

  get dilation() {
    return this.mode === 'free' ? this.freeDilation : this.script.dilation;
  }

  get held() {
    return this.mode === 'script' && this.script.held;
  }

  get caption() {
    return this.mode === 'free' ? null : this.script.caption;
  }

  update(dt, wallDt = dt) {
    const tl = this.timeline;
    if (this.mode === 'script') {
      super.update(dt);
      this.t = this.tStart + this.script.sim;
      if (this.script.done) this.startFree();
    } else if (dt > 0) {
      this.t += (dt * 1e9) / this.freeDilation;
      if (this.t >= tl.duration) this.t = 0;
    }
    const wall = performance.now() / 1000;
    const trail = (TRAIL_WALL * 1e9) / this.dilation;
    this.pipeline.update(this.t, trail, wall);
    this.terrain.update(this.t, wall);
    this.updateReceipt();
    this.updateCamera(wallDt);

    this.updateCode();

    if (this.mode === 'free') {
      this.inspector.hidden = this.showCode;
      if (document.activeElement !== this.dilInput) this.dilInput.value = String(Math.log10(this.freeDilation));
      document.getElementById('ctl-dil-val').textContent = fmtDilation(this.freeDilation);
      if (document.activeElement !== this.timeInput) this.timeInput.value = String(Math.round((this.t / tl.duration) * 1000));
      this.playBtn.textContent = this.ctx.director.paused ? 'Play' : 'Pause';
      if (wall - this.lastInspect > 0.2) {
        this.lastInspect = wall;
        this.renderInspector();
      }
    }
  }

  // The code card follows our message through the stages: during the tuned run in the
  // script, and in free play whenever the code panel is chosen.
  updateCode() {
    const id = this.mode === 'script' ? this.script.id : null;
    const show = this.mode === 'free' ? this.showCode : id === 'tuned' || id === 'out' || id === 'naive';
    this.code.setVisible(show);
    if (!show) return;
    const [n, t] = this.pipeline.focusState;
    const inStage = (s) => s && s.stage >= 0;
    if (id === 'naive' ? inStage(n) : inStage(t)) this.codeStage = (id === 'naive' ? n : t).stage;
    else if (inStage(t)) this.codeStage = t.stage;
    else if (inStage(n)) this.codeStage = n.stage;
    const f = this.pipeline.focus;
    this.code.update(this.codeStage, this.timeline.lanes.map((ls) => ls.stageNs(f, this.codeStage)), [n, t]);
  }

  updateReceipt() {
    const tl = this.timeline;
    const hero = tl.hero;
    const t = this.t;
    tl.lanes.forEach((ls, lane) => {
      const arrive = tl.heroArrive;
      const start = ls.start[hero];
      this.receipt.set('queue', start > arrive ? (t - arrive) / (start - arrive) : t >= arrive ? 1 : 0, lane);
      STAGES.forEach((id, s) => {
        const b = hero * (ls.S + 1);
        const s0 = start + ls.rel[b + s];
        const d = ls.rel[b + s + 1] - ls.rel[b + s];
        this.receipt.set(id, d > 0 ? (t - s0) / d : 0, lane);
      });
      this.receipt.set('tx', (t - ls.done[hero]) / TX_NS, lane);
    });
  }

  updateCamera(dt) {
    const id = this.mode === 'script' ? this.script.id : null;
    const pos = this.v, look = this.v2;
    let mode = this.camMode;
    if (id === 'naive') mode = 'overview';
    if (id === 'verdict') mode = 'book';

    if (id === 'arrive') {
      const k = smooth(this.script.progress * 1.2);
      pos.set(lerp(-3, -7.5, k), lerp(0.8, 3.4, k), lerp(5.5, 13.5, k));
      look.set(lerp(-1, 3, k), 0, 4.5);
    } else if (mode === 'follow') {
      const p = this.pipeline;
      const lane = p.focusAlive[1] ? 1 : p.focusAlive[0] ? 0 : -1;
      if (lane < 0) {
        pos.set(...CAMERAS.overview.pos);
        look.set(...CAMERAS.overview.look);
      } else {
        const h = p.focusPos[lane];
        const x = Math.min(h.x, EGRESS_X - 2);
        // With the code card open on the left, frame our message right of centre.
        const side = this.code.visible ? 1 : 0;
        pos.set(x - 6.5 + side * 4, h.y + 4, h.z + 12.5);
        look.set(x + 3 - side * 7.5, h.y - 0.6, h.z - 1);
      }
    } else {
      const c = CAMERAS[mode];
      pos.set(...c.pos);
      look.set(...c.look);
    }
    this.follow.update(dt, pos, look);
    this.terrain.setLabelsVisible(mode === 'book' || mode === 'overview');
  }

  renderInspector() {
    const tl = this.timeline;
    const tr = tl.trace;
    const i = this.pipeline.focus;
    const type = String.fromCharCode(tr.msgType[i]);
    const sym = tr.symbols.get(tr.msgLocate[i]) || '—';
    const pk = tr.msgPacket[i];
    const rows = STAGES.map((id, s) => {
      const cells = tl.lanes.map((ls, lane) => {
        const d = ls.stageNs(i, s);
        if (d <= 0) return '<td>·</td><td class="miss"></td>';
        const ev = ls.stalls(i)[s];
        const counts = [0, 0, 0, 0];
        for (const e of ev) counts[e.kind] += e.count;
        const miss = counts.some((c) => c > 0)
          ? ['L2', 'L3', 'D', 'br'].map((n, k) => (counts[k] ? `${Math.round(counts[k])}${n}` : '')).filter(Boolean).join(' ')
          : '';
        return `<td class="${lane ? 't' : 'n'}">${fmtNs(d)}</td><td class="miss">${miss}</td>`;
      });
      return `<tr><td>${STAGE_TITLES[s]}</td>${cells.join('')}</tr>`;
    }).join('');
    const totals = tl.lanes.map((ls) => fmtNs(ls.done[i] - ls.start[i]));
    const waits = tl.lanes.map((ls) => fmtNs(ls.start[i] - tl.arrive[i]));
    this.inspector.innerHTML = `
      <div class="title"><span class="type">${TYPE_NAMES[type] || type} · ${sym}</span><span>#${i.toLocaleString()}</span></div>
      <div style="color:var(--dim);margin-bottom:8px">packet ${pk.toLocaleString()} · ${i - tr.packetFirst[pk] + 1} of ${tr.packetCount[pk]}${i === tl.hero ? ' · our message' : ''}</div>
      <table><tr><th>stage</th><th class="n">naive</th><th></th><th class="t">tuned</th><th></th></tr>${rows}
      <tr><td>waited</td><td class="n">${waits[0]}</td><td></td><td class="t">${waits[1]}</td><td></td></tr>
      <tr><td>total</td><td class="n">${totals[0]}</td><td></td><td class="t">${totals[1]}</td><td></td></tr></table>`;
  }

  get clockText() {
    return this.timeline.clock(this.t);
  }

  get stat() {
    const tl = this.timeline;
    const [n, t] = tl.lanes.map((ls) => Math.max(0, ls.servingAt(this.t)));
    return `<span class="k">message</span> ${t.toLocaleString()} <span class="k">tuned</span> · ${n.toLocaleString()} <span class="k">naive</span>`;
  }
}

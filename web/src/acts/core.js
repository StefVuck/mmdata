import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { Follow, smooth, lerp, fmtNs, fmtDilation, dust } from '../fx.js';
import { Pipeline } from '../core/pipeline.js';
import { BookTerrain } from '../core/terrain.js';
import { CodeCard } from '../code.js';
import { TX_NS } from '../timing.js';
import { STAGES, STAGE_TITLES, TYPE_NAMES, WIRE, FIBRE_NS_PER_M } from '../journey.js';

const TRAIL_WALL = 0.35;
const CAMERAS = {
  overview: { pos: [-2, 44, 26], look: [0, 0, 2] },
  race: { pos: [-4, 15, 19], look: [-4, 0.8, 0] },
  memory: { pos: [12, 24, 30], look: [16, 0, 0] },
  book: { pos: [4, 13, 6], look: [4, 0, -32] },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const price = (p) => (p / 10000).toFixed(2);

export class CoreAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 0.6;
    this.bloomThreshold = 0.55;
    const s = this.scene;
    s.background = new THREE.Color(0x02030a);
    s.fog = new THREE.FogExp2(0x02030a, 0.0065);
    s.add(dust(2500, 0.06, new THREE.Vector3(140, 120, 70), 0x6f8fb8, 0.25));

    const tl = this.timeline;
    this.pipeline = new Pipeline(tl, s);
    this.terrain = new BookTerrain(tl, s, new THREE.Vector3(4, 0.1, -24));
    this.follow = new Follow(this.camera, 2.4);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();

    const hero = tl.hero;
    const [naive, tuned] = tl.lanes;
    this.tStart = tl.heroArrive - 4;
    this.t = this.tStart;
    this.story = this.bookStory();
    const dil = (simNs, wall, lo, hi) => clamp((wall * 1e9) / Math.max(simNs, 1e-6), lo, hi);
    const ttt = (lane) => this.tickToTrade(lane);
    const service = (ls) => ls.done[hero] - ls.start[hero];
    const raceNs = service(naive) + 40;
    const raceOffset = naive.start[hero] - tuned.start[hero];
    const at = (t, offset = 0) => () => {
      this.t = t;
      this.pipeline.laneOffset[0] = offset;
    };
    const order = this.story
      ? `${this.story.orderSide === 'B' ? 'BUY' : 'SELL'} 100 ${tl.trace.heroSymbol} @ ${price(this.story.orderPrice)}`
      : 'our order';

    this.script = new Script([
      { id: 'arrive', hold: 7, dilation: 1e8, snapDilation: true, onStart: at(this.tStart),
        caption: () => `Inside the CPU. Our packet's ${tl.heroPacketCount} messages land in the ring buffer, which the network card writes straight into L3. Two builds of the same trading code read it, each on its own core: <span style="color:var(--naive)">naive</span> on core 2, <span style="color:var(--tuned)">tuned</span> on core 3. Both run the same six stages and reach the same decision.` },
      { id: 'race', sim: raceNs, dilation: () => dil(raceNs, 16, 1e7, 2e9), onStart: at(tuned.start[hero] - 2, raceOffset),
        onEnd: () => { this.pipeline.laneOffset[0] = 0; },
        caption: () => {
          const tunedNs = service(tuned);
          let s = 0;
          const rb = hero * (naive.S + 1);
          while (s < naive.S - 1 && naive.rel[rb + s + 1] <= tunedNs) s++;
          return `First, a race. Our message on both cores, starting at the same instant. Tuned runs all six stages in <b>${fmtNs(tunedNs)}</b>. At that moment naive is still in its <em>${STAGE_TITLES[s]}</em> stage, and needs <b>${fmtNs(service(naive))}</b> in all. The numbers above each stage are the two builds' times.`;
        } },
      { id: 'detail', sim: () => tuned.done[hero] - this.tStart, dilation: () => dil(tuned.done[hero] - this.tStart, 16, 2e7, 2e9),
        onStart: at(this.tStart),
        caption: () => `Now why, one stage at a time. The card on the left shows both builds' code for the stage our message is in. Each trip off the core is a cache miss, drawn to scale: one unit of board is one nanosecond, so L2 sits beside the core, L3 across the die, and DRAM out on the DIMMs.` },
      { id: 'out', sim: TX_NS, dilation: 1.2e8, onStart: at(tuned.done[hero]),
        caption: () => `Signal fired, risk passed, order encoded: <b>${order}</b>. It leaves the way the packet came in: across the die to the PCIe root complex, down the lanes to the network card and onto the wire, about 600 ns (a typical figure). Tick to trade, tuned: <b>${fmtNs(ttt(1))}</b>.` },
      { id: 'naive', sim: () => Math.max(1, naive.done[hero] + TX_NS - this.t), dilation: () => dil(naive.done[hero] + TX_NS - this.t, 11, 1e3, 2e9),
        onStart: at(tuned.done[hero] + TX_NS),
        caption: () => (naive.start[hero] - tl.heroArrive > 50
          ? `In the real run it was worse than the race suggests. The naive core was still working through the burst that arrived before our packet, and only reached our message <b>${fmtNs(naive.start[hero] - tl.heroArrive)}</b> after it landed. Slow code doesn't just take longer: it falls behind, and then everything waits.`
          : 'The naive core gets to the same message and makes the same decision, just later.') },
      { id: 'book', hold: 13, dilation: 1e8, onStart: () => { at(tuned.done[hero] + 1)(); this.markBook(); },
        caption: () => (this.story
          ? `What was all that work for? This is the order book the Book stage keeps for ${tl.trace.heroSymbol}: every price level, bids in green on the left, asks in red on the right, bar height the shares waiting there, newest row at the front. Our message was a trade that emptied the best ${this.story.cleared.side === 'B' ? 'bid' : 'ask'} at <b>${price(this.story.cleared.price)}</b>. That is the signal: the price just moved, so we ${this.story.orderSide === 'B' ? 'buy' : 'sell'} at the new best, <b>${price(this.story.orderPrice)}</b>, before others react.`
          : `This is the order book the Book stage keeps for ${tl.trace.heroSymbol}: bids in green, asks in red, bar height the shares waiting at each price.`) },
      { id: 'verdict', hold: 9, dilation: 1e6, onStart: at(naive.done[hero] + TX_NS + 1),
        caption: () => `Same packet, same machine, same decision. Naive: <b>${fmtNs(ttt(0))}</b>. Tuned: <b>${fmtNs(ttt(1))}</b>, and the receipt below breaks down every nanosecond. Now it's yours: drag the timeline, change the slow motion, or follow the next order.` },
    ], 1e8);

    this.mode = 'script';
    this.camMode = 'follow';
    this.freeDilation = 1e8;
    this.buildControls();
    this.buildTransport();
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

  // Replays the hero symbol's book up to our message to find what it did: which level it
  // emptied, and so which side and price our order went out at.
  bookStory() {
    const tl = this.timeline;
    const book = tl.trace.book;
    const levels = { B: new Map(), S: new Map() };
    let cleared = null;
    for (let k = 0; k < book.message.length && book.message[k] <= tl.hero; k++) {
      const side = book.side[k] === 66 ? 'B' : 'S';
      if (book.kind[k] !== 0) continue;
      if (book.qty[k] > 0) levels[side].set(book.price[k], book.qty[k]);
      else levels[side].delete(book.price[k]);
      if (book.message[k] === tl.hero && book.qty[k] === 0) cleared = { side, price: book.price[k] };
    }
    if (!cleared) return null;
    const rest = [...levels[cleared.side].keys()];
    if (!rest.length) return null;
    const orderPrice = cleared.side === 'B' ? Math.max(...rest) : Math.min(...rest);
    return { cleared, orderSide: cleared.side === 'B' ? 'S' : 'B', orderPrice };
  }

  markBook() {
    if (!this.story) return;
    const s = this.story;
    this.terrain.setMarker(0, s.cleared.price, `Emptied by our message<span class="ns">${price(s.cleared.price)}</span>`, 0xffffff);
    this.terrain.setMarker(1, s.orderPrice, `Our order: ${s.orderSide === 'B' ? 'buy' : 'sell'}<span class="ns">${price(s.orderPrice)}</span>`, 0xffc44d);
  }

  buildControls() {
    const root = document.getElementById('controls');
    this.controls = root;
    root.innerHTML = `
      <h3>Free play</h3>
      <div class="ctl-row"><label>Lanes</label><div class="chips"><button class="chip lane-0 on" data-lane="0">Naive</button><button class="chip lane-1 on" data-lane="1">Tuned</button></div></div>
      <div class="ctl-row"><label>Camera</label><div class="chips">
        <button class="chip" data-cam="follow">Follow</button><button class="chip" data-cam="overview">Overview</button>
        <button class="chip" data-cam="memory">Memory</button><button class="chip" data-cam="book">Order book</button></div></div>
      <div class="ctl-row"><label>Jump to</label><div class="chips"><button class="chip" id="ctl-next">Next order</button><button class="chip" id="ctl-hero">Our message</button></div></div>
      <div class="ctl-row"><label>Panel</label><div class="chips"><button class="chip on" data-panel="code">Code</button><button class="chip" data-panel="numbers">Numbers</button></div></div>`;
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
  }

  // The transport bar: play and pause, a timeline you can click or drag to jump anywhere in
  // the trace, the slow-motion slider, and a way in and out of the scripted story.
  buildTransport() {
    const root = document.getElementById('transport');
    this.transport = root;
    root.innerHTML = `
      <button class="tp-play" title="Pause (Space)"></button>
      <div class="tp-timeline" title="Click or drag to jump">
        <canvas></canvas><div class="tp-head"></div>
        <div class="tp-hint">Click or drag the timeline to jump to any moment</div>
      </div>
      <label class="tp-label">Slow motion</label>
      <input class="tp-dil" type="range" min="0" max="9.3" step="0.01" title="Drag to change the slow-motion factor">
      <span class="tp-dil-val"></span>
      <button class="tp-mode"></button>`;
    this.tpPlay = root.querySelector('.tp-play');
    this.tpLine = root.querySelector('.tp-timeline');
    this.tpCanvas = root.querySelector('canvas');
    this.tpHead = root.querySelector('.tp-head');
    this.tpDil = root.querySelector('.tp-dil');
    this.tpDilVal = root.querySelector('.tp-dil-val');
    this.tpMode = root.querySelector('.tp-mode');

    this.tpPlay.addEventListener('click', () => { this.ctx.director.paused = !this.ctx.director.paused; });
    this.tpMode.addEventListener('click', () => {
      if (this.mode === 'script') this.startFree();
      else this.enter();
    });
    this.tpDil.addEventListener('input', () => {
      if (this.mode === 'script') this.startFree();
      this.freeDilation = 10 ** Number(this.tpDil.value);
    });
    const seek = (e) => {
      const r = this.tpLine.getBoundingClientRect();
      const f = clamp((e.clientX - r.left) / r.width, 0, 1);
      if (this.mode === 'script') this.startFree();
      this.t = f * this.timeline.duration;
    };
    let dragging = false;
    this.tpLine.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.tpLine.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.tpLine.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    this.tpLine.addEventListener('pointerup', () => { dragging = false; });
    window.addEventListener('resize', () => this.drawTimeline());
  }

  drawTimeline() {
    const c = this.tpCanvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const tl = this.timeline;
    const x = (t) => (t / tl.duration) * w;
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, h / 2 - 3, w, 6);
    // Message density, so the burst at the open is visible.
    const bins = Math.floor(w / 2);
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < tl.arrive.length; i++) counts[Math.min(bins - 1, Math.floor((tl.arrive[i] / tl.duration) * bins))]++;
    const peak = Math.max(...counts);
    g.fillStyle = 'rgba(63,216,255,0.35)';
    counts.forEach((n, k) => {
      const bh = (n / peak) * (h / 2 - 4);
      g.fillRect(k * 2, h / 2 - bh, 1.5, bh);
    });
    const ls = tl.lanes[1];
    g.fillStyle = 'rgba(255,196,77,0.55)';
    for (let i = 0; i < ls.n; i++) if (ls.outcome[i] === 2) g.fillRect(x(ls.done[i]), h / 2 + 4, 1, 5);
    g.font = '10px system-ui, sans-serif';
    if (tl.openTime > 0 && tl.openTime < tl.duration) {
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillRect(x(tl.openTime), 2, 1, h - 4);
      g.fillText('09:30 open', x(tl.openTime) + 4, 11);
    }
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(x(tl.heroArrive), h / 2, 4, 0, Math.PI * 2);
    g.fill();
    g.fillText('our packet', x(tl.heroArrive) + 6, h - 3);
    g.fillStyle = 'rgba(255,196,77,0.9)';
    g.fillText('orders', 4, h - 3);
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
    this.pipeline.laneOffset[0] = 0;
    this.terrain.reset();
    this.follow.snap = true;
    this.camMode = 'follow';
    this.controls.hidden = true;
    this.inspector.hidden = true;
    this.code.setVisible(false);
    this.transport.hidden = false;
    document.body.classList.add('has-transport');
    requestAnimationFrame(() => this.drawTimeline());
  }

  exit() {
    super.exit();
    this.controls.hidden = true;
    this.inspector.hidden = true;
    this.code.setVisible(false);
    this.transport.hidden = true;
    document.body.classList.remove('has-transport');
  }

  startFree() {
    if (this.mode === 'free') return;
    this.mode = 'free';
    this.pipeline.laneOffset[0] = 0;
    this.freeDilation = this.script.dilation;
    this.controls.hidden = false;
    this.setCamera(this.script.done ? 'overview' : this.camMode === 'follow' ? 'follow' : 'overview');
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
      const before = this.script.sim;
      super.update(dt);
      this.t += this.script.sim - before;
      if (this.script.done) this.startFree();
    } else if (dt > 0) {
      this.t += (dt * 1e9) / this.freeDilation;
      if (this.t >= tl.duration) this.t = 0;
    }
    const wall = performance.now() / 1000;
    const trail = (TRAIL_WALL * 1e9) / this.dilation;
    this.pipeline.update(this.t, trail, wall);
    const id = this.mode === 'script' ? this.script.id : null;
    const showBook = id === 'book' || (this.mode === 'free' && this.camMode === 'book');
    this.terrain.group.visible = showBook;
    this.terrain.setLabelsVisible(showBook);
    if (showBook) this.terrain.update(this.t, wall);
    this.updateReceipt();
    this.updateCamera(wallDt);
    this.updateCode();
    this.updateTransport();

    if (this.mode === 'free') {
      this.inspector.hidden = this.code.visible;
      if (wall - this.lastInspect > 0.2) {
        this.lastInspect = wall;
        this.renderInspector();
      }
    }
  }

  updateTransport() {
    const paused = this.ctx.director.paused;
    const play = paused ? '▶ Play' : '❚❚ Pause';
    if (this.tpPlay.textContent !== play) this.tpPlay.textContent = play;
    this.tpPlay.classList.toggle('paused', paused);
    this.tpHead.style.left = `${clamp(this.t / this.timeline.duration, 0, 1) * 100}%`;
    if (document.activeElement !== this.tpDil) this.tpDil.value = String(Math.log10(this.dilation));
    const d = fmtDilation(this.dilation);
    if (this.tpDilVal.textContent !== d) this.tpDilVal.textContent = d;
    const mode = this.mode === 'script' ? 'Skip to free play ⏭' : 'Replay the story ↺';
    if (this.tpMode.textContent !== mode) this.tpMode.textContent = mode;
  }

  // The code card follows our message through the stages: during the step-by-step beats in
  // the script, and in free play whenever the code panel is chosen with the follow camera.
  updateCode() {
    const id = this.mode === 'script' ? this.script.id : null;
    const show = this.mode === 'free' ? this.showCode && this.camMode === 'follow' : id === 'detail' || id === 'out';
    this.code.setVisible(show);
    if (!show) return;
    const [n, t] = this.pipeline.focusState;
    const inStage = (s) => s && s.stage >= 0;
    if (inStage(t)) this.codeStage = t.stage;
    else if (inStage(n)) this.codeStage = n.stage;
    const f = this.pipeline.focus;
    this.code.update(this.codeStage, this.timeline.lanes.map((ls) => ls.stageNs(f, this.codeStage)), [n, t]);
  }

  updateReceipt() {
    const tl = this.timeline;
    const hero = tl.hero;
    tl.lanes.forEach((ls, lane) => {
      const t = this.t + this.pipeline.laneOffset[lane];
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
    if (id === 'race') mode = 'race';
    if (id === 'naive' || id === 'verdict') mode = 'overview';
    if (id === 'book') mode = 'book';

    if (id === 'arrive') {
      const k = smooth(this.script.progress * 1.2);
      pos.set(lerp(-19, -12, k), lerp(6, 18, k), lerp(9, 22, k));
      look.set(lerp(-8, -4, k), 0.6, 0);
    } else if (mode === 'follow') {
      const p = this.pipeline;
      const lane = p.focusAlive[1] ? 1 : p.focusAlive[0] ? 0 : -1;
      if (lane < 0) {
        pos.set(...CAMERAS.overview.pos);
        look.set(...CAMERAS.overview.look);
      } else {
        const h = p.focusPos[lane];
        // With the code card open on the left, frame our message right of centre.
        const side = this.code.visible ? 1 : 0;
        pos.set(h.x - 4 + side * 3, h.y + 9, h.z + 10);
        look.set(h.x + 2 - side * 6, h.y - 0.5, h.z - 1);
      }
    } else {
      const c = CAMERAS[mode];
      pos.set(...c.pos);
      look.set(...c.look);
    }
    this.follow.update(dt, pos, look);
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
    if (this.mode === 'script' && this.script.id === 'race') return '<span class="k">replay</span> both cores start together';
    const tl = this.timeline;
    const [n, t] = tl.lanes.map((ls) => Math.max(0, ls.servingAt(this.t)));
    return `<span class="k">message</span> ${t.toLocaleString()} <span class="k">tuned</span> · ${n.toLocaleString()} <span class="k">naive</span>`;
  }
}

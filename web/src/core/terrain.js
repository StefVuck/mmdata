import * as THREE from 'three';
import { glow, label, lineMaterial } from '../fx.js';

const COLS = 60;
const ROWS = 64;
const CELL = 0.44;
const TICK = 100;
const BID = new THREE.Color(0x3fffb0);
const ASK = new THREE.Color(0xff4f7a);
const TRADE = new THREE.Color(0xffffff);

// The hero symbol's book as the tuned lane saw it. Price runs left to right, history runs
// back into the distance, and each change to the book pushes a new row to the front.
export class BookTerrain {
  constructor(timeline, scene, origin) {
    this.timeline = timeline;
    this.origin = origin.clone();
    this.group = new THREE.Group();
    this.group.position.copy(origin);
    scene.add(this.group);

    const book = timeline.trace.book;
    const done = timeline.lanes[1].done;
    this.n = book.message.length;
    this.times = new Float64Array(this.n);
    for (let k = 0; k < this.n; k++) this.times[k] = done[book.message[k]];

    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL * 0.8, 1, CELL * 0.45), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), COLS * ROWS);
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxes.setColorAt(0, BID);
    this.boxes.frustumCulled = false;
    this.group.add(this.boxes);
    this.flashes = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL * 0.5, 1, CELL * 0.5), glow(0xffffff, 1), 64);
    this.flashes.setColorAt(0, TRADE);
    this.flashes.frustumCulled = false;
    this.group.add(this.flashes);

    const w = COLS * CELL, d = ROWS * CELL;
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)), lineMaterial(0x5b8cff, 0.35));
    frame.rotation.x = -Math.PI / 2;
    frame.position.set(0, -0.02, -d / 2 + CELL / 2);
    this.group.add(frame);
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, d), glow(0xffc44d, 0.5));
    spine.position.set(0, 0, -d / 2 + CELL / 2);
    this.group.add(spine);

    const title = label(`Order book · ${timeline.trace.heroSymbol}`, 'label big');
    title.position.set(0, 6.5, -d - 0.5);
    this.group.add(title);
    this.bidLabel = label('', 'label tuned', true);
    this.askLabel = label('', 'label naive', true);
    this.bidLabel.position.set(-w / 4, 0.2, 1.4);
    this.askLabel.position.set(w / 4, 0.2, 1.4);
    this.group.add(this.bidLabel, this.askLabel);
    const now = label('now', 'label');
    now.position.set(w / 2 + 0.8, 0, 0);
    const past = label('earlier', 'label');
    past.position.set(w / 2 + 0.8, 0, -d + 1);
    this.group.add(now, past);
    this.labels = [title, this.bidLabel, this.askLabel, now, past];

    // Price markers on the front row: a thin beam with a label, used to point at the level
    // our message emptied and the price our order went out at.
    this.markers = [0, 1].map((k) => {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.06, 7, 0.06), glow(0xffffff, 0.8));
      const l = label('', 'label marker', true);
      l.position.set(0, k ? 1.2 : 3.9, 0);
      l.center.set(k ? 0 : 1, 1);
      beam.add(l);
      beam.visible = false;
      this.group.add(beam);
      return { beam, label: l, price: 0 };
    });

    this.rows = Array.from({ length: ROWS }, () => ({ centre: 0, bid: new Float32Array(COLS), ask: new Float32Array(COLS), used: false }));
    this.head = 0;
    this.trades = [];
    this.m = new THREE.Matrix4();
    this.c = new THREE.Color();
    this.reset();
  }

  reset() {
    this.ptr = 0;
    this.bids = new Map();
    this.asks = new Map();
    this.lastT = -Infinity;
    this.centre = 0;
    for (const r of this.rows) r.used = false;
    this.trades.length = 0;
  }

  bestBid() {
    let b = 0;
    for (const [p, q] of this.bids) if (q > 0 && p > b) b = p;
    return b;
  }

  bestAsk() {
    let a = Infinity;
    for (const [p, q] of this.asks) if (q > 0 && p < a) a = p;
    return a;
  }

  pushRow() {
    const bb = this.bestBid(), ba = this.bestAsk();
    let centre = this.centre;
    if (bb && isFinite(ba)) centre = Math.round((bb + ba) / 2 / TICK) * TICK;
    else if (bb) centre = bb;
    else if (isFinite(ba)) centre = ba;
    this.centre = centre;
    this.head = (this.head + 1) % ROWS;
    const row = this.rows[this.head];
    row.used = true;
    row.centre = centre;
    row.bid.fill(0);
    row.ask.fill(0);
    const half = COLS / 2;
    for (const [p, q] of this.bids) {
      const c = Math.round((p - centre) / TICK) + half;
      if (c >= 0 && c < COLS) row.bid[c] = q;
    }
    for (const [p, q] of this.asks) {
      const c = Math.round((p - centre) / TICK) + half;
      if (c >= 0 && c < COLS) row.ask[c] = q;
    }
    this.bb = bb;
    this.ba = ba;
  }

  update(t, wallTime) {
    if (t < this.lastT) this.reset();
    this.lastT = t;
    const book = this.timeline.trace.book;
    let changed = false;
    let end = this.ptr;
    while (end < this.n && this.times[end] <= t) end++;
    // A big jump (entering the act, scrubbing) still leaves a full history behind it.
    while (this.ptr < end) {
      const k = this.ptr++;
      if (changed && end - k < ROWS && this.timeline.trace.book.message[k] !== this.timeline.trace.book.message[k - 1]) this.pushRow();
      const side = book.side[k] === 66 ? this.bids : this.asks;
      if (book.kind[k] === 0) {
        if (book.qty[k] > 0) side.set(book.price[k], book.qty[k]);
        else side.delete(book.price[k]);
      } else {
        this.trades.push({ price: book.price[k], qty: book.qty[k], at: wallTime });
        if (this.trades.length > 64) this.trades.shift();
      }
      changed = true;
    }
    if (changed || !this.rows[this.head].used) this.pushRow();

    let n = 0;
    const half = COLS / 2;
    for (let r = 0; r < ROWS; r++) {
      const row = this.rows[(this.head - r + ROWS) % ROWS];
      if (!row.used) continue;
      const fade = Math.pow(1 - r / ROWS, 1.6);
      const z = -r * CELL;
      const shift = Math.round((row.centre - this.centre) / TICK);
      for (let c = 0; c < COLS; c++) {
        const q = row.bid[c] || row.ask[c];
        if (!q) continue;
        const col = c + shift;
        if (col < 0 || col >= COLS) continue;
        const h = 0.1 + Math.log10(1 + q / 100) * 1.25;
        this.m.makeScale(1, h, 1).setPosition((col - half) * CELL, h / 2, z);
        this.boxes.setMatrixAt(n, this.m);
        this.c.copy(row.bid[c] ? BID : ASK).multiplyScalar(r === 0 ? 0.75 : 0.03 + 0.17 * fade);
        this.boxes.setColorAt(n++, this.c);
      }
    }
    this.boxes.count = n;
    this.boxes.instanceMatrix.needsUpdate = true;
    this.boxes.instanceColor.needsUpdate = true;

    let f = 0;
    for (const tr of this.trades) {
      const age = wallTime - tr.at;
      if (age > 1.2 || age < 0) continue;
      const col = Math.round((tr.price - this.centre) / TICK) + half;
      if (col < 0 || col >= COLS) continue;
      const h = 6 * (1 - age / 1.2);
      this.m.makeScale(1, h, 1).setPosition((col - half) * CELL, h / 2, 0.3);
      this.flashes.setMatrixAt(f, this.m);
      this.c.copy(TRADE).multiplyScalar(2.5 * (1 - age / 1.2));
      this.flashes.setColorAt(f++, this.c);
    }
    this.flashes.count = f;
    for (const m of this.markers) {
      if (!m.price) continue;
      const col = Math.round((m.price - this.centre) / TICK) + half;
      m.beam.position.set((col - half) * CELL, 3.5, 0.6);
    }
    this.flashes.instanceMatrix.needsUpdate = true;
    if (this.flashes.instanceColor) this.flashes.instanceColor.needsUpdate = true;

    const fmt = (p) => (p / 10000).toFixed(2);
    const bidHtml = this.bb ? `Bid ${fmt(this.bb)}` : '';
    const askHtml = isFinite(this.ba) ? `Ask ${fmt(this.ba)}` : '';
    if (this.bidLabel.element.innerHTML !== bidHtml) this.bidLabel.element.innerHTML = bidHtml;
    if (this.askLabel.element.innerHTML !== askHtml) this.askLabel.element.innerHTML = askHtml;
  }

  setMarker(k, price, html, color) {
    const m = this.markers[k];
    m.price = price;
    m.beam.visible = price > 0;
    m.beam.material.color.set(color);
    m.label.element.innerHTML = html;
    m.label.element.style.borderColor = new THREE.Color(color).getStyle();
  }

  setLabelsVisible(v) {
    for (const l of this.labels) l.visible = v;
    for (const m of this.markers) m.label.visible = v && m.price > 0;
  }

  get centrePoint() {
    return this.origin.clone().add(new THREE.Vector3(0, 0, -ROWS * CELL * 0.35));
  }
}

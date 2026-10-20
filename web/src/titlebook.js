// The title screen's backdrop: the featured stock's order book, replayed from the trace. Time
// scrolls left as a heatmap of resting shares at each price, with the best bid and ask traced
// through it and trades flashing as they print. A live price ladder sits on the right.

const TICK = 100;
const ROW = 13;
const COL = 3;

export class TitleBook {
  constructor(canvas, trace) {
    this.canvas = canvas;
    this.book = trace.book;
    this.symbol = trace.heroSymbol;
    this.g = canvas.getContext('2d');
    this.heat = document.createElement('canvas');
    this.hg = this.heat.getContext('2d');
    this.running = false;
    this.reset();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  reset() {
    this.ptr = 0;
    this.bids = new Map();
    this.asks = new Map();
    this.centre = 0;
    this.trades = [];
    this.shown = new Map();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w;
    this.canvas.height = h;
    this.narrow = w < 760;
    this.ladderW = this.narrow ? 0 : Math.min(300, w * 0.24);
    this.heat.width = Math.max(1, w - this.ladderW);
    this.heat.height = h;
  }

  start() {
    if (this.running || !this.book.message.length) return;
    this.running = true;
    // Run a few seconds of the book first, so the screen opens on a full picture.
    for (let k = 0; k < 400; k++) this.step();
    const loop = () => {
      if (!this.running) return;
      this.step();
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  best() {
    let bb = 0, ba = Infinity;
    for (const p of this.bids.keys()) if (p > bb) bb = p;
    for (const p of this.asks.keys()) if (p < ba) ba = p;
    return [bb, ba];
  }

  // Apply the next handful of book events, then add one column to the heatmap.
  step() {
    const b = this.book;
    for (const t of this.trades) t.age++;
    this.trades = this.trades.filter((t) => t.age < 40);
    for (let k = 0; k < 7; k++) {
      if (this.ptr >= b.message.length) this.reset();
      const i = this.ptr++;
      const side = b.side[i] === 66 ? this.bids : this.asks;
      if (b.kind[i] === 0) {
        if (b.qty[i] > 0) side.set(b.price[i], b.qty[i]);
        else side.delete(b.price[i]);
      } else {
        this.trades.push({ price: b.price[i], qty: b.qty[i], age: 0, side: b.side[i] === 66 ? 'B' : 'S' });
      }
    }

    const [bb, ba] = this.best();
    if (!bb || !isFinite(ba)) return;
    const mid = Math.round((bb + ba) / 2 / TICK) * TICK;
    const h = this.heat.height;
    const cy = h * (this.narrow ? 0.62 : 0.5);
    if (!this.centre) this.centre = mid;
    // Recentre in whole ticks, moving the history with it.
    const shift = Math.round((mid - this.centre) / TICK);
    const hg = this.hg;
    hg.globalCompositeOperation = 'copy';
    hg.drawImage(this.heat, -COL, shift * ROW);
    hg.globalCompositeOperation = 'source-over';
    this.centre += shift * TICK;

    const x = this.heat.width - COL;
    const y = (p) => cy - ((p - this.centre) / TICK) * ROW;
    hg.fillStyle = '#03050a';
    hg.fillRect(x, 0, COL, h);
    const paint = (levels, rgb) => {
      for (const [p, q] of levels) {
        const a = Math.min(0.9, 0.18 + Math.log10(1 + q / 100) * 0.32);
        hg.fillStyle = `rgba(${rgb},${a})`;
        hg.fillRect(x, y(p) - ROW / 2, COL, ROW - 1);
      }
    };
    paint(this.bids, '63,255,176');
    paint(this.asks, '255,79,122');
    hg.fillStyle = 'rgba(255,255,255,0.9)';
    hg.fillRect(x, y(bb) - 1, COL, 2);
    hg.fillRect(x, y(ba) - 1, COL, 2);
    for (const t of this.trades) {
      if (t.age > 0) continue;
      const r = Math.min(5, 1.5 + Math.sqrt(t.qty / 100) * 0.8);
      hg.fillStyle = 'rgba(255,196,77,0.9)';
      hg.beginPath();
      hg.arc(x, y(t.price), r, 0, Math.PI * 2);
      hg.fill();
    }
    this.cy = cy;
    this.bb = bb;
    this.ba = ba;
  }

  draw() {
    const g = this.g, w = this.canvas.width, h = this.canvas.height;
    g.clearRect(0, 0, w, h);
    g.drawImage(this.heat, 0, 0);
    if (!this.ladderW || !this.bb) return;

    // The ladder: twelve prices each side of the spread, bars easing towards their size.
    const x0 = w - this.ladderW;
    const y = (p) => this.cy - ((p - this.centre) / TICK) * ROW * 1.6;
    g.fillStyle = 'rgba(3,5,10,0.75)';
    g.fillRect(x0, 0, this.ladderW, h);
    g.font = '11px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(160,180,210,0.6)';
    g.fillText(`${this.symbol} order book`, x0 + 16, this.cy - ROW * 1.6 * 14);
    const rows = [];
    for (let k = 0; k < 12; k++) rows.push(['S', this.ba + k * TICK], ['B', this.bb - k * TICK]);
    const barMax = this.ladderW - 96;
    for (const [side, p] of rows) {
      const q = (side === 'B' ? this.bids : this.asks).get(p) || 0;
      const key = side + p;
      const prev = this.shown.get(key) || 0;
      const v = prev + (q - prev) * 0.2;
      this.shown.set(key, v);
      const yy = y(p);
      const bw = Math.min(barMax, Math.log10(1 + v / 100) * barMax * 0.45);
      g.fillStyle = side === 'B' ? 'rgba(63,255,176,0.55)' : 'rgba(255,79,122,0.55)';
      g.fillRect(x0 + 72, yy - 7, bw, 14);
      g.fillStyle = side === 'B' ? 'rgba(63,255,176,0.9)' : 'rgba(255,107,138,0.9)';
      g.fillText((p / 10000).toFixed(2), x0 + 16, yy);
      const flash = this.trades.find((t) => t.price === p && t.age < 14 && t.side === side);
      if (flash) {
        g.fillStyle = `rgba(255,196,77,${0.5 * (1 - flash.age / 14)})`;
        g.fillRect(x0 + 8, yy - 8, this.ladderW - 16, 16);
      }
    }
    if (this.ba > this.bb) {
      g.fillStyle = 'rgba(160,180,210,0.6)';
      g.fillText(`spread ${((this.ba - this.bb) / 10000).toFixed(2)}`, x0 + 150, (y(this.ba) + y(this.bb)) / 2);
    }
  }
}

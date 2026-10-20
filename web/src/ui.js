import { WIRE, FIBRE_NS_PER_M, STAGES, STAGE_TITLES, LANE_TITLES } from './journey.js';
import { fmtNs, fmtDilation } from './fx.js';

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export const ACTS = [
  { n: 'I', title: 'The exchange' },
  { n: 'II', title: 'The fibre' },
  { n: 'III', title: 'The switch' },
  { n: 'IV', title: 'The network card' },
  { n: 'V', title: 'The core' },
  { n: 'VI', title: 'The code' },
];

export class Receipt {
  constructor(root, timeline) {
    this.root = root;
    this.timeline = timeline;
    const wire = (id, label, ns) => ({ id, label, ns, typical: true });
    this.shared = [
      wire('fibre', 'Fibre', WIRE.fibreMetres * FIBRE_NS_PER_M),
      wire('switch', 'L1 switch', WIRE.switchNs),
      wire('patch', 'Patch', WIRE.patchMetres * FIBRE_NS_PER_M),
      wire('phy', 'Optic + MAC', WIRE.opticPhyNs + WIRE.macNs),
      wire('pcie', 'PCIe DMA', WIRE.pcieNs),
      wire('poll', 'Poll', WIRE.pollNs),
    ];
    // Both rows share the same columns in the same order, so every stage lines up and is
    // visible for both builds even when one of them takes a few nanoseconds.
    this.rows = timeline.heroStats.map((h, lane) => {
      const segs = this.shared.map((s) => ({ ...s }));
      segs.push({ id: 'queue', label: 'Queue', ns: h.queue, queue: true });
      STAGES.forEach((id, s) => segs.push({ id, label: STAGE_TITLES[s], ns: h.stages[s], measured: true }));
      segs.push({ id: 'tx', label: 'Out to wire', ns: WIRE.txNs, typical: true });
      return { lane, segs, fill: new Map() };
    });
    this.build();
  }

  build() {
    this.root.innerHTML = '';
    const cols = this.rows[0].segs.map((s, k) => Math.max(...this.rows.map((r) => r.segs[k].ns)));
    const sum = cols.reduce((a, b) => a + b, 0);
    // Columns are as wide as the slower build needs, with a floor so the shortest stays readable.
    // Inside a column, each build's bar is in proportion to its own time.
    for (const row of [...this.rows].reverse()) {
      const line = el('div', `receipt-row lane-${row.lane}`);
      line.append(el('div', `receipt-lane lane-${row.lane}`, LANE_TITLES[row.lane]));
      const bar = el('div', 'receipt-bar');
      row.els = new Map();
      row.segs.forEach((s, k) => {
        const seg = el('div', `seg ${s.typical ? 'typical' : ''} ${s.queue ? 'queue' : ''} ${s.measured ? 'measured' : ''}`);
        seg.style.flexGrow = String(Math.max(cols[k] / sum, 0.045));
        const track = el('div', 'seg-track');
        track.style.width = `${cols[k] > 0 ? (s.ns / cols[k]) * 100 : 0}%`;
        const fill = el('div', 'seg-fill');
        track.append(fill);
        const txt = el('div', 'seg-text');
        txt.append(el('span', 'seg-name', s.label), el('span', 'seg-ns', s.ns > 0 || s.queue ? fmtNs(s.ns) : 'none'));
        seg.append(track, txt);
        seg.title = `${s.label}: ${fmtNs(s.ns)}${s.typical ? ' (typical figure)' : s.measured ? ' (measured)' : ' (from schedule)'}`;
        bar.append(seg);
        row.els.set(s.id, { seg, fill });
      });
      line.append(bar);
      const total = el('div', 'receipt-total', '0 ns');
      row.totalEl = total;
      line.append(total);
      this.root.append(line);
    }
    const legend = el('div', 'receipt-legend');
    const measured = this.timeline.trace.source === 'synthetic' ? 'illustrative software time' : 'measured by mmdecode';
    legend.innerHTML = `<span class="key typical"></span>typical figure <span class="key measured"></span>${measured} <span class="key queue"></span>waiting behind earlier messages <span class="legend-note">Columns line up stage by stage; the bar inside each shows that build's share.</span>`;
    this.root.append(legend);
  }

  set(id, fraction, lane = null) {
    for (const row of this.rows) {
      if (lane != null && row.lane !== lane) continue;
      const e = row.els.get(id);
      if (!e) continue;
      const f = Math.max(0, Math.min(1, fraction));
      row.fill.set(id, f);
      e.fill.style.width = `${f * 100}%`;
      e.seg.classList.toggle('active', f > 0 && f < 1);
    }
    this.updateTotals();
  }

  fillThrough(id, lane = null) {
    for (const row of this.rows) {
      if (lane != null && row.lane !== lane) continue;
      for (const s of row.segs) {
        this.set(s.id, 1, row.lane);
        if (s.id === id) break;
      }
    }
  }

  clear() {
    for (const row of this.rows) for (const s of row.segs) this.set(s.id, 0, row.lane);
  }

  updateTotals() {
    for (const row of this.rows) {
      let t = 0;
      for (const s of row.segs) t += s.ns * (row.fill.get(s.id) || 0);
      row.totalEl.textContent = fmtNs(t);
    }
  }

  total(lane) {
    return this.rows[lane].segs.reduce((a, s) => a + s.ns, 0);
  }
}

export class Hud {
  constructor(timeline) {
    this.timeline = timeline;
    this.root = $('#hud');
    this.actTitle = $('#act-title');
    this.actNum = $('#act-num');
    this.dil = $('#dilation');
    this.dilSub = $('#dilation-sub');
    this.clockEl = $('#clock');
    this.stat = $('#stat');
    this.caption = $('#caption');
    this.nav = $('#act-nav');
    this.badge = $('#badge');
    this.receipt = new Receipt($('#receipt'), timeline);
    this.captionText = null;
    this.onJump = null;


    const t = timeline.trace;
    const bits = [];
    if (t.source === 'synthetic') bits.push('Illustrative trace generated in the browser');
    else bits.push(`Trace from mmdecode · ${t.messageCount.toLocaleString()} messages`);
    bits.push(t.counters ? (t.source === 'synthetic' ? 'counters illustrative' : `counters measured via ${t.rdpmc ? 'rdpmc' : 'read()'}`) : 'stalls inferred from timing');
    this.badge.textContent = bits.join(' · ');
  }

  // The story bar: one section per act, sized by its number of beats, with a tick per beat.
  // Clicking jumps to that act at the beat under the pointer.
  buildNav(beatsPerAct) {
    this.nav.innerHTML = '';
    this.navActs = beatsPerAct.map((beats, i) => {
      const seg = el('div', 'story-act');
      seg.style.flexGrow = String(Math.max(2, beats.length));
      seg.innerHTML = `<div class="story-label"><span class="nav-n">${ACTS[i].n}</span> ${ACTS[i].title}</div><div class="story-track"><i></i></div>`;
      const track = seg.querySelector('.story-track');
      beats.forEach((_, k) => {
        if (k === 0) return;
        const tick = el('span', 'story-tick');
        tick.style.left = `${(k / beats.length) * 100}%`;
        track.append(tick);
      });
      seg.addEventListener('click', (e) => {
        const r = track.getBoundingClientRect();
        const f = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
        if (this.onJump) this.onJump(i, beats[Math.floor(f * beats.length)]);
      });
      this.nav.append(seg);
      return { seg, fill: seg.querySelector('i') };
    });
  }

  setProgress(act, fraction) {
    if (!this.navActs) return;
    this.navActs.forEach((a, k) => {
      const f = k < act ? 1 : k > act ? 0 : fraction;
      a.fill.style.width = `${f * 100}%`;
      a.seg.classList.toggle('current', k === act);
    });
  }

  setAct(i) {
    this.actNum.textContent = ACTS[i].n;
    this.actTitle.textContent = ACTS[i].title;
  }

  setDilation(d, held = false) {
    if (held) {
      this.dil.textContent = 'held';
      this.dilSub.textContent = 'the clock is stopped for a look around';
      return;
    }
    this.dil.textContent = fmtDilation(d);
    this.dilSub.textContent = d < 1.5 ? 'real time' : `1 second on screen = ${fmtNs(1e9 / d)}`;
  }

  setClock(text) {
    this.clockEl.textContent = text || '';
  }

  setStat(html) {
    if (this.statHtml === html) return;
    this.statHtml = html;
    this.stat.innerHTML = html || '';
  }

  setCaption(text) {
    if (text === this.captionText) return;
    this.captionText = text;
    this.caption.classList.remove('show');
    clearTimeout(this.captionTimer);
    this.captionTimer = setTimeout(() => {
      this.caption.innerHTML = text || '';
      if (text) this.caption.classList.add('show');
    }, 220);
  }
}

import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { dust, fmtNs } from '../fx.js';
import { SOURCES } from '../code.js';
import { PAGES, INTRO, OUTRO, ACCESS } from '../walkthrough.js';
import { STAGE_TITLES } from '../journey.js';

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KEYWORDS = /\b(auto|bool|break|case|char|const|default|else|for|if|int64_t|return|size_t|std|switch|uint8_t|uint16_t|uint32_t|uint64_t|void|while)\b/g;
const hl = (line) => escape(line).replace(KEYWORDS, '<span class="k">$1</span>') || ' ';

// Bars run on a log scale from 1 ns to 600 ns, so a 1 ns hit and a 300 ns tree walk both read.
const logPos = (ns) => Math.min(1, Math.log10(Math.max(1, ns)) / Math.log10(600));

// Act VI is a reading section: one page per stage, with the code of both builds side by side.
export class CodeWalkAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 0.5;
    const s = this.scene;
    s.background = new THREE.Color(0x02030a);
    s.add(dust(1500, 0.05, new THREE.Vector3(60, 30, 40), 0x6f8fb8, 0.25));
    this.camera.position.set(0, 0, 20);

    this.root = document.getElementById('walk');
    this.stats = this.measure();
    const pages = [{ id: 'intro', ...INTRO }, ...PAGES.map((p) => ({ id: `stage-${p.stage}`, ...p })), { id: 'outro', ...OUTRO }];
    this.pages = pages;
    const hold = (p) => 10 + p.body.join(' ').length / 22;
    this.script = new Script(pages.map((p) => ({ id: p.id, hold: hold(p), onStart: () => this.render(p) })));
  }

  // Per stage: the featured message's time in each build, the median across the trace, and the
  // share of stage time spent waiting on memory (from counters, or inferred from timing).
  measure() {
    const tl = this.timeline;
    const hero = tl.hero;
    return STAGE_TITLES.map((_, s) => tl.lanes.map((ls) => {
      const times = [];
      let wait = 0, total = 0;
      const stride = Math.max(1, Math.floor(ls.n / 6000));
      for (let i = 0; i < ls.n; i += stride) {
        if (ls.dropped[i]) continue;
        const d = ls.stageNs(i, s);
        if (d <= 0) continue;
        times.push(d);
        total += d;
        for (const e of ls.stalls(i)[s]) wait += e.len;
      }
      times.sort((a, b) => a - b);
      return {
        featured: ls.stageNs(hero, s),
        median: times.length ? times[Math.floor(times.length / 2)] : 0,
        p99: times.length ? times[Math.floor(times.length * 0.99)] : 0,
        waiting: total > 0 ? wait / total : 0,
      };
    }));
  }

  render(page) {
    const n = this.pages.indexOf(page);
    const stage = page.stage;
    const nav = `<div class="walk-nav"><button class="chip" data-go="-1">← Back</button><span>${n + 1} / ${this.pages.length}</span><button class="chip primary-chip" data-go="1">Next →</button></div>`;
    let html = `<div class="walk-head"><div class="eyebrow">${stage == null ? 'Act VI' : `Stage ${stage + 1} of 6`}</div><h2>${page.title}</h2>${nav}</div>`;
    if (stage == null) {
      html += `<div class="walk-prose wide">${page.body.map((p) => `<p>${p}</p>`).join('')}${this.legend()}</div>`;
    } else {
      const [nv, tu] = this.stats[stage];

      html += `<div class="walk-stats">
        ${this.statCell('Featured message', nv.featured, tu.featured)}
        ${this.statCell('Median across the trace', nv.median, tu.median)}
        ${this.timeline.trace.counters
          ? `<div class="stat"><div class="k">Time waiting on memory (from hardware counters)</div><div><span class="n">${Math.round(nv.waiting * 100)}%</span> <span class="t">${Math.round(tu.waiting * 100)}%</span></div></div>`
          : this.statCell('Slowest 1% across the trace', nv.p99, tu.p99)}
      </div>
      <div class="walk-body">
        <div class="walk-prose">${page.body.map((p) => `<p>${p}</p>`).join('')}${this.legend()}</div>
        <div class="walk-code">
          ${this.column('Naive', 'n', SOURCES[stage].naive, page.naive)}
          ${this.column('Tuned', 't', SOURCES[stage].tuned, page.tuned)}
        </div>
      </div>`;
    }
    this.root.innerHTML = html;
    this.root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => this.go(Number(b.dataset.go))));
  }

  statCell(label, naive, tuned) {
    return `<div class="stat"><div class="k">${label}</div><div><span class="n">${fmtNs(naive)}</span> <span class="t">${fmtNs(tuned)}</span></div></div>`;
  }

  legend() {
    const ticks = [1, 4, 14, 90, 300].map((ns) => `<span style="left:${logPos(ns) * 100}%">${ns} ns</span>`).join('');
    return `<div class="walk-legend"><div class="k">Typical cost of each marked line, log scale</div><div class="scale">${ticks}</div>
      <div class="k">L1 ~1 ns · L2 ~4 ns · L3 ~14 ns · DRAM ~90 ns · heap allocation 20 to 60 ns</div></div>`;
  }

  column(title, cls, lines, notes) {
    const rows = lines.map((line) => {
      const a = notes.find((x) => x.match.test(line));
      if (!a) return `<div class="ln">${hl(line)}</div>`;
      const kind = ACCESS[a.kind];
      const lo = logPos(a.cost[0]), hi = logPos(a.cost[1]);
      const range = a.cost[0] === a.cost[1] ? `~${a.cost[0]} ns` : `${a.cost[0]} to ${a.cost[1]} ns`;
      return `<div class="ln lit" style="--lit:${kind.color}">${hl(line)}</div>
        <div class="ann" style="--lit:${kind.color}"><span class="cost"><i style="left:${lo * 100}%;width:${Math.max(2, (hi - lo) * 100)}%"></i></span><span class="what"><b>${kind.label}</b> · ${a.note} · ${range}</span></div>`;
    }).join('');
    return `<div class="walk-col ${cls}"><div class="title">${title}</div><pre>${rows}</pre></div>`;
  }

  go(step) {
    const i = Math.max(0, Math.min(this.pages.length - 1, this.script.i + step));
    this.script.reset();
    if (i > 0) this.script.skipTo(this.pages[i].id);
  }

  enter() {
    super.enter();
    this.root.hidden = false;
    document.body.classList.add('act-code');
  }

  exit() {
    super.exit();
    this.root.hidden = true;
    document.body.classList.remove('act-code');
  }

  update(dt, wallDt = dt) {
    super.update(dt);
    const t = performance.now() / 4000;
    this.camera.position.set(Math.sin(t) * 3, Math.cos(t * 0.7) * 1.5, 20);
    this.camera.lookAt(0, 0, 0);
    if (this.script.done) {
      this.script.reset();
      this.script.skipTo('outro');
    }
  }

  get finished() {
    return false;
  }

  get caption() {
    return null;
  }

  get dilation() {
    return 1;
  }

  get held() {
    return true;
  }

  get stat() {
    return '';
  }
}

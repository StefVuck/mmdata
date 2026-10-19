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
      // A stage counts if it ran: risk only when the signal fired, encode only for orders sent.
      const ran = (i) => !ls.dropped[i] && (s < 4 || (s === 4 ? ls.outcome[i] >= 1 : ls.outcome[i] === 2));
      for (let i = 0; i < ls.n; i += stride) {
        if (!ran(i)) continue;
        const d = ls.stageNs(i, s);
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
    const last = n === this.pages.length - 1;
    const nav = `<div class="walk-nav">${n > 0 ? '<button class="chip" data-go="-1">← Back</button>' : ''}<span>${n + 1} / ${this.pages.length}</span>${last
      ? '<button class="chip" data-exit="title">Back to the title</button><button class="chip primary-chip" data-exit="explore">Explore the CPU →</button>'
      : '<button class="chip primary-chip" data-go="1">Next →</button>'}<button class="chip ghost-chip" data-exit="title" title="Leave the walkthrough">✕</button></div>`;
    let html = `<div class="walk-head"><div class="eyebrow">${stage == null ? 'Act VI' : `Stage ${stage + 1} of 6`}</div><h2>${page.title}</h2>${nav}</div>`;
    if (stage == null) {
      html += `<div class="walk-prose wide">${page.body.map((p) => `<p>${p}</p>`).join('')}${page.id === 'intro' ? this.legend() : ''}</div>`;
      if (last) html += `<div class="walk-end"><button class="primary" data-exit="explore">Explore the CPU in free play</button><button data-exit="replay">Replay the journey from the exchange</button><button data-exit="title">Back to the title</button></div>`;
    } else {
      const [nv, tu] = this.stats[stage];
      const tr = this.timeline.trace;
      html += `<table class="walk-stats"><tr><th>Measured time for this stage</th><th class="n">Naive</th><th class="t">Tuned</th><th>Tuned is</th></tr>
        ${this.statRow('The featured message', nv.featured, tu.featured)}
        ${this.statRow('Typical message (median)', nv.median, tu.median)}
        ${this.statRow('Slowest 1% of messages', nv.p99, tu.p99)}
        ${tr.counters ? `<tr><td>Share spent waiting on memory (counters)</td><td class="n">${Math.round(nv.waiting * 100)}%</td><td class="t">${Math.round(tu.waiting * 100)}%</td><td></td></tr>` : ''}
      </table>${tr.timerNs > 2 ? `<div class="walk-warn">This trace was timed with a clock that ticks every ${tr.timerNs.toFixed(1)} ns, longer than most stages, so these numbers are approximate. The bundled trace was timed on x86.</div>` : ''}
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
    this.root.querySelectorAll('[data-exit]').forEach((b) => b.addEventListener('click', () => this.leave(b.dataset.exit)));
  }

  statRow(label, naive, tuned) {
    const f = (ns) => (ns < 1 ? 'under 1 ns' : fmtNs(ns));
    const ratio = tuned >= 1 && naive >= 1 ? (naive / tuned >= 1.15 ? `${(naive / tuned).toFixed(1)}× faster` : 'about the same') : '';
    return `<tr><td>${label}</td><td class="n">${f(naive)}</td><td class="t">${f(tuned)}</td><td class="r">${ratio}</td></tr>`;
  }

  // The cost scale the per-line bars use: a log axis from 1 ns to 600 ns with each level of
  // the memory hierarchy marked where it sits.
  legend() {
    const marks = [
      { ns: 1, label: 'L1', note: '~1 ns', color: '#3fd8ff' },
      { ns: 4, label: 'L2', note: '~4 ns', color: '#4f9dff' },
      { ns: 14, label: 'L3', note: '~14 ns', color: '#8a6bff' },
      { ns: 90, label: 'DRAM', note: '~90 ns', color: '#ff4fd8' },
    ].map((m) => `<div class="mark" style="left:${logPos(m.ns) * 100}%;--c:${m.color}"><b>${m.label}</b><span>${m.note}</span></div>`).join('');
    const alloc = `<div class="band" style="left:${logPos(20) * 100}%;width:${(logPos(60) - logPos(20)) * 100}%"><span>heap allocation, 20 to 60 ns</span></div>`;
    const ticks = [1, 10, 100, 600].map((ns) => `<span style="left:${logPos(ns) * 100}%">${ns} ns</span>`).join('');
    return `<div class="walk-legend"><div class="k">How to read the bars beside each marked line: typical cost of that kind of memory access, on a log scale</div>
      <div class="axis">${alloc}${marks}<div class="line"></div><div class="ticks">${ticks}</div></div></div>`;
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

  leave(where) {
    const d = this.ctx.director;
    if (where === 'title') d.toTitle();
    else if (where === 'replay') d.go(0, { portal: false });
    else {
      d.go(4, { portal: false });
      d.act.startFree();
    }
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

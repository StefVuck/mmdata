import naiveSrc from '../../decoder/src/naive_lane.cpp?raw';
import tunedSrc from '../../decoder/src/tuned_lane.cpp?raw';
import { STAGE_TITLES, LEVELS } from './journey.js';
import { fmtNs } from './fx.js';
import { KIND_BRANCH } from './timing.js';

// Snippets are cut from the decoder source at build time, so the film always shows the code
// that was measured. Which lines light up during a stall is an annotation: the lines that
// touch memory (or branch), not a per-line measurement.
const STAGES = [
  {
    why: 'Naive copies every message into a vector and builds a string to check the session. Tuned reads the header in place.',
    naive: { fns: ['frame'], memory: /current_\.assign|std::string session/ },
    tuned: { fns: ['frame'], memory: /be(16|64)\(c\.packet/ },
  },
  {
    why: 'Naive parses byte by byte with bounds checks and allocates a polymorphic message on the heap. Tuned loads fields at fixed offsets into a struct that never moves.',
    naive: { fns: ['decode', 'read_be'], memory: /make_unique|symbol\(|current_\.at/ },
    tuned: { fns: ['decode'], memory: /be(32|64)\(p|symbols_\[/ },
  },
  {
    why: 'Naive finds orders in a node-based hash map and keeps each price level in a std::map keyed by symbol string: pointer chasing all the way. Tuned indexes orders by reference into one flat table and keeps levels in a best-first array.',
    naive: { fns: ['book', 'add_to_level'], memory: /orders_|books_|dynamic_cast/ },
    tuned: { fns: ['book', 'find', 'apply'], memory: /table_\[|insert\(|find\(|lv\[|books_\[/ },
  },
  {
    why: 'Naive copies both sides of the book into fresh vectors to compute an imbalance it barely uses. Tuned reads one flag and the best level.',
    naive: { fns: ['signal'], memory: /books_\.at|std::vector<std::pair|bids\[|asks\[/ },
    tuned: { fns: ['signal'], memory: /books_\[|same\[0\]/ },
  },
  {
    why: 'Naive looks positions up in a std::map keyed by string. Tuned indexes an array by stock locate.',
    naive: { fns: ['risk'], memory: /positions_\[/ },
    tuned: { fns: ['risk'], memory: /positions_\[/ },
  },
  {
    why: 'Naive builds the order with string appends and to_string, then pushes it into a vector. Tuned patches a few fields of a pre-filled template.',
    naive: { fns: ['encode'], memory: /out \+=|sent_\.push_back|to_string|padded\(/ },
    tuned: { fns: ['encode'], memory: /outbox_|memcpy|symbols_\[/ },
  },
];
const BRANCHY = /\b(if|switch|while|for|case)\b|\?/;

function extract(src, cls, fn) {
  const m = new RegExp(`^[^\\n;]*\\b${cls}::${fn}\\(`, 'm').exec(src);
  if (!m) return `// ${cls}::${fn} not found`;
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(m.index, i + 1);
}

const KEYWORDS = /\b(auto|bool|break|case|char|const|continue|default|double|else|for|if|int64_t|new|return|size_t|static_cast|std|switch|uint8_t|uint16_t|uint32_t|uint64_t|void|while|int)\b/g;

function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(line) {
  const comment = line.indexOf('//');
  const code = comment >= 0 ? line.slice(0, comment) : line;
  let html = escape(code)
    .replace(/(&quot;|"[^"]*"|'[^']*')/g, '<span class="s">$1</span>')
    .replace(KEYWORDS, '<span class="k">$1</span>')
    .replace(/\b(0x[0-9a-fA-F]+u?|\d+u?)\b/g, '<span class="n">$1</span>');
  if (comment >= 0) html += `<span class="c">${escape(line.slice(comment))}</span>`;
  return html || ' ';
}

function build(src, cls, fns) {
  return fns.map((fn) => extract(src, cls, fn)).join('\n\n').split('\n');
}

const SOURCES = STAGES.map((s) => ({
  naive: build(naiveSrc, 'NaiveLane', s.naive.fns),
  tuned: build(tunedSrc, 'TunedLane', s.tuned.fns),
}));

export class CodeCard {
  constructor() {
    this.root = document.getElementById('code');
    this.root.innerHTML = `
      <div class="code-head"><span class="code-stage"></span><span class="code-why"></span></div>
      <div class="code-cols">
        <div class="code-col lane-0"><div class="code-title"></div><pre></pre></div>
        <div class="code-col lane-1"><div class="code-title"></div><pre></pre></div>
      </div>
      <div class="code-foot">Lit lines touch memory or branch. Which of them stalled is an annotation; the stall itself is measured.</div>`;
    this.stageEl = this.root.querySelector('.code-stage');
    this.whyEl = this.root.querySelector('.code-why');
    this.cols = [...this.root.querySelectorAll('.code-col')].map((c) => ({
      title: c.querySelector('.code-title'),
      pre: c.querySelector('pre'),
      key: '',
      titleText: '',
    }));
    this.stage = -1;
    this.visible = false;
  }

  setVisible(v) {
    this.visible = v;
    this.root.hidden = !v;
  }

  // states: per lane, what the focused message is doing ({phase, stage, kind}) or null.
  update(stage, times, states) {
    if (!this.visible || stage < 0) return;
    if (stage !== this.stage) {
      this.stage = stage;
      this.stageEl.textContent = STAGE_TITLES[stage];
      this.whyEl.textContent = STAGES[stage].why;
    }
    ['naive', 'tuned'].forEach((name, lane) => {
      const col = this.cols[lane];
      const st = states[lane];
      const here = st && st.stage === stage;
      const kind = here && st.kind != null ? st.kind : -1;
      const spec = STAGES[stage][name];
      const pattern = kind === KIND_BRANCH ? BRANCHY : spec.memory;
      const key = `${stage}:${kind}`;
      if (key !== col.key) {
        col.key = key;
        const color = kind < 0 ? null : kind === KIND_BRANCH ? '#ff6b5b' : `#${LEVELS[kind].color.toString(16).padStart(6, '0')}`;
        let first = null;
        col.pre.innerHTML = SOURCES[stage][name].map((line, i) => {
          const lit = color && pattern.test(line);
          if (lit && first == null) first = i;
          return `<div class="ln${lit ? ' lit' : ''}"${lit ? ` style="--lit:${color}"` : ''}>${highlight(line)}</div>`;
        }).join('');
        if (first != null) col.pre.children[first].scrollIntoView({ block: 'center', behavior: 'smooth' });
        else col.pre.scrollTop = 0;
      }
      const label = kind < 0 ? '' : kind === KIND_BRANCH ? ' · branch mispredict' : ` · waiting on ${LEVELS[kind].id}`;
      const status = here ? `running${label}` : st && st.phase === 1 ? 'waiting in the queue' : '';
      const text = `${name === 'naive' ? 'Naive' : 'Tuned'} · ${times[lane] > 0 ? fmtNs(times[lane]) : 'did not run'}${status ? ` · ${status}` : ''}`;
      if (text !== col.titleText) {
        col.titleText = text;
        col.title.textContent = text;
      }
    });
  }
}

import { loadTrace } from './trace.js';
import { syntheticTrace } from './synthetic.js';
import { Timeline } from './timing.js';
import { Director } from './director.js';
import { TYPE_NAMES } from './journey.js';
import { fmtNs } from './fx.js';
import { TitleBook } from './titlebook.js';

async function boot() {
  const params = new URLSearchParams(location.search);
  const source = params.get('trace') || 'trace.bin';
  let trace;
  if (source === 'synthetic') {
    trace = syntheticTrace();
  } else {
    try {
      trace = await loadTrace(source);
    } catch (err) {
      console.warn(`could not load ${source}, using a synthetic trace`, err);
      trace = syntheticTrace();
    }
  }

  const timeline = new Timeline(trace);
  const director = new Director(timeline);
  window.director = director;

  const hero = timeline.hero;
  const type = String.fromCharCode(trace.msgType[hero]);
  const core = director.acts[4];
  document.getElementById('race-card').innerHTML = `Two builds of the same trading code on two cores. In this trace, tick to trade is <em>${fmtNs(core.tickToTrade(1))}</em> for the tuned build and <em>${fmtNs(core.tickToTrade(0))}</em> for the naive one.`;
  document.getElementById('title-meta').innerHTML = [
    trace.source === 'synthetic'
      ? 'Trace: illustrative, generated in the browser'
      : `Trace: ${trace.messageCount.toLocaleString()} synthetic ITCH messages around the 09:30 open`,
    `Featured: an ${TYPE_NAMES[type] || type} message on ${trace.heroSymbol}`,
    trace.timerNs > 2 ? `<span style="color:#ffb02e">Timed with a ${trace.timerNs.toFixed(1)} ns clock: numbers are approximate</span>` : '',
  ].filter(Boolean).join(' · ');

  const title = document.getElementById('title');
  const backdrop = new TitleBook(document.getElementById('title-bg'), trace);
  backdrop.start();
  // Restart the backdrop whenever the title screen comes back.
  new MutationObserver(() => {
    if (title.classList.contains('gone')) backdrop.stop();
    else backdrop.start();
  }).observe(title, { attributes: true, attributeFilter: ['class'] });
  const begin = (act) => {
    title.classList.add('gone');
    document.body.classList.remove('intro');
    director.start(act);
  };
  document.getElementById('begin').addEventListener('click', () => begin(0));
  document.getElementById('skip').addEventListener('click', () => begin(4));
  document.getElementById('code-btn').addEventListener('click', () => begin(5));

  if (params.has('act')) {
    begin(Number(params.get('act')) - 1);
    const beat = params.get('beat');
    if (beat) director.act.script.skipTo(beat);
    const advance = Number(params.get('advance') || 0);
    for (let k = 0; k < advance * 30; k++) director.act.update(1 / 30);
    if (params.has('hud') && params.get('hud') === '0') document.getElementById('hud').classList.add('hidden');
    if (params.has('paused')) director.paused = true;
  }
}

boot();

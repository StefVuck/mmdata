import { loadTrace } from './trace.js';
import { syntheticTrace } from './synthetic.js';
import { Timeline } from './timing.js';
import { Director } from './director.js';
import { TYPE_NAMES } from './journey.js';
import { fmtNs } from './fx.js';

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
  const [naive, tuned] = timeline.heroStats;
  const total = (h) => h.queue + h.stages.reduce((a, b) => a + b, 0);
  document.getElementById('title-meta').innerHTML = [
    trace.source === 'synthetic'
      ? 'Trace: illustrative, generated in the browser'
      : `Trace: ${trace.messageCount.toLocaleString()} ITCH messages in ${trace.packetTotal.toLocaleString()} MoldUDP64 packets`,
    `Featured packet: ${timeline.heroPacketCount} messages, carrying ${TYPE_NAMES[type] || type} on ${trace.heroSymbol}`,
    `Software time for it: tuned ${fmtNs(total(tuned))}, naive ${fmtNs(total(naive))}`,
  ].join('<br>');

  const title = document.getElementById('title');
  const begin = (act) => {
    title.classList.add('gone');
    document.body.classList.remove('intro');
    director.start(act);
  };
  document.getElementById('begin').addEventListener('click', () => begin(0));
  document.getElementById('skip').addEventListener('click', () => begin(4));

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

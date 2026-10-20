// Narration and ambience. Narration plays recordings made by tools/narrate.mjs (listed in
// audio/manifest.json) and falls back to the browser's own voice for any line without one.
// Ambience is synthesised with Web Audio: one bed per act, crossfaded as the story moves.
import { speakable, lineKey } from './speech.js';

const SETTINGS_KEY = 'trade-slowmo-sound';

function load() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function save(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage blocked: settings just won't persist.
  }
}

export class Sound {
  constructor() {
    const s = load();
    this.narrationOn = s.narration ?? true;
    this.ambienceOn = s.ambience ?? true;
    this.manifest = {};
    this.current = null;
    this.currentText = '';
    this.ctx = null;
    this.beds = [];
    this.act = -1;
    this.ducked = false;
    fetch('audio/manifest.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { this.manifest = m.lines || {}; })
      .catch(() => {});
  }

  get recorded() {
    return Object.keys(this.manifest).length > 0;
  }

  persist() {
    save({ narration: this.narrationOn, ambience: this.ambienceOn });
  }

  // Seconds the line for this caption takes to say, so a beat can wait for it. Nothing is said
  // until a click or key unlocks audio, so until then nothing waits.
  seconds(html) {
    if (!this.ctx || !this.narrationOn || !html) return 0;
    const text = speakable(html);
    const rec = this.manifest[lineKey(text)];
    if (rec) return rec.seconds;
    return 'speechSynthesis' in window ? text.length / 14 : 0;
  }

  // Must be called from a user gesture: browsers only allow audio after one.
  unlock() {
    if (this.ctx) return this.ctx.resume();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.ambienceOn ? 1 : 0;
    this.master.connect(this.ctx.destination);
    this.beds = BEDS.map((make) => {
      const out = this.ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);
      make(this.ctx, out);
      return out;
    });
    if (this.act >= 0) this.setAct(this.act);
  }

  setAct(i) {
    this.act = i;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.beds.forEach((g, k) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(k === i ? 1 : 0, t, 0.8);
    });
  }

  setAmbience(on) {
    this.ambienceOn = on;
    this.persist();
    this.applyLevel();
  }

  applyLevel() {
    if (!this.master) return;
    const level = this.ambienceOn ? (this.ducked ? 0.45 : 1) : 0;
    this.master.gain.setTargetAtTime(level, this.ctx.currentTime, 0.4);
  }

  setNarration(on) {
    this.narrationOn = on;
    this.persist();
    if (!on) this.stop();
  }

  // Called every frame with the caption on screen; starts a line when it changes.
  say(html) {
    const text = this.ctx && this.narrationOn ? speakable(html) : '';
    if (text === this.currentText) return;
    this.stop();
    this.currentText = text;
    if (!text) return;
    const rec = this.manifest[lineKey(text)];
    if (rec) {
      const a = new Audio(`audio/${rec.file}`);
      a.onended = () => this.duck(false);
      a.play().catch(() => {});
      this.current = a;
      this.duck(true);
    } else if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      u.voice = voices.find((v) => /Daniel|Google UK English Male|Alex|Arthur/i.test(v.name)) || null;
      u.rate = 0.92;
      u.pitch = 0.8;
      u.onend = () => this.duck(false);
      speechSynthesis.speak(u);
      this.current = 'synth';
      this.duck(true);
    }
  }

  stop() {
    if (this.current instanceof Audio) this.current.pause();
    else if (this.current === 'synth') speechSynthesis.cancel();
    this.current = null;
    this.currentText = '';
    this.duck(false);
  }

  pause(paused) {
    if (this.current instanceof Audio) {
      if (paused) this.current.pause();
      else this.current.play().catch(() => {});
    } else if (this.current === 'synth') {
      if (paused) speechSynthesis.pause();
      else speechSynthesis.resume();
    }
    if (this.ctx) {
      if (paused) this.ctx.suspend();
      else this.ctx.resume();
    }
  }

  duck(on) {
    this.ducked = on;
    this.applyLevel();
  }
}

// ---- Ambience beds, one per act ----

function noise(ctx, seconds = 4, brown = false) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start();
  return src;
}

function tone(ctx, freq, type, gain, out) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = gain;
  o.connect(g).connect(out);
  o.start();
  return { o, g };
}

function lfo(ctx, rate, depth, param) {
  const o = ctx.createOscillator();
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(param);
  o.start();
}

function filtered(ctx, src, type, freq, q, gain, out) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(out);
  return f;
}

const BEDS = [
  // I. The exchange: a data hall, fans and mains hum.
  (ctx, out) => {
    filtered(ctx, noise(ctx, 4, true), 'lowpass', 380, 0.7, 0.32, out);
    tone(ctx, 50, 'sine', 0.05, out);
    tone(ctx, 100, 'sine', 0.025, out);
    const air = filtered(ctx, noise(ctx), 'bandpass', 1400, 0.6, 0.02, out);
    lfo(ctx, 0.07, 400, air.frequency);
  },
  // II. The fibre: a thin, high shimmer moving past.
  (ctx, out) => {
    const f = filtered(ctx, noise(ctx), 'bandpass', 3200, 6, 0.05, out);
    lfo(ctx, 0.15, 1500, f.frequency);
    tone(ctx, 880, 'sine', 0.008, out);
    tone(ctx, 1320, 'sine', 0.005, out);
    filtered(ctx, noise(ctx, 4, true), 'lowpass', 160, 0.7, 0.12, out);
  },
  // III. The switch: electrical buzz.
  (ctx, out) => {
    const b = tone(ctx, 120, 'sawtooth', 0.02, out);
    lfo(ctx, 0.3, 0.008, b.g.gain);
    filtered(ctx, noise(ctx, 4, true), 'lowpass', 300, 0.7, 0.18, out);
    tone(ctx, 240, 'sine', 0.01, out);
  },
  // IV. The network card: softer buzz with a faint high whine.
  (ctx, out) => {
    tone(ctx, 60, 'sine', 0.05, out);
    tone(ctx, 6200, 'sine', 0.0025, out);
    filtered(ctx, noise(ctx, 4, true), 'lowpass', 240, 0.7, 0.16, out);
  },
  // V. The core: a deep, slow pulse.
  (ctx, out) => {
    const a = tone(ctx, 55, 'sine', 0.07, out);
    tone(ctx, 82.4, 'sine', 0.03, out);
    lfo(ctx, 0.25, 0.03, a.g.gain);
    const f = filtered(ctx, noise(ctx), 'lowpass', 500, 2, 0.03, out);
    lfo(ctx, 0.05, 300, f.frequency);
  },
  // VI. The code: almost silence, a quiet pad.
  (ctx, out) => {
    tone(ctx, 110, 'sine', 0.018, out);
    tone(ctx, 164.8, 'sine', 0.012, out);
    filtered(ctx, noise(ctx, 4, true), 'lowpass', 200, 0.7, 0.06, out);
  },
];

export const sound = new Sound();

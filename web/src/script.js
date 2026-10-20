// Runs an act as a list of beats. A beat either advances simulated time by `sim` ns at a
// time dilation of `dilation`, or holds the clock still for `hold` wall seconds.
// `sim` and `dilation` may be functions, resolved when the beat starts.
import { sound } from './audio.js';

// The whole story runs a fifth slower than the beats are written, to leave time to read.
export const PACE = 1.2;

export class Script {
  constructor(beats, initialDilation = 1e8) {
    this.beats = beats;
    this.initialDilation = initialDilation;
    this.reset();
  }

  reset() {
    this.i = 0;
    this.sim = 0;
    this.beatSim = 0;
    this.beatWall = 0;
    this.done = false;
    this.started = false;
    this.dilation = this.initialDilation;
    this.cur = null;
    this.lastCaption = null;
  }

  get beat() {
    return this.beats[this.i];
  }

  get id() {
    return this.beat ? this.beat.id : 'end';
  }

  get held() {
    return !!this.cur && this.cur.hold != null;
  }

  get caption() {
    if (this.cur) return this.cur.caption;
    const c = this.beat ? this.beat.caption : null;
    return typeof c === 'function' ? null : c;
  }

  get progress() {
    if (!this.cur) return 0;
    if (this.cur.hold != null) return Math.min(1, this.beatWall / this.cur.hold);
    return this.cur.sim > 0 ? Math.min(1, this.beatSim / this.cur.sim) : 1;
  }

  begin() {
    const b = this.beat;
    const val = (x) => (typeof x === 'function' ? x() : x);
    this.cur = { sim: val(b.sim), hold: val(b.hold), dilation: val(b.dilation) };
    this.cur.caption = val(b.caption);
    if (this.cur.hold != null) this.cur.hold *= PACE;
    if (this.cur.dilation) this.cur.dilation *= PACE;
    this.fitNarration();
    if (b.snapDilation && this.cur.dilation) this.dilation = this.cur.dilation;
    this.started = true;
    if (b.onStart) b.onStart();
  }

  // A beat lasts at least as long as its narration. Moving beats slow down to fit; anything
  // still short waits at the end.
  fitNarration() {
    const c = this.cur;
    const fresh = c.caption && c.caption !== this.lastCaption;
    this.lastCaption = c.caption;
    const said = fresh ? sound.seconds(c.caption) : 0;
    if (!said) return;
    const need = said + 0.8;
    if (c.hold != null) {
      c.hold = Math.max(c.hold, need);
      return;
    }
    c.minWall = need;
    if (c.sim > 0 && c.dilation) {
      const wall = (c.sim * c.dilation) / 1e9;
      if (wall < need) c.dilation *= need / wall;
    }
  }

  finish() {
    const b = this.beat;
    if (b.onEnd) b.onEnd();
    this.i++;
    this.beatSim = 0;
    this.beatWall = 0;
    this.started = false;
    this.cur = null;
    if (this.i >= this.beats.length) this.done = true;
  }

  // Jump to the start of the beat with this id, fast-forwarding simulated time.
  skipTo(id) {
    while (!this.done && this.id !== id) {
      if (!this.started) this.begin();
      if (this.cur.sim != null) this.sim += this.cur.sim - this.beatSim;
      this.finish();
    }
  }

  update(dt) {
    if (this.done) return;
    if (!this.started) this.begin();
    const c = this.cur;
    if (c.dilation) {
      const k = 1 - Math.exp(-dt * 2.5);
      this.dilation = Math.exp(Math.log(this.dilation) + (Math.log(c.dilation) - Math.log(this.dilation)) * k);
    }
    this.beatWall += dt;
    if (c.sim != null) {
      const ds = (dt * 1e9) / this.dilation;
      const left = c.sim - this.beatSim;
      if (ds >= left) {
        if (this.beatWall < (c.minWall || 0)) {
          this.sim += left;
          this.beatSim = c.sim;
          return;
        }
        this.beatSim = c.sim;
        this.sim += left;
        this.finish();
      } else {
        this.beatSim += ds;
        this.sim += ds;
      }
    } else if (this.beatWall >= (c.hold || 0)) {
      this.finish();
    }
  }
}

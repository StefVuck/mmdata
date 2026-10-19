// Runs an act as a list of beats. A beat either advances simulated time by `sim` ns at a
// time dilation of `dilation`, or holds the clock still for `hold` wall seconds.
// `sim` and `dilation` may be functions, resolved when the beat starts.

const CHARS_PER_SECOND = 13;

export function readingSeconds(html) {
  if (!html) return 0;
  return 4 + html.replace(/<[^>]*>/g, '').length / CHARS_PER_SECOND;
}

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
    // Every beat lasts at least as long as its caption takes to read. A held beat waits longer;
    // a moving beat slows down rather than cutting the text short.
    const read = readingSeconds(this.cur.caption);
    if (this.cur.hold != null) this.cur.hold = Math.max(this.cur.hold, read);
    else if (this.cur.sim > 0 && this.cur.dilation) {
      this.cur.dilation = Math.max(this.cur.dilation, (read * 1e9) / this.cur.sim);
    }
    if (b.snapDilation && this.cur.dilation) this.dilation = this.cur.dilation;
    this.started = true;
    if (b.onStart) b.onStart();
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

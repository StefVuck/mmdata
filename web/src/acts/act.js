import * as THREE from 'three';

export class Act {
  constructor(ctx) {
    this.ctx = ctx;
    this.timeline = ctx.timeline;
    this.receipt = ctx.hud.receipt;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.02, 3000);
    this.script = null;
    this.receiptIds = [];
  }

  enter() {
    if (this.script) this.script.reset();
  }

  exit() {
    this.scene.traverse((o) => {
      if (o.isCSS2DObject) o.element.remove();
    });
  }

  // dt is simulated-clock wall time (zero while paused); wallDt always runs, for cameras.
  update(dt, wallDt = dt) {
    if (this.script) this.script.update(dt);
  }

  completeReceipt() {
    for (const id of this.receiptIds) this.receipt.set(id, 1);
  }

  resize(aspect) {
    const design = 16 / 9;
    const base = 50;
    const fov = aspect >= design ? base
      : (2 * Math.atan(Math.tan((base * Math.PI) / 360) * (design / aspect)) * 180) / Math.PI;
    this.camera.fov = Math.min(fov, 96);
    this.camera.aspect = aspect;
    // In portrait the captions and controls fill the bottom of the screen, so centre the
    // scene in the space above them.
    const w = window.innerWidth, h = window.innerHeight;
    if (aspect < 1) this.camera.setViewOffset(w, h, 0, h * 0.17, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  get finished() { return this.script ? this.script.done : false; }
  get dilation() { return this.script ? this.script.dilation : 1; }
  get held() { return this.script ? this.script.held : false; }
  get caption() { return this.script ? this.script.caption : null; }
  get clockText() { return ''; }
  get storyProgress() {
    const s = this.script;
    if (!s) return 0;
    return s.done ? 1 : Math.min(1, (s.i + s.progress) / s.beats.length);
  }
  get stat() { return ''; }

  // Time on the journey clock, which starts when the packet enters the firm's cross-connect.
  journeyClock(ns) {
    const sign = ns < 0 ? '−' : '+';
    return `journey clock ${sign}${Math.abs(ns).toFixed(1)} ns`;
  }
}

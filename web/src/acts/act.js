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
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  get finished() { return this.script ? this.script.done : false; }
  get dilation() { return this.script ? this.script.dilation : 1; }
  get held() { return this.script ? this.script.held : false; }
  get caption() { return this.script ? this.script.caption : null; }
  get clockText() { return ''; }
  get stat() { return ''; }

  // Time on the journey clock, which starts when the packet enters the firm's cross-connect.
  journeyClock(ns) {
    const sign = ns < 0 ? '−' : '+';
    return `journey clock ${sign}${Math.abs(ns).toFixed(1)} ns`;
  }
}

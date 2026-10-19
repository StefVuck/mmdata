import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import { Hud } from './ui.js';
import { smooth } from './fx.js';
import { ExchangeAct } from './acts/exchange.js';
import { FibreAct } from './acts/fibre.js';
import { SwitchAct } from './acts/switch.js';
import { NicAct } from './acts/nic.js';
import { CoreAct } from './acts/core.js';

const PORTAL_OUT = 0.7;
const PORTAL_IN = 0.9;

export class Director {
  constructor(timeline) {
    this.timeline = timeline;
    const stage = document.getElementById('stage');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    stage.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer({ element: document.getElementById('labels') });
    this.labels.setSize(window.innerWidth, window.innerHeight);

    this.hud = new Hud(timeline);
    this.hud.onJump = (i) => this.go(i, { portal: false });
    this.whiteout = document.getElementById('whiteout');
    this.pauseBtn = document.getElementById('pause-btn');
    this.pauseBtn.addEventListener('click', () => { this.paused = !this.paused; });

    const ctx = { timeline, hud: this.hud, director: this };
    this.acts = [new ExchangeAct(ctx), new FibreAct(ctx), new SwitchAct(ctx), new NicAct(ctx), new CoreAct(ctx)];

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.acts[0].scene, this.acts[0].camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.35, 0.55);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.current = -1;
    this.paused = false;
    this.autoAdvance = true;
    this.transition = null;
    this.timer = new THREE.Timer();

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.key(e));
  }

  get act() {
    return this.acts[this.current];
  }

  start(i) {
    this.switchTo(i);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  go(i, { portal = true } = {}) {
    if (i < 0 || i >= this.acts.length) return;
    if (portal) this.transition = { phase: 'out', t: 0, next: i };
    else {
      this.transition = { phase: 'in', t: PORTAL_IN * 0.5 };
      this.switchTo(i);
    }
  }

  switchTo(i) {
    if (this.act) this.act.exit();
    this.current = i;
    const act = this.act;
    this.hud.receipt.clear();
    for (let k = 0; k < i; k++) this.acts[k].completeReceipt();
    act.resize(window.innerWidth / window.innerHeight);
    act.enter();
    this.renderPass.scene = act.scene;
    this.renderPass.camera = act.camera;
    this.bloom.strength = act.bloomStrength ?? 0.6;
    this.bloom.threshold = act.bloomThreshold ?? 0.55;
    this.hud.setAct(i);
  }

  key(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { this.paused = !this.paused; e.preventDefault(); }
    else if (e.code === 'ArrowRight') this.go(this.current + 1);
    else if (e.code === 'ArrowLeft') this.go(this.current - 1, { portal: false });
    else if (e.code === 'KeyH') document.getElementById('hud').classList.toggle('hidden');
    else if (e.code === 'KeyR') this.go(0, { portal: false });
    else if (/^Digit[1-5]$/.test(e.code)) this.go(Number(e.code.slice(5)) - 1, { portal: false });
    else if (this.act && this.act.key) this.act.key(e);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.acts.forEach((a) => a.resize(w / h));
  }

  // A fixed step can be passed in to render frame by frame, as the GIF capture does.
  frame(step) {
    this.timer.update();
    const dt = step ?? Math.min(this.timer.getDelta(), 1 / 20);
    const act = this.act;
    act.update(this.paused ? 0 : dt, dt);

    if (act.finished && !this.transition && this.autoAdvance && this.current < this.acts.length - 1) {
      this.go(this.current + 1);
    }

    let white = 0;
    const tr = this.transition;
    if (tr) {
      tr.t += dt;
      if (tr.phase === 'out') {
        white = smooth(tr.t / PORTAL_OUT);
        if (tr.t >= PORTAL_OUT) {
          this.switchTo(tr.next);
          this.transition = { phase: 'in', t: 0 };
          white = 1;
        }
      } else {
        white = 1 - smooth(tr.t / PORTAL_IN);
        if (tr.t >= PORTAL_IN) this.transition = null;
      }
    }
    this.whiteout.style.opacity = String(white);
    const base = this.act.bloomStrength ?? 0.6;
    this.bloom.strength = base + white * 2;

    const a = this.act;
    this.hud.setDilation(a.dilation, a.held);
    this.hud.setClock(a.clockText);
    this.hud.setStat(a.stat);
    this.hud.setCaption(a.caption || (this.paused ? 'Paused' : null));
    this.hud.caption.classList.toggle('paused', this.paused);
    const label = this.paused ? '▶ Play' : '❚❚ Pause';
    if (this.pauseBtn.textContent !== label) this.pauseBtn.textContent = label;
    this.pauseBtn.classList.toggle('paused', this.paused);

    this.composer.render();
    this.labels.render(a.scene, a.camera);
  }
}

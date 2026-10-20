import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { Comet, Follow, glow, label, lineMaterial, wireBox, polyline, smooth, lerp, dust } from '../fx.js';
import { FIBRE_NS_PER_M, WIRE } from '../journey.js';

const PORTS = 16;
const PORT_X = (i) => -6.4 + (i * 12.8) / (PORTS - 1);
const FRONT = 5;
const IN_PORT = 0;
const SERVER_PORT = 11;
const SUBSCRIBERS = [2, 4, 5, 7, 9, 11, 13, 15];
const GHOST_Y = 4.6;
const SERVER_Y = -4.8;

function portPath(i, y, outward) {
  const x = PORT_X(i);
  const pts = [
    new THREE.Vector3(x, y + 0.35, FRONT + 0.9),
    new THREE.Vector3(x, y + 0.35, FRONT),
    new THREE.Vector3(x, y + 0.05, 2.2),
    new THREE.Vector3(x * 0.25, y + 0.05, 1.0),
    new THREE.Vector3(0, y + 0.1, 0),
  ];
  if (outward) pts.reverse();
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
}

export class SwitchAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 0.6;
    this.receiptIds = ['switch', 'patch'];
    const s = this.scene;
    s.background = new THREE.Color(0x02040a);
    s.fog = new THREE.FogExp2(0x02040a, 0.022);
    s.add(dust(1200, 0.04, new THREE.Vector3(40, 20, 30), 0x8fb0e0, 0.3));

    this.buildChassis(0, 0x5b8cff, 'Layer 1 switch', true);
    this.buildChassis(GHOST_Y, 0x5d6b85, 'Conventional switch, for comparison', false);
    this.buildServer();

    this.inPath = portPath(IN_PORT, 0, false);
    this.outPaths = SUBSCRIBERS.map((i) => portPath(i, 0, true));
    this.ghostIn = portPath(IN_PORT, GHOST_Y, false);

    const portOut = new THREE.Vector3(PORT_X(SERVER_PORT), 0.35, FRONT + 0.9);
    this.nicPort = new THREE.Vector3(PORT_X(SERVER_PORT) - 1.2, SERVER_Y + 0.35, FRONT + 0.9);
    this.patch = new THREE.CatmullRomCurve3([
      portOut,
      portOut.clone().add(new THREE.Vector3(0.3, -0.4, 1.4)),
      new THREE.Vector3(portOut.x + 0.6, -2.4, FRONT + 2.4),
      this.nicPort.clone().add(new THREE.Vector3(0.2, 0.6, 1.4)),
      this.nicPort.clone(),
    ], false, 'centripetal');
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.patch, 120, 0.06, 8), new THREE.MeshBasicMaterial({
      color: 0xffd23f, transparent: true, opacity: 0.25, depthWrite: false,
    })));
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.inPath, 60, 0.012, 6), glow(0x3fd8ff, 0.25)));
    const feed = new THREE.CatmullRomCurve3([
      new THREE.Vector3(PORT_X(IN_PORT) - 3, 0.35, FRONT + 6),
      new THREE.Vector3(PORT_X(IN_PORT) - 0.5, 0.35, FRONT + 3),
      new THREE.Vector3(PORT_X(IN_PORT), 0.35, FRONT + 0.9),
    ]);
    s.add(new THREE.Mesh(new THREE.TubeGeometry(feed, 40, 0.06, 8), new THREE.MeshBasicMaterial({
      color: 0xffd23f, transparent: true, opacity: 0.25, depthWrite: false,
    })));
    const fromExchange = label('From the exchange', 'label');
    fromExchange.position.copy(feed.getPointAt(0)).add(new THREE.Vector3(0, 0.5, 0));
    s.add(fromExchange);

    this.inComet = new Comet(0x9fe8ff, { radius: 0.07, length: 34 });
    this.outComets = this.outPaths.map((_, k) => new Comet(SUBSCRIBERS[k] === SERVER_PORT ? 0xbff4ff : 0x3f8cff, { radius: 0.06, length: 26 }));
    this.patchComet = new Comet(0xbff4ff, { radius: 0.07, length: 40 });
    this.ghostComet = new Comet(0x8fa4c8, { radius: 0.06, length: 22 });
    for (const c of [this.inComet, ...this.outComets, this.patchComet, this.ghostComet]) s.add(c.mesh);

    this.ghostLabel = label('', 'label ghost', true);
    this.ghostLabel.position.set(0, GHOST_Y + 1.6, 0);
    s.add(this.ghostLabel);

    this.follow = new Follow(this.camera, 2.4);
    this.patchNs = WIRE.patchMetres * FIBRE_NS_PER_M;
    this.script = new Script([
      { id: 'intro', hold: 6,
        caption: 'The firm’s switch is a <em>layer 1</em> switch. It never reads the packet. It repeats the signal, electrically, to every port that subscribes.' },
      { id: 'cross', sim: WIRE.switchNs, dilation: 1.2e9, snapDilation: true,
        caption: 'Five nanoseconds, port to port. The conventional switch above is still taking the frame into its buffer.' },
      { id: 'patch', sim: this.patchNs, dilation: 4e8,
        caption: 'Three metres of patch cord to the trading server: another fifteen nanoseconds.' },
      { id: 'arrive', hold: 1.2, caption: 'Into the network card.' },
    ]);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
  }

  buildChassis(y, color, name, main) {
    const s = this.scene;
    const box = wireBox(15, 1.6, 10, color, main ? 0.7 : 0.35, main ? 0.025 : 0.015);
    box.position.set(0, y, 0);
    s.add(box);
    for (let i = 0; i < PORTS; i++) {
      for (const row of [0.35, -0.35]) {
        const lit = main && row > 0 && (i === IN_PORT || SUBSCRIBERS.includes(i));
        const cage = wireBox(0.62, 0.42, 0.7, lit ? 0x3fd8ff : color, lit ? 0.8 : 0.35, lit ? 0.08 : 0.02);
        cage.position.set(PORT_X(i), y + row, FRONT + 0.25);
        s.add(cage);
      }
      s.add(polyline(portPath(i, y, false).getPoints(20), color, main ? 0.22 : 0.12));
    }
    const chip = wireBox(2.6, 0.3, 2.6, main ? 0x3fd8ff : color, main ? 0.9 : 0.4, main ? 0.12 : 0.04);
    chip.position.set(0, y + 0.1, 0);
    s.add(chip);
    if (main) {
      this.chip = chip;
      const l = label('Crosspoint', 'label cyan');
      l.position.set(0, y + 0.9, 0);
      s.add(l);
    } else {
      const buffer = wireBox(2.2, 0.5, 1.2, 0xff9f43, 0.6, 0.08);
      buffer.position.set(0, y + 0.3, -2.2);
      s.add(buffer);
      this.buffer = buffer;
      const b = label('Packet buffer', 'label');
      b.position.set(0, y + 1.1, -2.2);
      s.add(b);
    }
    const n = label(name, main ? 'label big' : 'label');
    n.position.set(-8.6, y + 1.3, FRONT);
    s.add(n);
  }

  buildServer() {
    const box = wireBox(15, 1.6, 10, 0x3fffb0, 0.3, 0.008);
    box.position.set(0, SERVER_Y, 0);
    this.scene.add(box);
    const nic = wireBox(5, 0.5, 3.5, 0x3fffb0, 0.6, 0.03);
    nic.position.set(PORT_X(SERVER_PORT) - 1.2, SERVER_Y + 0.3, FRONT - 1.8);
    this.scene.add(nic);
    const l = label('Trading server · network card', 'label big tuned');
    l.position.set(-8.4, SERVER_Y + 1.3, FRONT);
    this.scene.add(l);
  }

  enter() {
    super.enter();
    this.follow.snap = true;
  }

  update(dt) {
    super.update(dt);
    const sc = this.script;
    const id = sc.id;
    const pIn = 0.4;
    const crossP = id === 'intro' ? -1 : id === 'cross' ? sc.progress : 1;
    const patchP = id === 'patch' ? sc.progress : id === 'arrive' || sc.done ? 1 : 0;

    const along = (curve, p, spacing) => (i, out) => curve.getPointAt(Math.max(0, Math.min(1, p - i * spacing)), out);
    const inP = crossP < 0 ? 0 : Math.min(1, crossP / pIn);
    this.inComet.update(along(this.inPath, inP, 0.018), crossP >= 0 && crossP < pIn + 0.25);
    const outP = crossP < pIn ? -1 : (crossP - pIn) / (1 - pIn);
    this.outComets.forEach((c, k) => {
      const server = SUBSCRIBERS[k] === SERVER_PORT;
      c.update(along(this.outPaths[k], Math.min(1, outP), 0.022), outP >= 0 && (!server || patchP <= 0.05));
    });
    this.patchComet.update(along(this.patch, patchP, 0.012), patchP > 0);

    // The comparison: a conventional switch takes the frame into its buffer and sits on it.
    const elapsed = (id === 'intro' ? 0 : sc.sim);
    const gp = Math.min(1, elapsed / (WIRE.switchNs * 0.9));
    this.ghostComet.update((i, out) => {
      if (gp < 1) return this.ghostIn.getPointAt(Math.max(0, gp - i * 0.02), out);
      out.set(Math.sin(i * 1.7) * 0.7, GHOST_Y + 0.3 + Math.cos(i * 2.3) * 0.15, -2.2 + Math.sin(i * 0.9) * 0.4);
      return out;
    }, id !== 'intro');
    if (this.buffer) this.buffer.userData.fill.material.opacity = gp >= 1 ? 0.08 + 0.06 * Math.sin(performance.now() / 200) : 0.04;
    this.ghostLabel.element.innerHTML = id === 'intro' ? 'Typical cut-through switch: ~350 ns'
      : `Still buffered: ${elapsed.toFixed(1)} ns of ~${WIRE.conventionalSwitchNs} ns`;

    if (this.chip) this.chip.userData.fill.material.opacity = crossP >= pIn - 0.05 && crossP < pIn + 0.2 ? 0.45 : 0.12;

    this.receipt.set('switch', crossP < 0 ? 0 : crossP);
    this.receipt.set('patch', patchP);

    const pos = this.v, look = this.v2;
    if (id === 'intro') {
      const k = smooth(sc.progress);
      pos.set(lerp(20, 11, k), lerp(9, 4.5, k), lerp(22, 15, k));
      look.set(lerp(0, -2, k), 0, lerp(0, 2, k));
    } else if (id === 'cross') {
      pos.set(-2.5, 6, 16.5);
      look.set(-0.5, 0.8, 1.5);
    } else {
      const head = this.patch.getPointAt(Math.min(1, patchP));
      const k = id === 'arrive' ? smooth(sc.progress) : 0;
      pos.copy(head).add(new THREE.Vector3(lerp(3.2, 0.6, k), lerp(1.4, 0.2, k), lerp(4.2, 1.0, k)));
      look.copy(head).add(new THREE.Vector3(0, -0.2, -1));
    }
    this.follow.update(dt, pos, look);
  }

  get clockText() {
    const base = WIRE.fibreMetres * FIBRE_NS_PER_M;
    return this.journeyClock(base + (this.script.id === 'intro' ? 0 : this.script.sim));
  }

  get stat() {
    const id = this.script.id;
    if (id === 'patch' || id === 'arrive') return `<span class="k">patch cord</span> ${WIRE.patchMetres} m · ${this.patchNs.toFixed(1)} ns`;
    return `<span class="k">port to port</span> ${WIRE.switchNs} ns`;
  }
}

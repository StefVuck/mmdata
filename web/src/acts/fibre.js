import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { Comet, Follow, glow, label, smooth, dust, lineMaterial } from '../fx.js';
import { FIBRE_NS_PER_M, WIRE } from '../journey.js';

// The cross-connect is drawn schematically: a tray run, a spool and a short exit run. Metres
// along the real fibre map piecewise onto distance along the drawn curve.
const SECTIONS = [
  { id: 'tray', metres: 30 },
  { id: 'coil', metres: 55 },
  { id: 'exit', metres: 15 },
];
const R = 3.2;
const TURNS = 5;
const PITCH = 0.42;
const CORE_R = 0.035;
const CLAD_R = 0.11;

export class FibreAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 0.9;
    this.bloomThreshold = 0.3;
    this.receiptIds = ['fibre'];
    const s = this.scene;
    s.background = new THREE.Color(0x010308);
    s.fog = new THREE.FogExp2(0x010308, 0.03);

    const pts = [];
    const bounds = [0];
    const trayLen = 30;
    for (let i = 0; i <= 60; i++) {
      const x = (i / 60) * trayLen;
      pts.push(new THREE.Vector3(x - trayLen, 0.25 * Math.sin(i / 9), 0.2 * Math.sin(i / 13)));
    }
    bounds.push(pts.length - 1);
    const C = new THREE.Vector3(0, 0.25 * Math.sin(60 / 9), 0.2 * Math.sin(60 / 13) + R);
    const steps = TURNS * 72;
    for (let i = 1; i <= steps; i++) {
      const th = -Math.PI / 2 + (i / steps) * TURNS * Math.PI * 2;
      pts.push(new THREE.Vector3(C.x + R * Math.cos(th), C.y + (PITCH * (th + Math.PI / 2)) / (Math.PI * 2), C.z + R * Math.sin(th)));
    }
    bounds.push(pts.length - 1);
    const exitStart = pts[pts.length - 1].clone();
    for (let i = 1; i <= 30; i++) pts.push(exitStart.clone().add(new THREE.Vector3((i / 30) * 15, 0, 0)));
    bounds.push(pts.length - 1);
    this.coilCentre = C.clone().add(new THREE.Vector3(0, (PITCH * TURNS) / 2, 0));

    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const lengths = this.curve.getLengths(pts.length - 1);
    const total = lengths[lengths.length - 1];
    this.uBounds = bounds.map((b) => lengths[b] / total);
    this.length = total;

    const segs = 2400;
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.curve, segs, 0.2, 14), new THREE.MeshBasicMaterial({
      color: 0xc9a227, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false,
    })));
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.curve, segs, CLAD_R, 14), glow(0x9fd8ff, 0.025)));
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.curve, segs, CORE_R, 8), glow(0x3fd8ff, 0.07)));
    this.frames = this.curve.computeFrenetFrames(4000, false);

    // Neighbouring fibres in the tray, and the tray itself.
    for (let k = 0; k < 8; k++) {
      const off = new THREE.Vector3(0, -1.5 - (k % 2) * 0.45, -2.6 + k * 0.75);
      const g = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 46, 10, 1, true), new THREE.MeshBasicMaterial({
        color: 0xc9a227, transparent: true, opacity: 0.04, depthWrite: false, side: THREE.DoubleSide,
      }));
      g.rotation.z = Math.PI / 2;
      g.position.set(-14, off.y, off.z);
      s.add(g);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 46, 4), glow(0x3fd8ff, 0.05));
      core.rotation.z = Math.PI / 2;
      core.position.copy(g.position);
      s.add(core);
    }
    const tray = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(46, 0.05, 6.4)), lineMaterial(0x2a3d60, 0.6));
    tray.position.set(-14, -2.25, 0);
    s.add(tray);

    // The spool flanges.
    for (const y of [-0.3, PITCH * TURNS + 0.3]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.55, R * 1.35, 96), glow(0x5b8cff, 0.05, { side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(C.x, C.y + y, C.z);
      s.add(ring);
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 97 }, (_, i) => new THREE.Vector3(Math.cos((i / 96) * Math.PI * 2) * R * 1.35, 0, Math.sin((i / 96) * Math.PI * 2) * R * 1.35)),
      ), lineMaterial(0x5b8cff, 0.4));
      edge.position.copy(ring.position);
      s.add(edge);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.55, R * 0.55, PITCH * TURNS + 0.6, 48, 1, true), glow(0x5b8cff, 0.03, { side: THREE.DoubleSide }));
    hub.position.copy(this.coilCentre);
    s.add(hub);
    const spoolLabel = label('Spool · 55 m of extra fibre', 'label big');
    spoolLabel.position.copy(this.coilCentre).add(new THREE.Vector3(0, 1.8, 0));
    s.add(spoolLabel);

    const endLabel = label('To our switch', 'label cyan');
    endLabel.position.copy(this.curve.getPointAt(1)).add(new THREE.Vector3(0, 0.6, 0));
    s.add(endLabel);

    s.add(dust(2500, 0.03, new THREE.Vector3(70, 14, 24), 0x9fc0ff, 0.4));

    this.comet = new Comet(0xbff4ff, { radius: 0.045, length: 70 });
    s.add(this.comet.mesh);
    this.follow = new Follow(this.camera, 2.6);

    const ns = (m) => m * FIBRE_NS_PER_M;
    this.script = new Script([
      { id: 'tray', sim: ns(30), dilation: 3e7, snapDilation: true,
        caption: 'Our cross-connect: 100 metres of single-mode fibre. Light in glass covers one metre every <b>4.9 nanoseconds</b>.' },
      { id: 'coil', sim: ns(55), dilation: 2.4e7,
        caption: 'Exchanges give every firm the same length of cable, so a firm whose rack is close is handed a spool of extra fibre. Proximity buys nothing here.' },
      { id: 'exit', sim: ns(15), dilation: 3e7,
        caption: () => {
          const v = 1e9 / FIBRE_NS_PER_M / 3e7;
          const like = v < 2.5 ? 'someone walking' : v < 5 ? 'a jogger' : v < 9 ? 'a sprinter' : 'a cyclist';
          return `Slowed thirty million times, light is moving at ${v.toFixed(1)} m/s, about as fast as ${like}.`;
        } },
    ], 3e7);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
    this.tmpN = new THREE.Vector3();
  }

  metresAt() {
    return this.script.sim / FIBRE_NS_PER_M;
  }

  uAt(metres) {
    let acc = 0;
    for (let k = 0; k < SECTIONS.length; k++) {
      const m = SECTIONS[k].metres;
      if (metres <= acc + m || k === SECTIONS.length - 1) {
        const f = Math.max(0, Math.min(1, (metres - acc) / m));
        return this.uBounds[k] + f * (this.uBounds[k + 1] - this.uBounds[k]);
      }
      acc += m;
    }
    return 1;
  }

  // Ray-optics picture: the light zig-zags between the core walls as it goes.
  pointAt(u, out) {
    this.curve.getPointAt(u, out);
    const idx = Math.min(this.frames.normals.length - 1, Math.round(u * (this.frames.normals.length - 1)));
    const phase = (u * this.length) / 0.35;
    const tri = 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
    out.addScaledVector(this.frames.normals[idx], tri * CORE_R * 0.9);
    return out;
  }

  enter() {
    super.enter();
    this.follow.snap = true;
  }

  update(dt) {
    super.update(dt);
    const metres = this.metresAt();
    const u = this.uAt(metres);
    const step = 0.0009 * (180 / this.length);
    this.comet.update((i, out) => this.pointAt(Math.max(0, u - i * step * 0.35), out), true);
    this.receipt.set('fibre', metres / WIRE.fibreMetres);

    const id = this.script.id;
    const head = this.curve.getPointAt(u);
    const tan = this.curve.getTangentAt(u);
    const pos = this.v, look = this.v2;
    if (id === 'coil') {
      const k = smooth(this.script.progress * 3) * (1 - smooth((this.script.progress - 0.82) * 5.5));
      const chase = head.clone().addScaledVector(tan, -2.4).add(new THREE.Vector3(0, 0.6, 1.1));
      const wide = this.coilCentre.clone().add(new THREE.Vector3(9, 6.5, 11));
      pos.copy(chase).lerp(wide, k);
      look.copy(head).addScaledVector(tan, 1.2).lerp(this.coilCentre, k * 0.8);
    } else {
      pos.copy(head).addScaledVector(tan, -2.4).add(new THREE.Vector3(0, 0.55, 1.0));
      look.copy(head).addScaledVector(tan, 1.6);
      if (id === 'end' || this.script.done) {
        pos.copy(head).addScaledVector(tan, -0.4);
      }
    }
    this.follow.update(dt, pos, look);
  }

  get clockText() {
    return this.journeyClock(this.script.sim);
  }

  get stat() {
    const m = this.metresAt();
    const speed = 1e9 / FIBRE_NS_PER_M / this.dilation;
    return `<span class="k">fibre</span> ${m.toFixed(1)} m of ${WIRE.fibreMetres} m<br><span class="k">light on screen</span> ${speed.toFixed(1)} m/s`;
  }
}

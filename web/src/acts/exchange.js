import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { Comet, Follow, glow, label, lineMaterial, wireBox, smooth, lerp, dust } from '../fx.js';
import { FIBRE_NS_PER_M } from '../journey.js';

const ROWS = [-15, -9, -3, 3, 9, 15];
const RACK = { w: 0.6, h: 2.1, d: 1.0, pitch: 0.66 };
const ENGINE = new THREE.Vector3(-31, 1.2, 0);
const PORT = new THREE.Vector3(32.2, 1.55, 0);

export class ExchangeAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 0.6;
    const s = this.scene;
    s.background = new THREE.Color(0x02040a);
    s.fog = new THREE.FogExp2(0x02040a, 0.018);

    s.add(new THREE.HemisphereLight(0x6a8ac0, 0x05070c, 1.1));
    for (let x = -28; x <= 28; x += 14) {
      const l = new THREE.PointLight(0x7fb0ff, 18, 24, 1.6);
      l.position.set(x, 4.5, 0);
      s.add(l);
    }

    this.buildFloor();
    this.buildRacks();
    this.buildTrays();
    this.buildEngine();
    this.buildMeetMe();
    s.add(dust(1500, 0.05, new THREE.Vector3(80, 8, 40), 0x8fb0e0, 0.35));

    const pts = [
      ENGINE.clone().add(new THREE.Vector3(0.6, 0.2, 0)),
      new THREE.Vector3(-29.8, 2.2, 0),
      new THREE.Vector3(-28.8, 2.95, 0),
      new THREE.Vector3(-20, 2.95, 0),
      new THREE.Vector3(0, 2.95, 0),
      new THREE.Vector3(20, 2.95, 0),
      new THREE.Vector3(29.4, 2.95, 0),
      new THREE.Vector3(30.8, 2.1, 0),
      new THREE.Vector3(31.4, 1.55, 0),
      PORT.clone(),
    ];
    this.path = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.pathLength = this.path.getLength();
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.path, 400, 0.02, 6), glow(0xffd23f, 0.12)));

    this.comet = new Comet(0x9fe8ff, { radius: 0.05, length: 50 });
    s.add(this.comet.mesh);
    this.follow = new Follow(this.camera, 2.2);

    this.publishNs = this.pathLength * FIBRE_NS_PER_M;
    this.script = new Script([
      { id: 'establish', hold: 6, caption: 'An exchange data centre. Hundreds of trading firms rent racks a few metres from the one machine that matters.' },
      { id: 'engine', hold: 5, caption: 'Inside the <em>matching engine</em>, an incoming sell order meets a resting buy. <b>That is the trade.</b>' },
      { id: 'publish', sim: this.publishNs, dilation: 3.5e7, snapDilation: true,
        caption: 'The exchange publishes the execution as a multicast ITCH packet, to every subscriber at once.' },
      { id: 'meetme', hold: 1.6, caption: 'At the meet-me room it is handed to the trading firm’s cross-connect. From here, every nanosecond goes on the receipt.' },
    ]);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
  }

  buildFloor() {
    const grid = new THREE.GridHelper(90, 90, 0x1b2a44, 0x0c1424);
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    this.scene.add(grid);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x03060c, roughness: 0.35, metalness: 0.6 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    this.scene.add(floor);
  }

  buildRacks() {
    const xs = [];
    for (let x = -26; x <= 28; x += RACK.pitch) xs.push(x);
    const count = ROWS.length * xs.length;
    const geo = new THREE.BoxGeometry(RACK.w, RACK.h, RACK.d);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a2232, emissive: 0x05080f, roughness: 0.45, metalness: 0.6 });
    const racks = new THREE.InstancedMesh(geo, mat, count);
    const ledsPer = 7;
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.025, 0.01), glow(0xffffff, 1), count * ledsPer);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const palette = [0x2bff88, 0x3fd8ff, 0x3fd8ff, 0xffb02e, 0x2bff88];
    let k = 0, j = 0;
    for (const z of ROWS) {
      const face = z < 0 ? 1 : -1;
      for (const x of xs) {
        m.makeTranslation(x, RACK.h / 2, z);
        racks.setMatrixAt(k++, m);
        for (let l = 0; l < ledsPer; l++) {
          m.makeTranslation(x - 0.2 + Math.random() * 0.4, 0.2 + Math.random() * 1.8, z + face * (RACK.d / 2 + 0.01));
          leds.setMatrixAt(j, m);
          c.setHex(palette[(Math.random() * palette.length) | 0]).multiplyScalar(0.4 + Math.random() * 1.6);
          leds.setColorAt(j++, c);
        }
      }
    }
    this.scene.add(racks, leds);
    // Thin light strips along the top front edge of every row give the hall its shape.
    for (const z of ROWS) {
      const face = z < 0 ? 1 : -1;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(xs[xs.length - 1] - xs[0] + RACK.w, 0.015, 0.015), glow(0x5b8cff, 0.6));
      strip.position.set((xs[0] + xs[xs.length - 1]) / 2, RACK.h + 0.01, z + face * (RACK.d / 2));
      this.scene.add(strip);
    }
    this.leds = leds;
    this.ledBase = Float32Array.from(leds.instanceColor.array);

    const names = ['Firm racks', 'Firm racks', 'Firm racks'];
    names.forEach((n, i) => {
      const l = label(n, 'label');
      l.position.set(-10 + i * 18, 2.6, ROWS[i * 2 + 1] + 1.2);
      this.scene.add(l);
    });
  }

  buildTrays() {
    for (const z of [...ROWS, 0]) {
      const tray = wireBox(60, 0.06, 0.45, 0x2a3d60, 0.5, 0.05);
      tray.position.set(1, z === 0 ? 2.85 : 2.6, z);
      this.scene.add(tray);
      for (let f = 0; f < 4; f++) {
        const fibre = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 60, 4), glow(0xffd23f, 0.05));
        fibre.rotation.z = Math.PI / 2;
        fibre.position.set(1, (z === 0 ? 2.9 : 2.65), z - 0.15 + f * 0.1);
        this.scene.add(fibre);
      }
    }
  }

  buildEngine() {
    const g = new THREE.Group();
    for (let i = -1; i <= 1; i++) {
      const rack = wireBox(0.7, 2.3, 1.1, 0x3fd8ff, 0.7, 0.04);
      rack.position.set(ENGINE.x - 0.3, 1.15, i * 1.6);
      g.add(rack);
    }
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), glow(0x3fd8ff, 0.55));
    core.position.copy(ENGINE);
    g.add(core);
    this.core = core;

    const cage = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(4.2, 2.8, 7)),
      lineMaterial(0x3fd8ff, 0.25),
    );
    cage.position.set(ENGINE.x + 0.2, 1.4, 0);
    g.add(cage);

    const l = label('Matching engine', 'label big cyan');
    l.position.set(ENGINE.x, 3.2, 0);
    g.add(l);

    this.buy = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 2), glow(0x3fffb0, 1));
    this.sell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 2), glow(0xff4f7a, 1));
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 3), glow(0xffffff, 0));
    this.flash.position.copy(ENGINE).add(new THREE.Vector3(1.0, 0, 0));
    g.add(this.buy, this.sell, this.flash);

    this.buyLabel = label('Resting buy · 300 @ 187.34', 'label tuned');
    this.sellLabel = label('Incoming sell · 300 @ 187.34', 'label naive');
    this.buy.add(this.buyLabel);
    this.sell.add(this.sellLabel);
    this.buyLabel.position.set(0, -0.25, 0);
    this.sellLabel.position.set(0, 0.6, 0);
    this.scene.add(g);
  }

  buildMeetMe() {
    const wall = wireBox(0.3, 2.6, 4, 0xffc44d, 0.6, 0.05);
    wall.position.set(PORT.x + 0.2, 1.3, 0);
    this.scene.add(wall);
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 10; c++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 0.08), glow(0xffc44d, c === 5 && r === 3 ? 0.9 : 0.18));
        p.position.set(PORT.x + 0.02, 0.6 + r * 0.38, -1.7 + c * 0.38);
        this.scene.add(p);
      }
    }
    const l = label('Meet-me room · the firm’s cross-connect', 'label big gold');
    l.position.set(PORT.x, 3.2, 0);
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
    const p = sc.progress;
    const t = performance.now() / 1000;

    if (dt > 0 && Math.random() < 0.5) {
      const arr = this.leds.instanceColor.array;
      for (let n = 0; n < 60; n++) {
        const k = ((Math.random() * arr.length) / 3) | 0;
        const on = Math.random() < 0.7 ? 1 : 0.1;
        arr[k * 3] = this.ledBase[k * 3] * on;
        arr[k * 3 + 1] = this.ledBase[k * 3 + 1] * on;
        arr[k * 3 + 2] = this.ledBase[k * 3 + 2] * on;
      }
      this.leds.instanceColor.needsUpdate = true;
    }
    this.core.material.opacity = 0.4 + 0.2 * Math.sin(t * 3);

    // The match: a resting buy waits, an incoming sell arrives and they meet in a flash.
    const meet = this.flash.position;
    const matchP = id === 'establish' ? 0 : id === 'engine' ? p : 1;
    this.buy.position.copy(meet).add(new THREE.Vector3(0, -0.25, 0));
    const approach = smooth(matchP / 0.6);
    this.sell.position.copy(meet).add(new THREE.Vector3(lerp(3.5, 0, approach), lerp(1.2, 0.25, approach), lerp(2.5, 0, approach)));
    const flashT = (matchP - 0.6) / 0.4;
    const matched = matchP >= 0.6;
    this.flash.material.opacity = matched && id === 'engine' ? Math.max(0, 1 - flashT) * 0.8 : 0;
    this.flash.scale.setScalar(1 + (matched ? flashT * 3 : 0));
    this.buy.visible = this.sell.visible = !matched || id === 'engine';
    this.buy.material.opacity = this.sell.material.opacity = matched ? Math.max(0, 1 - flashT * 2) : 1;
    this.buyLabel.visible = this.sellLabel.visible = id === 'engine' && !matched;

    const travelling = id === 'publish' || id === 'meetme';
    const s = id === 'publish' ? sc.beatSim / FIBRE_NS_PER_M : id === 'meetme' ? this.pathLength : 0;
    this.comet.update((i, out) => {
      const u = Math.max(0, Math.min(1, (s - i * 0.09) / this.pathLength));
      this.path.getPointAt(u, out);
    }, travelling);

    const pos = this.v, look = this.v2;
    if (id === 'establish') {
      const k = smooth(p);
      pos.set(lerp(36, -14, k), lerp(26, 6, k), lerp(34, 13, k));
      look.set(lerp(0, ENGINE.x, k), lerp(0, 1.2, k), 0);
      this.follow.snap = true;
    } else if (id === 'engine') {
      pos.set(-25.6, 2.0, 4.8);
      look.copy(meet);
    } else if (id === 'publish') {
      const u = Math.min(1, s / this.pathLength);
      const head = this.path.getPointAt(u);
      const tan = this.path.getTangentAt(u);
      pos.copy(head).addScaledVector(tan, -5).add(new THREE.Vector3(0, 1.3, 3.4));
      look.copy(head).addScaledVector(tan, 1.5);
    } else {
      pos.copy(PORT).add(new THREE.Vector3(-0.6 - 2 * (1 - p), 0.05, 0.25 * (1 - p)));
      look.copy(PORT).add(new THREE.Vector3(1, 0, 0));
    }
    this.follow.update(dt, pos, look);
  }

  get clockText() {
    const id = this.script.id;
    if (id === 'publish') return `${(this.script.beatSim).toFixed(0)} ns since publication`;
    return 'exchange time · before the journey clock starts';
  }

  get stat() {
    const id = this.script.id;
    if (id === 'publish' || id === 'meetme') {
      const m = id === 'meetme' ? this.pathLength : this.script.beatSim / FIBRE_NS_PER_M;
      return `<span class="k">across the hall</span> ${m.toFixed(1)} m`;
    }
    return '';
  }
}

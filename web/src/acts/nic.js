import * as THREE from 'three';
import { Act } from './act.js';
import { Script } from '../script.js';
import { Comet, Follow, glow, label, lineMaterial, wireBox, polyline, smooth, lerp, dust } from '../fx.js';
import { FIBRE_NS_PER_M, WIRE, TYPE_COLORS, TYPE_NAMES } from '../journey.js';

const OPTIC = new THREE.Vector3(-11.4, 0.55, 1.5);
const DIODE = new THREE.Vector3(-10.2, 0.55, 1.5);
const CHIP = new THREE.Vector3(-3, 0.3, 0);
const SHELL_Y = 2.7;
const CPU = new THREE.Vector3(-5, -2.6, -11.5);
const CORE = new THREE.Vector3(-5.75, -2.2, -12.25);
const RING_Y = -0.5;
const RING_Z = -11.5;
const MAX_SHOWN = 14;

const SHELLS = [
  { name: 'Ethernet · 14 B header', size: [7.0, 2.6, 2.6], color: 0x5b8cff },
  { name: 'IPv4 · 20 B', size: [6.2, 2.2, 2.2], color: 0x6b9bff },
  { name: 'UDP · 8 B', size: [5.4, 1.85, 1.85], color: 0x8a6bff },
  { name: 'MoldUDP64 · 20 B', size: [4.6, 1.5, 1.5], color: 0x3fd8ff },
];

export class NicAct extends Act {
  constructor(ctx) {
    super(ctx);
    this.bloomStrength = 0.6;
    this.receiptIds = ['phy', 'pcie', 'poll'];
    const s = this.scene;
    s.background = new THREE.Color(0x020409);
    s.fog = new THREE.FogExp2(0x020409, 0.02);
    s.add(new THREE.HemisphereLight(0x5070a0, 0x020409, 0.8));
    s.add(dust(900, 0.03, new THREE.Vector3(40, 16, 36), 0x8fb0e0, 0.3));

    this.buildBoard();
    this.buildHost();
    this.buildPacket();

    this.lightPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-17, 0.55, 1.5), new THREE.Vector3(-13, 0.55, 1.5), DIODE.clone(),
    ]);
    this.tracePath = new THREE.CatmullRomCurve3([
      DIODE.clone(), new THREE.Vector3(-8.2, 0.1, 1.5), new THREE.Vector3(-5.2, 0.1, 0.9), CHIP.clone().add(new THREE.Vector3(-0.6, 0.1, 0.2)),
    ], false, 'centripetal');
    s.add(new THREE.Mesh(new THREE.TubeGeometry(this.tracePath, 60, 0.025, 6), glow(0xffb02e, 0.35)));
    this.lightComet = new Comet(0xbff4ff, { radius: 0.08, length: 30 });
    this.elecComet = new Comet(0xffb02e, { radius: 0.07, length: 30 });
    s.add(this.lightComet.mesh, this.elecComet.mesh);

    this.dmaPaths = this.messages.map((m, k) => new THREE.CatmullRomCurve3([
      m.home.clone(),
      new THREE.Vector3(1.2 + k * 0.15, 0.2, -2.6),
      new THREE.Vector3(3 + k * 0.2, -0.3, -4.4),
      new THREE.Vector3(4 + k * 0.25, -2.4, -6.8),
      new THREE.Vector3(this.cells[k].position.x, RING_Y + 1.2, RING_Z + 1.4),
      this.cells[k].position.clone(),
    ], false, 'centripetal'));

    this.ghostPath = new THREE.CatmullRomCurve3([
      CHIP.clone().add(new THREE.Vector3(-1, 0, -1.5)),
      new THREE.Vector3(-9, -1.2, -4.5),
      new THREE.Vector3(-12, -2.2, -6.2),
      new THREE.Vector3(-9.5, -2.3, -10),
      CPU.clone().add(new THREE.Vector3(-2.5, 0.4, 0)),
    ], false, 'centripetal');
    const dashed = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.ghostPath.getPoints(80)),
      new THREE.LineDashedMaterial({ color: 0x8fa4c8, dashSize: 0.25, gapSize: 0.2, transparent: true, opacity: 0.5 }));
    dashed.computeLineDistances();
    s.add(dashed);
    this.ghostComet = new Comet(0x8fa4c8, { radius: 0.08, length: 18 });
    s.add(this.ghostComet.mesh);

    this.follow = new Follow(this.camera, 2.2);
    this.script = new Script([
      { id: 'optic', sim: WIRE.opticPhyNs, dilation: 1e8, snapDilation: true,
        caption: 'The optic turns light back into an electrical signal, and the PHY recovers the bits.' },
      { id: 'unpack', sim: WIRE.macNs, dilation: 2e8,
        caption: () => `Ethernet, IP and UDP headers come off. Inside the MoldUDP64 packet are <b>${this.timeline.heroPacketCount} ITCH messages</b>, including the featured message.` },
      { id: 'dma', sim: WIRE.pcieNs, dilation: 2.5e7,
        caption: 'Kernel bypass: the card writes the messages straight into a ring buffer in the trading process’s memory over PCIe. No interrupt, no system call, no copy.' },
      { id: 'poll', sim: WIRE.pollNs, dilation: 1e8,
        caption: 'Core 3 does nothing but spin on that ring. On its next check it sees the new slot, and picks up the featured message.' },
    ], 1e8);
    this.v = new THREE.Vector3();
    this.v2 = new THREE.Vector3();
  }

  buildBoard() {
    const s = this.scene;
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(20, 0.12, 8),
      new THREE.MeshStandardMaterial({ color: 0x03160f, roughness: 0.6, metalness: 0.3 }));
    pcb.position.set(-1, 0, 0);
    s.add(pcb);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(pcb.geometry), lineMaterial(0x2bff88, 0.35));
    edge.position.copy(pcb.position);
    s.add(edge);
    for (let k = 0; k < 40; k++) {
      const z = -3.6 + Math.random() * 7.2;
      const x0 = -10 + Math.random() * 18;
      const pts = [new THREE.Vector3(x0, 0.07, z), new THREE.Vector3(x0 + 1 + Math.random() * 3, 0.07, z),
        new THREE.Vector3(x0 + 2 + Math.random() * 3, 0.07, z + (Math.random() - 0.5) * 2)];
      s.add(polyline(pts, 0x1f8f5a, 0.25));
    }
    const optic = wireBox(3.2, 1.0, 1.4, 0x9fd8ff, 0.6, 0.025);
    optic.position.copy(OPTIC);
    s.add(optic);
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4.2, 12), new THREE.MeshBasicMaterial({
      color: 0xc9a227, transparent: true, opacity: 0.12, depthWrite: false,
    }));
    stub.rotation.z = Math.PI / 2;
    stub.position.set(-15, 0.55, 1.5);
    s.add(stub);
    const diode = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 2), glow(0x9fd8ff, 0.6));
    diode.position.copy(DIODE);
    s.add(diode);
    this.diode = diode;
    const ol = label('Optic · photodiode', 'label cyan');
    ol.position.copy(OPTIC).add(new THREE.Vector3(0, 1.1, 0));
    s.add(ol);

    const chip = wireBox(3.6, 0.5, 3.6, 0xffb02e, 0.8, 0.08);
    chip.position.copy(CHIP);
    s.add(chip);
    this.chip = chip;
    const cl = label('PHY + MAC', 'label gold');
    cl.position.copy(CHIP).add(new THREE.Vector3(2.6, 0.7, 1.6));
    s.add(cl);

    for (let k = 0; k < 30; k++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.45), glow(0xffc44d, 0.4));
      f.position.set(0.5 + k * 0.26, 0.0, -4.1);
      s.add(f);
    }
    for (let k = 0; k < 8; k++) {
      s.add(polyline([CHIP.clone().add(new THREE.Vector3(1 + k * 0.08, -0.2, -1.8)),
        new THREE.Vector3(1.5 + k * 0.8, 0.07, -3.2), new THREE.Vector3(1.5 + k * 0.8, 0.07, -3.9)], 0xffb02e, 0.3));
    }
    const pl = label('PCIe', 'label');
    pl.position.set(4.4, 0.4, -4.6);
    s.add(pl);
  }

  buildHost() {
    const s = this.scene;
    const grid = new THREE.GridHelper(40, 40, 0x1b2a44, 0x0b1322);
    grid.position.set(0, -3, -8);
    s.add(grid);
    for (let k = 0; k < 16; k++) {
      const pts = [new THREE.Vector3(1 + k * 0.4, -0.05, -4.2), new THREE.Vector3(1.4 + k * 0.38, -2.4, -6.4),
        new THREE.Vector3(3.2 + k * 0.42, -2.9, -9.6)];
      s.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.02, 4), glow(0x5b8cff, 0.18)));
    }
    for (const z of [RING_Z, RING_Z - 0.9, RING_Z - 1.8]) {
      const dimm = wireBox(8.4, 2.4, 0.25, 0x8a6bff, 0.55, 0.05);
      dimm.position.set(7, -1.8, z);
      s.add(dimm);
    }
    this.cells = [];
    for (let k = 0; k < 16; k++) {
      const cell = wireBox(0.42, 0.3, 0.42, 0x8a6bff, 0.6, 0.05);
      cell.position.set(3.4 + k * 0.48, RING_Y, RING_Z);
      s.add(cell);
      this.cells.push(cell);
    }
    const rl = label('Ring buffer in process memory', 'label');
    rl.position.set(7, RING_Y + 0.9, RING_Z);
    s.add(rl);

    const cpu = wireBox(6, 0.6, 6, 0x3fffb0, 0.6, 0.04);
    cpu.position.copy(CPU);
    s.add(cpu);
    this.cores = [];
    for (let k = 0; k < 8; k++) {
      const c = wireBox(1.1, 0.12, 1.1, 0x3fffb0, k === 3 ? 0.9 : 0.3, k === 3 ? 0.25 : 0.03);
      c.position.set(CPU.x - 2.25 + (k % 4) * 1.5, CPU.y + 0.38, CPU.z - 0.75 + Math.floor(k / 4) * 1.5);
      s.add(c);
      this.cores.push(c);
    }
    CORE.copy(this.cores[3].position);
    const corel = label('Core 3 · spinning on the ring', 'label tuned');
    corel.position.copy(CORE).add(new THREE.Vector3(0, 0.9, 0));
    s.add(corel);
    this.pollRing = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.66, 48), glow(0x3fffb0, 0.6, { side: THREE.DoubleSide }));
    this.pollRing.rotation.x = -Math.PI / 2;
    this.pollRing.position.copy(CORE).add(new THREE.Vector3(0, 0.1, 0));
    s.add(this.pollRing);
    this.pollBeam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([CORE, CORE]), lineMaterial(0x3fffb0, 0.8));
    s.add(this.pollBeam);

    const kl = label('Kernel network stack, for comparison<br>interrupt · softirq · socket buffer · copy ≈ 5 µs', 'label ghost', true);
    kl.position.set(-12.5, -1.3, -6.2);
    s.add(kl);
  }

  buildPacket() {
    const s = this.scene;
    const tl = this.timeline;
    const trace = tl.trace;
    this.shells = SHELLS.map((d, k) => {
      const g = wireBox(...d.size, d.color, 0.7, 0.04);
      g.position.set(CHIP.x, SHELL_Y, CHIP.z);
      const l = label(k === 3 ? `${d.name} · seq ${tl.heroPacketFirst + 1}` : d.name, 'label shell');
      l.position.set(-d.size[0] / 2 + 0.2, d.size[1] / 2 + 0.05, d.size[2] / 2);
      l.center.set(0, 1);
      g.add(l);
      g.userData.label = l;
      s.add(g);
      return g;
    });

    const n = Math.min(tl.heroPacketCount, MAX_SHOWN);
    const heroRank = tl.hero - tl.heroPacketFirst;
    const first = Math.max(0, Math.min(heroRank - Math.floor(n / 2), tl.heroPacketCount - n));
    this.messages = [];
    for (let k = 0; k < n; k++) {
      const idx = tl.heroPacketFirst + first + k;
      const type = String.fromCharCode(trace.msgType[idx]);
      const hero = idx === tl.hero;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(hero ? 0.2 : 0.13, 2), glow(TYPE_COLORS[type] || TYPE_COLORS.default, 1));
      const home = new THREE.Vector3(CHIP.x - 1.8 + (n > 1 ? (k * 3.6) / (n - 1) : 1.8), SHELL_Y, CHIP.z);
      mesh.position.copy(home);
      s.add(mesh);
      if (hero) {
        const sym = trace.symbols.get(trace.msgLocate[idx]) || trace.heroSymbol;
        const l = label(`Featured · ${TYPE_NAMES[type] || type} · ${sym}`, 'label hero');
        l.position.set(0, 0.55, 0);
        mesh.add(l);
        this.heroLabel = l;
      }
      this.messages.push({ mesh, home, hero, type });
    }
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
    const order = ['optic', 'unpack', 'dma', 'poll', 'end'];
    const stage = order.indexOf(sc.done ? 'end' : id);
    const t = performance.now() / 1000;

    const opticP = stage === 0 ? p : 1;
    const lightP = Math.min(1, opticP / 0.45);
    const elecP = Math.max(0, (opticP - 0.45) / 0.55);
    this.lightComet.update((i, out) => this.lightPath.getPointAt(Math.max(0, lightP - i * 0.012), out), stage === 0 && lightP < 1.2);
    this.elecComet.update((i, out) => this.tracePath.getPointAt(Math.max(0, Math.min(1, elecP - i * 0.02)), out), stage === 0 && elecP > 0);
    this.diode.material.opacity = stage === 0 && lightP >= 1 && elecP < 0.3 ? 1.6 : 0.5;
    this.chip.userData.fill.material.opacity = stage === 1 || (stage === 0 && elecP > 0.9) ? 0.1 : 0.04;

    // The packet: shells appear over the chip, peel away one by one, the messages spill out.
    const unpackP = stage < 1 ? -1 : stage === 1 ? p : 2;
    this.shells.forEach((g, k) => {
      const a = 0.12 + k * 0.17;
      const peel = unpackP < 0 ? 0 : smooth((unpackP - a) / 0.12);
      const appear = unpackP < 0 ? 0 : smooth(unpackP / 0.08);
      g.visible = unpackP >= 0 && peel < 1;
      g.scale.setScalar((0.7 + 0.3 * appear) * (1 + peel * 0.6));
      g.userData.edges.material.opacity = 0.7 * appear * (1 - peel);
      g.userData.fill.material.opacity = 0.04 * appear * (1 - peel);
      g.userData.label.element.style.opacity = String(appear * (1 - peel * 2));
    });

    const dmaP = stage < 2 ? 0 : stage === 2 ? p : 1;
    const spread = unpackP < 0 ? 0 : smooth((unpackP - 0.8) / 0.2);
    this.messages.forEach((m, k) => {
      m.mesh.visible = unpackP >= 0;
      if (stage <= 1) {
        m.mesh.position.copy(m.home);
        m.mesh.position.x = CHIP.x + (m.home.x - CHIP.x) * (0.55 + 0.45 * spread);
        m.mesh.position.y = SHELL_Y + spread * 0.3 * Math.sin(k * 1.3 + t * 2);
      } else {
        const local = smooth((dmaP - k * 0.025) / 0.75);
        this.dmaPaths[k].getPointAt(Math.min(1, local), m.mesh.position);
      }
    });
    if (this.heroLabel) this.heroLabel.element.style.opacity = String(unpackP < 0.6 && stage <= 1 ? 0 : 1);
    this.cells.forEach((c, k) => {
      const filled = k < this.messages.length && smooth((dmaP - k * 0.025) / 0.75) >= 1;
      c.userData.fill.material.opacity = filled ? 0.35 : 0.05;
    });

    const ghostP = stage < 2 ? 0 : (sc.sim - WIRE.opticPhyNs - WIRE.macNs) / WIRE.kernelPathNs;
    this.ghostComet.update((i, out) => this.ghostPath.getPointAt(Math.max(0, Math.min(1, ghostP - i * 0.004)), out), stage >= 2);

    const pollP = stage === 3 ? p : stage > 3 ? 1 : 0;
    const beat = (Math.sin(t * 12) + 1) / 2;
    this.pollRing.scale.setScalar(1 + beat * 0.5);
    this.pollRing.material.opacity = 0.25 + 0.5 * beat;
    const heroK = this.messages.findIndex((m) => m.hero);
    const target = this.cells[Math.max(0, heroK)].position;
    const end = CORE.clone().lerp(target, stage === 3 ? smooth(pollP * 2) : 0);
    this.pollBeam.geometry.setFromPoints([CORE.clone().add(new THREE.Vector3(0, 0.15, 0)), end]);

    this.receipt.set('phy', stage === 0 ? (p * WIRE.opticPhyNs) / (WIRE.opticPhyNs + WIRE.macNs)
      : stage === 1 ? (WIRE.opticPhyNs + p * WIRE.macNs) / (WIRE.opticPhyNs + WIRE.macNs) : 1);
    this.receipt.set('pcie', dmaP);
    this.receipt.set('poll', pollP);

    const pos = this.v, look = this.v2;
    if (stage === 0) {
      pos.set(-14.5, 3.0, 7.2);
      look.set(-8.5, 0.4, 0.8);
    } else if (stage === 1) {
      pos.set(-3, 6, 11.5);
      look.set(-3, 2.3, 0);
    } else if (stage === 2) {
      const k = smooth(p * 1.5);
      pos.set(lerp(2, 13, k), lerp(5, 8.5, k), lerp(8, 6, k));
      look.set(lerp(-1, 3, k), lerp(1, -1.6, k), lerp(-1, -8, k));
    } else {
      const k = smooth((pollP - 0.6) / 0.4);
      pos.set(lerp(-1.5, CORE.x, k), lerp(2.2, CORE.y + 0.5, k), lerp(-5, CORE.z + 0.4, k));
      look.copy(CORE);
    }
    this.follow.update(dt, pos, look);
  }

  get clockText() {
    const base = (WIRE.fibreMetres + WIRE.patchMetres) * FIBRE_NS_PER_M + WIRE.switchNs;
    return this.journeyClock(base + this.script.sim);
  }

  get stat() {
    const id = this.script.done ? 'poll' : this.script.id;
    if (id === 'dma') {
      const g = Math.max(0, this.script.sim - WIRE.opticPhyNs - WIRE.macNs);
      return `<span class="k">PCIe DMA</span> ${Math.round(g)} of ~${WIRE.pcieNs} ns<br><span class="k">kernel path</span> ${Math.round((g / WIRE.kernelPathNs) * 100)}% of the way`;
    }
    if (id === 'unpack') return `<span class="k">packet</span> ${this.timeline.heroPacketCount} messages · ${this.timeline.trace.packetBytes[this.timeline.heroPacket]} B payload`;
    return '';
  }
}

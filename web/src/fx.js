import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export function label(text, className = 'label', html = false) {
  const el = document.createElement('div');
  el.className = className;
  if (html) el.innerHTML = text; else el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  return obj;
}

export function glow(color, opacity = 1, extra = {}) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending,
    depthWrite: false, ...extra,
  });
}

export function lineMaterial(color, opacity = 1) {
  return new THREE.LineBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

export function wireBox(w, h, d, color, opacity = 0.8, fill = 0.03) {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMaterial(color, opacity));
  g.add(edges);
  if (fill > 0) {
    const m = new THREE.Mesh(geo, glow(color, fill, { side: THREE.DoubleSide }));
    g.add(m);
    g.userData.fill = m;
  }
  g.userData.edges = edges;
  return g;
}

// An opaque block with lit faces and crisp coloured edges, for physical components. The faces
// are pushed back slightly so the edges never flicker against them.
export function solidBox(w, h, d, color, { edge = 0.6, tint = 0.14 } = {}) {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  const c = new THREE.Color(color);
  const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x0a0e16).lerp(c, tint), roughness: 0.55, metalness: 0.35,
    emissive: c, emissiveIntensity: 0.04, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMaterial(color, edge));
  g.add(body, edges);
  g.userData.body = body;
  g.userData.edges = edges;
  return g;
}

export function polyline(points, color, opacity = 1) {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(geo, lineMaterial(color, opacity));
}

export function dust(count, size, spread, color = 0x6f8fb8, opacity = 0.5) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * spread.x;
    pos[i * 3 + 1] = (Math.random() - 0.5) * spread.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * spread.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    color, size, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
}

// A bright head with a tapering tail of instanced spheres. `at(back, out)` places a point
// `back` steps behind the head; the caller decides what a step means.
export class Comet {
  constructor(color, { radius = 0.2, length = 40 } = {}) {
    this.length = length;
    this.color = new THREE.Color(color);
    const geo = new THREE.IcosahedronGeometry(radius, 2);
    this.mesh = new THREE.InstancedMesh(geo, glow(0xffffff, 1), length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    for (let i = 0; i < length; i++) {
      const f = 1 - i / length;
      c.copy(this.color).multiplyScalar(i === 0 ? 1.8 : 1.2 * f * f);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.tmp = new THREE.Vector3();
    this.m = new THREE.Matrix4();
  }

  setColor(color) {
    this.color.set(color);
    const c = new THREE.Color();
    for (let i = 0; i < this.length; i++) {
      const f = 1 - i / this.length;
      c.copy(this.color).multiplyScalar(i === 0 ? 1.8 : 1.2 * f * f);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(at, visible = true) {
    this.mesh.visible = visible;
    if (!visible) return;
    for (let i = 0; i < this.length; i++) {
      at(i, this.tmp);
      const s = i === 0 ? 1.3 : 1 - (i / this.length) * 0.85;
      this.m.makeScale(s, s, s).setPosition(this.tmp);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get head() {
    const p = new THREE.Vector3();
    this.m.identity();
    this.mesh.getMatrixAt(0, this.m);
    return p.setFromMatrixPosition(this.m);
  }
}

export const isNarrow = () => window.innerWidth < 760;

// The viewer's own adjustment to every scripted camera: an orbit around whatever the shot is
// looking at, and a zoom along the line of sight.
export const userView = { yaw: 0, pitch: 0, zoom: 1, touched: false };

export function resetUserView() {
  userView.yaw = 0;
  userView.pitch = 0;
  userView.zoom = 1;
}

export function attachOrbit(el) {
  const pointers = new Map();
  let pinch = 0;
  let lastTap = 0;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (now - lastTap < 300) resetUserView();
    lastTap = now;
  });
  el.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      userView.yaw -= (e.clientX - p.x) * 0.006;
      userView.pitch -= (e.clientY - p.y) * 0.006;
      userView.touched = true;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) userView.zoom = Math.min(4, Math.max(0.25, userView.zoom * (pinch / d)));
      pinch = d;
      userView.touched = true;
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    userView.zoom = Math.min(4, Math.max(0.25, userView.zoom * Math.exp(e.deltaY * 0.001)));
    userView.touched = true;
  }, { passive: false });
  el.addEventListener('dblclick', resetUserView);
}

const orbitSph = new THREE.Spherical();
const orbitV = new THREE.Vector3();

// Critically damped follow for cameras.
export class Follow {
  constructor(camera, stiffness = 3) {
    this.camera = camera;
    this.k = stiffness;
    this.target = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.snap = true;
  }
  update(dt, position, lookAt) {
    this.prepare();
    if (this.snap) {
      this.camera.position.copy(position);
      this.look.copy(lookAt);
      this.snap = false;
    } else {
      const a = 1 - Math.exp(-dt * this.k);
      this.camera.position.lerp(position, a);
      this.look.lerp(lookAt, Math.min(1, a * 1.6));
    }
    // Apply the viewer's orbit and zoom on top of the scripted shot.
    if (userView.yaw || userView.pitch || userView.zoom !== 1) {
      orbitV.subVectors(this.camera.position, this.look);
      orbitSph.setFromVector3(orbitV);
      orbitSph.theta += userView.yaw;
      orbitSph.phi = Math.min(Math.PI - 0.05, Math.max(0.05, orbitSph.phi + userView.pitch));
      orbitSph.radius *= userView.zoom;
      this.applied = orbitV.setFromSpherical(orbitSph).add(this.look);
      this.base = this.base || new THREE.Vector3();
      this.base.copy(this.camera.position);
      this.camera.position.copy(this.applied);
      this.camera.lookAt(this.look);
      // Keep the smoothing working from the scripted position, not the orbited one.
      this.restore = true;
      return;
    }
    this.restore = false;
    this.camera.lookAt(this.look);
  }

  // Call before the next update when an orbit was applied, so lerping starts from the script.
  prepare() {
    if (this.restore && this.base) this.camera.position.copy(this.base);
  }
}

export const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export const lerp = (a, b, t) => a + (b - a) * t;

export function fmtNs(ns) {
  if (!isFinite(ns)) return '—';
  const a = Math.abs(ns);
  if (a < 10) return `${ns.toFixed(1)} ns`;
  if (a < 1000) return `${Math.round(ns)} ns`;
  if (a < 1e6) return `${(ns / 1000).toFixed(a < 1e4 ? 2 : 1)} µs`;
  if (a < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };

export function fmtDilation(d) {
  if (d < 1.5) return '×1';
  const e = Math.floor(Math.log10(d) + 1e-9);
  const m = d / 10 ** e;
  const sup = String(e).split('').map((c) => SUP[c]).join('');
  if (Math.abs(m - 1) < 0.05) return `×10${sup}`;
  return `×${m.toFixed(1)}·10${sup}`;
}

'use strict';
/* ==========================================================================
   jet.js - fighter model, arcade flight dynamics, scripted flyby jets
   Local axes: nose = -Z, up = +Y, right = +X (same as a Three.js camera).
   ========================================================================== */

const FIGHTER_SPEED = 1.6; // fighters fly this many times faster than the original tuning (cruise ~1,400 km/h, afterburner ~2,600 km/h)

const JET_PALETTES = {
  steel: { body: 0x9ba6b3, belly: 0x6c7684, accent: 0x2f6bd6, canopy: 0x1b2b3d },
  enemy: { body: 0x5a6068, belly: 0x3a3f46, accent: 0xd8402c, canopy: 0x2a1c1c },
  red: { body: 0xc72a20, belly: 0x8b1c16, accent: 0xf1f1f1, canopy: 0x1b2b3d },
  blue: { body: 0x2b57b8, belly: 0x1d3c82, accent: 0xf2c522, canopy: 0x16212f },
  white: { body: 0xe9ecef, belly: 0xb4bac2, accent: 0x2b57b8, canopy: 0x1b2b3d },
  camo: { body: 0x66744a, belly: 0x9aa59a, accent: 0x3b4630, canopy: 0x1c2a22 },
  desert: { body: 0xb99f6d, belly: 0x9aa0a4, accent: 0x6e5a3a, canopy: 0x2a2a1c },
  black: { body: 0x30343a, belly: 0x222529, accent: 0xff7a1a, canopy: 0x10151c },
};
const SHOW_PALETTES = ['red', 'blue', 'white', 'steel', 'camo', 'desert', 'black'];

/* ---------- position history (for retarded-time sound propagation) ---------- */

class TrackHistory {
  constructor(cap) {
    this.cap = cap || 4096;
    this.t = new Float64Array(this.cap);
    this.p = new Float64Array(this.cap * 3);
    this.n = 0;
    this.head = 0;
    this.lastT = -1e18;
  }

  /** Seed with a straight-line history so a freshly spawned source has a past. */
  reset(t, pos, vel) {
    this.n = 0;
    this.head = 0;
    this.lastT = -1e18;
    // a jet has been flying for a long time: give it a long straight past (sound from far away is still arriving)
    const back = 170;
    this.push(t - back, pos.x - vel.x * back, pos.y - vel.y * back, pos.z - vel.z * back);
    this.push(t, pos.x, pos.y, pos.z);
  }

  push(t, x, y, z) {
    if (t <= this.lastT) {
      // same timestamp: overwrite the newest sample
      const i = (this.head - 1 + this.cap) % this.cap;
      this.t[i] = t; this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
      return;
    }
    const i = this.head;
    this.t[i] = t; this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.head = (i + 1) % this.cap;
    if (this.n < this.cap) this.n++;
    this.lastT = t;
  }

  _phys(k) {
    return (this.head - this.n + k + this.cap) % this.cap;
  }

  /** Position at time tq (clamped to the stored range) written into out {x,y,z}. */
  at(tq, out) {
    const n = this.n;
    if (n === 0) return false;
    const p = this.p, t = this.t;
    let i0, i1, u;
    if (tq >= this.lastT) {
      i0 = i1 = this._phys(n - 1);
      u = 0;
    } else {
      const first = this._phys(0);
      if (tq <= t[first]) {
        i0 = i1 = first;
        u = 0;
      } else {
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (t[this._phys(mid)] <= tq) lo = mid;
          else hi = mid;
        }
        i0 = this._phys(lo);
        i1 = this._phys(hi);
        const dt = t[i1] - t[i0];
        u = dt > 1e-9 ? (tq - t[i0]) / dt : 0;
      }
    }
    out.x = p[i0 * 3] + (p[i1 * 3] - p[i0 * 3]) * u;
    out.y = p[i0 * 3 + 1] + (p[i1 * 3 + 1] - p[i0 * 3 + 1]) * u;
    out.z = p[i0 * 3 + 2] + (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * u;
    return true;
  }
}

/* ---------- model ------------------------------------------------------------ */

function twoTone(geo, top, bottom) {
  const a = new THREE.Color(top), b = new THREE.Color(bottom);
  const nr = geo.attributes.normal, n = nr.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = smoothstep(-0.35, 0.3, nr.getY(i));
    arr[i * 3] = b.r + (a.r - b.r) * t;
    arr[i * 3 + 1] = b.g + (a.g - b.g) * t;
    arr[i * 3 + 2] = b.b + (a.b - b.b) * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function mirroredCopy(geo) {
  const g = geo.clone();
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const p = g.attributes.position, nr = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    p.setX(i, -p.getX(i));
    nr.setX(i, -nr.getX(i));
  }
  const a = g.index.array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1];
    a[i + 1] = a[i + 2];
    a[i + 2] = t;
  }
  return g;
}

/** Flat plate planform: pts are [span, longitudinal(+z = backward)] pairs. */
function platePlan(pts, thickness) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1 });
  geo.rotateX(PI / 2);
  geo.translate(0, thickness / 2, 0);
  return geo;
}

let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const [cv, g] = makeCanvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,235,190,0.85)');
  grad.addColorStop(0.45, 'rgba(255,150,60,0.28)');
  grad.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(cv);
  return _glowTex;
}

const _jetMatCache = {};
function jetBodyMaterial() {
  if (!_jetMatCache.body) {
    _jetMatCache.body = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x444a52, shininess: 55 });
  }
  return _jetMatCache.body;
}

function buildJetMesh(palName) {
  const pal = JET_PALETTES[palName] || JET_PALETTES.steel;
  const parts = [];

  // fuselage (lathe around the long axis)
  const prof = [
    [0.0, -8.2], [0.5, -8.2], [0.72, -7.6], [0.92, -6.0], [1.04, -3.2], [1.08, 0.0],
    [1.03, 2.4], [0.88, 4.4], [0.64, 5.9], [0.36, 7.2], [0.0, 8.5],
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  const fus = new THREE.LatheGeometry(prof, gfxLod(16));
  fus.rotateX(-PI / 2);
  fus.scale(1, 0.86, 1);
  parts.push(twoTone(fus, pal.body, pal.belly));

  // wings
  const wingR = platePlan([[0.7, -2.4], [6.0, 2.6], [6.0, 4.1], [0.7, 4.4]], 0.17);
  wingR.translate(0, -0.12, 0);
  twoTone(wingR, pal.body, pal.belly);
  const wingL = mirroredCopy(wingR);
  parts.push(wingR, wingL);

  // tail planes
  const tpR = platePlan([[0.8, 4.7], [3.4, 6.3], [3.4, 7.5], [0.8, 7.6]], 0.13);
  tpR.translate(0, -0.1, 0);
  twoTone(tpR, pal.body, pal.belly);
  parts.push(tpR, mirroredCopy(tpR));

  // twin canted fins
  const finBase = platePlan([[0.2, 3.3], [3.0, 5.7], [3.0, 7.0], [0.2, 7.4]], 0.12);
  finBase.rotateZ(PI / 2); // span axis x -> y (up)
  paintGeometry(finBase, pal.accent);
  for (const sx of [1, -1]) {
    const f = finBase.clone();
    f.rotateZ(-sx * 0.3); // cant outward
    f.translate(sx * 0.72, 0.28, 0);
    parts.push(f);
  }

  // intakes
  const intake = new THREE.BoxGeometry(0.95, 0.85, 3.4);
  intake.translate(0.98, -0.42, -1.1);
  paintGeometry(intake, 0x3a3f46);
  parts.push(intake, mirroredCopy(paintGeometry(intake.clone(), 0x3a3f46)));

  // engine nozzle
  const noz = new THREE.CylinderGeometry(0.66, 0.52, 1.6, gfxLod(14), 1, true);
  noz.rotateX(PI / 2);
  noz.translate(0, 0, 8.6);
  paintGeometry(noz, 0x2b2d31);
  parts.push(noz);

  // wingtip rails + missiles
  for (const sx of [1, -1]) {
    const m = new THREE.CylinderGeometry(0.1, 0.1, 2.9, 8);
    m.rotateX(PI / 2);
    m.translate(sx * 5.4, -0.22, 2.6);
    paintGeometry(m, 0xd7dadf);
    parts.push(m);
    const m2 = new THREE.CylinderGeometry(0.11, 0.11, 2.6, 8);
    m2.rotateX(PI / 2);
    m2.translate(sx * 2.6, -0.45, 1.9);
    paintGeometry(m2, 0xc4c8ce);
    parts.push(m2);
  }

  const merged = mergeGeometries(parts);
  const body = new THREE.Mesh(merged, jetBodyMaterial());

  const group = new THREE.Group();
  group.add(body);

  // canopy
  const canopyGeo = new THREE.SphereGeometry(1, gfxLod(14), gfxLod(10));
  canopyGeo.scale(0.6, 0.5, 2.5);
  canopyGeo.translate(0, 0.62, -3.1);
  const canopy = new THREE.Mesh(
    canopyGeo,
    new THREE.MeshPhongMaterial({ color: pal.canopy, specular: 0xaad0ff, shininess: 150, transparent: true, opacity: 0.9 })
  );
  group.add(canopy);

  // afterburner flame (two nested cones) - additive
  const mkFlame = (radius) => {
    const g = new THREE.ConeGeometry(radius, 1, 12, 1, true);
    g.rotateX(PI / 2);
    g.translate(0, 0, 0.5);
    return g;
  };
  const paintFlame = (g, c0, c1) => {
    const pos = g.attributes.position, n = pos.count;
    const arr = new Float32Array(n * 3);
    const a = new THREE.Color(c0), b = new THREE.Color(c1);
    for (let i = 0; i < n; i++) {
      const z = clamp(pos.getZ(i), 0, 1);
      const t = Math.pow(z, 0.8);
      arr[i * 3] = a.r + (b.r - a.r) * t;
      arr[i * 3 + 1] = a.g + (b.g - a.g) * t;
      arr[i * 3 + 2] = a.b + (b.b - a.b) * t;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  };
  const outerG = mkFlame(0.8);
  paintFlame(outerG, 0xffb050, 0x000000);
  const coreG = mkFlame(0.42);
  paintFlame(coreG, 0xd8f0ff, 0x000000);
  const flameMat = () =>
    new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
  const flame = new THREE.Mesh(outerG, flameMat());
  flame.position.z = 9.2;
  const core = new THREE.Mesh(coreG, flameMat());
  core.position.z = 9.2;
  group.add(flame, core);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false })
  );
  glow.position.set(0, 0, 9.6);
  group.add(glow);

  // navigation lights
  const mkLight = (x, y, z, color, size) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false })
    );
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    group.add(s);
    return s;
  };
  // transonic condensation cone (Prandtl-Glauert cloud) - visible near Mach 1
  const vg = new THREE.ConeGeometry(3.3, 9, 20, 1, true);
  vg.rotateX(-PI / 2);
  vg.translate(0, 0, 5.2);
  const vapor = new THREE.Mesh(
    vg,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
  );
  vapor.visible = false;
  group.add(vapor);

  const lights = {
    red: mkLight(-5.4, -0.1, 3.0, 0xff2a2a, 2.2),
    green: mkLight(5.4, -0.1, 3.0, 0x30ff50, 2.2),
    strobe: mkLight(0.0, 3.3, 7.2, 0xffffff, 3.2),
  };

  return { group, body, canopy, flame, core, glow, lights, pal, vapor };
}

/* ---------- blob shadow ------------------------------------------------------- */

let _shadowTex = null;
function shadowTexture() {
  if (_shadowTex) return _shadowTex;
  const [cv, g] = makeCanvas(128, 128);
  g.fillStyle = '#000';
  const cx = 64;
  g.beginPath(); g.ellipse(cx, 62, 6.5, 52, 0, 0, TAU); g.fill();
  const wing = (sx) => {
    g.beginPath();
    g.moveTo(cx + sx * 5, 52); g.lineTo(cx + sx * 56, 88); g.lineTo(cx + sx * 56, 99); g.lineTo(cx + sx * 5, 94);
    g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(cx + sx * 4, 100); g.lineTo(cx + sx * 24, 114); g.lineTo(cx + sx * 24, 121); g.lineTo(cx + sx * 4, 122);
    g.closePath(); g.fill();
  };
  wing(1); wing(-1);
  const [c2, g2] = makeCanvas(40, 40);
  g2.imageSmoothingEnabled = true;
  g2.drawImage(cv, 0, 0, 40, 40);
  g.clearRect(0, 0, 128, 128);
  g.imageSmoothingEnabled = true;
  g.drawImage(c2, 0, 0, 128, 128);
  _shadowTex = new THREE.CanvasTexture(cv);
  return _shadowTex;
}

class JetShadow {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-PI / 2);
    this.mat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.5, fog: true, color: 0x000000 });
    this.mat.polygonOffset = true;
    this.mat.polygonOffsetFactor = -4;
    this.mat.polygonOffsetUnits = -4;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._f = new THREE.Vector3();
  }

  update(jet, world) {
    const p = jet.pos;
    let gy = world.surfaceAt(p.x, p.z);
    const h = p.y - gy;
    if (h > 2600 || !jet.alive) {
      this.mesh.visible = false;
      return;
    }
    // close to the camera the real sun shadow takes over from this blob
    if (world.shadowOn && jet.pos.distanceTo(world.shadowCenter) < 520 && h < 700) { this.mesh.visible = false; return; }
    const sx = SUN_DIR.x / SUN_DIR.y, sz = SUN_DIR.z / SUN_DIR.y;
    let x = p.x - sx * h, z = p.z - sz * h;
    gy = world.surfaceAt(x, z);
    const h2 = Math.max(0, p.y - gy);
    x = p.x - sx * h2; z = p.z - sz * h2;
    gy = world.surfaceAt(x, z);
    this.mesh.visible = true;
    this.mesh.position.set(x, gy + 0.35, z);
    const f = jet.getForward(this._f);
    this.mesh.rotation.y = Math.atan2(-f.x, -f.z);
    const s = 1 + Math.min(h2, 1500) / 1500 * 0.5;
    this.mesh.scale.set((jet.heavy ? jet.spec.shadow[0] * jet.spec.scale : 14.5) * s, 1, (jet.heavy ? jet.spec.shadow[1] * jet.spec.scale : 19) * s);
    this.mat.opacity = 0.55 * (1 - smoothstep(250, 2200, h2));
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/* ==========================================================================
   Jet base class
   ========================================================================== */

class Jet {
  constructor(opts) {
    opts = opts || {};
    this.name = opts.name || 'JET';
    this.team = opts.team || 'neutral';
    this.palName = opts.palette || 'steel';
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.speed = 0;
    this.throttle = 0.6;
    this.ab = 0;
    this.radius = 9;
    this.alive = true;
    this.hp = 100;
    this.maxHp = 100;
    this.history = new TrackHistory(4096);
    this.spec = (opts.type && PLANES[opts.type]) || null; // large aircraft (C-17 / 737 / 747); null for fighters
    this.heavy = !!this.spec;
    this.model = this.spec ? this.spec.build(!!opts.gear) : buildJetMesh(this.palName);
    if (this.spec) this.radius = this.spec.radius * this.spec.scale / 1.25;
    this.group = this.model.group;
    // sun shadows: the airframe throws and receives them
    this.model.body.castShadow = this.model.body.receiveShadow = true;
    if (this.model.canopy) this.model.canopy.castShadow = true;
    this.group.rotation.order = 'YXZ';
    this.smokeOn = false;
    this.smokeAcc = 0;
    this.damageSmoke = 0;
    this.seed = Math.random() * 100;
    this.mach = 0;
    this.machScale = 1; // Aircraft: the player's fighter reaches "Mach 1" at FIGHTER_SPEED x the real speed of sound
    this._tmp = new THREE.Vector3();
  }

  getForward(out) {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }

  getUp(out) {
    return out.set(0, 1, 0).applyQuaternion(this.quat);
  }

  getRight(out) {
    return out.set(1, 0, 0).applyQuaternion(this.quat);
  }

  resetHistory(t) {
    this.history.reset(t, this.pos, this.vel);
  }

  recordHistory(t) {
    this.history.push(t, this.pos.x, this.pos.y, this.pos.z);
  }

  syncVisual(time) {
    const g = this.group;
    g.position.copy(this.pos);
    g.quaternion.copy(this.quat);
    const m = this.model;
    const ab = this.ab;
    const flick = 0.88 + 0.24 * Math.sin(time * 61 + this.seed) * Math.sin(time * 37.3 + this.seed * 2.1);
    const dry = 0.35 + this.throttle * 1.1;
    const len = (dry + ab * 7.2) * flick;
    m.flame.scale.set(0.45 + 0.65 * ab, 0.45 + 0.65 * ab, len);
    m.core.scale.set(0.5 + 0.5 * ab, 0.5 + 0.5 * ab, len * 0.55);
    m.flame.material.opacity = 0.18 + 0.82 * ab;
    m.core.material.opacity = 0.35 + 0.65 * ab;
    m.flame.visible = m.core.visible = this.alive && !m.noFlame;
    const gs = 1.8 + this.throttle * 1.0 + ab * 3.4;
    m.glow.scale.set(gs, gs, 1);
    m.glow.material.opacity = 0.15 + 0.6 * ab + 0.1 * this.throttle;
    m.lights.strobe.visible = ((time * 1.3 + this.seed) % 1) < 0.1;
    const M = this.speed / (SPEED_OF_SOUND * this.machScale);
    const vm = smoothstep(0.9, 0.99, M) * (1 - smoothstep(1.04, 1.2, M)) * (1 - smoothstep(2500, 5000, this.pos.y));
    m.vapor.visible = vm > 0.02;
    if (m.vapor.visible) {
      m.vapor.material.opacity = 0.5 * vm;
      const sc = 0.85 + 0.3 * vm;
      m.vapor.scale.set(sc, sc, 0.9 + 0.2 * Math.sin(time * 9 + this.seed));
    }
  }

  /** Emit a trailing smoke puff (call each frame). */
  emitTrail(fx, dt) {
    const wantSmoke = this.smokeOn || this.damageSmoke > 0;
    if (!wantSmoke || !this.alive) return;
    this.smokeAcc += dt;
    const step = this.damageSmoke > 0 ? 0.03 : clamp(5.5 / Math.max(this.speed, 60), 0.012, 0.04);
    const f = this._tmp;
    while (this.smokeAcc >= step) {
      this.smokeAcc -= step;
      // nozzle position
      f.set(0, 0, this.heavy ? this.spec.tail * this.spec.scale : 9).applyQuaternion(this.quat).add(this.pos);
      if (this.damageSmoke > 0) {
        const k = this.damageSmoke;
        fx.puff(f.x, f.y, f.z, rand(-2, 2), rand(0, 3), rand(-2, 2), rand(2.5, 4.5), 2 + 2 * k, 9 + 9 * k, 0.08 + 0.06 * Math.random(), 0.5 * k + 0.15, 0.8, 0.5);
        if (k > 0.6) fx.glow(f.x, f.y, f.z, rand(-2, 2), rand(-1, 2), rand(-2, 2), 0.45, 3.5, 1.5, 1, 0.55, 0.15, 0.8, 1.5);
      } else {
        fx.puff(f.x, f.y, f.z, rand(-0.5, 0.5), rand(0, 0.6), rand(-0.5, 0.5), 9, 5, 30, 0.98, 0.34, 0.2, 0.1);
      }
    }
  }
}

/* ==========================================================================
   Aircraft - dynamic arcade flight model (player and AI combatants)
   ========================================================================== */

const _q1 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _w = new THREE.Vector3();

class Aircraft extends Jet {
  constructor(opts) {
    super(opts);
    this.input = { pitch: 0, roll: 0, yaw: 0, boost: false, brake: false, throttle: -1 };
    this.rates = { p: 0, r: 0, y: 0 };
    this.vdir = new THREE.Vector3(0, 0, -1);
    this.cruise = 0.55;
    this.nLoad = 1;
    this.stalled = false;
    this.assist = true;
    this.gMul = 1;
    this.dying = false;
    this.dyingT = 0;
    this._lastVdir = new THREE.Vector3(0, 0, -1);
    this.machScale = this.heavy ? 1 : FIGHTER_SPEED;
    if (this.spec) { this.cruise = this.spec.cruise; this.gMul = this.spec.gMul; this.assist = true; }
  }

  /** heading: yaw radians (0 = looking toward -Z, +ve turns left). */
  place(x, y, z, heading, speed) {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.speed = speed;
    this.vdir.set(0, 0, -1).applyQuaternion(this.quat);
    this._lastVdir.copy(this.vdir);
    this.vel.copy(this.vdir).multiplyScalar(speed);
    this.rates.p = this.rates.r = this.rates.y = 0;
    this.throttle = this.cruise;
    this.ab = 0;
    this.alive = true;
    this.dying = false;
    this.hp = this.maxHp;
    this.damageSmoke = 0;
  }

  step(dt) {
    const inp = this.input;
    let spd = this.speed;
    const rho = Math.exp(-Math.max(0, this.pos.y) / 9500);

    if (this.dying) {
      this.dyingT += dt;
      inp.roll = 1; inp.pitch = -0.25; inp.yaw = 0; inp.boost = false; inp.throttle = 0.3;
      this.damageSmoke = 1;
    }

    // --- control authority -------------------------------------------------
    const H = this.heavy, SP = this.spec; // big transports: slow, heavy, gentle on the controls
    const K = H ? 1 : FIGHTER_SPEED; // fighters fly this much faster than the original tuning
    const lowAuth = H ? smoothstep(SP.auth[0], SP.auth[1], spd) : smoothstep(45, 150, spd);
    const highAuth = 1 - 0.38 * smoothstep(300 * K, 480 * K, spd);
    const auth = lowAuth * highAuth * (0.4 + 0.6 * Math.sqrt(rho));
    const gMax = 11 * this.gMul * K; // more g at higher speed keeps the turn RATE the same
    const pitchCap = Math.min((H ? SP.pitchLim : 62) * DEG, (gMax * 9.81) / Math.max(spd, 90));
    const stallF = H ? 1 - smoothstep(SP.stall[0], SP.stall[1], spd) : 1 - smoothstep(62, 108, spd);
    this.stalled = stallF > 0.35;

    // in a stall the nose drops toward the flight path (weathervane) so the jet falls forward and recovers
    let stallTerm = 0;
    if (stallF > 0) {
      const fn = this.getForward(_v1);
      const err = clamp(Math.asin(clamp(fn.y, -1, 1)) - Math.asin(clamp(this.vdir.y, -1, 1)), -0.9, 0.9);
      stallTerm = -stallF * (0.12 + 1.4 * err);
    }
    let tp = inp.pitch * pitchCap * auth + stallTerm;
    let tr = inp.roll * (H ? SP.roll : 175) * DEG * (0.3 + 0.7 * lowAuth) * (1 - 0.3 * smoothstep(330 * K, 480 * K, spd));
    let ty = inp.yaw * (H ? SP.yaw : 22) * DEG * auth;

    // gentle wings-level assist when the stick is centred
    if (this.assist && !this.dying && Math.abs(inp.roll) < 0.05 && Math.abs(inp.pitch) < 0.15) {
      _w.set(1, 0, 0).applyQuaternion(this.quat);
      const up = _v3.set(0, 1, 0).applyQuaternion(this.quat);
      // right wing down => _w.y < 0 => negative roll command (roll left) levels the wings
      if (up.y > 0.15) tr += clamp(_w.y, -1, 1) * 1.15;
    }

    const k1 = 1 - Math.exp(-dt * (H ? SP.kPitch : 7));
    const k2 = 1 - Math.exp(-dt * (H ? SP.kRoll : 11));
    this.rates.p += (tp - this.rates.p) * k1;
    this.rates.y += (ty - this.rates.y) * k1;
    this.rates.r += (tr - this.rates.r) * k2;

    // storm turbulence: random jolts
    if (this.turb > 0.02) {
      const tb = this.turb * (H ? 0.55 : 1);
      this.rates.r += rand(-1, 1) * tb * 0.5;
      this.rates.p += rand(-1, 1) * tb * 0.09;
      this.rates.y += rand(-1, 1) * tb * 0.04;
    }

    // local rotation: pitch about +X (nose up positive), yaw about +Y (right = negative), roll about +Z (right = negative)
    _w.set(this.rates.p, -this.rates.y, -this.rates.r);
    const ang = _w.length() * dt;
    if (ang > 1e-7) {
      _w.normalize();
      _q1.setFromAxisAngle(_w, ang);
      this.quat.multiply(_q1).normalize();
    }

    // --- throttle & speed ---------------------------------------------------
    let tgt = inp.throttle >= 0 ? inp.throttle : this.cruise;
    if (H && inp.throttle < 0 && !inp.boost && !inp.brake) {
      // cruise control for the big aircraft: when you are not touching the throttle the speed is held where you left it
      if (this.holdSpeed === undefined || this.holdSpeed === null) { this.holdSpeed = spd; this.atI = this.throttle; }
      const err = this.holdSpeed - spd;
      const acc = this._atLast === undefined ? 0 : (spd - this._atLast) / Math.max(dt, 1e-3); // damping term: how fast the speed is changing now
      this._atLast = spd;
      this.atI = clamp(this.atI + err * 0.0018 * dt, 0.02, 1);
      tgt = clamp(this.atI + err * 0.0022 - acc * 0.03, 0.02, 1);
    } else if (H) { this.holdSpeed = null; this._atLast = undefined; }
    if (inp.boost) tgt = 1;
    if (inp.brake) tgt = 0.04;
    this.throttle += (tgt - this.throttle) * (1 - Math.exp(-dt * (H ? SP.kThr : 1.7)));
    const abTarget = inp.boost && this.throttle > 0.82 && !H ? 1 : 0;
    this.ab += (abTarget - this.ab) * (1 - Math.exp(-dt * 3.0));

    const thrust = (this.throttle * (H ? SP.thrustK : 12.5 * K * K) + this.ab * 19 * K * K) * (0.3 + 0.7 * Math.pow(rho, 0.8));
    const M = spd / (SPEED_OF_SOUND * this.machScale);
    const cd = 1.15e-4 + (H ? 1.0e-4 : 0.4e-4) * smoothstep(0.9, 1.1, M);
    let drag = cd * spd * spd * (0.3 + 0.7 * rho) * (H && SP.dragK ? SP.dragK : 1);
    if (inp.brake) drag += 3.4e-4 * spd * spd;
    const omega = Math.hypot(this.rates.p, this.rates.y);
    const nLoad = (spd * omega) / 9.81;
    drag += 0.085 * nLoad * nLoad / (K * K); // the same turn costs the same fraction of thrust
    const gAlong = -9.81 * this.vdir.y;
    spd += (thrust - drag + gAlong) * dt;
    spd = H ? clamp(spd, SP.vmin, SP.vmax) : clamp(spd, 35, 560 * K * 1.1);
    this.speed = spd;

    // --- velocity vector follows the nose with some lag --------------------------
    const fwd = this.getForward(_v1);
    const align = (1.8 + 3.2 * clamp(spd / (260 * K), 0, 1.4)) * (H ? SP.align : 1);
    this._lastVdir.copy(this.vdir);
    this.vdir.lerp(fwd, 1 - Math.exp(-align * dt));
    this.vdir.y -= stallF * 0.85 * dt;
    this.vdir.normalize();
    this.vel.copy(this.vdir).multiplyScalar(spd);
    this.pos.addScaledVector(this.vel, dt);
    this.mach = spd / (SPEED_OF_SOUND * this.machScale);

    const turn = Math.acos(clamp(this.vdir.dot(this._lastVdir), -1, 1)) / Math.max(dt, 1e-4);
    this.nLoad += (Math.sqrt(1 + Math.pow((turn * spd) / 9.81, 2)) - this.nLoad) * (1 - Math.exp(-dt * 6));
  }
}

/* ==========================================================================
   ScriptedJet - kinematic jets for flyby/airshow mode (constant commanded Mach)
   ========================================================================== */

class ScriptedJet extends Jet {
  constructor(opts) {
    super(opts);
    this.leader = null;
    this.offset = new THREE.Vector3();
    this.wps = [];
    this.wi = 0;
    this.theta = 0; // horizontal heading angle (atan2(dz, dx))
    this.gamma = 0; // climb angle
    this.cmdSpeed = 250;
    this.cmdAB = 0;
    this.aLat = 3.2 * 9.81;
    this.accel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
    this.upVec = new THREE.Vector3(0, 1, 0);
    this.flourish = 0; // barrel-roll progress 0..1 (or -1 for none)
    this.flourishAt = null;
    this.age = 0;
    this.done = false;
    this.terrainClear = 90;
    this.terrain = null;
  }

  startAt(pos, theta, speed, waypoints) {
    this.pos.copy(pos);
    this.theta = theta;
    this.gamma = 0;
    this.speed = this.cmdSpeed = speed;
    this.wps = waypoints;
    this.wi = 0;
    this.vel.set(Math.cos(theta) * speed, 0, Math.sin(theta) * speed);
    this.prevVel.copy(this.vel);
    this.accel.set(0, 0, 0);
    this.upVec.set(0, 1, 0);
    this._orient(1, 0);
  }

  _orient(dt, rollOffset) {
    const f = _v1.copy(this.vel);
    const sp = f.length();
    if (sp < 1) return;
    f.multiplyScalar(1 / sp);
    // lift vector = acceleration + gravity compensation, orthogonalised against the velocity
    const lift = _v2.set(this.accel.x, this.accel.y + 9.81, this.accel.z);
    lift.addScaledVector(f, -lift.dot(f));
    if (lift.lengthSq() < 4) lift.copy(this.upVec).addScaledVector(f, -this.upVec.dot(f));
    if (lift.lengthSq() < 1e-6) lift.set(0, 1, 0).addScaledVector(f, -f.y);
    lift.normalize();
    // smooth the up vector (avoids flicker through zero-g)
    this.upVec.lerp(lift, 1 - Math.exp(-dt * 8)).addScaledVector(f, -this.upVec.dot(f)).normalize();
    const up = _v3.copy(this.upVec);
    if (rollOffset) {
      const r = _w.crossVectors(f, up);
      up.multiplyScalar(Math.cos(rollOffset)).addScaledVector(r, Math.sin(rollOffset));
    }
    const right = _w.crossVectors(f, up).normalize();
    const back = _v1.copy(f).multiplyScalar(-1);
    const m = new THREE.Matrix4().makeBasis(right, up, back);
    this.quat.setFromRotationMatrix(m);
  }

  /** Advance. ctx = {world, time} */
  step(dt, ctx) {
    this.age += dt;
    if (this.leader) {
      // rigid formation slot in the leader's frame
      const L = this.leader;
      _v1.copy(this.offset).applyQuaternion(L.quat);
      this.pos.copy(L.pos).add(_v1);
      this.vel.copy(L.vel);
      this.quat.copy(L.quat);
      this.speed = L.speed;
      this.ab = L.ab;
      this.throttle = L.throttle;
      this.mach = L.mach;
      return;
    }

    // --- waypoint following ----------------------------------------------------
    const wp = this.wps[this.wi];
    if (wp) {
      const next = this.wps[this.wi + 1];
      let tx = wp.x, tz = wp.z, ty = wp.y;
      if (next) {
        // line-following with look-ahead between this waypoint and the next
        const ux = next.x - wp.x, uz = next.z - wp.z;
        const len = Math.hypot(ux, uz) || 1;
        const nx = ux / len, nz = uz / len;
        const along = (this.pos.x - wp.x) * nx + (this.pos.z - wp.z) * nz;
        const look = Math.max(500, this.speed * 2.4);
        const ta = clamp(along + look, 0, len);
        tx = wp.x + nx * ta; tz = wp.z + nz * ta;
        const u = clamp(ta / len, 0, 1);
        ty = wp.y + (next.y - wp.y) * u;
        if (along > len - 30) this.wi++;
      } else if (Math.hypot(this.pos.x - wp.x, this.pos.z - wp.z) < 200) {
        this.wi++;
      }
      // terrain awareness
      if (ctx && ctx.world) {
        const ahead = this.speed * 3;
        const hx = this.pos.x + Math.cos(this.theta) * ahead, hz = this.pos.z + Math.sin(this.theta) * ahead;
        const g = Math.max(ctx.world.surfaceAt(hx, hz), ctx.world.surfaceAt(this.pos.x, this.pos.z), ctx.world.surfaceAt(tx, tz));
        ty = Math.max(ty, g + this.terrainClear);
      }
      const want = Math.atan2(tz - this.pos.z, tx - this.pos.x);
      const dth = wrapPi(want - this.theta);
      const maxTurn = (this.aLat / Math.max(this.speed, 50)) * dt;
      this.theta += clamp(dth, -maxTurn, maxTurn);
      const hd = Math.max(Math.hypot(tx - this.pos.x, tz - this.pos.z), 300);
      const wantG = Math.atan2(ty - this.pos.y, hd);
      const gMax = 38 * DEG;
      const dg = clamp(wantG, -gMax, gMax) - this.gamma;
      this.gamma += clamp(dg, -22 * DEG * dt, 22 * DEG * dt);
    } else {
      this.done = true;
    }

    // speed command (smooth)
    this.speed += (this.cmdSpeed - this.speed) * (1 - Math.exp(-dt * 1.2));
    this.prevVel.copy(this.vel);
    const cg = Math.cos(this.gamma);
    this.vel.set(Math.cos(this.theta) * cg * this.speed, Math.sin(this.gamma) * this.speed, Math.sin(this.theta) * cg * this.speed);
    this.pos.addScaledVector(this.vel, dt);
    // smoothed acceleration for banking
    _v1.copy(this.vel).sub(this.prevVel).multiplyScalar(1 / Math.max(dt, 1e-4));
    this.accel.lerp(_v1, 1 - Math.exp(-dt * 5));

    // optional barrel roll flourish
    let roll = 0;
    if (this.flourishAt !== null && this.flourish >= 0) {
      if (this.flourish === 0 && this.age >= this.flourishAt) this.flourish = 1e-6;
      if (this.flourish > 0) {
        this.flourish += dt / 2.6;
        if (this.flourish >= 1) this.flourish = -1;
        else roll = -TAU * (this.flourish * this.flourish * (3 - 2 * this.flourish)) * (this.flourishDir || 1);
      }
    }
    this._orient(dt, roll);
    this.mach = this.speed / SPEED_OF_SOUND;
    this.throttle += ((this.cmdSpeed > 290 ? 1 : 0.55 + 0.45 * smoothstep(120, 300, this.cmdSpeed)) - this.throttle) * (1 - Math.exp(-dt * 2));
    this.ab += (this.cmdAB - this.ab) * (1 - Math.exp(-dt * 2.5));
  }
}

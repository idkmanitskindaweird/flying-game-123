'use strict';
/* ==========================================================================
   crash.js - realistic aircraft crashes (any aircraft: fighters, C-17, 737, 747).
   The airframe breaks into chunks (fuselage sections, wings, tail, engines) that fly on, tumble, bounce,
   skid and burn. Ground impacts throw dust, burn, leave a scorch mark and trigger secondary explosions;
   crashes into the sea make a splash instead; mid-air kills break the aircraft up and the burning pieces
   rain down. Each piece leaves a smoke trail and rests burning where it stops.
   ========================================================================== */

const PLANE_DIMS = {
  c17: { L: 53, R: 3.3, span: 52, finH: 10, engines: [[9.6, 1], [17.2, 1]] },
  b737: { L: 39.5, R: 1.95, span: 35.8, finH: 6.6, engines: [[5.9, 1]] },
  b747: { L: 70.7, R: 3.25, span: 64.4, finH: 11.6, engines: [[11.8, 1], [24.4, 1]] },
};

const _kq = new THREE.Quaternion();
const _kv = new THREE.Vector3();
const _kw = new THREE.Vector3();

class CrashFX {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    app.scene.add(this.group);
    this.chunks = [];
    this.sites = []; // burning wreck sites
    this.timers = [];
    this.marks = [];
    this.thudT = 0;
    this.collT = 0;
    this.listener = null; // when set (the Replay Lab), sounds are heard from here and arrive after the travel time of sound
    this.focusChunk = null;
    this.charred = new THREE.Color(0x1b1a19);
  }

  clear() {
    for (const c of this.chunks) this.dropChunk(c);
    this.chunks.length = 0;
    this.sites.length = 0;
    this.timers.length = 0;
    for (const m of this.marks) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.marks.length = 0;
    this.focusChunk = null;
  }

  dropChunk(c) {
    this.group.remove(c.mesh);
    c.mesh.geometry.dispose();
    c.mesh.material.dispose();
  }

  /* ----- breaking an airframe into pieces ----------------------------------------------- */

  /** [{size:[x,y,z], at:[x,y,z], color, round}] in the aircraft's local frame, in metres (before the model's draw scale). */
  partsFor(jet) {
    const parts = [];
    const spec = jet.spec;
    if (!spec) {
      const pal = jet.model.pal;
      const B = pal.body, D = pal.belly, A = pal.accent;
      // fuselage in sections, nose cone and cockpit glass
      parts.push({ size: [0.9, 0.9, 3.2], at: [0, 0, -7.6], color: 0x30343a, round: true });
      parts.push({ size: [1.5, 1.3, 3.4], at: [0, 0, -4.6], color: B });
      parts.push({ size: [1.0, 0.6, 2.4], at: [0, 0.9, -3.8], color: 0x16212f, glass: true });
      parts.push({ size: [2.0, 1.7, 3.0], at: [0, 0, -1.2], color: B }, { size: [2.1, 1.7, 3.0], at: [0, 0, 1.8], color: B });
      parts.push({ size: [1.9, 1.6, 3.0], at: [0, 0, 4.6], color: D }, { size: [1.7, 1.5, 2.6], at: [0, 0, 7.0], color: D });
      for (const sx of [1, -1]) {
        parts.push({ size: [3.0, 0.28, 3.8], at: [sx * 2.6, -0.1, 2.4], color: B });
        parts.push({ size: [2.8, 0.24, 2.6], at: [sx * 5.4, -0.1, 3.0], color: B });
        parts.push({ size: [0.3, 3.0, 2.6], at: [sx * 1.1, 2.1, 6.3], color: A });
        parts.push({ size: [2.8, 0.22, 1.8], at: [sx * 2.2, 0, 7.0], color: D });
        parts.push({ size: [0.9, 0.9, 3.4], at: [sx * 1.0, -0.4, -0.6], color: 0x3a3f46 });   // intake
        parts.push({ size: [0.2, 0.2, 2.8], at: [sx * 5.4, -0.3, 2.6], color: 0xd7dadf, round: true }); // wingtip missile
        parts.push({ size: [0.55, 0.55, 0.45], at: [sx * 1.3, -1.7, 2.2], color: 0x1d1f23, round: true, axis: 'x', wheel: true });
      }
      parts.push({ size: [0.5, 0.5, 0.42], at: [0, -1.6, -4.4], color: 0x1d1f23, round: true, axis: 'x', wheel: true });
      parts.push({ size: [1.2, 1.2, 1.8], at: [0, 0, 8.4], color: 0x2b2d31, round: true });
      this.addShrapnel(parts, 80, 7, [B, D, A, 0x2b2d31]);
      return parts;
    }
    const d = PLANE_DIMS[spec.key];
    const white = spec.key === 'c17' ? 0x9aa1a8 : 0xf1f3f5, belly = spec.key === 'c17' ? 0x727980 : 0xc7ccd2;
    const tail = spec.key === 'b737' ? 0x1f58b8 : spec.key === 'b747' ? 0xc4202c : 0x868d94;
    // fuselage in eight sections, with the cockpit nose and tail cone as their own pieces
    const n = 8, sl = d.L / n;
    for (let i = 0; i < n; i++) parts.push({ size: [d.R * 1.9, d.R * 1.9, sl], at: [0, 0, -d.L / 2 + (i + 0.5) * sl], color: i % 2 ? belly : white });
    parts.push({ size: [d.R * 1.5, d.R * 1.3, d.R * 2.2], at: [0, d.R * 0.1, -d.L / 2 - d.R * 0.9], color: white });
    parts.push({ size: [d.R * 1.2, d.R * 0.6, d.R * 1.6], at: [0, d.R * 0.55, -d.L / 2 + d.R * 0.6], color: 0x16212f, glass: true });
    parts.push({ size: [d.R * 1.2, d.R * 1.1, d.R * 2.0], at: [0, d.R * 0.3, d.L / 2 + d.R * 0.7], color: belly });
    for (const sx of [1, -1]) {
      // wings in three pieces each, plus flaps
      parts.push({ size: [d.span * 0.14, 0.5, d.L * 0.17], at: [sx * d.span * 0.1, -d.R * 0.4, d.L * 0.06], color: white });
      parts.push({ size: [d.span * 0.14, 0.45, d.L * 0.13], at: [sx * d.span * 0.24, -d.R * 0.4, d.L * 0.09], color: white });
      parts.push({ size: [d.span * 0.14, 0.4, d.L * 0.1], at: [sx * d.span * 0.38, -d.R * 0.4, d.L * 0.12], color: white });
      parts.push({ size: [d.span * 0.2, 0.12, d.L * 0.035], at: [sx * d.span * 0.2, -d.R * 0.4, d.L * 0.17], color: belly });
      parts.push({ size: [0.3, d.finH * 0.35, d.L * 0.04], at: [sx * d.span * 0.495, -d.R * 0.2 + d.finH * 0.15, d.L * 0.16], color: tail }); // winglet
      parts.push({ size: [d.span * 0.15, 0.3, d.L * 0.07], at: [sx * d.span * 0.09, d.R * 0.2, d.L * 0.4], color: white });
      for (const [ex] of d.engines) {
        parts.push({ size: [d.R * 0.7, d.R * 0.7, d.R * 1.5], at: [sx * ex, -d.R * 0.9, d.L * 0.0], color: 0xaab0b7, round: true });
        parts.push({ size: [d.R * 0.7, d.R * 0.7, d.R * 1.0], at: [sx * ex, -d.R * 0.9, d.L * 0.045], color: 0x3a3d42, round: true });
      }
      // main landing gear: two bogies per side
      for (const gz of [0.06, 0.1]) parts.push({ size: [d.R * 0.4, d.R * 0.4, d.R * 0.3], at: [sx * d.R * 1.0, -d.R * 1.5, d.L * gz], color: 0x1d1f23, round: true, axis: 'x', wheel: true });
    }
    parts.push({ size: [d.R * 0.4, d.R * 0.4, d.R * 0.3], at: [0, -d.R * 1.5, -d.L * 0.36], color: 0x1d1f23, round: true, axis: 'x', wheel: true });
    parts.push({ size: [0.5, d.finH * 0.55, d.L * 0.14], at: [0, d.R + d.finH * 0.25, d.L * 0.38], color: tail });
    parts.push({ size: [0.5, d.finH * 0.45, d.L * 0.1], at: [0, d.R + d.finH * 0.75, d.L * 0.41], color: tail });
    // cargo and luggage spilling out of the hold
    const loads = spec.key === 'c17' ? [0x6b7a4a, 0x8a6f3a, 0x55603c, 0x9a8a5a] : [0x2b3a67, 0x6b2a2a, 0x2a2a2a, 0x8a6a3a, 0x1f5f4a];
    const nl = spec.key === 'b747' ? 18 : spec.key === 'c17' ? 14 : 12;
    for (let i = 0; i < nl; i++) {
      const sz = spec.key === 'c17' ? rand(1.4, 2.6) : rand(0.5, 0.9);
      parts.push({ size: [sz, sz * rand(0.5, 0.8), sz * rand(0.7, 1.2)], at: [rand(-0.4, 0.4) * d.R, -d.R * 0.4, rand(-0.35, 0.35) * d.L], color: loads[i % loads.length], cargo: true });
    }
    this.addShrapnel(parts, 130, d.L * 0.18, [white, belly, tail, 0x2b2d31, 0xaab0b7]);
    return parts;
  }

  /** a spray of small torn-off plates scattered over the airframe (n pieces, within `reach` metres of the centre) */
  addShrapnel(parts, n, reach, colors) {
    for (let i = 0; i < n; i++) {
      // every fourth piece is a larger torn panel, the rest are small plates and splinters
      const s = (i % 4 === 0 ? rand(0.9, 2.2) * (1 + reach * 0.06) : rand(0.2, 1.1) * (1 + reach * 0.03));
      parts.push({
        size: [s, rand(0.03, 0.14), s * rand(0.4, 1.5)], at: [rand(-1, 1) * reach * 0.35, rand(-0.5, 1) * reach * 0.15, rand(-1, 1) * reach],
        color: colors[i % colors.length], shard: true,
      });
    }
  }

  makeMesh(part, sc) {
    const [sx, sy, sz] = part.size;
    const geo = part.round ? new THREE.CylinderGeometry(sx / 2, sx / 2 * 0.9, sz, 10) : new THREE.BoxGeometry(sx, sy, sz);
    if (part.round) { if (part.axis === 'x') geo.rotateZ(PI / 2); else geo.rotateX(PI / 2); }
    const mat = part.glass
      ? new THREE.MeshPhongMaterial({ color: part.color, specular: 0xaad0ff, shininess: 120 })
      : new THREE.MeshLambertMaterial({ color: part.color });
    const m = new THREE.Mesh(geo, mat);
    m.scale.setScalar(sc);
    m.castShadow = m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  /** Crash an aircraft. opts: {air: shot down in flight, water: hit the sea} */
  crash(jet, opts) {
    const app = this.app, w = app.world;
    opts = opts || {};
    const sc = jet.spec ? jet.spec.scale : 1;
    const dims = jet.spec ? PLANE_DIMS[jet.spec.key] : null;
    const es = dims ? clamp(sc * (dims.L / 22), 2.2, 4.6) : 1.7; // explosion size
    const p = jet.pos;
    const gh = w.groundTop(p.x, p.z);
    const water = !!opts.water || (!opts.air && w.heightAt(p.x, p.z) < 0.5 && p.y < 40);
    const air = !!opts.air && p.y - gh > 40;
    const cx = p.x, cz = p.z, cy = air ? p.y : Math.max(p.y, gh + 1.5);
    const vel = jet.vel;

    // 1. the explosion
    if (water) {
      this.splash(cx, 0, cz, es * 1.2);
      app.fx.explosion(cx, 3, cz, es * 0.55, 0, 0, 0);
    } else {
      app.fx.explosion(cx, cy, cz, es, vel.x * 0.25, vel.y * 0.15, vel.z * 0.25);
      if (!air) this.dustRing(cx, gh, cz, es, vel);
    }

    // 2. the airframe breaks into pieces
    const parts = this.partsFor(jet);
    let biggest = null, bigSize = 0;
    for (const part of parts) {
      const mesh = this.makeMesh(part, sc);
      _kv.set(part.at[0] * sc, part.at[1] * sc, part.at[2] * sc).applyQuaternion(jet.quat);
      mesh.position.copy(p).add(_kv);
      mesh.quaternion.copy(jet.quat);
      const radius = Math.max(0.5, Math.max(part.size[0], part.size[1], part.size[2]) * sc * 0.32);
      const burst = (air ? rand(25, 70) : rand(8, 38)) * Math.sqrt(sc);
      const out = _kw.copy(_kv).normalize();
      const c = {
        mesh, r: radius, s: radius * 0.35 + 0.5,
        vel: new THREE.Vector3(vel.x * (air ? 0.85 : 0.9), vel.y * (air ? 0.85 : 0.2), vel.z * (air ? 0.85 : 0.9)),
        ang: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(rand(1.5, air ? 7 : 5)),
        rest: false, age: 0, burn: rand(8, 20) * (0.7 + 0.3 * Math.min(sc, 2)), acc: 0, sunk: 0, fade: 1, water: false,
      };
      c.vel.addScaledVector(out, burst);
      c.vel.y += rand(2, air ? 18 : 28) * Math.sqrt(sc);
      c.fric = 1.5;
      if (part.shard) { // torn-off plates are thrown wide and flutter down
        c.vel.multiplyScalar(rand(1.0, 1.5)); c.vel.y += rand(5, 30);
        c.ang.multiplyScalar(2.2); c.burn = rand(0.4, 3); c.s *= 0.5; c.fric = 2.6;
      } else if (part.wheel) { c.wheel = true; c.burn = rand(10, 20); c.fric = 0.45; c.vel.multiplyScalar(1.15); }
      else if (part.cargo) { c.burn = rand(2, 7); c.vel.multiplyScalar(rand(0.9, 1.3)); }
      else if (part.glass) { c.burn = 0; c.vel.multiplyScalar(1.2); }
      c.interval = c.s > 1.5 ? 0.06 : c.s > 0.9 ? 0.1 : 0.24; // small pieces make fewer puffs (keeps the particle budget in check)
      this.chunks.push(c);
      const size = part.size[0] * part.size[1] * part.size[2];
      if (size > bigSize && !part.round) { bigSize = size; biggest = c; }
    }
    this.focusChunk = biggest;

    // 2b. a crash in the city: the shock wave brings the buildings around it down
    if (!water && w.city && w.city.inside(cx, cz, 120) && (!air || cy - gh < 160)) w.city.blast(cx, cz, 70 + 62 * es, es, this);

    // 3. the site burns, leaves a scorch mark, and the fuel goes up a few more times
    if (!water) {
      this.sites.push({ x: cx, y: air ? gh : gh, z: cz, t: 0, life: air ? 0 : 30, size: es, acc: 0 });
      if (!air) {
        this.scorch(cx, gh, cz, vel, es);
        for (let k = 0; k < 3; k++) {
          const t = 0.35 + k * rand(0.35, 0.7);
          this.timers.push({ t, fn: () => {
            const a = this.focusChunk ? this.focusChunk.mesh.position : _kv.set(cx, gh + 2, cz);
            const px = a.x + rand(-8, 8) * es, pz = a.z + rand(-8, 8) * es;
            app.fx.explosion(px, w.groundTop(px, pz) + 2, pz, es * rand(0.3, 0.6), 0, 0, 0);
            this.noise(px, w.groundTop(px, pz), pz, 'boom', es);
          } });
        }
      }
    }

    // 4. sound
    this.listener = opts.listener || null;
    const cp = this.listener || app.camera.position;
    const snd = () => { if (app.audio && app.audio.ok) app.audio.crash({ x: cx - cp.x, y: cy - cp.y, z: cz - cp.z }, es / 1.7, water); };
    this.after(snd, cx, cy, cz);
  }

  /* ----- effects ------------------------------------------------------------------- */

  dustRing(x, y, z, es, vel) {
    const fx = this.app.fx;
    for (let i = 0; i < 44; i++) {
      const a = rand(0, TAU), sp = rand(18, 70) * Math.sqrt(es);
      fx.puff(x + Math.cos(a) * 4, y + 1, z + Math.sin(a) * 4, Math.cos(a) * sp + vel.x * 0.3, rand(1, 7), Math.sin(a) * sp + vel.z * 0.3,
        rand(2.5, 5), rand(5, 9) * es, rand(26, 48) * es, rand(0.36, 0.5), rand(0.4, 0.7), 1.3, rand(0.3, 1.2));
    }
  }

  splash(x, y, z, es) {
    const fx = this.app.fx;
    for (let i = 0; i < 60; i++) {
      const a = rand(0, TAU), sp = rand(6, 42) * Math.sqrt(es);
      fx.puff(x, y + 1, z, Math.cos(a) * sp, rand(10, 46) * Math.sqrt(es), Math.sin(a) * sp, rand(1.8, 4), rand(3, 7) * es, rand(10, 30) * es, 0.92, rand(0.5, 0.8), 0.9, -3);
    }
  }

  scorch(x, y, z, vel, es) {
    if (!this._markTex) {
      const [cv, g] = makeCanvas(128, 128);
      const gr = g.createRadialGradient(64, 64, 6, 64, 64, 62);
      gr.addColorStop(0, 'rgba(8,6,4,0.95)'); gr.addColorStop(0.55, 'rgba(14,10,6,0.7)'); gr.addColorStop(1, 'rgba(20,14,8,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      this._markTex = new THREE.CanvasTexture(cv);
    }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: this._markTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const m = new THREE.Mesh(geo, mat);
    const sp = Math.hypot(vel.x, vel.z);
    const len = clamp(sp * 0.35 * Math.sqrt(es), 30 * es, 260 * es);
    m.scale.set(26 * es, 1, len);
    const hx = sp > 1 ? vel.x / sp : 0, hz = sp > 1 ? vel.z / sp : 1;
    m.rotation.y = Math.atan2(hx, hz);
    m.position.set(x + hx * len * 0.35, y + 0.3, z + hz * len * 0.35);
    m.renderOrder = 2;
    this.group.add(m);
    this.marks.push(m);
    if (this.marks.length > 6) { const o = this.marks.shift(); this.group.remove(o); o.geometry.dispose(); o.material.dispose(); }
  }

  /** a building starts to collapse: dust, glass, flying concrete, sometimes fire, and the roar of it coming down */
  buildingDown(bl, y0) {
    const app = this.app, fx = app.fx;
    const H = bl.H, cx = bl.x, cz = bl.z;
    // billowing dust from the whole height of the building
    const n = clamp(10 + Math.round(H / 8), 10, 34);
    for (let i = 0; i < n; i++) {
      fx.puff(cx + rand(-1, 1) * bl.hw, y0 + Math.random() * H, cz + rand(-1, 1) * bl.hd, rand(-14, 14), rand(-4, 9), rand(-14, 14),
        rand(5, 9), rand(10, 16), rand(38, 70) + H * 0.15, rand(0.5, 0.7), rand(0.5, 0.75), 0.9, rand(0.5, 2));
    }
    // the dust wave that rolls out along the street
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + rand(-0.2, 0.2), sp = rand(20, 42);
      fx.puff(cx + Math.cos(a) * bl.hw, y0 + 2, cz + Math.sin(a) * bl.hd, Math.cos(a) * sp, rand(0.5, 3), Math.sin(a) * sp, rand(3.5, 6.5), rand(8, 12), rand(26, 46), rand(0.45, 0.62), rand(0.45, 0.7), 1.2, rand(0, 1));
    }
    // windows blowing out: glittering glass
    for (let i = 0; i < 16; i++) {
      fx.glow(cx + rand(-1, 1) * bl.hw, y0 + Math.random() * H, cz + rand(-1, 1) * bl.hd, rand(-18, 18), rand(-4, 12), rand(-18, 18), rand(0.5, 1.1), 1.6, 0.6, 0.75, 0.92, 1, 0.85, 0.5);
    }
    // chunks of concrete, steel and curtain wall thrown out
    if (this.chunks.length < 520) {
      const nd = clamp(Math.round(2 + H / 22), 2, 9);
      const cols = [0x8d8b86, 0x7c7a76, 0x9b9791, 0x6f8fa6, 0x55585c];
      for (let i = 0; i < nd; i++) {
        const sz = rand(1.2, 4.2);
        const a = rand(0, TAU), sp = rand(10, 36);
        this.addDebris(cx + rand(-1, 1) * bl.hw, y0 + H * rand(0.25, 1), cz + rand(-1, 1) * bl.hd, Math.cos(a) * sp, rand(5, 28), Math.sin(a) * sp, sz, cols[i % cols.length], rand(1.5, 5));
      }
    }
    // some of them burn
    if (Math.random() < 0.4) this.sites.push({ x: cx, y: y0 + H * 0.12, z: cz, t: 0, life: rand(18, 38), size: clamp(0.8 + H / 120, 0.8, 2.4), acc: 0 });
    // sound (limited so a whole district coming down is a roar, not a thousand voices)
    if (this.collT <= 0) {
      this.collT = 0.2;
      const a = app.audio, cp = this.listener || app.camera.position;
      if (a && a.ok && a.collapse) { const rel = { x: cx - cp.x, y: y0 + H * 0.4 - cp.y, z: cz - cp.z }; this.after(() => a.collapse(rel, clamp(H / 80, 0.4, 2)), cx, y0, cz); }
    }
  }

  /** one tumbling lump of debris (concrete, glass, steel) */
  addDebris(x, y, z, vx, vy, vz, size, color, burn) {
    const part = { size: [size, size * rand(0.35, 0.8), size * rand(0.6, 1.2)], color };
    const mesh = this.makeMesh(part, 1);
    mesh.position.set(x, y, z);
    mesh.quaternion.setFromEuler(new THREE.Euler(rand(0, TAU), rand(0, TAU), rand(0, TAU)));
    const radius = Math.max(0.5, size * 0.4);
    this.chunks.push({
      mesh, r: radius, s: radius * 0.35 + 0.4, vel: new THREE.Vector3(vx, vy, vz),
      ang: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(rand(1.5, 5)),
      rest: false, age: 0, burn, acc: 0, sunk: 0, fade: 1, water: false, fric: 1.8, interval: 0.22,
    });
  }

  /** run a sound function after sound has travelled from (x,y,z) to the listener (no delay in live flight) */
  after(fn, x, y, z) {
    const l = this.listener;
    const d = l ? Math.hypot(x - l.x, y - l.y, z - l.z) : 0;
    if (d > 120) setTimeout(fn, Math.min(d / SPEED_OF_SOUND, 20) * 1000); else fn();
  }

  noise(x, y, z, kind, size) {
    const a = this.app.audio, cp = this.listener || this.app.camera.position;
    if (!a || !a.ok) return;
    const rel = { x: x - cp.x, y: y - cp.y, z: z - cp.z };
    this.after(() => { if (kind === 'boom') a.explosion(rel, size > 1.6); else if (a.thud) a.thud(rel, size); }, x, y, z);
  }

  /* ----- simulation --------------------------------------------------------------------- */

  update(dt) {
    const app = this.app, w = app.world, fx = app.fx;
    this.thudT -= dt;
    this.collT -= dt;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) { this.timers.splice(i, 1); t.fn(); }
    }

    // burning wreck sites
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      s.t += dt;
      if (s.life > 0 && s.t > s.life) { this.sites.splice(i, 1); continue; }
      if (s.life <= 0) { this.sites.splice(i, 1); continue; }
      const k = 1 - s.t / s.life;
      s.acc += dt;
      while (s.acc > 0.09) {
        s.acc -= 0.09;
        const f = s.size * (0.4 + 0.6 * k);
        fx.glow(s.x + rand(-6, 6) * f, s.y + 1, s.z + rand(-6, 6) * f, rand(-2, 2), rand(6, 14), rand(-2, 2), rand(0.5, 1.0), rand(5, 9) * f, rand(10, 18) * f, 1, rand(0.45, 0.65), rand(0.1, 0.2), 0.9, 0.8);
        fx.puff(s.x + rand(-5, 5) * f, s.y + 3, s.z + rand(-5, 5) * f, rand(-2, 2), rand(8, 14), rand(-2, 2), rand(4, 7), rand(7, 11) * f, rand(26, 46) * f, rand(0.06, 0.15), 0.7 * (0.4 + 0.6 * k), 0.5, 5);
      }
    }

    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i], m = c.mesh;
      c.age += dt;
      const pos = m.position;
      if (!c.rest && c.age > 22) c.rest = true; // anything still tumbling after this long has come to a halt for our purposes
      if (!c.rest) {
        c.vel.y -= 11 * dt;
        pos.addScaledVector(c.vel, dt);
        if (c.ang.lengthSq() > 1e-8) {
          _kq.setFromAxisAngle(_kv.copy(c.ang).normalize(), c.ang.length() * dt);
          m.quaternion.premultiply(_kq);
        }
        const gh = w.surfaceAt(pos.x, pos.z);
        const inWater = w.heightAt(pos.x, pos.z) < 0.5;
        // what is the piece touching? the terrain (with its real slope), or the side / roof of a building
        let touch = 0, nx = 0, ny = 1, nz = 0, wall = false;
        if (pos.y - c.r < gh) {
          touch = 1;
          pos.y = gh + c.r;
          if (!inWater) { // slope of the hillside under it
            const e = 4;
            const sx = (w.surfaceAt(pos.x + e, pos.z) - w.surfaceAt(pos.x - e, pos.z)) / (2 * e);
            const sz = (w.surfaceAt(pos.x, pos.z + e) - w.surfaceAt(pos.x, pos.z - e)) / (2 * e);
            const il = 1 / Math.sqrt(sx * sx + 1 + sz * sz);
            nx = -sx * il; ny = il; nz = -sz * il;
          }
        } else if (w.city) {
          const hit = w.city.collide(pos.x, pos.y, pos.z, c.r);
          if (hit) {
            touch = 2;
            pos.x += hit.nx * hit.pen; pos.y += hit.ny * hit.pen; pos.z += hit.nz * hit.pen;
            nx = hit.nx; ny = hit.ny; nz = hit.nz;
            wall = ny < 0.5;
          }
        }
        if (touch && inWater && touch === 1) {
          if (!c.water) { c.water = true; this.splash(pos.x, 0, pos.z, 0.35 + c.s * 0.2); }
          c.vel.multiplyScalar(Math.exp(-dt * 3));
          c.vel.y = Math.max(c.vel.y, 0) - 2.5;
          c.ang.multiplyScalar(Math.exp(-dt * 2));
          pos.y = Math.min(pos.y, -c.sunk * 3);
          c.sunk += dt;
          if (c.sunk > 3.5) { this.dropChunk(c); this.chunks.splice(i, 1); if (this.focusChunk === c) this.focusChunk = null; continue; }
        } else if (touch) {
          // bounce off the surface (velocity reflected about its normal), then friction along it
          const vn = c.vel.x * nx + c.vel.y * ny + c.vel.z * nz;
          if (vn < 0) {
            if (-vn > 12) {
              const rest = c.wheel ? 0.5 : 0.26;
              c.vel.x -= (1 + rest) * vn * nx; c.vel.y -= (1 + rest) * vn * ny; c.vel.z -= (1 + rest) * vn * nz;
              c.ang.multiplyScalar(0.75);
              c.ang.x += rand(-2, 2); c.ang.y += rand(-2, 2); c.ang.z += rand(-2, 2); // an impact sets it tumbling a different way
              this.landed(c, -vn, wall);
            } else { c.vel.x -= vn * nx; c.vel.y -= vn * ny; c.vel.z -= vn * nz; }
          }
          const vn2 = c.vel.x * nx + c.vel.y * ny + c.vel.z * nz;
          const tx = c.vel.x - vn2 * nx, ty = c.vel.y - vn2 * ny, tz = c.vel.z - vn2 * nz;
          const f = Math.exp(-dt * (wall ? c.fric * 0.4 : c.fric));
          c.vel.set(vn2 * nx + tx * f, vn2 * ny + ty * f, vn2 * nz + tz * f);
          c.ang.multiplyScalar(Math.exp(-dt * 1.3));
          const hs = Math.hypot(tx, ty, tz);
          if (hs > 22 && Math.random() < dt * 40) {
            fx.glow(pos.x, pos.y - c.r * 0.7, pos.z, rand(-6, 6), rand(4, 16), rand(-6, 6), rand(0.2, 0.5), 1.5, 0.6, 1, rand(0.7, 0.9), rand(0.3, 0.5), 1, 0.5);
            fx.puff(pos.x, pos.y - c.r * 0.5, pos.z, -tx * 0.1 + rand(-3, 3), rand(1, 5), -tz * 0.1 + rand(-3, 3), rand(1.5, 3), 3, 9, wall ? 0.6 : 0.42, 0.5, 1.2, 1);
          }
          if (hs < 1.2 && Math.abs(vn2) < 1.5 && c.ang.length() < 0.5 && ny > 0.78) c.rest = true;
        } else if (!inWater && pos.y - gh < 16 && w.terrain.forestMask(pos.x, pos.z) > 0.45 && !c.rest) {
          // low through a forest: trees snap and slow the piece down
          c.vel.multiplyScalar(Math.exp(-dt * 1.1));
          if (Math.random() < dt * 8) fx.puff(pos.x, pos.y, pos.z, rand(-4, 4), rand(2, 8), rand(-4, 4), rand(1.2, 2.4), 2, 7, 0.34, 0.5, 1, 1);
        }
      }
      // charring
      if (c.age > 0.6) m.material.color.lerp(this.charred, Math.min(1, dt * 0.35));
      // fire and smoke trail
      const left = c.burn - c.age;
      c.acc += dt;
      while (c.acc > c.interval) {
        c.acc -= c.interval;
        if (c.water) break;
        const b = clamp(left / c.burn, 0, 1);
        const sm = c.s * (c.rest ? 0.6 : 1);
        if (left > 0) fx.glow(pos.x, pos.y + c.r * 0.5, pos.z, rand(-1.5, 1.5), rand(1, 5), rand(-1.5, 1.5), rand(0.35, 0.8), rand(1.5, 2.6) * sm, rand(4, 7) * sm, 1, rand(0.5, 0.75), rand(0.1, 0.25), 0.85 * (0.4 + 0.6 * b), 0.8);
        if (c.burn > 0 && left > -14) fx.puff(pos.x, pos.y + c.r * 0.6, pos.z, rand(-1.5, 1.5) - c.vel.x * 0.1, rand(2, 6), rand(-1.5, 1.5) - c.vel.z * 0.1, rand(2.5, 5), rand(2.5, 4) * sm, rand(9, 18) * sm, rand(0.07, 0.16), 0.55 * clamp((left + 14) / 14, 0.15, 1), 0.7, 3);
      }
    }
  }

  landed(c, speed, wall) {
    const fx = this.app.fx, p = c.mesh.position;
    const k = clamp(speed / 40, 0.3, 1.6) * Math.sqrt(c.s);
    for (let i = 0; i < 5; i++) {
      const a = rand(0, TAU);
      // dirt off the ground, grey concrete dust off a building
      fx.puff(p.x, p.y - c.r * 0.6, p.z, Math.cos(a) * rand(4, 16) * k, rand(1, 5), Math.sin(a) * rand(4, 16) * k, rand(1.5, 3.2), 2.5 * k, 9 * k + 4, wall ? rand(0.55, 0.7) : rand(0.38, 0.5), 0.55, 1.2, 0.8);
    }
    if (wall && speed > 30) { // glass and masonry showering down from the impact
      for (let i = 0; i < 8; i++) fx.glow(p.x, p.y, p.z, rand(-14, 14), rand(-6, 10), rand(-14, 14), rand(0.4, 0.9), 1.4, 0.5, 0.75, 0.9, 1, 0.8, 0.4);
    }
    if (speed > 26 && c.s > 1.4 && Math.random() < 0.6) fx.explosion(p.x, p.y, p.z, 0.16 * c.s, 0, 0, 0);
    if (this.thudT <= 0) { this.thudT = 0.12; this.noise(p.x, p.y, p.z, 'thud', clamp(c.s * 0.5, 0.4, 2)); }
  }

  /** where the camera should look: the biggest piece of wreckage */
  focus(out) {
    const c = this.focusChunk;
    if (c && this.chunks.includes(c)) return out.copy(c.mesh.position);
    return null;
  }
}

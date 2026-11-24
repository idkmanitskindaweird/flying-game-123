'use strict';
/* ==========================================================================
   crash.js - realistic aircraft crashes (any aircraft: fighters, C-17, 737, 747).
   The airframe breaks into chunks (fuselage sections, wings, tail, engines) that fly on, tumble, bounce,
   skid and burn. Ground impacts throw dust, burn, leave a scorch mark and trigger secondary explosions;
   crashes into the sea make a splash instead; mid-air kills break the aircraft up and the burning pieces
   rain down. Each piece leaves a smoke trail and rests burning where it stops.
   ========================================================================== */

/** crash detail by level (Low..Ultra): how many pieces may exist, how many small shards a plane breaks into, buildings that can fall, cells per slab */
const CRASH_Q = { cap: [450, 900, 1400, 2100, 3200], shards: [0.3, 0.65, 1, 1.5, 2.2], blast: [30, 55, 80, 110, 160], cells: [2, 3, 4, 5, 6] };
function crashLevel() { return (typeof App !== 'undefined' && App.quality && App.quality.crash !== undefined) ? App.quality.crash : 2; }

const PLANE_DIMS = {
  c17: { L: 53, R: 3.3, span: 52, finH: 10, engines: [[9.6, 1], [17.2, 1]] },
  b737: { L: 39.5, R: 1.95, span: 35.8, finH: 6.6, engines: [[5.9, 1]] },
  b2: { L: 21, R: 2, span: 52.4, finH: 0, engines: [] },
  b747: { L: 70.7, R: 3.25, span: 64.4, finH: 11.6, engines: [[11.8, 1], [24.4, 1]] },
};

const _kq = new THREE.Quaternion();
const _kv = new THREE.Vector3();
const _kw = new THREE.Vector3();

/**
 * Turn a clean box / cylinder into a jagged broken lump: every vertex is pushed by a pseudo-random amount (a hash of its position,
 * so vertices that share a spot move together and the surface stays closed), then the normals are recomputed.
 * amt is the largest push as a fraction of the piece's size per axis.
 */
function jaggedGeometry(geo, amt) {
  geo.computeBoundingBox();
  const sz = geo.boundingBox.getSize(new THREE.Vector3());
  const p = geo.attributes.position, k = Math.random() * 100;
  const h = (x, y, z, o) => { const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + (k + o) * 19.19) * 43758.5453; return n - Math.floor(n); };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const rx = Math.round(x * 40), ry = Math.round(y * 40), rz = Math.round(z * 40);
    p.setXYZ(i, x + (h(rx, ry, rz, 1) - 0.5) * 2 * amt * sz.x, y + (h(rx, ry, rz, 2) - 0.5) * 2 * amt * sz.y, z + (h(rx, ry, rz, 3) - 0.5) * 2 * amt * sz.z);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

const _ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1)); // random integer in [a, b]

class CrashFX {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    app.scene.add(this.group);
    this.chunks = [];
    this.sites = []; // burning wreck sites
    this.plumes = []; // long-lived smoke columns rising from wrecks and burning buildings
    this.timers = [];
    this.marks = [];
    this.thudT = 0;
    this.collT = 0;
    this.dustK = 1; // < 1 while a nuclear blast brings down hundreds of buildings (each gets fewer dust puffs)
    this.listener = null; // when set (the Replay Lab), sounds are heard from here and arrive after the travel time of sound
    this.focusChunk = null;
    this.charred = new THREE.Color(0x1b1a19);
  }

  clear() {
    for (const c of this.chunks) this.dropChunk(c);
    this.chunks.length = 0;
    this.sites.length = 0;
    this.plumes.length = 0;
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
    if (spec.key === 'b2') { // a flying wing breaks into wing panels and a blunt centre body, and spills its bombs
      const top = 0x3b3f45, under = 0x2a2d32;
      parts.push({ size: [7.5, 2.3, 8], at: [0, 0.2, -4.2], color: top }, { size: [8.5, 2.0, 8], at: [0, 0.1, 3.6], color: under });
      parts.push({ size: [2.4, 0.9, 3], at: [0, 1.2, -6.4], color: 0x10161d, glass: true });
      for (const sx of [1, -1]) {
        parts.push({ size: [7, 0.5, 11], at: [sx * 8.5, 0, 0.5], color: top }, { size: [7, 0.45, 9], at: [sx * 15.5, 0, 2.2], color: top }, { size: [5, 0.4, 5], at: [sx * 21.8, 0, 4.2], color: top });
        parts.push({ size: [4, 0.3, 2.2], at: [sx * 12, 0, 7.6], color: under }, { size: [3.4, 0.3, 2], at: [sx * 6, 0, 9], color: under });
        parts.push({ size: [0.9, 0.9, 1.6], at: [sx * 3.4, 0, 3.4], color: 0x3a3d42, round: true });
        parts.push({ size: [0.6, 0.6, 0.5], at: [sx * 4.2, -2.2, 1.6], color: 0x1f2125, round: true, axis: 'x', wheel: true });
      }
      parts.push({ size: [0.6, 0.6, 0.5], at: [0, -2.2, -6.6], color: 0x1f2125, round: true, axis: 'x', wheel: true });
      for (let i = 0; i < 8; i++) parts.push({ size: [0.7, 0.7, 3.6], at: [rand(-3, 3), -0.6, rand(-3, 3)], color: 0x55595f, round: true, cargo: true }); // bombs
      this.addShrapnel(parts, 70, 14, [top, under, 0x131518, 0x55595f]);
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
    n = Math.round(n * CRASH_Q.shards[crashLevel()]);
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
    // a random number of segments gives every piece a different number of vertices, and the jitter makes the pieces jagged
    let geo;
    if (part.round) {
      geo = new THREE.CylinderGeometry(sx / 2, sx / 2 * 0.9, sz, part.wheel ? 12 : _ri(5, 12), _ri(1, 2));
      if (part.axis === 'x') geo.rotateZ(PI / 2); else geo.rotateX(PI / 2);
      jaggedGeometry(geo, part.wheel ? 0.04 : 0.1);
    } else {
      geo = new THREE.BoxGeometry(sx, sy, sz, _ri(1, part.shard ? 3 : 2), _ri(1, part.shard ? 2 : 2), _ri(1, part.shard ? 3 : 2));
      jaggedGeometry(geo, part.glass ? 0.06 : part.shard ? 0.32 : part.cargo ? 0.08 : 0.16);
    }
    const mat = part.glass
      ? new THREE.MeshPhongMaterial({ color: part.color, specular: 0xaad0ff, shininess: 120 })
      : new THREE.MeshLambertMaterial({ color: part.color });
    const m = new THREE.Mesh(geo, mat);
    m.scale.setScalar(sc);
    m.castShadow = !part.shard && Math.max(sx, sy, sz) * sc > 1.2; // thin shards and splinters do not cast shadows: every shadow caster is an extra draw call
    m.receiveShadow = true;
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
    const cx = p.x, cz = p.z, cy = air ? p.y : Math.max(p.y, w.surfaceAt(p.x, p.z) + 1.5); // (a wall strike happens at the height of the wall, not on the roof)
    const vel = jet.vel;

    // ---- how the aircraft meets the ground decides what kind of crash it is --------------------------------------------------
    //  'skid'   : a shallow angle at speed: it hits flat, slides, sheds wings and engines, and leaves a long burning trail
    //  'tumble' : a medium angle: it cartwheels and breaks up along a shorter path
    //  'impact' : a steep dive or a wall: it is pulverised in one spot, with a crater
    let kind = air ? 'air' : water ? 'water' : 'impact';
    const nrm = new THREE.Vector3(0, 1, 0), vT = new THREE.Vector3(), tdir = new THREE.Vector3(1, 0, 0);
    let speedT = 0, vInto = 0, skid = 0;
    if (!air && !water) {
      const e = 4, gx = (w.surfaceAt(cx + e, cz) - w.surfaceAt(cx - e, cz)) / (2 * e), gz = (w.surfaceAt(cx, cz + e) - w.surfaceAt(cx, cz - e)) / (2 * e);
      const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      nrm.set(-gx * il, il, -gz * il);
      const vn = vel.dot(nrm);
      vInto = Math.max(0, -vn);
      vT.copy(vel).addScaledVector(nrm, -vn);
      speedT = vT.length();
      if (speedT > 1) tdir.copy(vT).multiplyScalar(1 / speedT);
      const wall = p.y - w.surfaceAt(cx, cz) > 6; // it hit something standing on the ground: a building or the tower
      const ang = Math.atan2(vInto, Math.max(speedT, 1));
      kind = wall || ang > 0.95 ? 'impact' : ang < 0.34 && speedT > 35 ? 'skid' : 'tumble';
      skid = kind === 'skid' ? clamp((speedT * speedT) / (2 * 0.42 * 9.81), 25, 650) : kind === 'tumble' ? clamp((speedT * speedT) / (2 * 0.9 * 9.81) * 0.5, 10, 220) : 0;
    }
    const half = dims ? (dims.L / 2) * sc : 8.5;

    // 1. the explosion
    if (water) {
      this.splash(cx, 0, cz, es * 1.2);
      app.fx.explosion(cx, 3, cz, es * 0.55, 0, 0, 0);
    } else {
      app.fx.explosion(cx, cy, cz, es, vel.x * 0.25, vel.y * 0.15, vel.z * 0.25);
      // the fireball: a big aircraft (airliner, C-17) gets a much bigger one, with a second eruption
      const big = !!jet.spec, fb = big ? clamp(es * 2.3, 5, 10.5) : 1.7; // airliners and the C-17 get a fireball 3-6x the size of a fighter's
      app.fx.fireball(cx, cy, cz, fb, big);
      w.flash(cx, cy, cz, big ? fb * 0.7 : 1);
      if (big) {
        this.timers.push({ t: 0.35, fn: () => { app.fx.fireball(cx + rand(-14, 14) * fb, cy + 2, cz + rand(-14, 14) * fb, fb * 0.65, false); w.flash(cx, cy, cz, fb * 0.5); } });
        this.timers.push({ t: 0.8, fn: () => { app.fx.fireball(cx + rand(-20, 20) * fb, cy + 2, cz + rand(-20, 20) * fb, fb * 0.5, false); } });
      }
      if (!air) this.dustRing(cx, gh, cz, es, vel);
    }

    // 2. the airframe breaks into pieces
    let parts = this.partsFor(jet);
    if (jet.lost && (jet.lost.wingL || jet.lost.wingR)) { // a wing that already came off earlier is not part of this wreck
      const cutL = wingCutFor(jet) / sc;
      parts = parts.filter((pt) => !((jet.lost.wingL && pt.at[0] < -cutL * 0.9) || (jet.lost.wingR && pt.at[0] > cutL * 0.9)));
    }
    let biggest = null, bigSize = 0;
    for (const part of parts) {
      const mesh = this.makeMesh(part, sc);
      _kv.set(part.at[0] * sc, part.at[1] * sc, part.at[2] * sc).applyQuaternion(jet.quat);
      mesh.position.copy(p).add(_kv);
      mesh.quaternion.copy(jet.quat);
      const radius = Math.max(0.5, Math.max(part.size[0], part.size[1], part.size[2]) * sc * 0.32);
      const out = _kw.copy(_kv).normalize();
      let c;
      if (!air && !water) {
        // the parts that hit first stop first; the rear carries on with most of the speed along the ground
        const sPos = speedT > 1 ? clamp(_kv.dot(tdir) / half, -1, 1) : 0; // +1 at the front (towards the direction of travel), -1 at the rear
        const rear = (1 - sPos) / 2;
        const ret = kind === 'impact' ? 0.05 + 0.08 * rear : kind === 'skid' ? 0.7 + 0.24 * rear : 0.36 + 0.28 * rear;
        const burst = (kind === 'impact' ? rand(10, 42) : rand(3, 14)) * Math.sqrt(sc);
        c = {
          mesh, r: radius, s: radius * 0.35 + 0.5,
          vel: new THREE.Vector3().copy(vT).multiplyScalar(ret).addScaledVector(nrm, vInto * rand(0.04, 0.22) * (1 - ret) + rand(1, 7)),
          ang: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(kind === 'skid' ? rand(0.4, 2.2) : rand(2, 6)),
          rest: false, age: 0, burn: rand(8, 20) * (0.7 + 0.3 * Math.min(sc, 2)), acc: 0, sunk: 0, fade: 1, water: false,
        };
        c.vel.addScaledVector(out, burst);
        if (sPos > 0.55 && kind !== 'skid') mesh.scale.z *= 0.55; // the nose is crushed against what it hit
        c.fric = kind === 'skid' ? 0.6 : 1.4;
      } else {
        const burst = (air ? rand(25, 70) : rand(8, 38)) * Math.sqrt(sc);
        c = {
          mesh, r: radius, s: radius * 0.35 + 0.5,
          vel: new THREE.Vector3(vel.x * (air ? 0.85 : 0.9), vel.y * (air ? 0.85 : 0.2), vel.z * (air ? 0.85 : 0.9)),
          ang: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(rand(1.5, air ? 7 : 5)),
          rest: false, age: 0, burn: rand(8, 20) * (0.7 + 0.3 * Math.min(sc, 2)), acc: 0, sunk: 0, fade: 1, water: false,
        };
        c.vel.addScaledVector(out, burst);
        c.vel.y += rand(2, air ? 18 : 28) * Math.sqrt(sc);
        c.fric = 1.5;
      }
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

    // 2-. what the ground does: a skid leaves a long gouged, burning trail; a steep impact digs a crater and throws earth
    if (!air && !water && !(kind === 'impact' && p.y - w.surfaceAt(cx, cz) > 6)) {
      const soil = [0x4d3b29, 0x5b4733, 0x3c4a2a, 0x6a5a44];
      const bigp = !!jet.spec, fbp = bigp ? clamp(es * 2.3, 5, 10.5) : 1.7;
      if (kind === 'skid' || kind === 'tumble') {
        const nS = Math.min(14, Math.floor(skid / 45));
        for (let k = 1; k <= nS; k++) {
          const d = k * 45, px = cx + tdir.x * d, pz = cz + tdir.z * d, gyp = w.surfaceAt(px, pz);
          this.sites.push({ x: px, y: gyp, z: pz, t: 0, life: rand(14, 34), size: es * rand(0.3, 0.55), acc: 0 });
          this.timers.push({ t: d / Math.max(speedT * 0.7, 20), fn: () => {
            const fx2 = app.fx;
            for (let i = 0; i < 14; i++) fx2.glow(px + rand(-6, 6), gyp + 0.6, pz + rand(-6, 6), rand(-9, 9) + tdir.x * 10, rand(3, 16), rand(-9, 9) + tdir.z * 10, rand(0.3, 0.8), 1.8, 0.6, 1, rand(0.7, 0.95), rand(0.3, 0.5), 1, 0.5);
            for (let i = 0; i < 6; i++) fx2.puff(px + rand(-6, 6), gyp + 1, pz + rand(-6, 6), rand(-5, 5), rand(1, 6), rand(-5, 5), rand(2, 4), 6, 22, rand(0.36, 0.5), 0.55, 1.2, 1);
            if (bigp && k % 5 === 0) fx2.fireball(px, gyp + 2, pz, fbp * 0.4, false);
          } });
        }
        // clods of earth torn up along the whole path
        const nC = kind === 'skid' ? clamp(Math.round(skid / 5), 12, 70) : 22;
        for (let i = 0; i < nC; i++) {
          const d = Math.random() * Math.max(skid, 10), px = cx + tdir.x * d, pz = cz + tdir.z * d;
          this.addDebris(px + rand(-5, 5), w.surfaceAt(px, pz) + 1, pz + rand(-5, 5), tdir.x * speedT * 0.25 + rand(-8, 8), rand(5, 22), tdir.z * speedT * 0.25 + rand(-8, 8), rand(0.5, 1.9), soil[i % soil.length], 0);
        }
      } else {
        // a steep impact: a crater with earth thrown out of it in every direction
        for (let i = 0; i < 46; i++) {
          const a = rand(0, TAU), sp = rand(10, 46) * Math.sqrt(es / 1.7);
          this.addDebris(cx + Math.cos(a) * 3, gh + 1, cz + Math.sin(a) * 3, Math.cos(a) * sp, rand(10, 36), Math.sin(a) * sp, rand(0.5, 2.2), soil[i % soil.length], 0);
        }
      }
    }

    // 2a. the smoke: a huge black column goes up at once, and a plume keeps feeding it for a minute or more
    if (!water) {
      const fxq = app.fx.budget, big = !!jet.spec;
      const nCol = Math.round((big ? 150 : 70) * fxq);
      for (let i = 0; i < nCol; i++) {
        // a column that widens as it climbs: small puffs low down, big billows high up
        const u = Math.pow(Math.random(), 1.7), a = rand(0, TAU), o = es * (3 + 22 * u) * Math.random();
        app.fx.bigPuff(cx + Math.cos(a) * o, gh + u * es * 55 + rand(0, 6), cz + Math.sin(a) * o, es * (8 + 26 * u) * rand(0.5, 1.2), 'soot', rand(30, 58), rand(5, 20) * Math.sqrt(es / 1.7) * (0.4 + u));
      }
      this.addPlume(cx, gh + 2, cz, es * 54, big ? 110 : 70, 3.4 * fxq, 'soot');
    }

    // 2b. a crash in the city: the building the aircraft actually hit comes down; the others only if the blast is big enough to reach them
    // (a fighter's blast hardly leaves the building it hit; an airliner's fuel load can take its neighbours too)
    if (!water && w.city && w.city.inside(cx, cz, 120) && (!air || cy - gh < 400)) {
      const shock = es > 2 ? 22 * (es - 1.8) * (jet.spec && jet.spec.scale > 1.5 ? 1.2 : 1) : 0;
      w.city.blast(cx, cz, shock, es, this, cy, 5 + (jet.spec ? jet.spec.scale * 3 : 0));
    }

    // 3. the site burns, leaves a scorch mark, and the fuel goes up a few more times
    if (!water) {
      this.sites.push({ x: cx, y: air ? gh : gh, z: cz, t: 0, life: air ? 0 : 30, size: es, acc: 0 });
      if (!air) {
        this.scorch(cx, gh, cz, kind === 'skid' || kind === 'tumble' ? vT : vel, es, kind === 'impact' ? -1 : skid);
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
    const skidSecs = kind === 'skid' ? skid / Math.max(speedT * 0.6, 15) : 0; // a long scraping, tearing sound while it slides
    const snd = () => { if (app.audio && app.audio.ok) app.audio.crash({ x: cx - cp.x, y: cy - cp.y, z: cz - cp.z }, es / 1.7, water, skidSecs); };
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

  /** a dark scorched mark on the ground. skid > 0: a long gouged trench along the path of a skid; skid < 0: a round crater; 0: a mark that follows the velocity */
  scorch(x, y, z, vel, es, skid) {
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
    const hx = sp > 1 ? vel.x / sp : 0, hz = sp > 1 ? vel.z / sp : 1;
    let len, wid, off;
    if (skid > 0) { len = skid + 24 * es; wid = 17 * es; off = len * 0.5 - 12 * es; }
    else if (skid < 0) { len = wid = 34 * es; off = 0; }
    else { len = clamp(sp * 0.35 * Math.sqrt(es), 30 * es, 260 * es); wid = 26 * es; off = len * 0.35; }
    m.scale.set(wid, 1, len);
    m.rotation.y = Math.atan2(hx, hz);
    m.position.set(x + hx * off, y + 0.3, z + hz * off);
    m.renderOrder = 2;
    this.group.add(m);
    this.marks.push(m);
    if (this.marks.length > 6) { const o = this.marks.shift(); this.group.remove(o); o.geometry.dispose(); o.material.dispose(); }
  }

  /** a long-lived source of billowing smoke */
  addPlume(x, y, z, size, life, rate, kind) {
    if (this.plumes.length > 40) this.plumes.shift();
    this.plumes.push({ x, y, z, size, life, rate, kind: kind || 'soot', t: 0, acc: 0 });
  }

  /** a building starts to collapse: dust, glass, flying concrete, sometimes fire, and the roar of it coming down */
  buildingDown(bl, y0) {
    const app = this.app, fx = app.fx;
    const H = bl.H, cx = bl.x, cz = bl.z;
    // billowing dust from the whole height of the building
    const dk = this.dustK;
    const n = Math.max(2, Math.round(clamp(10 + Math.round(H / 8), 10, 34) * dk));
    for (let i = 0; i < n; i++) {
      fx.puff(cx + rand(-1, 1) * bl.hw, y0 + Math.random() * H, cz + rand(-1, 1) * bl.hd, rand(-14, 14), rand(-4, 9), rand(-14, 14),
        rand(5, 9), rand(10, 16), rand(38, 70) + H * 0.15, rand(0.5, 0.7), rand(0.5, 0.75), 0.9, rand(0.5, 2));
    }
    // the dust wave that rolls out along the street
    for (let i = 0, nr = Math.max(3, Math.round(14 * dk)); i < nr; i++) {
      const a = (i / nr) * TAU + rand(-0.2, 0.2), sp = rand(20, 42);
      fx.puff(cx + Math.cos(a) * bl.hw, y0 + 2, cz + Math.sin(a) * bl.hd, Math.cos(a) * sp, rand(0.5, 3), Math.sin(a) * sp, rand(3.5, 6.5), rand(8, 12), rand(26, 46), rand(0.45, 0.62), rand(0.45, 0.7), 1.2, rand(0, 1));
    }
    // windows blowing out: glittering glass
    for (let i = 0, ng = Math.round(16 * dk); i < ng; i++) {
      fx.glow(cx + rand(-1, 1) * bl.hw, y0 + Math.random() * H, cz + rand(-1, 1) * bl.hd, rand(-18, 18), rand(-4, 12), rand(-18, 18), rand(0.5, 1.1), 1.6, 0.6, 0.75, 0.92, 1, 0.85, 0.5);
    }
    // the dust cloud: great pale clouds that swell, rise and drift downwind for half a minute
    const fq = app.fx.budget;
    const nd = Math.max(1, Math.round(clamp(3 + H / 28, 3, 11) * fq * dk));
    for (let i = 0; i < nd; i++) {
      fx.bigPuff(cx + rand(-1, 1) * bl.hw, y0 + rand(0.05, 1) * H, cz + rand(-1, 1) * bl.hd, rand(90, 180) * (0.55 + H / 200), 'dust', rand(22, 42), rand(2, 10));
    }
    // some of them burn, and burning buildings send up a column of black smoke
    if (Math.random() < (dk < 1 ? 0.02 : 0.4)) {
      this.sites.push({ x: cx, y: y0 + H * 0.12, z: cz, t: 0, life: rand(18, 38), size: clamp(0.8 + H / 120, 0.8, 2.4), acc: 0 });
      this.addPlume(cx, y0 + H * 0.15, cz, 36 + H * 0.42, rand(45, 90), 1.4 * fq, 'soot');
    }
    // sound (limited so a whole district coming down is a roar, not a thousand voices)
    if (this.collT <= 0) {
      this.collT = 0.2;
      const a = app.audio, cp = this.listener || app.camera.position;
      if (a && a.ok && a.collapse) { const rel = { x: cx - cp.x, y: y0 + H * 0.4 - cp.y, z: cz - cp.z }; this.after(() => a.collapse(rel, clamp(H / 80, 0.4, 2)), cx, y0, cz); }
    }
  }

  /** one facade-textured block (a piece of a building) */
  makeFacadeMesh(sx, sy, sz, color) {
    const geo = new THREE.BoxGeometry(sx, sy, sz, _ri(1, 3), _ri(1, 3), _ri(1, 3)); // random segment counts: random vertex counts
    const uv = geo.attributes.uv, nr = geo.attributes.normal;
    const cz = Math.max(1, Math.round(sz / 6.2)), cx = Math.max(1, Math.round(sx / 6.2)), cv = Math.max(1, Math.round(sy / 3.6));
    for (let i = 0; i < uv.count; i++) {
      const ax = Math.abs(nr.getX(i)), ay = Math.abs(nr.getY(i));
      if (ay > 0.5) uv.setXY(i, 0.04, 0.04); // top and bottom: bare concrete
      else if (ax > 0.5) uv.setXY(i, uv.getX(i) * cz, uv.getY(i) * cv);
      else uv.setXY(i, uv.getX(i) * cx, uv.getY(i) * cv);
    }
    jaggedGeometry(geo, rand(0.1, 0.26)); // broken, uneven edges
    const mat = new THREE.MeshLambertMaterial({ map: this.app.world.city.facadeTex, color });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = Math.max(sx, sy, sz) > 5; // only the big blocks cast shadows (each one is an extra draw call)
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  /**
   * A slab of a building, from yBot to yTop, breaks off: the floors fracture into blocks (still showing windows) that are thrown
   * away from the blast, tumble, bounce off the neighbouring buildings and the street, and pile up as rubble.
   */
  slab(bl, yBot, yTop, y0, first) {
    const app = this.app, fx = app.fx;
    const dk = this.dustK;
    const hh = yTop - yBot;
    if (hh < 0.5) return;
    const mid = (yBot + yTop) / 2;
    let bx = bl.x, bz = bl.z, hw = bl.hw0 || bl.hw, hd = bl.hd0 || bl.hd;
    bl.boxes.forEach((b, k) => { const r = bl.ranges[k]; if (mid >= r[2] && mid <= r[3]) { bx = b.x; bz = b.z; hw = b.hw0; hd = b.hd0; } });
    const imp = bl.imp;
    let ix = 0, iz = 0, k = 0.4;
    if (imp) { ix = bl.x - imp.x; iz = bl.z - imp.z; const il = Math.hypot(ix, iz) || 1; ix /= il; iz /= il; k = clamp(1 - imp.d / imp.R, 0.15, 1); }
    const cm = dk < 1 ? 1 : CRASH_Q.cells[crashLevel()];
    const cols = clamp(Math.round(hw * 2 / 8), 1, cm), rows = clamp(Math.round(hd * 2 / 8), 1, cm), lays = hh > 18 && dk >= 1 ? 2 : 1;
    const sx = hw * 2 / cols, sz = hd * 2 / rows, sy = hh / lays;
    if (this.chunks.length < (dk < 1 ? 260 : CRASH_Q.cap[crashLevel()])) {
      const tone = new THREE.Color(bl.color).multiplyScalar(rand(0.55, 0.85)); // already blackened by the blast
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) for (let l = 0; l < lays; l++) {
        const px = bx - hw + (c + 0.5) * sx, pz = bz - hd + (r + 0.5) * sz, py = yBot + (l + 0.5) * sy;
        const nSub = Math.random() < 0.35 ? 2 : 1; // some blocks have already cracked in two
        for (let q = 0; q < nSub; q++) {
          const piece = Math.random() < 0.45 ? rand(0.4, 0.7) : rand(0.8, 0.98); // many blocks are only a broken part of the cell
          const ssy = sy * piece / nSub;
          const mesh = this.makeFacadeMesh(sx * piece, ssy, sz * piece, tone);
          mesh.position.set(px + rand(-0.1, 0.1) * sx, py + (nSub === 2 ? (q - 0.5) * sy * 0.5 : 0), pz + rand(-0.1, 0.1) * sz);
          mesh.quaternion.setFromEuler(new THREE.Euler(rand(-0.12, 0.12), rand(0, TAU), rand(-0.12, 0.12)));
          const ox = px - bl.x, oz = pz - bl.z, ol = Math.hypot(ox, oz) || 1;
          const radius = Math.max(0.5, Math.max(sx, ssy, sz) * piece * 0.36);
          const sp = rand(0.6, 1.4);
          this.chunks.push({
            mesh, r: radius, s: radius * 0.3 + 0.4,
            vel: new THREE.Vector3(ix * rand(6, 30) * k * sp + (ox / ol) * rand(2, 9) * (0.5 + k), (first ? rand(-2, 10) * k : rand(-9, 1)) - (py - y0) * 0.01, iz * rand(6, 30) * k * sp + (oz / ol) * rand(2, 9) * (0.5 + k)),
            ang: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(rand(0.8, 4)),
            rest: false, age: 0, burn: Math.random() < 0.3 ? rand(2, 7) : 0, acc: 0, sunk: 0, fade: 1, water: false, fric: 1.7, interval: 0.2,
          });
        }
      }
    }
    // concrete lumps, broken slabs and steel: a spread of sizes from boulders to gravel
    if (this.chunks.length < (dk < 1 ? 300 : CRASH_Q.cap[crashLevel()] + 60)) {
      const nl = Math.max(dk < 1 ? 1 : 6, Math.round(clamp(Math.round(hw * hd * hh / 260), 6, 22) * dk)), grey = [0x77756f, 0x5e5d59, 0x8a877e, 0x3d3c3a];
      for (let i = 0; i < nl; i++) {
        const big = Math.random() < 0.2;
        this.addDebris(bx + rand(-1, 1) * hw, yBot + Math.random() * hh, bz + rand(-1, 1) * hd, ix * rand(2, 22) * k + rand(-7, 7), (first ? rand(0, 12) : rand(-8, 2)), iz * rand(2, 22) * k + rand(-7, 7), big ? rand(1.6, 3.4) : rand(0.35, 1.2), grey[i % 4], 0);
      }
    }
    // the dust surge: the falling floors compress the air and blow a roiling wall of dust out along the street
    if (!first) {
      for (let i = 0, ns = Math.max(1, Math.round(7 * dk)); i < ns; i++) {
        const a = (i / ns) * TAU + rand(-0.3, 0.3), sp = rand(14, 34), rr = Math.max(hw, hd);
        fx.puff(bx + Math.cos(a) * rr, y0 + 2, bz + Math.sin(a) * rr, Math.cos(a) * sp, rand(0.5, 3), Math.sin(a) * sp, rand(3, 5.5), rand(7, 11), rand(22, 40), rand(0.45, 0.62), rand(0.4, 0.65), 1.2, rand(0, 0.6));
      }
    }
    // a swelling cloud of dust where each slab lets go
    for (let i = 0, nn = Math.max(1, Math.round(2 * app.fx.budget * dk)); i < nn; i++) fx.bigPuff(bx + rand(-1, 1) * hw, mid, bz + rand(-1, 1) * hd, rand(55, 120) * (0.6 + hh / 50), 'dust', rand(16, 32), rand(1, 7));
    // dust, glass and a flash where the floors let go
    const n = Math.max(2, Math.round(clamp(5 + Math.round(hh / 5), 5, 14) * dk));
    for (let i = 0; i < n; i++) {
      fx.puff(bx + rand(-1, 1) * hw, yBot + Math.random() * hh, bz + rand(-1, 1) * hd, rand(-12, 12) + ix * 8, rand(-3, 8), rand(-12, 12) + iz * 8,
        rand(4, 8), rand(8, 14), rand(30, 60), rand(0.5, 0.68), rand(0.5, 0.75), 0.9, rand(0.5, 1.8));
    }
    for (let i = 0, ng = Math.round(10 * dk); i < ng; i++) fx.glow(bx + rand(-1, 1) * hw, yBot + Math.random() * hh, bz + rand(-1, 1) * hd, rand(-16, 16), rand(-3, 10), rand(-16, 16), rand(0.5, 1.0), 1.5, 0.6, 0.75, 0.92, 1, 0.85, 0.5);
    if (first && dk >= 1) fx.explosion(bx, mid, bz, clamp(bl.H / 140, 0.25, 1.1), ix * 6, 0, iz * 6);
    if (this.thudT <= 0) { this.thudT = 0.1; this.noise(bx, mid, bz, 'thud', clamp(hh / 14, 0.5, 2)); }
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

  /** a wing is torn off: its pieces fly away trailing fire and smoke (the aircraft itself is handled by the caller) */
  wingOff(jet, side) {
    const app = this.app, fx = app.fx;
    const sc = jet.spec ? jet.spec.scale : 1, cutLocal = wingCutFor(jet) / sc;
    const right = _kw.set(1, 0, 0).applyQuaternion(jet.quat).clone(), up = new THREE.Vector3(0, 1, 0).applyQuaternion(jet.quat);
    const parts = this.partsFor(jet).filter((p) => !p.shard && !p.cargo && !p.wheel && !p.glass && side * p.at[0] > cutLocal * 0.9);
    for (const part of parts) {
      const mesh = this.makeMesh(part, sc);
      _kv.set(part.at[0] * sc, part.at[1] * sc, part.at[2] * sc).applyQuaternion(jet.quat);
      mesh.position.copy(jet.pos).add(_kv);
      mesh.quaternion.copy(jet.quat);
      const radius = Math.max(0.5, Math.max(part.size[0], part.size[1], part.size[2]) * sc * 0.32);
      const c = {
        mesh, r: radius, s: radius * 0.35 + 0.5,
        vel: jet.vel.clone().multiplyScalar(0.96).addScaledVector(right, side * rand(8, 24)).addScaledVector(up, rand(2, 12)),
        ang: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(rand(2, 6)),
        rest: false, age: 0, burn: rand(9, 18), acc: 0, sunk: 0, fade: 1, water: false, fric: 1.5, interval: 0.06,
      };
      this.chunks.push(c);
    }
    // sparks, a flash and a puff at the break
    _kv.set(side * cutLocal * sc, 0, 0).applyQuaternion(jet.quat).add(jet.pos);
    fx.explosion(_kv.x, _kv.y, _kv.z, 0.3 * Math.sqrt(sc), jet.vel.x * 0.2, jet.vel.y * 0.2, jet.vel.z * 0.2);
    const cp = this.listener || app.camera.position, a = app.audio;
    if (a && a.ok) { a.hit(); if (a.thud) a.thud({ x: _kv.x - cp.x, y: _kv.y - cp.y, z: _kv.z - cp.z }, 1.6); }
  }

  /** run a sound function after sound has travelled from (x,y,z) to the listener (no delay in live flight) */
  after(fn, x, y, z) {
    const l = this.listener;
    const d = l ? Math.hypot(x - l.x, y - l.y, z - l.z) : 0;
    const au = this.app.audio, ms = Math.min(d / SPEED_OF_SOUND, 5) * 1000;
    if (d > 120) { if (au && au.later) au.later(fn, ms); else setTimeout(fn, ms); } else fn();
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

    // smoke plumes: puffs of smoke fed up from a source, swelling as they rise and leaning downwind
    for (let i = this.plumes.length - 1; i >= 0; i--) {
      const p = this.plumes[i];
      p.t += dt;
      if (p.t > p.life) { this.plumes.splice(i, 1); continue; }
      const k = 1 - p.t / p.life; // the fire dies down: fewer, smaller puffs
      p.acc += dt;
      const period = 1 / Math.max(0.2, p.rate * (0.35 + 0.65 * k));
      while (p.acc > period) {
        p.acc -= period;
        fx.bigPuff(p.x + rand(-1, 1) * p.size * 0.12, p.y + rand(0, 1) * 6, p.z + rand(-1, 1) * p.size * 0.12, p.size * rand(0.7, 1.25) * (0.5 + 0.5 * k), p.kind, rand(26, 46), rand(5, 13));
      }
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
            if (hit.cut && ny > 0.5) { // landed on the broken top of a building: it slides off the stump instead of piling into a tower
              const rdx = pos.x - hit.bx, rdz = pos.z - hit.bz, rl = Math.hypot(rdx, rdz) || 1;
              c.vel.x += (rdx / rl) * 34 * dt; c.vel.z += (rdz / rl) * 34 * dt; c.slide = 0.4;
            }
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
          if (c.slide > 0) c.slide -= dt;
          else if (hs < 1.2 && Math.abs(vn2) < 1.5 && c.ang.length() < 0.5 && ny > 0.78) c.rest = true;
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
      const cfg = 1 / Math.max(0.35, fx.budget); // thinner trails when the frame rate is low
      const poolFull = fx.smoke.alive > fx.smoke.max * 0.75;
      while (c.acc > c.interval * cfg * 1.6) {
        c.acc -= c.interval * cfg * 1.6;
        if (c.water || poolFull) break;
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

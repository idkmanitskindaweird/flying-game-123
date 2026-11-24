'use strict';
/* ==========================================================================
   hitbox.js - every aircraft has a set of hit spheres covering its fuselage, tail, wings and engines.
   The parts are tested against the terrain, the sea and the buildings. Hit the ground or a wall with the body and it is a
   crash; hit it with a WING and the wing is torn off (the aircraft survives, out of control).
   Local axes: nose = -Z, up = +Y, right = +X. Spheres are in metres, already scaled by the model's draw scale.
   ========================================================================== */

const _hbCache = {};

/**
 * Hit spheres built from the aircraft's real mesh: every triangle of the model is sampled, the points are voxelised, and each
 * occupied voxel becomes a small sphere sitting on the surface. So the hitbox follows the real shape (the B-2's sawtooth trailing
 * edge, the fighter's tail fins, the engine pods under an airliner's wing) instead of a few big balls on the centreline.
 * Returns [{x, y, z, r, part}] (part is 'body', 'wingL' or 'wingR'), with .groups (coarse clusters, for a fast first test) and .rb.
 */
function hitboxesFor(jet) {
  const spec = jet.spec;
  const key = spec ? spec.key : 'fighter';
  if (_hbCache[key]) return _hbCache[key];
  const quick = _hbSimple(jet);
  _hbGroup(quick);
  _hbCache[key] = quick; // a coarse hitbox at once...
  const build = () => { // ...and the detailed one, built from the real model, a moment later (so the start of a flight never stalls on it)
    let out = null;
    try { out = _hbFromMesh(jet, key); } catch (e) { out = null; }
    if (out && out.length >= 8) { _hbGroup(out); _hbCache[key] = out; }
  };
  if (typeof setTimeout === 'function' && !jet._hbNow) setTimeout(build, 900); else build();
  return quick;
}

function _hbFromMesh(jet, key) {
  const group = jet.group, model = jet.model;
  const spec = jet.spec;
  const gsm = new THREE.Matrix4().makeScale(group.scale.x, group.scale.y, group.scale.z);
  const skip = new Set([model.flame, model.core, model.glow].filter(Boolean));
  const tris = []; // flat arrays of 9 numbers per triangle, in the aircraft's own frame
  const m = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let mx = 0, my = 0, mz = 0;
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || skip.has(o)) return;
    let n = o; while (n && n !== group) { if (n.visible === false || skip.has(n)) return; n = n.parent; }
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.blending === THREE.AdditiveBlending || (mat.transparent && mat.opacity < 0.5)) return;
    const chain = []; n = o;
    while (n && n !== group) { n.updateMatrix(); chain.push(n.matrix); n = n.parent; }
    m.copy(gsm);
    for (let i = chain.length - 1; i >= 0; i--) m.multiply(chain[i]);
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const nt = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < nt; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m); b.fromBufferAttribute(pos, i1).applyMatrix4(m); c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      mx = Math.max(mx, Math.abs(a.x), Math.abs(b.x), Math.abs(c.x));
      my = Math.max(my, Math.abs(a.y), Math.abs(b.y), Math.abs(c.y));
      mz = Math.max(mz, Math.abs(a.z), Math.abs(b.z), Math.abs(c.z));
    }
  });
  if (tris.length < 30) return null;
  const pq = (typeof App !== 'undefined' && App.quality && App.quality.plane !== undefined) ? App.quality.plane : 2;
  let cell = Math.min(1.9, Math.max(0.6, Math.max(mx * 2, mz * 2) / 44)) * [1.45, 1.2, 1, 1, 1][pq]; // a weaker setting: fewer, bigger spheres
  let out = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const vox = new Map(), step = cell * 0.7;
    for (let t = 0; t < tris.length; t += 9) {
      const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
      const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
      const n = Math.min(40, Math.max(1, Math.ceil(e / step)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        const x = ax * w + bx * u + cx * v, y = ay * w + by * u + cy * v, z = az * w + bz * u + cz * v;
        const k = ((Math.floor(x / cell) + 512) * 1024 + Math.floor(y / cell) + 512) * 1024 + Math.floor(z / cell) + 512; // (a number: much faster than a string key)
        let r = vox.get(k);
        if (!r) { r = [0, 0, 0, 0]; vox.set(k, r); }
        r[0] += x; r[1] += y; r[2] += z; r[3]++;
      }
    }
    out = [];
    const L = spec ? PLANE_DIMS[spec.key].L * spec.scale : 15;
    const cut = wingCutFor(jet), tailZ = spec ? (spec.key === 'b2' ? 1e9 : L * 0.3) : 4.2;
    for (const r of vox.values()) {
      const x = r[0] / r[3], y = r[1] / r[3], z = r[2] / r[3];
      let part = 'body';
      if (Math.abs(x) > cut && z < tailZ) part = x < 0 ? 'wingL' : 'wingR';
      out.push({ x, y, z, r: cell * 0.66, part });
    }
    if (out.length <= 1100) break;
    cell *= 1.25; // too many spheres: use bigger ones
  }
  return out;
}

/** the old hand-placed spheres: only used if the mesh cannot be read */
function _hbSimple(jet) {
  const spec = jet.spec;
  const key = spec ? spec.key : 'fighter';
  const out = [];
  const add = (x, y, z, r, part) => out.push({ x, y, z, r, part });
  const wing = (side, x, y, z, r) => add(side * x, y, z, r, side < 0 ? 'wingL' : 'wingR');
  if (!spec) {
    for (const z of [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5]) add(0, 0, z, 1.15, 'body');
    for (const side of [-1, 1]) {
      for (const x of [1.9, 3.3, 4.7, 6.0]) wing(side, x, 0, 2.6, 0.75);
      add(side * 1.1, 2.1, 6.4, 0.7, 'body');
      add(side * 2.3, 0, 7.0, 0.6, 'body');
    }
  } else {
    const sc = spec.scale, d = PLANE_DIMS[spec.key];
    if (spec.key === 'b2') {
      for (const z of [-8, -4.5, -1, 2.5, 6, 9]) add(0, 0.2, z, 2.1, 'body');
      for (const side of [-1, 1]) {
        add(side * 3.2, 0.1, 2.2, 1.7, 'body');
        for (let x = 5.2; x <= 26; x += 3.4) wing(side, x, 0, (b2LE(x) + b2TE(x)) / 2, Math.max(0.55, 1.5 * (1 - x / 27) + 0.45));
      }
    } else {
      const R = d.R, L = d.L, span = d.span;
      for (let z = -L / 2 + R; z <= L / 2 - R * 0.5; z += R * 1.7) add(0, 0, z, R * 0.98, 'body');
      add(0, R + d.finH * 0.5, L * 0.38, R * 0.5, 'body');
      const wy = spec.key === 'c17' ? R * 0.45 : -R * 0.4;
      for (const side of [-1, 1]) {
        for (let x = R * 1.3; x <= span / 2; x += 3.2) wing(side, x, wy, L * 0.06 + (x / (span / 2)) * L * 0.09, x < span * 0.2 ? 1.5 : 1.0);
        for (const [ex] of d.engines) wing(side, ex, wy - R * 0.9, L * 0.0, spec.key === 'b747' ? 1.7 : 1.3);
        add(side * span * 0.09, R * 0.2, L * 0.41, 1.0, 'body');
      }
    }
    for (const s of out) { s.x *= sc; s.y *= sc; s.z *= sc; s.r *= sc; }
  }
  return out;
}

/** cluster the spheres into coarse groups so a hit test can reject a whole region with one check */
function _hbGroup(list) {
  const cs = Math.max(4, list.reduce((m, s) => Math.max(m, s.r), 0) * 7), map = new Map();
  list.forEach((s, i) => {
    const k = Math.floor(s.x / cs) + ',' + Math.floor(s.y / cs) + ',' + Math.floor(s.z / cs);
    let g = map.get(k);
    if (!g) { g = { x: 0, y: 0, z: 0, r: 0, idx: [] }; map.set(k, g); }
    g.x += s.x; g.y += s.y; g.z += s.z; g.idx.push(i);
  });
  list.groups = [];
  list.rb = 0;
  for (const g of map.values()) {
    g.x /= g.idx.length; g.y /= g.idx.length; g.z /= g.idx.length;
    for (const i of g.idx) { const s = list[i]; g.r = Math.max(g.r, Math.hypot(s.x - g.x, s.y - g.y, s.z - g.z) + s.r); }
    list.groups.push(g);
  }
  for (const s of list) list.rb = Math.max(list.rb, Math.hypot(s.x, s.y, s.z) + s.r);
}

/** how far out from the centreline (metres, in the model's own scale) a wing is cut when it breaks off */
function wingCutFor(jet) {
  const spec = jet.spec;
  if (!spec) return 1.25;
  return { c17: 3.7, b737: 2.3, b747: 3.7, b2: 4.7 }[spec.key] * spec.scale;
}

'use strict';
/* ==========================================================================
   city.js - a downtown with a street grid, towers, low-rise suburbs and parks,
   sitting on the flat plain north of the airfield. Every building is merged into
   ONE mesh (one draw call) and shares one window texture.
   ========================================================================== */

function makeCityTextures() {
  // facade: one bay x one floor (wall + window), repeated by UV
  const [fc, f] = makeCanvas(64, 64);
  f.fillStyle = '#e4e2dc'; f.fillRect(0, 0, 64, 64);
  f.fillStyle = '#2b3c4e'; f.fillRect(10, 16, 44, 32);
  const gr = f.createLinearGradient(0, 16, 0, 48);
  gr.addColorStop(0, 'rgba(160,200,235,0.55)'); gr.addColorStop(1, 'rgba(20,30,45,0)');
  f.fillStyle = gr; f.fillRect(10, 16, 44, 32);
  f.fillStyle = 'rgba(0,0,0,0.12)'; f.fillRect(0, 60, 64, 4);
  const facade = new THREE.CanvasTexture(fc);
  facade.wrapS = facade.wrapT = THREE.RepeatWrapping;
  facade.anisotropy = 4;

  // ground tile: one city block with the streets around it (street centres on the tile edge)
  const S = 256, road = 26 / 134;
  const [gc, g] = makeCanvas(S, S);
  g.fillStyle = '#3a3d42'; g.fillRect(0, 0, S, S);
  const m = (road / 2) * S;
  g.fillStyle = '#a3a39e'; g.fillRect(m, m, S - 2 * m, S - 2 * m);
  g.fillStyle = '#8d8e8a'; g.fillRect(m + 6, m + 6, S - 2 * m - 12, S - 2 * m - 12);
  g.fillStyle = '#d8c25a';
  for (let k = 0; k < S; k += 32) { g.fillRect(0, k + 4, 2, 14); g.fillRect(S - 2, k + 4, 2, 14); g.fillRect(k + 4, 0, 14, 2); g.fillRect(k + 4, S - 2, 14, 2); }
  const ground = new THREE.CanvasTexture(gc);
  ground.wrapS = ground.wrapT = THREE.RepeatWrapping;
  ground.anisotropy = 8;
  return { facade, ground };
}

const _cityHit = { nx: 0, ny: 1, nz: 0, pen: 0 };

function buildCity(scene) {
  const C = CITY, y0 = PLAIN_H, P = 134, ROAD = 26;
  const nx = Math.floor((2 * C.hx) / P), nz = Math.floor((2 * C.hz) / P);
  const x0 = C.x - (nx * P) / 2, z0 = C.z - (nz * P) / 2;
  const tex = makeCityTextures();
  const group = new THREE.Group();
  scene.add(group);

  // streets + sidewalks
  const gg = new THREE.PlaneGeometry(nx * P, nz * P);
  gg.rotateX(-PI / 2);
  tex.ground.repeat.set(nx, nz);
  const gm = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ map: tex.ground, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  gm.position.set(C.x, y0 + 0.08, C.z);
  group.add(gm);
  gm.receiveShadow = true;

  const pos = [], nor = [], uv = [], col = [], idx = [];
  const boxes = new Map(); // block key -> [{x, z, hw, hd, top}]
  const tint = new THREE.Color();
  let vN = 0;

  // mode 'box' scales the facade UVs by bay/floor counts; 'plain' maps everything to bare wall
  const addGeo = (geo, color, mode, scaleU, scaleV, roofCol) => {
    const p = geo.attributes.position, n = geo.attributes.normal, u = geo.attributes.uv;
    const cnt = p.count;
    for (let i = 0; i < cnt; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      let uu = 0.04, vv = 0.04, c = color;
      if (mode === 'box') {
        const face = Math.floor(i / 4); // BoxGeometry: +x, -x, +y, -y, +z, -z
        if (face === 2) c = roofCol;
        else if (face !== 3) {
          uu = u.getX(i) * (face < 2 ? scaleU[1] : scaleU[0]);
          vv = u.getY(i) * scaleV;
        } else c = 0x555555;
      }
      uv.push(uu, vv);
      tint.set(c);
      col.push(tint.r, tint.g, tint.b);
    }
    const ix = geo.index.array;
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + vN);
    vN += cnt;
  };

  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const BAY = 6.2, FLOOR = 3.6;
  const FACADES = [0xd9d6cf, 0xcfc8ba, 0xc8cdd2, 0xb9a18e, 0xdad2c2, 0xa9bccb, 0x8fb0c8, 0xb7c4cf];
  const ROOFS = [0x6c6e70, 0x7a7770, 0x5d6063, 0x8a6a5a];

  const buildings = []; // every building: its vertex ranges in the merged mesh and its collision boxes (so it can be destroyed)
  const addBox = (cx, cz, w, d, yBase, h, color, roof, key) => {
    const v0 = vN;
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(cx, yBase + h / 2, cz);
    addGeo(geo, color, 'box', [Math.max(1, Math.round(w / BAY)), Math.max(1, Math.round(d / BAY))], Math.max(1, Math.round(h / FLOOR)), roof);
    geo.dispose();
    let box = null;
    if (key !== undefined) {
      if (!boxes.has(key)) boxes.set(key, []);
      box = { x: cx, z: cz, hw: w / 2, hd: d / 2, hw0: w / 2, hd0: d / 2, top: yBase + h, top0: yBase + h };
      boxes.get(key).push(box);
    }
    return { v0, n: vN - v0, box };
  };

  const HUBS = [[-0.55, 0.3, 0.55], [0.5, -0.35, 0.5], [0.6, 0.4, 0.4], [-0.45, -0.5, 0.45]];
  const parks = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const bx = x0 + (i + 0.5) * P, bz = z0 + (j + 0.5) * P;
      const d = Math.hypot((bx - C.x) / C.hx, (bz - C.z) / C.hz); // 0 centre .. ~1 edge
      // secondary business districts
      let core = Math.exp(-(d * d) / 0.1);
      for (const [hx, hz, k] of HUBS) {
        const dd = Math.hypot((bx - C.x) / C.hx - hx, (bz - C.z) / C.hz - hz);
        core = Math.max(core, k * Math.exp(-(dd * dd) / 0.03));
      }
      const key = i * nz + j;
      const inner = P - ROAD; // buildable block width
      if (d > 0.3 && rnd() < 0.08) { parks.push([bx, bz]); continue; }
      const nLots = core > 0.3 || d < 0.45 ? (rnd() < 0.35 ? 1 : 2) : (d < 0.75 && rnd() < 0.4 ? 2 : 3);
      const lot = inner / nLots;
      for (let a = 0; a < nLots; a++) {
        for (let b = 0; b < nLots; b++) {
          const lx = bx - inner / 2 + (a + 0.5) * lot, lz = bz - inner / 2 + (b + 0.5) * lot;
          const gap = nLots === 3 ? 0.72 + rnd() * 0.2 : 0.82 + rnd() * 0.14;
          const w = lot * gap, dp = lot * (gap - 0.04 + rnd() * 0.08);
          let H;
          if (nLots === 3) H = 10 + rnd() * 20; // houses / small shops
          else H = 22 + Math.pow(rnd(), 1.5) * 50 + core * Math.pow(rnd(), 0.8) * 280;
          const colr = (core > 0.35 && rnd() < 0.55) ? FACADES[5 + Math.floor(rnd() * 3)] : FACADES[Math.floor(rnd() * 5)];
          const roof = ROOFS[Math.floor(rnd() * ROOFS.length)];
          const bl = { x: lx, z: lz, hw: w / 2, hd: dp / 2, H, ranges: [], boxes: [], state: 0, p: 0, dur: 3, shx: 0, shz: 0 };
          const take = (r) => { bl.ranges.push([r.v0, r.n]); if (r.box) bl.boxes.push(r.box); };
          take(addBox(lx, lz, w, dp, y0, H, colr, roof, key));
          if (H > 70 && rnd() < 0.7) { // stepped top
            const h2 = H * (0.18 + rnd() * 0.25);
            take(addBox(lx, lz, w * 0.62, dp * 0.62, y0 + H, h2, colr, roof, key));
            bl.H = H + h2;
          } else if (H > 30 && rnd() < 0.4) { // rooftop plant
            take(addBox(lx + w * 0.1, lz, w * 0.3, dp * 0.3, y0 + H, 4, 0xaaaaaa, 0x777777, key));
          }
          buildings.push(bl);
        }
      }
    }
  }

  // parks: green plates (a thin box so the geometry matches the others)
  for (const [px, pz] of parks) {
    const pg = new THREE.BoxGeometry(P - ROAD - 8, 1.6, P - ROAD - 8);
    pg.translate(px, y0 + 0.8, pz);
    addGeo(pg, 0x5f8f48, 'plain');
    pg.dispose();
  }

  // a TV tower at the heart of downtown
  const tower = (r0, r1, h, y, c) => {
    const g = new THREE.CylinderGeometry(r1, r0, h, 10, 1);
    g.translate(C.x + 4, y0 + y, C.z + 4);
    addGeo(g, c, 'plain');
    g.dispose();
  };
  tower(5, 2.2, 330, 165, 0xb8bcc2);
  tower(9, 15, 18, 245, 0xd4d7dc);
  tower(1.8, 0.2, 70, 365, 0xd23b2e);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(new THREE.BufferAttribute(vN > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex.facade, vertexColors: true }));
  mesh.frustumCulled = false;
  group.add(mesh);

  /* ----- destruction: buildings in the blast collapse, one after another as the shock wave reaches them ----- */
  const posAttr = geo.attributes.position, colAttr = geo.attributes.color;
  const posArr = posAttr.array, colArr = colAttr.array, basePos = new Float32Array(posArr);
  const baseCol = new Float32Array(colArr);
  const pending = [], collapsing = [];
  let blastFx = null;
  const ease = (p) => p * p * (3 - 2 * p);

  const startCollapse = (bl) => {
    bl.state = 1;
    bl.p = 0;
    bl.dur = clamp(1.8 + bl.H / 40, 2.2, 7);
    bl.shx = (Math.random() - 0.5) * 0.5;
    bl.shz = (Math.random() - 0.5) * 0.5;
    for (const [v0, n] of bl.ranges) for (let i = v0; i < v0 + n; i++) { // scorched: the facade goes dark
      colArr[i * 3] *= 0.34; colArr[i * 3 + 1] *= 0.32; colArr[i * 3 + 2] *= 0.3;
    }
    colAttr.needsUpdate = true;
    collapsing.push(bl);
    if (blastFx) blastFx.buildingDown(bl, y0);
  };

  return {
    group, mesh, buildings, ground: gm,
    /** rebuild every destroyed building (a new game) */
    reset() {
      if (!pending.length && !collapsing.length && !buildings.some((b) => b.state)) return;
      pending.length = 0;
      collapsing.length = 0;
      posArr.set(basePos);
      colArr.set(baseCol);
      for (const bl of buildings) {
        bl.state = 0;
        for (const b of bl.boxes) { b.hw = b.hw0; b.hd = b.hd0; b.top = b.top0; }
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    },
    inside(x, z, pad) { return Math.abs(x - C.x) < C.hx + pad && Math.abs(z - C.z) < C.hz + pad; },
    /** An explosion at (cx, cz): buildings within R go down, nearest first (the shock wave travels at ~260 m/s). */
    blast(cx, cz, R, es, fx) {
      blastFx = fx;
      const hit = [];
      for (const bl of buildings) {
        if (bl.state) continue;
        const d = Math.max(0, Math.hypot(bl.x - cx, bl.z - cz) - Math.max(bl.hw, bl.hd));
        if (d > R) continue;
        const chance = d < R * 0.35 ? 1 : 1 - Math.pow((d - R * 0.35) / (R * 0.65), 1.3);
        if (Math.random() < chance) hit.push([d, bl]);
      }
      hit.sort((a, b) => a[0] - b[0]);
      for (const [d, bl] of hit.slice(0, 80)) { bl.state = 3; pending.push({ bl, t: d / 260 + Math.random() * 0.45 }); }
    },
    update(dt) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        p.t -= dt;
        if (p.t <= 0) { pending.splice(i, 1); startCollapse(p.bl); }
      }
      if (!collapsing.length) return;
      for (let c = collapsing.length - 1; c >= 0; c--) {
        const bl = collapsing[c];
        bl.p = Math.min(1, bl.p + dt / bl.dur);
        const k = ease(bl.p), f = 1 - 0.9 * k;
        const lean = bl.shx * k * 0.5, leanZ = bl.shz * k * 0.5;
        for (const [v0, n] of bl.ranges) {
          for (let i = v0; i < v0 + n; i++) {
            const ox = basePos[i * 3], oy = basePos[i * 3 + 1], oz = basePos[i * 3 + 2];
            const h = oy - y0;
            const sp = 1 + 0.2 * k * (h / (bl.H + 1)); // the upper floors spread as they pancake
            posArr[i * 3] = bl.x + (ox - bl.x) * sp + lean * h;
            posArr[i * 3 + 1] = y0 + h * f;
            posArr[i * 3 + 2] = bl.z + (oz - bl.z) * sp + leanZ * h;
          }
        }
        for (const b of bl.boxes) b.top = y0 + (b.top0 - y0) * f; // collision follows the falling roof
        if (bl.p >= 1) {
          collapsing.splice(c, 1);
          bl.state = 2;
          bl.boxes.forEach((b, k2) => { if (k2 > 0) b.hw = b.hd = -9; }); // tiers and rooftop plants are gone; the base stays as a rubble heap
        }
      }
      posAttr.needsUpdate = true;
    },
    /**
     * Collision of a sphere (centre x,y,z, radius r) with the buildings: returns {nx,ny,nz,pen} (push-out direction and depth)
     * for the smallest-penetration face (roof or wall), or null.
     */
    collide(x, y, z, r) {
      const i = Math.floor((x - x0) / P), j = Math.floor((z - z0) / P);
      if (i < 0 || j < 0 || i >= nx || j >= nz) return null;
      const list = boxes.get(i * nz + j);
      if (!list) return null;
      for (const b of list) {
        const dx = x - b.x, dz = z - b.z, ax = Math.abs(dx), az = Math.abs(dz);
        if (ax >= b.hw + r || az >= b.hd + r || y - r >= b.top || y < y0) continue;
        const px = b.hw + r - ax, pz = b.hd + r - az, py = b.top + r - y;
        const h = _cityHit;
        if (py <= px && py <= pz) { h.nx = 0; h.ny = 1; h.nz = 0; h.pen = py; }
        else if (px <= pz) { h.nx = dx < 0 ? -1 : 1; h.ny = 0; h.nz = 0; h.pen = px; }
        else { h.nx = 0; h.ny = 0; h.nz = dz < 0 ? -1 : 1; h.pen = pz; }
        return h;
      }
      return null;
    },
    /** height of the roof at (x, z), or 0 when no building is there */
    topAt(x, z) {
      const i = Math.floor((x - x0) / P), j = Math.floor((z - z0) / P);
      if (i < 0 || j < 0 || i >= nx || j >= nz) return 0;
      let top = 0;
      const list = boxes.get(i * nz + j);
      if (list) for (const b of list) if (Math.abs(x - b.x) < b.hw && Math.abs(z - b.z) < b.hd && b.top > top) top = b.top;
      return top;
    },
    /** true if the point is inside a building (used for crash detection) */
    hit(x, y, z) {
      const i = Math.floor((x - x0) / P), j = Math.floor((z - z0) / P);
      if (i < 0 || j < 0 || i >= nx || j >= nz) return false;
      if (y > y0 + 420) return false;
      const list = boxes.get(i * nz + j);
      if (list) for (const b of list) if (Math.abs(x - b.x) < b.hw + 2 && Math.abs(z - b.z) < b.hd + 2 && y < b.top + 2) return true;
      return Math.hypot(x - C.x - 4, z - C.z - 4) < 8 && y < y0 + 340; // TV tower
    },
  };
}

'use strict';
/* ==========================================================================
   world.js - infinite procedural terrain (streamed quadtree LOD), sky, ocean,
   clouds and the airfield used as the airshow ground.
   Units: metres. +Y up. The airfield sits at the origin, runway along X.
   ========================================================================== */

const SUN_DIR = new THREE.Vector3(0.38, 0.58, 0.72).normalize();
const FOG_COLOR = 0xbdd5ea;
const CITY = { x: 0, z: -4700, hx: 3200, hz: 2600, flatR: 4300 }; // the city on the plain north of the airfield
const _swF = new THREE.Vector3(), _swR = new THREE.Vector3(), _swU = new THREE.Vector3(), _swUp = new THREE.Vector3(0, 1, 0);
const _cullM = new THREE.Matrix4(), _cullInv = new THREE.Matrix4();
const PLAIN_H = 24; // elevation of the flat airfield plain (m above sea level)

/* ---------- graphics quality: five levels per setting ----------------------------------------------
   Every setting has the same five levels (index 0..4 = Low, Medium, High, Epic, Ultra). A preset sets all of them to the
   same level; "Custom" lets each one be chosen on its own. buildQuality() turns the chosen levels into the numbers the game uses. */
const GFX_LEVELS = ['Low', 'Medium', 'High', 'Epic', 'Ultra'];
const GFX = {
  res: [{ pr: 1, ss: 0 }, { pr: 1.25, ss: 0 }, { pr: 2, ss: 0 }, { pr: 2, ss: 1.25 }, { pr: 2.5, ss: 1.75 }], // pr: max pixel ratio, ss: supersampling floor
  shadows: [0, 1536, 2048, 3072, 4096], // shadow-map size (0 = off)
  terrain: [{ n: 24, b: 2 }, { n: 28, b: 3 }, { n: 32, b: 4 }, { n: 38, b: 5 }, { n: 46, b: 6 }], // terrain mesh detail, and how many chunks may build per frame
  trees: [0.3, 0.65, 1.0, 1.3, 1.7],
  clouds: [40, 70, 110, 140, 180],
  particles: [2500, 4500, 7000, 11000, 18000], // smoke and fire particles
};
function gfxPreset(i) { return { res: i, shadows: i, terrain: i, trees: i, clouds: i, particles: i, crash: i, plane: i, aa: i > 0 }; }
function buildQuality(g) {
  const c = (k, v) => clamp(v === undefined ? 1 : v, 0, 4) | 0;
  return {
    pixelRatio: GFX.res[c('res', g.res)].pr, ss: GFX.res[c('res', g.res)].ss,
    shadows: GFX.shadows[c('shadows', g.shadows)],
    terrainN: GFX.terrain[c('terrain', g.terrain)].n, maxBuild: GFX.terrain[c('terrain', g.terrain)].b,
    trees: GFX.trees[c('trees', g.trees)], clouds: GFX.clouds[c('clouds', g.clouds)], particles: GFX.particles[c('particles', g.particles)],
    crash: c('crash', g.crash), plane: c('plane', g.plane), aa: g.aa !== false,
  };
}
const QUALITY = { low: buildQuality(gfxPreset(0)), med: buildQuality(gfxPreset(1)), high: buildQuality(gfxPreset(2)), epic: buildQuality(gfxPreset(3)), ultra: buildQuality(gfxPreset(4)) };
/** scale a geometry segment count by the Aircraft detail setting */
function gfxLod(n) {
  const p = (typeof App !== 'undefined' && App.quality && App.quality.plane !== undefined) ? App.quality.plane : 2;
  return Math.max(4, Math.round(n * [0.5, 0.75, 1, 1.5, 2.2][p]));
}

/* ---------- geometry helpers ------------------------------------------------ */

function paintGeometry(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Merge indexed/non-indexed geometries that all have position, normal and color attributes. */
function mergeGeometries(geos) {
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < n; i++) idx[io + i] = vo + i;
      io += n;
    }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

function makeTreeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.3, 0.45, 2.4, 5, 1);
  trunk.translate(0, 1.2, 0);
  paintGeometry(trunk, 0x5a4028);
  const c1 = new THREE.ConeGeometry(3.1, 6.4, 6, 1);
  c1.translate(0, 2.4 + 3.2, 0);
  paintGeometry(c1, 0x2f5a2e);
  const c2 = new THREE.ConeGeometry(2.2, 5.2, 6, 1);
  c2.translate(0, 6.2 + 2.6, 0);
  paintGeometry(c2, 0x3f7a3a);
  return mergeGeometries([trunk, c1, c2]);
}

/* ---------- procedural textures --------------------------------------------- */

function makeDetailTexture() {
  const S = 256;
  const [cv, g] = makeCanvas(S, S);
  const nz = new Noise2D(4242);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const n =
        nz.tileNoise(u * 8, v * 8, 8) * 0.45 +
        nz.tileNoise(u * 24, v * 24, 24) * 0.3 +
        nz.tileNoise(u * 64, v * 64, 64) * 0.25;
      const val = clamp(0.5 + n * 0.75, 0, 1) * 255;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeWaterNormalTexture() {
  const S = 256;
  const [cv, g] = makeCanvas(S, S);
  const rnd = mulberry32(77);
  const waves = [];
  for (let i = 0; i < 9; i++) {
    const a = rnd() * TAU;
    const k = 2 + Math.floor(rnd() * 7);
    waves.push({ kx: Math.round(Math.cos(a) * k), ky: Math.round(Math.sin(a) * k), amp: 1 / (1 + k * 0.6), ph: rnd() * TAU });
  }
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let h = 0;
      for (const w of waves) h += w.amp * Math.sin(TAU * ((w.kx * x + w.ky * y) / S) + w.ph);
      hgt[y * S + x] = h;
    }
  }
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x + S - 1) % S)];
      const hy = hgt[((y + 1) % S) * S + x] - hgt[((y + S - 1) % S) * S + x];
      let nx = -hx * 1.1, ny = -hy * 1.1, nzz = 1;
      const l = Math.hypot(nx, ny, nzz);
      nx /= l; ny /= l; nzz /= l;
      const i = (y * S + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nzz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeCloudTextures(count) {
  const out = [];
  for (let n = 0; n < count; n++) {
    const S = 128;
    const [cv, g] = makeCanvas(S, S);
    const rnd = mulberry32(900 + n * 17);
    for (let i = 0; i < 16; i++) {
      const x = 64 + (rnd() - 0.5) * 56;
      const y = 66 + (rnd() - 0.5) * 30 - Math.abs(x - 64) * 0.18;
      const r = 16 + rnd() * 22;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.5)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
    g.globalCompositeOperation = 'source-atop';
    const lg = g.createLinearGradient(0, 38, 0, 100);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(1, 'rgba(112,128,158,0.6)');
    g.fillStyle = lg;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(cv);
    out.push(tex);
  }
  return out;
}

function makeRunwayTexture() {
  const W = 2048, H = 128;
  const [cv, g] = makeCanvas(W, H);
  g.fillStyle = '#3c3e43';
  g.fillRect(0, 0, W, H);
  const id = g.getImageData(0, 0, W, H);
  const rnd = mulberry32(5);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = (rnd() - 0.5) * 20;
    id.data[i] += v; id.data[i + 1] += v; id.data[i + 2] += v;
  }
  g.putImageData(id, 0, 0);
  // rubber marks at both touchdown zones
  g.fillStyle = 'rgba(15,15,18,0.35)';
  for (const cx of [230, W - 230]) {
    g.fillRect(cx - 70, H / 2 - 26, 140, 8);
    g.fillRect(cx - 70, H / 2 + 18, 140, 8);
  }
  g.fillStyle = '#e9e9e4';
  g.fillRect(36, 6, W - 72, 4);
  g.fillRect(36, H - 10, W - 72, 4);
  for (let x = 150; x < W - 150; x += 70) g.fillRect(x, H / 2 - 2, 40, 4);
  for (let k = 0; k < 8; k++) {
    const y = 18 + k * 12.5;
    g.fillRect(14, y, 78, 7);
    g.fillRect(W - 92, y, 78, 7);
  }
  g.font = 'bold 44px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save(); g.translate(132, H / 2); g.rotate(Math.PI / 2); g.fillText('09', 0, 0); g.restore();
  g.save(); g.translate(W - 132, H / 2); g.rotate(-Math.PI / 2); g.fillText('27', 0, 0); g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 8;
  return tex;
}

/* ==========================================================================
   Terrain
   ========================================================================== */

class Terrain {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    const seed = 90210;
    this.nCont = new Noise2D(seed + 1);
    this.nHill = new Noise2D(seed + 2);
    this.nMask = new Noise2D(seed + 3);
    this.nRidge = new Noise2D(seed + 4);
    this.nPatch = new Noise2D(seed + 5);
    this.nForest = new Noise2D(seed + 6);

    this.ROOT = 16384;
    this.MAXL = 7;
    this.N = quality.terrainN;
    this.splitK = 1.25;
    this.range = 52000;

    this.group = new THREE.Group();
    scene.add(this.group);
    this.chunks = new Map();
    this.stamp = 0;
    this.lastPos = new THREE.Vector3(1e9, 0, 1e9);
    this.pending = 0;
    this.needed = [];
    this.stats = { chunks: 0, visible: 0 };

    this._buildShared();
  }

  /* ----- height field ----- */

  heightAt(x, z) {
    const h = this._baseHeight(x, z);
    const dc = Math.hypot(x - CITY.x, (z - CITY.z) * 0.9);
    if (dc >= CITY.flatR + 1400) return h;
    return h + (PLAIN_H - h) * (1 - smoothstep(CITY.flatR, CITY.flatR + 1400, dc));
  }

  _baseHeight(x, z) {
    const r = Math.sqrt(x * x + z * z * 1.21);
    if (r < 3000) return PLAIN_H;
    const hills = this.nHill.fbm(x / 2600, z / 2600, 4);
    const kFlat = smoothstep(3000, 4800, r);
    const plain = PLAIN_H + kFlat * hills * 18;
    if (r < 6500) return plain;
    const kNat = smoothstep(6500, 16000, r);
    const cont = this.nCont.fbm(x * 4.2e-5 + 3.1, z * 4.2e-5 - 1.7, 3);
    const mm = smoothstep(-0.04, 0.26, this.nMask.fbm(x / 21000 + 9.2, z / 21000 + 4.4, 2));
    let nat = 115 + cont * 200 + hills * 140;
    if (mm > 0) {
      const rg = this.nRidge.ridged(x / 6800 + 2.2, z / 6800 - 8.8, 5);
      nat += mm * (rg * rg * 1900 + 160);
    }
    // open sea to the west, with a wandering coastline
    const xw = x + this.nCont.noise(z / 5200 + 3.3, 0.5) * 3600 + this.nHill.noise(z / 1300 + 1.1, 2.2) * 650;
    nat -= 360 * smoothstep(-9000, -17000, xw);
    return plain + (nat - plain) * kNat;
  }

  forestMask(x, z) {
    return smoothstep(0.02, 0.32, this.nForest.fbm(x / 1100 + 5, z / 1100 - 3, 3));
  }

  /* ----- colours ----- */

  _color(h, ny, wx, wz, out) {
    const patch = this.nPatch.fbm(wx / 650, wz / 650, 2) * 0.5 + 0.5;
    const fine = this.nPatch.noise(wx / 47 + 11, wz / 47 - 5);
    // grass
    let r = 0.31 + patch * 0.17, g = 0.46 + patch * 0.08, b = 0.19 + patch * 0.04;
    // forests
    const fm = this.forestMask(wx, wz) * smoothstep(750, 450, h) * smoothstep(0.62, 0.82, ny);
    r += (0.17 - r) * fm * 0.7; g += (0.33 - g) * fm * 0.7; b += (0.15 - b) * fm * 0.7;
    // rock on altitude and steep slopes
    const rockT = Math.max(smoothstep(520, 980, h + patch * 140), smoothstep(0.86, 0.6, ny));
    const rv = 0.4 + fine * 0.07 + patch * 0.06;
    r += (rv + 0.06 - r) * rockT; g += (rv + 0.02 - g) * rockT; b += (rv - 0.02 - b) * rockT;
    // snow
    const sn = smoothstep(1180, 1380, h + fine * 90) * smoothstep(0.5, 0.78, ny);
    r += (0.94 - r) * sn; g += (0.96 - g) * sn; b += (0.99 - b) * sn;
    // beach and sea bed
    const sand = smoothstep(7, 1.5, h);
    r += (0.8 - r) * sand; g += (0.74 - g) * sand; b += (0.54 - b) * sand;
    const deep = smoothstep(-2, -25, h);
    r += (0.36 - r) * deep; g += (0.5 - g) * deep; b += (0.5 - b) * deep;
    const v = 0.94 + fine * 0.09;
    out[0] = r * v; out[1] = g * v; out[2] = b * v;
  }

  /* ----- shared resources ----- */

  _buildShared() {
    const N = this.N;
    const NV = (N + 1) * (N + 1);
    const idx = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const quad = (e0, e1, s0, s1, flip) => {
      if (!flip) idx.push(e0, e1, s0, e1, s1, s0);
      else idx.push(e1, e0, s1, e0, s0, s1);
    };
    for (let i = 0; i < N; i++) {
      quad(i, i + 1, NV + i, NV + i + 1, false); // north
      quad(N * (N + 1) + i, N * (N + 1) + i + 1, NV + (N + 1) + i, NV + (N + 1) + i + 1, true); // south
      quad(i * (N + 1), (i + 1) * (N + 1), NV + 2 * (N + 1) + i, NV + 2 * (N + 1) + i + 1, true); // west
      quad(i * (N + 1) + N, (i + 1) * (N + 1) + N, NV + 3 * (N + 1) + i, NV + 3 * (N + 1) + i + 1, false); // east
    }
    this.indexAttr = new THREE.BufferAttribute(new Uint32Array(idx), 1);
    this.detailTex = makeDetailTexture();

    this.mats = [];
    for (let L = 0; L <= this.MAXL; L++) {
      const m = new THREE.MeshLambertMaterial({ vertexColors: true });
      const tex = this.detailTex;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uDetail = { value: tex };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D uDetail;')
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            float dn = texture2D(uDetail, vWPos.xz * 0.0105).r * 0.55 + texture2D(uDetail, vWPos.xz * 0.071).r * 0.45;
            diffuseColor.rgb *= 0.74 + 0.52 * dn;`
          );
      };
      this.mats.push(m);
    }

    this.treeGeo = makeTreeGeometry();
    this.treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this._H = new Float32Array((this.N + 3) * (this.N + 3));
  }

  /* ----- chunk construction ----- */

  _buildChunk(level, ix, iz, key) {
    const N = this.N;
    const size = this.ROOT / (1 << level);
    const cell = size / N;
    const x0 = ix * size, z0 = iz * size;
    const M = N + 3;
    const H = this._H;
    for (let j = 0; j < M; j++) {
      const wz = z0 + (j - 1) * cell;
      for (let i = 0; i < M; i++) H[j * M + i] = this.heightAt(x0 + (i - 1) * cell, wz);
    }
    const NV = (N + 1) * (N + 1), NS = 4 * (N + 1);
    const pos = new Float32Array((NV + NS) * 3);
    const nor = new Float32Array((NV + NS) * 3);
    const col = new Float32Array((NV + NS) * 3);
    const c = [0, 0, 0];
    let minH = 1e9, maxH = -1e9;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const id = (j * (N + 1) + i) * 3;
        const h = H[(j + 1) * M + i + 1];
        const nx = H[(j + 1) * M + i] - H[(j + 1) * M + i + 2];
        const nz = H[j * M + i + 1] - H[(j + 2) * M + i + 1];
        const ny = 2 * cell;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        pos[id] = i * cell; pos[id + 1] = h; pos[id + 2] = j * cell;
        nor[id] = nx * il; nor[id + 1] = ny * il; nor[id + 2] = nz * il;
        this._color(h, ny * il, x0 + i * cell, z0 + j * cell, c);
        col[id] = c[0]; col[id + 1] = c[1]; col[id + 2] = c[2];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    const skirt = cell * 0.8 + 6;
    const copy = (dst, src) => {
      const d = (NV + dst) * 3, s = src * 3;
      pos[d] = pos[s]; pos[d + 1] = pos[s + 1] - skirt; pos[d + 2] = pos[s + 2];
      nor[d] = nor[s]; nor[d + 1] = nor[s + 1]; nor[d + 2] = nor[s + 2];
      col[d] = col[s]; col[d + 1] = col[s + 1]; col[d + 2] = col[s + 2];
    };
    for (let i = 0; i <= N; i++) {
      copy(i, i); // north
      copy((N + 1) + i, N * (N + 1) + i); // south
      copy(2 * (N + 1) + i, i * (N + 1)); // west
      copy(3 * (N + 1) + i, i * (N + 1) + N); // east
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(this.indexAttr);
    const half = size * 0.5;
    const cy = (minH + maxH) * 0.5 - skirt * 0.5;
    const ry = (maxH - minH) * 0.5 + skirt;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(half, cy, half), Math.sqrt(half * half * 2 + ry * ry));
    const mesh = new THREE.Mesh(geo, this.mats[level]);
    mesh.receiveShadow = true;
    mesh.position.set(x0, 0, z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);

    let trees = null;
    if (level >= this.MAXL - 1 && this.quality.trees > 0) trees = this._buildTrees(level, x0, z0, size, mesh);

    return { key, level, ix, iz, mesh, trees, stamp: this.stamp };
  }

  /** hide the instanced trees of chunks outside the view (an InstancedMesh cannot be frustum-culled by three itself) */
  cullTrees(frustum) {
    let hidden = 0;
    for (const ch of this.chunks.values()) {
      if (!ch.trees) continue;
      if (!ch.sph) {
        const bs = ch.mesh.geometry.boundingSphere;
        ch.sph = new THREE.Sphere(bs.center.clone().add(ch.mesh.position), bs.radius + 40);
      }
      const on = frustum.intersectsSphere(ch.sph);
      ch.trees.visible = on;
      if (!on) hidden++;
    }
    this.stats.treesHidden = hidden;
  }

  _buildTrees(level, x0, z0, size, parent) {
    const q = this.quality.trees;
    const sp = (level === this.MAXL ? 8.5 : 14) / Math.sqrt(q);
    const n = Math.floor(size / sp);
    const mats = [];
    const m4 = new THREE.Matrix4();
    const q4 = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const list = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const wx0 = x0 + (i + 0.5) * sp, wz0 = z0 + (j + 0.5) * sp;
        const hx = Math.floor(wx0 / sp), hz = Math.floor(wz0 / sp);
        const wx = wx0 + (hash2(hx, hz, 1) - 0.5) * sp * 0.9;
        const wz = wz0 + (hash2(hx, hz, 2) - 0.5) * sp * 0.9;
        if (Math.abs(wx) < 1500 && Math.abs(wz) < 520) continue; // keep the airfield clear
        if (Math.hypot(wx - CITY.x, (wz - CITY.z) * 0.9) < CITY.flatR + 80) continue; // ... and the city
        const fm = this.forestMask(wx, wz);
        if (fm < 0.12) continue;
        if (hash2(hx, hz, 3) > fm * 0.95) continue;
        const h = this.heightAt(wx, wz);
        if (h < 6 || h > 640) continue;
        const dh = Math.abs(this.heightAt(wx + 6, wz) - h) + Math.abs(this.heightAt(wx, wz + 6) - h);
        if (dh > 6.5) continue;
        list.push(wx, h - 0.3, wz, hash2(hx, hz, 4));
      }
    }
    const count = list.length / 4;
    if (count === 0) return null;
    const im = new THREE.InstancedMesh(this.treeGeo, this.treeMat, count);
    for (let k = 0; k < count; k++) {
      const s = 0.8 + list[k * 4 + 3] * 0.9;
      q4.setFromAxisAngle(up, list[k * 4 + 3] * 40);
      m4.compose(new THREE.Vector3(list[k * 4] - x0, list[k * 4 + 1], list[k * 4 + 2] - z0), q4, new THREE.Vector3(s, s * (0.9 + list[k * 4 + 3] * 0.35), s));
      im.setMatrixAt(k, m4);
      const b = 0.78 + list[k * 4 + 3] * 0.4;
      col.setRGB(b, b * (0.95 + list[k * 4 + 3] * 0.15), b * 0.9);
      im.setColorAt(k, col);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false;
    im.receiveShadow = true;
    parent.add(im);
    return im;
  }

  _disposeChunk(ch) {
    this.group.remove(ch.mesh);
    ch.mesh.geometry.dispose();
    if (ch.trees) {
      ch.mesh.remove(ch.trees);
      ch.trees.dispose();
    }
  }

  /* ----- streaming ----- */

  update(cam, force) {
    const moved = Math.abs(cam.x - this.lastPos.x) + Math.abs(cam.z - this.lastPos.z) + Math.abs(cam.y - this.lastPos.y) * 0.3;
    if (!force && this.pending === 0 && moved < 10) return;
    this.lastPos.copy(cam);
    this.stamp++;
    const R = this.ROOT, range = this.range;
    const rx0 = Math.floor((cam.x - range) / R), rx1 = Math.floor((cam.x + range) / R);
    const rz0 = Math.floor((cam.z - range) / R), rz1 = Math.floor((cam.z + range) / R);
    this.needed.length = 0;
    for (let rz = rz0; rz <= rz1; rz++) for (let rx = rx0; rx <= rx1; rx++) this._visit(0, rx, rz, cam);

    const missing = [];
    for (const nd of this.needed) {
      nd.key = nd.level + ':' + nd.ix + ':' + nd.iz;
      const ch = this.chunks.get(nd.key);
      if (ch) {
        ch.stamp = this.stamp;
        ch.mesh.visible = true;
      } else missing.push(nd);
    }
    missing.sort((a, b) => a.d - b.d);
    const budget = force ? 1e9 : this.quality.maxBuild;
    let built = 0;
    for (const nd of missing) {
      if (built >= budget) break;
      const ch = this._buildChunk(nd.level, nd.ix, nd.iz, nd.key);
      ch.stamp = this.stamp;
      this.chunks.set(nd.key, ch);
      built++;
    }
    this.pending = missing.length - built;

    if (this.pending === 0) {
      let vis = 0;
      for (const ch of this.chunks.values()) {
        const on = ch.stamp === this.stamp;
        ch.mesh.visible = on;
        if (on) vis++;
      }
      this.stats.visible = vis;
      // evict stale chunks (keep a cache of recently used ones)
      if (this.chunks.size > 420) {
        const arr = Array.from(this.chunks.values()).filter((c) => c.stamp !== this.stamp);
        arr.sort((a, b) => a.stamp - b.stamp);
        const drop = Math.min(arr.length, this.chunks.size - 360);
        for (let i = 0; i < drop; i++) {
          this._disposeChunk(arr[i]);
          this.chunks.delete(arr[i].key);
        }
      }
    }
    this.stats.chunks = this.chunks.size;
  }

  _visit(level, ix, iz, cam) {
    const size = this.ROOT / (1 << level);
    const x0 = ix * size, z0 = iz * size;
    const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - size);
    const dz = Math.max(z0 - cam.z, 0, cam.z - z0 - size);
    const dy = Math.max(0, cam.y - 900);
    const d = Math.sqrt(dx * dx + dz * dz + dy * dy);
    if (d > this.range) return;
    if (level < this.MAXL && d < size * this.splitK) {
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) this._visit(level + 1, ix * 2 + a, iz * 2 + b, cam);
    } else {
      this.needed.push({ level, ix, iz, d, key: '' });
    }
  }
}

/* ==========================================================================
   Sky dome
   ========================================================================== */

function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uTop: { value: new THREE.Color(0x2b69b4) },
      uMid: { value: new THREE.Color(0x6fa3d8) },
      uHor: { value: new THREE.Color(FOG_COLOR) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uSun; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float t = clamp(h, 0.0, 1.0);
        vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.22, t));
        col = mix(col, uTop, smoothstep(0.15, 0.85, t));
        col = mix(col, uHor, smoothstep(0.02, -0.12, h));
        float s = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.86, 0.62) * (pow(s, 900.0) * 3.0 + pow(s, 40.0) * 0.32 + pow(s, 6.0) * 0.10);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(30000, 40, 20), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/* ==========================================================================
   Clouds (billboard sprites, tiled around the camera)
   ========================================================================== */

class Clouds {
  constructor(scene, quality) {
    this.cell = 3800;
    this.W = 12;
    this.texs = makeCloudTextures(4);
    this.slots = [];
    const slotCount = this.W * this.W;
    const wantClusters = quality.clouds;
    const prob = Math.min(0.9, wantClusters / slotCount);
    this.group = new THREE.Group();
    scene.add(this.group);
    for (let j = 0; j < this.W; j++) {
      for (let i = 0; i < this.W; i++) {
        if (hash2(i, j, 11) > prob) continue;
        const grp = new THREE.Group();
        const mat = new THREE.SpriteMaterial({ map: this.texs[Math.floor(hash2(i, j, 12) * 4)], transparent: true, depthWrite: false, opacity: 0.95 });
        const n = 5 + Math.floor(hash2(i, j, 13) * 4);
        const base = 520 + hash2(i, j, 14) * 520;
        for (let k = 0; k < n; k++) {
          const sp = new THREE.Sprite(mat);
          const a = hash2(i, j, 20 + k) * TAU, rr = hash2(i, j, 40 + k) * base * 0.9;
          const sz = base * (0.8 + hash2(i, j, 60 + k) * 0.9);
          sp.position.set(Math.cos(a) * rr, (hash2(i, j, 80 + k) - 0.35) * base * 0.22, Math.sin(a) * rr);
          sp.scale.set(sz * 1.6, sz, 1);
          grp.add(sp);
        }
        grp.userData = {
          i, j, mat,
          jx: hash2(i, j, 15), jz: hash2(i, j, 16),
          alt: 1700 + hash2(i, j, 17) * 1000,
          r: base * 1.5,
          cx: 1e9, cz: 1e9,
        };
        this.group.add(grp);
        this.slots.push(grp);
      }
    }
  }

  update(cam) {
    const cell = this.cell, W = this.W;
    const ccx = cam.x / cell, ccz = cam.z / cell;
    for (const grp of this.slots) {
      const u = grp.userData;
      const wi = u.i + W * Math.round((ccx - u.i) / W);
      const wj = u.j + W * Math.round((ccz - u.j) / W);
      if (wi !== u.cx || wj !== u.cz) {
        u.cx = wi; u.cz = wj;
        grp.position.set((wi + u.jx) * cell, u.alt, (wj + u.jz) * cell);
      }
      const dx = grp.position.x - cam.x, dz = grp.position.z - cam.z, dy = grp.position.y - cam.y;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      u.mat.opacity = 0.95 * smoothstep(u.r * 0.25, u.r * 1.1, d);
      grp.visible = u.mat.opacity > 0.01;
    }
  }
}

/* ==========================================================================
   Airfield (runway, hangars, tower, tanks) - the airshow ground at the origin
   ========================================================================== */

function buildAirfield(scene) {
  const g = new THREE.Group();
  const y0 = PLAIN_H;
  const flat = (w, d, x, z, color, lift, tex) => {
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-PI / 2);
    const m = new THREE.MeshLambertMaterial({ color, map: tex || null, polygonOffset: true, polygonOffsetFactor: -2 - lift, polygonOffsetUnits: -2 - lift });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y0 + 0.05 + lift * 0.05, z);
    g.add(mesh);
    return mesh;
  };
  flat(2300, 74, 0, 0, 0x7d7f74, 0); // gravel shoulder around the runway
  flat(2200, 50, 0, 0, 0xffffff, 2, makeRunwayTexture());
  flat(2100, 16, 0, 70, 0x55575a, 1); // taxiway
  for (const x of [-700, -250, 250, 700]) flat(16, 44, x, 48, 0x55575a, 1); // connectors
  flat(660, 150, 0, 185, 0x8f918e, 1); // apron

  const box = (w, h, d, x, z, color, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, (y === undefined ? y0 : y) + h / 2, z);
    g.add(m);
    return m;
  };
  // hangars (box + arched roof)
  const hangarMat = new THREE.MeshLambertMaterial({ color: 0xb9bdc2 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x8f959c });
  for (let k = 0; k < 4; k++) {
    const x = -230 + k * 150;
    const body = new THREE.Mesh(new THREE.BoxGeometry(84, 11, 58), hangarMat);
    body.position.set(x, y0 + 5.5, 270);
    g.add(body);
    const roofGeo = new THREE.CylinderGeometry(29, 29, 84, 16, 1, false, 0, PI);
    roofGeo.rotateZ(PI / 2);
    roofGeo.rotateY(PI / 2);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.rotation.y = PI / 2;
    roof.position.set(x, y0 + 11, 270);
    g.add(roof);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(56, 11), new THREE.MeshLambertMaterial({ color: 0x3a4048 }));
    door.position.set(x, y0 + 5.6, 270 - 29.2);
    door.rotation.y = PI;
    g.add(door);
  }
  // control tower
  box(11, 22, 11, 330, 215, 0xd9dcdf);
  box(17, 6, 17, 330, 215, 0x2c4660, y0 + 22);
  box(19, 1.2, 19, 330, 215, 0xc8cbcf, y0 + 28);
  box(0.6, 7, 0.6, 330, 215, 0xaa3333, y0 + 29.2);
  // terminal / offices
  box(120, 9, 30, 260, 170, 0xcfc9bd);
  box(60, 8, 26, -380, 190, 0xc7c2b6);
  // fuel tanks
  for (let k = 0; k < 3; k++) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 12, 18), new THREE.MeshLambertMaterial({ color: 0xe9ebe6 }));
    t.position.set(-420 + k * 24, y0 + 6, 330);
    g.add(t);
  }
  // windsock
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 9, 6), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
  pole.position.set(-120, y0 + 4.5, 52);
  g.add(pole);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(1.2, 6, 10, 1, true), new THREE.MeshLambertMaterial({ color: 0xff6a1a, side: THREE.DoubleSide }));
  sock.rotation.z = PI / 2 + 0.25;
  sock.position.set(-117, y0 + 9, 52);
  g.add(sock);
  // runway edge lights (white dots) - cheap instanced spheres
  const lg = new THREE.SphereGeometry(0.6, 6, 4);
  const lm = new THREE.MeshBasicMaterial({ color: 0xfff4c8 });
  const lights = new THREE.InstancedMesh(lg, lm, 2 * 60);
  const m4 = new THREE.Matrix4();
  let li = 0;
  for (let k = 0; k < 60; k++) {
    const x = -1080 + k * 36.6;
    for (const z of [-26.5, 26.5]) {
      m4.makeTranslation(x, y0 + 0.5, z);
      lights.setMatrixAt(li++, m4);
    }
  }
  lights.frustumCulled = false;
  g.add(lights);
  addParkedJets(g);
  scene.add(g);
  return g;
}

/** A row of parked jets on the apron (static scenery). */
function addParkedJets(g) {
  const pals = ['white', 'red', 'blue', 'camo', 'desert', 'steel'];
  const gearMat = new THREE.MeshPhongMaterial({ color: 0x25272b });
  const strutMat = new THREE.MeshPhongMaterial({ color: 0xb8bcc2 });
  const strut = (grp, x, z, h) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h, 6), strutMat);
    c.position.set(x, -h / 2 - 0.3, z);
    grp.add(c);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12), gearMat);
    w.rotation.z = PI / 2;
    w.position.set(x, -h - 0.3, z);
    grp.add(w);
  };
  // a C-17 Globemaster parked beside the apron
  {
    const c = buildC17Mesh(true);
    c.lights.strobe.visible = false;
    c.group.position.set(560, PLAIN_H + 5.75 * C17_SCALE, 205);
    c.group.rotation.y = 0.55;
    g.add(c.group);
  }
  // airliners parked on the grass either side of the apron
  for (const [kind, x, z, rot] of [['b747', -640, 235, -0.45], ['b737', 740, 300, 0.35]]) {
    const sp = PLANES[kind], a = sp.build(true);
    a.lights.strobe.visible = false;
    a.group.position.set(x, PLAIN_H + a.gearBottom * sp.scale, z);
    a.group.rotation.y = rot;
    g.add(a.group);
  }
  const xs = [-250, -150, -50, 50, 150, 250];
  xs.forEach((x, i) => {
    const m = buildJetMesh(pals[i % pals.length]);
    m.flame.visible = m.core.visible = m.glow.visible = false;
    m.lights.strobe.visible = false;
    strut(m.group, 0, -4.4, 1.3);
    strut(m.group, 1.7, 2.4, 1.3);
    strut(m.group, -1.7, 2.4, 1.3);
    m.group.position.set(x, PLAIN_H + 2.07, 150 + (i % 2) * 34);
    m.group.rotation.y = (i % 2 ? 0.22 : -0.12) + (i > 3 ? PI : 0);
    g.add(m.group);
  });
}

/* ==========================================================================
   World - owns lights, terrain, sky, water, clouds
   ========================================================================== */

class World {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0000425);
    scene.background = new THREE.Color(FOG_COLOR);

    this.sunLight = new THREE.DirectionalLight(0xfff1dc, 1.0);
    this.sunLight.position.copy(SUN_DIR).multiplyScalar(1000);
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
    // real sun shadows around the camera: jets, buildings, hangars and wreckage throw shadows on the ground and on each other
    // a warm point light that flashes when something explodes, lighting up the buildings and ground around it (always present, so no shader recompiles)
    this.flashLight = new THREE.PointLight(0xffa860, 0, 1200, 1.2);
    scene.add(this.flashLight);
    this.cullFrustum = new THREE.Frustum();
    this.shadowOn = !!quality.shadows;
    this.shadowCenter = new THREE.Vector3();
    this.shadowExtent = 760;
    if (this.shadowOn) {
      const L = this.sunLight;
      L.castShadow = true;
      L.shadow.mapSize.set(quality.shadows, quality.shadows);
      const sc = L.shadow.camera, e = this.shadowExtent;
      sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 50; sc.far = 3600;
      sc.updateProjectionMatrix();
      L.shadow.bias = -0.0005;
      L.shadow.normalBias = 0.6;
    }
    this.hemi = new THREE.HemisphereLight(0xa9c9ff, 0x78765a, 0.66);
    scene.add(this.hemi);

    this.terrain = new Terrain(scene, quality);
    this.sky = createSky();
    scene.add(this.sky);

    this.waveTex = makeWaterNormalTexture();
    this.waveTex.repeat.set(800, 800);
    const wgeo = new THREE.PlaneGeometry(120000, 120000, 1, 1);
    wgeo.rotateX(-PI / 2);
    this.waterMat = new THREE.MeshPhongMaterial({
      color: 0x1a5a86,
      specular: 0xcfe2f2,
      shininess: 110,
      normalMap: this.waveTex,
      normalScale: new THREE.Vector2(0.55, 0.55),
    });
    this.water = new THREE.Mesh(wgeo, this.waterMat);
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    scene.add(this.water);

    this.clouds = new Clouds(scene, quality);
    this.airfield = buildAirfield(scene);
    this.city = buildCity(scene);
    for (const root of [this.airfield, this.city.group]) {
      root.traverse((o) => { if (o.isMesh) { o.castShadow = o !== this.city.ground; o.receiveShadow = true; } });
    }
    this.time = 0;
  }

  heightAt(x, z) {
    return this.terrain.heightAt(x, z);
  }

  /** Ground or sea-surface height (whichever is higher). */
  surfaceAt(x, z) {
    const h = this.terrain.heightAt(x, z);
    return h > 0 ? h : 0;
  }

  /** light everything around (x,y,z) with the glare of an explosion; k ~ 1 for a fighter, 3 for a jumbo */
  flash(x, y, z, k) {
    this.flashLight.position.set(x, y + 30, z);
    this.flashLight.distance = 500 + 450 * k;
    this.flashLight.intensity = Math.max(this.flashLight.intensity, 2.2 + 1.8 * k);
  }

  /** Keep the sun's shadow map centred on the area ahead of the camera, snapped to shadow texels so edges do not shimmer. */
  updateShadow(camera) {
    const L = this.sunLight, c = this.shadowCenter;
    const fwd = _swF.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const p = camera.position;
    const cx = p.x + fwd.x * 220, cz = p.z + fwd.z * 220;
    const g = this.surfaceAt(cx, cz);
    c.set(cx, (g + Math.max(p.y, g)) * 0.5, cz);
    const right = _swR.crossVectors(_swUp, SUN_DIR).normalize();
    const up = _swU.crossVectors(SUN_DIR, right).normalize();
    const texel = (2 * this.shadowExtent) / L.shadow.mapSize.x;
    const a = Math.round(c.dot(right) / texel) * texel - c.dot(right);
    const b = Math.round(c.dot(up) / texel) * texel - c.dot(up);
    c.addScaledVector(right, a).addScaledVector(up, b);
    L.target.position.copy(c);
    L.position.copy(c).addScaledVector(SUN_DIR, 1800);
    L.target.updateMatrixWorld();
  }

  /** ground, sea surface or rooftop, whichever is highest at (x, z) */
  groundTop(x, z) {
    return Math.max(this.surfaceAt(x, z), this.city.topAt(x, z));
  }

  cityHit(x, y, z) {
    return this.city.hit(x, y, z);
  }

  /** Synchronously build everything around a point (used when a mode starts). */
  prebuild(pos) {
    this.terrain.update(pos, true);
  }

  update(camera, dt) {
    this.time += dt;
    const p = camera.position;
    this.terrain.update(p, false);
    this.city.update(dt);
    // view-frustum culling for the things three cannot cull by itself
    camera.updateMatrixWorld();
    _cullM.multiplyMatrices(camera.projectionMatrix, _cullInv.copy(camera.matrixWorld).invert());
    this.cullFrustum.setFromProjectionMatrix(_cullM);
    this.city.cull(this.cullFrustum);
    this.terrain.cullTrees(this.cullFrustum);
    if (this.shadowOn) this.updateShadow(camera);
    if (this.flashLight.intensity > 0.01) this.flashLight.intensity *= Math.exp(-dt * 2.6); else this.flashLight.intensity = 0;
    this.sky.position.copy(p);
    this.water.position.set(p.x, 0, p.z);
    this.waveTex.offset.set(p.x / 150 + this.time * 0.006, -p.z / 150 + this.time * 0.004);
    this.clouds.update(p);
  }
}

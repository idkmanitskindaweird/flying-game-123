'use strict';
/* ==========================================================================
   clouds.js - how clouds are drawn.
   Each puff is a quad that always faces the camera but keeps its "up" locked to the WORLD's up, so when you roll or pitch the
   aircraft the clouds stay level with the horizon (screen-aligned sprites would roll with the camera). Puffs fade out when the camera
   gets close to them, so flying through a cloud is a soft grey-out instead of big sprites popping. Each puff carries its own shading
   (darker underneath and on the side away from the sun), and the puff textures are generated from fractal noise with self-shadowing,
   so they look billowy rather than like round blobs.
   ========================================================================== */

/** noise-based puff textures. kinds: 'cu' cumulus, 'st' stratus. Returns CanvasTextures with alpha and baked shading. */
function makeCumulusTextures(kinds, seedBase) {
  const out = [];
  kinds.forEach((kind, n) => {
    const S = 160;
    const [cv, g] = makeCanvas(S, S);
    const nz = new Noise2D((seedBase || 5100) + n * 31);
    const img = g.createImageData(S, S);
    const st = kind === 'st';
    const dens = (u, v) => {
      // u, v in -1..1 (v positive = down). A soft round (or wide, for stratus) body with a flattened base...
      const r = Math.hypot(u * (st ? 0.62 : 0.95), v * (st ? 1.9 : 1.1));
      let mask = 1 - smoothstep(st ? 0.3 : 0.28, 1.0, r);
      if (!st) mask *= 1 - smoothstep(0.32, 0.62, v);
      // ...broken up by fractal noise into billows
      const f = nz.fbm(u * (st ? 1.6 : 2.4) + n * 3.1, v * (st ? 3.2 : 2.4), 5) * 0.5 + 0.5;
      const edge = 1 - smoothstep(0.55, 0.98, Math.max(Math.abs(u), Math.abs(v))); // always fade to nothing before the square's border
      return clamp(f * 1.3 + mask * 0.95 - 0.66, 0, 1) * edge;
    };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / (S - 1)) * 2 - 1, v = (y / (S - 1)) * 2 - 1;
        const d = dens(u, v);
        const dl = dens(u - 0.08, v - 0.1); // toward the light (upper left)
        const a = Math.pow(smoothstep(0.02, 0.5, d), 0.85);
        // self-shadowing: surfaces facing the light are bright, the far sides fall into blue-grey shade
        let sh = clamp(0.7 + (d - dl) * 2.6, 0.38, 1);
        sh *= 1 - 0.22 * smoothstep(0.0, 0.7, v); // darker toward the base
        const i = (y * S + x) * 4;
        img.data[i] = (0.56 + 0.44 * sh) * 255 * (0.9 + 0.1 * sh);
        img.data[i + 1] = (0.62 + 0.38 * sh) * 255;
        img.data[i + 2] = (0.76 + 0.24 * sh) * 255;
        img.data[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.anisotropy = 2;
    out.push(t);
  });
  return out;
}

const CLOUD_VERT = `
attribute vec3 center;
attribute vec2 corner;
attribute vec2 psize;
attribute float rot;
attribute float shade;
varying vec2 vUv;
varying float vShade;
varying float vNear;
#include <fog_pars_vertex>
void main() {
  vec3 wc = (modelMatrix * vec4(center, 1.0)).xyz;
  vec3 toCam = cameraPosition - wc;
  float dist = length(toCam);
  toCam /= max(dist, 0.001);
  // a billboard that faces the camera but keeps the world's up: it does not roll with the aircraft
  vec3 right = cross(vec3(0.0, 1.0, 0.0), toCam);
  float rl = length(right);
  right = rl > 0.03 ? right / rl : vec3(1.0, 0.0, 0.0);
  vec3 up = cross(toCam, right);
  float c = cos(rot), s = sin(rot);
  vec2 q = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  vec3 wp = wc + right * (q.x * psize.x) + up * (q.y * psize.y);
  vUv = corner + 0.5;
  vShade = shade;
  vNear = dist / max(psize.x, psize.y);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const CLOUD_FRAG = `
uniform sampler2D map;
uniform float uOpacity;
uniform vec3 uTint;
varying vec2 vUv;
varying float vShade;
varying float vNear;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  float a = t.a * uOpacity * smoothstep(0.22, 0.8, vNear); // soft fade when the camera is close to (or inside) the puff
  gl_FragColor = vec4(t.rgb * uTint * vShade, a);
  #include <fog_fragment>
}`;

function makeCloudMaterial(tex) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      map: { value: tex }, uOpacity: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) },
    }]),
    vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
    transparent: true, depthWrite: false, fog: true,
  });
}

/** one mesh from many puffs: [{x, y, z, sx, sy, rot, shade}] (positions relative to the mesh) */
function buildPuffMesh(puffs, material) {
  const n = puffs.length;
  const center = new Float32Array(n * 12), corner = new Float32Array(n * 8), psize = new Float32Array(n * 8);
  const rot = new Float32Array(n * 4), shade = new Float32Array(n * 4);
  const idx = new Uint16Array(n * 6);
  const cs = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  let rad = 1;
  puffs.forEach((p, i) => {
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      center[v * 3] = p.x; center[v * 3 + 1] = p.y; center[v * 3 + 2] = p.z;
      corner[v * 2] = cs[k][0]; corner[v * 2 + 1] = cs[k][1];
      psize[v * 2] = p.sx; psize[v * 2 + 1] = p.sy;
      rot[v] = p.rot || 0;
      shade[v] = p.shade === undefined ? 1 : p.shade;
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    rad = Math.max(rad, Math.hypot(p.x, p.y, p.z) + Math.max(p.sx, p.sy));
  });
  const geo = new THREE.BufferGeometry();
  // "position" is required by three; the vertex shader ignores it and builds the quad itself
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 12), 3));
  geo.setAttribute('center', new THREE.BufferAttribute(center, 3));
  geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('psize', new THREE.BufferAttribute(psize, 2));
  geo.setAttribute('rot', new THREE.BufferAttribute(rot, 1));
  geo.setAttribute('shade', new THREE.BufferAttribute(shade, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rad);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = true;
  return mesh;
}

'use strict';
/* ==========================================================================
   util.js - math helpers, seeded random numbers, gradient noise
   ========================================================================== */

const PI = Math.PI;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const SPEED_OF_SOUND = 343; // m/s (sea level, 20 C)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wrapPi = (a) => {
  a = (a + PI) % TAU;
  if (a < 0) a += TAU;
  return a - PI;
};
const mix3 = (a, b, t, out) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of integer lattice coordinates -> [0,1). */
function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Classic 2D gradient (Perlin) noise with fBm helpers. Output roughly in [-1, 1]. */
class Noise2D {
  constructor(seed) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.p[i] = p[i & 255];
  }

  noise(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = X & 255, yi = Y & 255;
    const p = this.p;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = p[p[xi] + yi], b = p[p[xi + 1] + yi];
    const c = p[p[xi] + yi + 1], d = p[p[xi + 1] + yi + 1];
    const x1 = xf - 1, y1 = yf - 1;
    // gradients: 8 directions
    const ga = grad8(a, xf, yf), gb = grad8(b, x1, yf);
    const gc = grad8(c, xf, y1), gd = grad8(d, x1, y1);
    const l1 = ga + (gb - ga) * u;
    const l2 = gc + (gd - gc) * u;
    return (l1 + (l2 - l1) * v) * 1.15;
  }

  /** Periodic variant (tiles every `period` lattice cells) - used for textures. */
  tileNoise(x, y, period) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const xi = ((X % period) + period) % period, yi = ((Y % period) + period) % period;
    const xj = (xi + 1) % period, yj = (yi + 1) % period;
    const p = this.p;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = p[p[xi & 255] + (yi & 255)], b = p[p[xj & 255] + (yi & 255)];
    const c = p[p[xi & 255] + (yj & 255)], d = p[p[xj & 255] + (yj & 255)];
    const x1 = xf - 1, y1 = yf - 1;
    const ga = grad8(a, xf, yf), gb = grad8(b, x1, yf);
    const gc = grad8(c, xf, y1), gd = grad8(d, x1, y1);
    const l1 = ga + (gb - ga) * u;
    const l2 = gc + (gd - gc) * u;
    return (l1 + (l2 - l1) * v) * 1.15;
  }

  /** Fractal Brownian motion, normalised to roughly [-1,1]. Domain is rotated each octave. */
  fbm(x, y, oct, lac = 2.0, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.noise(x, y);
      norm += amp;
      amp *= gain;
      const nx = (x * 0.8 - y * 0.6) * lac + 17.3;
      const ny = (x * 0.6 + y * 0.8) * lac - 9.1;
      x = nx;
      y = ny;
    }
    return sum / norm;
  }

  /** Ridged multifractal, result in about [0, 1]. */
  ridged(x, y, oct, lac = 2.0, gain = 0.5) {
    let amp = 1, sum = 0, norm = 0, w = 1;
    for (let i = 0; i < oct; i++) {
      let n = 1 - Math.abs(this.noise(x, y));
      n *= n;
      n *= w;
      w = clamp(n * 2, 0, 1);
      sum += n * amp;
      norm += amp;
      amp *= gain;
      const nx = (x * 0.8 - y * 0.6) * lac + 5.7;
      const ny = (x * 0.6 + y * 0.8) * lac + 23.1;
      x = nx;
      y = ny;
    }
    return sum / norm;
  }
}

function grad8(h, x, y) {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x * 1.4;
    case 5: return -x * 1.4;
    case 6: return y * 1.4;
    default: return -y * 1.4;
  }
}

/** Small helper: create a canvas of a given size and return [canvas, ctx]. */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

'use strict';
/* ==========================================================================
   fireball.js - a simulated fireball (not a canned particle burst).
   Hundreds of parcels of hot gas, each with its own temperature, radius and velocity. They obey:
     * the blast: an initial outward rush that air drag quickly kills,
     * buoyancy: hot gas is lighter than air, so acceleration grows with temperature,
     * cooling: radiation plus mixing with cold air (faster when moving fast), so the colour runs white -> yellow -> orange -> red -> soot,
     * entrainment: the parcels swell as they sweep up cold air,
     * a Hill's spherical vortex around the rising cap: gas shoots up the middle and rolls down the outside, the way a real
       fireball or mushroom cloud rolls over itself,
     * a stem of hot gas fed up from the ground for the first second or so,
     * turbulence, and ground bounce.
   Cooled gas turns into dark soot smoke. Rendering uses the shared fire (additive) and smoke particle systems.
   ========================================================================== */

/** temperature (0..1) -> blackbody-ish colour */
function fireColor(T, out) {
  const stops = [[0.12, 0.45, 0.1, 0.03], [0.3, 0.85, 0.27, 0.06], [0.5, 1.0, 0.55, 0.14], [0.72, 1.0, 0.8, 0.36], [0.92, 1.0, 0.96, 0.8]];
  if (T <= stops[0][0]) { out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3]; return out; }
  for (let i = 1; i < stops.length; i++) {
    if (T <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], u = (T - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * u; out[1] = a[2] + (b[2] - a[2]) * u; out[2] = a[3] + (b[3] - a[3]) * u;
      return out;
    }
  }
  const e = stops[stops.length - 1];
  out[0] = e[1]; out[1] = e[2]; out[2] = e[3];
  return out;
}

const _fcol = [0, 0, 0];

class FireballSim {
  /** scale ~1.7 for a fighter, 3-6 for an airliner; big: the bigger particle budget and a longer burn */
  constructor(fx, x, y, z, scale, big) {
    this.fx = fx;
    this.scale = scale;
    this.big = !!big;
    const gnd = fx.ground ? fx.ground(x, z) : y;
    this.gy = Math.min(gnd, y);
    this.R0 = 13 * scale; // initial radius of the ball
    this.U0 = 20 * Math.sqrt(scale); // how fast the cap rises at first (m/s)
    this.tau = 2.4 + 0.5 * Math.sqrt(scale);
    this.t = 0;
    this.cx = x; this.cz = z;
    this.cy = Math.max(y, this.gy + this.R0 * 0.55);
    const q = fx.budget || 1;
    this.N = Math.round((this.big ? 460 : 230) * q);
    this.p = [];
    this.stemLeft = Math.round(this.N * 0.3);
    this.life = this.big ? 13 : 9;
    this.done = false;

    const n0 = this.N - this.stemLeft;
    for (let i = 0; i < n0; i++) {
      // a ball of hot gas, hottest at the centre, rushing outwards
      const a = rand(0, TAU), e = rand(-1, 1), cyl = Math.sqrt(1 - e * e), rad = Math.cbrt(Math.random()) * this.R0 * 0.55;
      const dx = Math.cos(a) * cyl, dy = e, dz = Math.sin(a) * cyl;
      const vb = 52 * Math.sqrt(scale) * rand(0.6, 1.1) * (rad / (this.R0 * 0.55) * 0.7 + 0.3);
      this.add(this.cx + dx * rad, this.cy + dy * rad, this.cz + dz * rad, dx * vb, dy * vb * 0.8, dz * vb, 1 - 0.3 * rad / (this.R0 * 0.55) + rand(-0.08, 0.05), this.R0 * rand(0.26, 0.4));
    }
  }

  add(x, y, z, vx, vy, vz, T, r) {
    const f = this.fx.fire.alloc();
    if (f < 0) return;
    this.p.push({ x, y, z, vx, vy, vz, T, r, f, s: -1, ph: Math.random() * TAU, ph2: Math.random() * TAU, sz: rand(0.35, 1.25) });
  }

  kill() {
    for (const q of this.p) this.release(q);
    this.p.length = 0;
    this.done = true;
  }

  release(q) {
    if (q.f >= 0) { this.fx.fire.release(q.f); q.f = -1; }
    if (q.s >= 0) { this.fx.smoke.release(q.s); q.s = -1; }
  }

  update(dt) {
    if (this.done) return false;
    dt = Math.min(dt, 0.05);
    const t = (this.t += dt), sc = this.scale, fx = this.fx;
    const U = this.U0 * Math.exp(-t / this.tau); // rise speed of the cap, easing off as it cools and mixes
    this.cy += U * 0.85 * dt;
    const a = this.R0 * (1 + 1.7 * (1 - Math.exp(-t / 1.5))); // the cap grows
    const a2 = a * a;
    const vort = clamp((t - 0.2) / 0.5, 0, 1); // the vortex organises itself after the first rush
    const blastDrag = 0.45 + 3.4 * Math.exp(-t * 1.3);

    // the stem: hot gas still being fed up from the burning wreck
    if (this.stemLeft > 0) {
      const k = Math.min(this.stemLeft, Math.max(1, Math.round(this.N * 0.3 * dt / 1.3)));
      for (let i = 0; i < k; i++) {
        this.stemLeft--;
        const o = rand(0, 0.3) * this.R0, an = rand(0, TAU);
        this.add(this.cx + Math.cos(an) * o, this.gy + rand(0.2, 1.2) * this.R0 * 0.3, this.cz + Math.sin(an) * o,
          rand(-3, 3), this.U0 * rand(0.55, 1.0), rand(-3, 3), rand(0.55, 0.85), this.R0 * rand(0.22, 0.34));
      }
    }

    const age = t / this.life;
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i];
      const sp = Math.sqrt(q.vx * q.vx + q.vy * q.vy + q.vz * q.vz);

      // cooling: radiation (strong when very hot) and mixing with cold air (strong when moving fast)
      q.T *= Math.exp(-(0.2 + 0.55 * Math.min(sp / 60, 1.5) + 0.3 * q.T * q.T) * dt);
      // buoyancy: hot gas is lighter than the air around it
      q.vy += 15 * Math.max(0, q.T - 0.1) * dt;
      // drag: the blast rush dies quickly, and big blobs coast
      const dk = Math.exp(-blastDrag * dt * (1.2 / (0.6 + q.r / this.R0)));
      q.vx *= dk; q.vy *= dk; q.vz *= dk;

      // the rolling vortex (Hill's spherical vortex) around the rising cap
      const dx = q.x - this.cx, dy = q.y - this.cy, dz = q.z - this.cz;
      const rho2 = dx * dx + dz * dz, d2 = rho2 + dy * dy;
      if (d2 < a2 * 1.5 && vort > 0) {
        const fall = 1 - clamp((d2 - a2) / (a2 * 0.5), 0, 1);
        const vz = U * 0.5 + 1.35 * U * (1 - (2 * rho2 + dy * dy) / a2); // up through the middle, down around the outside
        const rho = Math.sqrt(rho2) + 1e-3;
        const vr = 1.35 * U * (rho * dy) / a2 * 1.6; // out over the top, in underneath
        const kk = Math.min(1, 2.4 * dt) * vort * fall;
        q.vy += (vz - q.vy) * kk;
        const cvr = (q.vx * dx + q.vz * dz) / rho;
        q.vx += (vr - cvr) * (dx / rho) * kk;
        q.vz += (vr - cvr) * (dz / rho) * kk;
      }

      // turbulence
      const amp = (2.5 + 7 * Math.min(1, t / 1.5)) * Math.sqrt(sc / 1.7) * (0.3 + q.T) * dt;
      q.vx += amp * Math.sin(q.y * 0.19 + t * 1.9 + q.ph) * Math.cos(q.z * 0.17 - t * 1.3);
      q.vy += amp * 0.6 * Math.sin(q.x * 0.21 + t * 1.5 + q.ph2);
      q.vz += amp * Math.sin(q.x * 0.18 - t * 1.7 + q.ph) * Math.cos(q.y * 0.2 + t);

      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;

      // ground: hot gas hitting it splashes outward (this is what makes the base of the fireball hug the ground)
      const g = fx.ground ? fx.ground(q.x, q.z) : this.gy;
      if (q.y < g + q.r * 0.35) {
        q.y = g + q.r * 0.35;
        if (q.vy < 0) q.vy = -q.vy * 0.2;
        const hs = Math.hypot(q.x - this.cx, q.z - this.cz) + 1e-3;
        q.vx += (q.x - this.cx) / hs * 6 * dt * Math.max(0, q.T);
        q.vz += (q.z - this.cz) / hs * 6 * dt * Math.max(0, q.T);
      }

      // entrainment: parcels swell as they sweep up cold air
      q.r = Math.min(this.R0 * 1.15, q.r * (1 + (0.3 + 0.012 * sp) * dt));

      // ---- drawing ----
      if (q.f >= 0) {
        const fp = fx.fire, f3 = q.f * 3, f4 = q.f * 4;
        fireColor(q.T, _fcol);
        const glow = clamp((q.T - 0.14) / 0.45, 0, 1);
        fp.pos[f3] = q.x; fp.pos[f3 + 1] = q.y; fp.pos[f3 + 2] = q.z;
        fp.siz[q.f] = q.r * 2.3;
        fp.col[f4] = _fcol[0]; fp.col[f4 + 1] = _fcol[1]; fp.col[f4 + 2] = _fcol[2];
        fp.col[f4 + 3] = glow * (0.1 + 0.2 * q.T) * (this.big ? 0.8 : 1);
        if (glow <= 0 && q.s >= 0) { fp.release(q.f); q.f = -1; }
      }
      // soot: as the gas cools it turns into dark smoke that keeps drifting
      if (q.T < 0.48 && q.s < 0) q.s = fx.smoke.alloc();
      if (q.s >= 0) {
        const sp2 = fx.smoke, s3 = q.s * 3, s4 = q.s * 4;
        const dark = 0.05 + 0.1 * clamp(q.T * 2, 0, 1);
        sp2.pos[s3] = q.x; sp2.pos[s3 + 1] = q.y; sp2.pos[s3 + 2] = q.z;
        sp2.siz[q.s] = q.r * 2.9 * q.sz * (1 + 0.5 * age);
        sp2.col[s4] = dark; sp2.col[s4 + 1] = dark * 0.95; sp2.col[s4 + 2] = dark * 0.9;
        sp2.col[s4 + 3] = clamp((0.48 - q.T) / 0.3, 0, 1) * 0.07 * (1 - clamp((age - 0.4) / 0.5, 0, 1)); // each parcel is thin; the dense cap comes from hundreds overlapping
      }
    }

    if (t > this.life) { this.kill(); return false; }
    return true;
  }
}

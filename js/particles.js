'use strict';
/* ==========================================================================
   particles.js - GPU point-sprite particle systems (smoke / fire / sparks)
   Two instances are used: one alpha-blended (smoke) and one additive (fire).
   ========================================================================== */

class ParticleSystem {
  constructor(scene, max, additive) {
    this.max = max;
    this.additive = additive;
    this.next = 0;
    this.hi = 0;

    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.siz = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max); // 0 => dead
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 4);
    this.c1 = new Float32Array(max * 4);
    this.drag = new Float32Array(max);
    this.buoy = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizAttr = new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('pcolor', this.colAttr);
    geo.setAttribute('psize', this.sizAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    this.uniforms = { uScale: { value: 800 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        attribute vec4 pcolor;
        attribute float psize;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 1.0);
          vColor = pcolor;
          vColor.a *= smoothstep(5.0, 40.0, dist);
          gl_PointSize = min(psize * uScale / dist, 700.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          float a = 1.0 - d;
          a = a * a * (3.0 - 2.0 * a);
          gl_FragColor = vec4(vColor.rgb, vColor.a * a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 4 : 3;
    scene.add(this.points);
  }

  /** p,v: {x,y,z}; c0,c1: [r,g,b,a] */
  emit(p, v, life, size0, size1, c0, c1, drag, buoy) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (i + 1 > this.hi) this.hi = i + 1;
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = size0;
    this.s1[i] = size1;
    for (let k = 0; k < 4; k++) {
      this.c0[i4 + k] = c0[k];
      this.c1[i4 + k] = c1[k];
      this.col[i4 + k] = c0[k];
    }
    this.siz[i] = size0;
    this.drag[i] = drag || 0;
    this.buoy[i] = buoy || 0;
  }

  update(dt, camera, viewportH) {
    const fov = camera.fov * DEG;
    this.uniforms.uScale.value = viewportH / (2 * Math.tan(fov / 2));
    const hi = this.hi;
    let alive = 0;
    for (let i = 0; i < hi; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = (this.age[i] += dt);
      if (age >= life) {
        this.life[i] = 0;
        this.siz[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      const i3 = i * 3, i4 = i * 4;
      const t = age / life;
      const dk = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dk;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dk + this.buoy[i] * dt;
      this.vel[i3 + 2] *= dk;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.siz[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      for (let k = 0; k < 4; k++) this.col[i4 + k] = this.c0[i4 + k] + (this.c1[i4 + k] - this.c0[i4 + k]) * t;
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizAttr.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.siz.fill(0);
    this.col.fill(0);
    this.hi = 0;
    this.next = 0;
  }
}

/** Convenience wrapper holding both systems and recipes for common effects. */
class Effects {
  constructor(scene, quality) {
    this.smoke = new ParticleSystem(scene, quality.particles, false);
    this.fire = new ParticleSystem(scene, Math.floor(quality.particles * 0.6), true);
    this._p = { x: 0, y: 0, z: 0 };
    this._v = { x: 0, y: 0, z: 0 };
    this._c0 = [0, 0, 0, 0];
    this._c1 = [0, 0, 0, 0];
  }

  update(dt, camera, h) {
    this.smoke.update(dt, camera, h);
    this.fire.update(dt, camera, h);
  }

  clear() {
    this.smoke.clear();
    this.fire.clear();
  }

  /** a white/grey smoke puff */
  puff(x, y, z, vx, vy, vz, life, s0, s1, shade, alpha, drag, buoy) {
    const p = this._p, v = this._v;
    p.x = x; p.y = y; p.z = z; v.x = vx; v.y = vy; v.z = vz;
    const c0 = this._c0, c1 = this._c1;
    c0[0] = c0[1] = c0[2] = shade; c0[3] = alpha;
    c1[0] = c1[1] = c1[2] = shade * 0.9; c1[3] = 0;
    this.smoke.emit(p, v, life, s0, s1, c0, c1, drag === undefined ? 0.4 : drag, buoy || 0);
  }

  /** additive glowing blob */
  glow(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag) {
    const p = this._p, v = this._v;
    p.x = x; p.y = y; p.z = z; v.x = vx; v.y = vy; v.z = vz;
    const c0 = this._c0, c1 = this._c1;
    c0[0] = r; c0[1] = g; c0[2] = b; c0[3] = a;
    c1[0] = r * 0.55; c1[1] = g * 0.25; c1[2] = b * 0.1; c1[3] = 0;
    this.fire.emit(p, v, life, s0, s1, c0, c1, drag === undefined ? 1.2 : drag, 0);
  }

  explosion(x, y, z, scale, vx, vy, vz) {
    scale = scale || 1;
    vx = vx || 0; vy = vy || 0; vz = vz || 0;
    // flash
    this.glow(x, y, z, vx, vy, vz, 0.22, 60 * scale, 150 * scale, 1, 0.9, 0.7, 1, 0);
    // fireball
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), e = rand(-0.6, 1), sp = rand(8, 55) * scale;
      const cy = Math.sqrt(Math.max(0, 1 - e * e));
      this.glow(x, y, z, vx * 0.6 + Math.cos(a) * cy * sp, vy * 0.6 + e * sp * 0.8, vz * 0.6 + Math.sin(a) * cy * sp,
        rand(0.5, 1.2), rand(14, 26) * scale, rand(30, 55) * scale, 1, rand(0.55, 0.8), rand(0.15, 0.3), rand(0.7, 1), 1.6);
    }
    // sparks
    for (let i = 0; i < 28; i++) {
      const a = rand(0, TAU), e = rand(-0.5, 1), sp = rand(40, 170) * scale;
      const cy = Math.sqrt(Math.max(0, 1 - e * e));
      this.glow(x, y, z, vx * 0.5 + Math.cos(a) * cy * sp, vy * 0.5 + e * sp, vz * 0.5 + Math.sin(a) * cy * sp,
        rand(0.4, 1.1), 2.5 * scale, 1, 1, rand(0.7, 0.95), rand(0.3, 0.6), 1, 0.6);
    }
    // smoke
    for (let i = 0; i < 34; i++) {
      const a = rand(0, TAU), e = rand(-0.4, 1), sp = rand(4, 26) * scale;
      const cy = Math.sqrt(Math.max(0, 1 - e * e));
      this.puff(x, y, z, vx * 0.4 + Math.cos(a) * cy * sp, vy * 0.4 + e * sp * 0.8 + 3, vz * 0.4 + Math.sin(a) * cy * sp,
        rand(2.5, 5.5), rand(16, 28) * scale, rand(55, 110) * scale, rand(0.12, 0.3), rand(0.55, 0.85), 1.0, rand(2, 6));
    }
  }
}

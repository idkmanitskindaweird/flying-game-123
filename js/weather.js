'use strict';
/* ==========================================================================
   weather.js - storms.
   Towering dark thunderheads (cumulonimbus with flat anvil tops) drift across the map. Under each one there is a curtain
   of rain; lightning bolts strike from the cloud base to the ground, flash-light the clouds and the scene, and are followed
   by thunder that arrives after the travel time of sound. Fly into a storm and the world closes in: dense dark fog, heavy
   rain on the screen, a darker sky, buffeting turbulence and the roar of the rain.
   Setting: Settings -> Weather (Fair / Cloudy / Stormy).
   ========================================================================== */

/** a big soft dark cloud puff: lit from above, grey-blue underneath */
function makeStormPuffTexture() {
  const S = 256;
  const [cv, g] = makeCanvas(S, S);
  const rnd = mulberry32(777);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * TAU, d = Math.pow(rnd(), 0.7) * 78;
    const x = 128 + Math.cos(a) * d * 1.1, y = 120 + Math.sin(a) * d * 0.8 - 6;
    const r = 26 + rnd() * 34;
    const gr = g.createRadialGradient(x - r * 0.25, y - r * 0.35, r * 0.08, x, y, r);
    gr.addColorStop(0, 'rgba(206,210,220,0.95)');
    gr.addColorStop(0.5, 'rgba(128,136,150,0.72)');
    gr.addColorStop(0.85, 'rgba(72,80,94,0.42)');
    gr.addColorStop(1, 'rgba(52,58,72,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  g.globalCompositeOperation = 'source-atop';
  const lg = g.createLinearGradient(0, 70, 0, 215);
  lg.addColorStop(0, 'rgba(40,46,60,0)');
  lg.addColorStop(1, 'rgba(32,38,52,0.7)');
  g.fillStyle = lg; g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}

/** streaky falling rain, tiled vertically */
function makeRainTexture() {
  const [cv, g] = makeCanvas(128, 256);
  const rnd = mulberry32(31);
  for (let i = 0; i < 150; i++) {
    const x = rnd() * 128, y = rnd() * 256, l = 16 + rnd() * 46;
    g.strokeStyle = `rgba(215,225,240,${0.18 + rnd() * 0.4})`;
    g.lineWidth = 0.8 + rnd() * 1.1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x - 2, y + l); g.stroke();
    if (y + l > 256) { g.beginPath(); g.moveTo(x, y - 256); g.lineTo(x - 2, y + l - 256); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const _rainV = new THREE.Vector3(), _rainF = new THREE.Vector3(), _rainA = new THREE.Vector3(), _rainU = new THREE.Vector3(), _rainW = new THREE.Vector3(), _rainUp = new THREE.Vector3(0, 1, 0);

class StormCell {
  constructor(weather, x, z, r, seed) {
    this.w = weather;
    this.x = x; this.z = z; this.r = r;
    this.vx = 7 + (seed % 5) * 0.6; this.vz = 2.5 - (seed % 3);
    this.baseY = 1050 + (seed * 37 % 200);
    this.topY = 6300 + (seed * 91 % 900);
    this.group = new THREE.Group();
    this.timer = rand(1.5, 5);
    this.gy = 0; this.lastGyX = 1e9; this.lastGyZ = 1e9;
    const q = weather.q;
    this.mat = makeCloudMaterial(weather.texPuff);
    const puffs = [];
    const add = (px, py, pz, sx, sy, shade) => puffs.push({ x: px, y: py, z: pz, sx, sy, rot: rand(-0.2, 0.2), shade });
    // the dark base wall of the storm
    for (let i = 0; i < Math.round(30 * q); i++) {
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * r * 1.05, s = r * rand(0.6, 1.1);
      add(Math.cos(a) * d, this.baseY + rand(-120, 160), Math.sin(a) * d, s * 1.5, s * 0.7, rand(0.36, 0.52));
    }
    // towers climbing to the anvil: dark low down, bright in the sunlit tops
    const towers = 4 + (seed % 3);
    for (let t = 0; t < towers; t++) {
      const ta = rand(0, TAU), td = rand(0, 0.55) * r;
      const steps = Math.round(15 * q);
      for (let k = 0; k < steps; k++) {
        const u = k / (steps - 1);
        const h = this.baseY + (this.topY - this.baseY) * Math.pow(u, 1.15);
        const rr = r * (0.55 - 0.3 * u) * rand(0.4, 1.0);
        const a = rand(0, TAU);
        const s = r * (0.55 + 0.35 * rand(0, 1)) * (1.05 - 0.4 * u);
        add(Math.cos(ta) * td + Math.cos(a) * rr, h, Math.sin(ta) * td + Math.sin(a) * rr, s * 1.4, s * 1.1, clamp(0.42 + 0.6 * u + rand(-0.06, 0.06), 0.4, 1.05));
      }
    }
    // the flat anvil top, blown downwind
    for (let i = 0; i < Math.round(20 * q); i++) {
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * r * 1.7, s = r * rand(0.6, 1.1);
      add(Math.cos(a) * d + r * 0.5, this.topY + rand(-250, 350), Math.sin(a) * d, s * 2.1, s * 0.55, rand(0.88, 1.05));
    }
    this.group.add(buildPuffMesh(puffs, this.mat));
    weather.group.add(this.group);

    // rain curtains under the cloud
    this.rainMat = new THREE.MeshBasicMaterial({ map: weather.texRain.clone(), transparent: true, depthWrite: false, opacity: 0.34, side: THREE.DoubleSide, fog: true });
    this.rainMat.map.needsUpdate = true;
    this.rainMat.map.wrapS = this.rainMat.map.wrapT = THREE.RepeatWrapping;
    this.rain = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.5, 1), this.rainMat);
      m.rotation.y = (i / 3) * PI;
      this.rain.add(m);
    }
    weather.group.add(this.rain);
    this.place();
  }

  place() {
    this.group.position.set(this.x, 0, this.z);
    const g = Math.max(0, this.w.world.surfaceAt(this.x, this.z));
    this.gy = g;
    const h = Math.max(300, this.baseY + 80 - g);
    this.rain.position.set(this.x, g + h / 2, this.z);
    this.rain.children.forEach((m) => m.scale.set(1, h, 1));
    this.rainMat.map.repeat.set(2.2, h / 700);
    this.lastGyX = this.x; this.lastGyZ = this.z;
  }

  update(dt, cam) {
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.group.position.x = this.x; this.group.position.z = this.z;
    this.rain.position.x = this.x; this.rain.position.z = this.z;
    if (Math.abs(this.x - this.lastGyX) + Math.abs(this.z - this.lastGyZ) > 250) this.place();
    this.rainMat.map.offset.y -= dt * 2.4;
    // a storm that has drifted far away is replaced by a new one ahead of the camera
    if (Math.hypot(this.x - cam.x, this.z - cam.z) > 26000) {
      const a = rand(0, TAU);
      this.x = cam.x + Math.cos(a) * 18000; this.z = cam.z + Math.sin(a) * 18000;
      this.place();
    }
  }
}

/**
 * A hurricane: a huge rotating storm. A clear calm EYE ringed by the towering dark EYEWALL (the strongest winds, heaviest rain
 * and most lightning), three spiral RAINBANDS arming out to ~34 km, and a bright cirrus outflow canopy 12 km up. The whole
 * structure turns counter-clockwise, drifts across the map, and drags aircraft around with its winds.
 */
class Hurricane {
  constructor(weather, x, z) {
    this.w = weather;
    this.x = x; this.z = z;
    this.R = 34000; this.eye = 3200; this.top = 12500;
    this.vx = -2.5; this.vz = 1.0;
    this.omega = 0.011; // rad/s: one turn every ~10 minutes
    this.rot = 0;
    this.vmax = 78; // strongest wind, in the eyewall (m/s)
    this.group = new THREE.Group();
    this.mat = makeCloudMaterial(weather.texPuff);
    const q = weather.q, puffs = [];
    const add = (px, py, pz, sx, sy, shade) => puffs.push({ x: px, y: py, z: pz, sx, sy, rot: rand(-0.25, 0.25), shade });
    // the eyewall: a ring of towers that lean outward as they climb
    const nA = Math.round(64 * q);
    for (let i = 0; i < nA; i++) {
      const a = (i / nA) * TAU + rand(-0.04, 0.04), r0 = this.eye + rand(0, 1500);
      const lv = 5;
      for (let k = 0; k < lv; k++) {
        const u = k / (lv - 1), h = 900 + u * (this.top - 1800), r = r0 + u * u * 4200 + rand(-500, 500), s = 2400 + 1600 * u + rand(0, 900);
        add(Math.cos(a) * r, h, Math.sin(a) * r, s * 1.5, s * 1.15, clamp(0.34 + 0.66 * u + rand(-0.05, 0.05), 0.3, 1.05));
      }
    }
    // three spiral rainbands
    const arms = 3, steps = Math.max(24, Math.round(60 * q));
    for (let arm = 0; arm < arms; arm++) {
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1), r = this.eye * 1.9 + t * (this.R - this.eye * 1.9);
        const th = (arm / arms) * TAU + 2.2 * Math.log(r / this.eye) + rand(-0.05, 0.05);
        const wob = rand(-1, 1) * 1700 * (1 - 0.5 * t);
        const px = Math.cos(th) * r - Math.sin(th) * wob, pz = Math.sin(th) * r + Math.cos(th) * wob;
        const size = (1800 + rand(0, 1800)) * (1 - 0.3 * t);
        add(px, rand(1500, 4600), pz, size * 1.6, size * 1.1, rand(0.46, 0.82));
      }
    }
    // the cirrus outflow canopy, bright in the sun
    for (let i = 0; i < Math.round(60 * q); i++) {
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * this.R * 0.9, s = rand(3500, 6500);
      add(Math.cos(a) * d, this.top + rand(-600, 500), Math.sin(a) * d, s * 2.4, s * 0.45, rand(0.9, 1.06));
    }
    this.group.add(buildPuffMesh(puffs, this.mat));
    this.group.position.set(x, 0, z);
    weather.scene.add(this.group);
  }

  update(dt) {
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.rot += this.omega * dt;
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.rot;
  }

  /** storm intensity at a point (0..1): the eyewall and the spiral bands, nothing in the calm eye or above the cloud tops */
  intensityAt(x, y, z) {
    const dx = x - this.x, dz = z - this.z, r = Math.hypot(dx, dz);
    if (r > this.R * 1.05) return 0;
    const theta = Math.atan2(dz, dx) + this.rot;
    const wall = Math.exp(-Math.pow((r - (this.eye + 1000)) / 1900, 2));
    const ph = 3 * (theta - 2.2 * Math.log(Math.max(r, this.eye) / this.eye));
    const band = Math.pow(0.5 + 0.5 * Math.cos(ph), 2.5) * smoothstep(this.R, this.eye * 2.2, r) * 0.8;
    const calm = smoothstep(this.eye * 0.7, this.eye * 1.05, r); // inside the eye it is quiet
    const alt = 1 - smoothstep(this.top - 1200, this.top + 1500, y);
    return Math.max(wall, band) * calm * alt;
  }

  /** wind (m/s) at a point: counter-clockwise around the eye, strongest at the eyewall */
  windAt(x, y, z, out) {
    const dx = x - this.x, dz = z - this.z, r = Math.hypot(dx, dz) + 1;
    if (r > this.R * 1.3) { out.x = out.z = 0; return out; }
    const rp = this.eye + 1000;
    let v = r < rp ? this.vmax * Math.pow(r / rp, 1.6) * (r < this.eye * 0.8 ? 0.4 : 1) : this.vmax * Math.pow(rp / r, 0.62);
    v *= 1 - smoothstep(6000, 11000, y) * 0.9;
    // gusty: the bands pulse
    v *= 0.85 + 0.3 * this.intensityAt(x, Math.min(y, 3000), z);
    out.x = v * dz / r; out.z = -v * dx / r;
    return out;
  }

  /** how calm and clear it is inside the eye (1 at the centre) */
  eyeAmount(x, z) { return 1 - smoothstep(this.eye * 0.55, this.eye * 1.0, Math.hypot(x - this.x, z - this.z)); }

  dispose() {
    this.w.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.mat.dispose();
  }
}

class Weather {
  constructor(scene, world, quality) {
    this.scene = scene;
    this.world = world;
    this.mode = 'cloudy';
    this.I = 0; // how deep inside a storm the camera is (0..1)
    this.flash = 0; this.flashClock = 9;
    this.q = clamp(quality.clouds / 110, 0.45, 1.6);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.texPuff = makeCumulusTextures(['cu'], 8800)[0];
    this.texRain = makeRainTexture();
    this.light = new THREE.PointLight(0xbcd0ff, 0, 9000, 1.0); // lights the world when lightning strikes (always present: no shader recompiles)
    scene.add(this.light);
    // the glowing bolt: a pool of additive sprites laid along a jagged path
    this.bolt = [];
    for (let i = 0; i < 70; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xd8e6ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      s.visible = false;
      scene.add(s);
      this.bolt.push(s);
    }
    // the forks: side branches off the main bolt
    this.fork = [];
    for (let i = 0; i < 44; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xc8d8ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      s.visible = false;
      scene.add(s);
      this.fork.push(s);
    }
    this.snow = 0;
    this.flakes = [];
    this.boltLife = 0;
    this.cells = [];
    const spots = [[3500, -9500, 3000], [-9000, -4500, 3400], [9500, 2500, 2800], [-2500, 10500, 3200]];
    spots.forEach((p, i) => this.cells.push(new StormCell(this, p[0], p[1], p[2], i + 3)));
    // remember the normal look so storms can be blended in and out
    const u = world.sky.material.uniforms;
    this.skyBase = { top: u.uTop.value.clone(), mid: u.uMid.value.clone(), hor: u.uHor.value.clone() };
    this.skyStorm = { top: new THREE.Color(0x3e4753), mid: new THREE.Color(0x626c78), hor: new THREE.Color(0x7d8794) };
    this.fogBase = scene.fog.density;
    this.fogColBase = new THREE.Color(FOG_COLOR);
    this.fogColStorm = new THREE.Color(0x4b525b);
    this.sunBase = world.sunLight.intensity; this.hemiBase = world.hemi.intensity;
    this.rainGain = 0;
    this.hurricane = null; this.hurrTimer = 3; this.hurrWind = { x: 0, z: 0 };
    this.fogColCloud = new THREE.Color(0xdfe5ec);
    this.skySnow = { top: new THREE.Color(0x8c97a6), mid: new THREE.Color(0xb6bfca), hor: new THREE.Color(0xd3d9e0) };
    this.fogColSnow = new THREE.Color(0xcdd4dd);
    this.setMode((typeof Settings !== 'undefined' && Settings.data.weather) || 'cloudy');
    this.setHurricane(typeof Settings !== 'undefined' && Settings.data.hurricane === 'on');
  }

  setMode(m) {
    this.mode = m;
    const cl = this.world.clouds;
    if (cl) { cl.setCoverage(m === 'fair' ? 0.3 : m === 'cloudy' ? 0.85 : 1); cl.setTint(m === 'storm' ? 0.74 : m === 'snow' ? 0.9 : 1); }
    this.group.visible = m === 'storm';
    if (m !== 'storm' && !this.hurricane) { this.I = 0; this.apply(0, 0, 0); this.setBolt(false); }
  }

  /** add or remove the hurricane */
  setHurricane(on) {
    if (on && !this.hurricane) {
      // it starts some 20 km from the airfield, so its outer bands and eyewall are in sight from the start
      this.hurricane = new Hurricane(this, -15000, -13500);
    } else if (!on && this.hurricane) {
      this.hurricane.dispose();
      this.hurricane = null;
      this.hurrWind.x = this.hurrWind.z = 0;
      if (this.mode !== 'storm') { this.I = 0; this.apply(0, 0, 0); this.setBolt(false); }
    }
  }

  /** how much storm there is at a point in space (0..1): inside a storm cell or the hurricane, and below the cloud tops */
  intensityAt(x, y, z) {
    let best = 0;
    if (this.mode === 'storm') {
      for (const c of this.cells) {
        const d = Math.hypot(x - c.x, z - c.z);
        const core = 1 - smoothstep(c.r * 0.5, c.r * 1.05, d);
        const alt = 1 - smoothstep(c.topY - 400, c.topY + 900, y);
        best = Math.max(best, core * alt);
      }
    }
    if (this.hurricane) best = Math.max(best, this.hurricane.intensityAt(x, y, z));
    return best;
  }

  /** how wet the ground should be around (x, z): soaked in a storm, drenched near a hurricane, dry in fair weather */
  wetTarget(cam) {
    let w = this.mode === 'storm' ? 0.75 : 0;
    const h = this.hurricane;
    if (h) {
      const d = Math.hypot(cam.x - h.x, cam.z - h.z);
      w = Math.max(w, 0.9 * (1 - smoothstep(h.R * 0.9, h.R * 2.0, d)));
    }
    return w;
  }

  /**
   * turbulence a flying aircraft feels (0..1): thunderstorms and the hurricane are violent; flying through the body of an ordinary
   * cumulus cloud is bumpy, and the air near the ground is always a little rough (rising warm air, wind over the terrain)
   */
  turbAt(pos) {
    let t = this.intensityAt(pos.x, pos.y, pos.z);
    const cl = this.world.clouds;
    if (cl && cl.inside > 0.05) t = Math.max(t, 0.32 * cl.inside);
    const agl = pos.y - Math.max(0, this.world.surfaceAt(pos.x, pos.z));
    const ground = (this.mode === 'fair' ? 0.05 : 0.11) * (1 - smoothstep(120, 1000, agl));
    return Math.max(t, ground);
  }

  /** wind (m/s) pushing an aircraft along: a steady breeze that gusts (stronger in bad weather), plus a hurricane's winds */
  windAt(pos) {
    const base = this.mode === 'storm' ? 1.35 : this.mode === 'cloudy' ? 0.85 : 0.5;
    const t = this.world.time || 0;
    const gust = 1 + 0.35 * Math.sin(t * 0.37 + pos.x * 0.0004) + 0.2 * Math.sin(t * 0.91 + pos.z * 0.0006) + 0.1 * Math.sin(t * 2.3);
    const o = this.hurrWind;
    o.x = WX_WIND.x * base * gust; o.z = WX_WIND.z * base * gust;
    if (this.hurricane) {
      const hw = this.hurricane.windAt(pos.x, pos.y, pos.z, this._hw || (this._hw = { x: 0, z: 0 }));
      if (hw) { o.x += hw.x; o.z += hw.z; }
    }
    return o;
  }

  /** blend the sky, fog and light between fair weather and the gloom of a storm. sky: gloom of the sky (0..1); I: inside-storm amount; inCloud: inside an ordinary cloud (white-out) */
  apply(sky, I, inCloud) {
    const u = this.world.sky.material.uniforms;
    u.uTop.value.copy(this.skyBase.top).lerp(this.skyStorm.top, sky);
    u.uMid.value.copy(this.skyBase.mid).lerp(this.skyStorm.mid, sky);
    u.uHor.value.copy(this.skyBase.hor).lerp(this.skyStorm.hor, sky);
    if (this.snow > 0.01) { u.uTop.value.lerp(this.skySnow.top, this.snow); u.uMid.value.lerp(this.skySnow.mid, this.snow); u.uHor.value.lerp(this.skySnow.hor, this.snow); }
    const fc = this.fogColBase.clone().lerp(this.fogColStorm, Math.max(sky * 0.5, I));
    if (this.snow > 0.01) fc.lerp(this.fogColSnow, this.snow * 0.92); // a pale, muffled winter haze
    if (inCloud > 0) fc.lerp(this.fogColCloud, inCloud * 0.9); // inside a cloud the world goes pale grey-white
    this.scene.fog.color.copy(fc);
    this.scene.background.copy(fc);
    this.scene.fog.density = this.fogBase * (1 + 55 * I * I + 1.5 * sky + 38 * inCloud * inCloud + 5 * this.snow);
    this.world.sunLight.intensity = this.sunBase * (1 - 0.35 * sky - 0.35 * I - 0.3 * inCloud - 0.32 * this.snow);
    this.world.hemi.intensity = this.hemiBase * (1 - 0.2 * sky - 0.15 * I);
  }

  setBolt(on) { for (const s of this.bolt) s.visible = on; for (const s of this.fork) s.visible = on; }

  strike(cell, cam) {
    const sx = cell.x + rand(-0.6, 0.6) * cell.r, sz = cell.z + rand(-0.6, 0.6) * cell.r;
    const gy = Math.max(0, this.world.surfaceAt(sx, sz));
    const top = cell.baseY + rand(-60, 120);
    // a jagged path from the cloud base to the ground
    let x = sx, z = sz;
    for (let i = 0; i < this.bolt.length; i++) {
      const s = this.bolt[i];
      const u = i / (this.bolt.length - 1);
      const y = top + (gy - top) * u;
      x += rand(-1, 1) * 38 * (1 - u * 0.4); z += rand(-1, 1) * 38 * (1 - u * 0.4);
      s.position.set(x, y, z);
      const sz2 = 55 + rand(0, 40) * (1 - u);
      s.scale.set(sz2, sz2 * 1.2, 1);
      s.visible = true;
    }
    // forks: three branches that leave the main bolt and head off sideways and down
    let fi = 0;
    for (let b = 0; b < 3; b++) {
      const i0 = 6 + Math.floor(Math.random() * this.bolt.length * 0.55), p0 = this.bolt[i0].position;
      let fx = p0.x, fy = p0.y, fz = p0.z;
      const ang = rand(0, TAU), dx = Math.cos(ang), dz = Math.sin(ang), n = 13;
      for (let k = 0; k < n && fi < this.fork.length; k++) {
        const s = this.fork[fi++];
        fx += dx * rand(22, 60) + rand(-24, 24); fz += dz * rand(22, 60) + rand(-24, 24); fy -= rand(24, 58);
        s.position.set(fx, fy, fz);
        const sz = 30 - 20 * (k / n);
        s.scale.set(sz, sz * 1.15, 1);
        s.visible = true;
      }
    }
    for (; fi < this.fork.length; fi++) this.fork[fi].visible = false;
    this.boltPos = new THREE.Vector3(x, gy + 150, z);
    this.boltLife = 0.45;
    this.flash = 1;
    this.light.position.set(x, gy + 400, z);
    // thunder: it reaches you after the travel time of sound
    const d = Math.hypot(x - cam.x, gy - cam.y, z - cam.z);
    const a = typeof App !== 'undefined' ? App.audio : null;
    if (a && a.ok && a.thunder) {
      const rel = { x: x - cam.x, y: gy - cam.y, z: z - cam.z };
      a.later(() => a.thunder(rel, d), Math.min(d / SPEED_OF_SOUND, 25) * 1000);
    }
  }

  update(dt, cam) {
    const storm = this.mode === 'storm', hur = this.hurricane;
    const inCloud = this.world.clouds && this.world.clouds.inside ? this.world.clouds.inside : 0;
    this.snow += ((this.mode === 'snow' ? 1 : 0) - this.snow) * (1 - Math.exp(-dt * 0.6)); // the snow comes and goes gradually
    if (this.snow < 0.002) this.snow = 0;
    if (!storm && !hur) {
      // fair / cloudy / snowy weather: only the white-out inside an ordinary cloud, and the snow's look
      if (inCloud > 0.01 || this._wasCloud || this.snow > 0) { this.apply(this.snow * 0.5, 0, inCloud); this._wasCloud = inCloud > 0.01 || this.snow > 0; }
      return;
    }
    this._wasCloud = true;
    if (storm) for (const c of this.cells) c.update(dt, cam);
    if (hur) hur.update(dt);

    // lightning: storm cells, and the eyewall of a hurricane
    if (storm) {
      for (const c of this.cells) {
        c.timer -= dt;
        if (c.timer <= 0) {
          const dist = Math.hypot(c.x - cam.x, c.z - cam.z);
          if (dist < 22000) this.strike(c, cam);
          c.timer = rand(2.5, 9) * (0.6 + dist / 14000);
        }
      }
    }
    if (hur) {
      this.hurrTimer -= dt;
      if (this.hurrTimer <= 0) {
        const a = rand(0, TAU), r = hur.eye + rand(300, 3200);
        const cell = { x: hur.x + Math.cos(a) * r, z: hur.z + Math.sin(a) * r, r: 2500, baseY: 1100 };
        const dist = Math.hypot(cell.x - cam.x, cell.z - cam.z);
        if (dist < 26000) this.strike(cell, cam);
        this.hurrTimer = rand(1.2, 4.5) * (0.6 + dist / 18000);
      }
    }
    this.boltLife = Math.max(0, this.boltLife - dt);
    // sheet lightning: flashes inside the clouds that light them from within, with no bolt to the ground
    this.sheet = (this.sheet || 0) * Math.exp(-dt * 6);
    if (storm) {
      for (const c of this.cells) {
        c.icTimer = (c.icTimer === undefined ? rand(0.5, 3) : c.icTimer) - dt;
        if (c.icTimer <= 0) {
          c.icTimer = rand(0.7, 3.2);
          const dist = Math.hypot(c.x - cam.x, c.z - cam.z);
          if (dist < 18000) {
            this.sheet = Math.max(this.sheet, rand(0.35, 0.85) * (1 - smoothstep(2000, 18000, dist) * 0.7));
            const a = typeof App !== 'undefined' ? App.audio : null;
            if (a && a.ok && a.thunder && Math.random() < 0.5) { const rel = { x: c.x - cam.x, y: c.baseY + 2500 - cam.y, z: c.z - cam.z }; a.later(() => a.thunder(rel, Math.hypot(rel.x, rel.y, rel.z) * 1.3), Math.min(dist / SPEED_OF_SOUND, 25) * 1000); } // a long, low rumble from inside the cloud
          }
        }
      }
    }
    // the flash flickers: two or three quick pulses then it dies away
    const t = 0.45 - this.boltLife;
    const flick = this.boltLife > 0 ? (Math.sin(t * 38) > -0.2 ? 1 : 0.35) * Math.exp(-t * 4.5) : 0;
    this.flash = Math.max(flick, this.sheet * 0.55);
    for (const s of this.bolt) { if (this.boltLife <= 0) s.visible = false; else s.material.opacity = Math.min(1, flick * 1.4); }
    for (const s of this.fork) { if (this.boltLife <= 0) s.visible = false; else s.material.opacity = Math.min(1, flick * 1.0); }
    this.light.intensity = 9 * this.flash;
    for (const c of this.cells) c.mat.uniforms.uTint.value.setScalar(0.82 * (1 + 1.3 * this.flash));
    if (hur) hur.mat.uniforms.uTint.value.setScalar(0.85 * (1 + 0.9 * this.flash));

    // inside a storm: dense dark fog, dim light
    const I = this.intensityAt(cam.x, cam.y, cam.z);
    this.I += (I - this.I) * (1 - Math.exp(-dt * 1.8));
    // the sky: gloomy under a storm, darkest near the hurricane, and bright blue again right in the eye
    let sky = storm ? 0.8 : 0;
    if (hur) {
      const dh = Math.hypot(cam.x - hur.x, cam.z - hur.z);
      const prox = 1 - smoothstep(hur.R * 0.8, hur.R * 1.9, dh);
      sky = Math.max(sky, 0.92 * prox * (1 - 0.8 * hur.eyeAmount(cam.x, cam.z)));
    }
    this.apply(sky, this.I, inCloud);

    // the sound of rain, loudest inside the storm
    const a = typeof App !== 'undefined' ? App.audio : null;
    if (a && a.ok && a.setRain) a.setRain(this.I);
  }


  /** where the hurricane is, seen from (x, z): distance in metres, compass bearing in degrees (0 = north, 90 = east) and its name */
  hurricaneInfo(x, z) {
    const h = this.hurricane;
    if (!h) return null;
    const dx = h.x - x, dz = h.z - z;
    const dist = Math.hypot(dx, dz);
    const bearing = (Math.atan2(dx, -dz) * RAD + 360) % 360;
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const short = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const k = Math.round(bearing / 45) % 8;
    return { dist, bearing, name: names[k], short: short[k], eyeDist: Math.max(0, dist - h.eye), inEye: dist < h.eye, inside: dist < h.R };
  }

  /** a label and a marker so you can always find the hurricane: distance and bearing, a ring on it when it is in view, an arrow at the screen edge when it is not */
  drawHurricaneMarker(ctx, w, h) {
    const hur = this.hurricane, cp = this.world.camPos;
    if (!hur || !cp || typeof App === 'undefined') return;
    const info = this.hurricaneInfo(cp.x, cp.z);
    const km = (m) => (m >= 10000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1)) + ' km';
    ctx.save();
    // the label (top left, under the mode name)
    const text = info.inEye ? 'HURRICANE: you are in the EYE' : info.inside ? `HURRICANE  ${km(info.dist)} ${info.short} (${Math.round(info.bearing)}°)  ·  you are in its outer bands` : `HURRICANE  ${km(info.dist)} ${info.short} (${Math.round(info.bearing)}°)`;
    ctx.font = '700 14px "Segoe UI", system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(8,24,40,0.7)';
    roundRect(ctx, 16, 44, tw + 42, 28, 14);
    ctx.fill();
    ctx.fillStyle = '#7fd8ff';
    ctx.beginPath(); ctx.arc(32, 58, 7, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#0a2236'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(32, 58, 3, 0, TAU); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#d6f2ff';
    ctx.fillText(text, 46, 59);

    // the marker on the eye
    const cam = App.camera;
    const v = this._mv || (this._mv = new THREE.Vector3());
    v.set(hur.x, 4500, hur.z).project(cam);
    let sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    const behind = v.z > 1;
    const onScreen = !behind && v.x > -0.92 && v.x < 0.92 && v.y > -0.88 && v.y < 0.88;
    ctx.strokeStyle = '#7fd8ff'; ctx.fillStyle = '#7fd8ff';
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 5;
    if (onScreen && !info.inEye) {
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 22, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, TAU); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`EYE  ${km(info.dist)}`, sx, sy + 40);
    } else if (!info.inEye) {
      // off screen: an arrow on the edge pointing the way to turn
      let dx = v.x, dy = -v.y;
      if (behind) { dx = -dx; dy = -dy; }
      if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) dy = 1;
      const ang = Math.atan2(dy, dx), mx = w / 2 - 70, my = h / 2 - 90;
      const k = Math.min(Math.abs(mx / (Math.cos(ang) || 1e-6)), Math.abs(my / (Math.sin(ang) || 1e-6)));
      const ex = w / 2 + Math.cos(ang) * k, ey = h / 2 + Math.sin(ang) * k;
      ctx.translate(ex, ey);
      ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -12); ctx.lineTo(-4, 0); ctx.lineTo(-10, 12); ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
      ctx.textAlign = 'center';
      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`HURRICANE ${km(info.dist)}`, 0, 26);
    }
    ctx.restore();
  }

  /** rain on the glass and the flash of lightning, drawn over the 3D view */
  /** the sun's glow and light shafts through the cloud, and a rainbow when you are near rain with the sun behind you */
  drawSky(ctx, w, h) {
    const app = typeof App !== 'undefined' ? App : null;
    if (!app || !app.camera) return;
    const cam = app.camera, cp = this.world.camPos || cam.position, sd = SUN_DIR;
    const fwd = _rainF.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const dot = fwd.x * sd.x + fwd.y * sd.y + fwd.z * sd.z;
    const cov = this.world.clouds ? this.world.clouds.coverage : 0.5;
    const dark = 1 - Math.min(1, this.I * 1.4 + (this.mode === 'storm' ? 0.55 : 0) + this.snow * 0.35); // no direct sun in a storm
    if (dot > 0.4 && dark > 0.05 && sd.y > 0.02) {
      const q = _rainV.set(cp.x + sd.x * 5000, cp.y + sd.y * 5000, cp.z + sd.z * 5000).project(cam);
      if (q.z < 1) {
        const sx = (q.x * 0.5 + 0.5) * w, sy = (-q.y * 0.5 + 0.5) * h, g = smoothstep(0.4, 0.97, dot) * dark;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.9);
        gr.addColorStop(0, `rgba(255,226,170,${0.3 * g})`); gr.addColorStop(0.12, `rgba(255,200,130,${0.13 * g})`); gr.addColorStop(1, 'rgba(255,190,120,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
        const sa = g * (0.25 + 0.75 * Math.min(1, cov * 1.2)) * 0.075; // shafts need cloud to cast them
        if (sa > 0.004) {
          const gr2 = ctx.createRadialGradient(sx, sy, 0, sx, sy, w * 0.9);
          gr2.addColorStop(0, `rgba(255,236,200,${sa * 1.6})`); gr2.addColorStop(1, 'rgba(255,236,200,0)');
          ctx.fillStyle = gr2;
          const t = app.time || 0, L = w * 1.2;
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * TAU + Math.sin(t * 0.07 + i * 1.9) * 0.08, wd = 0.011 + 0.02 * ((i * 37) % 7) / 7;
            ctx.beginPath(); ctx.moveTo(sx, sy);
            ctx.lineTo(sx + Math.cos(a - wd) * L, sy + Math.sin(a - wd) * L);
            ctx.lineTo(sx + Math.cos(a + wd) * L, sy + Math.sin(a + wd) * L);
            ctx.closePath(); ctx.fill();
          }
        }
        ctx.restore();
      }
    }
    // a rainbow: opposite the sun, 42 degrees from the shadow of your head, when you are near (not in) the rain
    if (sd.y > 0.04 && sd.y < 0.78) {
      let near = 0;
      if (this.mode === 'storm') for (const c of this.cells) near = Math.max(near, 1 - smoothstep(c.r * 1.1, c.r * 3.4, Math.hypot(c.x - cp.x, c.z - cp.z)));
      if (this.hurricane) near = Math.max(near, 0.8 * (1 - smoothstep(this.hurricane.R * 1.1, this.hurricane.R * 2.4, Math.hypot(cp.x - this.hurricane.x, cp.z - this.hurricane.z))));
      near *= 1 - Math.min(1, this.I * 3);
      if (near > 0.03) {
        const anti = _rainA.set(-sd.x, -sd.y, -sd.z), u = _rainU.crossVectors(anti, _rainUp).normalize(), v = _rainW.crossVectors(anti, u);
        const cols = ['255,60,60', '255,150,40', '255,235,70', '90,230,90', '70,170,255', '110,90,255', '190,90,255'];
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.lineWidth = Math.max(2, h * 0.011);
        for (let j = 0; j < cols.length; j++) {
          const ang = (41.4 - j * 0.45) * DEG, ca = Math.cos(ang), sa = Math.sin(ang);
          ctx.strokeStyle = `rgba(${cols[j]},${0.3 * near})`;
          ctx.beginPath();
          let pen = false;
          for (let k = 0; k <= 56; k++) {
            const ph = (k / 56) * TAU, cph = Math.cos(ph), sph = Math.sin(ph);
            const dx = anti.x * ca + (u.x * cph + v.x * sph) * sa, dy = anti.y * ca + (u.y * cph + v.y * sph) * sa, dz = anti.z * ca + (u.z * cph + v.z * sph) * sa;
            if (dy < 0.02) { pen = false; continue; } // only above the horizon
            const p = _rainV.set(cp.x + dx * 3000, cp.y + dy * 3000, cp.z + dz * 3000).project(cam);
            if (p.z >= 1) { pen = false; continue; }
            const px = (p.x * 0.5 + 0.5) * w, py = (-p.y * 0.5 + 0.5) * h;
            if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  /** falling snow: flakes of different depth drift down and stream away from the point you are flying towards */
  drawSnow(ctx, w, h) {
    const app = typeof App !== 'undefined' ? App : null;
    const s = this.snow, fl = this.flakes, t = app ? app.time : 0;
    const dt = Math.min(0.05, (t - (this._ot || t)) || 0.016); this._ot = t;
    ctx.save();
    const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95); // a soft pale vignette: the air is full of snow
    g.addColorStop(0, 'rgba(235,240,250,0)'); g.addColorStop(1, `rgba(235,240,250,${0.2 * s})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    let vx = w / 2, vy = h * 0.45, spd = 80;
    const pl = app && app.mode && app.mode.player;
    if (pl && pl.vdir && app.camera) {
      const cp = this.world.camPos || app.camera.position;
      const q = _rainV.set(cp.x + pl.vdir.x * 800, cp.y + pl.vdir.y * 800, cp.z + pl.vdir.z * 800).project(app.camera);
      if (q.z < 1) { vx = (q.x * 0.5 + 0.5) * w; vy = (-q.y * 0.5 + 0.5) * h; }
      spd = pl.speed || 80;
    }
    const k = clamp(spd / 320, 0.04, 1.3);
    while (fl.length < 150) fl.push({ x: Math.random() * w, y: Math.random() * h, z: 0.25 + Math.random() * 0.75, ph: Math.random() * TAU });
    ctx.fillStyle = 'rgba(250,252,255,1)';
    for (const f of fl) {
      const dx = f.x - vx, dy = f.y - vy;
      f.x += dx * k * f.z * 0.9 * dt + Math.sin(t * 1.3 + f.ph) * 8 * f.z * dt;
      f.y += dy * k * f.z * 0.9 * dt + (22 + 46 * f.z) * dt;
      if (f.x < -10 || f.x > w + 10 || f.y > h + 10 || f.y < -10) { f.x = Math.random() * w; f.y = -5; f.z = 0.25 + Math.random() * 0.75; }
      ctx.globalAlpha = (0.35 + 0.55 * f.z) * s;
      ctx.beginPath(); ctx.arc(f.x, f.y, 0.8 + 2.4 * f.z, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  drawOverlay(ctx, w, h) {
    const rainy = this.mode === 'storm' || !!this.hurricane;
    this.drawSky(ctx, w, h);
    if (this.snow > 0.02) this.drawSnow(ctx, w, h);
    if (!rainy) return;
    const I = this.I;
    if (I > 0.03) {
      ctx.save();
      ctx.fillStyle = `rgba(22,28,38,${0.32 * I})`;
      ctx.fillRect(0, 0, w, h);
      // the rain streaks past: from the point you are flying towards, outwards, longer the faster you go (a hurricane drives it sideways)
      const cp = this.world.camPos || { x: 0, y: 0, z: 0 };
      const app = typeof App !== 'undefined' ? App : null, pl = app && app.mode && app.mode.player;
      let vx = w / 2, vy = h * 0.45, spd = 60;
      if (pl && pl.vdir && app.camera) {
        const q = _rainV.set(cp.x + pl.vdir.x * 800, cp.y + pl.vdir.y * 800, cp.z + pl.vdir.z * 800).project(app.camera);
        if (q.z < 1) { vx = (q.x * 0.5 + 0.5) * w; vy = (-q.y * 0.5 + 0.5) * h; }
        spd = pl.speed || 60;
      }
      const wind = this.hurricane && this.hurricane.intensityAt(cp.x, cp.y, cp.z) > 0.2 ? 1 : 0;
      const k = clamp(spd / 260, 0.15, 1.6);
      ctx.strokeStyle = `rgba(214,226,242,${0.12 + 0.2 * I})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const n = Math.round(200 * I);
      for (let i = 0; i < n; i++) {
        const x = Math.random() * w, y = Math.random() * h;
        let dx = x - vx, dy = y - vy;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl; dy /= dl;
        const len = (6 + Math.random() * 15) * (0.45 + 0.55 * k) * (0.3 + Math.min(1, dl / (w * 0.5)));
        ctx.moveTo(x, y);
        ctx.lineTo(x - dx * len + (wind ? len * 0.5 : 0), y - dy * len + len * 0.22); // (the streak trails back towards where it came from; gravity pulls it a little down)
      }
      ctx.stroke();
      // drops that land on the glass, bead, and run down it
      const dr = this.drops || (this.drops = []);
      if (dr.length < 46 && Math.random() < I * 0.9) dr.push({ x: Math.random() * w, y: Math.random() * h * 0.9, r: 2 + Math.random() * 5, life: 3 + Math.random() * 4, age: 0, v: 8 + Math.random() * 30 });
      ctx.fillStyle = 'rgba(205,220,240,0.11)';
      ctx.strokeStyle = 'rgba(235,244,255,0.34)';
      ctx.lineWidth = 1;
      for (let i = dr.length - 1; i >= 0; i--) {
        const d = dr[i];
        d.age += 0.016; d.y += d.v * 0.016 * (d.age > d.life * 0.4 ? 1 : 0.1); d.x += Math.sin(d.age * 3 + d.r) * 0.15;
        if (d.age > d.life) { dr.splice(i, 1); continue; }
        const f = Math.min(1, (d.life - d.age) / 0.8) * Math.min(1, d.age / 0.2);
        ctx.globalAlpha = f;
        ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r * 0.8, d.r * 1.15, 0, 0, TAU); ctx.fill(); ctx.stroke();
        if (d.age > d.life * 0.4) { ctx.beginPath(); ctx.moveTo(d.x, d.y - d.r); ctx.lineTo(d.x, d.y - d.r - d.v * 0.5); ctx.stroke(); } // the wet trail it leaves
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    if (this.flash > 0.02 && this.boltPos) {
      // the whole sky lights up, more if the strike was close
      const cam = this.world.camPos || { x: 0, y: 0, z: 0 };
      const d = Math.hypot(this.boltPos.x - cam.x, this.boltPos.z - cam.z);
      const a = 0.5 * this.flash * (1 - smoothstep(1500, 14000, d)) + 0.12 * this.flash;
      ctx.fillStyle = `rgba(215,228,255,${a})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.hurricane) this.drawHurricaneMarker(ctx, w, h);
  }
}

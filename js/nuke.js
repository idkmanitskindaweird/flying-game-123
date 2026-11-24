'use strict';
/* ==========================================================================
   nuke.js - drop a nuclear bomb from any aircraft, anywhere (N in Free Flight / Dogfight).
   The bomb falls on a ballistic path and goes off on contact with the ground, a building or the sea:
     * a blinding white flash (stronger if you face it) and a glare that lights the whole scene,
     * a simulated fireball, a rising stem and a mushroom cloud that rolls over itself and spreads,
     * a shock wave that travels outwards (a shell you can see) and a dust skirt along the ground,
     * everything in the city goes down as the wave reaches it: next to the burst flattened to the foundations,
       further out the upper floors fail and the rest is scorched,
     * aircraft caught inside the blast radius are destroyed; further out the wave shakes the camera,
     * the sound reaches you after the time it takes sound to travel.
   ========================================================================== */

const NUKE = { RCITY: 3200, LETHAL: 2600, SHAKE: 6500, WAVE0: 500, WAVEV: 340, CAP_H: 3300, CAP_R: 1150 };

/** radius (m) of the shock wave t seconds after the burst: a fast start that slows to the speed of sound */
function nukeWaveR(t) { return NUKE.WAVEV * t + NUKE.WAVE0 * (1 - Math.exp(-t / 0.6)); }

function makeBombMesh() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x4d5538 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x25281d });
  const yellow = new THREE.MeshLambertMaterial({ color: 0xd9b52a });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 2.8, 18), mat);
  body.rotation.x = PI / 2;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.62, 18, 12), mat);
  nose.scale.set(1, 1, 1.5); nose.position.z = -1.4;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.3, 1.4, 14), mat);
  tail.rotation.x = PI / 2; tail.position.z = 2.05;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.3, 18), yellow);
  band.rotation.x = PI / 2; band.position.z = -0.6;
  g.add(body, nose, tail, band);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.9), dark);
    fin.position.set(0, 0, 2.5);
    const holder = new THREE.Group();
    holder.rotation.z = (i * PI) / 2 + PI / 4;
    fin.position.set(0, 0.8, 2.5);
    holder.add(fin);
    g.add(holder);
  }
  g.scale.setScalar(1.4);
  return g;
}

class NukeSystem {
  constructor(app) {
    this.app = app;
    this.bombs = [];
    this.blasts = [];
    this.group = new THREE.Group();
    app.scene.add(this.group);
    this.flashEl = null;
    this.cool = 0;
    this.cam = null; // the bomb camera: follows the bomb down, then watches the blast from a distance
    this._v = new THREE.Vector3();
  }

  ensureFlashEl() {
    if (this.flashEl) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:40;';
    document.body.appendChild(el);
    this.flashEl = el;
  }

  /** release a bomb from an aircraft: it keeps the aircraft's velocity and falls */
  drop(jet) {
    if (this.cool > 0) return false;
    this.cool = 1.5;
    const pos = jet.pos.clone().addScaledVector(jet.getUp(new THREE.Vector3()), -(2.2 + (jet.spec ? jet.spec.scale * 1.5 : 0)));
    const b = this.spawn(pos, jet.vel);
    this.cam = { phase: 'bomb', t: 0 };
    return b;
  }

  /** put a bomb in the air at pos with velocity vel (also used by the Replay Lab to show a recorded drop) */
  spawn(pos, vel) {
    const mesh = makeBombMesh();
    const b = { pos: pos.clone(), vel: vel.clone(), mesh, t: 0, roll: 0 };
    mesh.position.copy(b.pos);
    this.group.add(mesh);
    this.bombs.push(b);
    return b;
  }

  clear() {
    this.cam = null;
    for (const b of this.bombs) this.group.remove(b.mesh);
    this.bombs.length = 0;
    for (const d of this.blasts) this.dropBlast(d);
    this.blasts.length = 0;
    if (this.flashEl) this.flashEl.style.opacity = '0';
    if (this.app.mode && this.app.mode.crashFx) this.app.mode.crashFx.dustK = 1;
  }

  dropBlast(d) {
    if (d.shell) { this.group.remove(d.shell); d.shell.geometry.dispose(); d.shell.material.dispose(); d.shell = null; }
  }

  /**
   * Where would a bomb released right now land? The same fall as the real bomb, stepped forward until it meets the ground or a
   * building. Returns {x, y, z, t} (t: seconds of fall) or null. Used by the HUD bombsight.
   */
  predict(jet) {
    const w = this.app.world, city = w.city, dt = 0.1;
    const p = this._pp || (this._pp = new THREE.Vector3()), v = this._pv || (this._pv = new THREE.Vector3()), q = this._pq || (this._pq = { x: 0, y: 0, z: 0, t: 0 });
    p.copy(jet.pos).addScaledVector(jet.getUp(_nukeUp), -(2.2 + (jet.spec ? jet.spec.scale * 1.5 : 0)));
    v.copy(jet.vel);
    for (let i = 0; i < 480; i++) {
      v.y -= 11 * dt;
      v.multiplyScalar(Math.exp(-0.004 * dt));
      const x0 = p.x, y0 = p.y, z0 = p.z;
      p.addScaledVector(v, dt);
      const g = w.surfaceAt(p.x, p.z);
      if (p.y <= g + 0.5 || (city && city.hit(p.x, p.y, p.z))) {
        // refine inside the last step
        let lo = 0, hi = 1;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2, mx = x0 + (p.x - x0) * mid, my = y0 + (p.y - y0) * mid, mz = z0 + (p.z - z0) * mid;
          if (my <= w.surfaceAt(mx, mz) + 0.5 || (city && city.hit(mx, my, mz))) hi = mid; else lo = mid;
        }
        q.x = x0 + (p.x - x0) * hi; q.y = y0 + (p.y - y0) * hi; q.z = z0 + (p.z - z0) * hi; q.t = (i + hi) * dt;
        return q;
      }
    }
    return null;
  }

  /** the bomb camera. returns true if it has taken over the camera this frame (the owner then skips its own camera) */
  applyCamera(cam, dt) {
    const c = this.cam;
    if (!c) return false;
    c.t += dt;
    if (c.phase === 'bomb') {
      const b = this.bombs[this.bombs.length - 1];
      if (!b) { this.cam = null; return false; }
      const d = this._v.copy(b.vel).normalize();
      cam.position.copy(b.pos).addScaledVector(d, -24).add(_nukeUp.set(0, 7, 0));
      cam.lookAt(b.pos.x + d.x * 8, b.pos.y + d.y * 8, b.pos.z + d.z * 8);
    } else {
      if (c.t > 16) { this.cam = null; return false; }
      cam.position.set(c.x, c.y, c.z);
      cam.lookAt(c.tx, c.ty, c.tz);
    }
    if (Math.abs(cam.fov - 58) > 0.05) { cam.fov = 58; cam.updateProjectionMatrix(); }
    return true;
  }

  /** is a bomb in the air / a blast still going? (the owner uses this to keep updating) */
  get active() { return this.bombs.length > 0 || this.blasts.length > 0; }

  update(dt, mode) {
    this.cool = Math.max(0, this.cool - dt);
    const app = this.app, w = app.world;
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t += dt;
      b.vel.y -= 11 * dt;
      b.vel.multiplyScalar(Math.exp(-0.004 * dt));
      const n = Math.max(1, Math.ceil((b.vel.length() * dt) / 12));
      let hit = false;
      for (let k = 0; k < n && !hit; k++) {
        b.pos.addScaledVector(b.vel, dt / n);
        const g = w.surfaceAt(b.pos.x, b.pos.z);
        if (b.pos.y <= g + 0.5 || (w.city && w.city.hit(b.pos.x, b.pos.y, b.pos.z))) hit = true;
      }
      b.mesh.position.copy(b.pos);
      this._v.copy(b.vel).normalize();
      b.mesh.quaternion.setFromUnitVectors(_nukeFwd, this._v);
      b.roll += dt * 3;
      b.mesh.rotateZ(b.roll);
      if (hit) {
        this.group.remove(b.mesh);
        this.bombs.splice(i, 1);
        this.detonate(b.pos.x, b.pos.y, b.pos.z, mode);
        if (this.cam) { // watch it from a safe distance: 4 km out along the line the bomb came in on, up at 700 m
          const dir = this._v.copy(b.vel); dir.y = 0;
          if (dir.lengthSq() < 1) dir.set(0, 0, -1);
          dir.normalize();
          const gh = w.surfaceAt(b.pos.x, b.pos.z);
          this.cam = { phase: 'blast', t: 0, x: b.pos.x - dir.x * 4200, z: b.pos.z - dir.z * 4200, ty: gh + 1100, tx: b.pos.x, tz: b.pos.z, gy: gh };
          this.cam.y = Math.max(w.surfaceAt(this.cam.x, this.cam.z) + 60, gh + 700);
        }
      }
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      if (!this.stepBlast(this.blasts[i], dt, mode)) { this.dropBlast(this.blasts[i]); this.blasts.splice(i, 1); }
    }
    if (mode && mode.crashFx) mode.crashFx.dustK = this.blasts.length ? 0.28 : 1;
    if (!this.blasts.length && this.flashEl && this.flashEl.style.opacity !== '0') this.flashEl.style.opacity = '0';
  }

  detonate(x, y, z, mode) {
    const app = this.app, w = app.world, fx = app.fx;
    const gh = w.surfaceAt(x, z), water = w.heightAt(x, z) < 0.5;
    const D = { x, y: Math.max(y, gh + 2), z, gh, water, t: 0, acc: { stem: 0, cap: 0, surge: 0 }, pHit: false, shaken: 0, flashPeak: 0 };
    // the shock wave you can see: a hemisphere that grows
    const geo = new THREE.SphereGeometry(1, 32, 12, 0, TAU, 0, PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    D.shell = new THREE.Mesh(geo, mat);
    D.shell.position.set(x, gh, z);
    D.shell.scale.setScalar(1);
    D.shell.frustumCulled = false;
    D.shell.renderOrder = 5;
    this.group.add(D.shell);
    // the flash, the fireball and the glare
    fx.glow(x, D.y + 160, z, 0, 0, 0, 0.7, 1400, 3600, 1, 0.97, 0.88, 1, 0);
    fx.fireball(x, D.y + 8, z, 26, false);
    for (let i = 0; i < 8; i++) fx.glow(x + rand(-160, 160), D.y + rand(60, 420), z + rand(-160, 160), rand(-70, 70), rand(10, 60), rand(-70, 70), rand(2.5, 6), rand(380, 520), rand(780, 1100), 1, rand(0.55, 0.8), rand(0.18, 0.35), rand(0.5, 0.8), 0.5);
    w.flash(x, D.y + 200, z, 40);
    // the crater and the scorched ground
    if (mode && mode.crashFx) {
      if (!water) mode.crashFx.scorch(x, gh, z, _nukeZero, 14, -1);
      if (w.city && w.city.inside(x, z, NUKE.RCITY)) w.city.blast(x, z, NUKE.RCITY, 4.6, mode.crashFx, undefined, 0, { cap: clamp(CRASH_Q.blast[crashLevel()] * 8, 500, 2600), speed: 380 });
    }
    if (water) { // a column of water and a great ring of spray
      for (let i = 0; i < 40; i++) {
        const a = rand(0, TAU), sp = rand(80, 260);
        fx.puff(x + Math.cos(a) * 40, 4, z + Math.sin(a) * 40, Math.cos(a) * sp, rand(10, 90), Math.sin(a) * sp, rand(6, 12), 40, 220, rand(0.7, 0.9), 0.6, 0.5, 0);
      }
    }
    // the glare in your eyes
    const cam = app.camera, d = cam.position.distanceTo(this._v.set(x, D.y, z));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), to = new THREE.Vector3(x - cam.position.x, D.y - cam.position.y, z - cam.position.z).normalize();
    D.flashPeak = clamp(16000 / (d + 800), 0, 1) * (0.55 + 0.45 * Math.max(0, fwd.dot(to)));
    this.ensureFlashEl();
    // the sound arrives with the shock wave
    const au = app.audio;
    if (au && au.ok) {
      const cp = cam.position, rel = { x: x - cp.x, y: D.y - cp.y, z: z - cp.z };
      const dist = Math.hypot(rel.x, rel.y, rel.z), delay = clamp(dist / SPEED_OF_SOUND, 0.15, 30);
      const rel2 = { x: rel.x * 0.15, y: rel.y * 0.15, z: rel.z * 0.15 }; // (heard as a vast sound from that direction, not a tiny far one)
      au.later(() => au.nuke(rel2), delay * 1000);
    }
    this.blasts.push(D);
    if (mode && mode.pushMsg) mode.pushMsg('DETONATION', `${Math.round(d)} m away`, HUD_WARN, 26, 2.6);
  }

  stepBlast(D, dt, mode) {
    const app = this.app, fx = app.fx, t = (D.t += dt), q = fx.budget;
    const r = nukeWaveR(t);
    if (D.shell) {
      D.shell.scale.setScalar(Math.max(1, r));
      D.shell.material.opacity = 0.3 * clamp(1 - t / 8, 0, 1) * clamp(1 - r / 4800, 0, 1);
    }
    // --- the cloud ---------------------------------------------------------------------------------------
    const Hc = D.gh + NUKE.CAP_H * (1 - Math.exp(-t / 9)), Rc = NUKE.CAP_R * (1 - Math.exp(-t / 7)) + 120;
    const hot = clamp(1 - t / 16, 0, 1); // the cap glows orange while it is hot, then turns to grey-brown
    if (t < 40) {
      D.acc.stem += dt * 16 * q; D.acc.cap += dt * 28 * q; D.acc.surge += dt * 18 * q * (t < 10 ? 1 : 0);
      const c0 = [0, 0, 0, 0], c1 = [0, 0, 0, 0];
      while (D.acc.stem >= 1) { // the stem: a column of dust and smoke drawn up behind the cap
        D.acc.stem--;
        const u = Math.random(), a = rand(0, TAU), rr = (90 + 150 * Math.min(1, t / 10)) * Math.sqrt(Math.random());
        const sh = rand(0.28, 0.42) + 0.2 * hot;
        c0[0] = sh * (1 + 0.5 * hot); c0[1] = sh * (1 + 0.1 * hot); c0[2] = sh * (1 - 0.2 * hot); c0[3] = 0.5;
        c1[0] = 0.4; c1[1] = 0.37; c1[2] = 0.35; c1[3] = 0;
        this.puffBig(D.x + Math.cos(a) * rr, D.gh + 30 + u * Math.max(60, Hc - D.gh - Rc * 0.5), D.z + Math.sin(a) * rr, rand(-6, 6), rand(25, 70) * (1 - 0.6 * u) , rand(-6, 6), rand(260, 420), rand(26, 40), c0, c1, 0.2);
      }
      while (D.acc.cap >= 1) { // the cap: a torus of hot gas that rolls over itself
        D.acc.cap--;
        const a = rand(0, TAU), ph = rand(0, TAU), tube = Rc * 0.42;
        const ring = Rc * 0.72 + tube * Math.cos(ph);
        const sh = rand(0.38, 0.52);
        c0[0] = sh + 0.55 * hot; c0[1] = sh * (1 - 0.2 * hot) + 0.25 * hot; c0[2] = sh * (1 - 0.55 * hot); c0[3] = 0.5;
        c1[0] = 0.5; c1[1] = 0.45; c1[2] = 0.42; c1[3] = 0;
        const out = Math.sin(ph) > 0 ? 1 : -0.5; // rolls outwards over the top, inwards underneath
        this.puffBig(D.x + Math.cos(a) * ring, Hc + tube * 0.75 * Math.sin(ph), D.z + Math.sin(a) * ring, Math.cos(a) * out * 14, rand(-3, 8), Math.sin(a) * out * 14, rand(Rc * 0.5, Rc * 0.85), rand(26, 42), c0, c1, 0.1);
      }
      while (D.acc.surge >= 1) { // the dust skirt thrown out along the ground behind the shock wave
        D.acc.surge--;
        const a = rand(0, TAU), rs = r * rand(0.35, 0.65) * 0.7;
        c0[0] = 0.55; c0[1] = 0.5; c0[2] = 0.44; c0[3] = 0.3;
        c1[0] = 0.5; c1[1] = 0.46; c1[2] = 0.42; c1[3] = 0;
        this.puffBig(D.x + Math.cos(a) * rs, D.gh + rand(15, 60), D.z + Math.sin(a) * rs, Math.cos(a) * 24, rand(2, 10), Math.sin(a) * 24, rand(220, 380), rand(12, 18), c0, c1, 0.4);
      }
      if (t < 9 && Math.random() < dt * 5) fx.glow(D.x + rand(-1, 1) * Rc * 0.4, Hc + rand(-1, 1) * Rc * 0.3, D.z + rand(-1, 1) * Rc * 0.4, 0, 8, 0, rand(2, 4), Rc * 0.7, Rc * 1.1, 1, rand(0.5, 0.75), rand(0.15, 0.3), 0.4 * hot, 0.4); // the glow inside the cap
    }
    // --- what it does to aircraft ------------------------------------------------------------------------
    if (mode && mode.player && mode.player.alive && mode.state === 'playing' && !D.pHit) {
      const p = mode.player.pos, d = Math.hypot(p.x - D.x, p.y - D.y, p.z - D.z);
      if (r >= d || (t > 0.2 && d < 1200)) { // (inside 1.2 km the thermal pulse kills at once, even if you are outrunning the blast)
        D.pHit = true;
        if (d < NUKE.LETHAL) mode.playerDie('NUCLEAR BLAST');
        else if (d < NUKE.SHAKE) { D.shaken = 4; D.shakeK = clamp(2.2 * (1 - (d - NUKE.LETHAL) / (NUKE.SHAKE - NUKE.LETHAL)) + 0.25, 0.25, 2.2); mode.hitFlash = 1; }
        if (d < NUKE.LETHAL && mode.crashFx) { mode.shake = 2.2; }
      }
    }
    if (mode && !mode.player && mode.obs && !D.oHit) { // watching a replay: you feel the wave when it reaches where you stand
      const d = Math.hypot(mode.obs.x - D.x, mode.obs.y - D.y, mode.obs.z - D.z);
      if (r >= d) {
        D.oHit = true;
        if (d < NUKE.SHAKE) { D.shaken = 4; D.shakeK = clamp(2.2 * (1 - d / NUKE.SHAKE) + 0.25, 0.25, 2.2); }
      }
    }
    if (mode && mode.enemies) {
      for (const en of mode.enemies) {
        const j = en.jet;
        if (!j.alive || j.dying) continue;
        if (r >= Math.hypot(j.pos.x - D.x, j.pos.y - D.y, j.pos.z - D.z) && Math.hypot(j.pos.x - D.x, j.pos.y - D.y, j.pos.z - D.z) < NUKE.LETHAL + 600) { j.killedByPlayer = true; mode.finishEnemy(en, false); }
      }
    }
    if (D.shaken > 0) { D.shaken -= dt; if (mode) mode.shake = Math.max(mode.shake || 0, D.shakeK * clamp(D.shaken / 2, 0.2, 1)); }
    // --- the flash fades ---------------------------------------------------------------------------------
    if (this.flashEl) {
      const a = D.flashPeak * (t < 0.1 ? t / 0.1 : Math.exp(-(t - 0.1) / 1.5));
      if (a > 0.004) { this.flashEl.style.opacity = String(Math.min(1, a)); this.flashEl.style.background = t < 0.5 ? '#fff' : '#fff4e0'; }
      else this.flashEl.style.opacity = '0';
    }
    return t < 42;
  }

  /** a big slow smoke/dust billow in the big-cloud pool */
  puffBig(x, y, z, vx, vy, vz, size, life, c0, c1, drag) {
    const fx = this.app.fx, p = fx._p, v = fx._v;
    p.x = x; p.y = y; p.z = z; v.x = vx; v.y = vy; v.z = vz;
    fx.big.emit(p, v, life, size * 0.8, size, c0, c1, drag, 0.2);
  }
}

const _nukeFwd = new THREE.Vector3(0, 0, -1);
const _nukeZero = new THREE.Vector3();
const _nukeUp = new THREE.Vector3();

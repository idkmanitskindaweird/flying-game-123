'use strict';
const REC_DT = 1 / 30; // flight recordings are sampled 30 times a second
function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
/* ==========================================================================
   combat.js - Dogfight / Free Flight mode
   Player jet, enemy AI, cannon, homing missiles, waves, damage, camera, audio
   ========================================================================== */

const _ca = new THREE.Vector3();
const _hbp = new THREE.Vector3();
const _hbv = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _cc = new THREE.Vector3();
const _cd = new THREE.Vector3();
const _ce = new THREE.Vector3();
const _cq = new THREE.Quaternion();

const BULLET_SPEED = 950;

function segSphere(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz || 1e-9;
  let u = ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / l2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const qx = ax + dx * u - cx, qy = ay + dy * u - cy, qz = az + dz * u - cz;
  return qx * qx + qy * qy + qz * qz < r * r;
}

/* ---------- tracer bullets -------------------------------------------------------- */

class BulletSystem {
  constructor(scene) {
    const n = (this.n = 360);
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.team = new Uint8Array(n);
    this.dmg = new Float32Array(n);
    this.lp = new Float32Array(n * 6);
    this.lc = new Float32Array(n * 6);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.lp, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.lc, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.mesh = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    // bright bullet heads so tracers stay visible at range
    this.hp = new Float32Array(n * 3);
    const pgeo = new THREE.BufferGeometry();
    this.hpAttr = new THREE.BufferAttribute(this.hp, 3).setUsage(THREE.DynamicDrawUsage);
    pgeo.setAttribute('position', this.hpAttr);
    pgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.heads = new THREE.Points(
      pgeo,
      new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, color: 0xffe9a8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    this.heads.frustumCulled = false;
    this.heads.renderOrder = 5;
    scene.add(this.heads);
    this.next = 0;
    this.clear();
  }

  clear() {
    this.life.fill(0);
    this.lp.fill(0);
    for (let i = 0; i < this.n; i++) this.hp[i * 3 + 1] = -1e5;
    this.posAttr.needsUpdate = true;
    this.hpAttr.needsUpdate = true;
  }

  fire(x, y, z, vx, vy, vz, team, dmg) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = 1.8;
    this.team[i] = team;
    this.dmg[i] = dmg;
    const c = this.lc, k = i * 6;
    if (team === 0) { c[k] = 0.45; c[k + 1] = 0.3; c[k + 2] = 0.05; c[k + 3] = 1.0; c[k + 4] = 0.95; c[k + 5] = 0.55; }
    else { c[k] = 0.5; c[k + 1] = 0.08; c[k + 2] = 0.04; c[k + 3] = 1.0; c[k + 4] = 0.4; c[k + 5] = 0.28; }
    this.colAttr.needsUpdate = true;
  }

  /** hit(i, ax,ay,az, bx,by,bz, team, dmg) -> true if the bullet is consumed */
  update(dt, world, hit) {
    const p = this.p, v = this.v, lp = this.lp;
    for (let i = 0; i < this.n; i++) {
      const k = i * 6;
      if (this.life[i] <= 0) {
        if (lp[k + 1] !== -1e5) { lp[k] = lp[k + 3] = 0; lp[k + 1] = lp[k + 4] = -1e5; lp[k + 2] = lp[k + 5] = 0; this.hp[i * 3 + 1] = -1e5; }
        continue;
      }
      const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
      const bx = ax + v[i * 3] * dt, by = ay + v[i * 3 + 1] * dt, bz = az + v[i * 3 + 2] * dt;
      this.life[i] -= dt;
      let dead = this.life[i] <= 0;
      if (!dead && hit(i, ax, ay, az, bx, by, bz, this.team[i], this.dmg[i])) dead = true;
      if (!dead && by < world.surfaceAt(bx, bz)) dead = true;
      p[i * 3] = bx; p[i * 3 + 1] = by; p[i * 3 + 2] = bz;
      if (dead) { this.life[i] = 0; lp[k + 1] = lp[k + 4] = -1e5; this.hp[i * 3 + 1] = -1e5; continue; }
      lp[k] = bx - v[i * 3] * 0.075; lp[k + 1] = by - v[i * 3 + 1] * 0.075; lp[k + 2] = bz - v[i * 3 + 2] * 0.075;
      lp[k + 3] = bx; lp[k + 4] = by; lp[k + 5] = bz;
      this.hp[i * 3] = bx; this.hp[i * 3 + 1] = by; this.hp[i * 3 + 2] = bz;
    }
    this.posAttr.needsUpdate = true;
    this.hpAttr.needsUpdate = true;
  }
}

/* ---------- missile visual -------------------------------------------------------- */

let _missileGeo = null;
function makeMissileMesh() {
  if (!_missileGeo) {
    const body = new THREE.CylinderGeometry(0.24, 0.24, 3.4, 8);
    body.rotateX(PI / 2);
    paintGeometry(body, 0xeef0f2);
    const nose = new THREE.ConeGeometry(0.24, 0.9, 8);
    nose.rotateX(-PI / 2);
    nose.translate(0, 0, -2.1);
    paintGeometry(nose, 0xd24a3a);
    const fins = [];
    for (let k = 0; k < 4; k++) {
      const f = new THREE.BoxGeometry(0.05, 0.9, 0.7);
      f.translate(0, 0.55, 1.4);
      f.rotateZ(k * PI / 2);
      paintGeometry(f, 0x9aa3ad);
      fins.push(f);
    }
    _missileGeo = mergeGeometries([body, nose, ...fins]);
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(_missileGeo, new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40 })));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  glow.position.z = 2.3;
  glow.scale.set(6, 6, 1);
  g.add(glow);
  g.userData.glow = glow;
  return g;
}

/* ==========================================================================
   FlyMode
   ========================================================================== */

class FlyMode {
  constructor(app) {
    this.app = app;
    this.player = null;
    this.enemies = [];
    this.missileList = [];
    this.bullets = null;
    this.kind = 'dogfight';
    this.state = 'idle';
    this.camMode = 'chase';
    this.camQ = new THREE.Quaternion();
    this.alive = true;
    this.msgs = [];
    this.stick = { x: 0, y: 0 };
    this.prevKeys = {};
  }

  /* ----- lifecycle ----------------------------------------------------------------- */

  enter(kind) {
    const app = this.app;
    this.kind = kind;
    this.cleanup();
    if (!this.bullets) this.bullets = new BulletSystem(app.scene);
    if (!this.crashFx) this.crashFx = new CrashFX(app);
    this.crashFx.clear();
    if (!this.nukes && typeof NukeSystem !== 'undefined') this.nukes = new NukeSystem(app);
    if (this.nukes) this.nukes.clear();
    if (app.world.city) app.world.city.reset(); // a new game: the city is rebuilt
    this.bullets.clear();
    app.fx.clear();
    this.state = 'playing';
    this.alive = true;
    this.score = 0; this.kills = 0; this.wave = 0;
    this.missiles = 6;
    this.missileReload = 0;
    this.gunT = 0; this.gunSide = 1;
    this.target = null; this.userTarget = null; this.lockT = 0; this.lockNeed = 1.1; this.lockBeepT = 0;
    this.hitFlash = 0; this.shake = 0;
    this.warnPullUp = false; this.alarmT = 0;
    this.msgs.length = 0;
    this.hintT = 11;
    this.waveTimer = 3.5;
    this.waveActive = false;
    this.deadT = 0; this.orbit = 0;
    this.deathPos = new THREE.Vector3();
    this.timeAlive = 0;
    this.stick.x = this.stick.y = 0;
    this.camMode = 'chase';
    this.gameOverShown = false;
    app.camera.near = 2;
    app.camera.updateProjectionMatrix();

    const ptype = kind === 'free' && PLANES[Settings.data.plane] ? Settings.data.plane : 'fighter'; // Free Flight can be flown in a big transport
    const heavy = ptype !== 'fighter';
    this.heavy = heavy;
    const p = new Aircraft({ palette: heavy ? 'c17' : 'steel', type: ptype, team: 'player', name: 'YOU' });
    p.assist = Settings.data.assist;
    const gy = app.world.surfaceAt(-1200, 140);
    if (kind === 'free') p.place(0, gy + 470, 1100, 0, heavy ? PLANES[ptype].startSpeed : 210 * FIGHTER_SPEED); // fly north: the city is straight ahead
    else p.place(-1200, gy + 520, 140, -PI / 2, 210 * FIGHTER_SPEED);
    p.resetHistory(app.time);
    p.syncVisual(app.time);
    app.scene.add(p.group);
    this.player = p;
    this.playerShadow = new JetShadow(app.scene);
    this.camQ.copy(p.quat);
    app.world.prebuild(p.pos);
    this.updateCamera(0.016, true);

    if (app.audio && app.audio.ok) {
      app.audio.clearVoices();
      app.audio.dopplerK = 1;
      this.own = app.audio.createOwnEngine();
    }
    if (kind === 'free') {
      this.waveTimer = 1e9;
      this.pushMsg('FREE FLIGHT', 'Cruise the coast and mountains. Press V for the cockpit view.', HUD_COL, 26, 4);
    }
  }

  exit() {
    this.cleanup();
  }

  /* ----- flight recorder (watched later in the Replay lab) ---------------------------- */

  startRecording() {
    if (!this.player || this.state !== 'playing') return;
    this.recOn = true;
    this.recAcc = 0;
    this.recD = [];
    this.recWings = [];
    this.recNukes = [];
    this.recN = 0;
    this.recKind = this.player.heavy ? this.player.spec.key : 'fighter';
    this.recSample();
    this.app.toast('● RECORDING — press G to stop', 2600);
  }

  recSample() {
    const p = this.player, d = this.recD;
    d.push(p.pos.x, p.pos.y, p.pos.z, p.quat.x, p.quat.y, p.quat.z, p.quat.w, p.vel.x, p.vel.y, p.vel.z, p.speed, p.throttle, p.ab);
    this.recN++;
  }

  stopRecording(silent, crash) {
    if (!this.recOn) return;
    if (crash && this.player) this.recSample(); // the very last frame: the moment of impact
    this.recOn = false;
    if (this.recN >= 60) {
      App.recording = { dt: REC_DT, n: this.recN, d: this.recD, kind: this.recKind, crash: crash || null, wings: this.recWings || [], nukes: this.recNukes || [] };
      if (typeof ReplayStore !== 'undefined') ReplayStore.saveLatest(App.recording);
      if (App.refreshReplayUI) App.refreshReplayUI();
      if (!silent) this.app.toast(`Recording saved (${fmtTime((this.recN - 1) * REC_DT)}) — watch it from the menu: Replay`, 4200);
    } else if (!silent) this.app.toast('Recording too short (needs 2 s) — discarded');
    this.recD = null;
  }

  cleanup() {
    const app = this.app;
    this.stopRecording(true);
    if (this.nukes) this.nukes.clear();
    if (this.crashFx) this.crashFx.clear();
    if (this.streaks) { app.scene.remove(this.streaks.lines); this.streaks.lines.geometry.dispose(); this.streaks.lines.material.dispose(); this.streaks = null; }
    if (this.player) {
      app.scene.remove(this.player.group);
      this.player = null;
    }
    if (this.playerShadow) { this.playerShadow.dispose(app.scene); this.playerShadow = null; }
    for (const en of this.enemies) this.removeEnemy(en);
    this.enemies.length = 0;
    for (const m of this.missileList) this.removeMissile(m);
    this.missileList.length = 0;
    if (this.bullets) this.bullets.clear();
    if (this.own) { this.own.stop(); this.own = null; }
    if (app.audio && app.audio.ok) app.audio.clearVoices();
  }

  removeEnemy(en) {
    const app = this.app;
    app.scene.remove(en.jet.group);
    en.shadow.dispose(app.scene);
    if (en.voice && app.audio) app.audio.removeVoice(en.voice);
  }

  removeMissile(m) {
    m.gone = true;
    this.app.scene.remove(m.mesh);
  }

  /* ----- messages ------------------------------------------------------------------- */

  pushMsg(text, sub, color, size, life) {
    this.msgs.push({ text, color: color || HUD_COL, size: size || 24, life: life || 2.5, t: 0 });
    if (sub) this.msgs.push({ text: sub, color: 'rgba(225,238,255,0.92)', size: 15, life: life || 2.5, t: 0 });
    while (this.msgs.length > 5) this.msgs.shift();
  }

  /* ----- input ------------------------------------------------------------------------- */

  readInput(dt) {
    const k = this.app.keys;
    const inv = Settings.data.invert ? -1 : 1;
    let pitch = 0, roll = 0, yaw = 0, boost = false, brake = false, fire = false;
    if (k.KeyS || k.ArrowDown) pitch += 1 * inv;
    if (k.KeyW || k.ArrowUp) pitch -= 1 * inv;
    if (k.KeyD || k.ArrowRight) roll += 1;
    if (k.KeyA || k.ArrowLeft) roll -= 1;
    if (k.KeyE) yaw += 1;
    if (k.KeyQ) yaw -= 1;
    if (k.ShiftLeft || k.ShiftRight) boost = true;
    if (k.KeyX || k.KeyZ) brake = true;
    if (k.Space) fire = true;
    const mouse = this.app.mouse;
    if (Settings.data.mouse && mouse.locked) {
      this.stick.x = clamp(this.stick.x + mouse.dx * 0.0028, -1, 1);
      this.stick.y = clamp(this.stick.y + mouse.dy * 0.0028 * inv, -1, 1);
      this.stick.x *= Math.exp(-dt * 0.9);
      this.stick.y *= Math.exp(-dt * 0.9);
      roll += this.stick.x * 1.3;
      pitch += this.stick.y * 1.3;
    }
    if (mouse.buttons & 1 && (mouse.locked || !Settings.data.mouse)) fire = true;
    // gamepad
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
        roll += dz(gp.axes[0] || 0);
        pitch += dz(gp.axes[1] || 0) * inv;
        yaw += dz(gp.axes[2] || 0);
        if (gp.buttons[7] && gp.buttons[7].value > 0.4) boost = true;
        if (gp.buttons[6] && gp.buttons[6].value > 0.4) brake = true;
        if (gp.buttons[0] && gp.buttons[0].pressed) fire = true;
        const b1 = gp.buttons[1] && gp.buttons[1].pressed;
        if (b1 && !this._padB1) this.fireMissile();
        this._padB1 = b1;
        break;
      }
    } catch (e) { /* gamepad API unavailable */ }
    const inp = this.player.input;
    inp.pitch = clamp(pitch, -1, 1);
    inp.roll = clamp(roll, -1, 1);
    inp.yaw = clamp(yaw, -1, 1);
    inp.boost = boost;
    inp.brake = brake;
    return fire;
  }

  onKey(code, down, e) {
    if (!down || this.state !== 'playing') return false;
    switch (code) {
      case 'KeyV':
        if (this.nukes) this.nukes.cam = null;
        this.camMode = this.camMode === 'chase' ? 'cockpit' : 'chase';
        this.app.camera.near = this.camMode === 'cockpit' ? 0.4 : 2;
        this.app.camera.updateProjectionMatrix();
        return true;
      case 'KeyF':
        this.fireMissile();
        return true;
      case 'KeyN':
        if (this.nukes && this.nukes.cam) this.nukes.cam = null; // N again: back to the cockpit
        else this.dropNuke();
        return true;
      case 'KeyG':
        if (this.recOn) this.stopRecording(); else this.startRecording();
        return true;
      case 'KeyR':
      case 'Tab':
        this.cycleTarget();
        return true;
    }
    return false;
  }

  onMouseDown(e) {
    if (this.state !== 'playing') return;
    if (Settings.data.mouse && !document.pointerLockElement) {
      const c = document.getElementById('gl');
      if (c.requestPointerLock) c.requestPointerLock();
      return;
    }
    if (e.button === 2) this.fireMissile();
  }

  cycleTarget() {
    const p = this.player;
    const list = this.enemies.filter((e) => e.jet.alive && !e.jet.dying).sort((a, b) => a.jet.pos.distanceTo(p.pos) - b.jet.pos.distanceTo(p.pos));
    if (!list.length) return;
    let idx = list.findIndex((e) => e.jet === this.target);
    idx = (idx + 1) % list.length;
    this.userTarget = this.target = list[idx].jet;
    this.lockT = 0;
    if (this.app.audio && this.app.audio.ok) this.app.audio.beep(1100, 0.06, 0.12);
  }

  /* ----- weapons ------------------------------------------------------------------------- */

  /** Predicted aim point for the cannon against a target. */
  leadPoint(target, shooter) {
    const to = _ca.copy(target.pos).sub(shooter.pos);
    const vr = _cb.copy(target.vel).sub(shooter.vel);
    const a = vr.dot(vr) - BULLET_SPEED * BULLET_SPEED;
    const b = 2 * to.dot(vr);
    const c = to.dot(to);
    let t;
    if (Math.abs(a) < 1e-3) t = -c / b;
    else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const s = Math.sqrt(disc);
      const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a);
      t = Math.min(t1 > 0 ? t1 : 1e9, t2 > 0 ? t2 : 1e9);
    }
    if (!(t > 0) || t > 3) return null;
    // world point the nose must point at: shooter position + (to + vr*t) = target position + vr*t
    return new THREE.Vector3().copy(target.pos).addScaledVector(vr, t);
  }

  fireGun(jet, team, dmg, spreadDeg) {
    const f = jet.getForward(_cc);
    const r = jet.getRight(_cd);
    this.gunSide = -this.gunSide;
    const sp = spreadDeg * DEG;
    const dir = _ce.copy(f);
    dir.addScaledVector(r, rand(-sp, sp)).addScaledVector(jet.getUp(_ca), rand(-sp, sp)).normalize();
    const px = jet.pos.x + f.x * 7 + r.x * 1.9 * this.gunSide;
    const py = jet.pos.y + f.y * 7 + r.y * 1.9 * this.gunSide - 0.3;
    const pz = jet.pos.z + f.z * 7 + r.z * 1.9 * this.gunSide;
    this.bullets.fire(px, py, pz, jet.vel.x + dir.x * BULLET_SPEED, jet.vel.y + dir.y * BULLET_SPEED, jet.vel.z + dir.z * BULLET_SPEED, team, dmg);
  }

  /** N: drop a nuclear bomb, from any aircraft, anywhere */
  dropNuke() {
    const p = this.player;
    if (this.state !== 'playing' || !p || !p.alive || !this.nukes) return;
    const bomb = this.nukes.drop(p);
    if (bomb) {
      if (this.recOn && this.recNukes) this.recNukes.push({ t: (this.recN - 1) * REC_DT, x: bomb.pos.x, y: bomb.pos.y, z: bomb.pos.z, vx: bomb.vel.x, vy: bomb.vel.y, vz: bomb.vel.z }); // so the replay shows it
      this.pushMsg('NUKE AWAY', 'N: back to your aircraft  ·  lethal radius 2.6 km', HUD_WARN, 26, 3.6);
      if (this.app.audio && this.app.audio.ok) this.app.audio.missileLaunch();
    }
  }

  fireMissile() {
    const p = this.player;
    if (this.state !== 'playing' || !p || !p.alive) return;
    if (p.heavy) { this.pushMsg('NO WEAPONS', 'This aircraft is unarmed', HUD_BAD, 22, 1.5); return; }
    const audio = this.app.audio;
    if (this.missiles <= 0) { this.pushMsg('NO MISSILES', null, HUD_BAD, 22, 1.5); return; }
    const locked = this.target && this.target.alive && !this.target.dying && this.lockT >= this.lockNeed;
    this.missiles--;
    const f = p.getForward(new THREE.Vector3());
    const side = this.missiles % 2 ? 1 : -1;
    const pos = p.pos.clone().addScaledVector(p.getRight(_ca), side * 3.2).addScaledVector(p.getUp(_cb), -1.2).addScaledVector(f, 1);
    const m = this.makeMissile(pos, f, p.vel, locked ? this.target : null, 0);
    if (!locked) this.pushMsg('NO LOCK — missile fired dumb', null, HUD_WARN, 16, 1.4);
    if (audio && audio.ok) audio.missileLaunch();
  }

  makeMissile(pos, dir, vel, target, team) {
    const app = this.app;
    const m = {
      pos: pos.clone(), dir: dir.clone().normalize(), speed: Math.max(vel.length(), 120) + 40 * FIGHTER_SPEED, target, team,
      t: 0, life: 11, history: new TrackHistory(1024), mesh: makeMissileMesh(), gone: false, vel: new THREE.Vector3(), smokeAcc: 0,
    };
    m.vel.copy(m.dir).multiplyScalar(m.speed);
    m.history.reset(app.time, m.pos, m.vel);
    m.mesh.position.copy(m.pos);
    app.scene.add(m.mesh);
    this.missileList.push(m);
    if (app.audio && app.audio.ok) m.voice = app.audio.addMissileVoice(m);
    return m;
  }

  stepMissile(m, dt) {
    const app = this.app;
    m.t += dt;
    const burning = m.t < 5.5;
    m.speed = burning ? Math.min(m.speed + 230 * FIGHTER_SPEED * dt, 720 * FIGHTER_SPEED) : Math.max(m.speed - 30 * dt, 260 * FIGHTER_SPEED);
    const tg = m.target;
    let detonate = false;
    if (tg && tg.alive && !tg.dying) {
      const to = _ca.copy(tg.pos).sub(m.pos);
      const range = to.length();
      const tgo = clamp(range / m.speed, 0, 3);
      const aim = _cb.copy(tg.pos).addScaledVector(tg.vel, tgo).sub(m.pos).normalize();
      const ang = Math.acos(clamp(m.dir.dot(aim), -1, 1));
      const maxTurn = (burning ? 1.25 : 0.7) * dt;
      if (ang > 1e-4) m.dir.lerp(aim, Math.min(1, maxTurn / ang)).normalize();
      if (range < 24) detonate = true;
      if (ang > 2.4 && m.t > 0.8) m.target = null;
    } else if (tg) m.target = null;
    m.vel.copy(m.dir).multiplyScalar(m.speed);
    m.pos.addScaledVector(m.vel, dt);
    m.mesh.position.copy(m.pos);
    _cq.setFromUnitVectors(_cc.set(0, 0, -1), m.dir);
    m.mesh.quaternion.copy(_cq);
    m.history.push(app.time, m.pos.x, m.pos.y, m.pos.z);
    // trail
    m.smokeAcc += dt;
    while (m.smokeAcc > 0.018) {
      m.smokeAcc -= 0.018;
      const tail = _cd.copy(m.dir).multiplyScalar(-2.2).add(m.pos);
      app.fx.puff(tail.x, tail.y, tail.z, rand(-1, 1), rand(-1, 1), rand(-1, 1), 3.4, 2.4, 11, 0.9, burning ? 0.55 : 0.3, 0.5, 0.1);
      if (burning) app.fx.glow(tail.x, tail.y, tail.z, 0, 0, 0, 0.14, 3.2, 1, 1, 0.75, 0.3, 0.9, 0);
    }
    m.mesh.userData.glow.visible = burning;
    if (m.pos.y < app.world.surfaceAt(m.pos.x, m.pos.z) || m.t > m.life) detonate = true;
    // proximity to any valid target when unguided
    if (!detonate) {
      const list = m.team === 0 ? this.enemies.map((e) => e.jet) : [this.player];
      for (const j of list) {
        if (!j || !j.alive || j.dying) continue;
        if (j.pos.distanceToSquared(m.pos) < 20 * 20) { detonate = true; break; }
      }
    }
    if (detonate) this.detonateMissile(m);
  }

  detonateMissile(m) {
    m.dead = true;
    this.explode(m.pos, 0.55, m.vel);
    const list = m.team === 0 ? this.enemies.map((e) => e.jet) : [this.player];
    for (const j of list) {
      if (!j || !j.alive || j.dying) continue;
      const d = j.pos.distanceTo(m.pos);
      if (d < 58) this.damageJet(j, 150 * (1 - d / 60), m.team === 0);
    }
  }

  explode(pos, scale, vel) {
    const app = this.app;
    app.fx.explosion(pos.x, pos.y, pos.z, scale, vel ? vel.x * 0.3 : 0, vel ? vel.y * 0.3 : 0, vel ? vel.z * 0.3 : 0);
    const cp = app.camera.position;
    const d = Math.max(30, pos.distanceTo(cp));
    this.shake = Math.min(1.6, this.shake + (900 * scale) / (d * d) * 120);
    if (app.audio && app.audio.ok) app.audio.explosion({ x: pos.x - cp.x, y: pos.y - cp.y, z: pos.z - cp.z }, scale > 1);
  }

  /* ----- damage ------------------------------------------------------------------------------- */

  damageJet(j, amt, byPlayer) {
    if (!j.alive || j.dying) return;
    j.hp -= amt;
    if (j === this.player) {
      this.hitFlash = 1;
      this.shake = Math.min(1.2, this.shake + 0.5);
      if (this.app.audio && this.app.audio.ok) this.app.audio.hit();
      if (j.hp <= 0) this.playerDie('SHOT DOWN');
      return;
    }
    if (j.hp <= 0) {
      j.dying = true;
      j.dyingT = 0;
      j.killedByPlayer = byPlayer;
    }
  }

  /** A realistic crash for any aircraft (player or enemy): the airframe breaks up, burns and scatters. */
  crashAircraft(jet, air) {
    const app = this.app;
    jet.group.visible = false;
    this.crashFx.crash(jet, { air });
    const cp = app.camera.position;
    const d = Math.max(40, jet.pos.distanceTo(cp));
    const big = jet.heavy ? 2.2 : 1.3;
    this.shake = Math.min(2.2, this.shake + (1400 * big) / (d * d) * 120 + (jet === this.player ? 0.6 : 0));
  }

  playerDie(reason) {
    const p = this.player;
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.stopRecording(false, { air: reason === 'SHOT DOWN' || reason === 'MID-AIR COLLISION' || reason === 'NUCLEAR BLAST' });
    this.deadT = 0;
    p.alive = false;
    p.group.visible = false;
    this.deathPos.copy(p.pos);
    this.crashAircraft(p, reason === 'SHOT DOWN' || reason === 'MID-AIR COLLISION' || reason === 'NUCLEAR BLAST');
    this.deathR = p.heavy ? 240 + p.spec.scale * 70 : 75; // stand well back from a big fireball
    this.deathReason = reason;
    if (this.own) this.own.stop();
    this.own = null;
    this.alive = false;
  }

  finishEnemy(en, byGround) {
    const j = en.jet;
    j.alive = false;
    this.crashAircraft(j, !byGround);
    if (j.killedByPlayer) {
      this.kills++;
      const pts = 100 + 20 * this.wave;
      this.score += pts;
      this.pushMsg('SPLASH ONE!', `+${pts}`, '#ffd24a', 28, 2.0);
      if (this.app.audio && this.app.audio.ok) this.app.audio.beep(1500, 0.12, 0.14);
    }
  }

  /* ----- enemies ----------------------------------------------------------------------------------- */

  spawnWave() {
    this.wave++;
    const n = Math.min(1 + Math.ceil(this.wave * 0.9), 6);
    const skill = clamp(0.28 + 0.11 * this.wave, 0.28, 1);
    for (let i = 0; i < n; i++) this.spawnEnemy(skill);
    this.waveActive = true;
    this.pushMsg(`WAVE ${this.wave}`, `${n} bandit${n > 1 ? 's' : ''} inbound`, '#ffd24a', 30, 3);
  }

  spawnEnemy(skill) {
    const app = this.app, p = this.player;
    const ang = rand(0, TAU), dist = rand(3600, 5200);
    const x = p.pos.x + Math.cos(ang) * dist, z = p.pos.z + Math.sin(ang) * dist;
    const g = app.world.surfaceAt(x, z);
    const y = clamp(p.pos.y + rand(-250, 350), g + 320, 3800);
    const jet = new Aircraft({ palette: 'enemy', team: 'enemy', name: 'BANDIT' });
    jet.assist = false;
    jet.gMul = 0.78 + 0.18 * skill;
    jet.maxHp = jet.hp = 90 + 9 * this.wave;
    const dx = p.pos.x - x, dz = p.pos.z - z;
    jet.place(x, y, z, Math.atan2(-dx, -dz), 230 * FIGHTER_SPEED);
    jet.resetHistory(app.time);
    jet.syncVisual(app.time);
    app.scene.add(jet.group);
    const en = {
      jet, skill, state: 'attack', stateT: 0, burst: 0, burstGap: rand(0.5, 2), shadow: new JetShadow(app.scene),
      voice: app.audio && app.audio.ok ? app.audio.addJetVoice(jet) : null, spread: rand(1.0, 2.4) * (1.5 - skill), voiceT: 0,
    };
    this.enemies.push(en);
  }

  /** which part of this aircraft (if any) is touching the ground, the sea or a building: 'body' | 'wingL' | 'wingR' | null */
  hitCheck(jet) {
    if (typeof hitboxesFor === 'undefined') { // (an old cached page without hitbox.js: fall back to a simple centre-point check rather than failing every frame)
      if (!App._staleWarned && !App._warming) { // (not during the start-up warm-up, which runs behind the loading screen)
        App._staleWarned = true;
        // first try to fix it by itself: reload once with a unique address, which cannot come from the cache
        let tried = false;
        try { tried = sessionStorage.getItem('selfHeal') === '1'; sessionStorage.setItem('selfHeal', '1'); } catch (e) { tried = true; }
        if (!tried && typeof location !== 'undefined' && location.protocol !== 'file:') { location.replace(location.pathname + '?r=' + Date.now()); return null; }
        // it did not help: say what is wrong (was hitbox.js asked for, and did it fail?)
        let why = 'collision.js was not requested by this page (an old copy of the page)';
        try {
          const got = performance.getEntriesByType('resource').some((r) => /collision\.js/.test(r.name));
          const errs = (window.__errs || []).filter((x) => /collision|LOAD FAILED/.test(x));
          if (got) why = errs.length ? 'collision.js failed: ' + errs[0] : 'collision.js was loaded but did not run';
        } catch (e) { /* ignore */ }
        this.app.toast('Wings and nukes will not work properly: ' + why + '. Press Ctrl+F5.', 15000);
      }
      const w0 = this.app.world;
      return jet.pos.y < w0.surfaceAt(jet.pos.x, jet.pos.z) + (jet.heavy ? jet.spec.crash * jet.spec.scale : 4) || w0.cityHit(jet.pos.x, jet.pos.y, jet.pos.z) ? 'body' : null;
    }
    const w = this.app.world, city = w.city, q = jet.quat, cur = jet.pos, boxes = hitboxesFor(jet), lost = jet.lost;
    const prev = jet._hbPrev || (jet._hbPrev = new THREE.Vector3().copy(cur));
    const dist = prev.distanceTo(cur);
    // an aircraft at 1000 m/s moves 30+ m a frame: sweep from the old position to the new one so it cannot skip through a wall
    const steps = dist > 0.5 && dist < 600 ? Math.min(90, Math.ceil(dist / 1.2)) : 1;
    let res = null;
    for (let k = 1; k <= steps && !res; k++) {
      const f = steps === 1 ? 1 : k / steps;
      _hbp.lerpVectors(prev, cur, f);
      const gc = w.surfaceAt(_hbp.x, _hbp.z);
      // the whole aircraft is well clear of the ground and outside the city: nothing to test at this step
      if (_hbp.y - boxes.rb > gc + 1.7 * boxes.rb + 2 && !(city && city.inside(_hbp.x, _hbp.z, boxes.rb + 20) && _hbp.y < gc + 470)) continue;
      for (const g of boxes.groups) {
        _hbv.set(g.x, g.y, g.z).applyQuaternion(q).add(_hbp);
        const gs = w.surfaceAt(_hbv.x, _hbv.z);
        const terrainNear = _hbv.y - g.r < gs + 1.7 * g.r + 2;
        const cityNear = !terrainNear && city && _hbv.y < gs + 470 && city.inside(_hbv.x, _hbv.z, g.r + 10) && (g.r > 12 || city.sphereHit(_hbv.x, _hbv.y, _hbv.z, g.r));
        if (!terrainNear && !cityNear) continue;
        for (const i of g.idx) {
          const s = boxes[i];
          if (lost && lost[s.part]) continue; // a wing that is gone cannot hit anything
          _hbv.set(s.x, s.y, s.z).applyQuaternion(q).add(_hbp);
          if (_hbv.y - s.r < w.surfaceAt(_hbv.x, _hbv.z) || (city && city.sphereHit(_hbv.x, _hbv.y, _hbv.z, s.r))) { res = s.part; break; }
        }
        if (res) break;
      }
      if (res) cur.copy(_hbp); // the impact happens where it first touched, not where it would have ended up
    }
    prev.copy(cur);
    return res;
  }

  /** a wing hits something and is torn off: the aircraft survives, but spins out of control */
  loseWing(jet, side) {
    const key = side < 0 ? 'wingL' : 'wingR';
    if (jet.lost && jet.lost[key]) return;
    jet.lost = jet.lost || {};
    jet.lost[key] = true;
    jet.hideWing(side);
    this.crashFx.wingOff(jet, side);
    if (jet === this.player && this.recOn && this.recWings) this.recWings.push({ t: (this.recN - 1) * REC_DT, side }); // so the replay shows it
    jet.dying = true; jet.dyingT = 0; jet.dyingRoll = side; // an aircraft with one wing rolls towards the missing side
    if (jet === this.player) {
      this.hitFlash = 1; this.shake = Math.min(2, this.shake + 1.1);
      this.pushMsg(side < 0 ? 'LEFT WING LOST' : 'RIGHT WING LOST', 'no control', HUD_BAD, 30, 3.2);
    }
  }

  stepEnemy(en, dt) {
    const app = this.app, p = this.player, j = en.jet, inp = j.input;
    if (j.dying) {
      j.step(dt);
      const g = app.world.surfaceAt(j.pos.x, j.pos.z);
      if (j.dyingT > 2.4 || j.pos.y < g + 6) this.finishEnemy(en, j.pos.y < g + 6);
      return;
    }
    const to = _ca.copy(p.pos).sub(j.pos);
    const dist = Math.max(to.length(), 1);
    const dir = _cb.copy(to).multiplyScalar(1 / dist);
    const fwd = j.getForward(_cc);
    const ang = Math.acos(clamp(fwd.dot(dir), -1, 1));
    en.stateT -= dt;
    const playerAlive = p.alive && this.state === 'playing';

    // threat check: is the player lining up on me?
    let threat = false;
    if (playerAlive && dist < 1200) {
      const pf = p.getForward(_cd);
      const toMe = _ce.copy(j.pos).sub(p.pos).multiplyScalar(1 / dist);
      threat = pf.dot(toMe) > 0.94;
    }
    if (en.state === 'attack' && threat && Math.random() < dt * 0.9 * (0.3 + en.skill)) { en.state = 'evade'; en.stateT = rand(1.3, 2.6); en.evadeDir = Math.random() < 0.5 ? 1 : -1; }
    if (en.state === 'evade' && en.stateT <= 0) en.state = 'attack';
    if (en.state === 'attack' && dist < 140 && ang > 1.2) { en.state = 'extend'; en.stateT = rand(1.8, 3.0); }
    if (en.state === 'extend' && en.stateT <= 0) en.state = 'attack';

    // terrain avoidance
    const ahead = _cd.copy(j.vdir).multiplyScalar(j.speed * 2.4).add(j.pos);
    const floor = app.world.surfaceAt(ahead.x, ahead.z) + 130;
    const here = app.world.surfaceAt(j.pos.x, j.pos.z) + 110;
    let avoid = ahead.y < floor || j.pos.y < here;
    if (j.pos.y > 4200) avoid = false;

    if (avoid) {
      const right = j.getRight(_ce);
      inp.roll = clamp(right.y * 3.5, -1, 1);
      inp.pitch = (Math.abs(right.y) < 0.5) ? 1 : 0.35;
      inp.yaw = 0;
      inp.boost = false;
      inp.throttle = 0.9;
    } else if (en.state === 'evade') {
      inp.roll = en.evadeDir;
      inp.pitch = 0.9;
      inp.yaw = 0;
      inp.boost = true;
      inp.throttle = 1;
    } else if (en.state === 'extend') {
      const right = j.getRight(_ce);
      inp.roll = clamp(right.y * 3, -1, 1);
      inp.pitch = j.vdir.y > 0.2 ? 0 : 0.25;
      inp.boost = true;
      inp.throttle = 1;
    } else {
      // lead pursuit
      const tl = clamp(dist / 800, 0, 1.6) * (0.5 + 0.5 * en.skill);
      const aim = _cd.copy(p.pos).addScaledVector(p.vel, tl).sub(j.pos).normalize();
      const q = _cq.copy(j.quat).invert();
      const lv = _ce.copy(aim).applyQuaternion(q); // local direction, forward = -z
      const rollErr = Math.atan2(lv.x, lv.y);
      inp.roll = clamp(rollErr * 2.4, -1, 1);
      const off = Math.acos(clamp(-lv.z, -1, 1));
      const pull = Math.max(0, Math.cos(clamp(rollErr, -1.4, 1.4)));
      inp.pitch = clamp(off * 3.2, 0, 1) * pull;
      if (Math.abs(lv.x) < 0.1 && lv.y < 0 && -lv.z > 0.9) inp.pitch = -0.15; // target below: nose down
      inp.yaw = clamp(lv.x * 1.2, -1, 1) * 0.25;
      inp.boost = dist > 2600;
      inp.throttle = dist > 1500 ? 1 : dist < 380 && off < 0.5 ? 0.3 : 0.7;
      inp.brake = dist < 260 && off < 0.4;
    }

    // fire
    if (playerAlive && en.state === 'attack') {
      en.burstGap -= dt;
      const gate = (2.0 + 2.6 * (1 - en.skill)) * DEG;
      if (en.burst <= 0 && en.burstGap <= 0 && dist < 950 && ang < gate + 1.5 * DEG && !avoid) {
        en.burst = rand(0.5, 1.1);
        en.burstGap = rand(1.2, 2.8) - en.skill * 0.6;
      }
    }
    if (en.burst > 0) {
      en.burst -= dt;
      en.gunT = (en.gunT || 0) - dt;
      while (en.gunT <= 0) {
        en.gunT += 1 / 11;
        // aim slightly ahead of the player
        this.fireGun(j, 1, 1.8 + this.wave * 0.1, en.spread);
        if (app.audio && app.audio.ok && Math.random() < 0.4) {
          const cp = app.camera.position;
          app.audio.enemyGun({ x: j.pos.x - cp.x, y: j.pos.y - cp.y, z: j.pos.z - cp.z });
        }
      }
    }
    j.step(dt);
    // light damage smoke
    j.damageSmoke = j.hp < 38 ? clamp(1 - j.hp / 38, 0.15, 1) : 0;
  }

  /* ----- main update ----------------------------------------------------------------------------------- */

  update(dt) {
    const app = this.app, p = this.player, t = app.time;
    if (!p) return;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 1.6);
    this.shake *= Math.exp(-dt * 4.5);
    this.hintT = Math.max(0, this.hintT - dt);
    for (const m of this.msgs) m.t += dt;
    this.msgs = this.msgs.filter((m) => m.t < m.life);
    if (this.crashFx) this.crashFx.update(dt);
    if (this.nukes) this.nukes.update(dt, this);

    if (this.state === 'playing') {
      this.timeAlive += dt;
      const fire = this.readInput(dt);
      p.turb = app.world.weather ? app.world.weather.turbAt(p.pos) : 0; // thunderstorms buffet the aircraft
      const wnd = app.world.weather && app.world.weather.windAt(p.pos); // a hurricane's winds carry it around the eye
      if (wnd) { p.pos.x += wnd.x * dt; p.pos.z += wnd.z * dt; }
      p.step(dt);
      if (this.recOn) {
        this.recAcc += dt;
        while (this.recAcc >= REC_DT) { this.recAcc -= REC_DT; this.recSample(); }
        if (this.recN > 30 * 60 * 20) this.stopRecording();
      }
      // weapons
      this.gunT -= dt;
      if (fire && p.alive && !p.heavy) {
        let n = 0;
        while (this.gunT <= 0 && n < 4) {
          this.gunT += 1 / 17;
          n++;
          this.fireGun(p, 0, 13, 0.55);
          if (app.audio && app.audio.ok && (this._shotN = (this._shotN || 0) + 1) % 2 === 0) app.audio.gunShot();
        }
      } else this.gunT = Math.max(this.gunT, -0.02);
      this.missileReload += dt;
      if (this.missileReload > 9) { this.missileReload = 0; if (this.missiles < 6) this.missiles++; }
      this.updateTargeting(dt);

      // collision: every part of the aircraft has hit spheres. Body into ground / building = crash; a wing = the wing is torn off
      const g = app.world.surfaceAt(p.pos.x, p.pos.z);
      const hit = this.hitCheck(p);
      if (hit === 'body') this.playerDie('CRASHED');
      else if (hit) this.loseWing(p, hit === 'wingL' ? -1 : 1);
      // pull-up warning
      const ah = _ca.copy(p.vdir).multiplyScalar(p.speed * 2.2).add(p.pos);
      const clear = ah.y - app.world.surfaceAt(ah.x, ah.z);
      this.warnPullUp = (clear < 45 && p.vdir.y < 0.12) || (p.pos.y - g < 70 && p.vel.y < -25);
      if (this.warnPullUp || p.stalled) {
        this.alarmT -= dt;
        if (this.alarmT <= 0) { this.alarmT = 0.7; if (app.audio && app.audio.ok) app.audio.alarm(); }
      }
    } else if (this.state === 'dead') {
      this.deadT += dt;
      if (this.deadT > 3.6 && !this.gameOverShown) this.showGameOver();
    }

    // wave logic
    if (this.kind === 'dogfight' && this.state === 'playing') {
      const alive = this.enemies.filter((e) => e.jet.alive).length;
      if (this.waveActive && alive === 0) {
        this.waveActive = false;
        this.waveTimer = 5;
        this.score += 250;
        p.hp = Math.min(p.maxHp, p.hp + 30);
        this.missiles = Math.min(6, this.missiles + 2);
        this.pushMsg('WAVE CLEARED', '+250  ·  hull repaired  ·  missiles resupplied', '#9fe7ff', 26, 3.2);
      }
      if (!this.waveActive) {
        this.waveTimer -= dt;
        if (this.waveTimer <= 0) this.spawnWave();
      }
    }

    // enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const en = this.enemies[i];
      if (!en.jet.alive) { this.removeEnemy(en); this.enemies.splice(i, 1); continue; }
      if (this.state === 'dead') { en.jet.input.roll = 0; en.jet.input.pitch = 0; }
      this.stepEnemy(en, dt);
      if (en.jet.alive && !en.jet.dying) {
        const eh = this.hitCheck(en.jet);
        if (eh === 'body') this.finishEnemy(en, true);
        else if (eh) this.loseWing(en.jet, eh === 'wingL' ? -1 : 1);
      }
      // collision with the player
      if (this.state === 'playing' && p.alive && !en.jet.dying && en.jet.pos.distanceToSquared(p.pos) < 15 * 15) {
        en.jet.hp = 0; en.jet.dying = true; en.jet.dyingT = 3; en.jet.killedByPlayer = false;
        this.playerDie('MID-AIR COLLISION');
      }
    }

    // bullets
    this.bullets.update(dt, app.world, (i, ax, ay, az, bx, by, bz, team, dmg) => {
      if (team === 0) {
        for (const en of this.enemies) {
          const j = en.jet;
          if (!j.alive || j.dying) continue;
          if (segSphere(ax, ay, az, bx, by, bz, j.pos.x, j.pos.y, j.pos.z, 11)) {
            this.damageJet(j, dmg, true);
            app.fx.glow(bx, by, bz, rand(-8, 8), rand(-8, 8), rand(-8, 8), 0.25, 3, 6, 1, 0.8, 0.3, 1, 2);
            if (j.hp > 0 && app.audio && app.audio.ok && Math.random() < 0.5) {
              const cp = app.camera.position;
              app.audio.noiseBurst({ type: 'white', dur: 0.05, gain: 0.12, f0: 2600, filt: 'bandpass', rel: { x: bx - cp.x, y: by - cp.y, z: bz - cp.z } });
            }
            return true;
          }
        }
      } else if (this.state === 'playing' && p.alive) {
        if (segSphere(ax, ay, az, bx, by, bz, p.pos.x, p.pos.y, p.pos.z, 9)) {
          this.damageJet(p, dmg, false);
          return true;
        }
      }
      return false;
    });

    // missiles
    for (let i = this.missileList.length - 1; i >= 0; i--) {
      const m = this.missileList[i];
      this.stepMissile(m, dt);
      if (m.dead) { this.removeMissile(m); this.missileList.splice(i, 1); }
    }

    // histories & visuals
    const all = [p, ...this.enemies.map((e) => e.jet)];
    for (const j of all) {
      if (!j.alive) continue;
      j.recordHistory(t);
      j.syncVisual(t);
      j.emitTrail(app.fx, dt);
    }
    if (p.alive) this.playerShadow.update(p, app.world);
    else this.playerShadow.mesh.visible = false;
    for (const en of this.enemies) en.shadow.update(en.jet, app.world);

    this.updateCamera(dt, false);

    // audio
    if (app.audio && app.audio.ok) {
      const cam = app.camera;
      const fwd = _ca.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const up = _cb.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const vel = p.alive ? p.vel : { x: 0, y: 0, z: 0 };
      app.audio.update(t, { x: cam.position.x, y: cam.position.y, z: cam.position.z, vx: vel.x, vy: vel.y, vz: vel.z }, fwd, up);
      if (this.own && p.alive) this.own.update(p.throttle, p.ab, p.speed, this.camMode === 'cockpit', 1, p.heavy ? p.spec.ownLP : 0);
    }
  }

  updateTargeting(dt) {
    const p = this.player;
    if (this.target && (!this.target.alive || this.target.dying)) { this.target = null; this.lockT = 0; }
    if (this.userTarget && (!this.userTarget.alive || this.userTarget.dying)) this.userTarget = null;
    const fwd = p.getForward(_cc);
    let best = null, bestAng = 0.5;
    for (const en of this.enemies) {
      const j = en.jet;
      if (!j.alive || j.dying) continue;
      const to = _ca.copy(j.pos).sub(p.pos);
      const d = to.length();
      if (d > 6500) continue;
      const a = Math.acos(clamp(fwd.dot(to.multiplyScalar(1 / d)), -1, 1));
      if (a < bestAng) { bestAng = a; best = j; }
    }
    if (!this.userTarget && best && best !== this.target) {
      // keep the current target while it is still reasonably centred
      let keep = false;
      if (this.target) {
        const to = _ca.copy(this.target.pos).sub(p.pos);
        keep = Math.acos(clamp(fwd.dot(to.normalize()), -1, 1)) < 0.5;
      }
      if (!keep) { this.target = best; this.lockT = 0; }
    }
    if (!this.target && best) this.target = best;
    if (this.target) {
      const to = _ca.copy(this.target.pos).sub(p.pos);
      const d = to.length();
      const a = Math.acos(clamp(fwd.dot(to.multiplyScalar(1 / d)), -1, 1));
      const audio = this.app.audio;
      if (a < 0.36 && d < 5800) {
        const was = this.lockT >= this.lockNeed;
        this.lockT = Math.min(this.lockNeed + 0.01, this.lockT + dt);
        this.lockBeepT -= dt;
        if (this.lockT < this.lockNeed) {
          if (this.lockBeepT <= 0) { this.lockBeepT = 0.28; if (audio && audio.ok) audio.beep(900, 0.07, 0.09); }
        } else {
          if (!was) { this.pushMsg('MISSILE LOCK', 'press F to fire', HUD_BAD, 22, 1.6); }
          if (this.lockBeepT <= 0) { this.lockBeepT = 0.11; if (audio && audio.ok) audio.beep(1700, 0.06, 0.1); }
        }
      } else this.lockT = Math.max(0, this.lockT - dt * 2.5);
    } else this.lockT = 0;
  }

  /** Streaks of air rushing past the camera: the main cue that gives a sense of speed high above the ground. */
  updateStreaks(p) {
    const app = this.app, cam = app.camera, N = 170;
    if (!this.streaks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false });
      const lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      lines.renderOrder = 5;
      app.scene.add(lines);
      this.streaks = { lines, pts: new Float32Array(N * 3), ready: false };
    }
    const S = this.streaks, pts = S.pts;
    const fwd = _ca.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const dir = p.vel.lengthSq() > 1 ? _cb.copy(p.vel).normalize() : fwd;
    const R = 70, ahead = 130;
    const arr = S.lines.geometry.attributes.position.array;
    const len = clamp(p.speed * 0.09, 0, 40);
    for (let i = 0; i < N; i++) {
      let x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (!S.ready || along < -45 || dx * dx + dy * dy + dz * dz > 220 * 220) {
        // respawn in a ring ahead of the camera, outside the cockpit area
        const a = Math.random() * TAU, r = 9 + Math.random() * R;
        const ux = Math.cos(a) * r, uy = Math.sin(a) * r;
        x = cam.position.x + dir.x * (20 + Math.random() * ahead) + ux * 1.0;
        y = cam.position.y + dir.y * (20 + Math.random() * ahead) + uy;
        z = cam.position.z + dir.z * (20 + Math.random() * ahead);
        pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z;
      }
      arr[i * 6] = x; arr[i * 6 + 1] = y; arr[i * 6 + 2] = z;
      arr[i * 6 + 3] = x - dir.x * len; arr[i * 6 + 4] = y - dir.y * len; arr[i * 6 + 5] = z - dir.z * len;
    }
    S.ready = true;
    S.lines.geometry.attributes.position.needsUpdate = true;
    S.lines.material.opacity = 0.7 * smoothstep(60, 220, p.speed);
    S.lines.visible = S.lines.material.opacity > 0.01;
  }

  updateCamera(dt, snap) {
    const app = this.app, cam = app.camera, p = this.player;
    if (!p) return;
    if (this.state === 'playing') this._wantStreaks = true;
    if (this.state === 'dead') {
      this.orbit += dt * 0.45;
      const wf = this.crashFx && this.crashFx.focus(_cb);
      if (wf) this.deathPos.lerp(wf, Math.min(1, dt * 2.5));
      const R = this.deathR || 75;
      cam.position.set(this.deathPos.x + Math.cos(this.orbit) * R, this.deathPos.y + R * 0.35 + 8, this.deathPos.z + Math.sin(this.orbit) * R);
      cam.lookAt(this.deathPos);
      return;
    }
    if (this.nukes && this.nukes.cam && this.nukes.applyCamera(cam, dt)) { // the bomb camera
      p.group.visible = true;
      if (this.shake > 0.002) { cam.position.x += rand(-1, 1) * this.shake; cam.position.y += rand(-1, 1) * this.shake; cam.position.z += rand(-1, 1) * this.shake; }
      cam.updateMatrixWorld(true);
      return;
    }
    let fov;
    if (this.camMode === 'chase') {
      this.camQ.slerp(p.quat, snap ? 1 : 1 - Math.exp(-dt * 7));
      const off = p.heavy ? _ca.set(0, p.spec.chase[0] * p.spec.scale, p.spec.chase[1] * p.spec.scale).applyQuaternion(this.camQ) : _ca.set(0, 5.6, 22).applyQuaternion(this.camQ);
      cam.position.copy(p.pos).add(off);
      cam.quaternion.copy(this.camQ);
      cam.rotateX(-0.045);
      fov = 62 + 14 * smoothstep(150, 450, p.speed) + 5 * p.ab;
      p.group.visible = true;
    } else {
      cam.position.copy(p.pos).add((p.heavy ? _ca.set(0, p.spec.cockpit[0] * p.spec.scale, p.spec.cockpit[1] * p.spec.scale) : _ca.set(0, 1.05, -3.9)).applyQuaternion(p.quat));
      cam.quaternion.copy(p.quat);
      fov = 76;
      p.group.visible = false;
    }
    if (this.shake > 0.002) {
      cam.position.x += rand(-1, 1) * this.shake;
      cam.position.y += rand(-1, 1) * this.shake;
      cam.position.z += rand(-1, 1) * this.shake;
    }
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * (snap ? 1 : 1 - Math.exp(-dt * 4));
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    this.updateStreaks(p);
  }

  showGameOver() {
    this.gameOverShown = true;
    const secs = Math.floor(this.timeAlive);
    const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
    document.getElementById('go-title').textContent = this.deathReason === 'CRASHED' ? 'You crashed' : this.deathReason === 'MID-AIR COLLISION' ? 'Mid-air collision' : this.deathReason === 'NUCLEAR BLAST' ? 'Caught in the blast' : 'Shot down';
    document.getElementById('go-text').textContent = this.kind === 'dogfight'
      ? `Score ${this.score}\nKills ${this.kills}  ·  Wave ${Math.max(1, this.wave)}\nTime ${mm}:${ss}`
      : `You flew for ${mm}:${ss}`;
    this.app.showOverlay('gameover', true);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  drawHUD(ctx, w, h) {
    drawFlightHUD(this, ctx, w, h);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.recOn) {
      const on = Math.floor(this.app.time * 1.6) % 2 === 0;
      ctx.font = '700 14px "Segoe UI", system-ui, sans-serif';
      const label = 'REC  ' + fmtTime((this.recN - 1) * REC_DT) + '   ·   G stops';
      const bw = ctx.measureText(label).width + 44;
      roundRect(ctx, w / 2 - bw / 2, 10, bw, 28, 14);
      ctx.fillStyle = 'rgba(40,6,6,0.65)';
      ctx.fill();
      ctx.fillStyle = on ? '#ff4a3d' : '#7a2a26';
      ctx.beginPath(); ctx.arc(w / 2 - bw / 2 + 17, 24, 6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd6d0';
      ctx.fillText(label, w / 2 + 8, 24);
    }
    if (!this.recOn && this.state === 'playing' && this.timeAlive > 2 && this.timeAlive < 14) {
      ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(235,243,255,0.75)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 5;
      ctx.fillText('G — record this flight, then replay it from the ground', w / 2, 24);
    }
    ctx.restore();
  }
}

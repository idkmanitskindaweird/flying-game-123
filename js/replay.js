'use strict';
/* ==========================================================================
   replay.js - "Replay Lab": watch a flight you recorded (G in Free Flight / Dogfight)
   from anywhere on the ground. It reuses the Doppler Lab's sound, graphs and meter,
   so the recorded jet is heard exactly as a listener standing at the spot you picked would hear it.
   ========================================================================== */

/** A jet whose pose comes from a recording instead of from physics. */
class ReplayJet extends Jet {
  constructor(opts) {
    super(opts);
    this.history = new TrackHistory(16384);
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  /** Pose at recording time rt (seconds). */
  poseAt(rec, rt) {
    const d = rec.d, n = rec.n;
    const f = Math.min(Math.max(rt / rec.dt, 0), n - 1);
    const i = Math.min(Math.floor(f), n - 2), u = f - i;
    const a = i * 13, b = a + 13;
    const L = (k) => d[a + k] + (d[b + k] - d[a + k]) * u;
    this.pos.set(L(0), L(1), L(2));
    this._qa.set(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
    this._qb.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
    this.quat.copy(this._qa).slerp(this._qb, u);
    this.vel.set(L(7), L(8), L(9));
    this.speed = L(10);
    this.throttle = L(11);
    this.ab = L(12);
    this.mach = this.speed / SPEED_OF_SOUND;
  }

  /** Rebuild the sound-travel history from the recording (after a seek). */
  seedHistory(rec, rt, base) {
    const h = this.history, d = rec.d;
    h.n = 0; h.head = 0; h.lastT = -1e18;
    const k1 = Math.min(rec.n - 1, Math.floor(rt / rec.dt));
    const k0 = Math.max(0, k1 - Math.round(170 / rec.dt));
    if (k0 === 0) {
      // before the recording began the jet is assumed to have been cruising in a straight line
      const back = 170;
      h.push(base - back, d[0] - d[7] * back, d[1] - d[8] * back, d[2] - d[9] * back);
    }
    for (let k = k0; k <= k1; k += 2) h.push(base + k * rec.dt, d[k * 13], d[k * 13 + 1], d[k * 13 + 2]);
  }
}

class ReplayMode extends WatchMode {
  constructor(app) {
    super(app);
    this.replay = true;
    this.rec = null;
    this.rt = 0;
    this.base = 0;
    this.playing = false;
    this.jet = null;
    this.placing = false;
    this.map = { x: 0, z: 0, h: 3000 };
    this.obsH = 1.7;
    this.wingN = 0;
    this.walk = { on: false, vx: 0, vz: 0, speed: 0, ph: 0, x: 0, y: 0, roll: 0, nod: 0 };
    this.pathLine = null;
    this.downAt = null;
    this.scrubbing = false;
    this.lastTimeTxt = '';
    this.bbox = null;
    this._ray = new THREE.Vector3();
  }

  get dur() { return this.rec ? (this.rec.n - 1) * this.rec.dt : 0; }

  /** a recording that ends in a crash plays on for a while so the wreck can burn and the buildings come down */
  /** when the replay ends: a crash plays on for a while, and a recorded nuke plays out fully (the fall, the blast and the cloud) even if the recording stopped before it went off */
  endTime() {
    let e = this.dur + (this.rec && this.rec.crash ? 16 : 0);
    const ns = this.rec && this.rec.nukes;
    if (ns && ns.length) e = Math.max(e, ns[ns.length - 1].t + 58);
    return e;
  }

  /* ----- lifecycle --------------------------------------------------------- */

  enter() {
    const app = this.app, rec = App.replayRec || App.recording;
    this.rec = rec;
    this.interactive = true;
    this.clearJets();
    this.clearTrace();
    this.focus = null;
    this.ride = null;
    this.camMode = 'ground';
    this.hideUI = false;
    for (const id of ['show-panel', 'show-menu']) document.getElementById(id).classList.add('hidden');
    this.placing = false;
    this.playing = false;
    this.rt = 0;
    this.crashed = false;
    this.shakeIn = 0;
    if (!this.crashFx) this.crashFx = new CrashFX(app);
    this.crashFx.clear();
    this.passes = 0;
    Object.assign(this.cfg, WATCH_DEFAULTS, { track: true, zoom: true, smoke: true, path: true, auto: false });
    this.lastDop = 1;
    this.phase = 'ready';
    this.lastEnd = 'reset';
    this.diagSpan = 3400;
    this.view.yaw = 0; this.view.pitch = 0.06; this.view.fov = this.userFov = 58;
    app.camera.near = 2;
    app.camera.updateProjectionMatrix();
    this.walk.on = false;
    if (!this.nukes) this.nukes = new NukeSystem(app);
    this.nukes.clear();
    this.nukeN = 0;

    // bounding box of the whole flight
    const d = rec.d;
    let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18, y1 = -1e18;
    for (let k = 0; k < rec.n; k++) {
      const x = d[k * 13], y = d[k * 13 + 1], z = d[k * 13 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y > y1) y1 = y;
    }
    this.bbox = { x0, x1, z0, z1 };

    // first guess for where to stand: a little to the side of the middle of the flight path
    const mid = Math.floor(rec.n * 0.45) * 13;
    let vx = d[mid + 7], vz = d[mid + 9];
    const vl = Math.hypot(vx, vz) || 1;
    vx /= vl; vz /= vl;
    this.obsH = 1.7;
    let sx = d[mid] - vz * 260, sz = d[mid + 2] + vx * 260;
    if (rec.crash) { // a crash: stand well back from the impact so you can watch the whole thing
      const e = (rec.n - 1) * 13;
      let ux = d[e + 7], uz = d[e + 9];
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      sx = d[e] - uz * 900 - ux * 250; sz = d[e + 2] + ux * 900 - uz * 250;
      vx = ux; vz = uz;
      if (app.world.city && app.world.city.inside(d[e], d[e + 2], 100)) {
        // a crash in the city: watch from 1.2 km away, up on a rooftop-high viewpoint, so buildings don't hide it and the sound only lags ~3.5 s
        sx = d[e] - uz * 1200 - ux * 200; sz = d[e + 2] + ux * 1200 - uz * 200;
        this.obsH = 240;
      }
    }
    // never start inside the city (buildings would block the view): slide sideways until clear of it
    const city = app.world.city;
    for (let k = 0; k < 70 && city && this.obsH < 100 && city.inside(sx, sz, 150); k++) { sx += -vz * 100; sz += vx * 100; }
    this.setObserver(sx, sz);

    this.buildPath();
    this.ensureEntry();
    this.seek(0);
    this.bindUI();
    this.syncUI();
    document.getElementById('replayui').classList.remove('hidden');
    if (app.audio && app.audio.ok) {
      app.audio.dopplerK = this.cfg.doppler;
      app.audio.onBoom = () => { this.boomFlash = 1.6; this.shake = 1; };
    }
    app.toast('Press SPACE to play  ·  V to pick where you stand', 3600);
  }

  exit() {
    const app = this.app;
    this.clearJets();
    this.jet = null;
    if (this.crashFx) this.crashFx.clear();
    if (this.nukes) this.nukes.clear();
    if (app.world.city) app.world.city.reset();
    if (this.pathLine) { app.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine.material.dispose(); this.pathLine = null; }
    document.getElementById('replayui').classList.add('hidden');
    for (const id of ['show-panel', 'show-menu']) document.getElementById(id).classList.add('hidden');
    if (app.audio) { app.audio.onBoom = null; if (app.audio.ok) app.audio.setPaused(false); }
    app.camera.fov = 58;
    app.camera.updateProjectionMatrix();
  }

  buildPath() {
    const app = this.app, rec = this.rec, d = rec.d;
    if (this.pathLine) { app.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine.material.dispose(); }
    const stride = Math.max(1, Math.ceil(rec.n / 3000));
    const pts = [];
    for (let k = 0; k < rec.n; k += stride) pts.push(new THREE.Vector3(d[k * 13], d[k * 13 + 1], d[k * 13 + 2]));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.75 });
    this.pathLine = new THREE.Line(g, m);
    this.pathLine.frustumCulled = false;
    this.pathLine.visible = !!this.cfg.path;
    app.scene.add(this.pathLine);
  }

  ensureEntry() {
    if (this.entries.length) return;
    const jet = new ReplayJet({ palette: 'steel', type: this.rec.kind || 'fighter', name: 'YOU' });
    jet.smokeOn = this.cfg.smoke;
    this.jet = jet;
    const e = this.addEntry(jet, null, 1, 1e12, true);
    e.inCone = undefined;
    this.focus = jet;
    this.phase = this.playing ? 'flying' : 'ready';
  }

  /* ----- timeline ------------------------------------------------------------- */

  seek(rt) {
    const app = this.app;
    this.crashFx.clear();
    if (this.nukes) this.nukes.clear();
    { const ns = (this.rec && this.rec.nukes) || []; this.nukeN = 0; while (this.nukeN < ns.length && ns[this.nukeN].t < clamp(rt, 0, this.dur) - 0.05) this.nukeN++; } // bombs already dropped before this moment are not re-shown
    if (app.world.city) app.world.city.reset(); // going back in time: the wreck is gone and the city is whole again
    this.crashed = false;
    this.shakeIn = 0;
    this.rt = clamp(rt, 0, this.dur);
    this.ensureEntry();
    this.base = app.time - this.rt;
    const jet = this.jet;
    jet.restoreWings();
    this.wingN = 0;
    this.applyWings(false);
    jet.poseAt(this.rec, this.rt);
    applyGearPose(jet.model, gearTAt(this.rec.gear, this.rt, jet.heavy), jet.heavy);
    jet.seedHistory(this.rec, this.rt, this.base);
    jet.syncVisual(app.time);
    jet.group.visible = true;
    this.entries[0].shadow.update(jet, app.world);
    this.entries[0].inCone = undefined;
    this.entries[0].tau = 0;
    this.tau = 0;
    this.clearTrace();
    this.focus = jet;
    app.fx.clear();
    this.lastEnd = 'reset';
  }

  setPlaying(on) {
    if (on && this.crashed) this.base = this.app.time - this.rt; // resume the crash in progress
    else if (on && this.rt >= this.endTime() - 0.05) this.seek(0);
    else if (on) this.seek(this.rt); // re-anchor sound history to now
    this.playing = on;
    this.phase = on ? 'flying' : 'ready';
    this.syncUI();
  }

  /** wings torn off during the flight: at their recorded time the wing disappears from the aircraft and its pieces fly off */
  applyWings(fx) {
    const ws = this.rec && this.rec.wings, jet = this.jet;
    if (!ws || !jet) return;
    while (this.wingN < ws.length && ws[this.wingN].t <= this.rt + 1e-6) {
      const wv = ws[this.wingN++], key = wv.side < 0 ? 'wingL' : 'wingR';
      if (jet.lost && jet.lost[key]) continue;
      jet.lost = jet.lost || {};
      jet.lost[key] = true;
      jet.hideWing(wv.side);
      if (fx) {
        jet.poseAt(this.rec, wv.t);
        this.crashFx.listener = this.obs;
        this.crashFx.wingOff(jet, wv.side);
        jet.poseAt(this.rec, this.rt);
      }
    }
  }

  /** the recorded aircraft hits something: break it up (the same crash as in flight), seen and heard from where you stand */
  triggerCrash() {
    const app = this.app, jet = this.jet, rec = this.rec;
    jet.poseAt(rec, this.dur);
    this.clearJets(); // removes the intact aircraft (and wipes old smoke) before the wreck appears
    const d = Math.max(60, Math.hypot(jet.pos.x - this.obs.x, jet.pos.y - this.obs.y, jet.pos.z - this.obs.z));
    this.crashFx.crash(jet, { air: !!rec.crash.air, listener: this.obs });
    this.shakeAmt = clamp(1800 / d, 0, 1.2);
    this.shakeIn = d / SPEED_OF_SOUND; // the ground shakes when the sound arrives
    this.crashed = true;
    this.jet = null;
    this.focus = null;
    this.focusInfo = null;
    this.phase = 'flying';
  }

  finish() {
    this.playing = false;
    if (!this.crashed) this.clearJets();
    this.jet = null;
    this.focus = null;
    this.phase = 'ready';
    this.lastEnd = 'complete';
    this.syncUI();
  }

  /* ----- observer ---------------------------------------------------------------- */

  setObserver(x, z) {
    const app = this.app;
    this.obs.set(x, app.world.surfaceAt(x, z) + this.obsH, z);
  }

  /** The ground point under a screen position while looking down from the map camera. */
  groundAt(px, py) {
    const app = this.app, cam = app.camera;
    cam.updateMatrixWorld(true);
    const nx = (px / app.w) * 2 - 1, ny = -(py / app.h) * 2 + 1;
    const r = this._ray.set(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize();
    if (r.y > -0.02) return null;
    let gy = 0, x = 0, z = 0;
    for (let i = 0; i < 4; i++) {
      const t = (gy - cam.position.y) / r.y;
      x = cam.position.x + r.x * t;
      z = cam.position.z + r.z * t;
      gy = app.world.surfaceAt(x, z);
    }
    return { x, z };
  }

  togglePlacing() {
    this.placing = !this.placing;
    const m = this.map, b = this.bbox, app = this.app;
    if (this.placing) {
      // frame the whole flight (and the spot you are standing on)
      const x0 = Math.min(b.x0, this.obs.x), x1 = Math.max(b.x1, this.obs.x);
      const z0 = Math.min(b.z0, this.obs.z), z1 = Math.max(b.z1, this.obs.z);
      m.x = (x0 + x1) / 2; m.z = (z0 + z1) / 2;
      const t = Math.tan(25 * DEG);
      m.h = clamp(Math.max((z1 - z0) / (2 * t), (x1 - x0) / (2 * t * app.camera.aspect)) * 1.25 + 300, 700, 40000);
      m.x += 150 * (2 * m.h * t / app.h); // keep the flight clear of the side panel
      this.app.toast('Click the ground to stand there  ·  drag to pan  ·  wheel to zoom  ·  V to go back', 3800);
    } else {
      app.world.prebuild(this.obs);
      app.toast('Standing at the chosen spot');
    }
    this.syncUI();
  }

  standUnderJet() {
    const j = this.jet;
    if (!j) return;
    // a spot on the ground beside the jet's current position, 150 m to the side of its heading
    let vx = j.vel.x, vz = j.vel.z;
    const vl = Math.hypot(vx, vz) || 1;
    vx /= vl; vz /= vl;
    this.setObserver(j.pos.x - vz * 150, j.pos.z + vx * 150);
    this.app.world.prebuild(this.obs);
    this.app.toast('Standing right under the jet');
  }

  /* ----- UI wiring ----------------------------------------------------------------- */

  bindUI() {
    if (this.uiBound) return;
    this.uiBound = true;
    const $ = (id) => document.getElementById(id);
    const self = this, cfg = this.cfg;
    $('r-play').addEventListener('click', () => { self.togglePlay(); $('r-play').blur(); });
    $('r-restart').addEventListener('click', () => { self.seek(0); self.setPlaying(true); $('r-restart').blur(); });
    const sk = $('r-seek');
    sk.addEventListener('input', () => { self.scrubbing = true; self.seek(parseFloat(sk.value)); self.syncTime(); });
    sk.addEventListener('change', () => { self.scrubbing = false; sk.blur(); });
    $('r-map').addEventListener('click', () => { self.togglePlacing(); $('r-map').blur(); });
    $('r-under').addEventListener('click', () => { self.standUnderJet(); $('r-under').blur(); });
    $('r-walk').addEventListener('click', () => { self.toggleWalk(); $('r-walk').blur(); });
    $('r-h').addEventListener('input', () => { self.obsH = parseFloat($('r-h').value); self.setObserver(self.obs.x, self.obs.z); self.syncUI(); });
    $('r-h').addEventListener('change', () => $('r-h').blur());
    $('r-dop').addEventListener('input', () => {
      cfg.doppler = parseFloat($('r-dop').value);
      if (cfg.doppler > 0) self.lastDop = cfg.doppler;
      if (self.app.audio) self.app.audio.dopplerK = cfg.doppler;
      self.syncUI();
    });
    $('r-dop').addEventListener('change', () => $('r-dop').blur());
    const chk = (id, key, after) => $(id).addEventListener('change', () => { cfg[key] = $(id).checked; $(id).blur(); if (after) after(); });
    chk('r-track', 'track');
    chk('r-zoom', 'zoom');
    chk('r-diagram', 'diagram');
    chk('r-meter', 'meter');
    chk('r-labels', 'labels');
    chk('r-smoke', 'smoke', () => { for (const e of self.entries) e.jet.smokeOn = cfg.smoke; });
    chk('r-path', 'path', () => { if (self.pathLine) self.pathLine.visible = !!cfg.path; });
    $('r-cam').addEventListener('click', () => { self.toggleCam(); $('r-cam').blur(); });
    $('r-menu').addEventListener('click', () => self.app.setPaused(true));
    $('r-hide').addEventListener('click', () => self.togglePanels());
    $('show-panel').addEventListener('click', () => { if (self.app.mode === self) self.togglePanels(); $('show-panel').blur(); });
    $('show-menu').addEventListener('click', () => { if (self.app.mode === self) self.app.setPaused(true); $('show-menu').blur(); });
  }

  syncUI() {
    const $ = (id) => document.getElementById(id);
    const cfg = this.cfg;
    $('r-play').innerHTML = this.playing ? '&#10074;&#10074; Pause <kbd>Space</kbd>' : (this.lastEnd === 'complete' ? '&#8634; Play again <kbd>Space</kbd>' : '&#9654; Play <kbd>Space</kbd>');
    $('r-seek').max = this.dur;
    $('r-seek').value = this.rt;
    $('r-h').value = this.obsH;
    $('r-h-val').textContent = this.obsH <= 2 ? 'standing on the ground' : `${Math.round(this.obsH)} m up`;
    $('r-dop').value = cfg.doppler;
    $('r-dop-val').textContent = cfg.doppler === 0 ? 'OFF' : cfg.doppler === 1 ? 'real (1.0×)' : cfg.doppler.toFixed(2) + '×';
    for (const [id, key] of [['r-track', 'track'], ['r-zoom', 'zoom'], ['r-diagram', 'diagram'], ['r-meter', 'meter'], ['r-labels', 'labels'], ['r-smoke', 'smoke'], ['r-path', 'path']]) $(id).checked = !!cfg[key];
    $('r-cam').textContent = 'Camera: ' + (this.camMode === 'ground' ? 'ground' : 'riding jet');
    $('r-map').textContent = this.placing ? 'Back to ground view' : 'Pick spot on map';
    $('r-map').classList.toggle('on', this.placing);
    $('r-walk').textContent = this.walk.on ? 'Walk mode: ON' : 'Walk mode';
    $('r-walk').classList.toggle('on', this.walk.on);
    $('r-h').disabled = this.walk.on;
    this.syncTime();
  }

  syncTime() {
    const txt = `${fmtTime(Math.min(this.rt, this.dur))} / ${fmtTime(this.dur)}`;
    if (txt !== this.lastTimeTxt) { document.getElementById('r-time').textContent = txt; this.lastTimeTxt = txt; }
    if (!this.scrubbing) document.getElementById('r-seek').value = Math.min(this.rt, this.dur);
  }

  togglePanels() {
    this.hideUI = !this.hideUI;
    document.getElementById('replayui').classList.toggle('hidden', this.hideUI);
    for (const id of ['show-panel', 'show-menu']) document.getElementById(id).classList.toggle('hidden', !this.hideUI);
  }

  togglePlay() {
    this.setPlaying(!this.playing);
  }

  /* ----- per-frame ---------------------------------------------------------------- */

  update(dt) {
    const app = this.app, t = app.time, obs = this.obs, keys = app.keys;
    const jet = this.jet;

    // walking around / panning the map / changing height
    let mx = 0, mz = 0, my = 0;
    if (keys.KeyW) mz -= 1;
    if (keys.KeyS) mz += 1;
    if (keys.KeyA) mx -= 1;
    if (keys.KeyD) mx += 1;
    if (keys.KeyE) my += 1;
    if (keys.KeyQ) my -= 1;
    const fast = keys.ShiftLeft || keys.ShiftRight;
    if (this.placing) {
      if (mx || mz) {
        const sp = this.map.h * 0.45 * (fast ? 2.5 : 1) * dt;
        this.map.x += mx * sp;
        this.map.z += mz * sp;
      }
      if (my) this.map.h = clamp(this.map.h * Math.exp(-my * dt * 1.2), 300, 40000);
    } else if (this.walk.on) {
      this.walkStep(dt, mx, mz, fast);
    } else if (mx || mz || my) {
      const v = this.view, sp = (fast ? 260 : 45) * dt;
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
      const nx = obs.x + (fx * -mz + rx * mx) * sp, nz = obs.z + (fz * -mz + rz * mx) * sp;
      if (my) this.obsH = clamp(this.obsH + my * (fast ? 160 : 35) * dt, 1.7, 2500);
      this.setObserver(nx, nz);
      if (my) this.syncUI();
    } else {
      this.setObserver(obs.x, obs.z); // follow the terrain (streaming may refine it)
    }

    if (this.playing) {
      this.rt = t - this.base;
      if (jet && this.rt >= this.dur && this.rec.crash && !this.crashed) this.triggerCrash();
      if (this.rt >= this.endTime()) {
        this.rt = this.endTime();
        if (jet && !this.crashed) jet.poseAt(this.rec, this.dur);
        this.finish();
      }
    }
    if (this.playing && this.nukes) { // a recorded nuke: the bomb is released at its recorded time and falls and goes off just as it did
      const ns = (this.rec && this.rec.nukes) || [];
      while (this.nukeN < ns.length && ns[this.nukeN].t <= this.rt) {
        const e = ns[this.nukeN++];
        this.nukes.spawn(new THREE.Vector3(e.x, e.y, e.z), new THREE.Vector3(e.vx, e.vy, e.vz));
      }
      this.nukes.update(dt, this);
    }
    if ((this.crashed || this.crashFx.chunks.length || (this.nukes && this.nukes.active)) && this.playing) {
      this.crashFx.update(dt);
      if (this.shakeIn > 0) { this.shakeIn -= dt; if (this.shakeIn <= 0) this.shake = Math.max(this.shake, this.shakeAmt); }
    }
    if (this.jet) {
      const j = this.jet;
      j.poseAt(this.rec, this.rt);
      applyGearPose(j.model, gearTAt(this.rec.gear, this.rt, j.heavy), j.heavy); // the gear goes up and down as it did in the flight
      if (this.playing) this.applyWings(true);
      if (this.playing) j.recordHistory(t);
      if (!this.crashed) j.group.visible = !(this.rt > this.dur + 0.3); // the recording is over: the aircraft is gone while a nuke plays out
      j.syncVisual(t);
      if (this.playing && this.rt <= this.dur) j.emitTrail(app.fx, dt);
      this.entries[0].shadow.update(j, app.world);
      if (!this.focus) this.focus = j;
    }
    this.phase = this.playing ? 'flying' : 'ready';

    // diagram scale follows the jet so it stays on screen wherever you stand
    if (this.jet) {
      const j = this.jet;
      const dx = j.pos.x - obs.x, dz = j.pos.z - obs.z;
      const want = Math.max(2.5 * Math.abs(dx), dz < 0 ? 1.95 * -dz : 3.8 * dz, 1400) * 1.12;
      this.diagSpan += (clamp(want, 1400, 40000) - this.diagSpan) * (1 - Math.exp(-dt * 2));
    }

    this.updateCamera(dt);
    this.applyWalkCam();
    this.applyShake(dt);
    this.updateDiagram(dt);

    // audio: held while paused, and heard from the spot you chose
    const au = app.audio;
    if (au && au.ok) {
      const ctx = au.ctx;
      if (ctx) {
        if (!this.playing && ctx.state === 'running') au.setPaused(true);
        else if (this.playing && ctx.state === 'suspended' && !app.paused) au.setPaused(false);
      }
      if (this.playing) {
        const L = this.listenerState();
        const v = this.view;
        let fwd, up;
        if (this.camMode === 'ride' && this.ride && !this.placing) {
          fwd = this._v.set(0, 0, -1).applyQuaternion(app.camera.quaternion);
          up = new THREE.Vector3(0, 1, 0).applyQuaternion(app.camera.quaternion);
        } else {
          const eu = new THREE.Euler(v.pitch, v.yaw, 0, 'YXZ');
          fwd = this._v.set(0, 0, -1).applyEuler(eu);
          up = new THREE.Vector3(0, 1, 0).applyEuler(eu);
        }
        au.update(t, L, fwd, up);
      }
    }
    this.boomFlash = Math.max(0, this.boomFlash - dt);
    this.syncTime();
  }

  /**
   * Walking on the ground: a person's pace (3.4 m/s brisk walk, 9 m/s running) with smooth start and stop, slowed uphill, stopped by
   * the sea, steep cliffs and buildings. The stride sets the head bob, side sway and roll, and each footfall makes a sound.
   */
  walkStep(dt, mx, mz, fast) {
    const W = this.walk, v = this.view, app = this.app, w = app.world, obs = this.obs;
    this.obsH = 1.7;
    let wx = 0, wz = 0;
    if (mx || mz) {
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
      wx = fx * -mz + rx * mx; wz = fz * -mz + rz * mx;
      const l = Math.hypot(wx, wz) || 1, top = (fast ? 9 : 3.4) * (mz > 0 && !mx ? 0.6 : !mz ? 0.8 : 1); // backwards and sideways are slower
      wx = (wx / l) * top; wz = (wz / l) * top;
    }
    const a = 1 - Math.exp(-dt * (mx || mz ? 5 : 8));
    W.vx += (wx - W.vx) * a; W.vz += (wz - W.vz) * a;
    let nx = obs.x + W.vx * dt, nz = obs.z + W.vz * dt;
    const g0 = w.surfaceAt(obs.x, obs.z), g1 = w.surfaceAt(nx, nz), s0 = Math.hypot(W.vx, W.vz);
    if (s0 > 0.01) {
      const slope = (g1 - g0) / (s0 * dt);
      if (g1 < 0.4 && g0 >= 0.4) { nx = obs.x; nz = obs.z; W.vx = W.vz = 0; } // the sea
      else if (slope > 0.8) { nx = obs.x; nz = obs.z; W.vx *= 0.2; W.vz *= 0.2; } // too steep to climb
      else {
        const k = clamp(1 - Math.max(0, slope - 0.15) * 0.9, 0.35, 1); // slower uphill
        nx = obs.x + (nx - obs.x) * k; nz = obs.z + (nz - obs.z) * k;
      }
    }
    const city = w.city;
    if (city && city.collide) {
      for (let i = 0; i < 3; i++) { // buildings are solid
        const c = city.collide(nx, w.surfaceAt(nx, nz) + 1.0, nz, 0.45);
        if (!c || Math.abs(c.ny) > 0.7) break;
        nx += c.nx * c.pen; nz += c.nz * c.pen;
      }
    }
    const moved = Math.hypot(nx - obs.x, nz - obs.z) / Math.max(dt, 1e-3);
    W.speed += (moved - W.speed) * (1 - Math.exp(-dt * 10));
    this.setObserver(nx, nz);
    // the stride: one unit of phase is one step (alternating feet)
    const sp = W.speed, stride = 0.62 + 0.12 * sp, before = Math.floor(W.ph);
    if (sp > 0.15) W.ph += (sp * dt) / stride;
    if (Math.floor(W.ph) !== before && this.playing && !app.paused && app.audio && app.audio.footstep) {
      const kind = city && city.inside(nx, nz, 0) ? 'hard' : g1 < 3.5 ? 'sand' : g1 > 140 ? 'hard' : 'grass';
      app.audio.footstep(kind, 0.7 + sp * 0.2);
    }
    const amp = sp > 0.15 ? 0.02 * Math.pow(Math.min(sp, 9), 0.8) : 0, ph = W.ph * TAU, t = app.time;
    W.y = amp * Math.cos(ph) * 0.5 + 0.003 * Math.sin(t * 1.4); // up and down once per step, plus slow breathing
    W.x = amp * 0.8 * Math.sin(ph * 0.5); // sways from foot to foot (once per two steps)
    W.roll = amp * 0.12 * Math.sin(ph * 0.5);
    W.nod = amp * 0.07 * Math.sin(ph + 0.6);
  }

  /** put the walking bob on the camera (the listener stays where the person stands) */
  applyWalkCam() {
    const W = this.walk;
    if (!W.on || this.placing || this.camMode === 'ride') return;
    const cam = this.app.camera, v = this.view;
    cam.position.x += Math.cos(v.yaw) * W.x;
    cam.position.z += -Math.sin(v.yaw) * W.x;
    cam.position.y += W.y;
    cam.rotation.order = 'YXZ';
    cam.rotation.x += W.nod;
    cam.rotation.z = W.roll;
  }

  toggleWalk() {
    const W = this.walk;
    W.on = !W.on;
    W.vx = W.vz = W.speed = 0;
    if (W.on) {
      this.placing = false;
      this.camMode = 'ground';
      this.obsH = 1.7;
      this.setObserver(this.obs.x, this.obs.z);
      this.app.camera.near = 0.2; // at eye height the ground is closer than the usual 2 m clip distance
      this.app.camera.updateProjectionMatrix();
      this.app.toast('Walk mode — G walk mode  ·  WASD fly · Shift run · drag to look · G to stop', 2800);
    } else {
      this.app.camera.rotation.z = 0;
      this.app.camera.near = 2;
      this.app.camera.updateProjectionMatrix();
      this.app.toast('Walk mode off', 1200);
    }
    this.syncUI();
  }

  listenerState() {
    const app = this.app, obs = this.obs;
    if (this.camMode === 'ride' && this.ride && !this.placing) return super.listenerState();
    return { x: obs.x, y: obs.y, z: obs.z, vx: 0, vy: 0, vz: 0, gy: app.world.surfaceAt(obs.x, obs.z) };
  }

  updateCamera(dt) {
    if (this.crashed && !this.placing && this.camMode === 'ground') {
      // follow the wreckage: look at the biggest piece and zoom to fit it
      const app = this.app, cam = app.camera, v = this.view, obs = this.obs;
      const wp = this.crashFx.focus(this._v);
      cam.position.copy(obs);
      if (wp && this.cfg.track && !this.dragging) {
        const dx = wp.x - obs.x, dy = wp.y - obs.y, dz = wp.z - obs.z;
        const yt = Math.atan2(-dx, -dz), pt = Math.atan2(dy, Math.hypot(dx, dz));
        v.yaw += clamp(wrapPi(yt - v.yaw) * 4, -1.6, 1.6) * dt;
        v.pitch += clamp((pt - v.pitch) * 4, -1.2, 1.2) * dt;
        if (this.cfg.zoom) {
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const target = clamp(2 * Math.atan(160 / Math.max(dist, 80)) * RAD, 14, 58);
          v.fov += (target - v.fov) * (1 - Math.exp(-dt * 1.5));
        }
      }
      v.pitch = clamp(v.pitch, -0.5, 1.45);
      cam.rotation.order = 'YXZ';
      cam.rotation.set(v.pitch, v.yaw, 0);
      if (Math.abs(cam.fov - v.fov) > 0.01) { cam.fov = v.fov; cam.updateProjectionMatrix(); }
      return;
    }
    super.updateCamera(dt);
    if (!this.placing) return;
    const cam = this.app.camera, m = this.map;
    cam.position.set(m.x, m.h, m.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(-PI / 2, 0, 0);
    if (Math.abs(cam.fov - 50) > 0.01) { cam.fov = 50; cam.updateProjectionMatrix(); }
  }

  /* ----- input ------------------------------------------------------------------------ */

  onKey(code, down) {
    if (!down) return false;
    switch (code) {
      case 'Space': this.togglePlay(); return true;
      case 'KeyR': this.seek(0); this.setPlaying(true); return true;
      case 'ArrowLeft': this.seek(this.rt - 5); this.syncUI(); return true;
      case 'ArrowRight': this.seek(this.rt + 5); this.syncUI(); return true;
      case 'KeyV': this.togglePlacing(); return true;
      case 'KeyT': this.cfg.track = !this.cfg.track; this.syncUI(); this.app.toast('Auto-track ' + (this.cfg.track ? 'on' : 'off')); return true;
      case 'KeyZ': this.cfg.zoom = !this.cfg.zoom; this.syncUI(); this.app.toast('Auto zoom ' + (this.cfg.zoom ? 'on' : 'off')); return true;
      case 'KeyI': this.cfg.diagram = !this.cfg.diagram; this.syncUI(); return true;
      case 'KeyB': this.cfg.meter = !this.cfg.meter; this.syncUI(); return true;
      case 'KeyM': this.toggleDoppler(); return true;
      case 'KeyH': this.togglePanels(); return true;
      case 'KeyC': this.toggleCam(); return true;
      case 'KeyL': this.cfg.labels = !this.cfg.labels; this.syncUI(); return true;
      case 'KeyU': this.standUnderJet(); return true;
      case 'KeyG': this.toggleWalk(); return true;
    }
    return false;
  }

  toggleDoppler() {
    const cfg = this.cfg;
    if (cfg.doppler > 0) { this.lastDop = cfg.doppler; cfg.doppler = 0; }
    else cfg.doppler = this.lastDop || 1;
    if (this.app.audio) this.app.audio.dopplerK = cfg.doppler;
    this.syncUI();
    this.app.toast(cfg.doppler === 0 ? 'Doppler effect OFF' : 'Doppler effect ON');
  }

  toggleCam() {
    this.camMode = this.camMode === 'ground' ? 'ride' : 'ground';
    if (this.camMode === 'ride') { this.placing = false; if (this.walk.on) this.walk.on = false; }
    this.syncUI();
    this.app.toast(this.camMode === 'ride' ? 'Riding the jet: no relative motion, so no Doppler shift' : 'Ground observer');
  }

  onMouseDown(e) {
    this.downAt = { x: e.clientX, y: e.clientY };
  }

  onMouseUp(e) {
    const d = this.downAt;
    this.downAt = null;
    if (!d || !this.placing || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const p = this.groundAt(e.clientX, e.clientY);
    if (!p) return;
    this.setObserver(p.x, p.z);
    this.app.toast(`Standing here — ${Math.round(Math.hypot(this.jet ? this.jet.pos.x - p.x : 0, this.jet ? this.jet.pos.z - p.z : 0))} m from the jet`, 1800);
  }

  onWheel(dy) {
    if (this.placing) {
      this.map.h = clamp(this.map.h * Math.exp(dy * 0.0011), 300, 40000);
      return;
    }
    super.onWheel(dy);
  }

  onDrag(dx, dy) {
    if (this.placing) {
      const k = (2 * this.map.h * Math.tan(25 * DEG)) / this.app.h;
      this.map.x -= dx * k;
      this.map.z -= dy * k;
      return;
    }
    super.onDrag(dx, dy);
  }

  /* ----- HUD ---------------------------------------------------------------------------- */

  helpLine() {
    return this.placing
      ? 'MAP: click = stand here  ·  drag = pan  ·  wheel / Q E = zoom  ·  WASD pan  ·  V back to ground  ·  SPACE play/pause'
      : 'SPACE play/pause  ·  ← → skip 5 s  ·  V pick spot on map  ·  WASD walk  ·  Q E height  ·  U stand under jet  ·  M Doppler  ·  C ride  ·  ESC menu';
  }

  drawReadout(ctx, w, h) {
    if (this.focusInfo && this.focus) { super.drawReadout(ctx, w, h); return; }
    const cx = w / 2 - (this.hideUI ? 0 : 150);
    let main = this.lastEnd === 'complete' ? 'End of recording — press SPACE to watch again' : 'Press SPACE to play your flight';
    let sub = this.lastEnd === 'complete' && isFinite(this.peakDb)
      ? `loudest ${Math.round(this.peakDb)} dB at your spot   ·   the graphs keep the whole flight`
      : 'V picks where you stand  ·  drag to look around';
    let col = '#d8ffe6';
    if (this.crashed) {
      const since = Math.max(0, this.rt - this.dur);
      const wp = this.crashFx.focusChunk ? this.crashFx.focusChunk.mesh.position : this.obs;
      const dist = Math.hypot(wp.x - this.obs.x, wp.z - this.obs.z);
      if (this.playing) {
        main = this.rec.crash.air ? 'SHOT DOWN' : 'CRASH';
        sub = `${since.toFixed(0)} s since impact   ·   ${(dist / 1000).toFixed(1)} km away   ·   the sound reaches you after ${(dist / SPEED_OF_SOUND).toFixed(1)} s`;
        col = '#ffb08a';
      } else if (this.lastEnd === 'complete') {
        main = 'End of recording — press SPACE to watch the crash again';
      }
    }
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 22px "Segoe UI", system-ui, sans-serif';
    const w1 = ctx.measureText(main).width;
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    const bw = Math.min(w - 20, Math.max(w1, ctx.measureText(sub).width) + 40);
    roundRect(ctx, cx - bw / 2, 31, bw, 58, 12);
    ctx.fillStyle = 'rgba(7,14,26,0.58)';
    ctx.fill();
    ctx.font = '700 22px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = col;
    ctx.fillText(main, cx, 52);
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(228,240,255,0.92)';
    ctx.fillText(sub, cx, 74);
    ctx.restore();
  }

  drawHUD(ctx, w, h) {
    super.drawHUD(ctx, w, h);
    if (!this.placing) return;
    const app = this.app, cam = app.camera, rec = this.rec, d = rec.d;
    cam.updateMatrixWorld(true);
    const proj = (x, y, z) => {
      const p = this._v.set(x, y, z).project(cam);
      return [(p.x * 0.5 + 0.5) * w, (-p.y * 0.5 + 0.5) * h, p.z];
    };
    ctx.save();
    // flight path, with the part already flown drawn brighter
    const stride = Math.max(1, Math.ceil(rec.n / 600));
    const kNow = Math.floor(this.rt / rec.dt);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? 'rgba(255,210,122,0.38)' : 'rgba(255,226,150,0.95)';
      ctx.beginPath();
      let pen = false;
      const kEnd = pass === 0 ? rec.n - 1 : kNow;
      for (let k = 0; k <= kEnd; k += stride) {
        const [sx, sy, sz] = proj(d[k * 13], d[k * 13 + 1], d[k * 13 + 2]);
        if (sz > 1) { pen = false; continue; }
        if (!pen) { ctx.moveTo(sx, sy); pen = true; } else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    // start / end markers
    const mark = (k, col, txt) => {
      const [sx, sy] = proj(d[k * 13], d[k * 13 + 1], d[k * 13 + 2]);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, TAU); ctx.fill();
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = col;
      ctx.fillText(txt, sx + 9, sy);
    };
    mark(0, '#9fe7ff', 'start');
    mark(rec.n - 1, '#ff9f8a', 'end');
    // the jet right now
    if (this.jet) {
      const j = this.jet;
      const [sx, sy] = proj(j.pos.x, j.pos.y, j.pos.z);
      const [hx, hy] = proj(j.pos.x + j.vel.x, j.pos.y, j.pos.z + j.vel.z);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.atan2(hy - sy, hx - sx));
      ctx.fillStyle = '#ffd27a';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(14, 0); ctx.lineTo(-10, -9); ctx.lineTo(-5, 0); ctx.lineTo(-10, 9); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.restore();
    }
    // you
    const [ox, oy] = proj(this.obs.x, this.obs.y, this.obs.z);
    ctx.strokeStyle = 'rgba(125,255,176,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, 13, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#7dffb0';
    ctx.beginPath(); ctx.arc(ox, oy, 5, 0, TAU); ctx.fill();
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
    ctx.fillText('YOU (microphone)', ox, oy + 28);
    ctx.restore();
  }
}

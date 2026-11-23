'use strict';
/* ==========================================================================
   flyby.js - "Doppler Lab": stand at the airshow, jets scream past.
   Includes a live wave-front diagram and a pitch-vs-time graph so you can SEE
   what the Doppler effect does to the sound you are hearing.
   ========================================================================== */

const FORMATIONS = {
  solo: [[0, 0, 0]],
  pair: [[0, 0, 0], [-15, 0.3, 15]],
  diamond: [[0, 0, 0], [-14, 0.3, 14], [14, 0.3, 14], [0, -0.8, 29]],
  trail: [[0, 0, 0]],
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const WATCH_DEFAULTS = {
  formation: 'pair', mach: 0.8, alt: 140, offset: 240, doppler: 1, style: 'straight', dir: 'ltr',
  plane: 'fighter', ab: false, smoke: true, track: true, zoom: true, diagram: true, meter: true, labels: true,
};
const C17_MAX_MACH = 0.77; // the real C-17 cruises at about Mach 0.74
const GRAPH_SPAN = 24; // seconds of history shown by the graphs

class WatchMode {
  constructor(app) {
    this.app = app;
    this.entries = []; // {jet, shadow, voice, leader, dir, exitDist}
    this.cfg = Object.assign({}, WATCH_DEFAULTS);
    this.lastDop = 1;
    this.obs = new THREE.Vector3(0, PLAIN_H + 1.7, 94);
    this.view = { yaw: 0, pitch: 0.06, fov: 58 };
    this.userFov = 58;
    this.camMode = 'ground';
    this.nextDir = 1;
    this.timer = 0;
    this.interval = 26;
    this.focus = null;
    this.pulses = [];
    this.pulseAcc = 0;
    this.pings = [];
    this.arrivals = [];
    this.graph = [];
    this.graphAcc = 0;
    this.focusInfo = null;
    this.interactive = false;
    this.boomFlash = 0;
    this.dragging = false;
    this.uiBound = false;
    this._v = new THREE.Vector3();
    this._sol = { ok: false };
    this.tau = 0;
    this.hideUI = false;
    this.passes = 0;
    this.phase = 'ready'; // 'ready' = nothing flying, waiting for SPACE; 'flying' = a pass is under way
    this.lastEnd = 'reset'; // how the last pass ended: 'reset' or 'complete'
    this.graphNow = 0; // right-hand edge (sim time) of the graphs; frozen between passes so the last pass can be studied
    this.levelE = 0; // smoothed acoustic energy (linear) heard right now
    this.levelDb = NaN; // ... and the same level in dB
    this.peakDb = NaN;
    this.boomE = 0;
    this.stats = { maxR: NaN, minR: NaN };
    this._sol2 = { ok: false };
    this.firstPass = false;
    this.idleT = 0;
  }

  /* ----- lifecycle --------------------------------------------------------- */

  enter(interactive) {
    const app = this.app;
    this.interactive = interactive;
    this.clearJets();
    this.clearTrace();
    this.focus = null;
    this.camMode = 'ground';
    this.hideUI = false;
    this.obs.set(0, app.world.surfaceAt(0, 94) + 1.7, 94);
    this.view.yaw = 0;
    this.view.pitch = 0.06;
    this.view.fov = this.userFov = 58;
    app.camera.near = 2;
    app.camera.updateProjectionMatrix();
    app.world.prebuild(this.obs);
    this.passes = 0;
    this.nextDir = 1;
    Object.assign(this.cfg, WATCH_DEFAULTS);
    this.lastDop = 1;
    this.phase = 'ready';
    this.lastEnd = 'reset';
    // The title-screen backdrop launches planes by itself. The real Doppler Lab only flies when YOU press SPACE.
    this.cfg.auto = !interactive;
    this.timer = 0;
    this.idleT = 0;
    this.firstPass = !interactive;
    if (!interactive) {
      this.cfg.dir = 'alt';
    } else {
      this.bindUI();
      this.syncUI();
      document.getElementById('watchui').classList.remove('hidden');
      this.app.toast('Press SPACE to launch the plane', 3200);
    }
    if (app.audio && app.audio.ok) {
      app.audio.dopplerK = this.cfg.doppler;
      app.audio.onBoom = (s) => { this.boomFlash = 1.6; if (this.interactive) this.shake = 1; };
    }
  }

  exit() {
    this.clearJets();
    document.getElementById('watchui').classList.add('hidden');
    for (const id of ['show-panel', 'show-menu']) document.getElementById(id).classList.add('hidden');
    if (this.app.audio) this.app.audio.onBoom = null;
  }

  clearJets() {
    const app = this.app;
    for (const e of this.entries) this.removeEntry(e, true);
    this.entries.length = 0;
    if (app.audio && app.audio.ok) app.audio.clearVoices();
    app.fx.clear();
  }

  removeEntry(e, silent) {
    const app = this.app;
    app.scene.remove(e.jet.group);
    e.shadow.dispose(app.scene);
    // a jet that flies out of range lets its sound tail off; a reset cuts it quickly
    if (e.voice && app.audio) app.audio.removeVoice(e.voice, silent ? 0.06 : 0.9);
  }

  /** Forget everything the diagram, graphs and level meter have recorded. */
  clearTrace() {
    this.pulses.length = 0;
    this.pings.length = 0;
    this.arrivals.length = 0;
    this.graph.length = 0;
    this.pulseAcc = 0;
    this.graphAcc = 0;
    this.levelE = 0;
    this.levelDb = NaN;
    this.peakDb = NaN;
    this.boomE = 0;
    this.boomFlash = 0;
    this.stats.maxR = this.stats.minR = NaN;
    this.focusInfo = null;
    this.tau = 0;
  }

  /** Put the plane away: nothing flies until SPACE is pressed again. */
  resetPlane(silent) {
    this.clearJets();
    this.clearTrace();
    this.focus = null;
    this.phase = 'ready';
    this.lastEnd = 'reset';
    if (!silent) this.app.toast('Plane reset \u2014 press SPACE to launch');
  }

  /* ----- UI wiring ----------------------------------------------------------- */

  bindUI() {
    if (this.uiBound) return;
    this.uiBound = true;
    const $ = (id) => document.getElementById(id);
    const self = this, cfg = this.cfg;
    const num = (id, key, after) => {
      $(id).addEventListener('input', () => {
        cfg[key] = parseFloat($(id).value);
        self.syncUI();
        if (after) after();
      });
      $(id).addEventListener('change', () => $(id).blur());
    };
    num('w-mach', 'mach');
    num('w-alt', 'alt');
    num('w-off', 'offset');
    num('w-dop', 'doppler', () => {
      if (cfg.doppler > 0) self.lastDop = cfg.doppler;
      if (self.app.audio) self.app.audio.dopplerK = cfg.doppler;
    });
    const chk = (id, key, after) => {
      $(id).addEventListener('change', () => {
        cfg[key] = $(id).checked;
        $(id).blur();
        if (after) after();
      });
    };
    chk('w-ab', 'ab');
    chk('w-smoke', 'smoke', () => { for (const e of self.entries) e.jet.smokeOn = cfg.smoke; });
    chk('w-track', 'track');
    chk('w-zoom', 'zoom');
    chk('w-diagram', 'diagram');
    chk('w-meter', 'meter');
    chk('w-labels', 'labels');
    $('w-plane').addEventListener('change', () => {
      cfg.plane = $('w-plane').value;
      const sp = PLANES[cfg.plane];
      if (sp) {
        cfg.ab = false;
        if (cfg.mach > sp.maxMach) { cfg.mach = sp.maxMach; self.app.toast(`The ${sp.short} tops out at Mach ${sp.maxMach}`); }
      }
      self.syncUI();
      $('w-plane').blur();
    });
    $('w-style').addEventListener('change', () => { cfg.style = $('w-style').value; $('w-style').blur(); });
    $('w-dir').addEventListener('change', () => { cfg.dir = $('w-dir').value; $('w-dir').blur(); });
    for (const b of $('w-formation').querySelectorAll('button')) {
      b.addEventListener('click', () => { cfg.formation = b.dataset.val; self.syncUI(); b.blur(); });
    }
    $('w-launch').addEventListener('click', () => { self.launchPass(); $('w-launch').blur(); });
    $('w-reset').addEventListener('click', () => { self.resetPlane(); $('w-reset').blur(); });
    $('w-cam').addEventListener('click', () => { self.toggleCam(); $('w-cam').blur(); });
    $('w-menu').addEventListener('click', () => self.app.setPaused(true));
    $('w-hide').addEventListener('click', () => self.togglePanels());
    $('show-panel').addEventListener('click', () => { if (self.app.mode === self) self.togglePanels(); $('show-panel').blur(); });
    $('show-menu').addEventListener('click', () => { if (self.app.mode === self) self.app.setPaused(true); $('show-menu').blur(); });
  }

  syncUI() {
    const $ = (id) => document.getElementById(id);
    const cfg = this.cfg;
    $('w-plane').value = cfg.plane;
    $('w-mach').max = PLANES[cfg.plane] ? PLANES[cfg.plane].maxMach : 1.5;
    $('w-ab').disabled = !!PLANES[cfg.plane];
    $('w-mach').value = cfg.mach;
    const ms = cfg.mach * SPEED_OF_SOUND;
    $('w-mach-val').textContent = `Mach ${cfg.mach.toFixed(2)} · ${ms.toFixed(0)} m/s · ${(ms * 3.6).toFixed(0)} km/h`;
    $('w-alt').value = cfg.alt;
    $('w-alt-val').textContent = `${Math.round(cfg.alt)} m (${Math.round(cfg.alt * 3.281)} ft)`;
    $('w-off').value = cfg.offset;
    $('w-off-val').textContent = cfg.offset <= 40 ? `${Math.round(cfg.offset)} m — right overhead` : `${Math.round(cfg.offset)} m`;
    $('w-dop').value = cfg.doppler;
    $('w-dop-val').textContent = cfg.doppler === 0 ? 'OFF' : cfg.doppler === 1 ? 'real (1.0×)' : cfg.doppler.toFixed(2) + '×';
    $('w-style').value = cfg.style;
    $('w-dir').value = cfg.dir;
    for (const b of $('w-formation').querySelectorAll('button')) b.classList.toggle('on', b.dataset.val === cfg.formation);
    for (const [id, key] of [['w-ab', 'ab'], ['w-smoke', 'smoke'], ['w-track', 'track'], ['w-zoom', 'zoom'], ['w-diagram', 'diagram'], ['w-meter', 'meter'], ['w-labels', 'labels']]) $(id).checked = !!cfg[key];
    $('w-cam').textContent = 'Camera: ' + (this.camMode === 'ground' ? 'ground' : 'riding jet');
  }

  togglePanels() {
    this.hideUI = !this.hideUI;
    document.getElementById('watchui').classList.toggle('hidden', this.hideUI);
    for (const id of ['show-panel', 'show-menu']) document.getElementById(id).classList.toggle('hidden', !this.hideUI || !this.interactive);
  }

  toggleCam() {
    this.camMode = this.camMode === 'ground' ? 'ride' : 'ground';
    this.syncUI();
    this.app.toast(this.camMode === 'ride' ? 'Riding the lead jet: no relative motion, so no Doppler shift' : 'Ground observer');
  }

  toggleDoppler() {
    const cfg = this.cfg;
    if (cfg.doppler > 0) { this.lastDop = cfg.doppler; cfg.doppler = 0; }
    else cfg.doppler = this.lastDop || 1;
    if (this.app.audio) this.app.audio.dopplerK = cfg.doppler;
    this.syncUI();
    this.app.toast(cfg.doppler === 0 ? 'Doppler effect OFF' : 'Doppler effect ON');
  }

  /* ----- spawning passes ------------------------------------------------------ */

  launchPass(over) {
    const app = this.app;
    // SPACE always starts the pass from the very beginning: whatever is still flying is put away first
    this.resetPlane(true);
    const cfg = Object.assign({}, this.cfg, over || {});
    let style = cfg.style;
    if (style === 'random') style = pick(['straight', 'climb', 'roll']);
    if (style === 'orbit') { this.launchOrbit(cfg); return; }
    let dir;
    if (cfg.dir === 'ltr') dir = 1;
    else if (cfg.dir === 'rtl') dir = -1;
    else { dir = this.nextDir; this.nextDir = -this.nextDir; }
    this.passes++;
    const spec = PLANES[cfg.plane] || null;
    const heavy = !!spec;
    if (spec) cfg.mach = Math.min(cfg.mach, spec.maxMach);
    const hs = spec ? spec.hs * spec.scale : 1; // big aircraft fly much wider formations than fighters
    const speed = cfg.mach * SPEED_OF_SOUND;
    const obs = this.obs;
    const y = app.world.surfaceAt(obs.x, obs.z) + cfg.alt;
    const z = obs.z - cfg.offset;
    const startDist = clamp(speed * (cfg.startSecs || 18), 2400, 7500);
    const exitDist = startDist * 0.85;
    const pal = heavy ? 'c17' : pick(SHOW_PALETTES);
    const count = cfg.formation === 'trail' ? 3 : 1;
    const ab = heavy ? 0 : cfg.ab || cfg.mach >= 0.97 ? 1 : 0;
    const theta = dir > 0 ? 0 : PI;
    for (let k = 0; k < count; k++) {
      const back = k * 430;
      const sx = obs.x - dir * (startDist + back);
      const wps = [
        new THREE.Vector3(sx, y, z),
        new THREE.Vector3(obs.x + (style === 'climb' ? dir * 380 : 0), y, z),
      ];
      if (style === 'climb') {
        wps.push(new THREE.Vector3(obs.x + dir * 3400, y + 2300, z));
        wps.push(new THREE.Vector3(obs.x + dir * 9000, y + 4200, z));
      } else {
        wps.push(new THREE.Vector3(obs.x + dir * exitDist, y, z));
      }
      const leader = new ScriptedJet({ type: heavy ? cfg.plane : 'fighter', palette: pal, name: (heavy ? spec.short : 'JET') + (count > 1 ? ' ' + String.fromCharCode(65 + k) : '') });
      leader.cmdSpeed = speed;
      leader.cmdAB = ab;
      leader.ab = ab;
      leader.throttle = heavy ? 0.5 + 0.3 * smoothstep(0.3, spec.maxMach, cfg.mach) : ab ? 1 : 0.6 + 0.35 * smoothstep(0.3, 0.95, cfg.mach);
      if (heavy) leader.aLat = 1.6 * 9.81;
      leader.startAt(wps[0], theta, speed, wps);
      leader.terrainClear = Math.max(60, Math.min(120, cfg.alt * 0.6));
      if (style === 'roll') {
        leader.flourishAt = (startDist + back) / speed - 1.3;
        leader.flourish = 0;
        leader.flourishDir = Math.random() < 0.5 ? 1 : -1;
      }
      this.addEntry(leader, null, dir, exitDist, true);
      const slots = cfg.formation === 'trail' ? [] : FORMATIONS[cfg.formation].slice(1);
      for (const s of slots) {
        const w = new ScriptedJet({ type: heavy ? cfg.plane : 'fighter', palette: pal, name: leader.name + '+' });
        w.leader = leader;
        w.offset.set(s[0] * hs, s[1], s[2] * hs);
        w.cmdSpeed = speed;
        w.pos.copy(leader.pos).add(this._v.copy(w.offset).applyQuaternion(leader.quat));
        w.vel.copy(leader.vel);
        w.quat.copy(leader.quat);
        w.speed = speed;
        w.ab = ab;
        w.throttle = leader.throttle;
        this.addEntry(w, leader, dir, exitDist, false);
      }
    }
    this.timer = 0;
    if (this.interactive) this.app.toast(`Launched: ${count > 1 ? '3 jets in trail' : cfg.formation === 'solo' ? '1 jet' : FORMATIONS[cfg.formation].length + ' jets'} \u00b7 Mach ${cfg.mach.toFixed(2)}`);
  }

  /** Jets circle the listener at constant distance: no radial velocity, so NO Doppler shift. */
  launchOrbit(cfg) {
    const app = this.app, obs = this.obs;
    this.passes++;
    const spec = PLANES[cfg.plane] || null;
    const heavy = !!spec;
    if (spec) cfg.mach = Math.min(cfg.mach, spec.maxMach);
    const hs = spec ? spec.hs * spec.scale : 1;
    const speed = cfg.mach * SPEED_OF_SOUND;
    const R = Math.max(cfg.offset * 2, (speed * speed) / (2.2 * 9.81) + 150);
    const y = app.world.surfaceAt(obs.x, obs.z) + cfg.alt + 60;
    const pal = heavy ? 'c17' : pick(SHOW_PALETTES);
    const a0 = rand(0, TAU);
    const sgn = Math.random() < 0.5 ? 1 : -1; // direction of travel
    const wps = [];
    const rev = 1.5;
    const n = Math.ceil(72 * rev);
    for (let i = 0; i <= n; i++) {
      const a = a0 + sgn * (i / 72) * TAU;
      wps.push(new THREE.Vector3(obs.x + Math.cos(a) * R, y, obs.z + Math.sin(a) * R));
    }
    // leave tangentially
    const aEnd = a0 + sgn * (n / 72) * TAU;
    wps.push(new THREE.Vector3(obs.x + Math.cos(aEnd) * R - sgn * Math.sin(aEnd) * 6000, y, obs.z + Math.sin(aEnd) * R + sgn * Math.cos(aEnd) * 6000));
    const theta = Math.atan2(wps[1].z - wps[0].z, wps[1].x - wps[0].x);
    const count = cfg.formation === 'solo' ? 1 : cfg.formation === 'pair' ? 2 : cfg.formation === 'diamond' ? 4 : 3;
    const ab = heavy ? 0 : cfg.ab || cfg.mach >= 0.97 ? 1 : 0;
    const leader = new ScriptedJet({ type: heavy ? cfg.plane : 'fighter', palette: pal, name: heavy ? spec.short : 'JET' });
    leader.cmdSpeed = speed; leader.cmdAB = ab; leader.ab = ab;
    leader.throttle = heavy ? 0.5 + 0.3 * smoothstep(0.3, spec.maxMach, cfg.mach) : ab ? 1 : 0.6 + 0.35 * smoothstep(0.3, 0.95, cfg.mach);
    leader.aLat = (heavy ? 1.6 : 4) * 9.81;
    leader.terrainClear = 60;
    leader.startAt(wps[0], theta, speed, wps);
    const e = this.addEntry(leader, null, 1, 1e9, true);
    e.maxAge = (TAU * R * rev) / speed + 8;
    const slots = count === 3 ? FORMATIONS.diamond.slice(1, 3) : FORMATIONS[cfg.formation === 'trail' ? 'pair' : cfg.formation].slice(1);
    for (const s of slots) {
      const w = new ScriptedJet({ type: heavy ? cfg.plane : 'fighter', palette: pal, name: leader.name + '+' });
      w.leader = leader;
      w.offset.set(s[0] * hs, s[1], s[2] * hs);
      w.cmdSpeed = speed;
      w.pos.copy(leader.pos).add(this._v.copy(w.offset).applyQuaternion(leader.quat));
      w.vel.copy(leader.vel); w.quat.copy(leader.quat); w.speed = speed; w.ab = ab; w.throttle = leader.throttle;
      const we = this.addEntry(w, leader, 1, 1e9, false);
      we.maxAge = e.maxAge;
    }
    this.timer = 0;
    if (this.interactive) this.app.toast(`Circling you at ${(R / 1000).toFixed(1)} km \u2014 listen: the pitch never changes`);
  }

  addEntry(jet, leader, dir, exitDist, isLeader) {
    const app = this.app;
    jet.smokeOn = this.cfg.smoke;
    jet.resetHistory(app.time);
    app.scene.add(jet.group);
    jet.syncVisual(app.time);
    const shadow = new JetShadow(app.scene);
    let voice = null;
    if (this.interactive && app.audio && app.audio.ok) voice = app.audio.addJetVoice(jet);
    const e = { jet, shadow, voice, leader, dir, exitDist, isLeader, tau: 0, heard: undefined };
    this.entries.push(e);
    this.phase = 'flying';
    return e;
  }

  /* ----- per-frame ---------------------------------------------------------------- */

  update(dt) {
    const app = this.app;
    const t = app.time;
    const cfg = this.cfg;
    const obs = this.obs;

    // Only the title-screen backdrop launches planes by itself. In the Doppler Lab the plane flies when you press SPACE.
    if (cfg.auto) {
      const leadersAlive = this.entries.some((e) => e.isLeader);
      if (leadersAlive) this.idleT = 0;
      else {
        this.idleT += dt;
        if (this.idleT > (this.firstPass ? 0 : 1.5)) {
          // the menu backdrop varies things a little
          this.cfg.formation = pick(['solo', 'pair', 'pair', 'diamond']);
          this.cfg.mach = rand(0.65, 1.15);
          this.cfg.offset = rand(120, 420);
          this.cfg.alt = rand(60, 260);
          this.cfg.style = pick(['straight', 'straight', 'roll', 'climb']);
          this.launchPass(this.firstPass ? { startSecs: 11 } : null);
          this.firstPass = false;
          this.idleT = 0;
        }
      }
    }

    // step jets (leaders first so followers see fresh state)
    const ctx = { world: app.world };
    for (const e of this.entries) if (e.isLeader) e.jet.step(dt, ctx);
    for (const e of this.entries) if (!e.isLeader) e.jet.step(dt, ctx);
    for (const e of this.entries) {
      const j = e.jet;
      j.recordHistory(t);
      j.syncVisual(t);
      j.emitTrail(app.fx, dt);
      e.shadow.update(j, app.world);
    }
    // remove passed-out jets
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const lead = e.leader || e.jet;
      const past = (lead.pos.x - obs.x) * e.dir;
      const far = Math.hypot(lead.pos.x - obs.x, lead.pos.z - obs.z) > 11500 || lead.age > (e.maxAge || 150);
      if ((past > e.exitDist && !(lead.gamma > 0.3)) || far || lead.done && far) {
        this.removeEntry(e);
        this.entries.splice(i, 1);
      }
    }

    if (this.phase === 'flying' && this.entries.length === 0) {
      this.phase = 'ready';
      this.lastEnd = 'complete';
    }

    // choose the jet to follow (nearest leader, with hysteresis)
    let best = null, bd = 1e12;
    for (const e of this.entries) {
      if (!e.isLeader) continue;
      const d = e.jet.pos.distanceTo(obs);
      if (d < bd) { bd = d; best = e.jet; }
    }
    if (this.focus && !this.entries.some((e) => e.jet === this.focus)) this.focus = null;
    if (!this.focus) this.focus = best;
    else if (best && best !== this.focus && bd < 0.7 * this.focus.pos.distanceTo(obs)) this.focus = best;

    this.updateCamera(dt);
    this.applyShake(dt);
    this.updateDiagram(dt);

    // audio
    if (app.audio && app.audio.ok && this.interactive) {
      const cam = app.camera;
      const fwd = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const L = this.listenerState();
      app.audio.update(t, L, fwd, up);
    }
    this.boomFlash = Math.max(0, this.boomFlash - dt);
  }

  /** Camera shake when a sonic boom hits: a hard jolt that dies away over ~2 s. */
  applyShake(dt) {
    if (!(this.shake > 0.004)) { this.shake = 0; return; }
    this.shakeT = (this.shakeT || 0) + dt;
    this.shake *= Math.exp(-dt * 2.2);
    if (this.placing) return;
    const cam = this.app.camera, a = this.shake * this.shake * (0.4 + 0.6 * this.shake);
    const w = this.shakeT * 38;
    cam.rotation.x += (Math.sin(w * 1.3) * 0.6 + rand(-1, 1) * 0.4) * 0.028 * a;
    cam.rotation.y += (Math.sin(w * 1.7 + 1.1) * 0.6 + rand(-1, 1) * 0.4) * 0.028 * a;
    cam.rotation.z += Math.sin(w * 0.9 + 2.0) * 0.02 * a;
    cam.position.y += Math.sin(w * 2.1) * 0.35 * a;
    cam.position.x += rand(-1, 1) * 0.2 * a;
    cam.position.z += rand(-1, 1) * 0.2 * a;
  }

  listenerState() {
    const cam = this.app.camera;
    const L = { x: cam.position.x, y: cam.position.y, z: cam.position.z, vx: 0, vy: 0, vz: 0 };
    // standing on the ground: lets the sound engine add the ground reflection (comb-filter swoosh)
    if (!(this.camMode === 'ride' && this.ride)) L.gy = this.obs.y - 1.7;
    if (this.camMode === 'ride' && this.ride) {
      L.vx = this.ride.vel.x; L.vy = this.ride.vel.y; L.vz = this.ride.vel.z;
    }
    return L;
  }

  updateCamera(dt) {
    const app = this.app, cam = app.camera, v = this.view, obs = this.obs;
    const f = this.focus;
    if (this.camMode === 'ride') {
      const j = this.ride && this.entries.some((e) => e.jet === this.ride) ? this.ride : (f || null);
      this.ride = j;
      if (j) {
        const off = this._v.set(0, 4.2, 18.5).applyQuaternion(j.quat);
        cam.position.copy(j.pos).add(off);
        cam.quaternion.copy(j.quat);
        cam.rotateX(-0.05);
        cam.fov += (62 - cam.fov) * (1 - Math.exp(-dt * 3));
        cam.updateProjectionMatrix();
        return;
      }
    }
    this.ride = null;
    cam.position.copy(obs);
    if (this.cfg.track && f && !this.dragging) {
      const dx = f.pos.x - obs.x, dy = f.pos.y - obs.y, dz = f.pos.z - obs.z;
      const yt = Math.atan2(-dx, -dz);
      const pt = Math.atan2(dy, Math.hypot(dx, dz));
      v.yaw += clamp(wrapPi(yt - v.yaw) * 7, -2.2, 2.2) * dt;
      v.pitch += clamp((pt - v.pitch) * 7, -1.6, 1.6) * dt;
      if (this.cfg.zoom) {
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const target = clamp(2 * Math.atan(62 / Math.max(d, 60)) * RAD, this.interactive ? 8 : 26, 55);
        v.fov += (target - v.fov) * (1 - Math.exp(-dt * 1.8));
        this.userFov = v.fov;
      }
    } else if (this.cfg.track && !f && !this.dragging) {
      v.yaw += wrapPi(0 - v.yaw) * (1 - Math.exp(-dt * 0.8));
      v.pitch += (0.06 - v.pitch) * (1 - Math.exp(-dt * 0.8));
      if (this.cfg.zoom) v.fov += (58 - v.fov) * (1 - Math.exp(-dt * 0.8));
    }
    v.pitch = clamp(v.pitch, -0.5, 1.45);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(v.pitch, v.yaw, 0);
    if (Math.abs(cam.fov - v.fov) > 0.01) {
      cam.fov = v.fov;
      cam.updateProjectionMatrix();
    }
  }

  /* ----- Doppler diagram bookkeeping ------------------------------------------------- */

  updateDiagram(dt) {
    const app = this.app, t = app.time, obs = this.obs, c = SPEED_OF_SOUND;
    const f = this.focus;
    const PT = 0.25;
    if (f) {
      this.pulseAcc += dt;
      while (this.pulseAcc >= PT) {
        this.pulseAcc -= PT;
        const back = this.pulseAcc;
        this.pulses.push({ t: t - back, x: f.pos.x - f.vel.x * back, y: f.pos.y - f.vel.y * back, z: f.pos.z - f.vel.z * back, arrived: false });
      }
    }
    for (const p of this.pulses) {
      if (p.arrived) continue;
      const R = c * (t - p.t);
      const D = Math.hypot(p.x - obs.x, p.y - obs.y, p.z - obs.z);
      if (R >= D) {
        p.arrived = true;
        this.pings.push(t);
        this.arrivals.push(t);
      }
    }
    while (this.pulses.length && t - this.pulses[0].t > 20) this.pulses.shift();
    while (this.pings.length && t - this.pings[0] > 0.5) this.pings.shift();
    while (this.arrivals.length && t - this.arrivals[0] > 1.6) this.arrivals.shift();

    // heard-pitch sample for the focus jet
    const L = this.listenerState();
    const flying = this.phase === 'flying';
    this.focusInfo = null;
    if (f) {
      const sol = this._sol;
      if (inMachCone(f, L, c) && solveRetarded(f.history, t, L.x, L.y, L.z, c, this.tau, sol)) {
        this.tau = sol.tau;
        const r = dopplerRatio(sol, L.x, L.y, L.z, L.vx, L.vy, L.vz, c, this.cfg.doppler);
        const dx = sol.x - L.x, dy = sol.y - L.y, dz = sol.z - L.z;
        const d = Math.max(Math.hypot(dx, dy, dz), 1);
        const radial = (sol.vx * dx + sol.vy * dy + sol.vz * dz) / d - (L.vx * dx + L.vy * dy + L.vz * dz) / d;
        this.focusInfo = { ratio: r, d, tau: sol.tau, radial, speed: f.speed, mach: f.speed / c, audible: true };
        if (flying) {
          this.stats.maxR = isFinite(this.stats.maxR) ? Math.max(this.stats.maxR, r) : r;
          this.stats.minR = isFinite(this.stats.minR) ? Math.min(this.stats.minR, r) : r;
        }
      } else {
        this.focusInfo = { ratio: NaN, d: f.pos.distanceTo(L), tau: 0, radial: 0, speed: f.speed, mach: f.speed / c, audible: false };
      }
    }

    // loudness: add up the sound energy of every jet in the formation, each heard from where it WAS when the sound left it
    let E = 0;
    const s2 = this._sol2;
    for (const e of this.entries) {
      const j = e.jet;
      const cone = inMachCone(j, L, c);
      const wasIn = e.inCone;
      e.inCone = cone;
      if (cone && wasIn === false && !(t - (this.lastBoomT || -99) < 3)) {
        // the Mach cone has just swept over the listener: a sonic boom (a sharp, very loud thump)
        this.lastBoomT = t;
        const bx = j.pos.x - L.x, by = j.pos.y - L.y, bz = j.pos.z - L.z;
        const bd = Math.max(Math.sqrt(bx * bx + by * by + bz * bz), 1);
        this.boomE = Math.max(this.boomE, Math.pow(10, (140 - 18 * Math.log10(Math.max(bd, 150) / 150)) / 10));
        this.boomFlash = 1.6; if (this.interactive) this.shake = 1;
        if (this.interactive && this.app.audio && this.app.audio.ok) this.app.audio.boom({ x: bx, y: by, z: bz }, clamp(900 / Math.max(bd, 60), 0.25, 1.1));
      }
      if (!cone || !solveRetarded(j.history, t, L.x, L.y, L.z, c, e.tau, s2)) { e.heard = false; continue; }
      e.tau = s2.tau;
      const dx = s2.x - L.x, dy = s2.y - L.y, dz = s2.z - L.z;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1);
      const sp = Math.sqrt(s2.vx * s2.vx + s2.vy * s2.vy + s2.vz * s2.vz);
      const cosPhi = sp > 30 ? -(s2.vx * dx + s2.vy * dy + s2.vz * dz) / (sp * d) : 0;
      e.heard = true;
      e.silentT = 0;
      E += Math.pow(10, (jetSPL(j.throttle, j.ab, d, cosPhi) + (j.heavy ? j.spec.snd.spl : 0)) / 10);
    }
    const total = E + this.boomE;
    this.boomE *= Math.exp(-dt / 0.45);
    const kk = total > this.levelE ? 1 - Math.exp(-dt / 0.06) : 1 - Math.exp(-dt / (this.entries.length ? 0.3 : 1.0));
    this.levelE += (total - this.levelE) * kk;
    this.levelDb = this.levelE > 1000 ? 10 * Math.log10(this.levelE) : NaN;
    if (flying && isFinite(this.levelDb)) this.peakDb = isFinite(this.peakDb) ? Math.max(this.peakDb, this.levelDb) : this.levelDb;

    // graph samples (frozen between passes so the last pass can be studied)
    if (flying) {
      this.graphNow = t;
      this.graphAcc += dt;
      if (this.graphAcc >= 0.05) {
        this.graphAcc = 0;
        this.graph.push({ t, r: this.focusInfo && this.focusInfo.audible ? this.focusInfo.ratio : NaN, db: this.levelDb });
        while (this.graph.length && t - this.graph[0].t > GRAPH_SPAN + 2) this.graph.shift();
      }
    }
  }

  /* ----- input ------------------------------------------------------------------------ */

  onKey(code, down) {
    if (!down) return false;
    switch (code) {
      case 'Space': this.launchPass(); return true;
      case 'KeyR': this.resetPlane(); return true;
      case 'KeyT': this.cfg.track = !this.cfg.track; this.syncUI(); this.app.toast('Auto-track ' + (this.cfg.track ? 'on' : 'off')); return true;
      case 'KeyZ': this.cfg.zoom = !this.cfg.zoom; this.syncUI(); this.app.toast('Auto zoom ' + (this.cfg.zoom ? 'on' : 'off')); return true;
      case 'KeyD': this.cfg.diagram = !this.cfg.diagram; this.syncUI(); return true;
      case 'KeyB': this.cfg.meter = !this.cfg.meter; this.syncUI(); return true;
      case 'KeyM': this.toggleDoppler(); return true;
      case 'KeyH': this.togglePanels(); return true;
      case 'KeyC': this.toggleCam(); return true;
      case 'KeyL': this.cfg.labels = !this.cfg.labels; this.syncUI(); return true;
    }
    return false;
  }

  onWheel(dy) {
    if (this.camMode === 'ride') return;
    this.view.fov = clamp(this.view.fov * Math.exp(dy * 0.0012), 3, 75);
    this.userFov = this.view.fov;
    if (this.cfg.zoom) {
      this.cfg.zoom = false;
      this.syncUI();
      this.app.toast('Manual zoom (Z for auto zoom)');
    }
  }

  onDrag(dx, dy) {
    if (this.camMode === 'ride') return;
    if (this.cfg.track) {
      this.cfg.track = false;
      this.syncUI();
      this.app.toast('Free look (T for auto-track)');
    }
    const k = 0.0042 * (this.view.fov / 60);
    this.view.yaw -= dx * k;
    this.view.pitch = clamp(this.view.pitch + dy * k * -1, -0.5, 1.45);
  }

  /* ----- HUD ----------------------------------------------------------------------------- */

  drawHUD(ctx, w, h) {
    if (!this.interactive) return;
    const app = this.app;
    const t = app.time;
    ctx.save();

    // jet labels
    if (this.cfg.labels) {
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const e of this.entries) {
        if (!e.isLeader) continue;
        const j = e.jet;
        const p = this._v.copy(j.pos).project(app.camera);
        if (p.z > 1 || p.z < -1) continue;
        const sx = (p.x * 0.5 + 0.5) * w, sy = (-p.y * 0.5 + 0.5) * h;
        if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
        const d = j.pos.distanceTo(app.camera.position);
        // apparent size in pixels
        const px = (15 / d) * (h / (2 * Math.tan(app.camera.fov * DEG / 2)));
        const r = Math.max(14, px * 0.9);
        ctx.strokeStyle = e.jet === this.focus ? 'rgba(125,255,176,0.95)' : 'rgba(160,200,255,0.6)';
        ctx.lineWidth = 1.5;
        const L = r * 0.38;
        for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.beginPath();
          ctx.moveTo(sx + ax * r, sy + ay * (r - L));
          ctx.lineTo(sx + ax * r, sy + ay * r);
          ctx.lineTo(sx + ax * (r - L), sy + ay * r);
          ctx.stroke();
        }
        ctx.fillStyle = e.jet === this.focus ? '#8dffb4' : '#b9d4ff';
        const dist = d > 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;
        const left = sx + r + 175 > w - (this.hideUI ? 14 : 306);
        ctx.textAlign = left ? 'right' : 'left';
        ctx.fillText(`${j.name}  M${(j.speed / SPEED_OF_SOUND).toFixed(2)}  ${dist}`, left ? sx - r - 6 : sx + r + 6, sy);
        ctx.shadowBlur = 0;
      }
    }

    const pad = 14;
    const dw = Math.min(360, Math.max(250, w * 0.3));
    const dh = dw * 0.8;
    const rightEdge = w - (this.hideUI ? 14 : 306); // left edge of the side panel
    if (this.cfg.diagram) {
      this.drawDiagram(ctx, pad, h - dh - pad, dw, dh);
      const gx = pad + dw + 10;
      const gw = Math.min(520, rightEdge - gx - 12);
      const gh = (dh - 8) / 2;
      if (gw > 240) {
        this.drawPitchGraph(ctx, gx, h - dh - pad, gw, gh);
        this.drawLevelGraph(ctx, gx, h - pad - gh, gw, gh);
      }
    }
    const mh = clamp(h - 96 - (this.cfg.diagram ? dh + pad + 16 : pad + 16), 230, 360);
    if (this.cfg.meter) this.drawLevelMeter(ctx, pad, 96, 176, mh);
    this.drawReadout(ctx, w, h);

    // sonic boom flash
    if (this.boomFlash > 0) {
      const a = Math.min(1, this.boomFlash);
      ctx.fillStyle = `rgba(255,255,255,${0.16 * a * a})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = a;
      ctx.font = '900 56px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd9a0';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 14;
      ctx.fillText('SONIC BOOM', w / 2, h * 0.3);
      ctx.globalAlpha = 1;
    }
    // help line
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = 'rgba(235,243,255,0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(this.helpLine(), 16, 22);
    if (app.audio && !app.audio.ok) {
      ctx.fillStyle = '#ffb08a';
      ctx.fillText('Audio unavailable in this browser', 16, 42);
    }
    ctx.restore();
  }

  helpLine() {
    return 'SPACE launch plane  \u00b7  R reset plane  \u00b7  M Doppler on/off  \u00b7  T auto-track  \u00b7  C ride along  \u00b7  H hide panels  \u00b7  ESC menu';
  }

  drawReadout(ctx, w, h) {
    const fi = this.focusInfo, f = this.focus;
    const cx = w / 2 - (this.hideUI ? 0 : 150);
    let main = null, sub = '', col = '#d8ffe6';
    if (fi && f) {
      if (fi.audible) {
        const semis = 12 * Math.log2(fi.ratio);
        const dir = fi.radial < -3 ? 'approaching' : fi.radial > 3 ? 'moving away' : 'passing abeam';
        main = fi.ratio >= 1.0 ? `you hear it  \u00d7${fi.ratio.toFixed(2)}  higher` : `you hear it  \u00d7${fi.ratio.toFixed(2)}  lower`;
        sub = `${f.name}   Mach ${fi.mach.toFixed(2)}   ${dir} at ${Math.abs(fi.radial).toFixed(0)} m/s   \u00b7   ${semis >= 0 ? '+' : ''}${semis.toFixed(1)} semitones   \u00b7   sound arrives ${fi.tau.toFixed(1)} s late`;
        col = fi.ratio > 1.05 ? '#9fe7ff' : fi.ratio < 0.95 ? '#ffc08a' : '#d8ffe6';
      } else if (fi.mach >= 1) {
        main = 'silence \u2014 the jet is outrunning its own sound';
        sub = `${f.name}   Mach ${fi.mach.toFixed(2)}   the Mach cone has not reached you yet`;
        col = '#ffe08a';
      } else {
        main = 'near silence \u2014 the jet almost keeps pace with its own sound';
        sub = `${f.name}   Mach ${fi.mach.toFixed(2)}   its sound piles up in front of it and reaches you only at the last moment`;
        col = '#ffe08a';
      }
    } else if (this.phase === 'ready') {
      if (this.lastEnd === 'complete') {
        main = 'Pass complete \u2014 press SPACE to launch again';
        const st = this.stats;
        sub = isFinite(this.peakDb) && isFinite(st.maxR)
          ? `loudest ${Math.round(this.peakDb)} dB   \u00b7   pitch swung from \u00d7${st.maxR.toFixed(2)} (approaching) to \u00d7${st.minR.toFixed(2)} (moving away)   \u00b7   the graphs keep the whole pass`
          : 'the graphs keep the whole pass';
      } else {
        main = 'Press SPACE to launch the plane';
        sub = 'R resets the plane   \u00b7   M turns the Doppler effect on and off   \u00b7   drag to look around';
      }
    }
    if (!main) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 22px "Segoe UI", system-ui, sans-serif';
    const w1 = ctx.measureText(main).width;
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    const w2 = ctx.measureText(sub).width;
    const bw = Math.min(w - 20, Math.max(w1, w2) + 40);
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

  drawDiagram(ctx, x, y, w, h) {
    const app = this.app, t = app.time, obs = this.obs, c = SPEED_OF_SOUND;
    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = 'rgba(7,14,26,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,230,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.clip();

    const span = this.diagSpan || 3400; // metres across the panel
    const s = w / span;
    const cx = x + w * 0.5, cy = y + h * 0.66;
    const toPx = (wx, wz) => [cx + (wx - obs.x) * s, cy + (wz - obs.z) * s];

    // faint grid (every 500 m)
    ctx.strokeStyle = 'rgba(120,150,190,0.08)';
    ctx.beginPath();
    const gs = span > 9000 ? 2000 : span > 3600 ? 1000 : 500;
    const gn = Math.ceil(span / gs / 2) + 1;
    for (let g = -gn; g <= gn; g++) {
      const [px] = toPx(obs.x + g * gs, 0); ctx.moveTo(px, y); ctx.lineTo(px, y + h);
      const [, py] = toPx(0, obs.z + g * gs); ctx.moveTo(x, py); ctx.lineTo(x + w, py);
    }
    ctx.stroke();

    // wave fronts (cross-section of the expanding spheres with the listener's horizontal plane)
    for (const p of this.pulses) {
      const age = t - p.t;
      const R = c * age;
      const dy = p.y - obs.y;
      const rr = R * R - dy * dy;
      if (rr <= 0) continue;
      const rad = Math.sqrt(rr) * s;
      const [px, py] = toPx(p.x, p.z);
      if (rad > w * 3.2) continue;
      const a = Math.max(0, 1 - age / 18) * 0.85;
      ctx.strokeStyle = p.arrived ? `rgba(120,175,255,${a * 0.55})` : `rgba(90,215,255,${a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, TAU);
      ctx.stroke();
    }

    // Mach cone lines
    const f = this.focus;
    if (f && f.speed > c * 1.02) {
      const mu = Math.asin(c / f.speed);
      const hd = Math.atan2(f.vel.z, f.vel.x);
      const [jx, jy] = toPx(f.pos.x, f.pos.z);
      ctx.strokeStyle = 'rgba(255,190,110,0.9)';
      ctx.lineWidth = 2;
      for (const sg of [-1, 1]) {
        const a = hd + PI + sg * mu;
        ctx.beginPath();
        ctx.moveTo(jx, jy);
        ctx.lineTo(jx + Math.cos(a) * w * 1.6, jy + Math.sin(a) * w * 1.6);
        ctx.stroke();
      }
    }

    // jets
    for (const e of this.entries) {
      if (!e.isLeader) continue;
      const j = e.jet;
      const [jx, jy] = toPx(j.pos.x, j.pos.z);
      const hd = Math.atan2(j.vel.z, j.vel.x);
      ctx.save();
      ctx.translate(jx, jy);
      ctx.rotate(hd);
      ctx.fillStyle = j === this.focus ? '#ffd27a' : '#c9d6ea';
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-6, -5.5);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-6, 5.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // listener + arrival pings
    for (const pt of this.pings) {
      const k = (t - pt) / 0.5;
      ctx.strokeStyle = `rgba(125,255,176,${(1 - k) * 0.9})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 6 + k * 22, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = '#7dffb0';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, TAU);
    ctx.fill();
    ctx.restore();

    // text
    ctx.fillStyle = 'rgba(205,225,250,0.92)';
    ctx.font = '700 11.5px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SOUND WAVES  ·  top view', x + 12, y + 19);
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(160,185,220,0.85)';
    ctx.fillText('a new wave every 0.25 s', x + 12, y + 34);
    ctx.fillStyle = '#7dffb0';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', cx, cy + 20);
    const n = this.arrivals.length;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(125,255,176,0.95)';
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(`${(n / 1.6).toFixed(1)} waves/s reach you`, x + w - 12, y + 19);
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(160,185,220,0.85)';
    ctx.fillText('(emitted: 4.0 per second)', x + w - 12, y + 34);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(190,210,240,0.7)';
    ctx.fillText('waves bunch up ahead = higher pitch · stretch out behind = lower pitch', x + w / 2, y + h - 9);
    ctx.restore();
  }

  drawPitchGraph(ctx, x, y, w, h) {
    const t = this.graphNow;
    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = 'rgba(7,14,26,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,230,0.25)';
    ctx.stroke();
    const px = x + 38, py = y + 28, pw = w - 52, ph = h - 44;
    const ymin = Math.log2(0.25), ymax = Math.log2(5.0);
    const Y = (r) => py + ph * (1 - (Math.log2(clamp(r, 0.25, 5)) - ymin) / (ymax - ymin));
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (const r of [0.5, 1, 2, 4]) {
      const yy = Y(r);
      ctx.strokeStyle = r === 1 ? 'rgba(125,255,176,0.55)' : 'rgba(140,165,200,0.14)';
      ctx.setLineDash(r === 1 ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(px, yy);
      ctx.lineTo(px + pw, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = r === 1 ? '#7dffb0' : 'rgba(170,190,220,0.75)';
      ctx.fillText('×' + r, px - 6, yy + 3.5);
    }
    // curve
    const t0 = t - GRAPH_SPAN;
    ctx.strokeStyle = '#4cc9ff';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    let pen = false;
    let lastP = null;
    for (const g of this.graph) {
      if (!isFinite(g.r)) { pen = false; continue; }
      const gx = px + pw * ((g.t - t0) / GRAPH_SPAN);
      if (gx < px - 1) continue;
      const gy = Y(g.r);
      if (!pen) { ctx.moveTo(gx, gy); pen = true; } else ctx.lineTo(gx, gy);
      lastP = [gx, gy, g.r];
    }
    ctx.stroke();
    if (lastP) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(lastP[0], lastP[1], 4, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(205,225,250,0.92)';
    ctx.font = '700 11.5px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('PITCH YOU HEAR  vs  time', x + 12, y + 19);
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(160,185,220,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText('dashed line = the pitch the jet really makes', x + w - 12, y + 19);
    ctx.restore();
  }

  levelColor(db) {
    return db >= 120 ? '#ff5a4a' : db >= 100 ? '#ff9a3a' : db >= 85 ? '#ffd24a' : '#7dffb0';
  }

  /** Vertical gradient so colours always mean the same dB, wherever the bar or line is. */
  levelGradient(ctx, yTop, yBot, dbMin, dbMax) {
    const g = ctx.createLinearGradient(0, yBot, 0, yTop);
    const stops = [[30, '#2fd6a0'], [70, '#7dffb0'], [85, '#ffe066'], [100, '#ffa13a'], [120, '#ff5a4a'], [140, '#ff2d6f']];
    for (const [v, c] of stops) g.addColorStop(clamp((v - dbMin) / (dbMax - dbMin), 0, 1), c);
    return g;
  }

  /** Sound-level meter: the (simulated) real-world loudness of everything you can hear right now. */
  drawLevelMeter(ctx, x, y, w, h) {
    const db = this.levelDb, peak = this.peakDb;
    const have = isFinite(db);
    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = 'rgba(7,14,26,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,230,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(205,225,250,0.92)';
    ctx.font = '700 11.5px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('SOUND LEVEL', x + 14, y + 20);

    // big number
    ctx.font = '800 36px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = have ? this.levelColor(db) : 'rgba(170,190,220,0.55)';
    const num = have ? String(Math.round(db)) : '\u2014';
    ctx.fillText(num, x + 14, y + 58);
    const nw = ctx.measureText(num).width;
    ctx.font = '700 15px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(205,225,250,0.85)';
    ctx.fillText('dB', x + 14 + nw + 6, y + 58);

    // bar
    const bx = x + 16, by0 = y + 74, by1 = y + h - 64, bw = 24;
    const V = (v) => by1 - (by1 - by0) * clamp((v - 30) / 110, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(bx, by0, bw, by1 - by0);
    if (have) {
      ctx.fillStyle = this.levelGradient(ctx, by0, by1, 30, 140);
      const top = V(db);
      ctx.fillRect(bx, top, bw, by1 - top);
    }
    // reference scale
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    for (const [v, label, warn] of [[140, 'ear damage', 1], [120, 'pain threshold', 1], [100, 'chainsaw', 0], [85, 'hearing risk', 0], [60, 'conversation', 0], [40, 'quiet room', 0]]) {
      const yy = V(v);
      ctx.strokeStyle = 'rgba(190,210,240,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + bw, yy);
      ctx.lineTo(bx + bw + 6, yy);
      ctx.stroke();
      ctx.fillStyle = warn ? 'rgba(255,150,130,0.95)' : 'rgba(170,190,220,0.85)';
      ctx.textAlign = 'left';
      ctx.fillText(v + '  ' + label, bx + bw + 10, yy + 3.5);
    }
    // peak hold
    if (isFinite(peak)) {
      const yy = V(peak);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx - 4, yy);
      ctx.lineTo(bx + bw + 3, yy);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = isFinite(peak) ? this.levelColor(peak) : 'rgba(170,190,220,0.55)';
    ctx.fillText(isFinite(peak) ? 'PEAK ' + Math.round(peak) + ' dB' : 'PEAK \u2014', x + 14, y + h - 40);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(150,172,205,0.85)';
    ctx.fillText('Real-world level of the jet.', x + 14, y + h - 24);
    ctx.fillText('Your speakers play it far quieter.', x + 14, y + h - 11);
    ctx.restore();
  }

  /** Loudness (dB) against time - same time axis as the pitch graph above it. */
  drawLevelGraph(ctx, x, y, w, h) {
    const t = this.graphNow;
    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = 'rgba(7,14,26,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,190,230,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const px = x + 38, py = y + 28, pw = w - 52, ph = h - 44;
    const DBMIN = 40, DBMAX = 140;
    const Y = (db) => py + ph * (1 - (clamp(db, DBMIN, DBMAX) - DBMIN) / (DBMAX - DBMIN));
    // danger zones
    ctx.fillStyle = 'rgba(255,200,70,0.06)';
    ctx.fillRect(px, Y(100), pw, Y(85) - Y(100));
    ctx.fillStyle = 'rgba(255,140,50,0.08)';
    ctx.fillRect(px, Y(120), pw, Y(100) - Y(120));
    ctx.fillStyle = 'rgba(255,80,70,0.11)';
    ctx.fillRect(px, Y(140), pw, Y(120) - Y(140));
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (const v of [60, 85, 100, 120]) {
      const yy = Y(v);
      const special = v === 85 || v === 120;
      ctx.strokeStyle = v === 85 ? 'rgba(255,210,74,0.55)' : v === 120 ? 'rgba(255,100,80,0.55)' : 'rgba(140,165,200,0.14)';
      ctx.setLineDash(special ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(px, yy);
      ctx.lineTo(px + pw, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = v === 85 ? '#ffd24a' : v === 120 ? '#ff7a66' : 'rgba(170,190,220,0.75)';
      ctx.fillText(String(v), px - 6, yy + 3.5);
    }
    // curve
    const t0 = t - GRAPH_SPAN;
    ctx.strokeStyle = this.levelGradient(ctx, py, py + ph, DBMIN, DBMAX);
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false, last = null, best = null;
    for (const g of this.graph) {
      if (!isFinite(g.db) || g.db < DBMIN) { pen = false; continue; }
      const gx = px + pw * ((g.t - t0) / GRAPH_SPAN);
      if (gx < px - 1) continue;
      const gy = Y(g.db);
      if (!pen) { ctx.moveTo(gx, gy); pen = true; } else ctx.lineTo(gx, gy);
      last = [gx, gy, g.db];
      if (!best || g.db > best[2]) best = [gx, gy, g.db];
    }
    ctx.stroke();
    if (best && best[2] > 55) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(best[0], best[1], 4.5, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(Math.round(best[2]) + ' dB', clamp(best[0], px + 22, px + pw - 22), best[1] < py + 14 ? best[1] + 18 : best[1] - 9);
    }
    if (last && this.phase === 'flying') {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(last[0], last[1], 4, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(205,225,250,0.92)';
    ctx.font = '700 11.5px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SOUND LEVEL  vs  time', x + 12, y + 19);
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(160,185,220,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText('dB, real-world scale', x + w - 12, y + 19);
    ctx.restore();
  }

}

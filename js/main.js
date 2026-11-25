'use strict';
/* ==========================================================================
   main.js - application shell: renderer, input, menus, settings, main loop
   ========================================================================== */

const Settings = {
  data: { renderDist: 0, volume: 0.8, quality: 'med', weather: 'cloudy', hurricane: 'off', gfx: null, units: 'imperial', invert: false, assist: true, mouse: false, plane: 'fighter' },
  load() {
    try {
      const s = localStorage.getItem('afterburn.settings');
      if (s) Object.assign(this.data, JSON.parse(s));
    } catch (e) { /* storage may be blocked */ }
    // per-setting graphics levels (older saves only had a preset name)
    const idx = { low: 0, med: 1, high: 2, epic: 3, ultra: 4 };
    this.data.gfx = Object.assign(gfxPreset(idx[this.data.quality] !== undefined ? idx[this.data.quality] : 1), this.data.gfx || {});
    const m = /[?&]gfx=(low|med|high|epic|ultra)/.exec(location.search); // ?gfx=ultra forces a preset for this visit (handy for testing)
    if (m) this.data.gfx = gfxPreset(idx[m[1]]);
  },
  save() {
    try { localStorage.setItem('afterburn.settings', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  },
};

const App = {
  renderer: null, scene: null, camera: null, world: null, fx: null, audio: null,
  modes: {}, mode: null, modeName: 'loading',
  paused: false, time: 0,
  keys: {}, mouse: { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, locked: false },
  w: 1280, h: 720, dpr: 1,
  quality: QUALITY.med,
  debug: /[?&]debug/.test(location.search),
  fps: 60,
  toastTimer: 0,
  ready: false,
};

/* ---------- helpers ------------------------------------------------------------ */

const $id = (id) => document.getElementById(id);
window.App = App; // handy for debugging in the console

App.toast = function (msg, ms) {
  const el = $id('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(App.toastTimer);
  App.toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2400);
};

App.ensureAudio = function () {
  if (!App.audio) App.audio = new AudioEngine();
  App.audio.volume = Settings.data.volume;
  if (!App.audio.ok) App.audio.init();
  App.audio.resume();
  return App.audio.ok;
};

App.resize = function () {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.max(Math.min(window.devicePixelRatio || 1, App.quality.pixelRatio), App.quality.ss || 0);
  App.w = w; App.h = h; App.dpr = dpr;
  if (App.renderer) {
    App.renderer.setPixelRatio(dpr);
    App.renderer.setSize(w, h, false);
    App.camera.aspect = w / h;
    App.camera.updateProjectionMatrix();
  }
  const hud = $id('hud');
  hud.width = Math.floor(w * dpr);
  hud.height = Math.floor(h * dpr);
  App.hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

App.recording = null; // the latest flight recorded with G: {dt, n, d:[13 numbers per sample], kind, crash}
App.replayRec = null; // the recording the Replay Lab is showing (latest or a saved slot)

/* ---------- saved replays: three slots in the browser's storage ---------------------------------- */

const REPLAY_SLOTS = 3;
const ReplayStore = {
  key: 'afterburn.replays',
  slots: [null, null, null], // each: {kind, crash, n, dt, date, b64}
  load() {
    try {
      const s = localStorage.getItem(this.key);
      if (s) { const a = JSON.parse(s); for (let i = 0; i < REPLAY_SLOTS; i++) this.slots[i] = a[i] || null; }
    } catch (e) { /* storage may be blocked */ }
  },
  persist() {
    try { localStorage.setItem(this.key, JSON.stringify(this.slots)); return true; } catch (e) { return false; }
  },
  encode(rec) {
    const f = new Float32Array(rec.d), u = new Uint8Array(f.buffer);
    let str = '';
    for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return { kind: rec.kind || 'fighter', crash: rec.crash || null, wings: rec.wings || [], nukes: rec.nukes || [], n: rec.n, dt: rec.dt, date: Date.now(), b64: btoa(str) };
  },
  decode(slot) {
    const str = atob(slot.b64), u = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i);
    return { dt: slot.dt, n: slot.n, d: new Float32Array(u.buffer), kind: slot.kind, crash: slot.crash, wings: slot.wings || [], nukes: slot.nukes || [] };
  },
  save(i, rec) {
    const old = this.slots[i];
    this.slots[i] = this.encode(rec);
    if (!this.persist()) {
      // storage is full: the stored copy of the latest flight is the most expendable thing, so drop it and try once more
      try { localStorage.removeItem(this.latestKey); } catch (e) { /* ignore */ }
      if (!this.persist()) { this.slots[i] = old; return false; }
    }
    return true;
  },
  remove(i) { this.slots[i] = null; this.persist(); },
  /** the latest flight is also kept in storage, so a page refresh does not lose it */
  latestKey: 'afterburn.latest',
  saveLatest(rec) {
    try { localStorage.setItem(this.latestKey, JSON.stringify(this.encode(rec))); return true; } catch (e) { return false; }
  },
  loadLatest() {
    try {
      const s = localStorage.getItem(this.latestKey);
      return s ? this.decode(JSON.parse(s)) : null;
    } catch (e) { return null; }
  },
  any() { return this.slots.some(Boolean); },
};

function replayLabel(r) {
  const kind = (r.kind && PLANES[r.kind]) ? PLANES[r.kind].name : 'Fighter jet';
  return `${fmtTime((r.n - 1) * r.dt)}  \u00b7  ${kind}${r.crash ? '  \u00b7  ' + (r.crash.air ? 'shot down' : 'crashed') : ''}`;
}

App.renderReplays = function () {
  const list = $id('rp-list');
  list.innerHTML = '';
  const row = (cls, title, sub, buttons) => {
    const d = document.createElement('div');
    d.className = 'rp-row ' + cls;
    d.innerHTML = '<div><div class="t"></div><div class="s"></div></div><div class="b"></div>';
    d.querySelector('.t').textContent = title;
    d.querySelector('.s').textContent = sub;
    const b = d.querySelector('.b');
    for (const [label, fn, extra] of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (extra) btn.className = extra;
      btn.addEventListener('click', () => { if (App.audio && App.audio.ok) App.audio.click(); fn(); btn.blur(); });
      b.appendChild(btn);
    }
    list.appendChild(d);
  };
  const latest = App.recording;
  row('latest', 'Latest flight', latest ? replayLabel(latest) : 'nothing recorded yet \u2014 press G while flying',
    latest ? [['Watch', () => { App.replayRec = latest; App.closeModals(); App.launch('replay'); }, 'primary']] : []);
  for (let i = 0; i < REPLAY_SLOTS; i++) {
    const sl = ReplayStore.slots[i];
    const btns = [];
    if (sl) btns.push(['Watch', () => { App.replayRec = ReplayStore.decode(sl); App.closeModals(); App.launch('replay'); }, 'primary']);
    if (latest) {
      btns.push([sl ? 'Overwrite with latest' : 'Save latest here', () => {
        if (sl && !confirm(`Replace the replay in slot ${i + 1} with your latest flight?`)) return;
        if (ReplayStore.save(i, latest)) App.toast(`Saved to slot ${i + 1}`);
        else App.toast('Not enough browser storage to save this replay (delete one first)', 3600);
        App.renderReplays(); App.refreshReplayUI();
      }]);
    }
    if (sl) btns.push(['Delete', () => {
      if (!confirm(`Delete the replay in slot ${i + 1}?`)) return;
      ReplayStore.remove(i); App.toast(`Slot ${i + 1} deleted`); App.renderReplays(); App.refreshReplayUI();
    }, 'danger']);
    row('', `Slot ${i + 1}`, sl ? `${replayLabel(sl)}  \u00b7  ${new Date(sl.date).toLocaleString()}` : 'empty', btns);
  }
};

App.refreshReplayUI = function () {
  const r = App.recording, any = !!r || ReplayStore.any();
  for (const id of ['m-replay', 'p-replay']) { const el = $id(id); if (el) el.classList.toggle('dim', !any); }
  const pl = $id('m-plane');
  if (pl) pl.textContent = 'Free Flight aircraft: ' + (PLANES[Settings.data.plane] ? PLANES[Settings.data.plane].name : 'Fighter jet');
  const sub = $id('m-replay-sub');
  const saved = ReplayStore.slots.filter(Boolean).length;
  if (sub) sub.textContent = any
    ? `${r ? 'Your latest ' + fmtTime((r.n - 1) * r.dt) + ' flight' : 'Saved replays'}${saved ? ' \u00b7 ' + saved + ' of ' + REPLAY_SLOTS + ' slots used' : ''}. Watch it from anywhere on the ground.`
    : 'Press G while flying to record. Then watch it from anywhere on the ground, with Doppler sound.';
};

/* ---------- mode management --------------------------------------------------- */

App.showOverlay = function (id, on) {
  $id(id).classList.toggle('hidden', !on);
};

App.startMode = function (name, opts) {
  if (App.audio && App.audio.ok) App.audio.stopAll(); // no crash roar or delayed explosion carries over into the next screen
  if (App.mode && App.mode.recOn) App.mode.stopRecording(); // keep a flight that was still being recorded
  if (name === 'replay' && !App.recording) {
    App.toast('Nothing recorded yet — press G while flying to record', 3200);
    return;
  }
  if (App.mode) App.mode.exit();
  App.setPaused(false, true);
  App.showOverlay('gameover', false);
  App.modeName = name;
  if (document.pointerLockElement) document.exitPointerLock();
  if (name === 'menu') {
    App.mode = App.modes.watch;
    App.mode.enter(false);
    App.showOverlay('menu', true);
  } else if (name === 'replay') {
    App.ensureAudio();
    App.showOverlay('menu', false);
    App.mode = App.modes.replay;
    App.mode.enter();
  } else if (name === 'watch') {
    App.ensureAudio();
    App.showOverlay('menu', false);
    App.mode = App.modes.watch;
    App.mode.enter(true);
  } else {
    App.ensureAudio();
    App.showOverlay('menu', false);
    App.mode = App.modes.fly;
    App.mode.enter(name);
  }
};

/** start a mode from a menu button: the loading screen is shown first (and painted) so a slow computer does not look frozen while the scene is built */
App.launch = function (name) {
  if (App.launching) return;
  App.launching = true;
  const el = $id('loading'), p = el.querySelector('p'), old = p ? p.textContent : '';
  if (p) p.textContent = name === 'free' ? 'Starting free flight...' : name === 'fly' ? 'Starting dogfight...' : name === 'replay' ? 'Loading the replay...' : 'Starting...';
  el.classList.remove('hidden');
  requestAnimationFrame(() => setTimeout(() => {
    try { App.startMode(name === 'fly' ? 'dogfight' : name); } catch (e) {
      App.frameError('starting ' + name, e);
      try { App.startMode('menu'); } catch (e2) { /* nothing more to do */ }
    } finally { el.classList.add('hidden'); if (p) p.textContent = old; App.launching = false; }
  }, 40));
};

App.setPaused = function (p, silent) {
  if (App.paused === p) return;
  if (p && (App.modeName === 'menu' || App.modeName === 'loading')) return;
  App.paused = p;
  App.showOverlay('pause', p);
  if (App.audio && App.audio.ok) App.audio.setPaused(p);
  if (p && document.pointerLockElement) document.exitPointerLock();
};

App.restart = function () {
  const name = App.modeName;
  App.startMode(name);
};

App.openModal = function (which) {
  $id('modal-' + which).classList.remove('hidden');
  if (which === 'settings') syncSettingsUI();
};

App.closeModals = function () {
  let any = false;
  for (const id of ['modal-controls', 'modal-settings', 'modal-replays']) {
    const el = $id(id);
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); any = true; }
  }
  return any;
};

/* ---------- settings UI ----------------------------------------------------------- */

/* ---------- graphics settings: a preset plus a level for each individual setting ---------------------- */

const GFX_UI = [
  ['g-res', 'res', GFX_LEVELS],
  ['g-shadows', 'shadows', ['Off', 'Medium', 'High', 'Epic', 'Ultra']],
  ['g-terrain', 'terrain', GFX_LEVELS],
  ['g-trees', 'trees', GFX_LEVELS],
  ['g-clouds', 'clouds', GFX_LEVELS],
  ['g-particles', 'particles', GFX_LEVELS],
  ['g-crash', 'crash', GFX_LEVELS],
  ['g-plane', 'plane', GFX_LEVELS],
];
const GFX_PRESET_NAMES = ['low', 'med', 'high', 'epic', 'ultra'];

function readGfx() {
  const g = {};
  for (const [id, key] of GFX_UI) g[key] = parseInt($id(id).value, 10);
  g.aa = $id('g-aa').checked;
  return g;
}

function gfxSame(a, b) { return Object.keys(a).every((k) => a[k] === b[k]); }

function presetNameOf(g) {
  for (let i = 0; i < 5; i++) if (gfxSame(g, gfxPreset(i))) return GFX_PRESET_NAMES[i];
  return 'custom';
}

function syncGfxUI() {
  const d = Settings.data;
  if (!$id('g-res').options.length) {
    for (const [id, , names] of GFX_UI) {
      const sel = $id(id);
      names.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; sel.appendChild(o); });
    }
  }
  for (const [id, key] of GFX_UI) $id(id).value = d.gfx[key];
  $id('g-aa').checked = !!d.gfx.aa;
  $id('s-quality').value = presetNameOf(d.gfx);
  $id('s-apply').classList.add('hidden');
}

function bindGfx() {
  const d = Settings.data;
  const dirty = () => {
    const g = readGfx();
    $id('s-quality').value = presetNameOf(g);
    $id('s-apply').classList.toggle('hidden', gfxSame(g, d.gfx));
  };
  $id('s-quality').addEventListener('change', () => {
    const i = GFX_PRESET_NAMES.indexOf($id('s-quality').value);
    if (i >= 0) {
      const g = gfxPreset(i);
      $id('s-dist').value = GFX.dist[i]; $id('s-dist-o').textContent = GFX.dist[i] + ' km'; d.renderDist = GFX.dist[i]; Settings.save(); // a preset brings its own render distance (it can then be changed)
      if (App.world) App.world.setViewDistance(GFX.dist[i]);
      for (const [id, key] of GFX_UI) $id(id).value = g[key];
      $id('g-aa').checked = g.aa;
    }
    dirty();
    $id('s-quality').blur();
  });
  for (const [id] of GFX_UI) $id(id).addEventListener('change', () => { dirty(); $id(id).blur(); });
  $id('g-aa').addEventListener('change', () => { dirty(); $id('g-aa').blur(); });
  $id('s-apply').addEventListener('click', () => {
    d.gfx = readGfx();
    d.quality = presetNameOf(d.gfx);
    Settings.save();
    App.toast('Applying graphics settings...');
    setTimeout(() => location.reload(), 350);
  });
}

function syncSettingsUI() {
  const d = Settings.data;
  $id('s-volume').value = d.volume;
  $id('s-volume-o').textContent = Math.round(d.volume * 100) + '%';
  syncGfxUI();
  $id('s-units').value = d.units;
  $id('s-weather').value = d.weather;
  $id('s-hurricane').value = d.hurricane;
  $id('s-invert').checked = d.invert;
  $id('s-assist').checked = d.assist;
  $id('s-mouse').checked = d.mouse;
  const rd = d.renderDist || (App.quality && App.quality.dist) || 52;
  $id('s-dist').value = rd;
  $id('s-dist-o').textContent = rd + ' km';
}

function bindSettings() {
  const d = Settings.data;
  $id('s-volume').addEventListener('input', () => {
    d.volume = parseFloat($id('s-volume').value);
    $id('s-volume-o').textContent = Math.round(d.volume * 100) + '%';
    if (App.audio && App.audio.ok) App.audio.setVolume(d.volume);
    Settings.save();
  });
  bindGfx();
  $id('s-dist').addEventListener('input', () => { // live: no reload needed
    d.renderDist = parseInt($id('s-dist').value, 10);
    $id('s-dist-o').textContent = d.renderDist + ' km';
    if (App.world) App.world.setViewDistance(d.renderDist);
    Settings.save();
  });
  // when "Advanced graphics" is opened, scroll the settings window so the whole list is in view (it can be taller than a small screen)
  const adv = document.querySelector('details.adv');
  if (adv) adv.addEventListener('toggle', () => { if (adv.open) requestAnimationFrame(() => adv.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); });
  $id('s-weather').addEventListener('change', () => { d.weather = $id('s-weather').value; Settings.save(); if (App.world) App.world.weather.setMode(d.weather); $id('s-weather').blur(); });
  $id('s-hurricane').addEventListener('change', () => { d.hurricane = $id('s-hurricane').value; Settings.save(); if (App.world) App.world.weather.setHurricane(d.hurricane === 'on'); $id('s-hurricane').blur(); const hi = d.hurricane === 'on' && App.world.weather.hurricaneInfo(App.camera.position.x, App.camera.position.z);
    App.toast(hi ? `A hurricane has formed ${(hi.dist / 1000).toFixed(0)} km to the ${hi.name} \u2014 follow the blue marker on screen and the H on the radar` : 'Hurricane removed', 5200); });
  $id('s-units').addEventListener('change', () => { d.units = $id('s-units').value; Settings.save(); });
  for (const [id, key] of [['s-invert', 'invert'], ['s-assist', 'assist'], ['s-mouse', 'mouse']]) {
    $id(id).addEventListener('change', () => { d[key] = $id(id).checked; Settings.save(); $id(id).blur(); });
  }
}

/* ---------- input -------------------------------------------------------------------- */

function typingTarget(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' || t.tagName === 'TEXTAREA');
}

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (typingTarget(e)) return;
    if (e.code === 'Escape') {
      if (App.closeModals()) { e.preventDefault(); return; }
      const playing = App.modeName !== 'menu' && App.modeName !== 'loading';
      const gameOverShown = !$id('gameover').classList.contains('hidden');
      if (playing && !gameOverShown) App.setPaused(!App.paused);
      e.preventDefault();
      return;
    }
    if (!e.repeat) App.keys[e.code] = true;
    if (App.modeName === 'menu' || App.modeName === 'loading') return;
    if (e.code === 'KeyP') { App.setPaused(!App.paused); e.preventDefault(); return; }
    if (App.paused) return;
    if (App.mode && App.mode.onKey && !e.repeat) {
      if (App.mode.onKey(e.code, true, e)) e.preventDefault();
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    App.keys[e.code] = false;
    if (App.mode && App.mode.onKey && !App.paused) App.mode.onKey(e.code, false, e);
  });
  window.addEventListener('blur', () => {
    App.keys = {};
    if (App.modeName === 'dogfight' || App.modeName === 'free') {
      if (App.mode && App.mode.alive !== false && !App.paused) App.setPaused(true);
    }
  });

  const gl = $id('gl');
  gl.addEventListener('contextmenu', (e) => e.preventDefault());
  gl.addEventListener('mousedown', (e) => {
    App.mouse.buttons = e.buttons;
    App.mouse.drag = e.button === 0; // a look-drag only counts if it began on the 3D view
    App.mouse.x = e.clientX; App.mouse.y = e.clientY;
    if (App.paused || App.modeName === 'menu') return;
    if (App.mode && App.mode.onMouseDown) App.mode.onMouseDown(e);
  });
  window.addEventListener('mouseup', (e) => {
    App.mouse.buttons = e.buttons;
    if (!(e.buttons & 1)) App.mouse.drag = false;
    if (App.mode && App.mode.onMouseUp) App.mode.onMouseUp(e);
  });
  window.addEventListener('mousemove', (e) => {
    const locked = !!document.pointerLockElement;
    const dx = locked ? e.movementX : e.clientX - App.mouse.x;
    const dy = locked ? e.movementY : e.clientY - App.mouse.y;
    App.mouse.x = e.clientX; App.mouse.y = e.clientY;
    App.mouse.dx += dx; App.mouse.dy += dy;
    if (App.paused || App.modeName === 'menu') return;
    if ((e.buttons & 1) && App.mouse.drag && App.mode && App.mode.onDrag && !locked) App.mode.onDrag(dx, dy, e);
  });
  gl.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (App.paused || App.modeName === 'menu') return;
    if (App.mode && App.mode.onWheel) App.mode.onWheel(e.deltaY, e);
  }, { passive: false });
  document.addEventListener('pointerlockchange', () => {
    App.mouse.locked = !!document.pointerLockElement;
    if (!App.mouse.locked && (App.modeName === 'dogfight' || App.modeName === 'free') && Settings.data.mouse && App.mode && App.mode.alive !== false) {
      App.setPaused(true);
    }
  });
  window.addEventListener('resize', () => App.resize());
}

function bindMenus() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-close]');
    if (!t) return;
    if (App.audio && App.audio.ok) App.audio.click();
    if (t.hasAttribute('data-close')) { App.closeModals(); return; }
    switch (t.dataset.act) {
      case 'fly': App.launch('fly'); break;
      case 'free': App.launch('free'); break;
      case 'watch': App.launch('watch'); break;
      case 'replay':
        if (!App.recording && !ReplayStore.any()) App.toast('Nothing recorded yet \u2014 press G while flying to record', 3200);
        else { App.renderReplays(); App.openModal('replays'); }
        break;
      case 'plane':
        { const order = ['fighter', 'c17', 'b737', 'b747', 'b2']; Settings.data.plane = order[(order.indexOf(Settings.data.plane) + 1) % order.length]; }
        Settings.save();
        App.refreshReplayUI();
        break;
      case 'controls': App.openModal('controls'); break;
      case 'settings': App.openModal('settings'); break;
      case 'resume': App.setPaused(false); break;
      case 'restart': App.restart(); break;
      case 'menu': App.startMode('menu'); break;
    }
    t.blur();
  });
}

/* ---------- main loop ---------------------------------------------------------------- */

let _last = 0;
let _fpsAcc = 0, _fpsN = 0;

/** a script error inside the frame loop: keep running, log it, and tell the player once per kind of error (so it can be reported) */
App.errors = {};
App.frameError = function (where, e) {
  const key = where + ': ' + (e && e.message);
  App.errors[key] = (App.errors[key] || 0) + 1;
  if (App.errors[key] === 1) {
    console.error('[game] error in ' + where, e);
    const loc = e && e.stack ? (String(e.stack).split(/\r?\n/)[1] || '').trim().slice(-60) : '';
    App.toast('Error in ' + where + ': ' + (e && e.message ? e.message : e) + (loc ? ' (' + loc + ')' : ''), 9000);
  }
};

function frame(now) {
  requestAnimationFrame(frame);
  if (!App.ready) return;
  let dt = (now - _last) / 1000;
  _last = now;
  if (!(dt > 0)) dt = 0.016;
  dt = Math.min(dt, 0.05);
  _fpsAcc += dt; _fpsN++;
  if (_fpsAcc > 0.5) { App.fps = _fpsN / _fpsAcc; _fpsAcc = 0; _fpsN = 0; }

  if (!App.paused) {
    App.time += dt;
    // each part is guarded: an error in one of them must not stop the picture from being drawn (that looked like a frozen game)
    try { App.mode.update(dt); } catch (e) { App.frameError('update', e); }
    try { App.world.update(App.camera, dt); } catch (e) { App.frameError('world', e); }
    try { App.fx.update(dt, App.camera, App.renderer.domElement.height); } catch (e) { App.frameError('effects', e); }
  }
  App.renderer.render(App.scene, App.camera);

  const ctx = App.hudCtx;
  ctx.clearRect(0, 0, App.w, App.h);
  try {
    if (App.mode && App.mode.drawHUD) App.mode.drawHUD(ctx, App.w, App.h);
    if (App.world && App.world.weather && !App.paused) App.world.weather.drawOverlay(ctx, App.w, App.h);
  } catch (e) { App.frameError('hud', e); }
  if (App.debug) {
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    const r = App.renderer.info.render;
    ctx.fillText(`${App.fps.toFixed(0)} fps  ${r.calls} calls  ${(r.triangles / 1000).toFixed(0)}k tris  chunks ${App.world.terrain.stats.visible}`, App.w - 10, App.h - 10);
  }
  App.mouse.dx = 0; App.mouse.dy = 0;
}

/* ---------- boot ------------------------------------------------------------------------ */

/** a page that was cached from before the build loader existed has no BUILD: it replaces itself, once, with a fresh copy (a unique address cannot come from any cache) */
(function () {
  if (typeof BUILD !== 'undefined' || location.protocol === 'file:') return;
  let tried = false;
  try { tried = sessionStorage.getItem('oldPageHeal') === '1'; sessionStorage.setItem('oldPageHeal', '1'); } catch (e) { tried = true; }
  if (!tried) location.replace(location.pathname + '?fresh=' + Date.now());
})();

function boot() {
  Settings.load();
  App.quality = buildQuality(Settings.data.gfx);
  App.hudCtx = $id('hud').getContext('2d');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $id('gl'), antialias: App.quality.aa, powerPreference: 'high-performance' });
  } catch (err) {
    $id('loading').innerHTML = '<p style="max-width:28em;text-align:center">WebGL is not available in this browser, so the 3D world cannot start. Try a recent Chrome, Edge or Firefox with hardware acceleration enabled.</p>';
    return;
  }
  App.renderer = renderer;
  renderer.localClippingEnabled = true; // a broken-off wing is cut away from the model with a clipping plane
  renderer.shadowMap.enabled = !!App.quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  App.scene = new THREE.Scene();
  App.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 2, 60000);
  App.camera.rotation.order = 'YXZ';
  App.world = new World(App.scene, App.quality);
  App.world.setViewDistance(Settings.data.renderDist || App.quality.dist || 52);
  App.fx = new Effects(App.scene, App.quality);
  App.fx.ground = (x, z) => App.world.groundTop(x, z);
  App.resize();

  App.modes.watch = new WatchMode(App);
  App.modes.fly = new FlyMode(App);
  App.modes.replay = new ReplayMode(App);
  bindInput();
  bindMenus();
  bindSettings();

  ReplayStore.load();
  App.recording = ReplayStore.loadLatest(); // your last flight survives a refresh
  App.refreshReplayUI();
  // warm-up: the first time free flight starts, the graphics driver compiles a batch of new shaders and uploads textures (seconds on a slow
  // computer). Do that now, behind the loading screen, so the first real flight does not freeze.
  App._warming = true;
  try {
    App.startMode('free');
    for (let i = 0; i < 3; i++) { App.world.update(App.camera, 1 / 30); App.mode.update(1 / 30); App.fx.update(1 / 30, App.camera, App.renderer.domElement.height); App.renderer.render(App.scene, App.camera); }
  } catch (e) { console.warn('warm-up skipped', e); }
  App._warming = false;
  App.ready = true;
  { // a small build label on the menu, so it is easy to see which copy of the game a computer is really running
    const lab = document.createElement('div');
    lab.textContent = 'build ' + (typeof BUILD !== 'undefined' ? BUILD : 'old');
    lab.style.cssText = 'position:fixed;right:8px;bottom:6px;font:11px system-ui,sans-serif;color:rgba(255,255,255,.45);z-index:5;pointer-events:none;';
    document.body.appendChild(lab);
  }
  App.startMode('menu');
  $id('loading').classList.add('hidden');
  setTimeout(() => { try { if (!App.audio) App.audio = new AudioEngine(); App.audio.volume = Settings.data.volume; if (!App.audio.ok) App.audio.init(); } catch (e) { /* audio is set up again when a mode starts */ } }, 1500);
  requestAnimationFrame((t) => { _last = t; frame(t); });
}

window.addEventListener('load', () => {
  // let the loading overlay paint before the (synchronous) world build
  setTimeout(boot, 60);
});

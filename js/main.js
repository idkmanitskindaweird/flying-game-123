'use strict';
/* ==========================================================================
   main.js - application shell: renderer, input, menus, settings, main loop
   ========================================================================== */

const Settings = {
  data: { volume: 0.8, quality: 'med', units: 'imperial', invert: false, assist: true, mouse: false, plane: 'fighter' },
  load() {
    try {
      const s = localStorage.getItem('afterburn.settings');
      if (s) Object.assign(this.data, JSON.parse(s));
    } catch (e) { /* storage may be blocked */ }
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
  const dpr = Math.min(window.devicePixelRatio || 1, App.quality.pixelRatio);
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

App.recording = null; // the last flight recorded with G: {dt, n, d:[13 numbers per sample]}
App.refreshReplayUI = function () {
  const r = App.recording;
  for (const id of ['m-replay', 'p-replay']) { const el = $id(id); if (el) el.classList.toggle('dim', !r); }
  const pl = $id('m-plane');
  if (pl) pl.textContent = 'Free Flight aircraft: ' + (PLANES[Settings.data.plane] ? PLANES[Settings.data.plane].name : 'Fighter jet');
  const sub = $id('m-replay-sub');
  if (sub) sub.textContent = r
    ? `Your ${fmtTime((r.n - 1) * r.dt)} recording. Stand anywhere on the ground and hear it fly past.`
    : 'Press G while flying to record. Then watch it from anywhere on the ground, with Doppler sound.';
};

/* ---------- mode management --------------------------------------------------- */

App.showOverlay = function (id, on) {
  $id(id).classList.toggle('hidden', !on);
};

App.startMode = function (name, opts) {
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
  for (const id of ['modal-controls', 'modal-settings']) {
    const el = $id(id);
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); any = true; }
  }
  return any;
};

/* ---------- settings UI ----------------------------------------------------------- */

function syncSettingsUI() {
  const d = Settings.data;
  $id('s-volume').value = d.volume;
  $id('s-volume-o').textContent = Math.round(d.volume * 100) + '%';
  $id('s-quality').value = d.quality;
  $id('s-units').value = d.units;
  $id('s-invert').checked = d.invert;
  $id('s-assist').checked = d.assist;
  $id('s-mouse').checked = d.mouse;
}

function bindSettings() {
  const d = Settings.data;
  $id('s-volume').addEventListener('input', () => {
    d.volume = parseFloat($id('s-volume').value);
    $id('s-volume-o').textContent = Math.round(d.volume * 100) + '%';
    if (App.audio && App.audio.ok) App.audio.setVolume(d.volume);
    Settings.save();
  });
  $id('s-quality').addEventListener('change', () => {
    const was = d.quality;
    d.quality = $id('s-quality').value;
    Settings.save();
    if (was !== d.quality) {
      App.toast('Applying graphics quality...');
      setTimeout(() => location.reload(), 350);
    }
  });
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
      case 'fly': App.startMode('dogfight'); break;
      case 'free': App.startMode('free'); break;
      case 'watch': App.startMode('watch'); break;
      case 'replay': App.startMode('replay'); break;
      case 'plane':
        { const order = ['fighter', 'c17', 'b737', 'b747']; Settings.data.plane = order[(order.indexOf(Settings.data.plane) + 1) % order.length]; }
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
    App.mode.update(dt);
    App.world.update(App.camera, dt);
    App.fx.update(dt, App.camera, App.renderer.domElement.height);
  }
  App.renderer.render(App.scene, App.camera);

  const ctx = App.hudCtx;
  ctx.clearRect(0, 0, App.w, App.h);
  if (App.mode && App.mode.drawHUD) App.mode.drawHUD(ctx, App.w, App.h);
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

function boot() {
  Settings.load();
  App.quality = QUALITY[Settings.data.quality] || QUALITY.med;
  App.hudCtx = $id('hud').getContext('2d');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $id('gl'), antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    $id('loading').innerHTML = '<p style="max-width:28em;text-align:center">WebGL is not available in this browser, so the 3D world cannot start. Try a recent Chrome, Edge or Firefox with hardware acceleration enabled.</p>';
    return;
  }
  App.renderer = renderer;
  renderer.shadowMap.enabled = !!App.quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  App.scene = new THREE.Scene();
  App.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 2, 60000);
  App.camera.rotation.order = 'YXZ';
  App.world = new World(App.scene, App.quality);
  App.fx = new Effects(App.scene, App.quality);
  App.resize();

  App.modes.watch = new WatchMode(App);
  App.modes.fly = new FlyMode(App);
  App.modes.replay = new ReplayMode(App);
  bindInput();
  bindMenus();
  bindSettings();

  App.refreshReplayUI();
  App.ready = true;
  App.startMode('menu');
  $id('loading').classList.add('hidden');
  requestAnimationFrame((t) => { _last = t; frame(t); });
}

window.addEventListener('load', () => {
  // let the loading overlay paint before the (synchronous) world build
  setTimeout(boot, 60);
});

'use strict';
/* ==========================================================================
   audio.js - procedural sound with physically based Doppler shift

   Every external jet is a moving sound source. Sound travels at c = 343 m/s, so
   what you hear at time t was emitted at an earlier time te, from where the jet
   WAS. We solve   c * (t - te) = | x_src(te) - x_listener(t) |   (retarded time)
   from a recorded position history of the jet, then apply the exact Doppler
   factor
        f_heard / f_emitted = (c + u.v_listener) / (c + u.v_source)
   where u is the unit vector from the listener to the source (at emission).
   For supersonic sources the first root only exists once the Mach cone has swept
   over the listener - that moment triggers a sonic boom.
   ========================================================================== */

const _hp = { x: 0, y: 0, z: 0 };

function _distAt(hist, t, tau, Lx, Ly, Lz) {
  hist.at(t - tau, _hp);
  const dx = _hp.x - Lx, dy = _hp.y - Ly, dz = _hp.z - Lz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Solve the retarded time. Writes {ok, tau, d, x,y,z, vx,vy,vz} (source state at
 * emission) into `out` and returns out.ok. `guess` is the previous tau (warm start).
 */
function solveRetarded(hist, t, Lx, Ly, Lz, c, guess, out) {
  out.ok = false;
  if (hist.n < 2) return false;
  let tau = guess > 0 ? guess : _distAt(hist, t, 0, Lx, Ly, Lz) / c;
  let found = false;
  const e = 0.02;
  for (let it = 0; it < 10; it++) {
    const d = _distAt(hist, t, tau, Lx, Ly, Lz);
    const h = c * tau - d;
    if (Math.abs(h) < 0.0015 * c) { found = true; break; }
    const tm = Math.max(0, tau - e);
    const dD = (_distAt(hist, t, tau + e, Lx, Ly, Lz) - _distAt(hist, t, tm, Lx, Ly, Lz)) / (tau + e - tm);
    const hp = c - dD;
    if (hp < 0.1 * c) break; // near or beyond the Mach cone: fall back to scanning
    tau -= h / hp;
    if (tau < 0) tau = 0;
    if (tau > 165) break;
  }
  if (!found) {
    // first sign change of h(tau) = c*tau - D(tau), scanning outward (fine steps first, coarse far back in time)
    let prev = 0;
    const maxTau = 165;
    for (let s = 0.08; s <= maxTau; s += s < 12 ? 0.08 : 0.4) {
      if (c * s - _distAt(hist, t, s, Lx, Ly, Lz) >= 0) {
        let lo = prev, hi = s;
        for (let k = 0; k < 22; k++) {
          const mid = 0.5 * (lo + hi);
          if (c * mid - _distAt(hist, t, mid, Lx, Ly, Lz) >= 0) hi = mid;
          else lo = mid;
        }
        tau = hi;
        found = true;
        break;
      }
      prev = s;
    }
  }
  if (!found) return false;

  const te = t - tau;
  hist.at(te, _hp);
  out.x = _hp.x; out.y = _hp.y; out.z = _hp.z;
  // source velocity at emission (central difference, clamped to stored range)
  const eps = 0.05;
  const t2 = Math.min(te + eps, hist.lastT);
  const t1 = te - eps;
  hist.at(t1, _hp);
  const x1 = _hp.x, y1 = _hp.y, z1 = _hp.z;
  hist.at(t2, _hp);
  const dtv = Math.max(t2 - t1, 1e-3);
  out.vx = (_hp.x - x1) / dtv; out.vy = (_hp.y - y1) / dtv; out.vz = (_hp.z - z1) / dtv;
  const dx = out.x - Lx, dy = out.y - Ly, dz = out.z - Lz;
  out.d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out.tau = tau;
  out.ok = true;
  return true;
}

/**
 * Is the listener inside the jet's Mach cone (the region behind the shock where its sound can be heard)?
 * Always true for subsonic jets. For a supersonic jet nothing at all is heard ahead of the cone.
 */
function inMachCone(jet, L, c) {
  const v = jet.vel, sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (sp <= c * 1.0) return true;
  const wx = L.x - jet.pos.x, wy = L.y - jet.pos.y, wz = L.z - jet.pos.z;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
  const cosA = -(wx * v.x + wy * v.y + wz * v.z) / (wl * sp); // angle between 'behind the jet' and the listener
  return cosA >= Math.sqrt(1 - (c / sp) * (c / sp));
}

/** Doppler ratio f_heard / f_emitted for an emission state `s` (from solveRetarded). `k` scales velocities (0 = off). */
function dopplerRatio(s, Lx, Ly, Lz, Lvx, Lvy, Lvz, c, k) {
  const dx = s.x - Lx, dy = s.y - Ly, dz = s.z - Lz;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const vL = (Lvx * ux + Lvy * uy + Lvz * uz) * k;
  const vS = (s.vx * ux + s.vy * uy + s.vz * uz) * k;
  let den = c + vS;
  if (den < 0.12 * c) den = 0.12 * c;
  return clamp((c + vL) / den, 0.2, 4.5);
}

/**
 * Approximate REAL-WORLD sound level (dB SPL) of a jet engine, heard `d` metres from the place the jet was
 * when the sound left it. thr: throttle 0..1, ab: afterburner 0..1, cosPhi: +1 when the jet points straight
 * at the listener, -1 when it points away. Inverse-distance law (-6 dB per doubling of distance) plus a little
 * air absorption; the exhaust roar is louder behind the jet than in front of it.
 * (Playback is NOT this loud - that would hurt - it is just scaled to follow it.)
 */
function jetSPL(thr, ab, d, cosPhi) {
  const at100 = 103 + 23 * Math.pow(clamp(thr, 0, 1), 0.8) + 8 * ab; // dB at 100 m: ~126 at full dry power, ~134 with afterburner
  const dd = Math.max(d, 8);
  return Math.min(150, at100 - 1 - 4 * cosPhi - 20 * Math.log10(dd / 100) - 0.0025 * dd);
}

/* ---------- small helpers ------------------------------------------------------ */

function _set(param, v, now, tc) {
  if (!isFinite(v)) return;
  param.setTargetAtTime(v, now, tc === undefined ? 0.035 : tc);
}

function _makeNoiseBuffer(ctx, type, seconds) {
  const sr = ctx.sampleRate;
  const N = Math.floor(sr * seconds);
  const F = Math.floor(sr * 0.25); // cross-fade region so the loop is seamless
  const raw = new Float32Array(N + F);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'white') raw[i] = w * 0.5;
    else if (type === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.12;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last * 3.2;
    }
  }
  const buf = ctx.createBuffer(1, N, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < N; i++) d[i] = raw[i];
  for (let i = 0; i < F; i++) {
    const a = (i / F) * (PI / 2);
    d[i] = raw[i] * Math.sin(a) + raw[N + i] * Math.cos(a);
  }
  return buf;
}

/* ==========================================================================
   AudioEngine
   ========================================================================== */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.volume = 0.8;
    this.dopplerK = 1.0; // Doppler strength: 0 = off, 1 = physical, >1 exaggerated
    this.c = SPEED_OF_SOUND;
    this.voices = [];
    this.lastUpdateReal = 0;
    this.master = null;
    this.suspended = false;
    this.listenerVel = { x: 0, y: 0, z: 0 };
    this.stats = { rms: 0 };
    this.onBoom = null;
    this.throttle = true; // limit parameter updates to ~45 Hz (disabled in offline tests)
    this._lastU = 0;
  }

  /** Create the audio graph. Must be called from a user gesture (or pass an OfflineAudioContext). */
  init(ctxOverride) {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = ctxOverride || new AC({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('Web Audio unavailable', e);
      return false;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.28;
    this.bus = ctx.createGain(); // spatial voices
    this.sfx = ctx.createGain(); // flat effects
    this.sfx.gain.value = 0.9;
    this.bus.connect(this.comp);
    this.sfx.connect(this.comp);
    this.comp.connect(this.master);
    // soft clipper keeps loud passes from hard-clipping
    this.clip = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.25) / Math.tanh(1.25);
    }
    this.clip.curve = curve;
    this.master.connect(this.clip);
    this.clip.connect(ctx.destination);
    this.analyser = ctx.createAnalyser ? ctx.createAnalyser() : null;
    if (this.analyser) {
      this.analyser.fftSize = 1024;
      this.master.connect(this.analyser);
      this._abuf = new Float32Array(this.analyser.fftSize);
    }
    this.noise = {
      white: _makeNoiseBuffer(ctx, 'white', 3),
      pink: _makeNoiseBuffer(ctx, 'pink', 4),
      brown: _makeNoiseBuffer(ctx, 'brown', 4),
    };
    this.ok = true;
    return true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
  }

  setPaused(p) {
    if (!this.ctx || !this.ctx.suspend) return;
    if (p) this.ctx.suspend();
    else this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) _set(this.master.gain, v, this.ctx.currentTime, 0.05);
  }

  /** Level meter (RMS of master output), used by the UI. */
  meter() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._abuf);
    let s = 0;
    for (let i = 0; i < this._abuf.length; i++) s += this._abuf[i] * this._abuf[i];
    return Math.sqrt(s / this._abuf.length);
  }

  /** Orient the AudioListener. Positions are given relative to the listener, so it stays at the origin. */
  setListener(fwd, up) {
    if (!this.ok) return;
    const l = this.ctx.listener;
    if (l.forwardX) {
      l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else if (l.setOrientation) {
      l.setPosition(0, 0, 0);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** Drive all spatial voices. t = simulation time, L = {x,y,z,vx,vy,vz}. */
  update(t, L, fwd, up) {
    if (!this.ok) return;
    if (this.throttle) {
      const now = performance.now();
      if (now - this._lastU < 22) return;
      this._lastU = now;
    }
    this.setListener(fwd, up);
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.dead) {
        this.voices.splice(i, 1);
        continue;
      }
      v.update(t, L);
    }
  }

  addJetVoice(jet) {
    if (!this.ok) return null;
    const v = new ExternalJetVoice(this, jet);
    this.voices.push(v);
    return v;
  }

  addMissileVoice(src) {
    if (!this.ok) return null;
    const v = new MissileVoice(this, src);
    this.voices.push(v);
    return v;
  }

  removeVoice(v, fadeTc) {
    if (v) v.stop(false, fadeTc);
  }

  clearVoices() {
    for (const v of this.voices) v.stop(true);
    this.voices.length = 0;
  }

  /* ----- one-shot effects ------------------------------------------------- */

  _panner(rel) {
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 10;
    p.rolloffFactor = 0;
    const d = Math.sqrt(rel.x * rel.x + rel.y * rel.y + rel.z * rel.z) || 1;
    const k = 10 / d;
    if (p.positionX) {
      p.positionX.value = rel.x * k; p.positionY.value = rel.y * k; p.positionZ.value = rel.z * k;
    } else p.setPosition(rel.x * k, rel.y * k, rel.z * k);
    return p;
  }

  /** Noise burst with an exponential decay. o: {type, dur, gain, f0, f1, q, filt, attack, delay, rel} */
  noiseBurst(o) {
    if (!this.ok) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise[o.type || 'white'];
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.filt || 'lowpass';
    f.Q.value = o.q || 0.7;
    f.frequency.setValueAtTime(o.f0 || 2000, t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
    const g = ctx.createGain();
    const peak = o.gain === undefined ? 0.5 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f);
    f.connect(g);
    let out = g;
    if (o.rel) {
      const p = this._panner(o.rel);
      g.connect(p);
      out = p;
    }
    out.connect(o.dest || this.sfx);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + o.dur + 0.05);
  }

  tone(o) {
    if (!this.ok) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain === undefined ? 0.3 : o.gain, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    let out = g;
    if (o.rel) {
      const p = this._panner(o.rel);
      g.connect(p);
      out = p;
    }
    out.connect(o.dest || this.sfx);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }

  click() {
    this.tone({ f0: 900, f1: 600, dur: 0.06, gain: 0.12, type: 'triangle' });
  }

  beep(freq, dur, gain) {
    this.tone({ f0: freq, dur: dur || 0.08, gain: gain || 0.14, type: 'sine', attack: 0.004 });
  }

  alarm() {
    this.tone({ f0: 880, dur: 0.16, gain: 0.16, type: 'square', attack: 0.004 });
    this.tone({ f0: 660, dur: 0.16, gain: 0.16, type: 'square', attack: 0.004, delay: 0.2 });
  }

  /** Own cannon shot (flat): sharp crack, chesty thump and a short ringing tail */
  gunShot() {
    this.noiseBurst({ type: 'white', dur: 0.05, gain: 0.26, f0: 3200, q: 0.6, filt: 'highpass', attack: 0.001 });
    this.noiseBurst({ type: 'pink', dur: 0.11, gain: 0.3, f0: 1500, f1: 400, q: 0.8, filt: 'bandpass', attack: 0.002 });
    this.tone({ f0: 170, f1: 55, dur: 0.09, gain: 0.34, type: 'sine', attack: 0.002 });
  }

  /** Distant gunfire from an enemy */
  enemyGun(rel) {
    const d = Math.hypot(rel.x, rel.y, rel.z);
    const a = 1 / (1 + d / 150);
    this.noiseBurst({ type: 'white', dur: 0.05, gain: 0.4 * a, f0: 2600, filt: 'bandpass', q: 0.7, attack: 0.001, rel });
    this.noiseBurst({ type: 'pink', dur: 0.12, gain: 0.3 * a, f0: 900, f1: 250, filt: 'lowpass', rel });
  }

  missileLaunch(rel) {
    this.noiseBurst({ type: 'pink', dur: 1.1, gain: 0.55, f0: 500, f1: 3200, q: 0.9, filt: 'bandpass', attack: 0.05, rel });
    this.tone({ f0: 90, f1: 45, dur: 0.5, gain: 0.4, type: 'sine' });
  }

  hit() {
    this.noiseBurst({ type: 'pink', dur: 0.14, gain: 0.5, f0: 900, f1: 200, filt: 'lowpass' });
    this.tone({ f0: 240, f1: 90, dur: 0.14, gain: 0.35, type: 'triangle' });
    this.tone({ f0: 1800, f1: 1300, dur: 0.05, gain: 0.07, type: 'square' });
  }

  /** Explosion: sharp crack, chest-thump, long rolling rumble and scattered debris crackle. */
  explosion(rel, big) {
    if (!this.ok) return;
    const d = Math.hypot(rel.x, rel.y, rel.z);
    const a = clamp(1.1 / (1 + d / 260), 0.05, 1.1) * (big ? 1.2 : 1);
    const delay = Math.min(d / this.c * 0.4, 0.9);
    // air absorption: distant blasts lose their crack and are mostly low rumble
    const bright = clamp(1 - d / 2500, 0.15, 1);
    this.noiseBurst({ type: 'white', dur: 0.06, gain: 0.7 * a * bright, f0: 2500, filt: 'highpass', attack: 0.001, delay, rel });
    this.noiseBurst({ type: 'pink', dur: 0.45, gain: 1.0 * a, f0: 1800, f1: 120, q: 0.7, filt: 'lowpass', attack: 0.004, delay, rel });
    this.noiseBurst({ type: 'brown', dur: 2.8, gain: 1.0 * a, f0: 420, f1: 40, q: 0.6, filt: 'lowpass', attack: 0.02, delay: delay + 0.05, rel });
    this.tone({ f0: 80, f1: 24, dur: 1.6, gain: 0.9 * a, type: 'sine', delay, rel });
    // debris pattering down: random little pops that thin out over time
    const n = big ? 14 : 9;
    for (let i = 0; i < n; i++) {
      const tt = 0.25 + Math.pow(Math.random(), 1.6) * 2.2;
      this.noiseBurst({ type: 'white', dur: 0.03 + Math.random() * 0.05, gain: (0.22 * a * bright) * (1 - tt / 3), f0: 600 + Math.random() * 2000, q: 1.2, filt: 'bandpass', attack: 0.001, delay: delay + tt, rel });
    }
  }

  /**
   * Sonic boom: a real N-wave. The pressure jumps up (bow shock), ramps down linearly, then jumps back
   * (tail shock). Those two sharp edges are the "ba-boom" double crack. Followed by a low rumble.
   */
  boom(rel, strength) {
    if (!this.ok) return;
    const s = 0.72 * clamp(strength === undefined ? 1 : strength, 0.15, 1.4);
    const ctx = this.ctx, sr = ctx.sampleRate, t0 = ctx.currentTime;
    const T = rand(0.1, 0.15); // N-wave duration: the gap between the two bangs of a "double boom"
    // The boom skips the compressor (which would squash its first few milliseconds) and goes to the master via its own bus.
    if (!this.boomBus) { this.boomBus = ctx.createGain(); this.boomBus.gain.value = 1; this.boomBus.connect(this.master); }
    const dest = this.boomBus;

    // 1. the N-wave itself: a near-instant overpressure jump, a linear fall below ambient, then a second jump back.
    const len = Math.floor(sr * (T + 0.3));
    const buf = ctx.createBuffer(1, len, sr);
    const dat = buf.getChannelData(0);
    const kRise = 1 - Math.exp(-1 / (sr * 0.0006));
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const target = t < T ? 1 - (2 * t) / T : 0;
      lp += (target - lp) * kRise;
      // a faint ring after each shock edge (the sensor / the air / the ground are not perfect)
      const ring = Math.sin(t * 2 * PI * 210) * Math.exp(-t * 38) * 0.18 + Math.sin(Math.max(0, t - T) * 2 * PI * 170) * Math.exp(-Math.max(0, t - T) * 45) * 0.14 * (t >= T ? 1 : 0);
      dat[i] = lp + ring;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = 6500; lpf.Q.value = 0.6;
    const shaper = ctx.createWaveShaper(); // saturation: the loud transient gets thick and hard
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.6) / Math.tanh(2.6); }
    shaper.curve = curve;
    const g = ctx.createGain();
    g.gain.value = 1.9 * s;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 18; hpf.Q.value = 0.7;
    src.connect(hpf); hpf.connect(lpf); lpf.connect(shaper); shaper.connect(g);
    let out = g;
    if (rel) { const p = this._panner(rel); g.connect(p); out = p; }
    out.connect(dest);
    src.start(t0);

    // 2. the crack: a razor-sharp broadband snap at the bow shock and again at the tail shock
    this.noiseBurst({ type: 'white', dur: 0.05, gain: 4.6 * s, f0: 1800, filt: 'highpass', attack: 0.0002, rel, dest });
    this.noiseBurst({ type: 'white', dur: 0.03, gain: 3.6 * s, f0: 5500, filt: 'highpass', attack: 0.0002, rel, dest });
    this.noiseBurst({ type: 'white', dur: 0.075, gain: 3.4 * s, f0: 1600, filt: 'highpass', attack: 0.0002, delay: T, rel, dest });
    this.noiseBurst({ type: 'white', dur: 0.03, gain: 2.4 * s, f0: 5000, filt: 'highpass', attack: 0.0002, delay: T, rel, dest });
    this.noiseBurst({ type: 'pink', dur: 0.1, gain: 1.3 * s, f0: 3200, f1: 700, q: 0.8, filt: 'bandpass', attack: 0.0003, rel, dest });
    // 3. the boom: the thump you feel in your chest, with a deep tail
    this.tone({ f0: 92, f1: 30, dur: 0.65, gain: 2.0 * s, type: 'sine', attack: 0.002, rel, dest });
    this.tone({ f0: 52, f1: 20, dur: 1.5, gain: 1.3 * s, type: 'sine', attack: 0.006, delay: 0.01, rel, dest });
    this.tone({ f0: 70, f1: 26, dur: 0.5, gain: 1.5 * s, type: 'sine', attack: 0.002, delay: T, rel, dest });
    this.noiseBurst({ type: 'brown', dur: 3.2, gain: 1.0 * s, f0: 420, f1: 36, q: 0.5, filt: 'lowpass', attack: 0.06, delay: T + 0.02, rel, dest });
    // 4. the crack bounces off hills and buildings: quick, bright, fading slaps (and a low rolling tail)
    let eg = 1.5 * s, ed = 0.12;
    for (let k = 0; k < 7; k++) {
      ed += rand(0.07, 0.2);
      eg *= 0.62;
      this.noiseBurst({ type: 'white', dur: rand(0.06, 0.16), gain: eg, f0: rand(2400, 4200) / (1 + k * 0.35), f1: 500, q: 0.7, filt: 'bandpass', attack: 0.001, delay: ed, rel, dest });
    }
    this.noiseBurst({ type: 'pink', dur: 1.6, gain: 0.7 * s, f0: 1200, f1: 120, q: 0.5, filt: 'lowpass', attack: 0.03, delay: T + 0.05, rel, dest });
    // 5. the ear takes a hit: everything else ducks for a moment, then returns
    const bg = this.bus.gain;
    bg.cancelScheduledValues(t0);
    bg.setValueAtTime(Math.min(1, bg.value), t0);
    bg.linearRampToValueAtTime(0.2, t0 + 0.012);
    bg.setValueAtTime(0.2, t0 + 0.28);
    bg.linearRampToValueAtTime(1, t0 + 1.5);
    if (this.onBoom) this.onBoom(s);
  }

  /** Persistent cockpit / own-aircraft engine + wind */
  createOwnEngine() {
    if (!this.ok) return null;
    return new OwnEngineVoice(this);
  }
}

/* ==========================================================================
   Voices
   ========================================================================== */

/**
 * The engine of another aircraft, heard in 3D with Doppler shift.
 * Layers: turbulent exhaust roar, crackle (afterburner / high thrust), deep rumble, hiss, and several
 * turbine tones with a slight wobble. A ground reflection (delayed copy) produces the comb-filter "swoosh"
 * a real flyby has when you stand on the ground.
 */
class ExternalJetVoice {
  constructor(audio, jet) {
    this.audio = audio;
    this.jet = jet;
    const ctx = audio.ctx;
    this.dead = false;
    this.sol = { ok: false, tau: 0, d: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    this.tau = 0;
    this.prevOk = null;
    this.rampIn = 1;
    this.ratio = 1;
    this.distance = 0;
    this.detune = 1 + rand(-0.018, 0.018);
    this.srcs = [];
    this.oscs = [];

    const N = audio.noise;
    const mkLoop = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      this.srcs.push(s);
      return s;
    };
    const bq = (type, f, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q === undefined ? 0.7 : q;
      return b;
    };
    const gn = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };

    // roar: pink noise through a low-pass with a body peak
    this.roarSrc = mkLoop(N.pink);
    this.roarLP = bq('lowpass', 1500, 0.8);
    this.roarPeak = bq('peaking', 360, 0.9); this.roarPeak.gain.value = 7;
    this.roarGain = gn(0);
    this.roarSrc.connect(this.roarLP); this.roarLP.connect(this.roarPeak); this.roarPeak.connect(this.roarGain);
    // turbulence: the exhaust is a churning mass of eddies, so its loudness flutters at several rates
    this.lfoSrc = mkLoop(N.brown);
    this.lfoLP = bq('lowpass', 26, 0.5);
    this.lfoGain = gn(0);
    this.lfoSrc.connect(this.lfoLP); this.lfoLP.connect(this.lfoGain); this.lfoGain.connect(this.roarGain.gain);
    this.lfo2Src = mkLoop(N.pink);
    this.lfo2BP = bq('bandpass', 9, 0.9);
    this.lfo2Gain = gn(0);
    this.lfo2Src.connect(this.lfo2BP); this.lfo2BP.connect(this.lfo2Gain); this.lfo2Gain.connect(this.roarGain.gain);

    // crackle: sparse random pops of mid/high noise (loud when the afterburner is lit)
    this.crSrc = mkLoop(N.white);
    this.crBP = bq('bandpass', 1500, 0.8);
    this.crGain = gn(0);
    this.crSrc.connect(this.crBP); this.crBP.connect(this.crGain);
    this.trigSrc = mkLoop(N.white);
    const trigLP = bq('lowpass', 70, 0.5);
    const trigPre = gn(22);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = x > 0.55 ? Math.min(1, (x - 0.55) * 2.6) : 0;
    }
    shaper.curve = curve;
    this.crAmp = gn(0);
    this.trigSrc.connect(trigLP); trigLP.connect(trigPre); trigPre.connect(shaper); shaper.connect(this.crAmp); this.crAmp.connect(this.crGain.gain);

    // hiss: white noise band
    this.hissSrc = mkLoop(N.white);
    this.hissBP = bq('bandpass', 3500, 0.7);
    this.hissGain = gn(0);
    this.hissSrc.connect(this.hissBP); this.hissBP.connect(this.hissGain);
    // rumble: brown noise
    this.rumSrc = mkLoop(N.brown);
    this.rumLP = bq('lowpass', 120, 0.6);
    this.rumGain = gn(0);
    this.rumSrc.connect(this.rumLP); this.rumLP.connect(this.rumGain);

    // turbine whine: fan blade-pass, a compressor tone and a harmonic, all with a slight wobble
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'sine';
    this.o3 = ctx.createOscillator(); this.o3.type = 'triangle';
    this.vib = ctx.createOscillator(); this.vib.type = 'sine'; this.vib.frequency.value = 4.6 + rand(0, 2.5);
    this.vibGain = gn(0);
    this.vib.connect(this.vibGain);
    for (const o of [this.o1, this.o2, this.o3]) this.vibGain.connect(o.frequency);
    this.oscs.push(this.o1, this.o2, this.o3, this.vib);
    this.whineBP = bq('bandpass', 3000, 5);
    this.whineGain = gn(0);
    this.o1.connect(this.whineBP); this.whineBP.connect(this.whineGain);
    this.o2.connect(this.whineGain);
    this.o3g = gn(0.5);
    this.o3.connect(this.o3g); this.o3g.connect(this.whineGain);

    // mix -> (+ ground reflection) -> air absorption -> distance gain -> panner
    this.mix = gn(1);
    this.roarGain.connect(this.mix); this.crGain.connect(this.mix); this.hissGain.connect(this.mix);
    this.rumGain.connect(this.mix); this.whineGain.connect(this.mix);
    this.pre = gn(1);
    this.mix.connect(this.pre);
    this.refDelay = ctx.createDelay(0.15); this.refDelay.delayTime.value = 0.004;
    this.refLP = bq('lowpass', 3800, 0.5);
    this.refGain = gn(0);
    this.mix.connect(this.refDelay); this.refDelay.connect(this.refLP); this.refLP.connect(this.refGain); this.refGain.connect(this.pre);
    this.air = bq('lowpass', 12000, 0.5);
    this.out = gn(0);
    this.pan = ctx.createPanner();
    this.pan.panningModel = 'HRTF';
    this.pan.distanceModel = 'inverse';
    this.pan.refDistance = 10;
    this.pan.rolloffFactor = 0;
    this.pre.connect(this.air); this.air.connect(this.out); this.out.connect(this.pan); this.pan.connect(audio.bus);

    const t = ctx.currentTime;
    for (const s of this.srcs) s.start(t, Math.random() * 3);
    for (const o of this.oscs) o.start(t);
  }

  update(t, L) {
    const A = this.audio, ctx = A.ctx, now = ctx.currentTime, jet = this.jet;
    const sol = this.sol;
    const ok = inMachCone(jet, L, A.c) && solveRetarded(jet.history, t, L.x, L.y, L.z, A.c, this.tau, sol);

    const dtv = this.lastT === undefined ? 0.02 : clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    if (!ok) {
      this.prevOk = false;
      this.silentT = (this.silentT || 0) + dtv;
      _set(this.out.gain, 0, now, 0.05);
      return;
    }
    this.tau = sol.tau;
    const speed = Math.sqrt(sol.vx * sol.vx + sol.vy * sol.vy + sol.vz * sol.vz);
    // Sonic boom when the Mach cone sweeps over the listener. Debounced: the cone edge can flicker, and a
    // formation must produce ONE boom, not one per jet.
    if (this.prevOk === false && (this.silentT || 0) > 0.4 && speed > A.c * 0.99 && !(t - (A.lastBoomT || -99) < 3)) {
      A.lastBoomT = t;
      const rel = { x: sol.x - L.x, y: sol.y - L.y, z: sol.z - L.z };
      const alt = Math.max(60, sol.d);
      // (the boom sound itself is triggered by the Doppler Lab's own cone detection, see flyby.js)
      this.rampIn = 0;
    }
    if (this.prevOk === false && (this.silentT || 0) > 0.4 && speed > A.c * 0.99) this.rampIn = Math.min(this.rampIn, 0);
    this.prevOk = true;
    this.silentT = 0;
    // engine fades in over ~0.7 s after the cone arrives (the pitch is sweeping wildly at that instant)
    if (this.rampIn < 1) this.rampIn = Math.min(1, this.rampIn + dtv / 0.7);

    const r = dopplerRatio(sol, L.x, L.y, L.z, L.vx, L.vy, L.vz, A.c, A.dopplerK);
    this.ratio = r;
    const dx = sol.x - L.x, dy = sol.y - L.y, dz = sol.z - L.z;
    const d = Math.max(sol.d, 1);
    this.distance = d;
    const ux = dx / d, uy = dy / d, uz = dz / d;

    // directivity: compressor whine radiates forward, exhaust roar rearward
    let fx = 0, fy = 0, fz = -1;
    if (speed > 30) { fx = sol.vx / speed; fy = sol.vy / speed; fz = sol.vz / speed; }
    const cosPhi = -(fx * ux + fy * uy + fz * uz); // +1: jet pointing at the listener
    const front = clamp(0.5 + 0.5 * cosPhi, 0, 1);

    const thr = jet.throttle, ab = jet.ab;
    const att = 5.2 * Math.pow(1 / (1 + d / 110), 0.8);
    const rear = 0.5 + 0.8 * (1 - front);
    const roarG = (0.2 + 0.62 * thr * thr) * (1 + 0.9 * ab) * rear;
    const rumG = (0.16 + 0.34 * thr + 0.85 * ab) * (0.55 + 0.6 * (1 - front));
    const hissG = (0.035 + 0.2 * thr) * (0.3 + 0.9 * front) * (1 - 0.35 * ab);
    const whineG = (0.012 + 0.045 * thr) * (0.12 + 1.1 * Math.pow(front, 1.6));
    const crackleG = (0.03 + 0.34 * ab + 0.1 * thr * thr) * rear;
    const tc = 0.03;
    _set(this.roarGain.gain, roarG, now, tc);
    _set(this.lfoGain.gain, roarG * (0.18 + 0.55 * ab), now, tc);
    _set(this.lfo2Gain.gain, roarG * (0.5 + 0.6 * ab), now, tc);
    _set(this.crAmp.gain, crackleG, now, tc);
    _set(this.rumGain.gain, rumG, now, tc);
    _set(this.hissGain.gain, hissG, now, tc);
    _set(this.whineGain.gain, whineG, now, tc);
    _set(this.out.gain, att * this.rampIn, now, 0.04);

    // frequencies follow the Doppler ratio
    _set(this.roarSrc.playbackRate, r, now, tc);
    _set(this.crSrc.playbackRate, r, now, tc);
    _set(this.hissSrc.playbackRate, r, now, tc);
    _set(this.rumSrc.playbackRate, r, now, tc);
    _set(this.roarLP.frequency, clamp((650 + 2300 * thr + 1000 * ab) * r, 60, 15000), now, tc);
    _set(this.roarPeak.frequency, clamp(360 * r, 60, 8000), now, tc);
    _set(this.crBP.frequency, clamp((1300 + 900 * ab) * r, 200, 14000), now, tc);
    _set(this.hissBP.frequency, clamp((2600 + 2400 * thr) * r, 200, 16000), now, tc);
    _set(this.rumLP.frequency, clamp((115 + 90 * ab) * r, 20, 3000), now, tc);
    const f1 = clamp((1500 + 2600 * thr) * this.detune * r, 80, 15000);
    _set(this.o1.frequency, f1, now, tc);
    _set(this.o2.frequency, clamp(f1 * 2.01, 80, 18000), now, tc);
    _set(this.o3.frequency, clamp(f1 * 1.37, 80, 18000), now, tc);
    _set(this.whineBP.frequency, f1, now, tc);
    _set(this.vibGain.gain, f1 * 0.006, now, tc);
    // air absorption: far jets sound duller
    _set(this.air.frequency, clamp(19000 / (1 + d / 650), 600, 19000), now, 0.05);

    // ground reflection: only when the listener is standing on the ground (L.gy = ground height under them)
    let refG = 0, refDt = 0.004;
    if (L.gy !== undefined) {
      const hl = L.y - L.gy, hs = sol.y - L.gy;
      if (hl < 12 && hs > 0.5) {
        const dh = Math.sqrt(dx * dx + dz * dz);
        const rd = Math.sqrt(dh * dh + (hs - hl) * (hs - hl));
        const rr = Math.sqrt(dh * dh + (hs + hl) * (hs + hl));
        refDt = clamp((rr - rd) / A.c, 0.0004, 0.1);
        refG = 0.8 * (rd / rr);
      }
    }
    this.refDt = refDt;
    _set(this.refGain.gain, refG, now, 0.05);
    _set(this.refDelay.delayTime, refDt, now, 0.03);

    // direction (listener-relative world vector, normalised and parked at 10 m)
    const k = 10;
    if (this.pan.positionX) {
      _set(this.pan.positionX, ux * k, now, 0.02);
      _set(this.pan.positionY, uy * k, now, 0.02);
      _set(this.pan.positionZ, uz * k, now, 0.02);
    } else this.pan.setPosition(ux * k, uy * k, uz * k);
  }

  stop(immediate, fadeTc) {
    if (this.dead) return;
    this.dead = true;
    const ctx = this.audio.ctx, now = ctx.currentTime;
    const tc = immediate ? 0.01 : fadeTc || 0.12;
    try {
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setTargetAtTime(0, now, tc);
      const end = now + (immediate ? 0.06 : Math.max(0.6, tc * 6));
      for (const s of this.srcs) s.stop(end);
      for (const o of this.oscs) o.stop(end);
      setTimeout(() => {
        try { this.pan.disconnect(); this.out.disconnect(); } catch (e) { /* ignore */ }
      }, (end - now) * 1000 + 300);
    } catch (e) { /* already stopped */ }
  }
}

/** A missile motor: broadband hiss with Doppler. `src` needs .history */
class MissileVoice {
  constructor(audio, src) {
    this.audio = audio;
    this.src = src;
    const ctx = audio.ctx;
    this.dead = false;
    this.tau = 0;
    this.sol = { ok: false, tau: 0, d: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    this.n1 = ctx.createBufferSource(); this.n1.buffer = audio.noise.white; this.n1.loop = true;
    this.n2 = ctx.createBufferSource(); this.n2.buffer = audio.noise.pink; this.n2.loop = true;
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.Q.value = 0.8; this.bp.frequency.value = 1800;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 700;
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.9;
    this.n1.connect(this.bp); this.bp.connect(g1);
    this.n2.connect(this.lp); this.lp.connect(g2);
    this.out = ctx.createGain(); this.out.gain.value = 0;
    g1.connect(this.out); g2.connect(this.out);
    this.pan = ctx.createPanner();
    this.pan.panningModel = 'HRTF'; this.pan.distanceModel = 'inverse'; this.pan.refDistance = 10; this.pan.rolloffFactor = 0;
    this.out.connect(this.pan); this.pan.connect(audio.bus);
    this.n1.start(ctx.currentTime, Math.random() * 3);
    this.n2.start(ctx.currentTime, Math.random() * 3);
  }

  update(t, L) {
    const A = this.audio, now = A.ctx.currentTime, sol = this.sol;
    if (this.src.gone || !solveRetarded(this.src.history, t, L.x, L.y, L.z, A.c, this.tau, sol)) {
      _set(this.out.gain, 0, now, 0.05);
      if (this.src.gone) this.stop();
      return;
    }
    this.tau = sol.tau;
    const r = dopplerRatio(sol, L.x, L.y, L.z, L.vx, L.vy, L.vz, A.c, A.dopplerK);
    const d = Math.max(sol.d, 1);
    _set(this.out.gain, 0.5 / (1 + d / 60), now, 0.04);
    _set(this.n1.playbackRate, r, now, 0.03);
    _set(this.n2.playbackRate, r, now, 0.03);
    _set(this.bp.frequency, clamp(1800 * r, 200, 14000), now, 0.03);
    _set(this.lp.frequency, clamp(700 * r, 80, 8000), now, 0.03);
    const k = 10 / d;
    if (this.pan.positionX) {
      _set(this.pan.positionX, (sol.x - L.x) * k, now, 0.02);
      _set(this.pan.positionY, (sol.y - L.y) * k, now, 0.02);
      _set(this.pan.positionZ, (sol.z - L.z) * k, now, 0.02);
    }
  }

  stop(immediate) {
    if (this.dead) return;
    this.dead = true;
    const ctx = this.audio.ctx, now = ctx.currentTime;
    try {
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setTargetAtTime(0, now, 0.05);
      this.n1.stop(now + 0.4);
      this.n2.stop(now + 0.4);
    } catch (e) { /* ignore */ }
  }
}

/** The player's own engine and wind, heard from the cockpit/chase camera (no Doppler). */
class OwnEngineVoice {
  constructor(audio) {
    this.audio = audio;
    const ctx = audio.ctx;
    const N = audio.noise;
    this.dead = false;
    this.srcs = [];
    const loop = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      this.srcs.push(s);
      return s;
    };
    const bq = (type, f, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q || 0.7;
      return b;
    };
    this.out = ctx.createGain(); this.out.gain.value = 0.0;
    this.muffle = bq('lowpass', 3200, 0.6);
    // roar
    this.roar = loop(N.pink); this.roarLP = bq('lowpass', 900, 0.7); this.roarG = ctx.createGain(); this.roarG.gain.value = 0;
    this.roar.connect(this.roarLP); this.roarLP.connect(this.roarG); this.roarG.connect(this.muffle);
    // rumble
    this.rum = loop(N.brown); this.rumLP = bq('lowpass', 150, 0.6); this.rumG = ctx.createGain(); this.rumG.gain.value = 0;
    this.rum.connect(this.rumLP); this.rumLP.connect(this.rumG); this.rumG.connect(this.muffle);
    // hiss / whistle
    this.hiss = loop(N.white); this.hissBP = bq('bandpass', 3000, 1.2); this.hissG = ctx.createGain(); this.hissG.gain.value = 0;
    this.hiss.connect(this.hissBP); this.hissBP.connect(this.hissG); this.hissG.connect(this.muffle);
    // wind
    this.wind = loop(N.pink); this.windBP = bq('bandpass', 800, 0.6); this.windG = ctx.createGain(); this.windG.gain.value = 0;
    this.wind.connect(this.windBP); this.windBP.connect(this.windG); this.windG.connect(this.muffle);
    // afterburner crackle flutter
    this.lfo = loop(N.brown); this.lfoLP = bq('lowpass', 22); this.lfoG = ctx.createGain(); this.lfoG.gain.value = 0;
    this.lfo.connect(this.lfoLP); this.lfoLP.connect(this.lfoG); this.lfoG.connect(this.roarG.gain);
    this.lfo2 = loop(N.pink); this.lfo2BP = bq('bandpass', 9, 0.9); this.lfo2G = ctx.createGain(); this.lfo2G.gain.value = 0;
    this.lfo2.connect(this.lfo2BP); this.lfo2BP.connect(this.lfo2G); this.lfo2G.connect(this.roarG.gain);
    this.muffle.connect(this.out);
    this.out.connect(audio.sfx);
    const t = ctx.currentTime;
    for (const s of this.srcs) s.start(t, Math.random() * 3);
    this.setTarget = { thr: 0.5, ab: 0, speed: 200, cockpit: false, level: 1 };
  }

  update(thr, ab, speed, cockpit, level) {
    if (this.dead) return;
    const now = this.audio.ctx.currentTime, tc = 0.08;
    const sp = clamp(speed / 320, 0, 1.6);
    const base = (cockpit ? 0.5 : 0.85) * (level === undefined ? 1 : level);
    _set(this.out.gain, base, now, 0.1);
    _set(this.muffle.frequency, cockpit ? 1700 : 4200, now, 0.15);
    _set(this.roarG.gain, (0.18 + 0.5 * thr * thr) * (1 + 0.8 * ab), now, tc);
    _set(this.lfoG.gain, (0.06 + 0.3 * ab) * (0.18 + 0.5 * thr * thr), now, tc);
    _set(this.lfo2G.gain, (0.12 + 0.35 * ab) * (0.18 + 0.5 * thr * thr), now, tc);
    _set(this.roarLP.frequency, 480 + 1500 * thr + 700 * ab, now, tc);
    _set(this.rumG.gain, 0.15 + 0.3 * thr + 0.75 * ab, now, tc);
    _set(this.hissG.gain, (cockpit ? 0.03 : 0.07) + 0.12 * thr, now, tc);
    _set(this.hissBP.frequency, 2200 + 2600 * thr, now, tc);
    _set(this.windG.gain, 0.04 + 0.34 * sp * sp, now, tc);
    _set(this.windBP.frequency, 500 + 1200 * sp, now, tc);
  }

  stop() {
    if (this.dead) return;
    this.dead = true;
    const ctx = this.audio.ctx, now = ctx.currentTime;
    try {
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setTargetAtTime(0, now, 0.08);
      for (const s of this.srcs) s.stop(now + 0.5);
    } catch (e) { /* ignore */ }
  }
}

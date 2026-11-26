'use strict';
/* ==========================================================================
   gear.js - landing gear and ground physics.
   * L raises and lowers the gear (it takes a few seconds, and cannot be raised with weight on the wheels). Gear down adds drag and lets
     you fly a little slower.
   * Each aircraft has contact points (the wheels). Come down onto the ground with the gear down, the wings level, the nose in a sensible
     attitude and a gentle sink rate, and you touch down: a firm landing is fine, a hard one bounces and hurts the airframe, a very hard
     or badly aligned one is a crash. Gear up (or not yet locked down) and the belly hits the ground: a belly landing / crash as before.
   * On the ground the aircraft rolls: engine thrust (SHIFT = full power, otherwise idle), rolling resistance (smooth on the runway, rough
     on grass), brakes (X), nose-wheel steering (A/D or Q/E), and the elevator only bites when there is enough airspeed to rotate. Rotate
     past the lift-off speed and it flies. Rough, steep ground or a tail strike are crashes.
   * Free Flight can start on the runway (Settings -> Start).
   ========================================================================== */

const _gE = new THREE.Euler(0, 0, 0, 'YXZ');
const _gV = new THREE.Vector3();
const _gQ = new THREE.Quaternion();
const _gAxisZ = new THREE.Vector3(0, 0, 1);

/** a fighter's landing gear: a nose leg and two main legs on pivots, so they can swing up into the fuselage */
function buildFighterGear(group) {
  const gear = new THREE.Group();
  const strutMat = new THREE.MeshPhongMaterial({ color: 0xb8bcc2 });
  const tyreMat = new THREE.MeshPhongMaterial({ color: 0x23252a });
  const leg = (x, z, h, rot) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, -0.3, z);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h, 6), strutMat);
    s.position.set(0, -h / 2, 0);
    pivot.add(s);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12), tyreMat);
    w.rotation.z = PI / 2;
    w.position.set(0, -h, 0);
    pivot.add(w);
    pivot.userData.rot = rot;
    gear.add(pivot);
    return pivot;
  };
  gear.userData.nose = leg(0, -4.4, 1.35, 'x');
  gear.userData.mainR = leg(1.7, 2.4, 1.35, 'zR');
  gear.userData.mainL = leg(-1.7, 2.4, 1.35, 'zL');
  gear.visible = false;
  group.add(gear);
  return gear;
}

/** show the gear extended by t (0 = up and stowed, 1 = down and locked) */
function applyGearPose(model, t, heavy) {
  const g = model && model.gear;
  if (!g) return;
  g.visible = t > 0.02;
  if (!g.visible) return;
  if (heavy) { g.scale.y = Math.max(0.02, t); return; } // the legs fold up into the belly
  const u = g.userData, a = (1 - smoothstep(0, 1, t)) * (PI / 2);
  if (u.nose) u.nose.rotation.x = -a;       // swings back into the nose
  if (u.mainR) u.mainR.rotation.z = -a;     // swing in towards the centreline
  if (u.mainL) u.mainL.rotation.z = a;
}

/** contact points (the wheels' lowest points) in the aircraft's own frame, in metres */
function gearPointsFor(jet) {
  if (jet._gearPts) return jet._gearPts;
  const pts = [];
  if (!jet.spec) {
    pts.push({ x: 0, y: -2.05, z: -4.4, nose: true }, { x: 1.7, y: -2.05, z: 2.4 }, { x: -1.7, y: -2.05, z: 2.4 });
  } else {
    const gear = jet.model.gear, group = jet.group;
    if (gear) {
      const gs = new THREE.Matrix4().makeScale(group.scale.x, group.scale.y, group.scale.z);
      gear.updateMatrix();
      const raw = [];
      gear.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.geometry.parameters || o.geometry.parameters.radiusTop === undefined) return;
        if (Math.abs(Math.abs(o.rotation.z) - PI / 2) > 0.01) return; // wheels lie on their side
        const r = o.geometry.parameters.radiusTop;
        _gV.set(o.position.x, o.position.y - r, o.position.z).applyMatrix4(gear.matrix).applyMatrix4(gs);
        raw.push({ x: _gV.x, y: _gV.y, z: _gV.z });
      });
      // pairs of wheels on one leg become one contact point
      for (const p of raw) {
        const m = pts.find((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1.9 * group.scale.x);
        if (m) { m.x = (m.x * m.n + p.x) / (m.n + 1); m.z = (m.z * m.n + p.z) / (m.n + 1); m.n++; }
        else pts.push({ x: p.x, y: p.y, z: p.z, n: 1 });
      }
      let zMin = 1e9; for (const p of pts) zMin = Math.min(zMin, p.z);
      for (const p of pts) if (Math.abs(p.z - zMin) < 0.01) p.nose = true;
    }
    if (!pts.length) pts.push({ x: 0, y: -4, z: -10, nose: true }, { x: 3, y: -4, z: 4 }, { x: -3, y: -4, z: 4 });
  }
  jet._gearPts = pts;
  return pts;
}

/** how far the nose can rise on the main wheels before the tail (or anything else at the back) hits the ground, from the real model */
function tailLimitFor(jet) {
  const pts = gearPointsFor(jet), group = jet.group, model = jet.model;
  let mz = -1e9, yw = 0;
  for (const p of pts) if (!p.nose && p.z > mz) { mz = p.z; yw = p.y; }
  const skip = new Set([model.flame, model.core, model.glow, model.gear].filter(Boolean));
  const gs = new THREE.Matrix4().makeScale(group.scale.x, group.scale.y, group.scale.z), m = new THREE.Matrix4(), v = new THREE.Vector3();
  let minA = 1e9;
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || skip.has(o)) return;
    let n = o; while (n && n !== group) { if (n.visible === false || skip.has(n)) return; n = n.parent; }
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat || mat.blending === THREE.AdditiveBlending || mat.visible === false) return;
    const chain = []; n = o;
    while (n && n !== group) { n.updateMatrix(); chain.push(n.matrix); n = n.parent; }
    m.copy(gs);
    for (let i = chain.length - 1; i >= 0; i--) m.multiply(chain[i]);
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const d = v.z - mz;
      if (d > 0.6) minA = Math.min(minA, Math.atan2(v.y - yw - 0.25, d)); // the angle at which this point would touch down
    }
  });
  return clamp(minA * 0.85, 3 * DEG, 14 * DEG);
}

/** how rough a surface is: a rolling-resistance coefficient. The runway and the paved apron are smooth, grass is rough */
function surfaceMu(x, z) {
  if (Math.abs(z) < 27 && Math.abs(x) < 1110) return 0.018;                  // the runway
  if (Math.abs(z - 70) < 9 && Math.abs(x) < 1060) return 0.03;                // the taxiway
  if (Math.abs(x) < 340 && z > 108 && z < 262) return 0.03;                   // the apron
  return 0.085;                                                               // grass and dirt
}

/** the ground's height as the wheels feel it (no landing on the sea) */
function groundHeightFor(world) {
  return (x, z) => {
    if (world.heightAt(x, z) < 0.8) return -1e9;
    const h = world.surfaceAt(x, z);
    return Math.abs(z) < 27 && Math.abs(x) < 1110 ? h + 0.06 : h; // (the runway's paint sits a few centimetres up)
  };
}

Aircraft.prototype.gearInit = function () {
  if (this.gearT === undefined) { this.gearT = 0; this.gearDown = false; }
  if (this.onGround === undefined) this.onGround = false;
  this.gpitch = this.gpitch || 0;
  this.susp = this.susp || 0; this.suspV = this.suspV || 0;
  const H = this.heavy, SP = this.spec;
  // lift-off speeds (km/h): the B-2 240, the C-17 235, a 737 250, a 747 265; a fighter lifts off at 96 m/s (about 215 on its speedometer)
  const LIFT = { b2: 240, c17: 235, b737: 250, b747: 265 };
  this.vlift = H ? (LIFT[SP.key] || 250) / 3.6 : 96;   // lift-off speed (m/s)
  this.vr = this.vlift * (H ? 0.93 : 0.92);             // rotation speed
  this.maxRot = (H ? (SP.key === 'b2' ? 10 : SP.key === 'c17' ? 9 : 9.5) : 12) * DEG; // how far the nose can come up before the tail hits
  this.gearTime = H ? 6.5 : 3.2;
};

/** raise or lower the gear: returns a message, or null if nothing changed */
Aircraft.prototype.toggleGear = function () {
  this.gearInit();
  if (this.gearDown && this.onGround) return 'WEIGHT ON WHEELS';
  if (!this.gearDown && this.speed > (this.heavy ? this.spec.stall[1] * 2.6 : 190)) return 'TOO FAST FOR THE GEAR'; // (it would be torn off)
  this.gearDown = !this.gearDown;
  return this.gearDown ? 'GEAR DOWN' : 'GEAR UP';
};

/** the gear moves: it takes a few seconds to travel */
Aircraft.prototype.updateGear = function (dt) {
  if (this.gearT === undefined) this.gearInit();
  const target = this.gearDown ? 1 : 0;
  if (this.gearT !== target) {
    this.gearT = target > this.gearT ? Math.min(1, this.gearT + dt / this.gearTime) : Math.max(0, this.gearT - dt / this.gearTime);
    applyGearPose(this.model, this.gearT, this.heavy);
  }
};

/** worldspace height of the lowest wheel above the ground (negative = in the ground) */
Aircraft.prototype.wheelClearance = function () {
  const pts = gearPointsFor(this);
  let min = 1e9;
  for (const p of pts) {
    _gV.set(p.x, p.y, p.z).applyQuaternion(this.quat).add(this.pos);
    min = Math.min(min, _gV.y - this.groundFn(_gV.x, _gV.z));
  }
  return min;
};

/** called every frame while flying: is a wheel about to meet the ground? */
Aircraft.prototype.checkTouchdown = function (dt) {
  if (!this.groundFn || this.onGround || this.dying || !this.alive) return;
  if (this.liftT > 0) { this.liftT -= dt; return; } // just left the runway: it cannot touch down again at once
  if (this.gearT === undefined) this.gearInit();
  if (this.gearT < 0.75) return; // gear not (nearly) down and locked: no landing (a belly landing is a crash)
  const H = this.heavy, SP = this.spec;
  // only worth measuring when the aircraft is near the ground at all
  if (this.pos.y - this.groundFn(this.pos.x, this.pos.z) > 90) return;
  let clr = this.wheelClearance();
  // landing assist (Flight assist on): a cushion of air near the ground softens the sink, and the wings are eased level
  if (this.assist && clr > 0 && clr < (H ? 24 : 22) && this.vel.y < -1) {
    const vyT = -(H ? 1.2 : 1.4) - clr * 0.1;
    if (this.vel.y < vyT) {
      const k = 1 - Math.exp(-dt * (H ? 1.7 : 4.2));
      const vy = this.vel.y + (vyT - this.vel.y) * k, sp = Math.max(this.speed, 1), hz = Math.hypot(this.vdir.x, this.vdir.z) || 1;
      const ny = clamp(vy / sp, -0.5, 0.5), hs = Math.sqrt(Math.max(0, 1 - ny * ny)) / hz;
      this.vdir.set(this.vdir.x * hs, ny, this.vdir.z * hs);
      this.vel.copy(this.vdir).multiplyScalar(sp);
    }
    _gE.setFromQuaternion(this.quat, 'YXZ');
    if (Math.abs(_gE.z) > 0.005) this.quat.multiply(_gQ.setFromAxisAngle(_gAxisZ, -_gE.z * (1 - Math.exp(-dt * 1.6))));
    clr = this.wheelClearance();
  }
  if (clr > 0.2) return;
  const sink = Math.max(0, -this.vel.y);
  _gE.setFromQuaternion(this.quat, 'YXZ');
  const pitch = _gE.x, roll = _gE.z, spd = this.speed;
  const safeSink = H ? 5.6 : 8, hardSink = H ? 10 : 15;
  const tooFast = spd > (H ? SP.stall[1] * 2.7 : 230);
  const why = [];
  if (sink > hardSink) why.push('TOO HARD: ' + sink.toFixed(0) + ' m/s sink');
  if (tooFast && sink > 3) why.push('TOO FAST');
  if (Math.abs(roll) > 20 * DEG) why.push('WINGS NOT LEVEL');
  if (pitch < -12 * DEG) why.push('NOSE TOO LOW');
  if (pitch > (H ? 20 : 25) * DEG) why.push('NOSE TOO HIGH');
  if (why.length) { this.groundEvent = { kind: 'crash', sink, pitch, roll, why: why[0] }; return; }
  // lift the aircraft so the wheel is exactly on the ground
  this.pos.y -= Math.min(0, clr) * 1;
  if (sink > safeSink) { // a hard landing: it bounces and the airframe takes a beating
    this.groundEvent = { kind: 'hard', sink, spd };
    this.vel.y = sink * 0.32;
    this.vdir.copy(this.vel).normalize();
    this.hp = Math.max(1, this.hp - (H ? 12 : 22));
    return;
  }
  this.onGround = true;
  this.gpitch = clamp(pitch, 0, this.maxRot); // (the nose comes down onto the wheels: never beyond the tail-strike angle)
  this.speed = Math.hypot(this.vel.x, this.vel.z);
  this.rates.p = this.rates.r = this.rates.y = 0;
  this.susp = -Math.min(0.3, sink * 0.05); this.suspV = 0;
  this.groundEvent = { kind: 'touchdown', sink, spd };
  this.groundStep(1e-4); // settle the pose onto the wheels at once (the nose comes down to the tail-strike limit) before anything checks for contact
};

/** the aircraft rolling on its wheels */
Aircraft.prototype.groundStep = function (dt) {
  const inp = this.input, H = this.heavy, SP = this.spec, K = H ? 1 : FIGHTER_SPEED, g = 9.81;
  const gf = this.groundFn;
  _gE.setFromQuaternion(this.quat, 'YXZ');
  let yaw = _gE.y;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let spd = this.speed;

  // engine: SHIFT is full power, otherwise it idles
  const tgt = inp.boost && !inp.brake ? 1 : 0;
  this.throttle += (tgt - this.throttle) * (1 - Math.exp(-dt * (H ? SP.kThr * 1.3 : 2.2)));
  const abT = inp.boost && !H && this.throttle > 0.82 ? 1 : 0;
  this.ab += (abT - this.ab) * (1 - Math.exp(-dt * 3));
  const groundK = H ? (SP.key === 'b2' ? 0.12 : 1) : 0.25; // (a real fighter does not pull 7 g on the runway)
  const thrust = (this.throttle * (H ? SP.thrustK : 12.5 * K * K) + this.ab * 19 * K * K) * groundK;
  const drag = (1.15e-4 + this.gearT * 1.0e-4) * spd * spd * (H && SP.dragK ? SP.dragK : 1);
  // the slope along the heading
  const hA = gf(this.pos.x + fx * 6, this.pos.z + fz * 6), hB = gf(this.pos.x - fx * 6, this.pos.z - fz * 6);
  const slopePitch = Math.atan2(hA - hB, 12);
  const mu = surfaceMu(this.pos.x, this.pos.z);
  const brake = inp.brake ? (H ? 0.34 : 0.5) * g : 0;
  spd += (thrust - drag - g * Math.sin(slopePitch)) * dt;
  spd = Math.max(0, spd - ((spd > 0.2 ? mu * g : 0) + brake) * dt);
  if (spd < 0.2 && thrust < mu * g && !inp.brake) spd = Math.max(0, spd - 0.5 * dt); // comes to rest

  // nose-wheel steering: A/D or Q/E; weaker at speed
  const steer = clamp(inp.yaw + inp.roll * 0.8, -1, 1);
  const yawRate = steer * (H ? 0.2 : 0.4) * Math.min(1, spd / 6) / (1 + spd / (H ? 30 : 50));
  yaw -= yawRate * dt;
  const nfx = -Math.sin(yaw), nfz = -Math.cos(yaw);

  // rotation: the elevator bites only with airspeed
  if (!this._tailLimit) { this._tailLimit = tailLimitFor(this); this.maxRot = Math.min(this.maxRot, this._tailLimit); } // (computed once from the real model)
  const auth = smoothstep(0.5 * this.vr, this.vr, spd);
  const tgtRot = clamp(inp.pitch, 0, 1) * this.maxRot * auth;
  this.gpitch += (tgtRot - this.gpitch) * (1 - Math.exp(-dt * 2.4));

  const nx = this.pos.x + nfx * spd * dt, nz = this.pos.z + nfz * spd * dt;
  const hA2 = gf(nx + nfx * 6, nz + nfz * 6), hB2 = gf(nx - nfx * 6, nz - nfz * 6);
  const sp2 = Math.atan2(hA2 - hB2, 12);
  const pitch = sp2 * 0.92 + this.gpitch;
  this.quat.setFromEuler(_gE.set(pitch, yaw, 0, 'YXZ'));
  // put the deepest wheel on the ground
  let y = -1e9;
  for (const p of gearPointsFor(this)) {
    _gV.set(p.x, p.y, p.z).applyQuaternion(this.quat);
    y = Math.max(y, gf(nx + _gV.x, nz + _gV.z) - _gV.y);
  }
  if (y < -1e8) { this.onGround = false; return; } // the water: no landing
  // the suspension: a damped spring that settles after a touchdown
  this.suspV += (-140 * this.susp - 9 * this.suspV) * dt;
  this.susp += this.suspV * dt;
  const newY = y + this.susp;
  const oldY = this.pos.y;
  this.pos.set(nx, newY, nz);
  this.speed = spd;
  this.vdir.set(nfx * Math.cos(sp2), Math.sin(sp2), nfz * Math.cos(sp2));
  this.vel.set(nfx * spd, clamp((newY - oldY) / Math.max(dt, 1e-3), -25, 25) * (spd > 5 ? 1 : 0), nfz * spd);
  this.mach = spd / (SPEED_OF_SOUND * this.machScale);
  this.rates.p = this.rates.r = this.rates.y = 0;
  this.nLoad += (1 - this.nLoad) * (1 - Math.exp(-dt * 6));
  this.stalled = false;
  this.damageSmoke = this.damageSmoke || 0;

  // lift-off: fast enough, nose up and the pilot asking for it
  if (spd > this.vlift && this.gpitch > 3 * DEG && inp.pitch > 0.1) {
    this.onGround = false;
    this.vdir.set(nfx * Math.cos(pitch), Math.sin(pitch), nfz * Math.cos(pitch)).normalize();
    this.vel.copy(this.vdir).multiplyScalar(spd);
    this.groundEvent = { kind: 'liftoff', spd };
    this.liftT = 1.6; // (no touching down again for a moment: it would hop along the runway)
    this.vel.y = Math.max(this.vel.y, spd * Math.sin(pitch) * 0.9); this.vdir.copy(this.vel).normalize();
  }
  // a steep slope is not something you can drive up
  if (Math.abs(sp2) > 0.5 && spd > 12) this.groundEvent = { kind: 'crash', why: 'terrain', sink: 0, pitch: sp2, roll: 0 };
  // the wheels leave the ground (the end of a cliff)
  if (this.wheelClearance() > 1.2 && spd > 20) this.onGround = false;
};

/** put the aircraft on the ground, ready to roll (gear down, engines idle) */
Aircraft.prototype.parkAt = function (x, z, heading) {
  this.gearInit();
  this.place(x, this.groundFn(x, z) + 4, z, heading, 0);
  this.gearDown = true; this.gearT = 1;
  applyGearPose(this.model, 1, this.heavy);
  this.throttle = 0;
  this.onGround = true;
  this.gpitch = 0; this.susp = 0; this.suspV = 0;
  this.groundStep(0.016);
};

/** replay: how far down the gear is at time rt (0..1), from the recorded lever movements [{t, down}] */
function gearTAt(events, rt, heavy) {
  if (!events || !events.length) return 0;
  const dur = heavy ? 6.5 : 3.2;
  let tgt = events[0].down ? 1 : 0, g = tgt, tc = events[0].t;
  const go = (to, secs) => { g = to > g ? Math.min(to, g + secs / dur) : Math.max(to, g - secs / dur); };
  for (let i = 1; i < events.length && events[i].t <= rt; i++) { go(tgt, events[i].t - tc); tc = events[i].t; tgt = events[i].down ? 1 : 0; }
  go(tgt, rt - tc);
  return g;
}

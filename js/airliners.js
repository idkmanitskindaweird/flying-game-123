'use strict';
/* ==========================================================================
   airliners.js - Boeing 737 and 747 models, plus PLANES: the table of every large aircraft
   (C-17, 737, 747) with its size, flight model and sound settings.
   Same model interface as buildJetMesh(). Local axes: nose = -Z, up = +Y, right = +X.
   ========================================================================== */

const AIRLINER_SCALE = 1.25; // drawn this much larger than life-size so they read better in the sky

/** Parametric airliner. p: {L, R, span, sweep, rootC, tipC, engines:[x...], rn, ln, finH, hump, tail, winglet, gearH} */
function buildAirlinerMesh(p, landingGear) {
  const parts = [];
  const L = p.L, R = p.R, b2 = p.span / 2;
  const white = 0xf1f3f5, belly = 0xc7ccd2, grey = 0xaab0b7, dark = 0x1d1f23;

  // fuselage: (axial fraction of L, radius fraction of R); +y is the nose before the rotation
  const prof = [
    [-0.5, 0.0], [-0.5, 0.1], [-0.465, 0.26], [-0.41, 0.5], [-0.33, 0.76], [-0.25, 0.94], [-0.2, 1.0],
    [0.3, 1.0], [0.37, 0.94], [0.43, 0.78], [0.47, 0.52], [0.495, 0.24], [0.5, 0.0],
  ].map((q) => new THREE.Vector2(q[1] * R, q[0] * L));
  const fus = new THREE.LatheGeometry(prof, gfxLod(20));
  fus.rotateX(-PI / 2);
  const fp = fus.attributes.position;
  for (let i = 0; i < fp.count; i++) { // rear fuselage sweeps up under the tail
    const z = fp.getZ(i);
    if (z > L * 0.2 && fp.getY(i) < 0) fp.setY(i, fp.getY(i) + Math.pow((z - L * 0.2) / (L * 0.3), 2) * R * 0.5);
  }
  fus.computeVertexNormals();
  parts.push(twoTone(fus, white, belly));

  // 747 upper-deck hump
  if (p.hump) {
    const h = new THREE.SphereGeometry(1, gfxLod(16), gfxLod(10));
    h.scale(R * 0.66, R * 0.55, L * 0.12);
    h.translate(0, R * 0.78, -L * 0.34);
    twoTone(h, white, white);
    parts.push(h);
  }

  // window band along both sides
  for (const sx of [1, -1]) {
    const w = new THREE.BoxGeometry(0.1, R * 0.16, L * 0.66);
    w.translate(sx * R * 0.985, R * 0.28, -L * 0.03);
    paintGeometry(w, 0x2a3646);
    parts.push(w);
    // cheatline in the airline colour
    const c = new THREE.BoxGeometry(0.1, R * 0.09, L * 0.7);
    c.translate(sx * R * 0.985, R * 0.08, -L * 0.03);
    paintGeometry(c, p.color);
    parts.push(c);
  }

  // low swept wings
  const rootX = R * 0.9, zr = -L / 2 + 0.36 * L;
  const zt = zr + (b2 - rootX) * Math.tan(p.sweep);
  const wy = -R * 0.5;
  const wing = platePlan([[rootX, zr], [b2, zt], [b2, zt + p.tipC], [rootX, zr + p.rootC]], 0.5 + R * 0.08);
  wing.translate(0, wy, 0);
  twoTone(wing, white, belly);
  parts.push(wing, mirroredCopy(wing));
  const zLE = (x) => zr + (x - rootX) * Math.tan(p.sweep);
  // winglets
  const wh = p.winglet;
  const wl = platePlan([[0, zt], [wh, zt + wh * 0.8], [wh, zt + wh * 0.8 + p.tipC * 0.6], [0, zt + p.tipC]], 0.14);
  wl.rotateZ(PI / 2);
  paintGeometry(wl, p.color);
  for (const sx of [1, -1]) {
    const f = wl.clone();
    f.rotateZ(-sx * 0.2);
    f.translate(sx * b2, wy + 0.2, 0);
    parts.push(f);
  }

  // vertical fin (airline colour) and tailplanes
  const fz = L * 0.3, fh = p.finH;
  const fin = platePlan([[0, fz], [fh, fz + fh * 0.85], [fh, fz + fh * 0.85 + L * 0.07], [0, fz + L * 0.18]], 0.42);
  fin.rotateZ(PI / 2);
  fin.translate(0, R * 0.7, 0);
  paintGeometry(fin, p.color);
  parts.push(fin);
  const sh = L * 0.18, sz = L * 0.355;
  const st = platePlan([[0.5, sz], [sh, sz + sh * 0.62], [sh, sz + sh * 0.62 + L * 0.045], [0.5, sz + L * 0.1]], 0.28);
  st.translate(0, R * 0.32, 0);
  twoTone(st, white, belly);
  parts.push(st, mirroredCopy(st));

  // engines on pylons
  const rn = p.rn, ln = p.ln;
  for (const sx of [1, -1]) {
    for (const ax of p.engines) {
      const x = sx * ax, zc = zLE(ax) - ln * 0.15, yc = wy - rn * 0.95;
      const nac = new THREE.CylinderGeometry(rn, rn * 0.88, ln, gfxLod(16), 1, false);
      nac.rotateX(PI / 2);
      nac.translate(x, yc, zc);
      paintGeometry(nac, grey);
      const inlet = new THREE.CylinderGeometry(rn * 0.86, rn * 0.86, 0.35, gfxLod(16), 1, false);
      inlet.rotateX(PI / 2);
      inlet.translate(x, yc, zc - ln / 2 - 0.05);
      paintGeometry(inlet, dark);
      const cone = new THREE.CylinderGeometry(rn * 0.34, rn * 0.55, ln * 0.2, 12, 1, false);
      cone.rotateX(PI / 2);
      cone.translate(x, yc, zc + ln * 0.58);
      paintGeometry(cone, 0x3a3d42);
      const pyl = new THREE.BoxGeometry(0.45, rn * 1.0, ln * 0.7);
      pyl.translate(x, yc + rn * 0.9, zc - ln * 0.05);
      paintGeometry(pyl, belly);
      parts.push(nac, inlet, cone, pyl);
    }
  }

  const merged = mergeGeometries(parts);
  const body = new THREE.Mesh(merged, jetBodyMaterial());
  const group = new THREE.Group();
  group.scale.setScalar(AIRLINER_SCALE);
  group.add(body);

  // cockpit glass
  const cg = new THREE.SphereGeometry(1, gfxLod(12), gfxLod(8));
  cg.scale(R * 0.62, R * 0.28, R * 0.7);
  cg.translate(0, R * 0.42, -L * 0.455);
  const canopy = new THREE.Mesh(cg, new THREE.MeshPhongMaterial({ color: 0x16212f, specular: 0xaad0ff, shininess: 150 }));
  group.add(canopy);

  // landing gear (shown only when parked)
  const gear = new THREE.Group();
  const gm = new THREE.MeshPhongMaterial({ color: 0x23252a });
  const sm = new THREE.MeshPhongMaterial({ color: 0xb8bcc2 });
  const gb = R + p.gearH; // wheel bottom below the fuselage axis
  const leg = (x, z, y0) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, y0 - -gb, 8), sm);
    c.position.set(x, (y0 + -gb) / 2, z);
    gear.add(c);
  };
  const wheel = (x, z) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.45, 14), gm);
    w.rotation.z = PI / 2;
    w.position.set(x, -gb + 0.62, z);
    gear.add(w);
  };
  leg(0, -L * 0.36, -R * 0.7);
  for (const dx of [-0.32, 0.32]) wheel(dx, -L * 0.36);
  const mz = zr + p.rootC * 0.55;
  const mains = p.hump ? [[R * 0.78, mz], [R * 0.78, mz + 3.6], [R * 1.55, mz + 1.8], [R * 1.55, mz + 5.4]] : [[R * 0.95, mz], [R * 0.95, mz + 0.01]];
  for (const sx of [1, -1]) for (const [mx, mzz] of mains.slice(0, p.hump ? 4 : 1)) {
    leg(sx * mx, mzz, -R * 0.6);
    for (const dx of [-0.32, 0.32]) wheel(sx * mx + dx, mzz);
  }
  gear.visible = !!landingGear;
  group.add(gear);

  const dummyMat = () => new THREE.MeshBasicMaterial({ visible: false });
  const flame = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const core = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const vapor = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ visible: false }));
  flame.visible = core.visible = vapor.visible = glow.visible = false;
  const mkLight = (x, y, z, color, size) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    group.add(s);
    return s;
  };
  const lights = {
    red: mkLight(-b2, wy + wh * 0.7, zt + p.tipC, 0xff2a2a, 3.6),
    green: mkLight(b2, wy + wh * 0.7, zt + p.tipC, 0x30ff50, 3.6),
    strobe: mkLight(0, R * 0.7 + fh, fz + fh * 0.85 + L * 0.07, 0xffffff, 5),
  };
  return { group, body, canopy, flame, core, glow, lights, pal: JET_PALETTES.c17, vapor, noFlame: true, heavy: true, gear, gearBottom: gb };
}

const AIRLINER_SPECS = {
  b737: { L: 39.5, R: 1.95, span: 35.8, sweep: 25 * DEG, rootC: 7.0, tipC: 1.7, engines: [5.9], rn: 1.0, ln: 4.4, finH: 6.6, hump: false, winglet: 2.4, gearH: 1.9, color: 0x1f58b8 },
  b747: { L: 70.7, R: 3.25, span: 64.4, sweep: 37.5 * DEG, rootC: 16.6, tipC: 4.1, engines: [11.8, 24.4], rn: 1.45, ln: 6.4, finH: 11.6, hump: true, winglet: 3.2, gearH: 2.6, color: 0xc4202c },
};
function buildB737Mesh(g) { return buildAirlinerMesh(AIRLINER_SPECS.b737, g); }
function buildB747Mesh(g) { return buildAirlinerMesh(AIRLINER_SPECS.b747, g); }

/* ---------- Northrop Grumman B-2 Spirit: a flying wing ---------------------------------------------------
   52 m span, 21 m long, no tail, four engines buried in the wing behind flat intakes, a sawtooth trailing edge.
   The whole aircraft is ONE smooth lofted surface: thick and rounded through the middle (where the crew, bays and engines are),
   thinning to a knife-edge at the tips, the leading edge and the trailing edge. Local axes: nose = -Z, up = +Y, right = +X. */
const B2_SCALE = 1.7;

const B2_HALF = 26.2;
const B2_TE = [[0, 10.7], [4.6, 6.3], [8.6, 9.3], [14.6, 4.3], [17.6, 7.2], [26.2, 5.6]]; // trailing edge z at x (the W-shape with its two teeth)
function b2LE(ax) { return -10.6 + (ax / B2_HALF) * 14.2; } // straight swept leading edge from the nose to the wingtip
function b2TE(ax) {
  for (let i = 1; i < B2_TE.length; i++) {
    if (ax <= B2_TE[i][0]) { const a = B2_TE[i - 1], b = B2_TE[i], u = (ax - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * u; }
  }
  return B2_TE[B2_TE.length - 1][1];
}
/** thickness profile of the wing: v runs 0 (leading edge) to 1 (trailing edge) */
function b2Section(ax, v) {
  const span = Math.max(0, 1 - ax / B2_HALF);
  const t = 0.12 + 1.5 * Math.pow(span, 1.5); // the centre body is thick, the outer wing thin
  const h = Math.sin(PI * Math.pow(v, 0.72)); // rounded nose, long taper to a sharp trailing edge
  // the raised "turtle-deck" over the crew and bays
  const bump = 0.55 * Math.exp(-(ax * ax) / 14) * Math.exp(-Math.pow((v - 0.36) / 0.2, 2));
  return { top: t * h + bump, bot: -0.5 * t * h };
}
function b2BotY(x, z) {
  const ax = Math.abs(x), le = b2LE(ax), te = b2TE(ax);
  return b2Section(ax, clamp((z - le) / (te - le), 0, 1)).bot;
}
function b2TopY(x, z) {
  const ax = Math.abs(x), le = b2LE(ax), te = b2TE(ax);
  const v = clamp((z - le) / (te - le), 0, 1);
  return b2Section(ax, v).top;
}

function buildB2Mesh(landingGear) {
  // ---- the lofted wing: columns across the span, rows from leading to trailing edge ----
  const xs = [];
  const brk = B2_TE.map((p) => p[0]);
  for (let i = 0; i < brk.length - 1; i++) for (let k = 0; k < 4; k++) xs.push(brk[i] + (brk[i + 1] - brk[i]) * (k / 4));
  xs.push(B2_HALF);
  const cols = [];
  for (let i = xs.length - 1; i >= 1; i--) cols.push(-xs[i]); // left tip .. just left of centre
  for (let i = 0; i < xs.length; i++) cols.push(xs[i]); // centre .. right tip
  const rows = 14;
  const nC = cols.length, nR = rows + 1;
  const pos = [], col = [], idx = [];
  const cTop = new THREE.Color(), cBot = new THREE.Color();
  const top0 = new THREE.Color(0x848a93), top1 = new THREE.Color(0x4d525a), bot = new THREE.Color(0x8b919a); // mid-grey: dark enough to look stealthy, light enough to read the shape
  const vert = (x, y, z, c) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
  const topId = [], botId = [];
  for (let i = 0; i < nC; i++) {
    const x = cols[i], ax = Math.abs(x), le = b2LE(ax), te = b2TE(ax);
    topId.push([]); botId.push([]);
    for (let j = 0; j < nR; j++) {
      const v = j / rows, z = le + (te - le) * v, s = b2Section(ax, v);
      // paint: lighter near the leading edge, darker toward the exhaust, and a faint panel rhythm along the span
      cTop.copy(top0).lerp(top1, clamp(v * 1.15, 0, 1)).multiplyScalar(1 + 0.05 * Math.sin(ax * 2.3 + v * 3));
      topId[i].push(vert(x, s.top, z, cTop));
      cBot.copy(bot).multiplyScalar(1 + 0.04 * Math.sin(ax * 1.7));
      botId[i].push(vert(x, s.bot, z, cBot));
    }
  }
  for (let i = 0; i < nC - 1; i++) {
    for (let j = 0; j < rows; j++) {
      const a = topId[i][j], b = topId[i + 1][j], c = topId[i + 1][j + 1], d = topId[i][j + 1];
      idx.push(a, d, b, b, d, c); // upper surface, facing up
      const a2 = botId[i][j], b2 = botId[i + 1][j], c2 = botId[i + 1][j + 1], d2 = botId[i][j + 1];
      idx.push(a2, b2, d2, b2, c2, d2); // lower surface, facing down
    }
  }
  const wing = new THREE.BufferGeometry();
  wing.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  wing.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  wing.setIndex(idx);
  wing.computeVertexNormals();

  const parts = [wing];
  const dark = 0x0f1114;

  // ---- details placed on the surface ----
  // flat serrated engine intakes on the upper surface, ahead of the engines
  for (const sx of [1, -1]) {
    const ix = sx * 3.6, iz = -4.0;
    const intake = new THREE.BoxGeometry(2.8, 0.1, 1.5);
    intake.translate(ix, b2TopY(ix, iz) + 0.03, iz);
    paintGeometry(intake, dark);
    parts.push(intake);
    // exhaust troughs sunk into the upper surface near the trailing edge
    for (const ex of [sx * 3.2, sx * 7.4]) {
      const ez = b2TE(Math.abs(ex)) - 1.5;
      const slot = new THREE.BoxGeometry(2.6, 0.08, 1.0);
      slot.translate(ex, b2TopY(ex, ez) + 0.03, ez);
      paintGeometry(slot, 0x1b1d21);
      parts.push(slot);
    }
  }
  // panel detail on the underside: weapons-bay doors, landing-gear doors, the intake lips
  const panel = (x, z, w, d, c) => {
    const g = new THREE.BoxGeometry(w, 0.07, d);
    g.translate(x, b2BotY(x, z) - 0.02, z);
    paintGeometry(g, c);
    parts.push(g);
  };
  panel(-1.15, 0.8, 1.5, 4.6, 0x3a3e44); panel(1.15, 0.8, 1.5, 4.6, 0x3a3e44);   // bomb bay doors
  panel(0, -6.2, 1.2, 1.8, 0x3a3e44);                                              // nose gear door
  for (const sx of [1, -1]) {
    panel(sx * 4.2, 1.6, 1.5, 2.8, 0x40444a);                                      // main gear doors
    panel(sx * 3.6, -4.0, 2.8, 1.5, 0x2a2d32);                                     // intake lip seen from below
  }
  const merged = mergeGeometries(parts.map((g) => {
    // mergeGeometries needs position + normal + color on every part
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  }));
  const body = new THREE.Mesh(merged, jetBodyMaterial());
  const group = new THREE.Group();
  group.scale.setScalar(B2_SCALE);
  group.add(body);

  // cockpit: a set of angular dark windscreen panes sitting in the raised deck
  const glassMat = new THREE.MeshPhongMaterial({ color: 0x0c1218, specular: 0xaad0ff, shininess: 160 });
  const canopy = new THREE.Group();
  for (const [px, pz, w, rot] of [[-0.95, -7.1, 1.3, 0.35], [0.95, -7.1, 1.3, -0.35], [-1.6, -6.2, 1.1, 0.25], [1.6, -6.2, 1.1, -0.25]]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, 0.75), glassMat);
    pane.position.set(px, b2TopY(px, pz) + 0.07, pz);
    pane.rotation.y = rot;
    pane.rotation.x = -0.18;
    canopy.add(pane);
  }
  group.add(canopy);

  // landing gear (shown only when parked)
  const gear = new THREE.Group();
  const gm = new THREE.MeshPhongMaterial({ color: 0x1f2125 });
  const sm = new THREE.MeshPhongMaterial({ color: 0xaeb2b8 });
  const gb = 2.2;
  const leg = (x, z) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, gb - 0.2, 8), sm);
    c.position.set(x, -(gb - 0.2) / 2 - 0.2, z);
    gear.add(c);
  };
  const wheel = (x, z) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.45, 14), gm);
    w.rotation.z = PI / 2;
    w.position.set(x, -gb + 0.62, z);
    gear.add(w);
  };
  leg(0, -6.6); for (const dx of [-0.3, 0.3]) wheel(dx, -6.6);
  for (const sx of [1, -1]) { leg(sx * 4.2, 1.6); for (const dx of [-0.3, 0.3]) for (const dz of [-0.7, 0.7]) wheel(sx * 4.2 + dx, 1.6 + dz); }
  gear.visible = !!landingGear;
  group.add(gear);

  const dummyMat = () => new THREE.MeshBasicMaterial({ visible: false });
  const flame = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const core = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const vapor = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ visible: false }));
  flame.visible = core.visible = vapor.visible = glow.visible = false;
  const mkLight = (x, y, z, color, size) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    group.add(s);
    return s;
  };
  const lights = {
    red: mkLight(-25.4, 0.3, 4.6, 0xff2a2a, 3.6),
    green: mkLight(25.4, 0.3, 4.6, 0x30ff50, 3.6),
    strobe: mkLight(0, b2TopY(0, 3) + 0.3, 3, 0xffffff, 4.5),
  };
  return { group, body, canopy, flame, core, glow, lights, pal: JET_PALETTES.c17, vapor, noFlame: true, heavy: true, gear, gearBottom: gb };
}

/**
 * Every large aircraft: model, size, flight model and sound.
 * scale: drawn size multiplier. vmax/vmin: speed limits (m/s). thrustK: full-power thrust. roll/yaw: deg/s.
 * pitchLim: deg. kPitch/kRoll/kThr: how quickly controls and engines respond. auth/stall: speed bands (m/s).
 * hs: formation spacing multiplier. shadow: [width, length]. chase/cockpit: camera offsets [up, back/forward].
 * snd: turbofan whine pitch (w0 + w1*throttle), whine/roar/rumble gains, roar filter, +dB on the level meter.
 */
const PLANES = {
  c17: {
    key: 'c17', name: 'C-17 Globemaster III', short: 'C-17', build: buildC17Mesh, scale: C17_SCALE,
    maxMach: 0.77, vmax: 268, vmin: 42, thrustK: 7.0, cruise: 0.55, gMul: 0.24, startSpeed: 185,
    roll: 36, yaw: 7, pitchLim: 20, kPitch: 2.4, kRoll: 3, kThr: 0.7, auth: [50, 125], stall: [50, 78], align: 0.55,
    hs: 3.4, shadow: [56, 56], chase: [14, 62], cockpit: [2.3, -21.5], crash: 7, tail: 28, radius: 30,
    snd: { w0: 560, w1: 760, wg: 0.55, rg: 1.25, rum: 1.5, rlp: 0.6, peak: 240, spl: 2 }, ownLP: 0.62,
  },
  b737: {
    key: 'b737', name: 'Boeing 737', short: '737', build: buildB737Mesh, scale: AIRLINER_SCALE,
    maxMach: 0.8, vmax: 270, vmin: 44, thrustK: 7.4, cruise: 0.6, gMul: 0.32, startSpeed: 175,
    roll: 40, yaw: 8, pitchLim: 22, kPitch: 3.0, kRoll: 3.6, kThr: 0.9, auth: [48, 120], stall: [52, 80], align: 0.6,
    hs: 2.6, shadow: [38, 42], chase: [9, 40], cockpit: [1.3, -17.5], crash: 5, tail: 20, radius: 22,
    snd: { w0: 950, w1: 1150, wg: 0.9, rg: 1.1, rum: 1.1, rlp: 0.8, peak: 300, spl: 1 }, ownLP: 0.8,
  },
  b2: {
    key: 'b2', name: 'B-2 Spirit', short: 'B-2', build: buildB2Mesh, scale: B2_SCALE,
    // faster than the fighter: dragK makes it very slippery, so it cruises at roughly Mach 2.4 and tops out around Mach 3.2
    maxMach: 1.5, vmax: 1100, vmin: 46, thrustK: 50, dragK: 0.2, cruise: 0.6, gMul: 2.0, startSpeed: 520,
    roll: 70, yaw: 9, pitchLim: 40, kPitch: 3.6, kRoll: 4.6, kThr: 1.0, auth: [60, 150], stall: [52, 82], align: 0.8,
    hs: 2.0, shadow: [56, 34], chase: [8, 44], cockpit: [1.1, -9.5], crash: 3, tail: 11, radius: 26,
    snd: { w0: 380, w1: 480, wg: 0.25, rg: 0.95, rum: 1.3, rlp: 0.55, peak: 230, spl: -3 }, ownLP: 0.6, // buried engines: a low, quiet-ish roar with little whine
  },
  b747: {
    key: 'b747', name: 'Boeing 747', short: '747', build: buildB747Mesh, scale: AIRLINER_SCALE,
    maxMach: 0.84, vmax: 285, vmin: 48, thrustK: 8.0, cruise: 0.6, gMul: 0.2, startSpeed: 190,
    roll: 26, yaw: 6, pitchLim: 18, kPitch: 2.0, kRoll: 2.4, kThr: 0.55, auth: [55, 135], stall: [58, 88], align: 0.5,
    hs: 4.0, shadow: [72, 76], chase: [16, 78], cockpit: [4.6, -33], crash: 8, tail: 38, radius: 40,
    snd: { w0: 700, w1: 900, wg: 0.7, rg: 1.35, rum: 1.6, rlp: 0.55, peak: 210, spl: 3 }, ownLP: 0.55,
  },
};

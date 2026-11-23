'use strict';
/* ==========================================================================
   c17.js - Boeing C-17 Globemaster III: 53 m long, 52 m wingspan, 16 m tall, T-tail, four
   high-bypass turbofans under high swept wings with winglets, big cargo-hold fuselage.
   Same model interface as buildJetMesh() so every Jet / voice / shadow works with it.
   Local axes: nose = -Z, up = +Y, right = +X.
   ========================================================================== */

JET_PALETTES.c17 = { body: 0x9aa1a8, belly: 0x727980, accent: 0x868d94, canopy: 0x16212f };

const C17_SCALE = 1.6; // the model is drawn this much larger than life-size so it reads better in the sky

function buildC17Mesh(landingGear) {
  const pal = JET_PALETTES.c17;
  const parts = [];

  // fuselage: round cargo hold, long blunt nose, upswept tail (profile y = -z: +y is the nose)
  const prof = [
    [0.0, -27.2], [0.7, -27.2], [1.7, -25.2], [2.6, -21.5], [3.1, -16.5], [3.3, -10.0],
    [3.3, 10.0], [3.2, 16.5], [2.85, 20.5], [2.2, 23.6], [1.3, 25.9], [0.0, 27.2],
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  const fus = new THREE.LatheGeometry(prof, gfxLod(20));
  fus.rotateX(-PI / 2);
  fus.scale(1, 0.95, 1);
  const fp = fus.attributes.position;
  for (let i = 0; i < fp.count; i++) { // the rear fuselage sweeps upward to the cargo ramp
    const z = fp.getZ(i);
    if (z > 8) fp.setY(i, fp.getY(i) + 0.0075 * (z - 8) * (z - 8) * (fp.getY(i) < 0 ? 1 : 0.55));
  }
  fus.computeVertexNormals();
  parts.push(twoTone(fus, pal.body, pal.belly));

  // landing-gear sponsons along the belly
  const spon = new THREE.BoxGeometry(1.9, 2.3, 19);
  spon.translate(3.05, -2.0, 3.0);
  twoTone(spon, pal.belly, pal.belly);
  parts.push(spon, mirroredCopy(spon.clone()));

  // high, swept wing with a gentle droop and winglets
  const wing = platePlan([[2.8, -4.2], [25.6, 6.6], [25.6, 10.4], [2.8, 7.0]], 0.6);
  wing.translate(0, 1.5, 0);
  twoTone(wing, pal.body, pal.belly);
  parts.push(wing, mirroredCopy(wing));
  const wl = platePlan([[0, 6.4], [3.4, 9.4], [3.4, 11.8], [0, 10.4]], 0.18);
  wl.rotateZ(PI / 2);
  paintGeometry(wl, pal.accent);
  for (const sx of [1, -1]) {
    const f = wl.clone();
    f.rotateZ(-sx * 0.28);
    f.translate(sx * 25.6, 1.5, 0);
    parts.push(f);
  }

  // T-tail
  const fin = platePlan([[0, 12.8], [10.6, 21.2], [10.6, 25.6], [0, 26.2]], 0.5);
  fin.rotateZ(PI / 2);
  fin.translate(0, 2.2, 0);
  paintGeometry(fin, pal.accent);
  parts.push(fin);
  const tp = platePlan([[0, 21.6], [9.2, 26.0], [9.2, 28.4], [0, 28.4]], 0.32);
  tp.translate(0, 12.7, 0);
  twoTone(tp, pal.body, pal.belly);
  parts.push(tp, mirroredCopy(tp));

  // four turbofans on pylons
  const zLE = (x) => -4.2 + (x - 2.8) * 0.4737;
  for (const sx of [1, -1]) {
    for (const ax of [9.6, 17.2]) {
      const x = sx * ax, zc = zLE(ax) + 0.4, yc = -0.45;
      const nac = new THREE.CylinderGeometry(1.38, 1.3, 7.2, gfxLod(14), 1, false);
      nac.rotateX(PI / 2);
      nac.translate(x, yc, zc);
      paintGeometry(nac, 0xb7bcc2);
      const inlet = new THREE.CylinderGeometry(1.2, 1.2, 0.5, gfxLod(14), 1, false);
      inlet.rotateX(PI / 2);
      inlet.translate(x, yc, zc - 3.55);
      paintGeometry(inlet, 0x1d1f23);
      const noz = new THREE.CylinderGeometry(1.0, 0.8, 1.6, 12, 1, false);
      noz.rotateX(PI / 2);
      noz.translate(x, yc, zc + 4.2);
      paintGeometry(noz, 0x3a3d42);
      const pylon = new THREE.BoxGeometry(0.55, 0.9, 4.6);
      pylon.translate(x, yc + 1.55, zc - 0.2);
      paintGeometry(pylon, 0x868d94);
      parts.push(nac, inlet, noz, pylon);
    }
  }

  const merged = mergeGeometries(parts.map((g) => (g.index ? g : g)));
  const body = new THREE.Mesh(merged, jetBodyMaterial());
  const group = new THREE.Group();
  group.scale.setScalar(C17_SCALE);
  group.add(body);

  // cockpit glass and cargo-door seams
  const canopyGeo = new THREE.SphereGeometry(1, gfxLod(14), gfxLod(10));
  canopyGeo.scale(1.35, 0.7, 2.6);
  canopyGeo.translate(0, 1.55, -21.6);
  const canopy = new THREE.Mesh(
    canopyGeo,
    new THREE.MeshPhongMaterial({ color: pal.canopy, specular: 0xaad0ff, shininess: 150, transparent: true, opacity: 0.92 })
  );
  group.add(canopy);

  // landing gear (shown only when parked)
  const gear = new THREE.Group();
  const gm = new THREE.MeshPhongMaterial({ color: 0x23252a });
  const sm = new THREE.MeshPhongMaterial({ color: 0xb8bcc2 });
  const leg = (x, z, y0, y1) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, y0 - y1, 8), sm);
    c.position.set(x, (y0 + y1) / 2, z);
    gear.add(c);
  };
  const wheel = (x, z, y) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.5, 14), gm);
    w.rotation.z = PI / 2;
    w.position.set(x, y, z);
    gear.add(w);
  };
  leg(0, -19.5, -2.7, -5.0);
  for (const dx of [-0.36, 0.36]) wheel(dx, -19.5, -5.0);
  for (const sx of [1, -1]) {
    for (const zz of [-0.4, 2.2, 4.8]) {
      leg(sx * 3.1, zz, -2.9, -5.0);
      for (const dx of [-0.36, 0.36]) wheel(sx * 3.1 + dx, zz, -5.0);
    }
  }
  gear.visible = !!landingGear;
  group.add(gear);

  // placeholders so the shared fire/vapor logic has something to drive (these jets have no afterburner)
  const dummyMat = () => new THREE.MeshBasicMaterial({ visible: false });
  const flame = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const core = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const vapor = new THREE.Mesh(new THREE.BufferGeometry(), dummyMat());
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ visible: false }));
  flame.visible = core.visible = vapor.visible = glow.visible = false;

  const mkLight = (x, y, z, color, size) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false })
    );
    s.position.set(x, y, z);
    s.scale.set(size, size, 1);
    group.add(s);
    return s;
  };
  const lights = {
    red: mkLight(-25.8, 1.6, 8.4, 0xff2a2a, 4.5),
    green: mkLight(25.8, 1.6, 8.4, 0x30ff50, 4.5),
    strobe: mkLight(0, 13.2, 25.5, 0xffffff, 6),
  };

  return { group, body, canopy, flame, core, glow, lights, pal, vapor, noFlame: true, heavy: true, gear };
}

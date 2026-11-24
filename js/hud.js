'use strict';
/* ==========================================================================
   hud.js - fighter-jet head-up display drawn on a 2D canvas overlay
   ========================================================================== */

const HUD_COL = '#8dffb4';
const HUD_DIM = 'rgba(141,255,180,0.55)';
const HUD_WARN = '#ffd24a';
const HUD_BAD = '#ff5a4a';
const _hv = new THREE.Vector3();

function fmtSpeed(ms) {
  return Settings.data.units === 'metric' ? { v: Math.round(ms * 3.6), u: 'KM/H' } : { v: Math.round(ms * 1.94384), u: 'KT' };
}
function fmtAlt(m) {
  return Settings.data.units === 'metric' ? { v: Math.round(m), u: 'M' } : { v: Math.round(m * 3.28084), u: 'FT' };
}
function fmtRange(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + 'KM' : Math.round(m) + 'M';
}

function hudProject(camera, v, w, h, out) {
  _hv.copy(v).project(camera);
  out.x = (_hv.x * 0.5 + 0.5) * w;
  out.y = (-_hv.y * 0.5 + 0.5) * h;
  out.front = _hv.z < 1 && _hv.z > -1;
  return out;
}

function hudText(ctx, str, x, y, size, color, align, weight) {
  ctx.font = `${weight || 600} ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  if (typeof App !== 'undefined' && App.quality && App.quality.pixelRatio <= 1.25) { // a weaker setting: a cheap drop shadow instead of an outline (stroking text is slow)
    ctx.fillStyle = 'rgba(0,18,10,0.7)';
    ctx.fillText(str, x + 1.4, y + 1.4);
  } else {
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0,18,10,0.65)';
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = color || HUD_COL;
  ctx.fillText(str, x, y);
}

function hudLine(ctx, x0, y0, x1, y1, color, lw) {
  ctx.strokeStyle = 'rgba(0,18,10,0.55)';
  ctx.lineWidth = (lw || 1.6) + 2.2;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.strokeStyle = color || HUD_COL;
  ctx.lineWidth = lw || 1.6;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

function hudCircle(ctx, x, y, r, color, lw) {
  ctx.strokeStyle = 'rgba(0,18,10,0.55)';
  ctx.lineWidth = (lw || 1.6) + 2.2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  ctx.strokeStyle = color || HUD_COL;
  ctx.lineWidth = lw || 1.6;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
}

function drawFlightHUD(m, ctx, w, h) {
  const app = m.app, cam = app.camera, p = m.player;
  const sc = Math.min(w, h * 1.6) / 1280; // UI scale
  ctx.save();
  ctx.lineCap = 'round';

  // damage / hit flash
  if (m.hitFlash > 0) {
    const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.85);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(255,30,20,${Math.min(0.7, m.hitFlash * 0.7)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // low health vignette
  if (p && p.alive && p.hp < 35) {
    const a = 0.25 + 0.15 * Math.sin(app.time * 6);
    const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, h * 0.95);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(200,0,0,${a * (1 - p.hp / 35)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  if (!p || !p.alive) {
    drawMessages(m, ctx, w, h, sc);
    ctx.restore();
    return;
  }

  const pt = { x: 0, y: 0, front: false };
  const fwd = p.getForward(_hv.clone());
  const vd = p.vdir;

  // ---- pitch ladder & horizon ---------------------------------------------------
  const hdgRad = Math.atan2(fwd.x, -fwd.z);
  const camPos = cam.position;
  const ladder = (pitchDeg, half, gap, label) => {
    const pr = pitchDeg * DEG;
    const pts = [];
    for (const d of [-half, -gap, gap, half]) {
      const a = hdgRad + d * DEG;
      _hv.set(camPos.x + Math.sin(a) * Math.cos(pr) * 1000, camPos.y + Math.sin(pr) * 1000, camPos.z - Math.cos(a) * Math.cos(pr) * 1000);
      pts.push(hudProject(cam, _hv, w, h, { x: 0, y: 0, front: false }));
    }
    if (!pts.every((q) => q.front)) return;
    const col = pitchDeg === 0 ? HUD_COL : pitchDeg > 0 ? HUD_DIM : 'rgba(141,255,180,0.4)';
    if (pitchDeg < 0) ctx.setLineDash([7, 6]);
    hudLine(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y, col, 1.4);
    hudLine(ctx, pts[2].x, pts[2].y, pts[3].x, pts[3].y, col, 1.4);
    ctx.setLineDash([]);
    if (label) {
      hudText(ctx, String(Math.abs(pitchDeg)), pts[0].x - 6, pts[0].y, 11 * sc + 3, col, 'right', 600);
      hudText(ctx, String(Math.abs(pitchDeg)), pts[3].x + 6, pts[3].y, 11 * sc + 3, col, 'left', 600);
    }
  };
  ladder(0, 38, 7, false);
  for (const pd of [-60, -40, -30, -20, -10, 10, 20, 30, 40, 60]) ladder(pd, 7, 3, true);

  // ---- reticle & flight path marker ------------------------------------------------
  _hv.copy(p.pos).addScaledVector(fwd, 800);
  hudProject(cam, _hv, w, h, pt);
  if (pt.front) {
    const r = 15 * sc + 3;
    hudCircle(ctx, pt.x, pt.y, r, HUD_COL, 1.8);
    hudLine(ctx, pt.x - r - 8, pt.y, pt.x - r + 4, pt.y, HUD_COL, 1.8);
    hudLine(ctx, pt.x + r + 8, pt.y, pt.x + r - 4, pt.y, HUD_COL, 1.8);
    hudLine(ctx, pt.x, pt.y - r - 8, pt.x, pt.y - r + 4, HUD_COL, 1.8);
    ctx.fillStyle = HUD_COL;
    ctx.fillRect(pt.x - 1.5, pt.y - 1.5, 3, 3);
  }
  _hv.copy(p.pos).addScaledVector(vd, 800);
  hudProject(cam, _hv, w, h, pt);
  if (pt.front) {
    const r = 6.5 * sc + 2;
    hudCircle(ctx, pt.x, pt.y, r, HUD_COL, 1.6);
    hudLine(ctx, pt.x - r, pt.y, pt.x - r - 8, pt.y, HUD_COL, 1.6);
    hudLine(ctx, pt.x + r, pt.y, pt.x + r + 8, pt.y, HUD_COL, 1.6);
    hudLine(ctx, pt.x, pt.y - r, pt.x, pt.y - r - 7, HUD_COL, 1.6);
  }

  // ---- nuclear bombsight: where a bomb released now would land -----------------------
  if (m.nukes && m.state === 'playing' && !m.nukes.cam) {
    const hit = m.nukes.predict(p);
    if (hit) {
      const fl = _hv.copy(p.vel).multiplyScalar(hit.t).add(p.pos); // where YOU will be when it goes off
      const self = Math.hypot(fl.x - hit.x, fl.y - hit.y, fl.z - hit.z), danger = self < 2600;
      const col = danger ? HUD_BAD : HUD_WARN;
      _hv.set(hit.x, hit.y, hit.z);
      hudProject(cam, _hv, w, h, pt);
      const rng = Math.hypot(hit.x - p.pos.x, hit.z - p.pos.z);
      let px = pt.x, py = pt.y, on = pt.front && px > 30 && px < w - 30 && py > 30 && py < h - 30;
      if (!on) { // off screen: pin it to the edge of the view
        const ang = pt.front ? Math.atan2(py - h / 2, px - w / 2) : Math.PI / 2;
        px = clamp(w / 2 + Math.cos(ang) * w, 40, w - 40); py = clamp(h / 2 + Math.sin(ang) * h, 40, h - 40);
        if (!pt.front) { px = w / 2; py = h - 70; }
      }
      const r = 11 * sc + 4;
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath(); ctx.stroke();
      hudLine(ctx, px - r - 7, py, px - r + 3, py, col, 2); hudLine(ctx, px + r + 7, py, px + r - 3, py, col, 2);
      hudLine(ctx, px, py - r - 7, px, py - r + 3, col, 2); hudLine(ctx, px, py + r + 7, px, py + r - 3, col, 2);
      ctx.restore();
      hudText(ctx, `NUKE ${fmtRange(rng)}  ${hit.t.toFixed(0)}s`, px, py + r + 22, 12 * sc + 4, col, 'center', 700);
      if (danger) hudText(ctx, 'DANGER CLOSE', px, py + r + 40, 12 * sc + 4, HUD_BAD, 'center', 700);
      if (!on) hudText(ctx, pt.front ? '' : 'BEHIND', px, py - r - 12, 11 * sc + 3, col, 'center', 700);
    }
  }

  // ---- targets -----------------------------------------------------------------------
  const tgt = m.target;
  for (const en of m.enemies) {
    const j = en.jet;
    if (!j.alive) continue;
    hudProject(cam, j.pos, w, h, pt);
    const dist = j.pos.distanceTo(p.pos);
    const isT = j === tgt;
    const locked = isT && m.lockT >= m.lockNeed;
    const col = locked ? HUD_BAD : isT ? HUD_WARN : 'rgba(255,170,140,0.9)';
    if (pt.front && pt.x > -50 && pt.x < w + 50 && pt.y > -50 && pt.y < h + 50) {
      const px = (16 / dist) * (h / (2 * Math.tan(cam.fov * DEG / 2)));
      const r = Math.max(13 * sc + 4, px * 0.8);
      const L = r * 0.45;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? 'rgba(20,0,0,0.55)' : col;
        ctx.lineWidth = pass === 0 ? 4 : 1.8;
        for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.beginPath();
          ctx.moveTo(pt.x + ax * r, pt.y + ay * (r - L));
          ctx.lineTo(pt.x + ax * r, pt.y + ay * r);
          ctx.lineTo(pt.x + ax * (r - L), pt.y + ay * r);
          ctx.stroke();
        }
      }
      if (locked) {
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = HUD_BAD;
        ctx.lineWidth = 2;
        ctx.strokeRect(-r * 0.62, -r * 0.62, r * 1.24, r * 1.24);
        ctx.restore();
      }
      hudText(ctx, fmtRange(dist), pt.x, pt.y + r + 12, 11 + sc * 2, col, 'center', 600);
      if (locked) hudText(ctx, 'LOCK', pt.x, pt.y - r - 11, 11 + sc * 2, HUD_BAD, 'center', 800);
      // bullet lead marker for the selected target
      if (isT && dist < 1800) {
        const lead = m.leadPoint(j, p);
        if (lead) {
          hudProject(cam, lead, w, h, pt);
          if (pt.front) {
            hudCircle(ctx, pt.x, pt.y, 9 * sc + 2, '#ffb347', 1.6);
            ctx.fillStyle = '#ffb347';
            ctx.fillRect(pt.x - 1.2, pt.y - 1.2, 2.4, 2.4);
          }
        }
      }
    } else {
      // off-screen arrow
      const dx = pt.x - w / 2, dy = pt.y - h / 2;
      let ang = Math.atan2(dy, dx);
      if (!pt.front) ang = Math.atan2(-dy, -dx);
      const rr = Math.min(w, h) * 0.4;
      const ax = w / 2 + Math.cos(ang) * rr, ay = h / 2 + Math.sin(ang) * rr;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(20,0,0,0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(10, 0); ctx.lineTo(-7, -7); ctx.lineTo(-3, 0); ctx.lineTo(-7, 7); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.restore();
    }
  }

  // ---- instruments -----------------------------------------------------------------------
  const shown = p.heavy ? 1 : 1 / FIGHTER_SPEED; // fighters fly faster than the original tuning, but the speedometer reads on the old scale
  const spd = fmtSpeed(p.speed * shown);
  const alt = fmtAlt(p.pos.y);
  const ground = app.world.surfaceAt(p.pos.x, p.pos.z);
  const agl = fmtAlt(Math.max(0, p.pos.y - ground));
  const fs = 20 * sc + 6;
  // speed (left)
  const lx = w * 0.5 - 330 * sc - 40;
  hudText(ctx, String(spd.v), lx, h * 0.5 - 10, fs + 6, HUD_COL, 'right', 700);
  hudText(ctx, spd.u, lx, h * 0.5 + 16, 12 + sc * 2, HUD_DIM, 'right', 600);
  hudText(ctx, 'M ' + p.mach.toFixed(2), lx, h * 0.5 + 38, 14 + sc * 2, HUD_COL, 'right', 600);
  hudText(ctx, 'G ' + p.nLoad.toFixed(1), lx, h * 0.5 + 58, 13 + sc * 2, p.nLoad > 8 ? HUD_WARN : HUD_COL, 'right', 600);
  // altitude (right)
  const rx = w * 0.5 + 330 * sc + 40;
  hudText(ctx, String(alt.v), rx, h * 0.5 - 10, fs + 6, HUD_COL, 'left', 700);
  hudText(ctx, 'ALT ' + alt.u, rx, h * 0.5 + 16, 12 + sc * 2, HUD_DIM, 'left', 600);
  hudText(ctx, 'AGL ' + agl.v, rx, h * 0.5 + 38, 14 + sc * 2, HUD_COL, 'left', 600);
  const vs = Math.round(p.vel.y * (Settings.data.units === 'metric' ? 1 : 196.85) / (Settings.data.units === 'metric' ? 1 : 1));
  hudText(ctx, 'VS ' + (vs > 0 ? '+' : '') + vs, rx, h * 0.5 + 58, 13 + sc * 2, HUD_COL, 'left', 600);

  // heading tape
  const hdg = (hdgRad * RAD + 360) % 360;
  const tw = 360 * sc + 80, ty = 36;
  ctx.save();
  ctx.beginPath();
  ctx.rect(w / 2 - tw / 2, ty - 18, tw, 46);
  ctx.clip();
  const pxPerDeg = tw / 70;
  for (let d = Math.floor(hdg / 5) * 5 - 40; d <= hdg + 40; d += 5) {
    const x = w / 2 + (d - hdg) * pxPerDeg;
    const dd = ((d % 360) + 360) % 360;
    const major = dd % 10 === 0;
    hudLine(ctx, x, ty + 6, x, ty + (major ? -2 : 1), HUD_COL, 1.4);
    if (dd % 30 === 0) {
      const lab = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[dd] || String(dd / 10 | 0).padStart(2, '0');
      hudText(ctx, lab, x, ty + 22, 12 + sc * 2, HUD_COL, 'center', 700);
    }
  }
  ctx.restore();
  hudLine(ctx, w / 2, ty - 16, w / 2, ty - 6, HUD_WARN, 2.4);
  hudText(ctx, String(Math.round(hdg)).padStart(3, '0'), w / 2, ty - 24, 13 + sc * 2, HUD_COL, 'center', 700);

  // throttle & health (bottom centre)
  const bw = 230 * sc + 40, bx = w / 2 - bw / 2, by = h - 66;
  ctx.fillStyle = 'rgba(0,18,10,0.45)';
  ctx.fillRect(bx - 2, by - 2, bw + 4, 12);
  ctx.fillStyle = p.ab > 0.5 ? '#ffa23a' : HUD_COL;
  ctx.fillRect(bx, by, bw * p.throttle, 8);
  hudText(ctx, p.ab > 0.5 ? 'AFTERBURNER' : 'THROTTLE', bx, by - 11, 11 + sc * 2, p.ab > 0.5 ? '#ffa23a' : HUD_DIM, 'left', 700);
  if (p.input.brake) hudText(ctx, 'AIR BRAKE', bx + bw, by - 11, 11 + sc * 2, HUD_WARN, 'right', 700);
  const hy = h - 32;
  ctx.fillStyle = 'rgba(0,18,10,0.45)';
  ctx.fillRect(bx - 2, hy - 2, bw + 4, 12);
  const hp = clamp(p.hp / p.maxHp, 0, 1);
  ctx.fillStyle = hp > 0.5 ? '#6dff8f' : hp > 0.25 ? HUD_WARN : HUD_BAD;
  ctx.fillRect(bx, hy, bw * hp, 8);
  hudText(ctx, 'HULL', bx, hy - 11, 11 + sc * 2, HUD_DIM, 'left', 700);

  // weapons / score (top-left & top-right)
  if (m.kind === 'dogfight') {
    hudText(ctx, 'SCORE ' + m.score, 22, 28, 18 + sc * 3, HUD_COL, 'left', 700);
    hudText(ctx, `WAVE ${Math.max(1, m.wave)}   KILLS ${m.kills}`, 22, 52, 13 + sc * 2, HUD_DIM, 'left', 600);
  } else {
    hudText(ctx, 'FREE FLIGHT', 22, 28, 16 + sc * 3, HUD_COL, 'left', 700);
  }
  hudText(ctx, `MSL ${m.missiles}`, w - 22, 28, 18 + sc * 3, m.missiles > 0 ? HUD_COL : HUD_BAD, 'right', 700);
  hudText(ctx, 'GUN', w - 22, 52, 13 + sc * 2, HUD_DIM, 'right', 600);
  if (tgt && tgt.alive) {
    const d = tgt.pos.distanceTo(p.pos);
    hudText(ctx, `TGT ${fmtRange(d)}`, w - 22, 76, 13 + sc * 2, m.lockT >= m.lockNeed ? HUD_BAD : HUD_WARN, 'right', 700);
  }

  // radar (bottom left)
  drawRadar(m, ctx, 20, h - 20 - 150 * sc - 30, 150 * sc + 30);

  // warnings
  const warns = [];
  if (m.warnPullUp) warns.push(['PULL UP', HUD_BAD]);
  if (p.stalled) warns.push(['STALL', HUD_WARN]);
  if (p.hp < 30) warns.push(['HULL CRITICAL', HUD_BAD]);
  warns.forEach((wn, i) => {
    if (Math.floor(app.time * 4) % 2 === 0) hudText(ctx, wn[0], w / 2, h * 0.28 + i * 36, 28 + sc * 8, wn[1], 'center', 900);
  });

  drawMessages(m, ctx, w, h, sc);

  // controls hint at the start
  if (m.hintT > 0) {
    ctx.globalAlpha = Math.min(1, m.hintT);
    const lines = [
      'W/S pitch   A/D roll   Q/E rudder   SHIFT afterburner   X brake',
      'SPACE cannon   F missile (lock first)   R next target   V camera   P pause',
    ];
    lines.forEach((t, i) => hudText(ctx, t, w / 2, h - 124 + i * 24, 14 + sc * 2, 'rgba(235,245,255,0.95)', 'center', 600));
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawMessages(m, ctx, w, h, sc) {
  let y = h * 0.2;
  for (const msg of m.msgs) {
    const a = Math.min(1, msg.t * 1.6, (msg.life - msg.t) * 1.6);
    ctx.globalAlpha = clamp(a, 0, 1);
    hudText(ctx, msg.text, w / 2, y, msg.size * (0.8 + sc * 0.3), msg.color, 'center', 800);
    y += msg.size * 1.1;
  }
  ctx.globalAlpha = 1;
}

function drawRadar(m, ctx, x, y, size) {
  const p = m.player;
  const cx = x + size / 2, cy = y + size / 2, R = size / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(0,22,12,0.5)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  hudCircle(ctx, cx, cy, R, HUD_DIM, 1.4);
  hudCircle(ctx, cx, cy, R * 0.5, 'rgba(141,255,180,0.25)', 1);
  hudLine(ctx, cx, cy - R, cx, cy + R, 'rgba(141,255,180,0.2)', 1);
  hudLine(ctx, cx - R, cy, cx + R, cy, 'rgba(141,255,180,0.2)', 1);
  // heading-up
  const fwd = p.getForward(_hv.clone());
  const hdg = Math.atan2(fwd.x, -fwd.z);
  const RANGE = 7000;
  for (const en of m.enemies) {
    const j = en.jet;
    if (!j.alive) continue;
    const dx = j.pos.x - p.pos.x, dz = j.pos.z - p.pos.z;
    // rotate world offset into heading-up screen space
    const c = Math.cos(hdg), s = Math.sin(hdg);
    const fx = dx * s - dz * c; // along heading
    const rx = dx * c + dz * s; // to the right
    let px = rx / RANGE, py = -fx / RANGE;
    const len = Math.hypot(px, py);
    if (len > 0.96) { px *= 0.96 / len; py *= 0.96 / len; }
    const sx = cx + px * R, sy = cy + py * R;
    const isT = j === m.target;
    ctx.fillStyle = isT ? HUD_WARN : '#ff6a55';
    ctx.beginPath();
    ctx.arc(sx, sy, isT ? 4.5 : 3.5, 0, TAU);
    ctx.fill();
    const above = j.pos.y - p.pos.y;
    if (Math.abs(above) > 150) {
      ctx.fillStyle = ctx.fillStyle;
      ctx.fillRect(sx - 3, sy + (above > 0 ? -8 : 6), 6, 2);
    }
  }
  // the hurricane: a blue swirl on the rim of the radar, in the direction it lies
  const wxr = m.app.world && m.app.world.weather;
  if (wxr && wxr.hurricane) {
    const hu = wxr.hurricane;
    const dx = hu.x - p.pos.x, dz = hu.z - p.pos.z;
    const c = Math.cos(hdg), s = Math.sin(hdg);
    let px = (dx * c + dz * s) / RANGE, py = -(dx * s - dz * c) / RANGE;
    const len = Math.hypot(px, py);
    if (len > 0.86) { px *= 0.86 / len; py *= 0.86 / len; }
    const sx = cx + px * R, sy = cy + py * R;
    ctx.strokeStyle = '#7fd8ff'; ctx.fillStyle = '#7fd8ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0.4, TAU - 0.9); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, 3, 0, TAU); ctx.fill();
    ctx.font = '700 10px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('H', sx, sy - 11);
  }
  // player
  ctx.fillStyle = HUD_COL;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4.5, cy + 5); ctx.lineTo(cx + 4.5, cy + 5); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Yuddha Arena — strike physics, punishment/stun model and procedural impact audio.
//
// An original hands-only kung-fu interpretation of realism principles common to VR
// fight sims: velocity-gated power with a controller-speed cap, solid vs glancing
// contact, weak-point zones, move-in bonus, stuns, and a short/long-term punishment
// pool instead of an arcade health bar. No in-game stamina: your real arms tire.

export const STRIKE = {
  TOUCH_SPEED: 0.5,   // m/s — below this nothing registers; between this and MIN_SPEED it is a light touch
  MIN_SPEED: 1.2,     // m/s — below this a contact is a touch, not a strike (Quest controllers punch ~4–7 m/s)
  FULL_SPEED: 7.0,    // m/s — full power
  MAX_SPEED: 10.0,    // m/s — controller tracking is unreliable above ~10 m/s, so cap here
  MAX_DMG: 30,        // damage of a full-power, solid, neutral-zone strike
  MIN_TRAVEL: 0.20,   // m of shoulder-relative travel; short enough for chain punches, blocks flailing
  GLANCE_ALIGN: 0.35, // strike-direction · surface-normal below this = glancing
  SOLID_ALIGN: 0.75,  // above this = solid
  GLANCE_MULT: 0.15,
  STUN_DMG: 24,       // single head strike at/above this stuns
  STUN_MULT: 1.5,     // stunned targets take +50%
  BLOCK_MULT: 0.10,   // clean parry lets 10% through
  MOVE_IN_GAIN: 0.8,  // fraction of target-head speed toward the fist added to strike speed
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 0 … ~1.15 power curve from fist speed.
export function powerFromSpeed(speed) {
  if (speed < STRIKE.TOUCH_SPEED) return 0;
  if (speed < STRIKE.MIN_SPEED) return 0.02 * (speed / STRIKE.MIN_SPEED); // glancing light touch: ~0.6 dmg
  const s = Math.min(speed, STRIKE.MAX_SPEED);
  const t = clamp((s - STRIKE.MIN_SPEED) / (STRIKE.FULL_SPEED - STRIKE.MIN_SPEED), 0, 1.3);
  return Math.max(0.02, Math.pow(t, 1.35) * 0.9 + 0.1 * Math.min(1, t * 4)); // light snaps still register a little; continuous with the touch range
}

// align = cos(angle) between strike direction and the into-surface direction.
export function strikeQuality(align) {
  if (align <= STRIKE.GLANCE_ALIGN) return { label: 'GLANCING', mult: STRIKE.GLANCE_MULT };
  if (align >= STRIKE.SOLID_ALIGN) return { label: 'SOLID', mult: 1 };
  const t = (align - STRIKE.GLANCE_ALIGN) / (STRIKE.SOLID_ALIGN - STRIKE.GLANCE_ALIGN);
  return { label: 'GLANCING', mult: STRIKE.GLANCE_MULT + (1 - STRIKE.GLANCE_MULT) * t * t };
}

// Weak-point zones from the contact point in the defender's own frame.
// d = {fwd, up, right} offsets (m) from head centre (head) or chest point (body).
export function headZone(d) {
  if (d.fwd > 0.03 && d.up < -0.035) return { zone: 'JAW', mult: 1.45, head: true };
  if (Math.abs(d.right) > 0.07 && d.up > -0.03) return { zone: 'TEMPLE', mult: 1.3, head: true };
  return { zone: 'HEAD', mult: 1.0, head: true };
}
export function bodyZone(d) {
  if (d.fwd > 0 && Math.abs(d.right) < 0.07 && d.up > -0.17 && d.up < 0.04) return { zone: 'SOLAR PLEXUS', mult: 1.3, head: false };
  if (d.right > 0.05 && d.up < -0.12) return { zone: 'LIVER', mult: 1.35, head: false };
  return { zone: 'BODY', mult: 0.8, head: false };
}

// Full strike resolution → damage + labels.
export function computeStrike({ speed, align, zone, stunned = false, moveInSpeed = 0, guard = false, cleanBlock = false }) {
  const effSpeed = speed + (zone && zone.head ? Math.max(0, moveInSpeed) * STRIKE.MOVE_IN_GAIN : 0);
  const power = powerFromSpeed(effSpeed);
  const q = strikeQuality(align);
  let dmg = STRIKE.MAX_DMG * power * q.mult * (zone ? zone.mult : 1);
  if (stunned) dmg *= STRIKE.STUN_MULT;
  if (guard) dmg *= cleanBlock ? STRIKE.BLOCK_MULT : 0.45;
  return { dmg, power, quality: q.label, effSpeed };
}

// ── Punishment: short-term pool knocks you down, long-term shrinks the pool ──
export function createPunishment() {
  return { stp: 0, ltp: 0, pendingBody: 0, stunT: 0, downT: 0, lastStrikeT: 99, knockdowns: 0 };
}
export function capacity(p) { return Math.max(35, 100 - 0.6 * p.ltp); }
// isStriking: has this fighter thrown a strike recently (delays recovery).
export function stepPunishment(p, dt, threwStrike) {
  p.lastStrikeT = threwStrike ? 0 : p.lastStrikeT + dt;
  p.stunT = Math.max(0, p.stunT - dt);
  if (p.downT > 0) {
    p.downT = Math.max(0, p.downT - dt);
    if (p.downT === 0) { p.stp = 0; p.pendingBody = 0; }
    return false;
  }
  // Body damage soaks in over ~2.5 s.
  if (p.pendingBody > 0) {
    const d = Math.min(p.pendingBody, (p.pendingBody * 0.4 + 4) * dt);
    p.pendingBody -= d; p.stp += d;
  }
  // Recover when not striking; 30% of what recovers becomes long-term wear.
  if (p.lastStrikeT > 0.5 && p.stp > 0) {
    const r = Math.min(p.stp, 7 * dt);
    p.stp -= r; p.ltp = Math.min(100, p.ltp + r * 0.3);
  }
  if (p.stp >= capacity(p)) return knockDown(p);
  return false;
}
function knockDown(p) {
  p.downT = 3.2; p.stunT = 0; p.knockdowns++;
  p.ltp = Math.min(100, p.ltp + 12);
  return true;
}
// Returns { stunned, knockdown }.
export function applyHit(p, dmg, isHead) {
  if (p.downT > 0) return { stunned: false, knockdown: false };
  let stunned = false;
  if (isHead) {
    p.stp += dmg;
    if (dmg >= STRIKE.STUN_DMG && p.stunT <= 0) { p.stunT = clamp(1.5 + (dmg - STRIKE.STUN_DMG) / 10, 1.5, 3.5); stunned = true; }
  } else {
    p.stp += dmg * 0.35; p.pendingBody += dmg * 0.65;
  }
  if (p.stp >= capacity(p)) return { stunned, knockdown: knockDown(p) };
  return { stunned, knockdown: false };
}
// 0..100 "condition" for HUD bars.
export function condition(p) { return p.downT > 0 ? 0 : clamp(100 * (1 - (p.stp + p.pendingBody) / capacity(p)), 0, 100); }

// ── Procedural impact audio (WebAudio, no samples) ─────────────────────
export function createImpactAudio() {
  let ctx = null, noise = null, master = null;
  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    return ctx;
  }
  function env(g, t0, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }
  function noiseBurst(t0, type, f0, f1, q, peak, decay) {
    const src = ctx.createBufferSource(); src.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(f1, t0 + decay);
    const g = ctx.createGain(); env(g, t0, peak, 0.004, decay);
    src.connect(f).connect(g).connect(master); src.start(t0); src.stop(t0 + decay + 0.05);
  }
  function tone(t0, type, f0, f1, peak, decay) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + decay);
    const g = ctx.createGain(); env(g, t0, peak, 0.005, decay);
    o.connect(g).connect(master); o.start(t0); o.stop(t0 + decay + 0.05);
  }
  return {
    resume() { const c = ensure(); if (c && c.state === 'suspended') c.resume(); },
    play(kind, intensity = 1) {
      if (!ensure() || ctx.state !== 'running') return;
      const t = ctx.currentTime, k = clamp(intensity, 0.05, 1);
      switch (kind) {
        case 'solid': // flesh smack + deep thump
          noiseBurst(t, 'lowpass', 2600, 380, 0.9, 0.55 * k + 0.1, 0.09 + 0.06 * k);
          tone(t, 'sine', 120 + 40 * k, 48, 0.6 * k + 0.1, 0.16 + 0.08 * k);
          break;
        case 'glance': // skin brush
          noiseBurst(t, 'bandpass', 3800, 1800, 1.4, 0.12 + 0.12 * k, 0.05);
          break;
        case 'block': // forearm-on-forearm knock
          noiseBurst(t, 'bandpass', 1400, 700, 2.0, 0.3 * k + 0.08, 0.06);
          tone(t, 'triangle', 260, 180, 0.22 * k + 0.05, 0.07);
          break;
        case 'stun': // heavy hit + ringing
          noiseBurst(t, 'lowpass', 3000, 300, 0.9, 0.7, 0.16);
          tone(t, 'sine', 140, 40, 0.75, 0.3);
          tone(t + 0.02, 'sine', 1320, 1180, 0.08, 1.1);
          break;
        case 'down': // body hits the floor
          tone(t, 'sine', 70, 32, 0.9, 0.55);
          noiseBurst(t, 'lowpass', 900, 120, 0.7, 0.5, 0.4);
          break;
        case 'whiff': // short-travel / too-slow touch
          noiseBurst(t, 'highpass', 2500, 4000, 0.7, 0.05, 0.04);
          break;
      }
    },
  };
}

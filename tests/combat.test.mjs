import test from 'node:test';
import assert from 'node:assert/strict';
import { STRIKE, powerFromSpeed, computeStrike, headZone, bodyZone, createPunishment, applyHit, stepPunishment } from '../combat.js';

test('strikes below the touch gate do nothing; light touches are tiny; power caps at the controller limit', () => {
  assert.equal(powerFromSpeed(STRIKE.TOUCH_SPEED - 0.1), 0);
  const touch = powerFromSpeed((STRIKE.TOUCH_SPEED + STRIKE.MIN_SPEED) / 2);
  assert.ok(touch > 0 && touch * STRIKE.MAX_DMG < 1, 'a light touch does under 1 damage');
  assert.ok(powerFromSpeed(4) * STRIKE.MAX_DMG > 8, 'an ordinary 4 m/s Quest punch does real damage');
  assert.ok(powerFromSpeed(STRIKE.MIN_SPEED) > touch);
  assert.ok(powerFromSpeed(8) > powerFromSpeed(5));
  assert.equal(powerFromSpeed(12), powerFromSpeed(STRIKE.MAX_SPEED));
});

test('glancing contact does far less than solid contact', () => {
  const solid = computeStrike({ speed: 8, align: 0.95, zone: { mult: 1, head: true } }).dmg;
  const glance = computeStrike({ speed: 8, align: 0.2, zone: { mult: 1, head: true } }).dmg;
  assert.ok(glance < solid * 0.2);
});

test('weak points multiply damage', () => {
  assert.equal(headZone({ fwd: 0.06, up: -0.06, right: 0 }).zone, 'JAW');
  assert.equal(headZone({ fwd: 0, up: 0, right: 0.09 }).zone, 'TEMPLE');
  assert.equal(bodyZone({ fwd: 0.1, up: -0.05, right: 0 }).zone, 'SOLAR PLEXUS');
  assert.equal(bodyZone({ fwd: 0, up: -0.2, right: 0.1 }).zone, 'LIVER');
});

test('big head shot stuns; accumulated punishment knocks down; body damage soaks in', () => {
  const p = createPunishment();
  assert.equal(applyHit(p, 26, true).stunned, true);
  const q = createPunishment();
  assert.equal(applyHit(q, 30, false).stunned, false);
  assert.ok(q.pendingBody > 0);
  for (let i = 0; i < 60; i++) stepPunishment(q, 1 / 30, true);
  assert.ok(q.pendingBody < 19.5 * 0.5);
  const r = createPunishment();
  let kd = false;
  for (let i = 0; i < 10 && !kd; i++) kd = applyHit(r, 18, true).knockdown;
  assert.equal(kd, true);
});

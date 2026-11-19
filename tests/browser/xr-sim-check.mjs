// Browser checks for the Quest-facing behaviour that can be exercised without a headset:
//   1. Hits land: a fist moving at ordinary punching speed (4 m/s) into the sparring partner's head
//      and body registers damage, using raw grip-space poses in the same transform setup as WebXR
//      (rigGroup offset + camera local pose), at any frame rate.
//   2. The sparring partner stands inside arm's reach and steps back in when you back off.
//   3. Arms are connected: upper-arm / forearm / hand bones coincide with shoulder / elbow / wrist.
//   4. Mixed reality: the button waits for the support check, requests immersive-ar, and with
//      passthrough active nothing opaque is left in the framebuffer.
// Run:  node tests/browser/xr-sim-check.mjs [http://localhost:8099/index.html]
// Needs playwright-core + Chrome:  PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROME=/usr/bin/google-chrome
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const url = process.argv[2] || 'http://localhost:8099/index.html';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };
const rx = (deg) => { const h = deg * Math.PI / 360; return [Math.sin(h), 0, 0, Math.cos(h)]; };
const GRIP_Q = rx(60); // controller held in a guard: grip -Z tilted up, as a Touch controller reports it

async function open({ qs = '', init = null, shotDir = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.goto(url + qs, { waitUntil: 'networkidle' });
  return { page, errors };
}
async function startDuel(page, mode = 4) {
  await page.click('#desktop-btn'); await page.keyboard.press('Digit' + mode);
  await page.waitForFunction(() => window.__yuddha?.opp && window.__yuddha.realHandsTris, null, { timeout: 60000 });
  await page.evaluate((q) => {
    const y = window.__yuddha; y.manual = true;
    y.sim = { head: [0.0, 1.65, 0.0], headQuat: [0, 0, 0, 1], l: { p: [-0.16, 1.38, -0.34], q }, r: { p: [0.16, 1.38, -0.34], q }, curl: 1, xrLike: true };
  }, GRIP_Q);
  await page.evaluate(() => { for (let i = 0; i < 40; i++) window.__yuddha.step(11.1); });
}
// Move the right fist from→to at `speed` m/s using frames of `ms` ms (grip pose, raw, like a headset reports).
async function punch(page, from, to, speed, ms = 11.1) {
  return page.evaluate(({ from, to, speed, ms }) => {
    const y = window.__yuddha, d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], L = Math.hypot(...d);
    const frames = Math.max(2, Math.round(L / (speed * ms / 1000)));
    // Rest the fist at the start point first so the test measures the punch, not a teleport.
    y.sim.r.p = from.slice(); for (let i = 0; i < 25; i++) y.step(ms);
    const before = { hits: y.state.hits, score: y.state.score, hp1: y.state.hp1, callout: y.state.callout };
    let maxSpeed = 0;
    for (let i = 0; i <= frames + 6; i++) {
      const t = Math.min(1, i / frames);
      y.sim.r.p = [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
      y.step(ms);
      maxSpeed = Math.max(maxSpeed, y.state.f0R.vel.length());
    }
    return { before, hits: y.state.hits - before.hits, score: y.state.score - before.score, hp1: y.state.hp1, callout: y.state.callout, maxSpeed };
  }, { from, to, speed, ms });
}
const settle = (page, n = 60) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__yuddha.step(11.1); }, n);

// ── 1 & 2: hits and distance ───────────────────────────────────────────
for (const ms of [11.1, 16.7, 8.3]) {
  const { page, errors } = await open();
  await startDuel(page);
  const head = await punch(page, [0.05, 1.55, -0.12], [0.05, 1.55, -0.52], 4, ms);
  check(`head punch at 4 m/s registers (${(1000 / ms).toFixed(0)} fps)`, head.hits >= 1 && head.score > 4, `hits=${head.hits} dmg=${head.score.toFixed(1)} measured ${head.maxSpeed.toFixed(1)} m/s "${head.callout}"`);
  await page.close();
  check('no page errors', errors.length === 0, errors.join('; '));
}
{
  const { page } = await open();
  await startDuel(page);
  const body = await punch(page, [0.12, 1.32, -0.14], [0.12, 1.26, -0.52], 4);
  check('body punch at 4 m/s registers', body.hits >= 1 && body.score > 2, `hits=${body.hits} dmg=${body.score.toFixed(1)} "${body.callout}"`);
  await page.close();
}
{
  const { page } = await open();
  await startDuel(page);
  const g = await page.evaluate(() => { const y = window.__yuddha; return { d: y.rig0.head.z - y.rig1.head.z, chest: y.rig0.chest.z - y.rig1.chest.z }; });
  check('sparring partner stands in punching range (head 0.55–0.75 m from yours)', g.d > 0.55 && g.d < 0.75, `head distance ${g.d.toFixed(2)} m, chest-to-chest ${g.chest.toFixed(2)} m`);
  const touch = await punch(page, [0.05, 1.55, -0.40], [0.05, 1.55, -0.52], 0.8);
  check('light touch (0.8 m/s) does low damage, not none and not a knockout', touch.score > 0 && touch.score < 3, `dmg=${touch.score.toFixed(2)}`);
  await settle(page, 30);
  // back off 0.45 m and confirm he steps back in
  await page.evaluate(() => { const y = window.__yuddha; for (let i = 0; i <= 30; i++) { y.sim.head = [0, 1.65, 0.45 * i / 30]; y.sim.l.p = [-0.16, 1.38, -0.34 + 0.45 * i / 30]; y.sim.r.p = [0.16, 1.38, -0.34 + 0.45 * i / 30]; y.step(11.1); } });
  await settle(page, 120);
  const back = await page.evaluate(() => { const y = window.__yuddha; return y.rig0.head.z - y.rig1.head.z; });
  check('partner steps in when you back off', back > 0.55 && back < 0.75, `head distance after backing off ${back.toFixed(2)} m`);
  await page.close();
}
{
  // Reach limit of a real arm: shoulder-to-grip ≤ 0.6 m must still reach the head.
  const { page } = await open();
  await startDuel(page);
  const far = await punch(page, [0.05, 1.55, -0.12], [0.05, 1.55, -0.42], 4);
  check('punch at ~75% arm extension still lands', far.hits >= 1, `hits=${far.hits} "${far.callout}"`);
  await page.close();
}

// ── 3: arms are connected ─────────────────────────────────────────────
{
  const { page } = await open();
  await startDuel(page);
  const res = await page.evaluate(() => {
    const y = window.__yuddha, out = [];
    const poses = [[0.16, 1.38, -0.34], [0.16, 1.55, -0.62], [0.35, 1.3, -0.2], [0.1, 1.0, -0.1]]; // guard, full reach, wide hook, low
    for (const p of poses) {
      y.sim.r.p = p; y.sim.l.p = [-p[0], p[1], p[2]]; y.step(11.1);
      for (const side of ['left', 'right']) {
        const b = y.f0.real.bonePositions(side), r = y.rig0, k = side === 'left';
        const sh = k ? r.lSh : r.rSh, el = k ? r.lEl : r.rEl, wr = k ? r.lWr : r.rWr;
        out.push({ side, p, shoulderGap: b.up.distanceTo(sh), elbowGap: b.lo.distanceTo(el), wristGap: b.hd.distanceTo(wr), upper: sh.distanceTo(el), fore: el.distanceTo(wr), reach: sh.distanceTo(wr) });
      }
    }
    return out;
  });
  const worst = Math.max(...res.flatMap((r) => [r.shoulderGap, r.elbowGap, r.wristGap]));
  check('skinned arm bones sit exactly on shoulder, elbow and wrist (no gaps) in 4 poses', worst < 1e-3, `worst gap ${(worst * 1000).toFixed(3)} mm`);
  const lens = res.flatMap((r) => [r.upper, r.fore]);
  check('upper arm and forearm stay human length (0.28–0.36 m)', Math.min(...lens) > 0.28 && Math.max(...lens) < 0.36, `${Math.min(...lens).toFixed(3)}–${Math.max(...lens).toFixed(3)} m`);
  await page.close();
}

// ── 4: mixed reality ───────────────────────────────────────────────────
{
  const mock = () => {
    window.__reqs = [];
    const xr = {
      isSessionSupported: (m) => new Promise((r) => setTimeout(() => r(m === 'immersive-ar' || m === 'immersive-vr'), 2500)),
      requestSession: async (m) => { window.__reqs.push(m); return { environmentBlendMode: 'alpha-blend', addEventListener() {}, end() {} }; },
    };
    Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
  };
  const { page } = await open({ init: mock });
  const early = await page.evaluate(() => { const b = document.getElementById('enter-vr-btn'); return { disabled: b.disabled, text: b.textContent }; });
  check('enter button is disabled until the AR/VR support check finishes', early.disabled === true, early.text);
  await page.waitForFunction(() => !document.getElementById('enter-vr-btn').disabled, null, { timeout: 8000 });
  const ready = await page.evaluate(() => ({ text: document.getElementById('enter-vr-btn').textContent, fullVr: document.getElementById('enter-fullvr-btn').style.display }));
  check('default button is MIXED REALITY; full-VR stays available as an option', /MIXED REALITY/.test(ready.text) && ready.fullVr === '', ready.text);
  await page.click('#enter-vr-btn');
  await page.waitForFunction(() => window.__yuddha.xrLog.some((e) => e.phase === 'passthrough' || e.phase === 'error'), null, { timeout: 5000 });
  const log = await page.evaluate(() => ({ reqs: window.__reqs, log: window.__yuddha.xrLog }));
  check('tapping the main button requests immersive-ar', log.reqs[0] === 'immersive-ar', JSON.stringify(log.reqs));
  const pass = log.log.find((e) => e.phase === 'passthrough');
  check("alpha-blend session turns passthrough on (blend mode is read from the session)", pass && pass.passthrough === true && pass.blend === 'alpha-blend', JSON.stringify(log.log));
  await page.close();
}
{
  // Tap before the support check resolves → still goes AR (no race into full VR).
  const mock = () => {
    window.__reqs = [];
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      isSessionSupported: (m) => new Promise((r) => setTimeout(() => r(true), 500)),
      requestSession: async (m) => { window.__reqs.push(m); throw new Error('stop'); },
    } });
  };
  const { page } = await open({ init: mock });
  await page.evaluate(() => window.__yuddha.startXR('auto'));
  const reqs = await page.evaluate(() => window.__reqs);
  check('a tap that arrives before the support check completes still requests immersive-ar', reqs[0] === 'immersive-ar', JSON.stringify(reqs));
  await page.close();
}
{
  const { page } = await open({ qs: '?passthroughPreview=1' });
  await startDuel(page, 2); // mitts mode: no sparring partner landing a punch (hit tint) during the probe
  const mr = await page.evaluate(() => window.__yuddha.mr());
  check('passthrough mode hides the hall, background and fog and clears with alpha 0', !mr.envVisible && !mr.background && !mr.fog && mr.clearAlpha === 0, JSON.stringify(mr));
  const a = await page.evaluate(() => window.__yuddha.probeAlpha());
  check('framebuffer corners are fully transparent (nothing opaque covers the room)', Object.values(a).every((v) => v === 0), JSON.stringify(a));
  await page.close();
}

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

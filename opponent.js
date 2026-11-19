// Yuddha Arena — realistic skinned opponent (Quaternius Universal Base Character,
// CC0, with clips from the Quaternius Universal Animation Library, CC0).
// Skeletal animation drives the body; hitboxes are read back from the bones every
// frame so head / jaw / torso / liver zones always line up with what you see.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

let _skinMat = null;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const YAW_180 = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);

export async function loadOpponent(urlOrGltf, { skinTint = null } = {}) {
  const gltf = typeof urlOrGltf === 'string' ? await loadFighterGLTF(urlOrGltf) : urlOrGltf;
  const model = SkeletonUtils.clone(gltf.scene);
  const bones = {};
  let tris = 0;
  model.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow animation
      const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      const m = o.material;
      if (m && m.isMeshStandardMaterial && /Superhero|Male/i.test(m.name)) {
        // Skin: slightly glossy (sweat sheen), warm sheen at grazing angles for a fleshy look.
        const skin = new THREE.MeshPhysicalMaterial({
          map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap,
          roughness: 0.78, metalness: 0, normalScale: new THREE.Vector2(1.15, 1.15),
          sheen: 0.55, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xd9644a),
          clearcoat: 0.18, clearcoatRoughness: 0.42,
        });
        if (skinTint) skin.color.set(skinTint);
        skin.name = m.name;
        _skinMat = skin;
        o.material = skin;
      }
    }
  });
  const root = new THREE.Group();
  root.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const clip = (n) => gltf.animations.find((a) => a.name === n);
  const act = (n, once = false) => {
    const a = mixer.clipAction(clip(n));
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    return a;
  };
  const A = {
    // First frames of the jab = fighting stance (separate sub-clip so it doesn't share the jab action).
    guard: mixer.clipAction(THREE.AnimationUtils.subclip(clip('Punch_Jab'), 'Guard', 0, 2, 30)),
    idle: act('Idle_Loop'),        // hands-down idle = stunned / dropped guard
    jab: act('Punch_Jab', true),
    cross: act('Punch_Cross', true),
    hitHead: act('Hit_Head', true),
    hitBody: act('Hit_Chest', true),
    knock: act('Hit_Knockback', true),
    down: act('Death01', true),
    getUp: act('LayToIdle', true),
  };
  const ONE_SHOTS = ['jab', 'cross', 'hitHead', 'hitBody', 'knock', 'down', 'getUp'];
  A.guard.play(); A.guard.timeScale = 0;
  A.idle.play(); A.idle.setEffectiveWeight(0.12); // breathing life into the guard

  let current = null; // active one-shot
  let mode = 'guard';
  function oneShot(a, { fade = 0.06, timeScale = 1 } = {}) {
    if (current && current !== a) current.fadeOut(fade);
    a.reset(); a.setEffectiveTimeScale(timeScale); a.setEffectiveWeight(1); a.fadeIn(fade); a.play();
    current = a;
  }
  mixer.addEventListener('finished', (e) => {
    if (e.action === current && (mode === 'strike' || mode === 'hit')) {
      current.fadeOut(0.18); current = null; mode = 'guard';
    }
  });

  // Procedural hit-reaction offsets layered on top of the animation.
  const spring = { off: new THREE.Vector3(), vel: new THREE.Vector3() };
  const strikeHand = { side: null };

  const api = {
    root, model, bones, mixer, tris, skinMaterial: _skinMat,
    get mode() { return mode; },
    get striking() { return mode === 'strike'; },
    get strikeSide() { return strikeHand.side; },
    strike(kind) {
      if (mode !== 'guard') return false;
      mode = 'strike'; strikeHand.side = kind === 'jab' ? 'left' : 'right';
      oneShot(kind === 'jab' ? A.jab : A.cross, { timeScale: kind === 'jab' ? 1.05 : 1.1 });
      return true;
    },
    react(isHead, dirWorld, dmg) {
      spring.vel.addScaledVector(dirWorld, Math.min(2.2, 0.3 + dmg * 0.07));
      if (mode === 'down') return;
      if (dmg < 4) return; // light touches: spring only
      mode = 'hit';
      oneShot(dmg > 22 ? A.knock : isHead ? A.hitHead : A.hitBody, { fade: 0.04, timeScale: 1.15 });
    },
    knockDown() {
      mode = 'down';
      oneShot(A.down, { fade: 0.12, timeScale: 1.25 });
    },
    getUp() {
      if (mode !== 'down') return;
      mode = 'getup';
      oneShot(A.getUp, { fade: 0.2, timeScale: 1.3 });
      setTimeout(() => { if (mode === 'getup') { current && current.fadeOut(0.3); current = null; mode = 'guard'; } }, 1100);
    },
    // stunned: guard drops (idle takes over) and the head wobbles.
    update(dt, { stunned = false, t = 0 } = {}) {
      // Base layer (guard/idle) yields to whatever one-shots are playing or fading.
      let w = 0;
      for (const k of ONE_SHOTS) w += A[k].enabled && A[k].isScheduled() ? A[k].getEffectiveWeight() : 0;
      const base = Math.max(0, 1 - w);
      const stunIdle = stunned && mode === 'guard';
      A.idle.setEffectiveWeight(base * (stunIdle ? 1 : 0.12));
      A.guard.setEffectiveWeight(base * (stunIdle ? 0 : 1));
      mixer.update(dt);
      // spring
      spring.vel.addScaledVector(spring.off, -110 * dt);
      spring.vel.multiplyScalar(Math.exp(-9 * dt));
      spring.off.addScaledVector(spring.vel, dt).clampLength(0, 0.3);
      // convert world offset to a lean on spine + head (in model space)
      _v.copy(spring.off).applyQuaternion(_q.copy(root.quaternion).invert());
      const wob = stunned ? Math.sin(t * 6.5) * 0.12 : 0;
      const sp = bones.spine_03, hd = bones.Head;
      if (sp) { _e.set(_v.z * 1.4, 0, -_v.x * 1.4 + wob * 0.4); sp.quaternion.multiply(_q.setFromEuler(_e)); }
      if (hd) { _e.set(_v.z * 2.6 + (stunned ? 0.15 : 0), wob, -_v.x * 2.6 + wob); hd.quaternion.multiply(_q.setFromEuler(_e)); }
      root.updateMatrixWorld(true);
    },
    // Hitbox rig in the same shape solveArmRig() returns.
    rig(out = {}) {
      const p = (n, v = new THREE.Vector3()) => bones[n].getWorldPosition(v);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion);
      out.head = p('Head').addScaledVector(UP, 0.085).addScaledVector(fwd, 0.035);
      out.headQuat = root.quaternion.clone().multiply(YAW_180); // -Z forward convention
      out.lSh = p('upperarm_l'); out.rSh = p('upperarm_r');
      out.lEl = p('lowerarm_l'); out.rEl = p('lowerarm_r');
      out.lH = p('hand_l').lerp(p('middle_01_l'), 0.6);
      out.rH = p('hand_r').lerp(p('middle_01_r'), 0.6);
      out.lHQ = bones.hand_l.getWorldQuaternion(new THREE.Quaternion());
      out.rHQ = bones.hand_r.getWorldQuaternion(new THREE.Quaternion());
      out.chest = p('spine_03').addScaledVector(UP, 0.04);
      out.pelvis = p('spine_01');
      out.ringOffset = new THREE.Vector3();
      return out;
    },
    placeFacing(pos, target) {
      root.position.copy(pos);
      const dx = target.x - pos.x, dz = target.z - pos.z;
      root.rotation.set(0, Math.atan2(dx, dz), 0);
    },
  };
  return api;
}

// ── Player arms cut from the same realistic character ───────────────────
// Upper arm, forearm, hand and fingers of a skeleton clone are kept (shoulder cap, torso
// and head are not drawn by the skin). The arm bones are detached from the body skeleton and
// placed every frame from a two-bone IK solution: shoulder (estimated from the headset) →
// elbow → wrist (from the controller grip pose). Each bone is a rigid segment, stretched
// uniformly a little if the arm has to reach further than its length, so the hand never
// separates from the arm. Finger bones curl from the same 0..1 values as the procedural hands.
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
// Flexion (radians) per joint at full curl.
const CURL_MAX = { thumb: [0.55, 0.5, 0.65], index: [1.45, 1.65, 1.05], middle: [1.5, 1.7, 1.1], ring: [1.5, 1.7, 1.1], pinky: [1.5, 1.6, 1.05] };
// Hand tilt around the grip's X axis: a hand never holds a Touch handle exactly square to the
// forearm — the handle crosses the palm obliquely, so the forearm leans back toward the elbow.
export const GRIP_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(40));
// Wrist (hand bone origin) in grip space, before the tilt. Forearm continues along +Y.
export const WRIST_IN_GRIP = { l: new THREE.Vector3(-0.024, 0.095, 0.007), r: new THREE.Vector3(0.024, 0.095, 0.007) };
export const FOREARM_IN_GRIP = new THREE.Vector3(0, 1, 0); // wrist → elbow, in grip space before the tilt
export const ARM_L1 = 0.30, ARM_L2 = 0.29;               // upper arm / forearm length in the world (m)
const HAND_SCALE = 1.12;
const SKIN_BONE = /^(upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)_.*?([lr])$/;

const _F1 = new THREE.Matrix4();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _h = new THREE.Vector3();
// Orthonormal frame whose first axis is dir and whose second axis leans toward hint.
function frame(out, dir, hint) {
  _a.copy(dir).normalize();
  _b.copy(hint).addScaledVector(_a, -hint.dot(_a));
  if (_b.lengthSq() < 1e-6) { _b.set(0, 1, 0).addScaledVector(_a, -_a.y); if (_b.lengthSq() < 1e-6) _b.set(0, 0, 1); }
  _b.normalize(); _c.crossVectors(_a, _b);
  return out.makeBasis(_a, _b, _c);
}

export function createPlayerArms(gltf, { material = null } = {}) {
  const clone = SkeletonUtils.clone(gltf.scene);
  clone.updateMatrixWorld(true);
  let body = null;
  clone.traverse((o) => { if (o.isSkinnedMesh && /Superhero|Male/i.test(o.material.name)) body = o; });
  if (!body) throw new Error('arm source mesh not found');
  const skel = body.skeleton;
  const bi = new Map(skel.bones.map((b, i) => [b.name, i]));
  const bindWorld = skel.boneInverses.map((m) => m.clone().invert());
  const bindPos = (n) => new THREE.Vector3().setFromMatrixPosition(bindWorld[bi.get(n)]);

  const g = body.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index.array;
  const sideOfBone = skel.bones.map((b) => { const m = b.name.match(SKIN_BONE); return m ? m[2] : null; });
  const dominant = (v) => { let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; best = si.getComponent(v, k); } } return best; };
  const vSide = new Array(si.count); for (let v = 0; v < si.count; v++) vSide[v] = sideOfBone[dominant(v)];
  const mat = material || body.material;
  const sides = {};
  let tris = 0;
  const group = new THREE.Group();
  for (const s of ['l', 'r']) {
    const sub = [];
    for (let t = 0; t < idx.length; t += 3) if (vSide[idx[t]] === s && vSide[idx[t + 1]] === s && vSide[idx[t + 2]] === s) sub.push(idx[t], idx[t + 1], idx[t + 2]);
    const geo = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(g.attributes)) geo.setAttribute(k, a);
    // Drop influences from bones we don't drive (spine, clavicle), or shoulder-side verts collapse.
    const w = new Float32Array(sw.count * 4);
    for (let v = 0; v < sw.count; v++) {
      let tot = 0;
      for (let k = 0; k < 4; k++) { const ww = sideOfBone[si.getComponent(v, k)] === s ? sw.getComponent(v, k) : 0; w[v * 4 + k] = ww; tot += ww; }
      if (tot > 0) for (let k = 0; k < 4; k++) w[v * 4 + k] /= tot;
    }
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    geo.setIndex(sub);
    tris += sub.length / 3;
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.bind(skel, body.bindMatrix);
    mesh.frustumCulled = false;
    // Grip-from-bind rotation: open fingers → -Y, palm → ±X, thumb → -Z (grip space).
    const M = new THREE.Matrix4();
    if (s === 'l') M.makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1));
    else M.makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1));
    const bones = { up: skel.bones[bi.get(`upperarm_${s}`)], lo: skel.bones[bi.get(`lowerarm_${s}`)], hd: skel.bones[bi.get(`hand_${s}`)] };
    const iUp = bi.get(`upperarm_${s}`), iLo = bi.get(`lowerarm_${s}`), iHd = bi.get(`hand_${s}`);
    const Pu = bindPos(`upperarm_${s}`), Pe = bindPos(`lowerarm_${s}`), Pw = bindPos(`hand_${s}`);
    // Detach the three arm bones from the body skeleton; we set their world matrices directly.
    for (const b of Object.values(bones)) { group.add(b); b.matrixAutoUpdate = false; }
    // Finger joints: rest local quaternion + local flexion axis (bind T-pose: palms down, thumbs +Z).
    const palm = new THREE.Vector3(0, -1, 0);
    const thumbTarget = new THREE.Vector3(0, 0.15, -1).normalize();
    const joints = FINGERS.map((f) => [1, 2, 3].map((j) => {
      const n = `${f}_0${j}_${s}`, child = j < 3 ? `${f}_0${j + 1}_${s}` : `${f}_04_leaf_${s}`;
      const bone = skel.bones[bi.get(n)];
      const dir = bindPos(child).sub(bindPos(n)).normalize();
      const axisW = new THREE.Vector3().crossVectors(dir, f === 'thumb' ? thumbTarget : palm).normalize();
      const bq = new THREE.Quaternion(); bindWorld[bi.get(n)].decompose(new THREE.Vector3(), bq, new THREE.Vector3());
      const axisL = axisW.applyQuaternion(bq.invert());
      return { bone, rest: bone.quaternion.clone(), axis: axisL, max: CURL_MAX[f][j - 1] };
    }));
    // Hand bone: its local TRS stays as the rest pose relative to the (now detached) lowerarm
    // frame; we place it by world matrix instead, so nothing else to do for the hand itself.
    const d0u = Pe.clone().sub(Pu), d0l = Pw.clone().sub(Pe);
    const L1b = d0u.length(), L2b = d0l.length();
    d0u.normalize(); d0l.normalize();
    const hint0 = new THREE.Vector3(0, 0, 1);
    sides[s] = {
      mesh, M, bones, iUp, iLo, iHd, Pu, Pe, Pw, d0u, d0l, L1b, L2b, joints,
      F0u: frame(new THREE.Matrix4(), d0u, hint0), F0l: frame(new THREE.Matrix4(), d0l, hint0),
      wrist: (s === 'l' ? WRIST_IN_GRIP.l : WRIST_IN_GRIP.r).clone(),
      upDir: new THREE.Vector3(), elbow: new THREE.Vector3(), wristW: new THREE.Vector3(),
    };
    group.add(mesh);
  }

  const _qa = new THREE.Quaternion(), _qq = new THREE.Quaternion(), _p = new THREE.Vector3(), _hint = new THREE.Vector3(), _hint2 = new THREE.Vector3();
  const _dir = new THREE.Vector3(), _Dh = new THREE.Matrix4(), _Dr = new THREE.Matrix4();
  const _X = new THREE.Matrix4(), _T = new THREE.Matrix4(), _S = new THREE.Matrix4(), _W = new THREE.Matrix4();
  // X(p) = Pa + D·s·(p − Pb); bone world = X · bindWorld[bone]
  function setBone(bone, Pa, D, s, Pb, bind) {
    _X.copy(D); _X.scale(_p.set(s, s, s)); _X.setPosition(0, 0, 0);
    _T.makeTranslation(-Pb.x, -Pb.y, -Pb.z);
    _W.makeTranslation(Pa.x, Pa.y, Pa.z).multiply(_X).multiply(_T).multiply(bind);
    bone.matrix.copy(_W);
  }
  // Rotation (Matrix4) from frame F0 to frame F1 (both orthonormal).
  const _rot = new THREE.Matrix4();
  const rotBetween = (out, F0, F1) => out.copy(F1).multiply(_rot.copy(F0).transpose());

  return {
    group, tris,
    // Where the wrist sits for a given grip pose (used by the IK so the hand always meets the arm).
    wristFor(side, gripPos, gripQuat, out = new THREE.Vector3()) {
      return out.copy(sides[side === 'left' ? 'l' : 'r'].wrist).applyQuaternion(GRIP_TILT).applyQuaternion(gripQuat).add(gripPos);
    },
    // Test/debug: world positions of the three arm bones (must coincide with shoulder / elbow / wrist).
    bonePositions(side) {
      const S = sides[side === 'left' ? 'l' : 'r'];
      return { up: new THREE.Vector3().setFromMatrixPosition(S.bones.up.matrixWorld), lo: new THREE.Vector3().setFromMatrixPosition(S.bones.lo.matrixWorld), hd: new THREE.Vector3().setFromMatrixPosition(S.bones.hd.matrixWorld) };
    },
    // side: 'left'|'right'. shoulder / elbow / gripPos / gripQuat in world; curls [thumb..pinky] 0..1.
    pose(side, shoulder, elbow, gripPos, gripQuat, curls) {
      const S = sides[side === 'left' ? 'l' : 'r'];
      // Hand: grip rotation · tilt · bind→grip basis.
      _qa.copy(gripQuat).multiply(GRIP_TILT);
      _Dh.makeRotationFromQuaternion(_qa).multiply(S.M);                 // bind-world vector → actual world vector
      S.wristW.copy(S.wrist).applyQuaternion(GRIP_TILT).applyQuaternion(gripQuat).add(gripPos);
      const wrist = S.wristW;
      // Upper arm: aim shoulder→elbow, twist so its bind "front" faces the way the forearm folds.
      _dir.subVectors(elbow, shoulder);
      const l1 = Math.max(1e-3, _dir.length()); _dir.divideScalar(l1);
      _h.subVectors(wrist, elbow); _hint.copy(_h).addScaledVector(_dir, -_h.dot(_dir));
      if (_hint.lengthSq() < 1e-5) _hint.set(0, 0, 1).applyQuaternion(_qq.setFromRotationMatrix(_Dh));
      frame(_F1, _dir, _hint);
      rotBetween(_Dr, S.F0u, _F1);
      setBone(S.bones.up, shoulder, _Dr, l1 / S.L1b, S.Pu, bindWorld[S.iUp]);
      // Forearm: aim elbow→wrist; twist between the hand's thumb direction and the upper arm's twist.
      _dir.subVectors(wrist, elbow);
      const l2 = Math.max(1e-3, _dir.length()); _dir.divideScalar(l2);
      _hint2.set(0, 0, 1).applyMatrix4(_Dh); // thumb direction in the world (_Dh is a pure rotation)
      _hint2.addScaledVector(_dir, -_hint2.dot(_dir));
      _hint.copy(_hint).addScaledVector(_dir, -_hint.dot(_dir));
      if (_hint2.lengthSq() > 1e-6) _hint2.normalize();
      if (_hint.lengthSq() > 1e-6) _hint.normalize();
      _hint2.multiplyScalar(0.7).addScaledVector(_hint, 0.3);
      frame(_F1, _dir, _hint2);
      rotBetween(_Dr, S.F0l, _F1);
      setBone(S.bones.lo, elbow, _Dr, l2 / S.L2b, S.Pe, bindWorld[S.iLo]);
      // Hand + fingers.
      setBone(S.bones.hd, wrist, _Dh, HAND_SCALE, S.Pw, bindWorld[S.iHd]);
      for (let f = 0; f < 5; f++) for (const jt of S.joints[f]) jt.bone.quaternion.copy(jt.rest).multiply(_qq.setFromAxisAngle(jt.axis, (curls[f] || 0) * jt.max));
      S.bones.up.updateMatrixWorld(true); S.bones.lo.updateMatrixWorld(true); S.bones.hd.updateMatrixWorld(true);
    },
  };
}

export async function loadFighterGLTF(url) {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
}

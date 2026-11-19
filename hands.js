// Yuddha Arena — articulated human hands (open palm ↔ closed fist).
//
// Each hand is built in WebXR grip-space for a RIGHT hand:
//   origin = centre of the curled fingers (where a held rod would sit),
//   -Z     = toward the thumb, +X = out of the back of the hand,
//   +Y     = toward the forearm (fingers extend along -Y when open).
// The left hand is the mirror image (group.scale.x = -1).
//
// Curl values are 0 (fully open) … 1 (tight fist), one per finger, ordered
// [thumb, index, middle, ring, pinky]. They come from Touch controller
// trigger / grip / thumb-touch, or from WebXR hand-tracking joint poses.
import * as THREE from 'https://unpkg.com/three@0.170.0/build/three.module.js';

// Where the forearm should meet the hand, in the hand's local grip-space.
export const HAND_WRIST_LOCAL = new THREE.Vector3(0.018, 0.1, 0.0);

const _capCache = new Map();
function capsuleGeo(r, len) {
  const key = `${r.toFixed(4)}:${len.toFixed(4)}`;
  let g = _capCache.get(key);
  if (!g) {
    g = new THREE.CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 3, 8);
    _capCache.set(key, g);
  }
  return g;
}
const _sphereGeo = new THREE.SphereGeometry(1, 14, 10);
const _nailGeo = new THREE.SphereGeometry(1, 8, 6);

// MCP knuckle position, phalanx lengths (proximal, middle, distal), base radius, splay (rad, + = toward thumb)
const FINGER_DEFS = [
  { mcp: [0.020, -0.020, -0.026], len: [0.045, 0.027, 0.023], r: 0.0102, splay: 0.10 },  // index
  { mcp: [0.021, -0.024, -0.008], len: [0.050, 0.031, 0.024], r: 0.0106, splay: 0.02 },  // middle
  { mcp: [0.020, -0.021, 0.010], len: [0.047, 0.029, 0.023], r: 0.0100, splay: -0.06 },  // ring
  { mcp: [0.018, -0.013, 0.027], len: [0.037, 0.022, 0.021], r: 0.0088, splay: -0.16 },  // pinky
];
// Flexion per joint (MCP, PIP, DIP) at rest (open) and in a full fist.
const FLEX_OPEN = [0.10, 0.14, 0.08];
const FLEX_FIST = [1.55, 1.78, 1.15];

// Thumb: carpometacarpal base, segment lengths (metacarpal, proximal, distal), radii.
const THUMB_BASE = new THREE.Vector3(0.012, 0.060, -0.024);
const THUMB_LEN = [0.042, 0.032, 0.027];
const THUMB_R = [0.0128, 0.0112, 0.0102];

// Orientation whose local -Y points along `dir` and local +X (nail side) toward `nail`.
function segQuat(dir, nail) {
  const y = dir.clone().normalize().negate();
  const x = nail.clone().addScaledVector(y, -nail.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
// Absolute segment directions (hand space) → local joint rotations for the 3-bone thumb chain.
function thumbPose(dirs, nails) {
  const abs = dirs.map((d, i) => segQuat(new THREE.Vector3(...d), new THREE.Vector3(...nails[i])));
  return abs.map((q, i) => (i === 0 ? q.clone() : abs[i - 1].clone().invert().multiply(q)));
}
// Open: thumb splayed out to the side. Fist: folded down and across the middle phalanges.
const THUMB_OPEN = thumbPose(
  [[-0.30, -0.50, -0.80], [-0.22, -0.62, -0.75], [-0.15, -0.72, -0.68]],
  [[0.55, 0, -0.8], [0.55, 0, -0.8], [0.55, 0, -0.8]]
);
const THUMB_FIST = thumbPose(
  [[-0.66, -0.72, -0.22], [-0.55, -0.45, 0.70], [-0.10, -0.25, 0.96]],
  [[-0.2, 0.3, -1], [-1, -0.3, 0], [-1, -0.3, 0]]
);

function addSegment(parent, r, len, mat, nailMat, withNail) {
  const mesh = new THREE.Mesh(capsuleGeo(r, len + r * 0.8), mat); // slight overlap hides joint gaps
  mesh.position.y = -len / 2;
  parent.add(mesh);
  if (withNail) {
    // Fingernail on the back (+X) side of the distal phalanx.
    const nail = new THREE.Mesh(_nailGeo, nailMat);
    nail.scale.set(r * 0.35, len * 0.32, r * 0.75);
    nail.position.set(r * 0.78, -len * 0.62, 0);
    parent.add(nail);
  }
  const next = new THREE.Group();
  next.position.y = -len;
  parent.add(next);
  return next;
}

export function createHumanHand({ side = 'right', skinMat, nailMat }) {
  const group = new THREE.Group();
  const root = new THREE.Group(); // mirrored for the left hand
  if (side === 'left') root.scale.x = -1;
  group.add(root);

  // Palm, knuckle ridge, thumb pad and wrist.
  const palm = new THREE.Mesh(capsuleGeo(0.037, 0.112), skinMat);
  palm.scale.set(0.43, 1, 1); // flattened capsule: straight sides, rounded heel
  palm.position.set(0.021, 0.024, 0.0);
  const knuckles = new THREE.Mesh(capsuleGeo(0.0125, 0.066), skinMat);
  knuckles.rotation.x = Math.PI / 2;
  knuckles.position.set(0.021, -0.016, 0.0);
  const thenar = new THREE.Mesh(_sphereGeo, skinMat);
  thenar.scale.set(0.015, 0.030, 0.017);
  thenar.position.set(0.009, 0.050, -0.022);
  const wrist = new THREE.Mesh(_sphereGeo, skinMat);
  wrist.scale.set(0.015, 0.022, 0.025);
  wrist.position.set(0.019, 0.074, 0.0);
  root.add(palm, knuckles, thenar, wrist);

  // Four fingers, three joints each.
  const fingerJoints = FINGER_DEFS.map((def) => {
    const mcp = new THREE.Group();
    mcp.position.set(...def.mcp);
    root.add(mcp);
    const joints = [mcp];
    let parent = mcp;
    for (let s = 0; s < 3; s++) {
      const r = def.r * [1, 0.92, 0.84][s];
      parent = addSegment(parent, r, def.len[s], skinMat, nailMat, s === 2);
      if (s < 2) joints.push(parent);
    }
    return { joints, splay: def.splay };
  });

  // Thumb: oriented base + two flexing joints.
  const thumbBase = new THREE.Group();
  thumbBase.position.copy(THUMB_BASE);
  const thumbJoints = [thumbBase];
  root.add(thumbBase);
  let tParent = thumbBase;
  for (let s = 0; s < 3; s++) {
    tParent = addSegment(tParent, THUMB_R[s], THUMB_LEN[s], skinMat, nailMat, s === 2);
    if (s < 2) thumbJoints.push(tParent);
  }

  const curl = new Float32Array(5);   // current (smoothed)
  const target = new Float32Array(5); // desired

  function applyPose() {
    // thumb
    const t = curl[0];
    for (let j = 0; j < 3; j++) thumbJoints[j].quaternion.slerpQuaternions(THUMB_OPEN[j], THUMB_FIST[j], t);
    // fingers
    for (let f = 0; f < 4; f++) {
      const c = curl[f + 1];
      const { joints, splay } = fingerJoints[f];
      for (let j = 0; j < 3; j++) {
        const flex = THREE.MathUtils.lerp(FLEX_OPEN[j], FLEX_FIST[j], c);
        // Flexion about Z curls the finger toward the palm (-X); splay about X fans it out when open.
        joints[j].rotation.set(j === 0 ? splay * (1 - c) : 0, 0, -flex);
      }
    }
  }

  function setTarget(values) {
    for (let i = 0; i < 5; i++) target[i] = THREE.MathUtils.clamp(values[i] ?? 0, 0, 1);
  }
  function snap() { curl.set(target); applyPose(); }
  function update(dt) {
    const k = 1 - Math.exp(-dt * 22); // fast but smooth
    for (let i = 0; i < 5; i++) curl[i] += (target[i] - curl[i]) * k;
    applyPose();
  }

  applyPose();
  return { group, curl, target, setTarget, update, snap };
}

// ── Input → curl mapping ──────────────────────────────────────────────
// Meta Touch / Touch Plus (xr-standard mapping): 0 trigger, 1 squeeze/grip,
// 3 thumbstick, 4 A/X, 5 B/Y, 6 thumbrest (if exposed).
export function curlsFromGamepad(gp, out) {
  const b = gp.buttons;
  const trig = b[0]?.value ?? 0;
  const indexTouch = b[0]?.touched ? 0.3 : 0;
  const grip = b[1]?.value ?? 0;
  let thumbDown = false;
  for (const i of [3, 4, 5, 6]) if (b[i] && (b[i].touched || b[i].pressed)) thumbDown = true;
  out[0] = Math.max(thumbDown ? 0.8 : 0, grip * 0.55, grip > 0.85 && trig > 0.85 ? 1 : 0);
  out[1] = Math.max(trig, indexTouch, grip * 0.25);
  out[2] = grip;
  out[3] = grip;
  out[4] = grip;
  return out;
}

const TRACK_CHAINS = [
  ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
];
// Summed joint bend (radians) that counts as fully curled, per finger.
const FULL_BEND = [1.5, 3.9, 4.0, 4.0, 3.9];
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _d0 = new THREE.Vector3(), _d1 = new THREE.Vector3();

// Returns true if every joint was tracked this frame (out is left unchanged otherwise).
export function curlsFromHandJoints(frame, hand, refSpace, out) {
  if (!frame.getJointPose) return false;
  const tmp = [0, 0, 0, 0, 0];
  for (let f = 0; f < 5; f++) {
    const names = TRACK_CHAINS[f];
    let bend = 0, havePrevDir = false;
    for (let n = 0; n < names.length; n++) {
      const space = hand.get(names[n]);
      const pose = space && frame.getJointPose(space, refSpace);
      if (!pose) return false;
      const p = pose.transform.position;
      _p1.set(p.x, p.y, p.z);
      if (n > 0) {
        _d1.subVectors(_p1, _p0);
        if (_d1.lengthSq() > 1e-8) {
          _d1.normalize();
          if (havePrevDir) bend += Math.acos(THREE.MathUtils.clamp(_d0.dot(_d1), -1, 1));
          _d0.copy(_d1);
          havePrevDir = true;
        }
      }
      _p0.copy(_p1);
    }
    tmp[f] = THREE.MathUtils.clamp((bend - 0.15) / FULL_BEND[f], 0, 1);
  }
  for (let i = 0; i < 5; i++) out[i] = tmp[i];
  return true;
}

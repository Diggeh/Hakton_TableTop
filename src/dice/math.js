/**
 * Tiny vector / quaternion helpers on plain arrays. Quaternions are [x, y, z, w].
 * Kept dependency-free so geometry, physics and tests can share them in Node and the browser.
 */

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => {
  const len = length(a) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
};

/** Hamilton product a * b (apply b first, then a). */
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotates vector v by unit quaternion q. */
export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function quatFromAxisAngle(axis, angle) {
  const [x, y, z] = normalize(axis);
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/**
 * Quaternion from a proper rotation matrix given as three column vectors.
 * @param {number[]} c0 image of +X
 * @param {number[]} c1 image of +Y
 * @param {number[]} c2 image of +Z
 */
export function quatFromColumns(c0, c1, c2) {
  const m11 = c0[0], m21 = c0[1], m31 = c0[2];
  const m12 = c1[0], m22 = c1[1], m32 = c1[2];
  const m13 = c2[0], m23 = c2[1], m33 = c2[2];
  const trace = m11 + m22 + m33;
  let q;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Rotation R with R * from[i] = to[i] for an orthonormal, right-handed frame pair.
 * Computed as R = sum_i to[i] * from[i]^T.
 */
export function rotationBetweenFrames(from, to) {
  const col = (axis) => {
    // R * e_axis = sum_i to[i] * from[i][axis]
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[0] += to[i][0] * from[i][axis];
      out[1] += to[i][1] * from[i][axis];
      out[2] += to[i][2] * from[i][axis];
    }
    return out;
  };
  return quatFromColumns(col(0), col(1), col(2));
}

/** Uniformly distributed random unit quaternion (Shoemake). */
export function randomQuaternion(random) {
  const u1 = random();
  const u2 = random() * 2 * Math.PI;
  const u3 = random() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

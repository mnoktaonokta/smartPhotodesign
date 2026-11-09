// White balance math: Kelvin/tint <-> per-channel gains, and sRGB <-> CIE Lab.

export const XYZ_FROM_SRGB = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
export const SRGB_FROM_XYZ = invert3(XYZ_FROM_SRGB);

export const KELVIN_RANGE = [2000, 12000];
export const TINT_RANGE = [-150, 150];
export const RELATIVE_RANGE = [-100, 100];

// Adobe DNG SDK scale between tint units and CIE 1960 uv offsets.
const TINT_SCALE = 3000;
const NEUTRAL_KELVIN = 6500;
const NEUTRAL_MIRED = 1e6 / NEUTRAL_KELVIN;
const RELATIVE_MIRED_PER_UNIT = 0.9;
const RELATIVE_TINT_PER_UNIT = 1.2;

/** CIE 1931 xy of a blackbody at ``kelvin`` (Kim et al. cubic spline, 1667–25000 K). */
export function planckianXy(kelvin) {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.234358e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  let y;
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

function xyToUv([x, y]) {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

function uvToXy([u, v]) {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/**
 * xy chromaticity of the illuminant described by a temperature and tint.
 * Positive tint assumes a greener light, so compensating for it makes the
 * photo more magenta, matching Lightroom's slider direction.
 */
export function illuminantXy(kelvin, tint) {
  const uv = xyToUv(planckianXy(kelvin));
  const lo = xyToUv(planckianXy(kelvin - 10));
  const hi = xyToUv(planckianXy(kelvin + 10));
  const du = hi[0] - lo[0];
  const dv = hi[1] - lo[1];
  const len = Math.hypot(du, dv) || 1;
  let nu = dv / len;
  let nv = -du / len;
  if (nv < 0) {
    nu = -nu;
    nv = -nv;
  }
  const offset = tint / TINT_SCALE;
  return uvToXy([uv[0] + nu * offset, uv[1] + nv * offset]);
}

/** Channel gains (green = 1) that render a neutral surface under the illuminant as neutral. */
export function whiteGains(camXyz, kelvin, tint) {
  const [x, y] = illuminantXy(kelvin, tint);
  const xyz = [x / y, 1, (1 - x - y) / y];
  const cam = mulVec(camXyz, xyz);
  const gains = cam.map((v) => 1 / Math.max(v, 1e-9));
  return gains.map((g) => g / gains[1]);
}

/** Find the temperature and tint whose gains best match ``gains`` (e.g. the camera's as-shot values). */
export function temperatureTintFor(camXyz, gains) {
  const target = [Math.log(gains[0] / gains[1]), Math.log(gains[2] / gains[1])];
  const cost = (mired, tint) => {
    const g = whiteGains(camXyz, 1e6 / mired, tint);
    const dr = Math.log(g[0] / g[1]) - target[0];
    const db = Math.log(g[2] / g[1]) - target[1];
    return dr * dr + db * db;
  };
  let best = { mired: NEUTRAL_MIRED, tint: 0, cost: Infinity };
  for (let mired = 1e6 / 25000; mired <= 1e6 / 1700; mired += 4) {
    for (let tint = -150; tint <= 150; tint += 10) {
      const c = cost(mired, tint);
      if (c < best.cost) best = { mired, tint, cost: c };
    }
  }
  let stepM = 2;
  let stepT = 5;
  for (let i = 0; i < 60; i++) {
    let improved = false;
    for (const [dm, dt] of [
      [stepM, 0],
      [-stepM, 0],
      [0, stepT],
      [0, -stepT],
    ]) {
      const m = best.mired + dm;
      const t = Math.min(150, Math.max(-150, best.tint + dt));
      const c = cost(m, t);
      if (c < best.cost) {
        best = { mired: m, tint: t, cost: c };
        improved = true;
      }
    }
    if (!improved) {
      stepM /= 2;
      stepT /= 2;
    }
  }
  return { kelvin: 1e6 / best.mired, tint: best.tint };
}

/**
 * Gains for linear sRGB pixels from relative sliders (-100..100), used for
 * JPEG photos and for local mask adjustments. Zero/zero returns exactly 1,1,1.
 */
export function relativeGains(temperature, tint) {
  const kelvin = 1e6 / (NEUTRAL_MIRED - temperature * RELATIVE_MIRED_PER_UNIT);
  const g = whiteGains(SRGB_FROM_XYZ, kelvin, tint * RELATIVE_TINT_PER_UNIT);
  const ref = whiteGains(SRGB_FROM_XYZ, NEUTRAL_KELVIN, 0);
  return [g[0] / ref[0], g[1] / ref[1], g[2] / ref[2]];
}

/** sRGB 8-bit to CIE Lab (D65). */
export function srgb8ToLab(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  const X = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const Y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const Z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function mulVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// "Match to first photo": find slider values for the second photo whose
// rendered result has the same tonal and color statistics as the first.
// The renderer is the measurement device, so the result is exactly what the
// user will see, and it lands in ordinary sliders they can keep editing.

import { srgb8ToLab } from "./color.js";

const BACKGROUND_L = 10;
const SPECULAR_L = 97;
const MIN_PIXELS = 64;
const PRIOR_WEIGHT = 0.04;
const ITERATIONS = 8;
const STEP = 0.04;

export const MATCH_KEYS = ["exposure", "highlights", "shadows", "temperature", "tint"];

/**
 * Lab statistics of an RGBA8 buffer, ignoring near-black background and
 * specular highlights that would skew tooth and gum tones.
 */
export function measure(rgba) {
  const n = rgba.length / 4;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const [l, a, b] = srgb8ToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    L[i] = l;
    A[i] = a;
    B[i] = b;
    if (l > BACKGROUND_L && l < SPECULAR_L) kept++;
  }
  const useAll = kept < MIN_PIXELS;
  const Ls = [];
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    if (!useAll && !(L[i] > BACKGROUND_L && L[i] < SPECULAR_L)) continue;
    Ls.push(L[i]);
    sa += A[i];
    sb += B[i];
  }
  Ls.sort((x, y) => x - y);
  const count = Ls.length;
  const q = (p) => Ls[Math.min(count - 1, Math.max(0, Math.round(p * (count - 1))))];
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), a: sa / count, b: sb / count };
}

function residuals(stats, ref) {
  return [
    stats.p50 - ref.p50,
    stats.p90 - ref.p90,
    stats.p10 - ref.p10,
    (stats.a - ref.a) * 1.5,
    (stats.b - ref.b) * 1.5,
  ];
}

/**
 * Damped Gauss-Newton over the slider values in ``MATCH_KEYS``.
 *
 * ``ranges[key] = [min, max]`` bounds each slider and also sets its scale.
 * ``render(params)`` returns the stats of the photo rendered with ``params``.
 */
export function solveMatch({ start, ranges, render, reference }) {
  const keys = MATCH_KEYS;
  const scale = keys.map((k) => (ranges[k][1] - ranges[k][0]) / 2);
  const toParams = (z) => {
    const p = { ...start };
    keys.forEach((k, i) => {
      p[k] = Math.min(ranges[k][1], Math.max(ranges[k][0], start[k] + z[i] * scale[i]));
    });
    return p;
  };
  const evaluate = (z) => {
    const r = residuals(render(toParams(z)), reference);
    const prior = z.map((v) => v * PRIOR_WEIGHT * 100);
    return { r, cost: sumSq(r) + sumSq(prior) };
  };

  let z = keys.map(() => 0);
  let current = evaluate(z);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const J = keys.map((_, j) => {
      const zj = z.slice();
      zj[j] += STEP;
      const rj = evaluate(zj).r;
      return rj.map((v, i) => (v - current.r[i]) / STEP);
    });
    // Normal equations with prior: (JᵀJ + w²I) Δ = -(Jᵀr + w² z)
    const w2 = (PRIOR_WEIGHT * 100) ** 2;
    const n = keys.length;
    const M = Array.from({ length: n }, (_, a) =>
      Array.from({ length: n }, (_, b) => dot(J[a], J[b]) + (a === b ? w2 + 1e-6 : 0)),
    );
    const g = Array.from({ length: n }, (_, a) => -(dot(J[a], current.r) + w2 * z[a]));
    const delta = solveLinear(M, g);
    if (!delta) break;

    let stepScale = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = z.map((v, i) => v + delta[i] * stepScale);
      const result = evaluate(candidate);
      if (result.cost < current.cost) {
        z = candidate;
        current = result;
        accepted = true;
        break;
      }
      stepScale /= 2;
    }
    if (!accepted || Math.max(...delta.map(Math.abs)) * stepScale < 1e-3) break;
  }
  return toParams(z);
}

/** Interpolate the matched sliders between ``base`` (0) and ``solution`` (1). */
export function blendMatch(base, solution, strength) {
  const out = { ...base };
  for (const k of MATCH_KEYS) out[k] = base[k] + (solution[k] - base[k]) * strength;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function sumSq(a) {
  return dot(a, a);
}

function solveLinear(M, g) {
  const n = g.length;
  const A = M.map((row, i) => [...row, g[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    if (Math.abs(A[pivot][c]) < 1e-12) return null;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

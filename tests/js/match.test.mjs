import assert from "node:assert/strict";
import test from "node:test";

import { blendMatch, measure, solveMatch } from "../../web/js/match.js";

const RANGES = {
  exposure: [-4, 4],
  highlights: [-100, 100],
  shadows: [-100, 100],
  temperature: [2000, 12000],
  tint: [-150, 150],
};

// A tiny stand-in for the GPU pipeline: a gradient "photo" whose brightness
// follows exposure and whose color follows temperature/tint.
function fakeRender(params) {
  const n = 64 * 32;
  const out = new Uint8Array(n * 4);
  const gain = 2 ** params.exposure;
  const warm = (params.temperature - 5500) / 4000;
  const magenta = params.tint / 150;
  for (let i = 0; i < n; i++) {
    const base = 0.15 + 0.6 * (i / n);
    const lin = (c) => Math.max(0, Math.min(1, c)) ** (1 / 2.2) * 255;
    out[i * 4] = lin(base * gain * (1 + 0.25 * warm + 0.1 * magenta));
    out[i * 4 + 1] = lin(base * gain * (1 - 0.15 * magenta));
    out[i * 4 + 2] = lin(base * gain * (1 - 0.25 * warm + 0.1 * magenta));
    out[i * 4 + 3] = 255;
  }
  return out;
}

const START = { exposure: 0, highlights: 0, shadows: 0, temperature: 5000, tint: 0, contrast: 10 };

test("solver recovers exposure, temperature and tint differences", () => {
  const target = { ...START, exposure: 0.6, temperature: 6800, tint: 20 };
  const reference = measure(fakeRender(target));
  const solved = solveMatch({ start: START, ranges: RANGES, reference, render: (p) => measure(fakeRender(p)) });
  const got = measure(fakeRender(solved));
  assert.ok(Math.abs(got.p50 - reference.p50) < 1, `L median ${got.p50} vs ${reference.p50}`);
  assert.ok(Math.abs(got.a - reference.a) < 1, `a ${got.a} vs ${reference.a}`);
  assert.ok(Math.abs(got.b - reference.b) < 1, `b ${got.b} vs ${reference.b}`);
  assert.equal(solved.contrast, 10, "sliders outside the match set are untouched");
});

test("solution stays within slider ranges", () => {
  const reference = measure(fakeRender({ ...START, exposure: 3.9, temperature: 11900 }));
  const solved = solveMatch({ start: START, ranges: RANGES, reference, render: (p) => measure(fakeRender(p)) });
  for (const [k, [lo, hi]] of Object.entries(RANGES)) assert.ok(solved[k] >= lo && solved[k] <= hi, k);
});

test("blend interpolates only matched keys", () => {
  const base = { ...START };
  const solution = { ...START, exposure: 1, temperature: 6000 };
  const half = blendMatch(base, solution, 0.5);
  assert.equal(half.exposure, 0.5);
  assert.equal(half.temperature, 5500);
  assert.equal(half.contrast, 10);
});

test("measure ignores black background", () => {
  const photo = fakeRender(START);
  const framed = new Uint8Array(photo.length * 2);
  framed.set(photo);
  for (let i = photo.length; i < framed.length; i += 4) framed[i + 3] = 255;
  const clean = measure(photo);
  const withBackground = measure(framed);
  assert.ok(Math.abs(clean.p50 - withBackground.p50) < 0.5);
});

import assert from "node:assert/strict";
import test from "node:test";

import { illuminantXy, planckianXy, relativeGains, srgb8ToLab, temperatureTintFor, whiteGains } from "../../web/js/color.js";

const NIKON_D750 = [
  [0.902, -0.289, -0.0715],
  [-0.4535, 1.2436, 0.2348],
  [-0.0934, 0.1919, 0.7086],
];

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("planckian locus matches known chromaticities", () => {
  const [x, y] = planckianXy(6504);
  close(x, 0.3135, 0.002, "x at 6504 K");
  close(y, 0.3237, 0.002, "y at 6504 K");
  const [x2] = planckianXy(2856);
  close(x2, 0.4476, 0.002, "x at illuminant A");
});

test("as-shot gains round-trip through temperature and tint", () => {
  const shot = [2.078125, 1, 1.20703125];
  const { kelvin, tint } = temperatureTintFor(NIKON_D750, shot);
  const g = whiteGains(NIKON_D750, kelvin, tint);
  shot.forEach((v, i) => close(g[i], v, 1e-3, `gain ${i}`));
  assert.ok(kelvin > 5000 && kelvin < 7500, `plausible flash temperature, got ${kelvin}`);
});

test("higher kelvin warms the image and positive tint adds magenta", () => {
  const cool = whiteGains(NIKON_D750, 3900, 0);
  const warm = whiteGains(NIKON_D750, 6500, 0);
  assert.ok(warm[0] > cool[0], "more red gain when warmer");
  assert.ok(warm[2] < cool[2], "less blue gain when warmer");
  const [, yNeutral] = illuminantXy(5000, 0);
  const [, yGreen] = illuminantXy(5000, 50);
  assert.ok(yGreen > yNeutral, "positive tint assumes greener light");
  const magenta = whiteGains(NIKON_D750, 5000, 50);
  const neutral = whiteGains(NIKON_D750, 5000, 0);
  assert.ok(magenta[0] > neutral[0] && magenta[2] > neutral[2], "red and blue rise relative to green");
});

test("relative gains are identity at zero and directional", () => {
  assert.deepEqual(relativeGains(0, 0), [1, 1, 1]);
  const warm = relativeGains(50, 0);
  assert.ok(warm[0] > 1 && warm[2] < 1);
  const cool = relativeGains(-50, 0);
  assert.ok(cool[0] < 1 && cool[2] > 1);
});

test("srgb to lab reference values", () => {
  const [L, a, b] = srgb8ToLab(255, 0, 0);
  close(L, 53.24, 0.05, "L of red");
  close(a, 80.09, 0.1, "a of red");
  close(b, 67.2, 0.1, "b of red");
  const white = srgb8ToLab(255, 255, 255);
  close(white[0], 100, 1e-3, "white L");
  close(white[1], 0, 1e-3, "white a");
});

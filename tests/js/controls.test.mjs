import assert from "node:assert/strict";
import test from "node:test";

import { LIGHT_CONTROLS, colorControls, parseSliderValue } from "../../web/js/controls.js";

const exposure = LIGHT_CONTROLS.find((d) => d.key === "exposure");
const shadows = LIGHT_CONTROLS.find((d) => d.key === "shadows");
const temp = colorControls(true).find((d) => d.key === "temperature");

test("accepts signs, decimal commas, units and the unicode minus", () => {
  assert.equal(parseSliderValue("+0,25", exposure), 0.25);
  assert.equal(parseSliderValue("-1.5", exposure), -1.5);
  assert.equal(parseSliderValue("−100", shadows), -100);
  assert.equal(parseSliderValue("3900 K", temp), 3900);
  assert.equal(parseSliderValue("%80", { min: 0, max: 100, step: 1 }), 80);
});

test("clamps to the range and rounds to the step", () => {
  assert.equal(parseSliderValue("9", exposure), 4);
  assert.equal(parseSliderValue("-250", shadows), -100);
  assert.equal(parseSliderValue("0.333", exposure), 0.33);
  assert.equal(parseSliderValue("12.6", shadows), 13);
});

test("Kelvin can be typed to the single degree", () => {
  assert.equal(parseSliderValue("3875", temp), 3875);
});

test("rejects text without a number", () => {
  assert.equal(parseSliderValue("abc", shadows), null);
  assert.equal(parseSliderValue("", shadows), null);
});

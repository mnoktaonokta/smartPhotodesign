import assert from "node:assert/strict";
import test from "node:test";

import { VIDEO_DURATIONS, splitAt } from "../../web/js/slider-video.js";

test("starts on full Before and ends on full After", () => {
  for (const duration of Object.values(VIDEO_DURATIONS)) {
    assert.equal(splitAt(0, duration), 1);
    assert.equal(splitAt(duration * 0.1, duration), 1);
    assert.equal(splitAt(duration * 0.9, duration), 0);
    assert.equal(splitAt(duration, duration), 0);
  }
});

test("reveals After, goes back toward Before, then finishes", () => {
  const d = VIDEO_DURATIONS.normal;
  const samples = Array.from({ length: d * 30 + 1 }, (_, i) => splitAt(i / 30, d));
  const firstDip = samples.findIndex((s) => s <= 0.31);
  assert.ok(firstDip > 0);
  const back = samples.slice(firstDip).findIndex((s) => s >= 0.69);
  assert.ok(back > 0);
  assert.ok(samples.every((s) => s >= 0 && s <= 1));
});

test("motion is continuous", () => {
  const d = VIDEO_DURATIONS.short;
  let previous = splitAt(0, d);
  for (let i = 1; i <= d * 30; i++) {
    const s = splitAt(i / 30, d);
    assert.ok(Math.abs(s - previous) < 0.08, `jump at frame ${i}`);
    previous = s;
  }
});

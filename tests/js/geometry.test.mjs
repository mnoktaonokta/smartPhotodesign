import assert from "node:assert/strict";
import test from "node:test";

import { defaultGeometry, frameRect, frameToImage, imageToFrame, maxFrameWidth, pan, zoomAt } from "../../web/js/geometry.js";

const W = 3000;
const H = 2000;

function corners(rect) {
  return [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([fx, fy]) => frameToImage(rect, fx, fy));
}

function inside(rect) {
  return corners(rect).every(([x, y]) => x >= -1e-6 && y >= -1e-6 && x <= W + 1e-6 && y <= H + 1e-6);
}

test("default frame covers the whole photo at its own aspect", () => {
  const rect = frameRect(defaultGeometry(), W, H, 1.5);
  assert.equal(Math.round(rect.fw), W);
  assert.equal(Math.round(rect.fh), H);
});

test("rotated frames stay inside the photo", () => {
  for (const angle of [-45, -12.5, 0, 7, 30, 45]) {
    for (const aspect of [1.5, 1, 0.8, 16 / 9]) {
      const rect = frameRect({ ...defaultGeometry(), angle }, W, H, aspect);
      assert.ok(inside(rect), `angle ${angle} aspect ${aspect}`);
      assert.ok(rect.fw <= maxFrameWidth(W, H, (angle * Math.PI) / 180, aspect) + 1e-6);
    }
  }
});

test("panning is clamped to the photo edges", () => {
  let g = { ...defaultGeometry(), zoom: 3 };
  for (let i = 0; i < 50; i++) g = pan(g, W, H, 1.5, 0.5, 0.5);
  const rect = frameRect(g, W, H, 1.5);
  assert.ok(inside(rect));
  const [x, y] = frameToImage(rect, -0.5, -0.5);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6, "dragging the photo right/down reaches its top-left corner");
});

test("zoom keeps the point under the cursor fixed", () => {
  const g = { ...defaultGeometry(), zoom: 2 };
  const before = frameRect(g, W, H, 1.5);
  const target = frameToImage(before, 0.2, -0.1);
  const next = frameRect(zoomAt(g, W, H, 1.5, 1.5, 0.2, -0.1), W, H, 1.5);
  const after = frameToImage(next, 0.2, -0.1);
  assert.ok(Math.hypot(after[0] - target[0], after[1] - target[1]) < 1e-6);
  assert.ok(next.fw < before.fw);
});

test("frame and image coordinates invert each other", () => {
  const rect = frameRect({ quarter: 1, angle: 12, zoom: 2.5, cx: 0.4, cy: 0.6 }, W, H, 0.8);
  const [px, py] = frameToImage(rect, 0.3, -0.2);
  const [fx, fy] = imageToFrame(rect, px, py);
  assert.ok(Math.abs(fx - 0.3) < 1e-9 && Math.abs(fy + 0.2) < 1e-9);
});

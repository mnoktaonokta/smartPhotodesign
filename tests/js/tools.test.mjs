import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brushStamp, floatToHalf, halfToFloat, maskDefaults, selectTeethMask } from "../../web/js/tools.js";
import { MASK_BRUSH, MASK_LINEAR } from "../../web/js/shaders.js";

describe("float16 roundtrip", () => {
  it("preserves common values", () => {
    for (const v of [0, 0.18, 1, 0.5, -0.25, 12.5]) {
      assert.ok(Math.abs(halfToFloat(floatToHalf(v)) - v) < 0.01, String(v));
    }
  });
});

describe("brushStamp", () => {
  it("paints a soft circle", () => {
    const w = 64;
    const h = 64;
    const bitmap = new Uint8Array(w * h);
    brushStamp(bitmap, w, h, 0.5, 0.5, 0.2, 1, false);
    assert.equal(bitmap[32 * w + 32] > 200, true);
    assert.equal(bitmap[0], 0);
  });
});

describe("selectTeethMask", () => {
  it("prefers bright center pixels", () => {
    const w = 32;
    const h = 32;
    const pixels = new Uint16Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const bright = x > 10 && x < 22 && y > 12 && y < 20;
        const v = floatToHalf(bright ? 0.9 : 0.02);
        pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
      }
    }
    const mask = selectTeethMask(pixels, w, h, w, h);
    assert.ok(mask[16 * w + 16] > 100);
    assert.ok(mask[0] < 50);
  });
});

describe("maskDefaults", () => {
  it("sets types", () => {
    assert.equal(maskDefaults(MASK_LINEAR).type, MASK_LINEAR);
    assert.equal(maskDefaults(MASK_BRUSH).type, MASK_BRUSH);
    assert.equal(maskDefaults().invert, false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brushStamp, floatToHalf, halfToFloat, healStamp, maskDefaults, selectTeethMask } from "../../web/js/tools.js";
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

describe("healStamp", () => {
  it("copies nearby texture instead of flat fill", () => {
    const w = 64;
    const h = 64;
    const pixels = new Uint16Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        // Top half darker gum-like, bottom brighter; center has a bright streak to heal.
        const gum = y < 40;
        const streak = Math.abs(x - 32) < 2 && y > 20 && y < 44;
        const v = streak ? 0.9 : gum ? 0.25 + (x % 3) * 0.02 : 0.7;
        pixels[i] = floatToHalf(v);
        pixels[i + 1] = floatToHalf(v * (gum ? 0.7 : 1));
        pixels[i + 2] = floatToHalf(v * (gum ? 0.65 : 1));
      }
    }
    const before = halfToFloat(pixels[(32 * w + 32) * 3]);
    healStamp(pixels, w, h, 0.5, 0.5, 0.08);
    const after = halfToFloat(pixels[(32 * w + 32) * 3]);
    // Should move away from the bright streak toward darker surround.
    assert.ok(after < before - 0.05, `expected darker heal result, before=${before} after=${after}`);
  });
});

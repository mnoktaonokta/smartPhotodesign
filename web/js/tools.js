// Brush masks, subject (teeth) selection, heal and clone stamp helpers.
// Pixel buffers are linear half-float RGB (Uint16Array of float16 bits).

import { MASK_BRUSH, MASK_LINEAR, MASK_RADIAL } from "./shaders.js";

export { MASK_BRUSH, MASK_LINEAR, MASK_RADIAL };

const MASK_SCALE = 1024;

export function maskDefaults(type = MASK_LINEAR) {
  return {
    type,
    invert: false,
    a: [0.2, 0.5],
    b: [0.8, 0.5],
    center: [0.5, 0.5],
    inner: 0.15,
    outer: 0.4,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    bitmap: null,
  };
}

export function maskMapSize(imageW, imageH) {
  const scale = Math.min(1, MASK_SCALE / Math.max(imageW, imageH));
  return {
    width: Math.max(1, Math.round(imageW * scale)),
    height: Math.max(1, Math.round(imageH * scale)),
  };
}

export function ensureBitmap(mask, width, height) {
  const need = width * height;
  if (!mask.bitmap || mask.bitmap.length !== need) {
    mask.bitmap = new Uint8Array(need);
  }
  return mask.bitmap;
}

/** Soft circular stamp onto a brush mask (values 0..255). */
export function brushStamp(bitmap, width, height, nx, ny, radiusNorm, strength = 1, erase = false) {
  const cx = nx * (width - 1);
  const cy = ny * (height - 1);
  const radius = Math.max(1, radiusNorm * Math.min(width, height));
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius + 1));
  const amount = Math.max(0, Math.min(1, strength)) * 255;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const fall = 1 - Math.sqrt(d2) / radius;
      const soft = fall * fall * (3 - 2 * fall);
      const i = y * width + x;
      if (erase) {
        bitmap[i] = Math.max(0, Math.round(bitmap[i] - amount * soft));
      } else {
        bitmap[i] = Math.min(255, Math.max(bitmap[i], Math.round(amount * soft)));
      }
    }
  }
}

/**
 * Auto-select bright, low-saturation regions typical of teeth against a dark contrastor.
 * Works on linear float16 RGB preview pixels.
 */
export function selectTeethMask(pixels, imageW, imageH, mapW, mapH) {
  const bitmap = new Uint8Array(mapW * mapH);
  const luma = new Float32Array(mapW * mapH);
  let sum = 0;
  for (let y = 0; y < mapH; y++) {
    const sy = Math.min(imageH - 1, Math.round((y / Math.max(1, mapH - 1)) * (imageH - 1)));
    for (let x = 0; x < mapW; x++) {
      const sx = Math.min(imageW - 1, Math.round((x / Math.max(1, mapW - 1)) * (imageW - 1)));
      const i = (sy * imageW + sx) * 3;
      const r = halfToFloat(pixels[i]);
      const g = halfToFloat(pixels[i + 1]);
      const b = halfToFloat(pixels[i + 2]);
      const yLin = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx > 1e-6 ? (mx - mn) / mx : 0;
      // Prefer bright, not-too-saturated, somewhat central pixels.
      const cx = x / Math.max(1, mapW - 1) - 0.5;
      const cy = y / Math.max(1, mapH - 1) - 0.5;
      const center = Math.exp(-(cx * cx * 2.2 + cy * cy * 1.4));
      const score = yLin * (1 - sat * 0.85) * (0.55 + 0.45 * center);
      luma[y * mapW + x] = score;
      sum += score;
    }
  }
  const mean = sum / luma.length;
  // Threshold a bit above the mean; dental photos with black background push mean down.
  const thr = Math.max(0.08, mean * 1.35);
  for (let i = 0; i < luma.length; i++) {
    bitmap[i] = luma[i] > thr ? 255 : 0;
  }
  return softDilateErode(bitmap, mapW, mapH);
}

/** Flood-fill subject from a normalized click using colour similarity. */
export function selectSubjectAt(pixels, imageW, imageH, mapW, mapH, nx, ny, tolerance = 0.18) {
  const bitmap = new Uint8Array(mapW * mapH);
  const sx = Math.min(imageW - 1, Math.round(nx * (imageW - 1)));
  const sy = Math.min(imageH - 1, Math.round(ny * (imageH - 1)));
  const seedI = (sy * imageW + sx) * 3;
  const sr = halfToFloat(pixels[seedI]);
  const sg = halfToFloat(pixels[seedI + 1]);
  const sb = halfToFloat(pixels[seedI + 2]);
  const seedY = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;

  const visited = new Uint8Array(mapW * mapH);
  const stack = [[Math.round(nx * (mapW - 1)), Math.round(ny * (mapH - 1))]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= mapW || y >= mapH) continue;
    const mi = y * mapW + x;
    if (visited[mi]) continue;
    visited[mi] = 1;
    const ix = Math.min(imageW - 1, Math.round((x / Math.max(1, mapW - 1)) * (imageW - 1)));
    const iy = Math.min(imageH - 1, Math.round((y / Math.max(1, mapH - 1)) * (imageH - 1)));
    const pi = (iy * imageW + ix) * 3;
    const r = halfToFloat(pixels[pi]);
    const g = halfToFloat(pixels[pi + 1]);
    const b = halfToFloat(pixels[pi + 2]);
    const yLin = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const dist = Math.abs(yLin - seedY) + 0.35 * (Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb));
    if (dist > tolerance) continue;
    bitmap[mi] = 255;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return softDilateErode(bitmap, mapW, mapH);
}

function softDilateErode(bitmap, w, h) {
  const tmp = new Uint8Array(bitmap.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) m = Math.max(m, bitmap[(y + dy) * w + (x + dx)]);
      }
      tmp[y * w + x] = m;
    }
  }
  const out = new Uint8Array(bitmap.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) m = Math.min(m, tmp[(y + dy) * w + (x + dx)]);
      }
      out[y * w + x] = m;
    }
  }
  // Soften edges
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) s += out[(y + dy) * w + (x + dx)];
      }
      bitmap[y * w + x] = Math.round(s / 9);
    }
  }
  return bitmap;
}

/** Heal: blend destination with a ring average around the brush (texture-aware soft fill). */
export function healStamp(pixels, width, height, nx, ny, radiusNorm) {
  const cx = nx * (width - 1);
  const cy = ny * (height - 1);
  const radius = Math.max(2, radiusNorm * Math.min(width, height));
  const inner = radius * 0.55;
  const outer = radius * 1.35;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sw = 0;
  const x0 = Math.max(0, Math.floor(cx - outer - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + outer + 1));
  const y0 = Math.max(0, Math.floor(cy - outer - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + outer + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < inner || d > outer) continue;
      const w = 1 - Math.abs(d - (inner + outer) / 2) / ((outer - inner) / 2 + 1e-6);
      const i = (y * width + x) * 3;
      sr += halfToFloat(pixels[i]) * w;
      sg += halfToFloat(pixels[i + 1]) * w;
      sb += halfToFloat(pixels[i + 2]) * w;
      sw += w;
    }
  }
  if (sw < 1e-6) return;
  sr /= sw;
  sg /= sw;
  sb /= sw;
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius - 1)); y <= Math.min(height - 1, Math.ceil(cy + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 1)); x <= Math.min(width - 1, Math.ceil(cx + radius + 1)); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const fall = 1 - Math.sqrt(d2) / radius;
      const soft = fall * fall * (3 - 2 * fall);
      const i = (y * width + x) * 3;
      const or = halfToFloat(pixels[i]);
      const og = halfToFloat(pixels[i + 1]);
      const ob = halfToFloat(pixels[i + 2]);
      // Mix toward sampled surround while keeping local high-frequency from a mild blend.
      pixels[i] = floatToHalf(or * (1 - soft * 0.85) + sr * soft * 0.85);
      pixels[i + 1] = floatToHalf(og * (1 - soft * 0.85) + sg * soft * 0.85);
      pixels[i + 2] = floatToHalf(ob * (1 - soft * 0.85) + sb * soft * 0.85);
    }
  }
}

/** Clone stamp: copy from source offset with soft brush. */
export function cloneStamp(pixels, width, height, nx, ny, srcNx, srcNy, radiusNorm) {
  const cx = nx * (width - 1);
  const cy = ny * (height - 1);
  const ox = (srcNx - nx) * (width - 1);
  const oy = (srcNy - ny) * (height - 1);
  const radius = Math.max(2, radiusNorm * Math.min(width, height));
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius - 1)); y <= Math.min(height - 1, Math.ceil(cy + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 1)); x <= Math.min(width - 1, Math.ceil(cx + radius + 1)); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const sx = Math.round(x + ox);
      const sy = Math.round(y + oy);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const fall = 1 - Math.sqrt(d2) / radius;
      const soft = fall * fall * (3 - 2 * fall);
      const di = (y * width + x) * 3;
      const si = (sy * width + sx) * 3;
      const or = halfToFloat(pixels[di]);
      const og = halfToFloat(pixels[di + 1]);
      const ob = halfToFloat(pixels[di + 2]);
      const sr = halfToFloat(pixels[si]);
      const sg = halfToFloat(pixels[si + 1]);
      const sb = halfToFloat(pixels[si + 2]);
      pixels[di] = floatToHalf(or * (1 - soft) + sr * soft);
      pixels[di + 1] = floatToHalf(og * (1 - soft) + sg * soft);
      pixels[di + 2] = floatToHalf(ob * (1 - soft) + sb * soft);
    }
  }
}

export function clonePixels(pixels) {
  return new Uint16Array(pixels);
}

// Float16 helpers (IEEE 754 binary16).
export function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function floatToHalf(val) {
  if (!Number.isFinite(val)) return val < 0 ? 0xfc00 : 0x7c00;
  let v = Math.max(-65504, Math.min(65504, val));
  const sign = v < 0 ? 1 : 0;
  v = Math.abs(v);
  if (v < Math.pow(2, -14)) {
    const mant = Math.round(v / Math.pow(2, -24));
    return (sign << 15) | mant;
  }
  let exp = Math.floor(Math.log2(v));
  let mant = Math.round((v / Math.pow(2, exp) - 1) * 1024);
  if (mant === 1024) {
    mant = 0;
    exp += 1;
  }
  exp += 15;
  if (exp >= 31) return (sign << 15) | 0x7c00;
  return (sign << 15) | (exp << 10) | mant;
}

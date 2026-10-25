// Crop frame geometry. The frame is a rectangle of a fixed aspect that sits on
// the photo; rotating, zooming and panning move the frame, and it is always
// kept fully inside the photo so no empty corners appear.

export const ASPECTS = {
  original: { label: "Orijinal", ratio: null },
  "3:2": { label: "3:2", ratio: 3 / 2 },
  "4:3": { label: "4:3", ratio: 4 / 3 },
  "16:9": { label: "16:9", ratio: 16 / 9 },
  "1:1": { label: "1:1 Kare", ratio: 1 },
  "4:5": { label: "4:5", ratio: 4 / 5 },
};

export const ZOOM_RANGE = [1, 8];
export const ANGLE_RANGE = [-45, 45];

export function defaultGeometry() {
  return { quarter: 0, angle: 0, zoom: 1, cx: 0.5, cy: 0.5 };
}

/** Frame width/height ratio for ``aspectKey`` on a photo of ``width`` x ``height``. */
export function frameAspect(aspectKey, width, height, quarter = 0) {
  const ratio = ASPECTS[aspectKey]?.ratio;
  if (ratio) return ratio;
  return quarter % 2 === 0 ? width / height : height / width;
}

function thetaOf(geometry) {
  return ((geometry.quarter * 90 + geometry.angle) * Math.PI) / 180;
}

/** Largest frame width (in photo pixels) of the given aspect that fits inside the rotated photo. */
export function maxFrameWidth(width, height, theta, aspect) {
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  return Math.min(width / (c + s / aspect), height / (s + c / aspect));
}

/**
 * Resolve geometry into a concrete frame: center and size in photo pixels,
 * plus the rotation. Also returns the clamped geometry.
 */
export function frameRect(geometry, width, height, aspect) {
  const theta = thetaOf(geometry);
  const zoom = clamp(geometry.zoom, ZOOM_RANGE[0], ZOOM_RANGE[1]);
  const fw = maxFrameWidth(width, height, theta, aspect) / zoom;
  const fh = fw / aspect;
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  const ex = (fw / 2) * c + (fh / 2) * s;
  const ey = (fw / 2) * s + (fh / 2) * c;
  const cx = clampRange(geometry.cx * width, ex, width - ex);
  const cy = clampRange(geometry.cy * height, ey, height - ey);
  return {
    cx,
    cy,
    fw,
    fh,
    theta,
    geometry: { ...geometry, zoom, cx: cx / width, cy: cy / height },
  };
}

/** Frame coordinates (-0.5..0.5, y down) to photo pixels. */
export function frameToImage(rect, fx, fy) {
  const ox = fx * rect.fw;
  const oy = fy * rect.fh;
  const c = Math.cos(rect.theta);
  const s = Math.sin(rect.theta);
  return [rect.cx + c * ox - s * oy, rect.cy + s * ox + c * oy];
}

/** Photo pixels to frame coordinates. */
export function imageToFrame(rect, px, py) {
  const dx = px - rect.cx;
  const dy = py - rect.cy;
  const c = Math.cos(rect.theta);
  const s = Math.sin(rect.theta);
  return [(c * dx + s * dy) / rect.fw, (-s * dx + c * dy) / rect.fh];
}

/**
 * Column-major 3x3 matrix mapping (fx, fy, 1) to texture uv for WebGL.
 */
export function frameToUvMatrix(rect, width, height) {
  const c = Math.cos(rect.theta);
  const s = Math.sin(rect.theta);
  return new Float32Array([
    (c * rect.fw) / width,
    (s * rect.fw) / height,
    0,
    (-s * rect.fh) / width,
    (c * rect.fh) / height,
    0,
    rect.cx / width,
    rect.cy / height,
    1,
  ]);
}

/** Move the frame by a drag of (dx, dy) in frame units (dragging the photo, not the frame). */
export function pan(geometry, width, height, aspect, dx, dy) {
  const rect = frameRect(geometry, width, height, aspect);
  const [px, py] = frameToImage(rect, -dx, -dy);
  return frameRect({ ...rect.geometry, cx: px / width, cy: py / height }, width, height, aspect).geometry;
}

/** Zoom by ``factor`` keeping the photo point under frame position (fx, fy) in place. */
export function zoomAt(geometry, width, height, aspect, factor, fx, fy) {
  const rect = frameRect(geometry, width, height, aspect);
  const [px, py] = frameToImage(rect, fx, fy);
  const zoom = clamp(rect.geometry.zoom * factor, ZOOM_RANGE[0], ZOOM_RANGE[1]);
  const next = frameRect({ ...rect.geometry, zoom }, width, height, aspect);
  const [qx, qy] = frameToImage(next, fx, fy);
  const moved = {
    ...next.geometry,
    cx: (next.cx + px - qx) / width,
    cy: (next.cy + py - qy) / height,
  };
  return frameRect(moved, width, height, aspect).geometry;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function clampRange(v, lo, hi) {
  return lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi);
}

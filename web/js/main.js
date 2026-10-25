import { fetchPixels, postParts, uploadPhoto } from "./api.js";
import { KELVIN_RANGE, RELATIVE_RANGE, TINT_RANGE, relativeGains, temperatureTintFor, whiteGains } from "./color.js";
import { LIGHT_CONTROLS, MASK_CONTROLS, colorControls, el, section, segmented, select, slider } from "./controls.js";
import {
  ANGLE_RANGE,
  ASPECTS,
  ZOOM_RANGE,
  defaultGeometry,
  frameAspect,
  frameRect,
  frameToImage,
  frameToUvMatrix,
  imageToFrame,
  pan,
  zoomAt,
} from "./geometry.js";
import { blendMatch, measure, solveMatch } from "./match.js";
import { MAX_MASKS } from "./shaders.js";
import { Renderer } from "./renderer.js";
import { VIDEO_DURATIONS, encodeSliderVideo } from "./slider-video.js";

const MAX_EXPORT_SIDE = 6000;
// Enough source pixels for a 1080 x 1920 frame even when the photo is cropped to fill it.
const VIDEO_SOURCE_SIDE = 2400;
const SHARE_PREVIEW_SIDE = 1400;
const MEASURE_SIDE = 160;
const FRAME_PADDING = 0.86;
const DEFAULT_MATCH_STRENGTH = 0.8;
const PRESET_STORAGE_KEY = "spd.presets.v1";
const BUILTIN_PRESETS = [
  { name: "Diş odaklı (3900 K, Shadows −100)", builtin: true, kelvin: true, params: { temperature: 3900, shadows: -100 } },
];
const GLOBAL_KEYS = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation"];
const SLOTS = { before: "Before", after: "After" };

const state = {
  tab: "before",
  aspect: "original",
  photos: { before: null, after: null },
  compare: { mode: "split", split: 0.5 },
  afterView: "side",
  lastAfterCompare: "side",
  share: {
    layout: "auto",
    aspect: "4:5",
    fit: "pad",
    background: "#FFFFFF",
    labels: { enabled: true, beforeText: "BEFORE", afterText: "AFTER", sizePercent: 4, textColor: "#FFFFFF", backgroundOpacity: 0.45 },
    logo: { position: "divider", widthPercent: 18, opacity: 0.9 },
    videoDuration: "normal",
    logoBytes: null,
    logoName: null,
    previewUrl: null,
    previewInfo: "",
  },
  maskDraw: false,
  presets: loadPresets(),
};

const stage = document.getElementById("stage");
const glCanvas = document.getElementById("gl");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const panel = document.getElementById("panel");
const sharePreview = document.getElementById("share-preview");
const busy = document.getElementById("busy");
const toast = document.getElementById("toast");
const fileInput = document.getElementById("file-input");
const logoInput = document.getElementById("logo-input");

let renderer;
let controls = {};
let drawQueued = false;
let drag = null;
let sharePreviewTimer = null;

// ---------- photo state ----------

function defaultParams(meta) {
  const params = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0 };
  if (meta.kind === "camera") {
    const asShot = temperatureTintFor(meta.camXyz, meta.asShot);
    params.temperature = Math.round(asShot.kelvin);
    params.tint = Math.round(asShot.tint);
  }
  return params;
}

function defaultMask(a, b) {
  return { a, b, exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, saturation: 0 };
}

function isKelvin(photo) {
  return photo.meta.kind === "camera";
}

function ranges(photo) {
  const kelvin = isKelvin(photo);
  return {
    exposure: [-4, 4],
    highlights: [-100, 100],
    shadows: [-100, 100],
    temperature: kelvin ? KELVIN_RANGE : RELATIVE_RANGE,
    tint: kelvin ? TINT_RANGE : RELATIVE_RANGE,
  };
}

function currentAspect() {
  const ref = state.photos.before || state.photos.after;
  if (!ref) return 3 / 2;
  return frameAspect(state.aspect, ref.meta.width, ref.meta.height, ref.geometry.quarter);
}

function photoRect(photo) {
  const rect = frameRect(photo.geometry, photo.meta.width, photo.meta.height, currentAspect());
  photo.geometry = rect.geometry;
  return rect;
}

/**
 * Uniforms for the renderer. Coordinates are in preview pixels even when
 * ``texture`` is the full-resolution upload, since sampling uses normalized uv.
 */
function buildJob(photo, { texture = photo.texture, overlayMask = -1, params = photo.params } = {}) {
  const { meta } = photo;
  const rect = photoRect(photo);
  const W = meta.width;
  const H = meta.height;
  let gains;
  if (isKelvin(photo)) {
    const g = whiteGains(meta.camXyz, params.temperature, params.tint);
    const min = Math.min(...g);
    gains = g.map((v) => v / min);
  } else {
    gains = relativeGains(params.temperature, params.tint);
  }
  const m = meta.rgbCam;
  return {
    texture,
    imageSize: [W, H],
    frameToUv: frameToUvMatrix(rect, W, H),
    cameraSpace: isKelvin(photo),
    gains,
    rgbCam: new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]),
    rawLook: meta.isRaw,
    exposure: params.exposure + meta.baselineEv,
    contrast: params.contrast / 100,
    highlights: params.highlights / 100,
    shadows: params.shadows / 100,
    whites: params.whites / 100,
    blacks: params.blacks / 100,
    vibrance: params.vibrance / 100,
    saturation: params.saturation / 100,
    masks: photo.masks.map((mask) => ({
      line: [mask.a[0] * W, mask.a[1] * H, mask.b[0] * W, mask.b[1] * H],
      tone: [mask.exposure, mask.contrast / 100, mask.highlights / 100, mask.shadows / 100],
      color: [...relativeGains(mask.temperature, mask.tint), mask.saturation / 100],
    })),
    overlayMask,
  };
}

function frameSize(longSide) {
  const a = currentAspect();
  return a >= 1 ? [longSide, Math.max(1, Math.round(longSide / a))] : [Math.max(1, Math.round(longSide * a)), longSide];
}

function renderSmall(photo, longSide, params) {
  const [w, h] = frameSize(longSide);
  return { rgba: renderer.renderPixels(buildJob(photo, { params }), w, h), width: w, height: h };
}

async function renderFull(photo, maxSide = MAX_EXPORT_SIDE) {
  const full = await fetchPixels(photo.meta.id, { full: true, maxSide: renderer.maxTextureSize });
  const texture = renderer.createTexture(full.width, full.height, full.data);
  try {
    const rect = photoRect(photo);
    const scale = full.width / photo.meta.width;
    let longSide = Math.round(Math.max(rect.fw, rect.fh) * scale);
    longSide = Math.min(longSide, maxSide);
    const [w, h] = frameSize(longSide);
    return { rgba: renderer.renderPixels(buildJob(photo, { texture }), w, h), width: w, height: h };
  } finally {
    renderer.deleteTexture(texture);
  }
}

// ---------- loading ----------

async function openPhoto(slot, file) {
  await withBusy("Fotoğraf açılıyor…", async () => {
    const meta = await uploadPhoto(file);
    const pixels = await fetchPixels(meta.id);
    const texture = renderer.createTexture(pixels.width, pixels.height, pixels.data);
    const previous = state.photos[slot];
    if (previous) renderer.deleteTexture(previous.texture);
    const photo = {
      meta: { ...meta, width: pixels.width, height: pixels.height },
      texture,
      geometry: defaultGeometry(),
      params: defaultParams(meta),
      masks: [],
      selectedMask: -1,
      showMask: true,
      match: null,
    };
    state.photos[slot] = photo;
    state.tab = slot;
    state.maskDraw = false;
    if (slot === "after" && state.photos.before) {
      copyFromBefore(photo, { geometry: true });
      runMatch(photo);
    }
  });
  renderPanel();
  requestDraw();
}

function copyFromBefore(after, { geometry = false } = {}) {
  const before = state.photos.before;
  if (!before) return;
  const sameUnits = isKelvin(before) === isKelvin(after);
  for (const key of GLOBAL_KEYS) {
    if ((key === "temperature" || key === "tint") && !sameUnits) continue;
    after.params[key] = before.params[key];
  }
  if (geometry) after.geometry = { ...before.geometry };
  after.match = null;
}

function runMatch(after) {
  const before = state.photos.before;
  if (!before || !after) return;
  const reference = measure(renderSmall(before, MEASURE_SIDE).rgba);
  const base = { ...after.params };
  const solution = solveMatch({
    start: base,
    ranges: ranges(after),
    reference,
    render: (params) => measure(renderSmall(after, MEASURE_SIDE, params).rgba),
  });
  after.match = { base, solution, strength: DEFAULT_MATCH_STRENGTH };
  after.params = blendMatch(base, solution, DEFAULT_MATCH_STRENGTH);
}

// ---------- drawing ----------

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

/** How the After tab shows Before next to the photo being edited. */
function afterViewMode() {
  return state.tab === "after" && state.photos.before && state.photos.after ? state.afterView : "single";
}

/**
 * Screen placement of the edited photo's frame. In side-by-side mode the
 * edited (After) frame is on the right and ``beforeCx`` places Before on the left.
 */
function editLayout(canvasW, canvasH) {
  const a = currentAspect();
  if (afterViewMode() === "side") {
    const gap = Math.round(canvasW * 0.012);
    const rw = Math.min((canvasW * 0.94 - gap) / 2, canvasH * FRAME_PADDING * a);
    return { rw, rh: rw / a, cx: (canvasW + gap + rw) / 2, cy: canvasH / 2, beforeCx: (canvasW - gap - rw) / 2 };
  }
  const rw = Math.min(canvasW * FRAME_PADDING, canvasH * FRAME_PADDING * a);
  const rh = rw / a;
  return { rw, rh, cx: canvasW / 2, cy: canvasH / 2 };
}

function frameView(L, width, height, dimOutside) {
  return {
    scale: [width / L.rw, height / L.rh],
    offset: [(width / 2 - L.cx) / L.rw, (height / 2 - L.cy) / L.rh],
    dimOutside,
  };
}

function frameBox(L) {
  return { x: Math.round(L.cx - L.rw / 2), y: Math.round(L.cy - L.rh / 2), w: Math.round(L.rw), h: Math.round(L.rh) };
}

function splitX(L) {
  return Math.round(L.cx - L.rw / 2 + L.rw * state.compare.split);
}

function draw() {
  if (!renderer) return;
  const { width, height, dpr } = renderer.resize();
  overlay.width = width;
  overlay.height = height;
  overlayCtx.clearRect(0, 0, width, height);
  renderer.clear([0.075, 0.078, 0.086]);

  const showCanvas = state.tab !== "share";
  glCanvas.hidden = !showCanvas;
  overlay.hidden = !showCanvas;
  sharePreview.hidden = showCanvas || !state.share.previewUrl;
  if (!showCanvas) return;

  if (state.tab === "compare") return drawCompare(width, height, dpr);

  const photo = state.photos[state.tab];
  stage.classList.toggle("is-empty", !photo);
  if (!photo) return;
  const L = editLayout(width, height);
  const overlayMask = photo.showMask ? photo.selectedMask : -1;
  const full = { x: 0, y: 0, w: width, h: height };
  const mode = afterViewMode();
  const before = state.photos.before;
  if (mode === "side") {
    const B = { ...L, cx: L.beforeCx };
    renderer.drawToCanvas(buildJob(before), full, frameView(B, width, height, false), frameBox(B));
    renderer.drawToCanvas(buildJob(photo, { overlayMask }), full, frameView(L, width, height, false), frameBox(L));
    drawFrameOverlay(B, dpr, false);
  } else {
    renderer.drawToCanvas(buildJob(photo, { overlayMask }), full, frameView(L, width, height, true));
    if (mode === "split") {
      const box = frameBox(L);
      const x = splitX(L);
      renderer.drawToCanvas(buildJob(before), full, frameView(L, width, height, false), { ...box, w: Math.max(0, x - box.x) });
    }
  }
  drawFrameOverlay(L, dpr, drag?.kind === "pan");
  drawMaskOverlay(photo, L, dpr, mode !== "single");
  if (mode === "split") drawSplitHandle(L, dpr);
  if (mode !== "single") {
    const left = mode === "side" ? L.beforeCx - L.rw / 2 : L.cx - L.rw / 2;
    const top = L.cy - L.rh / 2;
    tag(overlayCtx, "BEFORE", left + 10 * dpr, top + 10 * dpr, dpr, "left");
    tag(overlayCtx, "AFTER", L.cx + L.rw / 2 - 10 * dpr, top + 10 * dpr, dpr, "right");
  }
}

function drawSplitHandle(L, dpr) {
  const ctx = overlayCtx;
  const x = splitX(L);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - dpr, L.cy - L.rh / 2, 2 * dpr, L.rh);
  ctx.beginPath();
  ctx.arc(x, L.cy, 14 * dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.font = `${13 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("↔", x, L.cy);
}

function drawFrameOverlay(L, dpr, thirds) {
  const ctx = overlayCtx;
  const x = L.cx - L.rw / 2;
  const y = L.cy - L.rh / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1 * dpr;
  ctx.strokeRect(x, y, L.rw, L.rh);
  if (!thirds) return;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(x + (L.rw * i) / 3, y);
    ctx.lineTo(x + (L.rw * i) / 3, y + L.rh);
    ctx.moveTo(x, y + (L.rh * i) / 3);
    ctx.lineTo(x + L.rw, y + (L.rh * i) / 3);
  }
  ctx.stroke();
}

function imageToScreen(photo, L, u, v) {
  const rect = photoRect(photo);
  const [fx, fy] = imageToFrame(rect, u * photo.meta.width, v * photo.meta.height);
  return [L.cx + fx * L.rw, L.cy + fy * L.rh];
}

function screenToImage(photo, L, sx, sy) {
  const rect = photoRect(photo);
  const [px, py] = frameToImage(rect, (sx - L.cx) / L.rw, (sy - L.cy) / L.rh);
  return [px / photo.meta.width, py / photo.meta.height];
}

function drawMaskOverlay(photo, L, dpr, clipToFrame) {
  const mask = photo.masks[photo.selectedMask];
  if (!mask || !photo.showMask) return;
  const ctx = overlayCtx;
  ctx.save();
  if (clipToFrame) {
    const box = frameBox(L);
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
  }
  const A = imageToScreen(photo, L, ...mask.a);
  const B = imageToScreen(photo, L, ...mask.b);
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const reach = Math.hypot(overlay.width, overlay.height);
  const line = (p, dash) => {
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(p[0] - nx * reach, p[1] - ny * reach);
    ctx.lineTo(p[0] + nx * reach, p[1] + ny * reach);
    ctx.stroke();
  };
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  line(A, []);
  line(B, [6 * dpr, 6 * dpr]);
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.beginPath();
  ctx.moveTo(A[0], A[1]);
  ctx.lineTo(B[0], B[1]);
  ctx.stroke();
  for (const [p, r] of [
    [A, 7],
    [B, 7],
    [[(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], 5],
  ]) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], r * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.stroke();
  }
  ctx.restore();
}

function drawCompare(width, height, dpr) {
  const { before, after } = state.photos;
  stage.classList.toggle("is-empty", !(before && after));
  if (!before || !after) return;
  const ctx = overlayCtx;
  if (state.compare.mode === "split") {
    const L = editLayout(width, height);
    const view = { scale: [width / L.rw, height / L.rh], offset: [0, 0], dimOutside: false, background: [0.075, 0.078, 0.086] };
    const full = { x: 0, y: 0, w: width, h: height };
    const x0 = Math.round(L.cx - L.rw / 2);
    const y0 = Math.round(L.cy - L.rh / 2);
    const splitX = Math.round(x0 + L.rw * state.compare.split);
    renderer.drawToCanvas(buildJob(before), full, view, { x: x0, y: y0, w: Math.max(0, splitX - x0), h: Math.round(L.rh) });
    renderer.drawToCanvas(buildJob(after), full, view, { x: splitX, y: y0, w: Math.max(0, x0 + Math.round(L.rw) - splitX), h: Math.round(L.rh) });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(splitX - dpr, y0, 2 * dpr, L.rh);
    ctx.beginPath();
    ctx.arc(splitX, L.cy, 14 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.font = `${13 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("↔", splitX, L.cy);
    tag(ctx, "BEFORE", x0 + 10 * dpr, y0 + 10 * dpr, dpr, "left");
    tag(ctx, "AFTER", x0 + L.rw - 10 * dpr, y0 + 10 * dpr, dpr, "right");
    return;
  }
  const a = currentAspect();
  const gap = 12 * dpr;
  const rw = Math.min((width * 0.94 - gap) / 2, height * 0.86 * a);
  const rh = rw / a;
  const top = Math.round((height - rh) / 2);
  const left = Math.round((width - 2 * rw - gap) / 2);
  const rects = [
    { x: left, y: top, w: Math.round(rw), h: Math.round(rh) },
    { x: Math.round(left + rw + gap), y: top, w: Math.round(rw), h: Math.round(rh) },
  ];
  const view = { scale: [1, 1], offset: [0, 0], dimOutside: false };
  renderer.drawToCanvas(buildJob(before), rects[0], view);
  renderer.drawToCanvas(buildJob(after), rects[1], view);
  tag(ctx, "BEFORE", rects[0].x + 10 * dpr, top + 10 * dpr, dpr, "left");
  tag(ctx, "AFTER", rects[1].x + 10 * dpr, top + 10 * dpr, dpr, "left");
}

function tag(ctx, text, x, y, dpr, align) {
  ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 14 * dpr;
  const h = 22 * dpr;
  const left = align === "right" ? x - w : x;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(left, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + 7 * dpr, y + h / 2);
}

// ---------- pointer interaction ----------

function pointerPos(event) {
  const r = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [(event.clientX - r.left) * dpr, (event.clientY - r.top) * dpr];
}

overlay.addEventListener("pointerdown", (event) => {
  const [sx, sy] = pointerPos(event);
  const dpr = window.devicePixelRatio || 1;
  if (state.tab === "compare") {
    if (state.compare.mode !== "split") return;
    drag = { kind: "split" };
    updateSplit(sx);
    overlay.setPointerCapture(event.pointerId);
    return;
  }
  const photo = state.photos[state.tab];
  if (!photo) return;
  const L = editLayout(overlay.width, overlay.height);
  overlay.setPointerCapture(event.pointerId);

  if (state.maskDraw) {
    if (photo.masks.length >= MAX_MASKS) return;
    const point = screenToImage(photo, L, sx, sy);
    photo.masks.push(defaultMask(point, point));
    photo.selectedMask = photo.masks.length - 1;
    photo.showMask = true;
    drag = { kind: "maskB", start: [sx, sy], creating: true };
    return;
  }

  const mask = photo.masks[photo.selectedMask];
  if (mask && photo.showMask) {
    const A = imageToScreen(photo, L, ...mask.a);
    const B = imageToScreen(photo, L, ...mask.b);
    const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const near = (p) => Math.hypot(p[0] - sx, p[1] - sy) < 14 * dpr;
    if (near(A)) drag = { kind: "maskA" };
    else if (near(B)) drag = { kind: "maskB" };
    else if (near(M)) drag = { kind: "maskMove", last: screenToImage(photo, L, sx, sy) };
    if (drag) return;
  }
  if (afterViewMode() === "split" && Math.abs(sx - splitX(L)) < 10 * dpr && Math.abs(sy - L.cy) < L.rh / 2) {
    drag = { kind: "split" };
    return;
  }
  drag = { kind: "pan", last: [sx, sy] };
  requestDraw();
});

overlay.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const [sx, sy] = pointerPos(event);
  if (drag.kind === "split") return updateSplit(sx);
  const photo = state.photos[state.tab];
  if (!photo) return;
  const L = editLayout(overlay.width, overlay.height);
  const mask = photo.masks[photo.selectedMask];
  if (drag.kind === "pan") {
    const dx = (sx - drag.last[0]) / L.rw;
    const dy = (sy - drag.last[1]) / L.rh;
    photo.geometry = pan(photo.geometry, photo.meta.width, photo.meta.height, currentAspect(), dx, dy);
    drag.last = [sx, sy];
    syncControls();
  } else if (drag.kind === "maskA" && mask) {
    mask.a = screenToImage(photo, L, sx, sy);
  } else if (drag.kind === "maskB" && mask) {
    mask.b = screenToImage(photo, L, sx, sy);
  } else if (drag.kind === "maskMove" && mask) {
    const p = screenToImage(photo, L, sx, sy);
    const d = [p[0] - drag.last[0], p[1] - drag.last[1]];
    mask.a = [mask.a[0] + d[0], mask.a[1] + d[1]];
    mask.b = [mask.b[0] + d[0], mask.b[1] + d[1]];
    drag.last = p;
  }
  requestDraw();
});

function endDrag() {
  if (!drag) return;
  const photo = state.photos[state.tab];
  if (drag.creating && photo) {
    const mask = photo.masks[photo.selectedMask];
    const L = editLayout(overlay.width, overlay.height);
    const A = imageToScreen(photo, L, ...mask.a);
    const B = imageToScreen(photo, L, ...mask.b);
    if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 8) {
      mask.b = screenToImage(photo, L, A[0], A[1] + L.rh * 0.3);
    }
    state.maskDraw = false;
    renderPanel();
  }
  drag = null;
  requestDraw();
}

overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);

overlay.addEventListener(
  "wheel",
  (event) => {
    const photo = state.photos[state.tab];
    if (!photo || state.tab === "compare") return;
    event.preventDefault();
    const [sx, sy] = pointerPos(event);
    const L = editLayout(overlay.width, overlay.height);
    const factor = Math.exp(-event.deltaY * 0.0015);
    photo.geometry = zoomAt(photo.geometry, photo.meta.width, photo.meta.height, currentAspect(), factor, (sx - L.cx) / L.rw, (sy - L.cy) / L.rh);
    syncControls();
    requestDraw();
  },
  { passive: false },
);

function updateSplit(sx) {
  const L = editLayout(overlay.width, overlay.height);
  state.compare.split = Math.min(1, Math.max(0, (sx - (L.cx - L.rw / 2)) / L.rw));
  requestDraw();
}

stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.classList.add("is-dragover");
});
stage.addEventListener("dragleave", () => stage.classList.remove("is-dragover"));
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  stage.classList.remove("is-dragover");
  const file = event.dataTransfer.files[0];
  const slot = state.tab in SLOTS ? state.tab : state.photos.before ? "after" : "before";
  if (file) openPhoto(slot, file).catch(showError);
});

// ---------- side panel ----------

function setTab(tab) {
  state.tab = tab;
  state.maskDraw = false;
  drag = null;
  renderPanel();
  requestDraw();
  if (tab === "share") scheduleSharePreview(0);
}

function renderPanel() {
  controls = {};
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const tab = button.dataset.tab;
    button.classList.toggle("is-active", tab === state.tab);
    const needsBoth = tab === "compare" || tab === "share";
    button.disabled = needsBoth && !(state.photos.before && state.photos.after);
  });
  stage.dataset.tab = state.tab;
  const empty = document.getElementById("empty-message");
  empty.textContent =
    state.tab === "after" && !state.photos.before
      ? "Önce Before fotoğrafını açın, sonra After’ı buraya sürükleyin."
      : "Fotoğrafı buraya sürükleyin veya sağdaki düğmeyle açın.";

  panel.replaceChildren(
    ...(state.tab === "compare" ? comparePanel() : state.tab === "share" ? sharePanel() : editPanel(state.tab)),
  );
  renderViewToggle();
}

const AFTER_VIEWS = [
  ["single", "Yalnız After"],
  ["side", "Yan yana"],
  ["split", "Ayraçlı"],
];

function renderViewToggle() {
  const node = document.getElementById("view-toggle");
  node.hidden = !(state.tab === "after" && state.photos.before && state.photos.after);
  if (node.hidden) return;
  node.replaceChildren(
    segmented(AFTER_VIEWS, state.afterView, setAfterView),
    el("span", { class: "shortcut", title: "Klavyede \\ tuşu Before karşılaştırmasını açıp kapatır" }, "\\ tuşu"),
  );
}

function setAfterView(mode) {
  state.afterView = mode;
  if (mode !== "single") state.lastAfterCompare = mode;
  renderViewToggle();
  requestDraw();
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "\\" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.("input, textarea, select")) return;
  if (!(state.tab === "after" && state.photos.before && state.photos.after)) return;
  event.preventDefault();
  setAfterView(state.afterView === "single" ? state.lastAfterCompare : "single");
});

function syncControls() {
  const photo = state.photos[state.tab];
  if (!photo) return;
  for (const [key, setter] of Object.entries(controls)) {
    if (key.startsWith("param:")) setter(photo.params[key.slice(6)]);
    if (key === "geom:zoom") setter(photo.geometry.zoom);
    if (key === "geom:angle") setter(photo.geometry.angle);
    if (key === "match:strength" && photo.match) setter(Math.round(photo.match.strength * 100));
  }
}

function editPanel(slot) {
  const photo = state.photos[slot];
  const open = el("button", { type: "button", class: "button primary wide", onclick: () => pickFile(slot) }, photo ? "Başka fotoğraf aç" : `${SLOTS[slot]} fotoğrafını aç`);
  const head = section(
    SLOTS[slot],
    photo
      ? el("p", { class: "file-meta" }, el("strong", {}, photo.meta.name), el("br"), `${photo.meta.isRaw ? "RAW" : "JPEG/PNG"} · ${photo.meta.fullWidth}×${photo.meta.fullHeight}`)
      : el("p", { class: "hint" }, slot === "before" ? "Referans fotoğraf. Önce bunu düzenleyin." : "After fotoğrafı açınca Before’un ayarları kopyalanır ve renkler otomatik eşleştirilir."),
    open,
  );
  if (!photo) return [head];

  const sections = [head];
  if (slot === "after") sections.push(matchSection(photo));
  sections.push(cropSection(photo), lightSection(photo), colorSection(photo), presetSection(photo), maskSection(photo));
  return sections;
}

function matchSection(photo) {
  const before = state.photos.before;
  if (!before) {
    return section("Eşleştirme", el("p", { class: "hint" }, "Eşleştirme için önce Before fotoğrafını açın."));
  }
  const strength = slider(
    { label: "Eşleştirme gücü", min: 0, max: 100, step: 1, format: (v) => `%${Math.round(v)}` },
    photo.match ? Math.round(photo.match.strength * 100) : 80,
    80,
    (v) => {
      if (!photo.match) return;
      photo.match.strength = v / 100;
      photo.params = blendMatch(photo.match.base, photo.match.solution, photo.match.strength);
      syncControls();
      requestDraw();
    },
    { disabled: !photo.match },
  );
  controls["match:strength"] = strength.set;
  return section(
    "Eşleştirme",
    el(
      "button",
      {
        type: "button",
        class: "button primary wide",
        onclick: () => {
          runMatch(photo);
          renderPanel();
          requestDraw();
          showToast("After, Before’a göre eşleştirildi.");
        },
      },
      "İlk fotoğrafla eşleştir",
    ),
    strength.node,
    el("p", { class: "hint" }, "Çerçevede görünen alan analiz edilir. Kadrajı Before ile aynı bölgeye getirip yeniden eşleştirin. Sonra istediğiniz ayarla oynayabilirsiniz."),
    el(
      "button",
      {
        type: "button",
        class: "button wide",
        onclick: () => {
          copyFromBefore(photo);
          renderPanel();
          requestDraw();
        },
      },
      "Before ayarlarını kopyala",
    ),
  );
}

function cropSection(photo) {
  const zoom = slider(
    { label: "Yakınlaştırma", min: ZOOM_RANGE[0], max: ZOOM_RANGE[1], step: 0.01, format: (v) => `${v.toFixed(2)}×` },
    photo.geometry.zoom,
    1,
    (v) => {
      photo.geometry = { ...photo.geometry, zoom: v };
      requestDraw();
    },
  );
  const angle = slider(
    { label: "Açı", min: ANGLE_RANGE[0], max: ANGLE_RANGE[1], step: 0.1, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}°` },
    photo.geometry.angle,
    0,
    (v) => {
      photo.geometry = { ...photo.geometry, angle: v };
      requestDraw();
    },
  );
  controls["geom:zoom"] = zoom.set;
  controls["geom:angle"] = angle.set;
  return section(
    "Kadraj",
    select(
      "Oran (iki fotoğraf için)",
      Object.entries(ASPECTS).map(([k, v]) => [k, v.label]),
      state.aspect,
      (v) => {
        state.aspect = v;
        requestDraw();
      },
    ),
    zoom.node,
    angle.node,
    el(
      "div",
      { class: "row" },
      el(
        "button",
        {
          type: "button",
          class: "button",
          onclick: () => {
            photo.geometry = { ...photo.geometry, quarter: (photo.geometry.quarter + 1) % 4 };
            requestDraw();
          },
        },
        "90° döndür",
      ),
      el(
        "button",
        {
          type: "button",
          class: "button",
          onclick: () => {
            photo.geometry = defaultGeometry();
            syncControls();
            requestDraw();
          },
        },
        "Kadrajı sıfırla",
      ),
    ),
    el("p", { class: "hint" }, "Fotoğrafı sürükleyerek kaydırın, fare tekerleğiyle imlecin olduğu yere yakınlaştırın."),
  );
}

function paramSliders(photo, defs) {
  const defaults = defaultParams(photo.meta);
  return defs.map((def) => {
    const s = slider(def, photo.params[def.key], defaults[def.key], (v) => {
      photo.params[def.key] = v;
      requestDraw();
    });
    controls[`param:${def.key}`] = s.set;
    return s.node;
  });
}

function lightSection(photo) {
  return section("Light", ...paramSliders(photo, LIGHT_CONTROLS));
}

function colorSection(photo) {
  const kelvin = isKelvin(photo);
  return section(
    "Color",
    ...paramSliders(photo, colorControls(kelvin)),
    kelvin ? null : el("p", { class: "hint" }, "JPEG’de Kelvin bilgisi olmadığı için Temp ve Tint göreli ölçektedir."),
    el(
      "button",
      {
        type: "button",
        class: "button wide",
        onclick: () => {
          photo.params = defaultParams(photo.meta);
          photo.match = null;
          renderPanel();
          requestDraw();
        },
      },
      "Işık ve rengi sıfırla",
    ),
  );
}

function presetSection(photo) {
  const all = [...BUILTIN_PRESETS, ...state.presets];
  let chosen = 0;
  const picker = select(
    "Hazır ayar",
    all.map((p, i) => [String(i), p.name]),
    "0",
    (v) => {
      chosen = Number(v);
    },
  );
  return section(
    "Hazır ayarlar",
    picker,
    el(
      "div",
      { class: "row" },
      el(
        "button",
        {
          type: "button",
          class: "button",
          onclick: () => {
            applyPreset(photo, all[chosen]);
            syncControls();
            requestDraw();
          },
        },
        "Uygula",
      ),
      el("button", { type: "button", class: "button", onclick: () => savePreset(photo) }, "Mevcut ayarı kaydet"),
    ),
    state.presets.length
      ? el(
          "button",
          {
            type: "button",
            class: "button ghost wide",
            onclick: () => {
              const name = window.prompt("Silinecek hazır ayarın adı:", state.presets.at(-1).name);
              if (!name) return;
              state.presets = state.presets.filter((p) => p.name !== name);
              storePresets();
              renderPanel();
            },
          },
          "Kayıtlı hazır ayarı sil",
        )
      : null,
    el("p", { class: "hint" }, "Hazır ayar ışık ve renk ayarlarını uygular; kadraj ve maskeler değişmez."),
  );
}

function applyPreset(photo, preset) {
  if (!preset) return;
  for (const [key, value] of Object.entries(preset.params)) {
    if ((key === "temperature" || key === "tint") && preset.kelvin !== isKelvin(photo)) continue;
    photo.params[key] = value;
  }
  photo.match = null;
}

function savePreset(photo) {
  const name = window.prompt("Hazır ayarın adı:", "Benim ayarım");
  if (!name) return;
  const params = {};
  for (const key of GLOBAL_KEYS) params[key] = photo.params[key];
  state.presets = [...state.presets.filter((p) => p.name !== name), { name, kelvin: isKelvin(photo), params }];
  storePresets();
  renderPanel();
  showToast(`“${name}” kaydedildi.`);
}

function maskSection(photo) {
  const list = el(
    "div",
    { class: "mask-list" },
    photo.masks.map((_, i) =>
      el(
        "button",
        {
          type: "button",
          class: `chip${i === photo.selectedMask ? " is-active" : ""}`,
          onclick: () => {
            photo.selectedMask = i;
            renderPanel();
            requestDraw();
          },
        },
        `Maske ${i + 1}`,
      ),
    ),
  );
  const add = el(
    "button",
    {
      type: "button",
      class: `button wide${state.maskDraw ? " is-armed" : ""}`,
      disabled: photo.masks.length >= MAX_MASKS,
      onclick: () => {
        state.maskDraw = !state.maskDraw;
        renderPanel();
      },
    },
    state.maskDraw ? "Fotoğraf üzerinde sürükleyerek çizin…" : "+ Doğrusal maske",
  );
  const mask = photo.masks[photo.selectedMask];
  const children = [add, photo.masks.length ? list : null];
  if (mask) {
    for (const def of MASK_CONTROLS) {
      const s = slider(def, mask[def.key], 0, (v) => {
        mask[def.key] = v;
        requestDraw();
      });
      children.push(s.node);
    }
    children.push(
      el(
        "label",
        { class: "check" },
        el("input", {
          type: "checkbox",
          checked: photo.showMask,
          onchange: (e) => {
            photo.showMask = e.target.checked;
            requestDraw();
          },
        }),
        "Maske alanını ve tutamaçları göster",
      ),
      el(
        "button",
        {
          type: "button",
          class: "button ghost wide",
          onclick: () => {
            photo.masks.splice(photo.selectedMask, 1);
            photo.selectedMask = photo.masks.length - 1;
            renderPanel();
            requestDraw();
          },
        },
        "Maskeyi sil",
      ),
    );
  }
  children.push(el("p", { class: "hint" }, "Etki düz çizgide tam, kesikli çizgide sıfırdır. Uç noktaları sürükleyerek yönü, ortadaki noktayla konumu değiştirin."));
  return section("Maskeler", ...children);
}

function comparePanel() {
  return [
    section(
      "Karşılaştır",
      segmented(
        [
          ["split", "Kaydırmalı"],
          ["side", "Yan yana"],
        ],
        state.compare.mode,
        (v) => {
          state.compare.mode = v;
          renderPanel();
          requestDraw();
        },
      ),
      el("p", { class: "hint" }, "Kaydırmalı görünümde çizgiyi sürükleyin. Beğenmezseniz Before veya After sekmesine dönüp düzenleyin."),
      el("button", { type: "button", class: "button primary wide", onclick: () => setTab("share") }, "Paylaşım moduna geç"),
    ),
  ];
}

function sharePanel() {
  const s = state.share;
  const update = (fn) => {
    fn();
    scheduleSharePreview();
  };
  const sliderOf = (def, value, def0, apply) => slider(def, value, def0, (v) => update(() => apply(v))).node;
  return [
    section(
      "Düzen",
      select(
        "Düzen",
        [
          ["auto", "Otomatik"],
          ["side_by_side", "Yan yana"],
          ["stacked", "Alt alta"],
        ],
        s.layout,
        (v) => update(() => (s.layout = v)),
      ),
      select(
        "Paylaşım oranı",
        [
          ["4:5", "4:5 Instagram gönderi"],
          ["1:1", "1:1 Kare"],
          ["9:16", "9:16 Story / Reels"],
          ["original", "Orijinal"],
        ],
        s.aspect,
        (v) => update(() => (s.aspect = v)),
      ),
      select(
        "Sığdırma",
        [
          ["pad", "Tamamını göster (dolgu)"],
          ["crop", "Kadrajı doldur (kırp)"],
        ],
        s.fit,
        (v) => update(() => (s.fit = v)),
      ),
      el("label", { class: "field" }, el("span", {}, "Dolgu ve ayraç rengi"), el("input", { type: "color", value: s.background, oninput: (e) => update(() => (s.background = e.target.value)) })),
    ),
    section(
      "Yazılar",
      el(
        "label",
        { class: "check" },
        el("input", { type: "checkbox", checked: s.labels.enabled, onchange: (e) => update(() => (s.labels.enabled = e.target.checked)) }),
        "BEFORE / AFTER yazısı",
      ),
      el("label", { class: "field" }, el("span", {}, "Before yazısı"), el("input", { type: "text", value: s.labels.beforeText, maxlength: 40, oninput: (e) => update(() => (s.labels.beforeText = e.target.value)) })),
      el("label", { class: "field" }, el("span", {}, "After yazısı"), el("input", { type: "text", value: s.labels.afterText, maxlength: 40, oninput: (e) => update(() => (s.labels.afterText = e.target.value)) })),
      sliderOf({ label: "Yazı boyutu", min: 2, max: 8, step: 0.5, format: (v) => v.toFixed(1) }, s.labels.sizePercent, 4, (v) => (s.labels.sizePercent = v)),
      el("label", { class: "field" }, el("span", {}, "Yazı rengi"), el("input", { type: "color", value: s.labels.textColor, oninput: (e) => update(() => (s.labels.textColor = e.target.value)) })),
      sliderOf({ label: "Yazı zemini opaklığı", min: 0, max: 100, step: 1, format: (v) => `%${v}` }, Math.round(s.labels.backgroundOpacity * 100), 45, (v) => (s.labels.backgroundOpacity = v / 100)),
    ),
    section(
      "Logo",
      el("p", { class: "file-meta" }, s.logoName ? el("strong", {}, s.logoName) : "Logo seçilmedi"),
      el("button", { type: "button", class: "button wide", onclick: () => logoInput.click() }, s.logoName ? "Logoyu değiştir" : "Şeffaf PNG logo seç"),
      select(
        "Konum",
        [
          ["divider", "Ortada, ayraç üstünde"],
          ["bottom_right", "Sağ alt köşe"],
          ["top_right", "Sağ üst köşe"],
        ],
        s.logo.position,
        (v) => update(() => (s.logo.position = v)),
      ),
      sliderOf({ label: "Logo genişliği", min: 5, max: 60, step: 1, format: (v) => `%${v}` }, s.logo.widthPercent, 18, (v) => (s.logo.widthPercent = v)),
      sliderOf({ label: "Logo opaklığı", min: 10, max: 100, step: 1, format: (v) => `%${v}` }, Math.round(s.logo.opacity * 100), 90, (v) => (s.logo.opacity = v / 100)),
    ),
    section(
      "İndir",
      el("p", { class: "hint", id: "share-info" }, s.previewInfo),
      el("button", { type: "button", class: "button primary wide", onclick: () => exportComposite("png").catch(showError) }, "Paylaşım görseli · PNG"),
      el("button", { type: "button", class: "button wide", onclick: () => exportComposite("jpeg").catch(showError) }, "Paylaşım görseli · JPEG %100"),
      el("button", { type: "button", class: "button wide", onclick: () => exportSingle("after", "jpeg").catch(showError) }, "Yalnız After · JPEG"),
      el("button", { type: "button", class: "button wide", onclick: () => exportSingle("after", "tiff").catch(showError) }, "Yalnız After · TIFF"),
      el("button", { type: "button", class: "button wide", onclick: () => exportSingle("before", "jpeg").catch(showError) }, "Yalnız Before · JPEG"),
      el("p", { class: "hint" }, "Dosyalar tam çözünürlükte hazırlanır; RAW fotoğraflarda birkaç saniye sürebilir. Çıktı sosyal medya içindir, klinik teşhis kaydının yerine geçmez."),
    ),
    section(
      "Kaydırmalı video",
      el(
        "p",
        { class: "hint" },
        "Önce Before görünür, ayraç kayıp After'ı gösterir, birkaç kez ileri geri gider ve After'da durur. Oran, sığdırma, yazılar ve logo yukarıdaki ayarlardan gelir; Reels için 9:16, gönderi için 4:5 seçin.",
      ),
      select(
        "Süre",
        [
          ["short", `Kısa (${VIDEO_DURATIONS.short} sn)`],
          ["normal", `Normal (${VIDEO_DURATIONS.normal} sn)`],
          ["long", `Uzun (${VIDEO_DURATIONS.long} sn)`],
        ],
        s.videoDuration,
        (v) => (s.videoDuration = v),
      ),
      el("button", { type: "button", class: "button primary wide", onclick: () => exportSliderVideo().catch(showError) }, "Kaydırmalı video · MP4"),
    ),
  ];
}

// ---------- share / export ----------

function shareHeader(format) {
  const s = state.share;
  return { format, settings: { layout: s.layout, aspect: s.aspect, fit: s.fit, background: s.background, labels: s.labels, logo: s.logo } };
}

function rgbaPart(render) {
  return { bytes: render.rgba, meta: { width: render.width, height: render.height } };
}

function scheduleSharePreview(delay = 250) {
  clearTimeout(sharePreviewTimer);
  sharePreviewTimer = setTimeout(() => updateSharePreview().catch(showError), delay);
}

async function updateSharePreview() {
  const { before, after } = state.photos;
  if (state.tab !== "share" || !before || !after) return;
  const response = await postParts("/api/compose", shareHeader("preview"), {
    before: rgbaPart(renderSmall(before, SHARE_PREVIEW_SIDE)),
    after: rgbaPart(renderSmall(after, SHARE_PREVIEW_SIDE)),
    logo: state.share.logoBytes ? { bytes: state.share.logoBytes, meta: {} } : null,
  });
  const blob = await response.blob();
  if (state.share.previewUrl) URL.revokeObjectURL(state.share.previewUrl);
  state.share.previewUrl = URL.createObjectURL(blob);
  const layout = response.headers.get("X-Layout") === "stacked" ? "Alt alta" : "Yan yana";
  state.share.previewInfo = `${layout} düzen. Önizleme; indirilen dosya tam çözünürlüktedir.`;
  sharePreview.src = state.share.previewUrl;
  const info = document.getElementById("share-info");
  if (info) info.textContent = state.share.previewInfo;
  requestDraw();
}

async function exportComposite(format) {
  const { before, after } = state.photos;
  await withBusy("Tam çözünürlük hazırlanıyor…", async () => {
    const b = await renderFull(before);
    const a = await renderFull(after);
    const response = await postParts("/api/compose", shareHeader(format), {
      before: rgbaPart(b),
      after: rgbaPart(a),
      logo: state.share.logoBytes ? { bytes: state.share.logoBytes, meta: {} } : null,
    });
    download(await response.blob(), `${stem(after.meta.name)}_before_after.${format === "jpeg" ? "jpg" : "png"}`);
  });
}

async function exportSingle(slot, format) {
  const photo = state.photos[slot];
  await withBusy("Tam çözünürlük hazırlanıyor…", async () => {
    const render = await renderFull(photo);
    const response = await postParts("/api/encode", { format }, { image: rgbaPart(render) });
    download(await response.blob(), `${stem(photo.meta.name)}_duzenlenmis.${format === "jpeg" ? "jpg" : "tif"}`);
  });
}

async function exportSliderVideo() {
  const { before, after } = state.photos;
  await withBusy("Video hazırlanıyor…", async () => {
    const b = await renderFull(before, VIDEO_SOURCE_SIDE);
    const a = await renderFull(after, VIDEO_SOURCE_SIDE);
    const response = await postParts("/api/slider-frames", shareHeader("png"), {
      before: rgbaPart(b),
      after: rgbaPart(a),
      logo: state.share.logoBytes ? { bytes: state.share.logoBytes, meta: {} } : null,
    });
    const [width, height] = response.headers.get("X-Size").split("x").map(Number);
    const box = response.headers.get("X-Content").split(",").map(Number);
    const sheet = await createImageBitmap(await response.blob());
    try {
      const video = await encodeSliderVideo({
        sheet,
        width,
        height,
        box,
        duration: VIDEO_DURATIONS[state.share.videoDuration],
        onProgress: (p) => setBusyMessage(`Video hazırlanıyor… %${Math.round(p * 100)}`),
      });
      download(video, `${stem(after.meta.name)}_before_after.mp4`);
    } finally {
      sheet.close();
    }
  });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function stem(name) {
  return name.replace(/\.[^.]+$/, "");
}

// ---------- misc ----------

function pickFile(slot) {
  fileInput.dataset.slot = slot;
  fileInput.value = "";
  fileInput.click();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) openPhoto(fileInput.dataset.slot, file).catch(showError);
});

logoInput.addEventListener("change", async () => {
  const file = logoInput.files[0];
  if (!file) return;
  state.share.logoBytes = new Uint8Array(await file.arrayBuffer());
  state.share.logoName = file.name;
  renderPanel();
  scheduleSharePreview(0);
});

function setBusyMessage(message) {
  busy.querySelector("span").textContent = message;
}

async function withBusy(message, fn) {
  setBusyMessage(message);
  busy.hidden = false;
  await new Promise((r) => setTimeout(r, 30));
  try {
    return await fn();
  } finally {
    busy.hidden = true;
  }
}

function showError(error) {
  console.error(error);
  showToast(error.message || String(error), true);
}

let toastTimer;
function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), isError ? 6000 : 2500);
}

function loadPresets() {
  try {
    const value = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function storePresets() {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(state.presets));
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
window.addEventListener("resize", requestDraw);

try {
  renderer = new Renderer(glCanvas);
} catch (error) {
  showError(error);
}
renderPanel();
requestDraw();

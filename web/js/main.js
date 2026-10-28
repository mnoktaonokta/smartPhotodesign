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
import { History } from "./history.js";
import { blendMatch, measure, solveMatch } from "./match.js";
import { MAX_MASKS } from "./shaders.js";
import { Renderer } from "./renderer.js";
import { VIDEO_DURATIONS, encodeSliderVideo } from "./slider-video.js";
import {
  MASK_BRUSH,
  MASK_LINEAR,
  MASK_RADIAL,
  brushStamp,
  clonePixels,
  cloneStamp,
  ensureBitmap,
  healStamp,
  maskDefaults,
  maskMapSize,
  selectSubjectAt,
  selectTeethMask,
} from "./tools.js";

const MAX_EXPORT_SIDE = 6000;
const VIDEO_SOURCE_SIDE = 2400;
const SHARE_PREVIEW_SIDE = 1400;
const MEASURE_SIDE = 160;
const FRAME_PADDING = 0.9;
const DEFAULT_MATCH_STRENGTH = 0.8;
const PRESET_STORAGE_KEY = "spd.presets.v1";
const BUILTIN_PRESETS = [
  { name: "Diş odaklı (3900 K, Shadows −100)", builtin: true, kelvin: true, params: { temperature: 3900, shadows: -100 } },
];
const GLOBAL_KEYS = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation"];
const SLOTS = { before: "Before", after: "After" };
const FONT_OPTIONS = [
  ["sans_bold", "Sans Bold"],
  ["sans", "Sans"],
  ["serif_bold", "Serif Bold"],
  ["mono_bold", "Mono Bold"],
  ["source_sans", "Source Sans"],
];
const MASK_TYPE_LABELS = {
  [MASK_LINEAR]: "Doğrusal",
  [MASK_RADIAL]: "Radyal",
  [MASK_BRUSH]: "Fırça",
};

const state = {
  tab: "edit",
  activeSlot: "before",
  aspect: "original",
  photos: { before: null, after: null },
  tool: "pan", // pan | linear | radial | brush | erase | subject | heal | clone
  brushSize: 0.04,
  cloneSource: null,
  share: {
    layout: "auto",
    aspect: "4:5",
    fit: "pad",
    background: "#FFFFFF",
    showDivider: true,
    labels: {
      enabled: true,
      beforeText: "BEFORE",
      afterText: "AFTER",
      sizePercent: 4,
      textColor: "#FFFFFF",
      backgroundOpacity: 0.45,
      font: "sans_bold",
    },
    logo: { position: "divider", widthPercent: 18, opacity: 0.9, variant: "beyaz" },
    vignette: { mode: "off", amount: 0.45, midpoint: 0.55 },
    videoDuration: "normal",
    logoBytes: null,
    logoName: null,
    clinicLogos: { beyaz: null, siyah: null },
    previewUrl: null,
    previewInfo: "",
  },
  presets: loadPresets(),
};

const history = new History();
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
const btnUndo = document.getElementById("btn-undo");
const btnRedo = document.getElementById("btn-redo");
const clearBefore = document.getElementById("clear-before");
const clearAfter = document.getElementById("clear-after");
const slotLabels = document.getElementById("slot-labels");
const editActions = document.getElementById("edit-actions");

let renderer;
let controls = {};
let drawQueued = false;
let drag = null;
let sharePreviewTimer = null;
let layouts = { before: null, after: null };
let committing = false;

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

function activePhoto() {
  return state.photos[state.activeSlot];
}

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
    maskArray: photo.maskArray,
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
    masks: photo.masks.map((mask) => maskUniforms(mask, W, H)),
    overlayMask,
  };
}

function maskUniforms(mask, W, H) {
  let line;
  if (mask.type === MASK_RADIAL) {
    const [cx, cy] = mask.center;
    const scale = Math.min(W, H);
    line = [cx * W, cy * H, mask.inner * scale, mask.outer * scale];
  } else if (mask.type === MASK_LINEAR) {
    line = [mask.a[0] * W, mask.a[1] * H, mask.b[0] * W, mask.b[1] * H];
  } else {
    line = [0, 0, 0, 0];
  }
  return {
    type: mask.type ?? MASK_LINEAR,
    invert: !!mask.invert,
    line,
    tone: [mask.exposure, mask.contrast / 100, mask.highlights / 100, mask.shadows / 100],
    color: [...relativeGains(mask.temperature, mask.tint), mask.saturation / 100],
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
    // Export uses parametric masks; brush masks are at preview resolution so scale via UV sampling.
    return { rgba: renderer.renderPixels(buildJob(photo, { texture }), w, h), width: w, height: h };
  } finally {
    renderer.deleteTexture(texture);
  }
}

function syncMaskTextures(photo) {
  if (!photo?.maskArray) return;
  photo.masks.forEach((mask, i) => {
    if (mask.type === MASK_BRUSH && mask.bitmap) {
      renderer.updateMaskLayer(photo.maskArray, i, mask.bitmap);
    } else {
      renderer.clearMaskLayer(photo.maskArray, i);
    }
  });
  for (let i = photo.masks.length; i < MAX_MASKS; i++) renderer.clearMaskLayer(photo.maskArray, i);
}

function applyPixels(photo) {
  renderer.updateTexture(photo.texture, photo.meta.width, photo.meta.height, photo.pixels);
}

let historyCooldown = false;
function pushHistory({ includePixels = false } = {}) {
  const photo = activePhoto();
  if (!photo || committing || historyCooldown) return;
  history.push(state.activeSlot, photo, { includePixels });
  updateHistoryButtons();
  // Collapse rapid slider/brush events into one undo step.
  historyCooldown = true;
  setTimeout(() => {
    historyCooldown = false;
  }, 450);
}

function updateHistoryButtons() {
  btnUndo.disabled = !history.canUndo;
  btnRedo.disabled = !history.canRedo;
}

function undo() {
  const slot = history.undo(state.photos, applyPixels);
  if (slot == null) return;
  state.activeSlot = slot;
  syncMaskTextures(state.photos[slot]);
  updateHistoryButtons();
  renderPanel();
  requestDraw();
}

function redo() {
  const slot = history.redo(state.photos, applyPixels);
  if (slot == null) return;
  state.activeSlot = slot;
  syncMaskTextures(state.photos[slot]);
  updateHistoryButtons();
  renderPanel();
  requestDraw();
}

// ---------- loading ----------

async function openPhoto(slot, file) {
  await withBusy("Fotoğraf açılıyor…", async () => {
    const meta = await uploadPhoto(file);
    const pixels = await fetchPixels(meta.id);
    const texture = renderer.createTexture(pixels.width, pixels.height, pixels.data);
    const map = maskMapSize(pixels.width, pixels.height);
    const maskArray = renderer.createMaskArray(map.width, map.height);
    const previous = state.photos[slot];
    if (previous) {
      renderer.deleteTexture(previous.texture);
      renderer.deleteMaskArray(previous.maskArray);
    }
    const photo = {
      meta: { ...meta, width: pixels.width, height: pixels.height },
      texture,
      pixels: pixels.data,
      originalPixels: clonePixels(pixels.data),
      maskArray,
      maskMap: map,
      geometry: defaultGeometry(),
      params: defaultParams(meta),
      masks: [],
      selectedMask: -1,
      showMask: true,
      match: null,
    };
    state.photos[slot] = photo;
    state.activeSlot = slot;
    state.tool = "pan";
    history.clear();
    updateHistoryButtons();
    if (slot === "after" && state.photos.before) {
      copyFromBefore(photo, { geometry: true });
      runMatch(photo);
    }
  });
  renderPanel();
  requestDraw();
}

function clearPhoto(slot) {
  const photo = state.photos[slot];
  if (!photo) return;
  renderer.deleteTexture(photo.texture);
  renderer.deleteMaskArray(photo.maskArray);
  state.photos[slot] = null;
  if (!state.photos.before && !state.photos.after) history.clear();
  state.activeSlot = state.photos.before ? "before" : state.photos.after ? "after" : "before";
  state.tool = "pan";
  updateHistoryButtons();
  if (state.tab === "share" && !(state.photos.before || state.photos.after)) setTab("edit");
  renderPanel();
  requestDraw();
  if (state.tab === "share") scheduleSharePreview(0);
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

// ---------- layout / drawing ----------

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

/** Side-by-side Before/After frames. Missing slot keeps an empty dashed frame. */
function dualLayout(canvasW, canvasH) {
  const a = currentAspect();
  const gap = Math.round(canvasW * 0.02);
  const available = canvasW * 0.94 - gap;
  let rw = Math.min(available / 2, canvasH * FRAME_PADDING * a);
  let rh = rw / a;
  if (rh > canvasH * FRAME_PADDING) {
    rh = canvasH * FRAME_PADDING;
    rw = rh * a;
  }
  const total = rw * 2 + gap;
  const left = (canvasW - total) / 2;
  const cy = canvasH / 2;
  return {
    before: { rw, rh, cx: left + rw / 2, cy },
    after: { rw, rh, cx: left + rw + gap + rw / 2, cy },
    gap,
  };
}

function singleLayout(canvasW, canvasH) {
  const a = currentAspect();
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

function hitSlot(sx, sy) {
  for (const slot of ["before", "after"]) {
    const L = layouts[slot];
    if (!L) continue;
    const box = frameBox(L);
    if (sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) return slot;
  }
  return null;
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
  editActions.hidden = state.tab !== "edit";
  stage.dataset.tab = state.tab;
  stage.dataset.tool = state.tool;
  if (!showCanvas) {
    clearBefore.hidden = true;
    clearAfter.hidden = true;
    slotLabels.hidden = true;
    return;
  }

  const hasAny = !!(state.photos.before || state.photos.after);
  stage.classList.toggle("is-empty", !hasAny);
  const dual = dualLayout(width, height);
  layouts = { before: dual.before, after: dual.after };

  const full = { x: 0, y: 0, w: width, h: height };
  for (const slot of ["before", "after"]) {
    const photo = state.photos[slot];
    const L = layouts[slot];
    const box = frameBox(L);
    const active = state.activeSlot === slot;
    if (photo) {
      const overlayMask = active && photo.showMask ? photo.selectedMask : -1;
      renderer.drawToCanvas(buildJob(photo, { overlayMask }), full, frameView(L, width, height, false), box);
      drawFrameOverlay(L, dpr, active && drag?.kind === "pan", active);
      if (active) drawMaskOverlay(photo, L, dpr);
    } else {
      drawEmptyFrame(L, dpr, slot, active);
    }
  }

  positionClearButtons(dpr);
  updateSlotLabels(dpr);
}

function drawEmptyFrame(L, dpr, slot, active) {
  const ctx = overlayCtx;
  const box = frameBox(L);
  ctx.save();
  ctx.strokeStyle = active ? "rgba(43,179,163,0.9)" : "rgba(255,255,255,0.35)";
  ctx.setLineDash([8 * dpr, 6 * dpr]);
  ctx.lineWidth = (active ? 2 : 1) * dpr;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `500 ${13 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${SLOTS[slot]} yükle`, L.cx, L.cy);
  ctx.restore();
}

function drawFrameOverlay(L, dpr, thirds, active) {
  const ctx = overlayCtx;
  const x = L.cx - L.rw / 2;
  const y = L.cy - L.rh / 2;
  ctx.strokeStyle = active ? "rgba(43,179,163,0.95)" : "rgba(255,255,255,0.7)";
  ctx.lineWidth = (active ? 2 : 1) * dpr;
  ctx.strokeRect(x, y, L.rw, L.rh);
  if (!thirds) return;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(x + (L.rw * i) / 3, y);
    ctx.lineTo(x + (L.rw * i) / 3, y + L.rh);
    ctx.moveTo(x, y + (L.rh * i) / 3);
    ctx.lineTo(x + L.rw, y + (L.rh * i) / 3);
  }
  ctx.stroke();
}

function positionClearButtons() {
  const place = (btn, slot) => {
    const photo = state.photos[slot];
    const L = layouts[slot];
    if (!photo || !L) {
      btn.hidden = true;
      return;
    }
    const box = frameBox(L);
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    btn.hidden = false;
    btn.style.left = `${box.x / dpr + 8}px`;
    btn.style.top = `${box.y / dpr + 8}px`;
    void rect;
  };
  place(clearBefore, "before");
  place(clearAfter, "after");
}

function updateSlotLabels(dpr) {
  slotLabels.hidden = false;
  for (const span of slotLabels.querySelectorAll("[data-slot]")) {
    const slot = span.dataset.slot;
    const L = layouts[slot];
    if (!L) continue;
    const box = frameBox(L);
    span.classList.toggle("is-active", state.activeSlot === slot && !!state.photos[slot]);
    span.style.left = `${box.x / dpr + 10}px`;
    span.style.top = `${box.y / dpr + 10}px`;
    // Keep clear button from overlapping label when photo exists — label sits under clear on left.
    if (state.photos[slot]) span.style.left = `${box.x / dpr + 42}px`;
  }
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

function drawMaskOverlay(photo, L, dpr) {
  const mask = photo.masks[photo.selectedMask];
  if (!mask || !photo.showMask) return;
  const ctx = overlayCtx;
  ctx.save();
  const box = frameBox(L);
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();

  if (mask.type === MASK_LINEAR) {
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
  } else if (mask.type === MASK_RADIAL) {
    const C = imageToScreen(photo, L, ...mask.center);
    const scale = Math.min(L.rw, L.rh);
    // Approximate radii in screen space using frame aspect.
    const rect = photoRect(photo);
    const innerPx = mask.inner * Math.min(photo.meta.width, photo.meta.height);
    const outerPx = mask.outer * Math.min(photo.meta.width, photo.meta.height);
    const innerScreen = (innerPx / rect.fw) * L.rw;
    const outerScreen = (outerPx / rect.fw) * L.rw;
    void scale;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(C[0], C[1], Math.max(2, innerScreen), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    ctx.beginPath();
    ctx.arc(C[0], C[1], Math.max(4, outerScreen), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(C[0], C[1], 6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }
  ctx.restore();
}

// ---------- pointer ----------

function pointerPos(event) {
  const r = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [(event.clientX - r.left) * dpr, (event.clientY - r.top) * dpr];
}

overlay.addEventListener("pointerdown", (event) => {
  if (state.tab !== "edit") return;
  const [sx, sy] = pointerPos(event);
  const dpr = window.devicePixelRatio || 1;
  const hit = hitSlot(sx, sy);
  if (hit && hit !== state.activeSlot) {
    state.activeSlot = hit;
    state.tool = "pan";
    renderPanel();
    requestDraw();
  }
  const slot = hit || state.activeSlot;
  const photo = state.photos[slot];
  if (!photo) {
    if (hit) pickFile(hit);
    return;
  }
  state.activeSlot = slot;
  const L = layouts[slot];
  overlay.setPointerCapture(event.pointerId);

  if (state.tool === "linear") {
    if (photo.masks.length >= MAX_MASKS) return;
    pushHistory();
    const point = screenToImage(photo, L, sx, sy);
    const mask = maskDefaults(MASK_LINEAR);
    mask.a = point;
    mask.b = point;
    photo.masks.push(mask);
    photo.selectedMask = photo.masks.length - 1;
    photo.showMask = true;
    drag = { kind: "maskB", creating: true };
    return;
  }

  if (state.tool === "radial") {
    if (photo.masks.length >= MAX_MASKS) return;
    pushHistory();
    const point = screenToImage(photo, L, sx, sy);
    const mask = maskDefaults(MASK_RADIAL);
    mask.center = point;
    photo.masks.push(mask);
    photo.selectedMask = photo.masks.length - 1;
    photo.showMask = true;
    drag = { kind: "radialOuter", creating: true };
    renderPanel();
    requestDraw();
    return;
  }

  if (state.tool === "subject") {
    if (photo.masks.length >= MAX_MASKS) return;
    pushHistory();
    const [u, v] = screenToImage(photo, L, sx, sy);
    const mask = maskDefaults(MASK_BRUSH);
    mask.bitmap = selectSubjectAt(photo.pixels, photo.meta.width, photo.meta.height, photo.maskMap.width, photo.maskMap.height, u, v);
    photo.masks.push(mask);
    photo.selectedMask = photo.masks.length - 1;
    photo.showMask = true;
    syncMaskTextures(photo);
    state.tool = "pan";
    renderPanel();
    requestDraw();
    showToast("Nesne seçildi. Invert ile diş dışı alanlara ayar uygulayabilirsiniz.");
    return;
  }

  if (state.tool === "brush" || state.tool === "erase") {
    let mask = photo.masks[photo.selectedMask];
    if (!mask || mask.type !== MASK_BRUSH) {
      if (photo.masks.length >= MAX_MASKS) return;
      pushHistory();
      mask = maskDefaults(MASK_BRUSH);
      ensureBitmap(mask, photo.maskMap.width, photo.maskMap.height);
      photo.masks.push(mask);
      photo.selectedMask = photo.masks.length - 1;
    } else {
      pushHistory();
      ensureBitmap(mask, photo.maskMap.width, photo.maskMap.height);
    }
    photo.showMask = true;
    const [u, v] = screenToImage(photo, L, sx, sy);
    brushStamp(mask.bitmap, photo.maskMap.width, photo.maskMap.height, u, v, state.brushSize, 1, state.tool === "erase");
    syncMaskTextures(photo);
    drag = { kind: "brush" };
    requestDraw();
    return;
  }

  if (state.tool === "heal" || state.tool === "clone") {
    if (state.tool === "clone" && event.altKey) {
      state.cloneSource = screenToImage(photo, L, sx, sy);
      showToast("Klon kaynağı seçildi.");
      return;
    }
    if (state.tool === "clone" && !state.cloneSource) {
      showToast("Önce Alt+tık ile kaynak seçin.", true);
      return;
    }
    pushHistory({ includePixels: true });
    const [u, v] = screenToImage(photo, L, sx, sy);
    if (state.tool === "heal") healStamp(photo.pixels, photo.meta.width, photo.meta.height, u, v, state.brushSize);
    else cloneStamp(photo.pixels, photo.meta.width, photo.meta.height, u, v, state.cloneSource[0], state.cloneSource[1], state.brushSize);
    applyPixels(photo);
    drag = { kind: "retouch" };
    requestDraw();
    return;
  }

  // Pan / mask handle edit
  const mask = photo.masks[photo.selectedMask];
  if (mask && photo.showMask && mask.type === MASK_LINEAR) {
    const A = imageToScreen(photo, L, ...mask.a);
    const B = imageToScreen(photo, L, ...mask.b);
    const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const near = (p) => Math.hypot(p[0] - sx, p[1] - sy) < 14 * dpr;
    if (near(A)) {
      pushHistory();
      drag = { kind: "maskA" };
      return;
    }
    if (near(B)) {
      pushHistory();
      drag = { kind: "maskB" };
      return;
    }
    if (near(M)) {
      pushHistory();
      drag = { kind: "maskMove", last: screenToImage(photo, L, sx, sy) };
      return;
    }
  }
  if (mask && photo.showMask && mask.type === MASK_RADIAL) {
    const C = imageToScreen(photo, L, ...mask.center);
    if (Math.hypot(C[0] - sx, C[1] - sy) < 14 * dpr) {
      pushHistory();
      drag = { kind: "radialCenter" };
      return;
    }
  }
  pushHistory();
  drag = { kind: "pan", last: [sx, sy] };
  requestDraw();
});

overlay.addEventListener("pointermove", (event) => {
  if (!drag || state.tab !== "edit") return;
  const [sx, sy] = pointerPos(event);
  const photo = activePhoto();
  if (!photo) return;
  const L = layouts[state.activeSlot];
  if (!L) return;
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
  } else if (drag.kind === "radialCenter" && mask) {
    mask.center = screenToImage(photo, L, sx, sy);
  } else if (drag.kind === "radialOuter" && mask) {
    const [u, v] = screenToImage(photo, L, sx, sy);
    const dist = Math.hypot(u - mask.center[0], v - mask.center[1]) * Math.max(photo.meta.width / photo.meta.height, 1);
    mask.outer = Math.max(0.05, Math.min(0.9, dist));
    mask.inner = Math.min(mask.inner, mask.outer * 0.6);
  } else if (drag.kind === "brush" && mask?.bitmap) {
    const [u, v] = screenToImage(photo, L, sx, sy);
    brushStamp(mask.bitmap, photo.maskMap.width, photo.maskMap.height, u, v, state.brushSize, 1, state.tool === "erase");
    syncMaskTextures(photo);
  } else if (drag.kind === "retouch") {
    const [u, v] = screenToImage(photo, L, sx, sy);
    if (state.tool === "heal") healStamp(photo.pixels, photo.meta.width, photo.meta.height, u, v, state.brushSize);
    else if (state.cloneSource) cloneStamp(photo.pixels, photo.meta.width, photo.meta.height, u, v, state.cloneSource[0], state.cloneSource[1], state.brushSize);
    applyPixels(photo);
  }
  requestDraw();
});

function endDrag() {
  if (!drag) return;
  const photo = activePhoto();
  if (drag.creating && photo) {
    const mask = photo.masks[photo.selectedMask];
    const L = layouts[state.activeSlot];
    if (mask?.type === MASK_LINEAR && L) {
      const A = imageToScreen(photo, L, ...mask.a);
      const B = imageToScreen(photo, L, ...mask.b);
      if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 8) {
        mask.b = screenToImage(photo, L, A[0], A[1] + L.rh * 0.3);
      }
    }
    state.tool = "pan";
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
    if (state.tab !== "edit") return;
    const photo = activePhoto();
    if (!photo) return;
    event.preventDefault();
    const [sx, sy] = pointerPos(event);
    const L = layouts[state.activeSlot];
    if (!L) return;
    const factor = Math.exp(-event.deltaY * 0.0015);
    photo.geometry = zoomAt(photo.geometry, photo.meta.width, photo.meta.height, currentAspect(), factor, (sx - L.cx) / L.rw, (sy - L.cy) / L.rh);
    syncControls();
    requestDraw();
  },
  { passive: false },
);

stage.addEventListener("dragover", (event) => {
  event.preventDefault();
  stage.classList.add("is-dragover");
});
stage.addEventListener("dragleave", () => stage.classList.remove("is-dragover"));
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  stage.classList.remove("is-dragover");
  if (state.tab !== "edit") return;
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const [sx, sy] = (() => {
    const r = overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(event.clientX - r.left) * dpr, (event.clientY - r.top) * dpr];
  })();
  const hit = hitSlot(sx, sy);
  const slot = hit || (state.photos.before ? (state.photos.after ? state.activeSlot : "after") : "before");
  openPhoto(slot, file).catch(showError);
});

// ---------- panel ----------

function setTab(tab) {
  state.tab = tab;
  state.tool = "pan";
  drag = null;
  renderPanel();
  requestDraw();
  if (tab === "share") scheduleSharePreview(0);
}

function setActiveSlot(slot) {
  if (state.activeSlot === slot) return;
  state.activeSlot = slot;
  state.tool = "pan";
  renderPanel();
  requestDraw();
}

function renderPanel() {
  controls = {};
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const tab = button.dataset.tab;
    button.classList.toggle("is-active", tab === state.tab);
    if (tab === "share") button.disabled = !(state.photos.before || state.photos.after);
  });
  stage.dataset.tab = state.tab;
  const empty = document.getElementById("empty-message");
  empty.textContent = "Sola Before, sağa After fotoğrafını sürükleyin veya çerçeveye tıklayın.";

  panel.replaceChildren(...(state.tab === "share" ? sharePanel() : editPanel()));
}

function syncControls() {
  const photo = activePhoto();
  if (!photo) return;
  for (const [key, setter] of Object.entries(controls)) {
    if (key.startsWith("param:")) setter(photo.params[key.slice(6)]);
    if (key === "geom:zoom") setter(photo.geometry.zoom);
    if (key === "geom:angle") setter(photo.geometry.angle);
    if (key === "match:strength" && photo.match) setter(Math.round(photo.match.strength * 100));
  }
}

function editPanel() {
  const slot = state.activeSlot;
  const photo = state.photos[slot];
  const head = section(
    "Aktif fotoğraf",
    el(
      "div",
      { class: "active-slot" },
      el("button", { type: "button", class: `chip${slot === "before" ? " is-active" : ""}`, onclick: () => setActiveSlot("before") }, "Before"),
      el("button", { type: "button", class: `chip${slot === "after" ? " is-active" : ""}`, onclick: () => setActiveSlot("after") }, "After"),
    ),
    photo
      ? el("p", { class: "file-meta" }, el("strong", {}, photo.meta.name), el("br"), `${photo.meta.isRaw ? "RAW" : "JPEG/PNG"} · ${photo.meta.fullWidth}×${photo.meta.fullHeight}`)
      : el("p", { class: "hint" }, `${SLOTS[slot]} için fotoğraf yükleyin. Çerçeveye tıklayın veya sürükleyip bırakın.`),
    el("button", { type: "button", class: "button primary wide", onclick: () => pickFile(slot) }, photo ? "Başka fotoğraf aç" : `${SLOTS[slot]} fotoğrafını aç`),
  );
  if (!photo) return [head, section("İpucu", el("p", { class: "hint" }, "After yüklenince Before ayarları kopyalanır ve renkler otomatik eşleştirilir. İki fotoğrafı aynı anda görüp soldakine/sağdakine tıklayarak düzenlersiniz."))];

  const sections = [head];
  if (slot === "after") sections.push(matchSection(photo));
  sections.push(toolsSection(photo), cropSection(photo), lightSection(photo), colorSection(photo), presetSection(photo), maskSection(photo));
  return sections;
}

function toolsSection(photo) {
  const tools = [
    ["pan", "Kaydır"],
    ["linear", "Doğrusal maske"],
    ["radial", "Radyal maske"],
    ["brush", "Fırça maske"],
    ["erase", "Maske silgi"],
    ["subject", "Nesne seç"],
    ["heal", "İyileştir"],
    ["clone", "Klon / rötüş"],
  ];
  return section(
    "Araçlar",
    el(
      "div",
      { class: "tool-list" },
      tools.map(([id, label]) =>
        el(
          "button",
          {
            type: "button",
            class: `chip${state.tool === id ? " is-active" : ""}`,
            onclick: () => {
              state.tool = id;
              if (id === "subject") showToast("Diş veya nesneye tıklayın.");
              if (id === "clone") showToast("Alt+tık kaynak, sürükleyerek boyayın.");
              if (id === "heal") showToast("Diş eti çizgisi vb. üzerinde sürükleyin.");
              renderPanel();
              requestDraw();
            },
          },
          label,
        ),
      ),
    ),
    ["brush", "erase", "heal", "clone"].includes(state.tool)
      ? slider(
          { label: "Fırça boyutu", min: 0.01, max: 0.15, step: 0.005, format: (v) => `${Math.round(v * 100)}` },
          state.brushSize,
          0.04,
          (v) => {
            state.brushSize = v;
          },
        ).node
      : null,
    el(
      "button",
      {
        type: "button",
        class: "button wide",
        onclick: () => {
          if (photo.masks.length >= MAX_MASKS) return showToast("En fazla 8 maske.", true);
          pushHistory();
          const mask = maskDefaults(MASK_BRUSH);
          mask.bitmap = selectTeethMask(photo.pixels, photo.meta.width, photo.meta.height, photo.maskMap.width, photo.maskMap.height);
          photo.masks.push(mask);
          photo.selectedMask = photo.masks.length - 1;
          photo.showMask = true;
          syncMaskTextures(photo);
          renderPanel();
          requestDraw();
          showToast("Parlak diş bölgesi seçildi. Invert ile dışı düzenleyebilirsiniz.");
        },
      },
      "Dişleri otomatik seç",
    ),
    el("p", { class: "hint" }, "İyileştir: çevredeki dokuya göre yumuşatır. Klon: Alt+tık kaynak, sonra boyayın. Nesne seç / diş seç maske üretir; Invert ile tersine çevirin."),
  );
}

function matchSection(photo) {
  const before = state.photos.before;
  if (!before) return section("Eşleştirme", el("p", { class: "hint" }, "Eşleştirme için Before gerekli."));
  const strength = slider(
    { label: "Eşleştirme gücü", min: 0, max: 100, step: 1, format: (v) => `%${Math.round(v)}` },
    photo.match ? Math.round(photo.match.strength * 100) : 80,
    80,
    (v) => {
      if (!photo.match) return;
      pushHistory();
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
          pushHistory();
          runMatch(photo);
          renderPanel();
          requestDraw();
          showToast("After, Before’a göre eşleştirildi.");
        },
      },
      "İlk fotoğrafla eşleştir",
    ),
    strength.node,
    el(
      "button",
      {
        type: "button",
        class: "button wide",
        onclick: () => {
          pushHistory();
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
      pushHistory();
      photo.geometry = { ...photo.geometry, zoom: v };
      requestDraw();
    },
  );
  const angle = slider(
    { label: "Açı", min: ANGLE_RANGE[0], max: ANGLE_RANGE[1], step: 0.1, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}°` },
    photo.geometry.angle,
    0,
    (v) => {
      pushHistory();
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
            pushHistory();
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
            pushHistory();
            photo.geometry = defaultGeometry();
            syncControls();
            requestDraw();
          },
        },
        "Kadrajı sıfırla",
      ),
    ),
  );
}

function paramSliders(photo, defs) {
  const defaults = defaultParams(photo.meta);
  return defs.map((def) => {
    const s = slider(def, photo.params[def.key], defaults[def.key], (v) => {
      pushHistory();
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
          pushHistory();
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
            pushHistory();
            applyPreset(photo, all[chosen]);
            syncControls();
            requestDraw();
          },
        },
        "Uygula",
      ),
      el("button", { type: "button", class: "button", onclick: () => savePreset(photo) }, "Mevcut ayarı kaydet"),
    ),
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
    photo.masks.map((mask, i) =>
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
        `${MASK_TYPE_LABELS[mask.type] || "Maske"} ${i + 1}`,
      ),
    ),
  );
  const mask = photo.masks[photo.selectedMask];
  const children = [photo.masks.length ? list : el("p", { class: "hint" }, "Araçlardan maske ekleyin.")];
  if (mask) {
    children.push(
      el(
        "label",
        { class: "check" },
        el("input", {
          type: "checkbox",
          checked: mask.invert,
          onchange: (e) => {
            pushHistory();
            mask.invert = e.target.checked;
            requestDraw();
          },
        }),
        "Invert (tersine çevir)",
      ),
    );
    if (mask.type === MASK_RADIAL) {
      children.push(
        slider(
          { label: "İç yarıçap", min: 0, max: 0.8, step: 0.01, format: (v) => v.toFixed(2) },
          mask.inner,
          0.15,
          (v) => {
            pushHistory();
            mask.inner = Math.min(v, mask.outer - 0.01);
            requestDraw();
          },
        ).node,
        slider(
          { label: "Dış yarıçap", min: 0.05, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
          mask.outer,
          0.4,
          (v) => {
            pushHistory();
            mask.outer = Math.max(v, mask.inner + 0.01);
            requestDraw();
          },
        ).node,
      );
    }
    for (const def of MASK_CONTROLS) {
      const s = slider(def, mask[def.key], 0, (v) => {
        pushHistory();
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
        "Maske alanını göster",
      ),
      el(
        "button",
        {
          type: "button",
          class: "button ghost wide",
          onclick: () => {
            pushHistory();
            photo.masks.splice(photo.selectedMask, 1);
            photo.selectedMask = photo.masks.length - 1;
            syncMaskTextures(photo);
            renderPanel();
            requestDraw();
          },
        },
        "Maskeyi sil",
      ),
    );
  }
  return section("Maskeler", ...children);
}

function sharePanel() {
  const s = state.share;
  const both = state.photos.before && state.photos.after;
  const update = (fn) => {
    fn();
    scheduleSharePreview();
  };
  const sliderOf = (def, value, def0, apply) => slider(def, value, def0, (v) => update(() => apply(v))).node;
  const sections = [
    section(
      "Düzen",
      both
        ? select(
            "Düzen",
            [
              ["auto", "Otomatik"],
              ["side_by_side", "Yan yana"],
              ["stacked", "Alt alta"],
            ],
            s.layout,
            (v) => update(() => (s.layout = v)),
          )
        : el("p", { class: "hint" }, "Tek fotoğraf yüklü — paylaşım tek kare olarak hazırlanır."),
      select(
        "Paylaşım oranı",
        [
          ["4:5", "4:5 Instagram gönderi"],
          ["1:1", "1:1 Kare"],
          ["9:16", "9:16 Story / Reels"],
          ["16:9", "16:9 Yatay"],
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
      both
        ? el(
            "label",
            { class: "check" },
            el("input", {
              type: "checkbox",
              checked: s.showDivider,
              onchange: (e) => update(() => (s.showDivider = e.target.checked)),
            }),
            "Fotoğraflar arasında ayraç çizgisi",
          )
        : null,
    ),
    section(
      "Yazılar",
      el(
        "label",
        { class: "check" },
        el("input", { type: "checkbox", checked: s.labels.enabled, onchange: (e) => update(() => (s.labels.enabled = e.target.checked)) }),
        "BEFORE / AFTER yazısı",
      ),
      select("Yazı tipi", FONT_OPTIONS, s.labels.font, (v) => update(() => (s.labels.font = v))),
      el("label", { class: "field" }, el("span", {}, "Before yazısı"), el("input", { type: "text", value: s.labels.beforeText, maxlength: 40, oninput: (e) => update(() => (s.labels.beforeText = e.target.value)) })),
      el("label", { class: "field" }, el("span", {}, "After yazısı"), el("input", { type: "text", value: s.labels.afterText, maxlength: 40, oninput: (e) => update(() => (s.labels.afterText = e.target.value)) })),
      sliderOf({ label: "Yazı boyutu", min: 2, max: 8, step: 0.5, format: (v) => v.toFixed(1) }, s.labels.sizePercent, 4, (v) => (s.labels.sizePercent = v)),
      el("label", { class: "field" }, el("span", {}, "Yazı rengi"), el("input", { type: "color", value: s.labels.textColor, oninput: (e) => update(() => (s.labels.textColor = e.target.value)) })),
      sliderOf({ label: "Yazı zemini opaklığı", min: 0, max: 100, step: 1, format: (v) => `%${v}` }, Math.round(s.labels.backgroundOpacity * 100), 45, (v) => (s.labels.backgroundOpacity = v / 100)),
    ),
    section(
      "Logo",
      el(
        "div",
        { class: "logo-picker" },
        logoChoice("beyaz", "Beyaz logo"),
        logoChoice("siyah", "Siyah logo"),
      ),
      el("p", { class: "file-meta" }, s.logoName ? el("strong", {}, s.logoName) : "Klinik logolarından birini seçin veya kendi PNG’nizi yükleyin"),
      el("button", { type: "button", class: "button wide", onclick: () => logoInput.click() }, "Kendi logosunu yükle"),
      select(
        "Konum",
        [
          ["divider", "Ortada / ayraç"],
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
      "Vinyet",
      select(
        "Uygulama",
        [
          ["off", "Kapalı"],
          ["before", "Yalnız Before"],
          ["after", "Yalnız After"],
          ["both", "Before ve After ayrı ayrı"],
          ["canvas", "Tek karede (tüm görsel)"],
        ],
        s.vignette.mode,
        (v) => update(() => (s.vignette.mode = v)),
      ),
      sliderOf({ label: "Yoğunluk", min: 0, max: 100, step: 1, format: (v) => `%${v}` }, Math.round(s.vignette.amount * 100), 45, (v) => (s.vignette.amount = v / 100)),
      sliderOf({ label: "Başlangıç", min: 20, max: 90, step: 1, format: (v) => `%${v}` }, Math.round(s.vignette.midpoint * 100), 55, (v) => (s.vignette.midpoint = v / 100)),
      el("p", { class: "hint" }, "Instagram’da kenarları yumuşatmak için. Ayrı ayrı: her panele; tek karede: birleşik görsele uygulanır."),
    ),
    section(
      "İndir",
      el("p", { class: "hint", id: "share-info" }, s.previewInfo),
      el("button", { type: "button", class: "button primary wide", onclick: () => exportComposite("png").catch(showError) }, "Paylaşım görseli · PNG"),
      el("button", { type: "button", class: "button wide", onclick: () => exportComposite("jpeg").catch(showError) }, "Paylaşım görseli · JPEG %100"),
      state.photos.after ? el("button", { type: "button", class: "button wide", onclick: () => exportSingle("after", "jpeg").catch(showError) }, "Yalnız After · JPEG") : null,
      state.photos.before ? el("button", { type: "button", class: "button wide", onclick: () => exportSingle("before", "jpeg").catch(showError) }, "Yalnız Before · JPEG") : null,
    ),
  ];
  if (both) {
    sections.push(
      section(
        "Kaydırmalı video",
        el("p", { class: "hint" }, "Önce Before, ayraç kayıp After’ı gösterir. Reels için 9:16, gönderi için 4:5."),
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
    );
  }
  return sections;
}

function logoChoice(variant, label) {
  const s = state.share;
  return el(
    "button",
    {
      type: "button",
      class: `logo-choice${s.logo.variant === variant && !s.logoName?.startsWith("özel") ? " is-active" : ""}`,
      "data-variant": variant,
      onclick: () => {
        s.logo.variant = variant;
        s.logoBytes = s.clinicLogos[variant];
        s.logoName = variant === "beyaz" ? "Klinik logo (beyaz)" : "Klinik logo (siyah)";
        renderPanel();
        scheduleSharePreview(0);
      },
    },
    el("img", { src: `/logos/${variant}.png`, alt: label }),
    label,
  );
}

// ---------- share / export ----------

function shareHeader(format) {
  const s = state.share;
  return {
    format,
    settings: {
      layout: s.layout,
      aspect: s.aspect,
      fit: s.fit,
      background: s.background,
      showDivider: s.showDivider,
      labels: s.labels,
      logo: s.logo,
      vignette: s.vignette,
    },
  };
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
  if (state.tab !== "share" || (!before && !after)) return;
  const parts = {
    before: before ? rgbaPart(renderSmall(before, SHARE_PREVIEW_SIDE)) : null,
    after: after ? rgbaPart(renderSmall(after, SHARE_PREVIEW_SIDE)) : null,
    logo: state.share.logoBytes ? { bytes: state.share.logoBytes, meta: {} } : null,
  };
  const response = await postParts("/api/compose", shareHeader("preview"), parts);
  const blob = await response.blob();
  if (state.share.previewUrl) URL.revokeObjectURL(state.share.previewUrl);
  state.share.previewUrl = URL.createObjectURL(blob);
  const layoutHeader = response.headers.get("X-Layout");
  const layout =
    layoutHeader === "stacked" ? "Alt alta" : layoutHeader === "single" ? "Tek kare" : "Yan yana";
  state.share.previewInfo = `${layout} düzen. Önizleme; indirilen dosya tam çözünürlüktedir.`;
  sharePreview.src = state.share.previewUrl;
  const info = document.getElementById("share-info");
  if (info) info.textContent = state.share.previewInfo;
  requestDraw();
}

async function exportComposite(format) {
  const { before, after } = state.photos;
  await withBusy("Tam çözünürlük hazırlanıyor…", async () => {
    const parts = {
      before: before ? rgbaPart(await renderFull(before)) : null,
      after: after ? rgbaPart(await renderFull(after)) : null,
      logo: state.share.logoBytes ? { bytes: state.share.logoBytes, meta: {} } : null,
    };
    const response = await postParts("/api/compose", shareHeader(format), parts);
    const name = stem((after || before).meta.name);
    download(await response.blob(), `${name}_${before && after ? "before_after" : "paylasim"}.${format === "jpeg" ? "jpg" : "png"}`);
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
  state.share.logoName = `özel: ${file.name}`;
  renderPanel();
  scheduleSharePreview(0);
});

clearBefore.addEventListener("click", (e) => {
  e.stopPropagation();
  clearPhoto("before");
});
clearAfter.addEventListener("click", (e) => {
  e.stopPropagation();
  clearPhoto("after");
});
btnUndo.addEventListener("click", undo);
btnRedo.addEventListener("click", redo);

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

async function loadClinicLogos() {
  for (const variant of ["beyaz", "siyah"]) {
    try {
      const response = await fetch(`/logos/${variant}.png`);
      if (!response.ok) continue;
      state.share.clinicLogos[variant] = new Uint8Array(await response.arrayBuffer());
    } catch {
      // Optional assets.
    }
  }
  if (state.share.clinicLogos.beyaz) {
    state.share.logoBytes = state.share.clinicLogos.beyaz;
    state.share.logoName = "Klinik logo (beyaz)";
    state.share.logo.variant = "beyaz";
  }
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
window.addEventListener("resize", requestDraw);
window.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  if (event.target.closest?.("input, textarea, select")) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    undo();
  } else if ((key === "z" && event.shiftKey) || key === "y") {
    event.preventDefault();
    redo();
  }
});

try {
  renderer = new Renderer(glCanvas);
} catch (error) {
  showError(error);
}
loadClinicLogos().finally(() => {
  renderPanel();
  requestDraw();
});

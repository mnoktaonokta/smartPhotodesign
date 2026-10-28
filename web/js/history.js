// Undo / redo snapshots for photo edits. Pixel buffers are cloned only when needed.

const MAX_STEPS = 40;

export class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Capture a reversible snapshot for ``slot``. ``pixels`` optional Uint16Array clone. */
  push(slot, photo, { includePixels = false } = {}) {
    if (!photo) return;
    this.undoStack.push(snapshot(slot, photo, includePixels));
    if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(photos, applyPixels) {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const current = photos[entry.slot];
    if (current) this.redoStack.push(snapshot(entry.slot, current, !!entry.pixels));
    return restore(entry, photos, applyPixels);
  }

  redo(photos, applyPixels) {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const current = photos[entry.slot];
    if (current) this.undoStack.push(snapshot(entry.slot, current, !!entry.pixels));
    return restore(entry, photos, applyPixels);
  }
}

function snapshot(slot, photo, includePixels) {
  return {
    slot,
    params: { ...photo.params },
    geometry: { ...photo.geometry },
    masks: photo.masks.map(cloneMask),
    selectedMask: photo.selectedMask,
    showMask: photo.showMask,
    match: photo.match
      ? {
          base: { ...photo.match.base },
          solution: { ...photo.match.solution },
          strength: photo.match.strength,
        }
      : null,
    pixels: includePixels && photo.pixels ? new Uint16Array(photo.pixels) : null,
  };
}

function cloneMask(mask) {
  return {
    ...mask,
    a: mask.a ? [...mask.a] : undefined,
    b: mask.b ? [...mask.b] : undefined,
    center: mask.center ? [...mask.center] : undefined,
    bitmap: mask.bitmap ? new Uint8Array(mask.bitmap) : null,
  };
}

function restore(entry, photos, applyPixels) {
  const photo = photos[entry.slot];
  if (!photo) return entry.slot;
  photo.params = { ...entry.params };
  photo.geometry = { ...entry.geometry };
  photo.masks = entry.masks.map(cloneMask);
  photo.selectedMask = entry.selectedMask;
  photo.showMask = entry.showMask;
  photo.match = entry.match
    ? {
        base: { ...entry.match.base },
        solution: { ...entry.match.solution },
        strength: entry.match.strength,
      }
    : null;
  if (entry.pixels && photo.pixels) {
    photo.pixels.set(entry.pixels);
    applyPixels?.(photo);
  }
  return entry.slot;
}

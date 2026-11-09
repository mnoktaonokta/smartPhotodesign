// Per-slot undo / redo. Before and After keep independent stacks.

const MAX_STEPS = 40;

export class SlotHistory {
  constructor() {
    this.stacks = {
      before: { undo: [], redo: [] },
      after: { undo: [], redo: [] },
    };
  }

  canUndo(slot) {
    return (this.stacks[slot]?.undo.length || 0) > 0;
  }

  canRedo(slot) {
    return (this.stacks[slot]?.redo.length || 0) > 0;
  }

  clear(slot) {
    if (slot) {
      this.stacks[slot] = { undo: [], redo: [] };
      return;
    }
    this.stacks.before = { undo: [], redo: [] };
    this.stacks.after = { undo: [], redo: [] };
  }

  /** Capture a reversible snapshot for ``slot``. ``pixels`` optional Uint16Array clone. */
  push(slot, photo, { includePixels = false } = {}) {
    if (!photo || !this.stacks[slot]) return;
    const stack = this.stacks[slot];
    stack.undo.push(snapshot(photo, includePixels));
    if (stack.undo.length > MAX_STEPS) stack.undo.shift();
    stack.redo = [];
  }

  undo(slot, photo, applyPixels) {
    const stack = this.stacks[slot];
    if (!stack || !photo) return false;
    const entry = stack.undo.pop();
    if (!entry) return false;
    stack.redo.push(snapshot(photo, !!entry.pixels));
    restore(entry, photo, applyPixels);
    return true;
  }

  redo(slot, photo, applyPixels) {
    const stack = this.stacks[slot];
    if (!stack || !photo) return false;
    const entry = stack.redo.pop();
    if (!entry) return false;
    stack.undo.push(snapshot(photo, !!entry.pixels));
    restore(entry, photo, applyPixels);
    return true;
  }
}

function snapshot(photo, includePixels) {
  return {
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

function restore(entry, photo, applyPixels) {
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
}

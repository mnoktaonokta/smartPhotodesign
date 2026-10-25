// Slider definitions and small DOM helpers for the side panel.

import { KELVIN_RANGE, RELATIVE_RANGE, TINT_RANGE } from "./color.js";

const signed = (digits = 0) => (v) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

// Light and color sliders use Lightroom's English names.
export const LIGHT_CONTROLS = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.01, format: signed(2) },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, format: signed() },
  { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1, format: signed() },
  { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1, format: signed() },
  { key: "whites", label: "Whites", min: -100, max: 100, step: 1, format: signed() },
  { key: "blacks", label: "Blacks", min: -100, max: 100, step: 1, format: signed() },
];

export function colorControls(kelvin) {
  return [
    kelvin
      ? { key: "temperature", label: "Temp", min: KELVIN_RANGE[0], max: KELVIN_RANGE[1], step: 50, inputStep: 1, format: (v) => `${Math.round(v)} K`, track: "temperature" }
      : { key: "temperature", label: "Temp", min: RELATIVE_RANGE[0], max: RELATIVE_RANGE[1], step: 1, format: signed(), track: "temperature" },
    kelvin
      ? { key: "tint", label: "Tint", min: TINT_RANGE[0], max: TINT_RANGE[1], step: 1, format: signed(), track: "tint" }
      : { key: "tint", label: "Tint", min: RELATIVE_RANGE[0], max: RELATIVE_RANGE[1], step: 1, format: signed(), track: "tint" },
    { key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1, format: signed() },
    { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, format: signed() },
  ];
}

export const MASK_CONTROLS = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.01, format: signed(2) },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, format: signed() },
  { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1, format: signed() },
  { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1, format: signed() },
  { key: "temperature", label: "Temp", min: -100, max: 100, step: 1, format: signed(), track: "temperature" },
  { key: "tint", label: "Tint", min: -100, max: 100, step: 1, format: signed(), track: "tint" },
  { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, format: signed() },
];

/**
 * Parse a typed slider value such as "+0,25", "3900 K" or "%80".
 * Returns the value clamped to the slider range and rounded to ``step``, or null.
 */
export function parseSliderValue(text, def) {
  const match = String(text).replace(",", ".").match(/[-+−]?\d*\.?\d+/);
  if (!match) return null;
  const value = Number(match[0].replace("−", "-"));
  if (!Number.isFinite(value)) return null;
  return roundToStep(Math.min(def.max, Math.max(def.min, value)), def.inputStep ?? def.step);
}

function roundToStep(value, step) {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(value / step) * step).toFixed(digits));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Labeled slider. Double-click the label to reset to ``defaultValue``; click the
 * value to type one (Enter applies, Esc cancels, arrow keys nudge).
 * Returns ``{ node, set }`` so code can update the value without rebuilding.
 */
export function slider(def, value, defaultValue, onChange, { disabled = false } = {}) {
  const format = (v) => (def.format ? def.format(v) : String(v));
  let current = Number(value);
  const output = el("input", {
    type: "text",
    class: "slider-value",
    inputmode: "decimal",
    spellcheck: "false",
    autocomplete: "off",
    disabled,
    title: "Değer yazmak için tıklayın",
    "aria-label": `${def.label} değeri`,
  });
  const commit = (v) => {
    current = v;
    input.value = String(v);
    output.value = format(v);
    onChange(v);
  };
  output.addEventListener("focus", () => {
    output.value = String(current);
    output.select();
  });
  output.addEventListener("blur", () => {
    const v = parseSliderValue(output.value, def);
    if (v !== null && v !== current) commit(v);
    else output.value = format(current);
  });
  output.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      output.blur();
    } else if (event.key === "Escape") {
      output.value = String(current);
      output.blur();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = (def.inputStep ?? def.step) * (event.shiftKey ? 10 : 1);
      const base = parseSliderValue(output.value, def) ?? current;
      const v = parseSliderValue(String(base + (event.key === "ArrowUp" ? step : -step)), def);
      commit(v);
      output.value = String(v);
      output.select();
    }
  });
  const input = el("input", {
    type: "range",
    min: def.min,
    max: def.max,
    step: def.step,
    disabled,
    class: def.track ? `track-${def.track}` : null,
    "aria-label": def.label,
  });
  const set = (v) => {
    current = Number(v);
    input.value = String(v);
    if (document.activeElement !== output) output.value = format(current);
  };
  set(value);
  input.addEventListener("input", () => {
    current = Number(input.value);
    output.value = format(current);
    onChange(current);
  });
  const label = el(
    "label",
    {
      class: "slider-label",
      title: "Sıfırlamak için çift tıklayın",
      ondblclick: () => {
        if (disabled) return;
        commit(defaultValue);
      },
    },
    def.label,
  );
  const node = el("div", { class: `slider${disabled ? " is-disabled" : ""}` }, el("div", { class: "slider-head" }, label, output), input);
  return { node, set };
}

export function section(title, ...children) {
  return el("section", { class: "panel-section" }, el("h3", {}, title), ...children);
}

export function select(label, options, value, onChange) {
  const node = el(
    "select",
    { onchange: (e) => onChange(e.target.value), "aria-label": label },
    options.map(([v, text]) => el("option", { value: v, selected: v === value }, text)),
  );
  return el("label", { class: "field" }, el("span", {}, label), node);
}

export function segmented(options, value, onChange) {
  return el(
    "div",
    { class: "segmented", role: "radiogroup" },
    options.map(([v, text]) =>
      el("button", { type: "button", class: v === value ? "is-active" : null, "aria-pressed": v === value, onclick: () => onChange(v) }, text),
    ),
  );
}

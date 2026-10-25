// Slider definitions and small DOM helpers for the side panel.

import { KELVIN_RANGE, RELATIVE_RANGE, TINT_RANGE } from "./color.js";

const signed = (digits = 0) => (v) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

export const LIGHT_CONTROLS = [
  { key: "exposure", label: "Pozlama", min: -4, max: 4, step: 0.01, format: signed(2) },
  { key: "contrast", label: "Kontrast", min: -100, max: 100, step: 1, format: signed() },
  { key: "highlights", label: "Parlak alanlar", min: -100, max: 100, step: 1, format: signed() },
  { key: "shadows", label: "Gölgeler", min: -100, max: 100, step: 1, format: signed() },
  { key: "whites", label: "Beyazlar", min: -100, max: 100, step: 1, format: signed() },
  { key: "blacks", label: "Siyahlar", min: -100, max: 100, step: 1, format: signed() },
];

export function colorControls(kelvin) {
  return [
    kelvin
      ? { key: "temperature", label: "Sıcaklık", min: KELVIN_RANGE[0], max: KELVIN_RANGE[1], step: 50, format: (v) => `${Math.round(v)} K`, track: "temperature" }
      : { key: "temperature", label: "Sıcaklık", min: RELATIVE_RANGE[0], max: RELATIVE_RANGE[1], step: 1, format: signed(), track: "temperature" },
    kelvin
      ? { key: "tint", label: "Renk tonu", min: TINT_RANGE[0], max: TINT_RANGE[1], step: 1, format: signed(), track: "tint" }
      : { key: "tint", label: "Renk tonu", min: RELATIVE_RANGE[0], max: RELATIVE_RANGE[1], step: 1, format: signed(), track: "tint" },
    { key: "vibrance", label: "Canlılık", min: -100, max: 100, step: 1, format: signed() },
    { key: "saturation", label: "Doygunluk", min: -100, max: 100, step: 1, format: signed() },
  ];
}

export const MASK_CONTROLS = [
  { key: "exposure", label: "Pozlama", min: -4, max: 4, step: 0.01, format: signed(2) },
  { key: "contrast", label: "Kontrast", min: -100, max: 100, step: 1, format: signed() },
  { key: "highlights", label: "Parlak alanlar", min: -100, max: 100, step: 1, format: signed() },
  { key: "shadows", label: "Gölgeler", min: -100, max: 100, step: 1, format: signed() },
  { key: "temperature", label: "Sıcaklık", min: -100, max: 100, step: 1, format: signed(), track: "temperature" },
  { key: "tint", label: "Renk tonu", min: -100, max: 100, step: 1, format: signed(), track: "tint" },
  { key: "saturation", label: "Doygunluk", min: -100, max: 100, step: 1, format: signed() },
];

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
 * Labeled slider. Double-click the label to reset to ``defaultValue``.
 * Returns ``{ node, set }`` so code can update the value without rebuilding.
 */
export function slider(def, value, defaultValue, onChange, { disabled = false } = {}) {
  const output = el("span", { class: "slider-value" });
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
    input.value = String(v);
    output.textContent = def.format ? def.format(Number(v)) : String(v);
  };
  set(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    output.textContent = def.format ? def.format(v) : String(v);
    onChange(v);
  });
  const label = el(
    "label",
    {
      class: "slider-label",
      title: "Sıfırlamak için çift tıklayın",
      ondblclick: () => {
        if (disabled) return;
        set(defaultValue);
        onChange(defaultValue);
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

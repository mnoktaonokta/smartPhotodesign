"""Before/after layouts, text labels, logo placement and file export."""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

Layout = Literal["side_by_side", "stacked"]
AspectRatio = Literal["original", "1:1", "4:5", "9:16"]
FitMode = Literal["pad", "crop"]
LogoPosition = Literal["divider", "bottom_right", "top_right"]
RGB = tuple[int, int, int]

ASPECT_VALUES: dict[str, float] = {"1:1": 1.0, "4:5": 4 / 5, "9:16": 9 / 16}
MAX_CANVAS_SIDE = 6000
FONT_PATH = Path(__file__).resolve().parent.parent / "assets" / "fonts" / "DejaVuSans-Bold.ttf"


@dataclass(frozen=True)
class LabelStyle:
    enabled: bool = True
    before_text: str = "BEFORE"
    after_text: str = "AFTER"
    size_percent: float = 4.0
    text_color: RGB = (255, 255, 255)
    background_opacity: float = 0.45


@dataclass(frozen=True)
class LogoStyle:
    position: LogoPosition = "bottom_right"
    width_percent: float = 18.0
    opacity: float = 0.9


@dataclass(frozen=True)
class CompositionSettings:
    layout: Layout = "side_by_side"
    aspect: AspectRatio = "4:5"
    fit: FitMode = "pad"
    background: RGB = (255, 255, 255)
    divider_percent: float = 0.4
    labels: LabelStyle = field(default_factory=LabelStyle)
    logo: LogoStyle = field(default_factory=LogoStyle)


def compose(
    before: np.ndarray,
    after: np.ndarray,
    settings: CompositionSettings,
    logo: Image.Image | None = None,
    *,
    max_side: int = MAX_CANVAS_SIDE,
) -> Image.Image:
    """Build the before/after canvas as an RGB image."""
    width, height = canvas_size(before, after, settings, max_side=max_side)
    gap = divider_width(width, height, settings)
    if settings.layout == "side_by_side":
        panel_w, panel_h = (width - gap) // 2, height
        origins = [(0, 0), (width - panel_w, 0)]
    else:
        panel_w, panel_h = width, (height - gap) // 2
        origins = [(0, 0), (0, height - panel_h)]

    canvas = Image.new("RGB", (width, height), settings.background)
    panels = [
        fit_to_panel(before, panel_w, panel_h, settings.fit, settings.background),
        fit_to_panel(after, panel_w, panel_h, settings.fit, settings.background),
    ]
    for panel, origin in zip(panels, origins):
        canvas.paste(Image.fromarray(panel), origin)

    canvas = canvas.convert("RGBA")
    if settings.labels.enabled:
        texts = [settings.labels.before_text, settings.labels.after_text]
        for text, origin in zip(texts, origins):
            _draw_label(canvas, text, origin, settings.labels, min(width, height))
    if logo is not None:
        _paste_logo(canvas, logo, settings)
    return canvas.convert("RGB")


def canvas_size(
    before: np.ndarray,
    after: np.ndarray,
    settings: CompositionSettings,
    *,
    max_side: int = MAX_CANVAS_SIDE,
) -> tuple[int, int]:
    """Pick the canvas size for the requested aspect without upscaling either photo."""
    stacked = settings.layout == "stacked"
    if settings.aspect == "original":
        bh, bw = before.shape[:2]
        panel_aspect = bw / bh
        ratio = panel_aspect / 2 if stacked else panel_aspect * 2
    else:
        ratio = ASPECT_VALUES[settings.aspect]
        panel_aspect = ratio * 2 if stacked else ratio / 2

    panel_h = min(min(img.shape[0], img.shape[1] / panel_aspect) for img in (before, after))
    height = panel_h * 2 if stacked else panel_h
    width = height * ratio
    scale = min(1.0, max_side / max(width, height))
    return max(2, round(width * scale)), max(2, round(height * scale))


def divider_width(width: int, height: int, settings: CompositionSettings) -> int:
    if settings.divider_percent <= 0:
        return 0
    return max(2, round(min(width, height) * settings.divider_percent / 100))


def fit_to_panel(image: np.ndarray, width: int, height: int, fit: FitMode, background: RGB) -> np.ndarray:
    """Resize ``image`` into a ``width`` x ``height`` panel by cropping or padding."""
    h, w = image.shape[:2]
    scale = max(width / w, height / h) if fit == "crop" else min(width / w, height / h)
    new_w, new_h = max(1, round(w * scale)), max(1, round(h * scale))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4
    resized = cv2.resize(image, (new_w, new_h), interpolation=interpolation)

    if fit == "crop":
        x0 = max(0, (new_w - width) // 2)
        y0 = max(0, (new_h - height) // 2)
        cropped = resized[y0 : y0 + height, x0 : x0 + width]
        if cropped.shape[:2] == (height, width):
            return np.ascontiguousarray(cropped)
        resized = cropped
        new_h, new_w = resized.shape[:2]

    panel = np.empty((height, width, 3), dtype=np.uint8)
    panel[:] = background
    x0 = (width - new_w) // 2
    y0 = (height - new_h) // 2
    panel[y0 : y0 + new_h, x0 : x0 + new_w] = resized[:height, :width]
    return panel


def to_png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", compress_level=6)
    return buf.getvalue()


def to_jpeg_bytes(image: Image.Image, quality: int = 100) -> bytes:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=quality, subsampling=0, optimize=True)
    return buf.getvalue()


def to_tiff_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="TIFF", compression="tiff_lzw")
    return buf.getvalue()


@lru_cache(maxsize=16)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(str(FONT_PATH), size)
    except OSError:
        return ImageFont.load_default(size)


def _draw_label(canvas: Image.Image, text: str, origin: tuple[int, int], style: LabelStyle, short_side: int) -> None:
    text = text.strip()
    if not text:
        return
    font_px = max(10, round(short_side * style.size_percent / 100))
    font = _font(font_px)
    pad_x, pad_y = round(font_px * 0.6), round(font_px * 0.35)
    margin = round(short_side * 0.025)

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    box_w = right - left + 2 * pad_x
    box_h = bottom - top + 2 * pad_y
    x, y = origin[0] + margin, origin[1] + margin

    alpha = round(255 * float(np.clip(style.background_opacity, 0, 1)))
    if alpha:
        draw.rounded_rectangle((x, y, x + box_w, y + box_h), radius=round(box_h * 0.25), fill=(0, 0, 0, alpha))
    draw.text((x + pad_x - left, y + pad_y - top), text, font=font, fill=(*style.text_color, 255))
    canvas.alpha_composite(overlay)


def _paste_logo(canvas: Image.Image, logo: Image.Image, settings: CompositionSettings) -> None:
    width, height = canvas.size
    style = settings.logo
    target_w = max(1, round(width * style.width_percent / 100))
    target_h = max(1, round(logo.height * target_w / logo.width))
    max_h = round(height * 0.3)
    if target_h > max_h:
        target_w = max(1, round(target_w * max_h / target_h))
        target_h = max_h

    resized = logo.convert("RGBA").resize((target_w, target_h), Image.Resampling.LANCZOS)
    opacity = float(np.clip(style.opacity, 0, 1))
    if opacity < 1:
        alpha = np.asarray(resized.getchannel("A"), dtype=np.float32) * opacity
        resized.putalpha(Image.fromarray(alpha.round().astype(np.uint8)))

    margin = round(min(width, height) * 0.03)
    if style.position == "divider":
        x, y = (width - target_w) // 2, (height - target_h) // 2
    elif style.position == "top_right":
        x, y = width - target_w - margin, margin
    else:
        x, y = width - target_w - margin, height - target_h - margin
    canvas.alpha_composite(resized, (x, y))

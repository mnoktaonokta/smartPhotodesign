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
Align = tuple[float, float]
CENTER: Align = (0.5, 0.5)

ASPECT_VALUES: dict[str, float] = {"1:1": 1.0, "4:5": 4 / 5, "9:16": 9 / 16}
MAX_CANVAS_SIDE = 6000
MAX_LOGO_HEIGHT_FRACTION = 0.5
VIDEO_WIDTH = 1080
VIDEO_MAX_HEIGHT = 1920
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
    # Padded photos hug the divider so the pair reads as one block.
    if settings.layout == "side_by_side":
        panel_w, panel_h = (width - gap) // 2, height
        origins = [(0, 0), (width - panel_w, 0)]
        aligns: list[Align] = [(1.0, 0.5), (0.0, 0.5)]
    else:
        panel_w, panel_h = width, (height - gap) // 2
        origins = [(0, 0), (0, height - panel_h)]
        aligns = [(0.5, 1.0), (0.5, 0.0)]

    canvas = Image.new("RGB", (width, height), settings.background)
    for image, origin, align in zip((before, after), origins, aligns):
        panel = fit_to_panel(image, panel_w, panel_h, settings.fit, settings.background, align)
        canvas.paste(Image.fromarray(panel), origin)

    canvas = canvas.convert("RGBA")
    if settings.labels.enabled:
        texts = [settings.labels.before_text, settings.labels.after_text]
        for text, image, origin, align in zip(texts, (before, after), origins, aligns):
            x0, y0, x1, y1 = content_box(image, panel_w, panel_h, settings.fit, align)
            box = (origin[0] + x0, origin[1] + y0, origin[0] + x1, origin[1] + y1)
            _draw_label(canvas, text, box, settings.labels)
    if logo is not None:
        _paste_logo(canvas, logo, settings.logo.position, settings.logo)
    return canvas.convert("RGB")


def video_size(image: np.ndarray, aspect: AspectRatio) -> tuple[int, int]:
    """Instagram-friendly video frame size: 1080 wide, even height, at most 1920 tall."""
    if aspect == "original":
        h, w = image.shape[:2]
        ratio = w / h
    else:
        ratio = ASPECT_VALUES[aspect]
    width = VIDEO_WIDTH
    height = min(VIDEO_MAX_HEIGHT, round(width / ratio / 2) * 2)
    return width, max(2, height)


def slider_frames(
    before: np.ndarray,
    after: np.ndarray,
    settings: CompositionSettings,
    logo: Image.Image | None = None,
    size: tuple[int, int] | None = None,
) -> tuple[Image.Image, Image.Image]:
    """Full-canvas Before and After frames for a sliding-divider video.

    Both frames share the same photo placement and logo so that revealing one
    over the other only changes the photo and its label. The Before label sits
    top-left and the After label top-right, matching the divider sides.
    """
    width, height = size or video_size(before, settings.aspect)
    # A logo centred on the canvas would cover the subject once the divider moves.
    logo_position: str = "bottom_center" if settings.logo.position == "divider" else settings.logo.position
    frames = []
    for image, text, side in (
        (before, settings.labels.before_text, "left"),
        (after, settings.labels.after_text, "right"),
    ):
        panel = fit_to_panel(image, width, height, settings.fit, settings.background)
        canvas = Image.fromarray(panel).convert("RGBA")
        if settings.labels.enabled:
            _draw_label(canvas, text, content_box(image, width, height, settings.fit), settings.labels, side)
        if logo is not None:
            _paste_logo(canvas, logo, logo_position, settings.logo)
        frames.append(canvas.convert("RGB"))
    return frames[0], frames[1]


def resolve_layout(image: np.ndarray, aspect: AspectRatio) -> Layout:
    """Choose the layout whose panels best match the photo's shape, wasting the least area."""
    h, w = image.shape[:2]
    photo_aspect = w / h
    if aspect == "original":
        return "stacked" if photo_aspect > 1 else "side_by_side"
    ratio = ASPECT_VALUES[aspect]
    side_mismatch = abs(np.log(photo_aspect / (ratio / 2)))
    stacked_mismatch = abs(np.log(photo_aspect / (ratio * 2)))
    return "stacked" if stacked_mismatch < side_mismatch else "side_by_side"


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


def content_box(
    image: np.ndarray,
    width: int,
    height: int,
    fit: FitMode,
    align: Align = CENTER,
) -> tuple[int, int, int, int]:
    """Return the (x0, y0, x1, y1) area the photo occupies inside a panel.

    ``align`` places a padded photo along each axis: 0 start, 0.5 center, 1 end.
    """
    if fit == "crop":
        return 0, 0, width, height
    h, w = image.shape[:2]
    scale = min(width / w, height / h)
    new_w, new_h = min(width, max(1, round(w * scale))), min(height, max(1, round(h * scale)))
    x0 = round((width - new_w) * align[0])
    y0 = round((height - new_h) * align[1])
    return x0, y0, x0 + new_w, y0 + new_h


def fit_to_panel(
    image: np.ndarray,
    width: int,
    height: int,
    fit: FitMode,
    background: RGB,
    align: Align = CENTER,
) -> np.ndarray:
    """Resize ``image`` into a ``width`` x ``height`` panel by center-cropping or padding."""
    h, w = image.shape[:2]
    if fit == "crop":
        scale = max(width / w, height / h)
        new_w, new_h = max(width, round(w * scale)), max(height, round(h * scale))
        resized = cv2.resize(image, (new_w, new_h), interpolation=_interpolation(scale))
        x0, y0 = (new_w - width) // 2, (new_h - height) // 2
        return np.ascontiguousarray(resized[y0 : y0 + height, x0 : x0 + width])

    x0, y0, x1, y1 = content_box(image, width, height, fit, align)
    resized = cv2.resize(image, (x1 - x0, y1 - y0), interpolation=_interpolation((x1 - x0) / w))
    panel = np.empty((height, width, 3), dtype=np.uint8)
    panel[:] = background
    panel[y0:y1, x0:x1] = resized
    return panel


def _interpolation(scale: float) -> int:
    return cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4


def to_png_bytes(image: Image.Image, compress_level: int = 6) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", compress_level=compress_level)
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


def _draw_label(
    canvas: Image.Image,
    text: str,
    box: tuple[int, int, int, int],
    style: LabelStyle,
    side: Literal["left", "right"] = "left",
) -> None:
    """Draw ``text`` in the top corner of the photo ``box``, sized relative to its long side."""
    text = text.strip()
    if not text:
        return
    photo_side = max(box[2] - box[0], box[3] - box[1])
    font_px = max(10, round(photo_side * style.size_percent / 100))
    font = _font(font_px)
    pad_x, pad_y = round(font_px * 0.6), round(font_px * 0.35)
    margin = round(font_px * 0.6)

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    box_w = right - left + 2 * pad_x
    box_h = bottom - top + 2 * pad_y
    x = box[0] + margin if side == "left" else box[2] - margin - box_w
    y = box[1] + margin

    alpha = round(255 * float(np.clip(style.background_opacity, 0, 1)))
    if alpha:
        draw.rounded_rectangle((x, y, x + box_w, y + box_h), radius=round(box_h * 0.25), fill=(0, 0, 0, alpha))
    draw.text((x + pad_x - left, y + pad_y - top), text, font=font, fill=(*style.text_color, 255))
    canvas.alpha_composite(overlay)


def _paste_logo(canvas: Image.Image, logo: Image.Image, position: str, style: LogoStyle) -> None:
    width, height = canvas.size
    target_w = max(1, round(width * style.width_percent / 100))
    target_h = max(1, round(logo.height * target_w / logo.width))
    max_h = round(height * MAX_LOGO_HEIGHT_FRACTION)
    if target_h > max_h:
        target_w = max(1, round(target_w * max_h / target_h))
        target_h = max_h

    resized = logo.convert("RGBA").resize((target_w, target_h), Image.Resampling.LANCZOS)
    opacity = float(np.clip(style.opacity, 0, 1))
    if opacity < 1:
        alpha = np.asarray(resized.getchannel("A"), dtype=np.float32) * opacity
        resized.putalpha(Image.fromarray(alpha.round().astype(np.uint8)))

    margin = round(min(width, height) * 0.03)
    if position == "divider":
        x, y = (width - target_w) // 2, (height - target_h) // 2
    elif position == "bottom_center":
        x, y = (width - target_w) // 2, height - target_h - margin
    elif position == "top_right":
        x, y = width - target_w - margin, margin
    else:
        x, y = width - target_w - margin, height - target_h - margin
    canvas.alpha_composite(resized, (x, y))

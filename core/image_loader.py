"""Decode RAW and standard photos into 8-bit sRGB arrays."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Literal

import numpy as np
import rawpy
from PIL import Image, ImageOps, UnidentifiedImageError

WhiteBalance = Literal["camera", "auto"]

RAW_EXTENSIONS = frozenset({".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf"})
STANDARD_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png"})
PHOTO_EXTENSIONS = RAW_EXTENSIONS | STANDARD_EXTENSIONS


class ImageLoadError(ValueError):
    """Raised when an uploaded file cannot be decoded as a photo."""


def is_raw(filename: str) -> bool:
    return Path(filename).suffix.lower() in RAW_EXTENSIONS


def load_photo(
    data: bytes,
    filename: str,
    *,
    white_balance: WhiteBalance = "camera",
    half_size: bool = False,
) -> np.ndarray:
    """Return an (H, W, 3) uint8 sRGB array.

    ``white_balance`` and ``half_size`` only affect RAW files. ``half_size``
    skips demosaicing and halves each side, which is enough for previews.
    """
    suffix = Path(filename).suffix.lower()
    if suffix in RAW_EXTENSIONS:
        return _load_raw(data, white_balance=white_balance, half_size=half_size)
    if suffix in STANDARD_EXTENSIONS:
        return _load_standard(data)
    raise ImageLoadError(f"Desteklenmeyen dosya türü: {suffix or filename}")


def load_logo(data: bytes) -> Image.Image:
    """Return the logo as RGBA, keeping its transparency."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            return img.convert("RGBA")
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageLoadError("Logo dosyası okunamadı.") from exc


def _load_raw(data: bytes, *, white_balance: WhiteBalance, half_size: bool) -> np.ndarray:
    try:
        with rawpy.imread(io.BytesIO(data)) as raw:
            rgb = raw.postprocess(
                use_camera_wb=white_balance == "camera",
                use_auto_wb=white_balance == "auto",
                half_size=half_size,
                output_bps=8,
                output_color=rawpy.ColorSpace.sRGB,
            )
    except (rawpy.LibRawError, ValueError) as exc:
        raise ImageLoadError("RAW dosyası çözülemedi. Dosya bozuk veya kamera desteklenmiyor olabilir.") from exc
    return np.ascontiguousarray(rgb, dtype=np.uint8)


def _load_standard(data: bytes) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("I;16", "I;16B", "I;16L", "I"):
                gray = np.asarray(img, dtype=np.float32)
                gray = np.clip(gray / 257.0, 0, 255).astype(np.uint8)
                return np.repeat(gray[..., None], 3, axis=2)
            if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
                background = Image.new("RGBA", img.size, (255, 255, 255, 255))
                img = Image.alpha_composite(background, img.convert("RGBA"))
            return np.asarray(img.convert("RGB"), dtype=np.uint8).copy()
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageLoadError("Görüntü dosyası okunamadı.") from exc

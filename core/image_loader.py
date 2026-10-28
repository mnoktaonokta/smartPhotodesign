"""Decode RAW and standard photos into linear-light float arrays for the editor."""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
import rawpy
from PIL import Image, ImageOps, UnidentifiedImageError

ColorKind = Literal["camera", "srgb"]

RAW_EXTENSIONS = frozenset({".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf"})
STANDARD_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png"})
PHOTO_EXTENSIONS = RAW_EXTENSIONS | STANDARD_EXTENSIONS

# Linear sRGB (D65) to CIE XYZ.
XYZ_FROM_SRGB = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
SRGB_LUMA = XYZ_FROM_SRGB[1]
MAX_BASELINE_EV = 2.5


class ImageLoadError(ValueError):
    """Raised when an uploaded file cannot be decoded as a photo."""


@dataclass(frozen=True)
class LinearImage:
    """Scene-linear pixels plus what the editor needs to white-balance them.

    For ``kind == "camera"`` the pixels are camera RGB with no white balance;
    the editor multiplies them by per-channel gains derived from ``cam_xyz``
    and then converts with ``rgb_cam``. For ``kind == "srgb"`` the pixels are
    already white-balanced linear sRGB and ``rgb_cam`` is the identity.
    """

    pixels: np.ndarray
    kind: ColorKind
    is_raw: bool
    cam_xyz: np.ndarray | None
    rgb_cam: np.ndarray
    as_shot: np.ndarray
    baseline_ev: float

    @property
    def width(self) -> int:
        return int(self.pixels.shape[1])

    @property
    def height(self) -> int:
        return int(self.pixels.shape[0])


def is_raw(filename: str) -> bool:
    return Path(filename).suffix.lower() in RAW_EXTENSIONS


def load_linear(data: bytes, filename: str, *, half_size: bool = False, max_side: int | None = None) -> LinearImage:
    """Decode ``data`` into a :class:`LinearImage`.

    ``half_size`` skips RAW demosaicing (each side halved), which is plenty for
    on-screen editing; it has no effect on JPEG/PNG. ``max_side`` downsizes the
    result if it is larger.
    """
    suffix = Path(filename).suffix.lower()
    if suffix in RAW_EXTENSIONS:
        image = _load_raw_linear(data, half_size=half_size)
    elif suffix in STANDARD_EXTENSIONS:
        rgb = _load_standard(data)
        if max_side:
            rgb = _downscale(rgb, max_side)
        pixels = srgb_to_linear(rgb.astype(np.float32) / 255.0)
        image = LinearImage(
            pixels=pixels,
            kind="srgb",
            is_raw=False,
            cam_xyz=None,
            rgb_cam=np.eye(3),
            as_shot=np.ones(3),
            baseline_ev=0.0,
        )
    else:
        raise ImageLoadError(f"Desteklenmeyen dosya türü: {suffix or filename}")

    if max_side and max(image.pixels.shape[:2]) > max_side:
        image = LinearImage(**{**image.__dict__, "pixels": _downscale(image.pixels, max_side)})
    return image


def full_size(data: bytes, filename: str) -> tuple[int, int]:
    """Return the (width, height) a full decode would produce, without decoding pixels."""
    try:
        if is_raw(filename):
            with rawpy.imread(io.BytesIO(data)) as raw:
                sizes = raw.sizes
                rotated = sizes.flip in (5, 6)
                return (sizes.height, sizes.width) if rotated else (sizes.width, sizes.height)
        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
            rotated = img.getexif().get(0x0112, 1) in (5, 6, 7, 8)
            return (height, width) if rotated else (width, height)
    except (rawpy.LibRawError, UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageLoadError("Görüntü dosyası okunamadı.") from exc


def load_logo(data: bytes) -> Image.Image:
    """Return the logo as RGBA, keeping its transparency."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            return img.convert("RGBA")
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageLoadError("Logo dosyası okunamadı.") from exc


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    return np.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4).astype(np.float32)


def rgb_cam_from_cam_xyz(cam_xyz: np.ndarray) -> np.ndarray:
    """Camera RGB (white-balanced so neutral is 1,1,1) to linear sRGB, as dcraw computes it."""
    cam_rgb = cam_xyz @ XYZ_FROM_SRGB
    cam_rgb = cam_rgb / cam_rgb.sum(axis=1, keepdims=True)
    return np.linalg.inv(cam_rgb)


def _load_raw_linear(data: bytes, *, half_size: bool) -> LinearImage:
    try:
        with rawpy.imread(io.BytesIO(data)) as raw:
            cam_xyz = np.asarray(raw.rgb_xyz_matrix, dtype=np.float64)[:3]
            usable = raw.num_colors == 3 and np.isfinite(cam_xyz).all() and np.abs(cam_xyz).sum() > 0
            if usable:
                pixels = raw.postprocess(
                    user_wb=[1.0, 1.0, 1.0, 1.0],
                    output_color=rawpy.ColorSpace.raw,
                    gamma=(1, 1),
                    no_auto_bright=True,
                    output_bps=16,
                    half_size=half_size,
                )
                as_shot = _as_shot_multipliers(raw.camera_whitebalance, raw.daylight_whitebalance)
            else:
                pixels = raw.postprocess(
                    use_camera_wb=True,
                    output_color=rawpy.ColorSpace.sRGB,
                    gamma=(1, 1),
                    no_auto_bright=True,
                    output_bps=16,
                    half_size=half_size,
                )
    except (rawpy.LibRawError, ValueError) as exc:
        raise ImageLoadError("RAW dosyası çözülemedi. Dosya bozuk veya kamera desteklenmiyor olabilir.") from exc

    linear = pixels.astype(np.float32) / 65535.0
    if usable:
        rgb_cam = rgb_cam_from_cam_xyz(cam_xyz)
        image = LinearImage(
            pixels=linear,
            kind="camera",
            is_raw=True,
            cam_xyz=cam_xyz,
            rgb_cam=rgb_cam,
            as_shot=as_shot,
            baseline_ev=0.0,
        )
    else:
        image = LinearImage(
            pixels=linear,
            kind="srgb",
            is_raw=True,
            cam_xyz=None,
            rgb_cam=np.eye(3),
            as_shot=np.ones(3),
            baseline_ev=0.0,
        )
    return LinearImage(**{**image.__dict__, "baseline_ev": _baseline_ev(image)})


def _as_shot_multipliers(camera_wb, daylight_wb) -> np.ndarray:
    for candidate in (camera_wb, daylight_wb):
        values = np.asarray(candidate[:3], dtype=np.float64)
        if np.all(np.isfinite(values)) and np.all(values > 0):
            return values / values[1]
    return np.ones(3)


def _baseline_ev(image: LinearImage) -> float:
    """Brightening that maps the 99th luminance percentile to white, like LibRaw's auto-bright."""
    sample = _downscale(image.pixels, 512).reshape(-1, 3).astype(np.float64)
    if image.kind == "camera":
        gains = image.as_shot / image.as_shot.min()
        sample = np.clip(sample * gains, 0.0, 1.0) @ image.rgb_cam.T
    luma = np.clip(sample, 0.0, None) @ SRGB_LUMA
    p99 = float(np.percentile(luma, 99))
    if p99 <= 1e-6:
        return 0.0
    return float(np.clip(np.log2(1.0 / p99), 0.0, MAX_BASELINE_EV))


def _downscale(image: np.ndarray, max_side: int) -> np.ndarray:
    h, w = image.shape[:2]
    if max(h, w) <= max_side:
        return image
    factor = max_side / max(h, w)
    size = (max(1, round(w * factor)), max(1, round(h * factor)))
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


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

"""Statistical color transfer from a reference photo to a target photo in CIE Lab."""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np
from skimage import color

Method = Literal["reinhard", "histogram"]

FIT_MAX_SIDE = 1024
BACKGROUND_L_MAX = 10.0
SPECULAR_L_MIN = 97.0
TRIM_PERCENT = 2.0
QUANTILE_COUNT = 257
CHUNK_ROWS = 256
_STD_EPS = 1e-3
_LAB_MIN = np.array([0.0, -128.0, -128.0])
_LAB_MAX = np.array([100.0, 127.0, 127.0])

Triple = tuple[float, float, float]
Curve = tuple[tuple[float, ...], tuple[float, ...], tuple[float, ...]]


@dataclass(frozen=True)
class ColorTransform:
    """A fitted target-to-reference mapping that can be applied at any resolution.

    Fitting happens once on downscaled images; the same coefficients are then
    applied to the preview and to the full-resolution export so they match.
    """

    method: Method
    ref_mean: Triple
    ref_std: Triple
    tar_mean: Triple
    tar_std: Triple
    tar_quantiles: Curve
    ref_quantiles: Curve

    def map_lab(self, lab: np.ndarray) -> np.ndarray:
        if self.method == "reinhard":
            tar_mean = np.asarray(self.tar_mean)
            tar_std = np.asarray(self.tar_std)
            scale = np.where(tar_std > _STD_EPS, np.asarray(self.ref_std) / np.maximum(tar_std, _STD_EPS), 1.0)
            out = (lab - tar_mean) * scale + np.asarray(self.ref_mean)
        else:
            out = np.empty_like(lab)
            for ch in range(3):
                out[..., ch] = _interp_extrapolate(
                    lab[..., ch],
                    np.asarray(self.tar_quantiles[ch]),
                    np.asarray(self.ref_quantiles[ch]),
                )
        return np.clip(out, _LAB_MIN, _LAB_MAX)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    return color.rgb2lab(rgb)


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        return np.clip(color.lab2rgb(lab), 0.0, 1.0)


def downscale(image: np.ndarray, max_side: int) -> np.ndarray:
    h, w = image.shape[:2]
    longest = max(h, w)
    if longest <= max_side:
        return image
    factor = max_side / longest
    size = (max(1, round(w * factor)), max(1, round(h * factor)))
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


def fit_transform(
    reference: np.ndarray,
    target: np.ndarray,
    *,
    method: Method = "reinhard",
    exclude_extremes: bool = True,
) -> ColorTransform:
    """Fit a mapping that moves ``target`` colors toward ``reference``.

    With ``exclude_extremes`` near-black and specular pixels, plus the outer
    tails of the remaining L distribution, are left out of the statistics so
    black backgrounds and highlights on teeth do not skew tooth and gum tones.
    """
    ref_px = _fit_pixels(reference, exclude_extremes)
    tar_px = _fit_pixels(target, exclude_extremes)
    probs = np.linspace(0.0, 100.0, QUANTILE_COUNT)
    tar_q = np.percentile(tar_px, probs, axis=0).T
    ref_q = np.percentile(ref_px, probs, axis=0).T
    return ColorTransform(
        method=method,
        ref_mean=_triple(ref_px.mean(axis=0)),
        ref_std=_triple(ref_px.std(axis=0)),
        tar_mean=_triple(tar_px.mean(axis=0)),
        tar_std=_triple(tar_px.std(axis=0)),
        tar_quantiles=_curve(tar_q),
        ref_quantiles=_curve(ref_q),
    )


def apply_transform(target: np.ndarray, transform: ColorTransform, strength: float) -> np.ndarray:
    """Apply ``transform`` to ``target`` and blend with the original.

    ``strength`` is 0..1: 0 returns the original, 1 the fully matched image.
    Work is done in row chunks so full-resolution photos stay within memory.
    """
    strength = float(np.clip(strength, 0.0, 1.0))
    if strength == 0.0:
        return target.copy()
    out = np.empty_like(target)
    for start in range(0, target.shape[0], CHUNK_ROWS):
        chunk = target[start : start + CHUNK_ROWS]
        original = chunk.astype(np.float64) / 255.0
        matched = lab_to_rgb(transform.map_lab(rgb_to_lab(chunk)))
        blended = matched * strength + original * (1.0 - strength)
        out[start : start + CHUNK_ROWS] = np.round(blended * 255.0).astype(np.uint8)
    return out


def match_colors(
    reference: np.ndarray,
    target: np.ndarray,
    *,
    method: Method = "reinhard",
    strength: float = 1.0,
    exclude_extremes: bool = True,
) -> np.ndarray:
    transform = fit_transform(reference, target, method=method, exclude_extremes=exclude_extremes)
    return apply_transform(target, transform, strength)


def _fit_pixels(rgb: np.ndarray, exclude_extremes: bool) -> np.ndarray:
    lab = rgb_to_lab(downscale(rgb, FIT_MAX_SIDE)).reshape(-1, 3)
    if not exclude_extremes:
        return lab
    # Contrastor backgrounds can cover a third of the frame, so a percentile
    # cut alone is not enough; drop near-black and specular pixels outright.
    kept = lab[(lab[:, 0] > BACKGROUND_L_MAX) & (lab[:, 0] < SPECULAR_L_MIN)]
    if kept.shape[0] < 64:
        return lab
    lo, hi = np.percentile(kept[:, 0], [TRIM_PERCENT, 100.0 - TRIM_PERCENT])
    trimmed = kept[(kept[:, 0] >= lo) & (kept[:, 0] <= hi)]
    return trimmed if trimmed.shape[0] >= 64 else kept


def _interp_extrapolate(x: np.ndarray, xp: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """Piecewise-linear map; outside the fitted range values are shifted, not clamped.

    Clamping would flatten highlights that were excluded from the fit.
    """
    xp = xp + np.arange(xp.size) * 1e-9
    y = np.interp(x, xp, fp)
    below = x < xp[0]
    above = x > xp[-1]
    y[below] = fp[0] + (x[below] - xp[0])
    y[above] = fp[-1] + (x[above] - xp[-1])
    return y


def _triple(values: np.ndarray) -> Triple:
    return (float(values[0]), float(values[1]), float(values[2]))


def _curve(quantiles: np.ndarray) -> Curve:
    return tuple(tuple(float(v) for v in row) for row in quantiles)  # type: ignore[return-value]

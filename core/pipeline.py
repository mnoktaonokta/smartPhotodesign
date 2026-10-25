"""Full-resolution rendering shared by the download buttons.

Lives outside ``app.py`` because Streamlit re-executes the app script on every
interaction, which would reset a module-level cache defined there.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from PIL import Image

from core.color_engine import ColorTransform, apply_transform
from core.image_composer import CompositionSettings, compose
from core.image_loader import WhiteBalance, load_logo, load_photo


@dataclass(frozen=True)
class Upload:
    name: str
    data: bytes


@dataclass(frozen=True)
class RenderRequest:
    before: Upload
    after: Upload
    logo: Upload | None
    white_balance: WhiteBalance
    transform: ColorTransform
    strength: float
    composition: CompositionSettings


@dataclass(frozen=True)
class RenderResult:
    composite: Image.Image
    matched_after: Image.Image


@lru_cache(maxsize=1)
def render_full_resolution(request: RenderRequest) -> RenderResult:
    before = load_photo(request.before.data, request.before.name, white_balance=request.white_balance)
    after = load_photo(request.after.data, request.after.name, white_balance=request.white_balance)
    matched = apply_transform(after, request.transform, request.strength)
    del after
    logo = load_logo(request.logo.data) if request.logo else None
    composite = compose(before, matched, request.composition, logo)
    return RenderResult(composite=composite, matched_after=Image.fromarray(np.ascontiguousarray(matched)))

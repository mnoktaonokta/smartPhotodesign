import io

import numpy as np
import pytest
from PIL import Image

from core.image_composer import (
    CompositionSettings,
    LabelStyle,
    LogoStyle,
    canvas_size,
    compose,
    fit_to_panel,
    to_jpeg_bytes,
    to_png_bytes,
    to_tiff_bytes,
)


def _solid(h: int, w: int, rgb: tuple[int, int, int]) -> np.ndarray:
    img = np.empty((h, w, 3), dtype=np.uint8)
    img[:] = rgb
    return img


@pytest.mark.parametrize(
    ("layout", "aspect", "ratio"),
    [
        ("side_by_side", "4:5", 4 / 5),
        ("side_by_side", "1:1", 1.0),
        ("stacked", "9:16", 9 / 16),
        ("stacked", "4:5", 4 / 5),
    ],
)
def test_canvas_matches_requested_aspect(layout, aspect, ratio):
    before = _solid(800, 1200, (200, 0, 0))
    after = _solid(900, 1200, (0, 200, 0))
    settings = CompositionSettings(layout=layout, aspect=aspect)
    width, height = canvas_size(before, after, settings)
    assert width / height == pytest.approx(ratio, abs=0.01)
    image = compose(before, after, settings)
    assert image.size == (width, height)
    assert image.mode == "RGB"


def test_original_aspect_side_by_side_doubles_width():
    before = _solid(600, 900, (10, 10, 10))
    settings = CompositionSettings(layout="side_by_side", aspect="original")
    width, height = canvas_size(before, before, settings)
    assert width / height == pytest.approx(3.0, abs=0.01)


def test_canvas_is_capped():
    big = _solid(4000, 6000, (0, 0, 0))
    width, height = canvas_size(big, big, CompositionSettings(aspect="original"), max_side=3000)
    assert max(width, height) == 3000


def test_before_left_after_right():
    before = _solid(400, 400, (255, 0, 0))
    after = _solid(400, 400, (0, 0, 255))
    settings = CompositionSettings(aspect="original", fit="crop", labels=LabelStyle(enabled=False))
    image = np.asarray(compose(before, after, settings))
    h, w = image.shape[:2]
    assert tuple(image[h // 2, w // 4]) == (255, 0, 0)
    assert tuple(image[h // 2, 3 * w // 4]) == (0, 0, 255)


def test_pad_fit_keeps_whole_image_and_fills_background():
    panel = fit_to_panel(_solid(100, 200, (50, 60, 70)), 200, 200, "pad", (255, 255, 255))
    assert panel.shape == (200, 200, 3)
    assert tuple(panel[0, 0]) == (255, 255, 255)
    assert tuple(panel[100, 100]) == (50, 60, 70)


def test_crop_fit_fills_panel():
    panel = fit_to_panel(_solid(100, 200, (50, 60, 70)), 200, 200, "crop", (255, 255, 255))
    assert panel.shape == (200, 200, 3)
    assert tuple(panel[0, 0]) == (50, 60, 70)


@pytest.mark.parametrize("position", ["divider", "bottom_right", "top_right"])
def test_logo_alpha_and_opacity_are_respected(position):
    photo = _solid(500, 500, (0, 0, 0))
    logo = Image.new("RGBA", (100, 50), (255, 255, 255, 0))
    logo.paste((255, 255, 255, 255), (25, 0, 75, 50))
    settings = CompositionSettings(
        aspect="original",
        labels=LabelStyle(enabled=False),
        logo=LogoStyle(position=position, width_percent=20, opacity=0.5),
        divider_percent=0,
    )
    image = np.asarray(compose(photo, photo, settings, logo))
    peak = image.max()
    assert 110 <= peak <= 145
    assert image.min() == 0


def test_labels_are_drawn():
    photo = _solid(400, 400, (0, 0, 0))
    plain = compose(photo, photo, CompositionSettings(aspect="original", labels=LabelStyle(enabled=False)))
    labeled = compose(photo, photo, CompositionSettings(aspect="original"))
    assert np.asarray(labeled).sum() > np.asarray(plain).sum()


def test_exports_round_trip():
    image = Image.fromarray(_solid(64, 96, (12, 34, 56)))
    for encoded, fmt in ((to_png_bytes(image), "PNG"), (to_jpeg_bytes(image), "JPEG"), (to_tiff_bytes(image), "TIFF")):
        with Image.open(io.BytesIO(encoded)) as decoded:
            assert decoded.format == fmt
            assert decoded.size == (96, 64)

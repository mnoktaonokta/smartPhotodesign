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
    divider_width,
    fit_to_panel,
    resolve_layout,
    slider_frames,
    to_jpeg_bytes,
    to_png_bytes,
    to_tiff_bytes,
    video_size,
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


@pytest.mark.parametrize(
    ("shape", "aspect", "expected"),
    [
        ((2000, 3000), "4:5", "stacked"),
        ((2000, 3000), "9:16", "stacked"),
        ((2000, 3000), "1:1", "stacked"),
        ((3000, 2000), "1:1", "side_by_side"),
        ((3000, 2000), "4:5", "side_by_side"),
        ((2000, 3000), "original", "stacked"),
        ((3000, 2000), "original", "side_by_side"),
    ],
)
def test_resolve_layout_picks_least_padding(shape, aspect, expected):
    assert resolve_layout(_solid(*shape, (0, 0, 0)), aspect) == expected


def test_labels_sit_on_the_photo_not_the_padding():
    landscape = _solid(200, 600, (0, 0, 0))
    settings = CompositionSettings(
        layout="side_by_side",
        aspect="1:1",
        fit="pad",
        background=(255, 255, 255),
        labels=LabelStyle(text_color=(255, 0, 0), background_opacity=0),
        divider_percent=0,
    )
    image = np.asarray(compose(landscape, landscape, settings))
    red = (image[..., 0] > 200) & (image[..., 1] < 80)
    rows = np.nonzero(red.any(axis=1))[0]
    photo_rows = np.nonzero((image[:, image.shape[1] // 4] < 50).all(axis=1))[0]
    assert rows.size and photo_rows.size
    assert photo_rows.min() <= rows.min() and rows.max() <= photo_rows.max()


def test_padded_photos_meet_at_the_divider():
    landscape = _solid(200, 600, (0, 0, 0))
    settings = CompositionSettings(
        layout="stacked", aspect="9:16", fit="pad", background=(255, 255, 255), labels=LabelStyle(enabled=False)
    )
    image = np.asarray(compose(landscape, landscape, settings))
    dark_rows = np.nonzero((image[:, image.shape[1] // 2] < 50).all(axis=1))[0]
    gap = divider_width(image.shape[1], image.shape[0], settings)
    middle = image.shape[0] // 2
    assert dark_rows.min() > 0 and dark_rows.max() < image.shape[0] - 1
    assert np.any(np.abs(dark_rows - middle) <= gap)


@pytest.mark.parametrize(
    ("aspect", "size"),
    [("4:5", (1080, 1350)), ("9:16", (1080, 1920)), ("1:1", (1080, 1080)), ("original", (1080, 720))],
)
def test_video_size_is_instagram_friendly(aspect, size):
    assert video_size(_solid(400, 600, (0, 0, 0)), aspect) == size


def test_slider_frames_label_sides_and_shared_logo():
    photo = _solid(400, 600, (0, 0, 0))
    settings = CompositionSettings(
        aspect="4:5",
        fit="crop",
        labels=LabelStyle(text_color=(255, 0, 0), background_opacity=0),
        logo=LogoStyle(position="divider", width_percent=20, opacity=1),
    )
    logo = Image.new("RGBA", (100, 50), (0, 255, 0, 255))
    before, after = (np.asarray(f) for f in slider_frames(photo, photo, settings, logo))
    assert before.shape == after.shape == (1350, 1080, 3)

    def red_columns(image):
        return np.nonzero(((image[..., 0] > 200) & (image[..., 1] < 80)).any(axis=0))[0]

    assert red_columns(before).max() < 540 < red_columns(after).min()
    green = (before[..., 1] > 200) & (before[..., 0] < 80)
    rows = np.nonzero(green.any(axis=1))[0]
    assert rows.min() > 1350 * 0.6
    np.testing.assert_array_equal(green, (after[..., 1] > 200) & (after[..., 0] < 80))


def test_logo_can_be_wide():
    photo = _solid(400, 600, (0, 0, 0))
    settings = CompositionSettings(
        aspect="4:5", fit="crop", labels=LabelStyle(enabled=False), logo=LogoStyle(position="bottom_right", width_percent=60, opacity=1)
    )
    logo = Image.new("RGBA", (300, 100), (0, 255, 0, 255))
    frame = np.asarray(slider_frames(photo, photo, settings, logo)[0])
    columns = np.nonzero(((frame[..., 1] > 200) & (frame[..., 0] < 80)).any(axis=0))[0]
    assert columns.size == pytest.approx(1080 * 0.6, abs=2)


def test_exports_round_trip():
    image = Image.fromarray(_solid(64, 96, (12, 34, 56)))
    for encoded, fmt in ((to_png_bytes(image), "PNG"), (to_jpeg_bytes(image), "JPEG"), (to_tiff_bytes(image), "TIFF")):
        with Image.open(io.BytesIO(encoded)) as decoded:
            assert decoded.format == fmt
            assert decoded.size == (96, 64)

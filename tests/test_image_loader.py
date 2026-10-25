import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from core.image_loader import (
    ImageLoadError,
    full_size,
    is_raw,
    load_linear,
    load_logo,
    rgb_cam_from_cam_xyz,
    srgb_to_linear,
)

SAMPLE_NEF = Path("/tmp/samples/sample.nef")


def _encode(image: Image.Image, fmt: str, **kwargs) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def test_png_loads_as_linear_srgb():
    data = _encode(Image.new("RGB", (30, 20), (128, 64, 255)), "PNG")
    image = load_linear(data, "foto.PNG")
    assert image.kind == "srgb"
    assert not image.is_raw
    assert image.pixels.shape == (20, 30, 3)
    assert image.pixels.dtype == np.float32
    expected = srgb_to_linear(np.array([128, 64, 255], dtype=np.float32) / 255)
    np.testing.assert_allclose(image.pixels[0, 0], expected, atol=1e-5)
    np.testing.assert_array_equal(image.rgb_cam, np.eye(3))


def test_max_side_downscales():
    data = _encode(Image.new("RGB", (400, 100), (10, 10, 10)), "PNG")
    assert load_linear(data, "x.png", max_side=200).pixels.shape[:2] == (50, 200)


def test_transparent_photo_is_flattened_on_white():
    data = _encode(Image.new("RGBA", (4, 4), (0, 0, 0, 0)), "PNG")
    np.testing.assert_allclose(load_linear(data, "x.png").pixels[0, 0], 1.0, atol=1e-6)


def test_exif_orientation_is_applied_and_reported():
    image = Image.new("RGB", (40, 10), (0, 0, 0))
    exif = image.getexif()
    exif[0x0112] = 6
    data = _encode(image, "JPEG", exif=exif)
    assert load_linear(data, "x.jpg").pixels.shape[:2] == (40, 10)
    assert full_size(data, "x.jpg") == (10, 40)


def test_rgb_cam_maps_white_balanced_neutral_to_white():
    cam_xyz = np.array([[0.902, -0.289, -0.0715], [-0.4535, 1.2436, 0.2348], [-0.0934, 0.1919, 0.7086]])
    np.testing.assert_allclose(rgb_cam_from_cam_xyz(cam_xyz) @ np.ones(3), np.ones(3), atol=1e-9)


def test_logo_keeps_alpha():
    logo = load_logo(_encode(Image.new("RGBA", (8, 8), (255, 0, 0, 100)), "PNG"))
    assert logo.mode == "RGBA"
    assert logo.getpixel((0, 0))[3] == 100


def test_unsupported_extension_is_rejected():
    with pytest.raises(ImageLoadError):
        load_linear(b"", "notlar.pdf")


def test_corrupt_files_raise_load_error():
    with pytest.raises(ImageLoadError):
        load_linear(b"not an image", "x.jpg")
    with pytest.raises(ImageLoadError):
        load_linear(b"not a raw file", "x.nef")


def test_raw_detection_is_case_insensitive():
    assert is_raw("IMG_0001.CR2")
    assert is_raw("a.dng")
    assert not is_raw("a.jpg")


@pytest.mark.skipif(not SAMPLE_NEF.exists(), reason="sample RAW not downloaded")
def test_raw_decodes_to_camera_space_matching_libraw():
    import rawpy

    data = SAMPLE_NEF.read_bytes()
    image = load_linear(data, SAMPLE_NEF.name, half_size=True)
    assert image.kind == "camera" and image.is_raw
    assert 0 < image.baseline_ev <= 2.5
    gains = image.as_shot / image.as_shot.min()
    mine = np.clip(np.clip(image.pixels * gains, 0, 1) @ image.rgb_cam.T, 0, 1)
    with rawpy.imread(io.BytesIO(data)) as raw:
        ref = raw.postprocess(
            use_camera_wb=True,
            output_color=rawpy.ColorSpace.sRGB,
            gamma=(1, 1),
            no_auto_bright=True,
            output_bps=16,
            half_size=True,
        )
    np.testing.assert_allclose(mine, ref / 65535.0, atol=2e-3)
    assert full_size(data, SAMPLE_NEF.name) == (6032, 4032)

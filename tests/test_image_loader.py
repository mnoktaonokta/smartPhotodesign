import io

import numpy as np
import pytest
from PIL import Image

from core.image_loader import ImageLoadError, is_raw, load_logo, load_photo


def _encode(image: Image.Image, fmt: str) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format=fmt)
    return buf.getvalue()


def test_png_loads_as_rgb_uint8():
    data = _encode(Image.new("RGB", (30, 20), (10, 20, 30)), "PNG")
    array = load_photo(data, "foto.PNG")
    assert array.shape == (20, 30, 3)
    assert array.dtype == np.uint8
    assert tuple(array[0, 0]) == (10, 20, 30)


def test_transparent_photo_is_flattened_on_white():
    data = _encode(Image.new("RGBA", (4, 4), (0, 0, 0, 0)), "PNG")
    assert tuple(load_photo(data, "x.png")[0, 0]) == (255, 255, 255)


def test_exif_orientation_is_applied():
    image = Image.new("RGB", (40, 10), (0, 0, 0))
    exif = image.getexif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    image.save(buf, format="JPEG", exif=exif)
    assert load_photo(buf.getvalue(), "x.jpg").shape[:2] == (40, 10)


def test_logo_keeps_alpha():
    logo = load_logo(_encode(Image.new("RGBA", (8, 8), (255, 0, 0, 100)), "PNG"))
    assert logo.mode == "RGBA"
    assert logo.getpixel((0, 0))[3] == 100


def test_unsupported_extension_is_rejected():
    with pytest.raises(ImageLoadError):
        load_photo(b"", "notlar.pdf")


def test_corrupt_files_raise_load_error():
    with pytest.raises(ImageLoadError):
        load_photo(b"not an image", "x.jpg")
    with pytest.raises(ImageLoadError):
        load_photo(b"not a raw file", "x.nef")


def test_raw_detection_is_case_insensitive():
    assert is_raw("IMG_0001.CR2")
    assert is_raw("a.dng")
    assert not is_raw("a.jpg")

import io
import json
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from smartphoto.server import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(allowed_hosts=["testserver"]))


def _png(color=(200, 100, 50), size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _pack(header: dict, parts: dict[str, tuple[bytes, dict]]) -> bytes:
    payload = b""
    for key, (data, meta) in parts.items():
        header[key] = {**meta, "offset": len(payload), "length": len(data)}
        payload += data
    head = json.dumps(header).encode()
    return struct.pack("<I", len(head)) + head + payload


def _rgba(w: int, h: int, rgb) -> bytes:
    arr = np.empty((h, w, 4), dtype=np.uint8)
    arr[..., :3] = rgb
    arr[..., 3] = 255
    return arr.tobytes()


def test_upload_returns_metadata_and_pixels(client):
    meta = client.post("/api/images", params={"name": "a.png"}, content=_png()).json()
    assert meta["kind"] == "srgb"
    assert (meta["width"], meta["height"]) == (64, 48)
    assert (meta["fullWidth"], meta["fullHeight"]) == (64, 48)

    response = client.get(f"/api/images/{meta['id']}/pixels")
    assert response.headers["X-Width"] == "64"
    pixels = np.frombuffer(response.content, dtype="<f2").reshape(48, 64, 3)
    assert pixels[0, 0, 0] == pytest.approx(0.578, abs=0.01)


def test_upload_rejects_unknown_type_and_corrupt_file(client):
    assert client.post("/api/images", params={"name": "a.pdf"}, content=b"x").status_code == 400
    response = client.post("/api/images", params={"name": "a.jpg"}, content=b"bozuk")
    assert response.status_code == 400
    assert "okunamadı" in response.json()["detail"]


def test_unknown_image_is_404(client):
    assert client.get("/api/images/yok/pixels").status_code == 404


def test_compose_returns_requested_format(client):
    body = _pack(
        {"format": "png", "settings": {"layout": "auto", "aspect": "4:5", "logo": {"position": "bottom_right"}}},
        {
            "before": (_rgba(300, 200, (255, 0, 0)), {"width": 300, "height": 200}),
            "after": (_rgba(300, 200, (0, 0, 255)), {"width": 300, "height": 200}),
            "logo": (_png((255, 255, 255), (40, 20)), {}),
        },
    )
    response = client.post("/api/compose", content=body)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["X-Layout"] == "stacked"
    with Image.open(io.BytesIO(response.content)) as img:
        assert img.width / img.height == pytest.approx(0.8, abs=0.01)


def test_compose_rejects_size_mismatch(client):
    body = _pack(
        {"format": "png", "settings": {}},
        {
            "before": (_rgba(10, 10, (0, 0, 0)), {"width": 11, "height": 10}),
            "after": (_rgba(10, 10, (0, 0, 0)), {"width": 10, "height": 10}),
        },
    )
    assert client.post("/api/compose", content=body).status_code == 400


def test_compose_single_image_and_16x9(client):
    body = _pack(
        {
            "format": "png",
            "settings": {
                "aspect": "16:9",
                "fit": "crop",
                "showDivider": False,
                "labels": {"enabled": False, "font": "sans_bold"},
                "vignette": {"mode": "canvas", "amount": 0.3},
            },
        },
        {"before": (_rgba(320, 180, (255, 0, 0)), {"width": 320, "height": 180})},
    )
    response = client.post("/api/compose", content=body)
    assert response.status_code == 200
    assert response.headers["X-Layout"] == "single"
    with Image.open(io.BytesIO(response.content)) as img:
        assert img.width / img.height == pytest.approx(16 / 9, abs=0.02)


def test_slider_frames_stack_before_over_after(client):
    body = _pack(
        {"settings": {"aspect": "9:16", "fit": "crop", "labels": {"enabled": False}}},
        {
            "before": (_rgba(300, 200, (255, 0, 0)), {"width": 300, "height": 200}),
            "after": (_rgba(300, 200, (0, 0, 255)), {"width": 300, "height": 200}),
        },
    )
    response = client.post("/api/slider-frames", content=body)
    assert response.status_code == 200
    assert response.headers["X-Size"] == "1080x1920"
    assert response.headers["X-Content"] == "0,0,1080,1920"
    with Image.open(io.BytesIO(response.content)) as img:
        assert img.size == (1080, 3840)
        assert img.getpixel((540, 960)) == (255, 0, 0)
        assert img.getpixel((540, 2880)) == (0, 0, 255)


def test_encode_tiff(client):
    body = _pack({"format": "tiff"}, {"image": (_rgba(20, 10, (1, 2, 3)), {"width": 20, "height": 10})})
    response = client.post("/api/encode", content=body)
    with Image.open(io.BytesIO(response.content)) as img:
        assert img.format == "TIFF"
        assert img.getpixel((0, 0)) == (1, 2, 3)


def test_foreign_host_is_rejected():
    client = TestClient(create_app(), base_url="http://evil.example")
    assert client.get("/").status_code == 400

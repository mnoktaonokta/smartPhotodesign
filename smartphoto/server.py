"""Local HTTP API: decodes photos for the browser editor and builds the final files.

Everything stays in memory. Request bodies are read whole instead of through
multipart parsing, which would spool large uploads to temporary files on disk.
"""

from __future__ import annotations

import json
import struct
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image

from core.image_composer import (
    ASPECT_VALUES,
    CompositionSettings,
    LabelStyle,
    LogoStyle,
    compose,
    content_box,
    resolve_layout,
    slider_frames,
    to_jpeg_bytes,
    to_png_bytes,
    to_tiff_bytes,
    video_size,
)
from core.image_loader import (
    PHOTO_EXTENSIONS,
    ImageLoadError,
    LinearImage,
    full_size,
    load_linear,
    load_logo,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
PREVIEW_MAX_SIDE = 3200
SHARE_PREVIEW_MAX_SIDE = 1400
MAX_STORED_IMAGES = 6
MIN_LOGO_PERCENT = 5.0
MAX_LOGO_PERCENT = 60.0
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

MIME_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "tiff": "image/tiff", "preview": "image/jpeg"}


@dataclass
class StoredImage:
    name: str
    data: bytes
    preview: LinearImage


class ImageStore:
    """Bounded in-memory store of uploaded files and their editing previews."""

    def __init__(self, capacity: int = MAX_STORED_IMAGES) -> None:
        self._items: OrderedDict[str, StoredImage] = OrderedDict()
        self._capacity = capacity
        self._lock = threading.Lock()

    def add(self, item: StoredImage) -> str:
        key = uuid.uuid4().hex
        with self._lock:
            self._items[key] = item
            while len(self._items) > self._capacity:
                self._items.popitem(last=False)
        return key

    def get(self, key: str) -> StoredImage:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                raise HTTPException(404, "Fotoğraf bulunamadı. Lütfen yeniden yükleyin.")
            self._items.move_to_end(key)
            return item


def create_app(allowed_hosts: list[str] | None = None) -> FastAPI:
    app = FastAPI(title="Smart Photo Design", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts or ALLOWED_HOSTS)
    store = ImageStore()

    @app.post("/api/images")
    async def upload_image(request: Request, name: str) -> dict[str, Any]:
        body = await request.body()
        return await run_in_threadpool(_register_upload, store, name, body)

    @app.get("/api/images/{key}/pixels")
    async def image_pixels(key: str, full: bool = False, max_side: int | None = None) -> Response:
        item = store.get(key)
        return await run_in_threadpool(_pixels_response, item, full, max_side)

    @app.post("/api/compose")
    async def compose_endpoint(request: Request) -> Response:
        body = await request.body()
        return await run_in_threadpool(_compose_response, body)

    @app.post("/api/encode")
    async def encode_endpoint(request: Request) -> Response:
        body = await request.body()
        return await run_in_threadpool(_encode_response, body)

    @app.post("/api/slider-frames")
    async def slider_frames_endpoint(request: Request) -> Response:
        body = await request.body()
        return await run_in_threadpool(_slider_frames_response, body)

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


def _register_upload(store: ImageStore, name: str, body: bytes) -> dict[str, Any]:
    if Path(name).suffix.lower() not in PHOTO_EXTENSIONS:
        raise HTTPException(400, f"Desteklenmeyen dosya türü: {Path(name).suffix or name}")
    try:
        preview = load_linear(body, name, half_size=True, max_side=PREVIEW_MAX_SIDE)
        full_width, full_height = full_size(body, name)
    except ImageLoadError as exc:
        raise HTTPException(400, str(exc)) from exc
    key = store.add(StoredImage(name=name, data=body, preview=preview))
    return {
        "id": key,
        "name": name,
        "kind": preview.kind,
        "isRaw": preview.is_raw,
        "width": preview.width,
        "height": preview.height,
        "fullWidth": full_width,
        "fullHeight": full_height,
        "camXyz": preview.cam_xyz.tolist() if preview.cam_xyz is not None else None,
        "rgbCam": preview.rgb_cam.tolist(),
        "asShot": preview.as_shot.tolist(),
        "baselineEv": preview.baseline_ev,
    }


def _pixels_response(item: StoredImage, full: bool, max_side: int | None) -> Response:
    if full:
        try:
            image = load_linear(item.data, item.name, max_side=max_side)
        except ImageLoadError as exc:
            raise HTTPException(400, str(exc)) from exc
    else:
        image = item.preview
    pixels = np.ascontiguousarray(image.pixels, dtype="<f2")
    return Response(
        content=pixels.tobytes(),
        media_type="application/octet-stream",
        headers={"X-Width": str(image.width), "X-Height": str(image.height)},
    )


def _compose_response(body: bytes) -> Response:
    header, payload = _unpack(body)
    before = _rgba_part(header, payload, "before")
    after = _rgba_part(header, payload, "after")
    logo = _logo_part(header, payload)
    settings = composition_from_json(header.get("settings", {}), before)
    fmt = header.get("format", "preview")
    if fmt == "preview":
        image = compose(before, after, settings, logo, max_side=SHARE_PREVIEW_MAX_SIDE)
    else:
        image = compose(before, after, settings, logo)
    response = _encode(image, fmt)
    response.headers["X-Layout"] = settings.layout
    response.headers["X-Size"] = f"{image.width}x{image.height}"
    return response


def _slider_frames_response(body: bytes) -> Response:
    """Before and After video frames as one PNG, Before on top."""
    header, payload = _unpack(body)
    before = _rgba_part(header, payload, "before")
    after = _rgba_part(header, payload, "after")
    logo = _logo_part(header, payload)
    settings = composition_from_json(header.get("settings", {}), before)
    size = video_size(before, settings.aspect)
    first, second = slider_frames(before, after, settings, logo, size)
    sheet = Image.new("RGB", (first.width, first.height * 2))
    sheet.paste(first, (0, 0))
    sheet.paste(second, (0, first.height))
    response = Response(content=to_png_bytes(sheet, compress_level=1), media_type=MIME_TYPES["png"])
    response.headers["X-Size"] = f"{first.width}x{first.height}"
    response.headers["X-Content"] = ",".join(str(v) for v in content_box(before, *size, settings.fit))
    return response


def _logo_part(header: dict[str, Any], payload: memoryview) -> Image.Image | None:
    if not header.get("logo"):
        return None
    try:
        return load_logo(_slice(payload, header["logo"]))
    except ImageLoadError as exc:
        raise HTTPException(400, str(exc)) from exc


def _encode_response(body: bytes) -> Response:
    header, payload = _unpack(body)
    image = Image.fromarray(_rgba_part(header, payload, "image"))
    return _encode(image, header.get("format", "jpeg"))


def composition_from_json(data: dict[str, Any], before: np.ndarray) -> CompositionSettings:
    aspect = data.get("aspect", "4:5")
    if aspect not in (*ASPECT_VALUES, "original"):
        raise HTTPException(400, "Geçersiz en-boy oranı.")
    layout = data.get("layout", "auto")
    if layout == "auto":
        layout = resolve_layout(before, aspect)
    if layout not in ("side_by_side", "stacked"):
        raise HTTPException(400, "Geçersiz düzen.")
    fit = data.get("fit", "pad")
    if fit not in ("pad", "crop"):
        raise HTTPException(400, "Geçersiz sığdırma.")
    labels = data.get("labels", {})
    logo = data.get("logo", {})
    position = logo.get("position", "divider")
    if position not in ("divider", "bottom_right", "top_right"):
        raise HTTPException(400, "Geçersiz logo konumu.")
    return CompositionSettings(
        layout=layout,
        aspect=aspect,
        fit=fit,
        background=_hex(data.get("background", "#FFFFFF")),
        labels=LabelStyle(
            enabled=bool(labels.get("enabled", True)),
            before_text=str(labels.get("beforeText", "BEFORE"))[:40],
            after_text=str(labels.get("afterText", "AFTER"))[:40],
            size_percent=float(np.clip(labels.get("sizePercent", 4.0), 1.0, 12.0)),
            text_color=_hex(labels.get("textColor", "#FFFFFF")),
            background_opacity=float(np.clip(labels.get("backgroundOpacity", 0.45), 0.0, 1.0)),
        ),
        logo=LogoStyle(
            position=position,
            width_percent=float(np.clip(logo.get("widthPercent", 18.0), MIN_LOGO_PERCENT, MAX_LOGO_PERCENT)),
            opacity=float(np.clip(logo.get("opacity", 0.9), 0.0, 1.0)),
        ),
    )


def _unpack(body: bytes) -> tuple[dict[str, Any], memoryview]:
    """Split ``[uint32 header length][JSON header][binary payload]``."""
    if len(body) < 4:
        raise HTTPException(400, "Eksik istek.")
    (length,) = struct.unpack_from("<I", body, 0)
    try:
        header = json.loads(body[4 : 4 + length])
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(400, "Geçersiz istek başlığı.") from exc
    if not isinstance(header, dict):
        raise HTTPException(400, "Geçersiz istek başlığı.")
    return header, memoryview(body)[4 + length :]


def _slice(payload: memoryview, part: dict[str, Any]) -> bytes:
    offset, length = int(part["offset"]), int(part["length"])
    if offset < 0 or length < 0 or offset + length > len(payload):
        raise HTTPException(400, "Bozuk istek gövdesi.")
    return bytes(payload[offset : offset + length])


def _rgba_part(header: dict[str, Any], payload: memoryview, key: str) -> np.ndarray:
    part = header.get(key)
    if not part:
        raise HTTPException(400, f"Eksik görüntü: {key}")
    width, height = int(part["width"]), int(part["height"])
    raw = _slice(payload, part)
    if width <= 0 or height <= 0 or len(raw) != width * height * 4:
        raise HTTPException(400, f"Görüntü boyutu tutmuyor: {key}")
    return np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[..., :3].copy()


def _encode(image: Image.Image, fmt: str) -> Response:
    if fmt == "png":
        content = to_png_bytes(image)
    elif fmt == "jpeg":
        content = to_jpeg_bytes(image)
    elif fmt == "tiff":
        content = to_tiff_bytes(image)
    elif fmt == "preview":
        content = to_jpeg_bytes(image, quality=88)
    else:
        raise HTTPException(400, "Geçersiz dosya biçimi.")
    return Response(content=content, media_type=MIME_TYPES[fmt])


def _hex(value: str) -> tuple[int, int, int]:
    value = str(value).lstrip("#")
    if len(value) != 6:
        raise HTTPException(400, "Geçersiz renk.")
    try:
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    except ValueError as exc:
        raise HTTPException(400, "Geçersiz renk.") from exc


app = create_app()

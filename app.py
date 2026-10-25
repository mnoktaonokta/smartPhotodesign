"""Smart Photo Design: dental before/after color matching and composition."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
import streamlit as st
import streamlit.components.v1 as components
from PIL import Image

from core.color_engine import ColorTransform, Method, apply_transform, downscale, fit_transform
from core.image_composer import (
    CompositionSettings,
    LabelStyle,
    LogoStyle,
    compose,
    fit_to_panel,
    resolve_layout,
    to_jpeg_bytes,
    to_png_bytes,
    to_tiff_bytes,
)
from core.image_loader import (
    PHOTO_EXTENSIONS,
    ImageLoadError,
    WhiteBalance,
    is_raw,
    load_logo,
    load_photo,
)
from core.pipeline import RenderRequest, Upload, render_full_resolution
from ui.comparison_slider import comparison_slider_html

PREVIEW_MAX_SIDE = 1600
SLIDER_MAX_SIDE = 1200
SLIDER_HEIGHT = 620
UPLOAD_TYPES = sorted(ext.lstrip(".") for ext in PHOTO_EXTENSIONS)

METHOD_LABELS = {
    "reinhard": "Reinhard (önerilen)",
    "histogram": "Histogram eşleme",
}
WB_LABELS = {"camera": "Kamera ayarı", "auto": "Otomatik"}
LAYOUT_LABELS = {"auto": "Otomatik", "side_by_side": "Yan yana", "stacked": "Alt alta"}
ASPECT_LABELS = {
    "4:5": "4:5 Instagram gönderi",
    "1:1": "1:1 Kare",
    "9:16": "9:16 Story / Reels",
    "original": "Orijinal oran",
}
FIT_LABELS = {"pad": "Tamamını göster (dolgu)", "crop": "Kadrajı doldur (kırp)"}
LOGO_POSITION_LABELS = {
    "divider": "Ortada, ayraç üstünde",
    "bottom_right": "Sağ alt köşe",
    "top_right": "Sağ üst köşe",
}


@st.cache_data(max_entries=6, show_spinner=False)
def decode_preview(data: bytes, name: str, white_balance: WhiteBalance) -> np.ndarray:
    image = load_photo(data, name, white_balance=white_balance, half_size=is_raw(name))
    return downscale(image, PREVIEW_MAX_SIDE)


@st.cache_data(max_entries=8, show_spinner=False)
def fit_cached(reference: np.ndarray, target: np.ndarray, method: Method, exclude_extremes: bool) -> ColorTransform:
    return fit_transform(reference, target, method=method, exclude_extremes=exclude_extremes)


@st.cache_data(max_entries=8, show_spinner=False)
def apply_cached(target: np.ndarray, transform: ColorTransform, strength: float) -> np.ndarray:
    return apply_transform(target, transform, strength)


@st.cache_data(max_entries=4, show_spinner=False)
def logo_cached(data: bytes) -> Image.Image:
    return load_logo(data)


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def sidebar_settings() -> tuple[Method, float, bool, WhiteBalance, str, CompositionSettings]:
    with st.sidebar:
        st.header("Renk eşleştirme")
        method: Method = st.radio("Yöntem", list(METHOD_LABELS), format_func=METHOD_LABELS.get)
        strength = st.slider(
            "Eşleştirme gücü",
            0,
            100,
            80,
            format="%d%%",
            help="%0 orijinal after fotoğrafı, %100 referansa tam eşleşme.",
        )
        exclude = st.toggle(
            "Fon ve parlamaları hesaba katma",
            value=True,
            help="Siyah fon, çok koyu gölgeler ve diş üstündeki parlama noktaları istatistiğe "
            "girmez, böylece renkleri kaydırmaz.",
        )
        white_balance: WhiteBalance = st.selectbox(
            "RAW beyaz ayarı", list(WB_LABELS), format_func=WB_LABELS.get
        )

        st.header("Kadraj")
        layout = st.radio(
            "Düzen",
            list(LAYOUT_LABELS),
            format_func=LAYOUT_LABELS.get,
            horizontal=True,
            help="Otomatik, fotoğrafa en az boşluk bırakan düzeni seçer.",
        )
        aspect = st.selectbox("En-boy oranı", list(ASPECT_LABELS), format_func=ASPECT_LABELS.get)
        fit = st.radio("Sığdırma", list(FIT_LABELS), format_func=FIT_LABELS.get)
        background = st.color_picker("Dolgu ve ayraç rengi", "#FFFFFF")

        st.header("Yazılar")
        labels_on = st.toggle("BEFORE / AFTER yazısı", value=True)
        before_text = st.text_input("Before yazısı", "BEFORE", disabled=not labels_on)
        after_text = st.text_input("After yazısı", "AFTER", disabled=not labels_on)
        size = st.slider("Yazı boyutu", 2.0, 8.0, 4.0, 0.5, disabled=not labels_on)
        text_color = st.color_picker("Yazı rengi", "#FFFFFF", disabled=not labels_on)
        label_bg = st.slider("Yazı zemini opaklığı", 0, 100, 45, format="%d%%", disabled=not labels_on)

        st.header("Logo")
        position = st.radio("Konum", list(LOGO_POSITION_LABELS), format_func=LOGO_POSITION_LABELS.get)
        logo_width = st.slider("Logo genişliği", 10, 30, 18, format="%d%%", help="Toplam görsel genişliğine göre.")
        logo_opacity = st.slider("Logo opaklığı", 10, 100, 90, format="%d%%")

    composition = CompositionSettings(
        layout="side_by_side" if layout == "auto" else layout,
        aspect=aspect,
        fit=fit,
        background=hex_to_rgb(background),
        labels=LabelStyle(
            enabled=labels_on,
            before_text=before_text,
            after_text=after_text,
            size_percent=size,
            text_color=hex_to_rgb(text_color),
            background_opacity=label_bg / 100,
        ),
        logo=LogoStyle(position=position, width_percent=logo_width, opacity=logo_opacity / 100),
    )
    return method, strength / 100, exclude, white_balance, layout, composition


def main() -> None:
    st.set_page_config(page_title="Smart Photo Design", layout="wide")
    method, strength, exclude, white_balance, layout_choice, composition = sidebar_settings()

    st.title("Smart Photo Design")
    st.caption(
        "Klinik before/after fotoğrafları için renk eşleştirme ve paylaşım görseli. "
        "Fotoğraflar yalnız bu bilgisayarda işlenir."
    )

    col_before, col_after, col_logo = st.columns(3)
    before_file = col_before.file_uploader("Referans fotoğraf (Before)", type=UPLOAD_TYPES)
    after_file = col_after.file_uploader("Hedef fotoğraf (After)", type=UPLOAD_TYPES)
    logo_file = col_logo.file_uploader("Klinik logosu (şeffaf PNG)", type=["png"])

    if before_file is None or after_file is None:
        st.info("Başlamak için before ve after fotoğraflarını yükleyin. RAW (CR2, NEF, ARW, DNG) veya JPG/PNG olabilir.")
        return

    before_upload = Upload(before_file.name, before_file.getvalue())
    after_upload = Upload(after_file.name, after_file.getvalue())
    logo_upload = Upload(logo_file.name, logo_file.getvalue()) if logo_file else None

    try:
        with st.spinner("Fotoğraflar çözülüyor…", show_time=True):
            before = decode_preview(before_upload.data, before_upload.name, white_balance)
            after = decode_preview(after_upload.data, after_upload.name, white_balance)
        logo = logo_cached(logo_upload.data) if logo_upload else None
    except ImageLoadError as exc:
        st.error(str(exc))
        return

    with st.spinner("Renkler eşleştiriliyor…"):
        transform = fit_cached(before, after, method, exclude)
        matched = apply_cached(after, transform, strength)

    if layout_choice == "auto":
        composition = replace(composition, layout=resolve_layout(before, composition.aspect))

    tab_compare, tab_post = st.tabs(["Karşılaştırma", "Paylaşım görseli"])

    with tab_compare:
        slider_h, slider_w = downscale(before, SLIDER_MAX_SIDE).shape[:2]
        slider_after = fit_to_panel(matched, slider_w, slider_h, composition.fit, composition.background)
        slider_before = fit_to_panel(before, slider_w, slider_h, composition.fit, composition.background)
        components.html(
            comparison_slider_html(
                Image.fromarray(slider_before),
                Image.fromarray(slider_after),
                before_label=composition.labels.before_text or "BEFORE",
                after_label=composition.labels.after_text or "AFTER",
                max_height=SLIDER_HEIGHT,
            ),
            height=SLIDER_HEIGHT + 10,
        )
        st.caption("Çizgiyi sürükleyerek referans ile renk eşleştirilmiş after fotoğrafını karşılaştırın.")
        c1, c2, c3 = st.columns(3)
        c1.image(before, caption="Referans (Before)")
        c2.image(after, caption="After, orijinal")
        c3.image(matched, caption=f"After, eşleştirilmiş (%{round(strength * 100)})")

    with tab_post:
        preview = compose(before, matched, composition, logo, max_side=PREVIEW_MAX_SIDE)
        _, mid, _ = st.columns([1, 2, 1])
        note = f"{LAYOUT_LABELS[composition.layout]} düzen. " if layout_choice == "auto" else ""
        mid.image(preview, caption=f"{note}Önizleme; indirilen dosya tam çözünürlüktedir.")

    st.subheader("İndir")
    request = RenderRequest(
        before=before_upload,
        after=after_upload,
        logo=logo_upload,
        white_balance=white_balance,
        transform=transform,
        strength=strength,
        composition=composition,
    )
    stem = Path(after_upload.name).stem
    d1, d2, d3, d4 = st.columns(4)
    d1.download_button(
        "Paylaşım görseli · PNG",
        data=lambda: to_png_bytes(render_full_resolution(request).composite),
        file_name=f"{stem}_before_after.png",
        mime="image/png",
        on_click="ignore",
        type="primary",
    )
    d2.download_button(
        "Paylaşım görseli · JPEG",
        data=lambda: to_jpeg_bytes(render_full_resolution(request).composite),
        file_name=f"{stem}_before_after.jpg",
        mime="image/jpeg",
        on_click="ignore",
    )
    d3.download_button(
        "Eşleştirilmiş after · JPEG",
        data=lambda: to_jpeg_bytes(render_full_resolution(request).matched_after),
        file_name=f"{stem}_eslestirilmis.jpg",
        mime="image/jpeg",
        on_click="ignore",
    )
    d4.download_button(
        "Eşleştirilmiş after · TIFF",
        data=lambda: to_tiff_bytes(render_full_resolution(request).matched_after),
        file_name=f"{stem}_eslestirilmis.tif",
        mime="image/tiff",
        on_click="ignore",
    )
    st.caption(
        "Tam çözünürlüklü dosya düğmeye basınca hazırlanır; RAW fotoğraflarda birkaç saniye sürebilir. "
        "JPEG kalitesi %100’dür. Çıktı sosyal medya içindir, klinik teşhis kaydının yerine geçmez."
    )


main()

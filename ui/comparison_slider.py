"""Self-contained before/after drag slider rendered inside a Streamlit iframe.

Everything is inlined so the preview works offline and patient images never
leave the page or touch the disk.
"""

from __future__ import annotations

import base64
import html
import io

from PIL import Image

_TEMPLATE = """
<style>
  html, body {{ margin: 0; background: transparent; font-family: system-ui, sans-serif; }}
  .wrap {{ display: flex; justify-content: center; }}
  .cmp {{ position: relative; line-height: 0; user-select: none; touch-action: none; }}
  .cmp img {{ display: block; max-width: 100%; max-height: {max_height}px; width: auto; height: auto; }}
  .cmp img.after {{ position: absolute; inset: 0; width: 100%; height: 100%; clip-path: inset(0 0 0 50%); }}
  .line {{ position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px;
           background: #fff; pointer-events: none; }}
  .knob {{ position: absolute; top: 50%; left: 50%; width: 34px; height: 34px; margin: -17px 0 0 -17px;
           border-radius: 50%; background: #fff; border: 1px solid rgba(0,0,0,.25); pointer-events: none;
           display: flex; align-items: center; justify-content: center; color: #333; font-size: 14px;
           line-height: 1; }}
  .tag {{ position: absolute; top: 10px; padding: 4px 8px; border-radius: 4px; line-height: 1.2;
          background: rgba(0,0,0,.5); color: #fff; font-size: 12px; font-weight: 600; letter-spacing: .04em;
          pointer-events: none; }}
  input {{ position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0;
           cursor: ew-resize; }}
</style>
<div class="wrap">
  <div class="cmp" id="cmp">
    <img src="{before_src}" alt="{before_label}">
    <img class="after" src="{after_src}" alt="{after_label}">
    <div class="line"></div>
    <div class="knob">&#8596;</div>
    <span class="tag" style="left:10px">{before_label}</span>
    <span class="tag" style="right:10px">{after_label}</span>
    <input type="range" min="0" max="100" step="0.1" value="50" aria-label="Karşılaştırma çizgisi">
  </div>
</div>
<script>
  const root = document.getElementById("cmp");
  const after = root.querySelector("img.after");
  const line = root.querySelector(".line");
  const knob = root.querySelector(".knob");
  root.querySelector("input").addEventListener("input", (e) => {{
    const v = e.target.value;
    after.style.clipPath = `inset(0 0 0 ${{v}}%)`;
    line.style.left = `${{v}}%`;
    knob.style.left = `${{v}}%`;
  }});
</script>
"""


def comparison_slider_html(
    before: Image.Image,
    after: Image.Image,
    *,
    before_label: str = "BEFORE",
    after_label: str = "AFTER",
    max_height: int = 620,
) -> str:
    """Return HTML for a drag slider. ``before`` and ``after`` must share a size."""
    if before.size != after.size:
        raise ValueError("Karşılaştırılan görüntüler aynı boyutta olmalı.")
    return _TEMPLATE.format(
        before_src=_data_uri(before),
        after_src=_data_uri(after),
        before_label=html.escape(before_label),
        after_label=html.escape(after_label),
        max_height=max_height,
    )


def _data_uri(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

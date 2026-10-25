# Smart Photo Design

Klinik before/after fotoğrafları için yerel çalışan renk eşleştirme ve paylaşım görseli aracı.

Referans (before) ve hedef (after) fotoğrafı yüklenir. After fotoğrafının renk ve parlaklığı CIE Lab
uzayında referansa çekilir, yan yana veya alt alta bir sosyal medya görseli hazırlanır, BEFORE / AFTER
yazısı ve klinik logosu eklenir. Fotoğraflar yalnız bu bilgisayarın belleğinde işlenir; diske veya dış
bir servise gönderilmez.

## Kurulum

Python 3.10 veya üstü gerekir.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Çalıştırma

```bash
streamlit run app.py
```

Tarayıcıda `http://localhost:8501` açılır.

## Desteklenen dosyalar

- RAW: CR2, CR3, NEF, ARW, DNG, ORF, RW2, RAF (LibRaw ile)
- Standart: JPG, PNG
- Logo: şeffaf PNG

## Renk eşleştirme

- **Reinhard (önerilen):** after fotoğrafının L, a, b kanallarının ortalama ve standart sapması
  referansınkine eşitlenir. Global ve öngörülebilir bir düzeltmedir, dokuyu bozmaz.
- **Histogram eşleme:** kanal dağılımları bire bir eşlenir. Daha agresiftir.
- **Fon ve parlamaları hesaba katma:** siyah kontrastör fonu, çok koyu gölgeler ve diş üstündeki
  parlama noktaları istatistiğe girmez.
- **Eşleştirme gücü:** sonucu orijinal after ile karıştırır (%0 orijinal, %100 tam eşleşme).

Önizleme 1600 piksel üzerinden çalışır. İndirilen dosyalar aynı katsayılarla tam çözünürlükte üretilir.

Çıktılar sosyal medya içindir; klinik teşhis kaydının yerine geçmez.

## Geliştirme

```bash
pip install -r requirements-dev.txt
pytest
```

| Dosya | Görev |
| --- | --- |
| `app.py` | Streamlit arayüzü |
| `core/image_loader.py` | RAW ve JPG/PNG çözümleme |
| `core/color_engine.py` | Lab istatistikleri, Reinhard ve histogram eşleme |
| `core/image_composer.py` | Kadraj, yazı, logo ve dışa aktarma |
| `core/pipeline.py` | İndirmeler için tam çözünürlük üretimi |
| `ui/comparison_slider.py` | Çevrimdışı kayan karşılaştırma |

Etiket fontu DejaVu Sans Bold'dur (`assets/fonts/DejaVu-LICENSE.txt`).

# Smart Photo Design

Klinik before/after fotoğrafları için yerel çalışan, Lightroom benzeri düzenleme ve paylaşım görseli aracı.

Before fotoğrafı kadrajlanır ve ışık/renk ayarları yapılır. After fotoğrafı açılınca Before'un ayarları ve
kadrajı kopyalanır, ardından görünen alan analiz edilerek After Before'a eşleştirilir. Karşılaştırma
beğenilirse paylaşım görseli hazırlanır. Fotoğraflar yalnız bu bilgisayarın belleğinde işlenir; diske veya
dış bir servise gönderilmez.

Uygulama yerel bir Python sunucusu (yalnız `127.0.0.1`) ve tarayıcıda çalışan bir WebGL arayüzünden oluşur.
Windows ve macOS'ta aynı şekilde çalışır.

## Kurulum

Python 3.10 veya üstü gerekir.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Çalıştırma

```bash
python -m smartphoto
```

Tarayıcıda `http://127.0.0.1:8765` kendiliğinden açılır. Farklı bir port için `--port 9000`, tarayıcıyı
açmamak için `--no-browser` kullanılabilir. Chrome, Edge veya Safari'nin güncel sürümü önerilir.

## Akış

1. **Before:** Fotoğrafı açın (sürükle-bırak da olur).
   - **Kadraj:** oran, yakınlaştırma (fare tekerleği imlecin olduğu yere yaklaşır), açı ve 90° döndürme.
     Fotoğrafı sürükleyerek çerçeve içinde kaydırın.
   - **Işık:** pozlama, kontrast, parlak alanlar, gölgeler, beyazlar, siyahlar.
   - **Renk:** RAW'da Kelvin cinsinden sıcaklık ve renk tonu, JPEG'de göreli ölçek; canlılık, doygunluk.
   - **Hazır ayarlar:** "Diş odaklı (3900 K, gölgeler −100)" hazır gelir. Kendi ayarınızı kaydedebilirsiniz
     (tarayıcıda saklanır).
   - **Doğrusal maske:** fotoğraf üzerinde sürükleyerek çizilir. Etki düz çizgide tam, kesikli çizgide
     sıfırdır. Maskenin kendi pozlama, kontrast, parlak alan, gölge, sıcaklık, renk tonu ve doygunluk ayarı
     vardır. En fazla 8 maske.
2. **After:** Fotoğraf açılınca Before'un ışık/renk ayarları ve kadrajı kopyalanır, sonra otomatik eşleştirme
   yapılır. **Eşleştirme gücü** (%0 yalnız kopyalanan ayarlar, %100 tam eşleşme) ve tüm ayarlar elle
   değiştirilebilir. Kadrajı Before ile aynı bölgeye getirip **İlk fotoğrafla eşleştir**'e yeniden basın.
3. **Karşılaştır:** kaydırmalı veya yan yana görünüm.
4. **Paylaş:** otomatik, yan yana veya alt alta düzen; 4:5, 1:1, 9:16 veya orijinal oran; BEFORE / AFTER
   yazısı ve logo. Paylaşım görseli PNG/JPEG, tek fotoğraf JPEG/TIFF olarak tam çözünürlükte indirilir.
   **Kaydırmalı video** Instagram için MP4 üretir: önce Before görünür, ayraç kayıp After'ı gösterir,
   birkaç kez ileri geri gider ve After'da durur. 6, 8 veya 10 saniye; 1080 piksel genişlik, 30 kare/sn,
   H.264. Oran, sığdırma, yazılar ve logo paylaşım ayarlarından gelir (Reels için 9:16, gönderi için 4:5).
   Video tarayıcıda kodlanır; Chrome, Edge veya Safari'nin güncel sürümü gerekir.

Eşleştirme, iki fotoğrafın çerçevede görünen alanının Lab parlaklık dağılımını (koyu, orta, açık tonlar) ve
ortalama rengini ölçer; pozlama, parlak alanlar, gölgeler, sıcaklık ve renk tonu ayarlarını bunlar örtüşene
kadar ayarlar. Siyah kontrastör fonu ve parlama noktaları hesaba katılmaz. Sonuç gerçek kaydırıcı
değerleridir, bu yüzden üzerine elle ince ayar yapılabilir.

Çıktılar sosyal medya içindir; klinik teşhis kaydının yerine geçmez.

## Desteklenen dosyalar

- RAW: CR2, CR3, NEF, ARW, DNG, ORF, RW2, RAF (LibRaw ile, doğrusal kamera verisi üzerinden)
- Standart: JPG, PNG
- Logo: şeffaf PNG

## Geliştirme

```bash
pip install -r requirements-dev.txt
pytest
node --test tests/js/*.test.mjs
```

| Dosya | Görev |
| --- | --- |
| `smartphoto/server.py` | Yerel FastAPI sunucusu: çözümleme, paylaşım görseli, kodlama |
| `core/image_loader.py` | RAW'ı doğrusal kamera uzayında, JPG/PNG'yi doğrusal sRGB olarak açma |
| `core/image_composer.py` | Düzen, yazı, logo ve dosya kodlama |
| `web/js/main.js` | Arayüz durumu, paneller, fare etkileşimi, dışa aktarma |
| `web/js/shaders.js`, `renderer.js` | WebGL2 işleme hattı (beyaz dengesi, ton, maskeler) |
| `web/js/color.js` | Kelvin/renk tonu ve beyaz dengesi hesapları |
| `web/js/geometry.js` | Kadraj, döndürme, yakınlaştırma ve kaydırma |
| `web/js/match.js` | Fotoğraf ölçümü ve ayar eşleştirme çözücüsü |
| `web/js/slider-video.js` | Kaydırmalı video zaman çizelgesi ve MP4 kodlama |

Etiket fontu DejaVu Sans Bold'dur (`assets/fonts/DejaVu-LICENSE.txt`). MP4 paketleme için
[mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 projeye kopyalanmıştır (`web/vendor/`, MIT lisansı).

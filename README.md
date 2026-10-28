# Smart Photo Design

Klinik before/after fotoğrafları için yerel çalışan, Lightroom benzeri düzenleme ve paylaşım görseli aracı.

Açılışta Before ve After yan yana görünür. Soldaki çerçeveye Before, sağdakine After yüklenir; tıklayarak
aktif fotoğraf seçilir ve aynı ekranda düzenlenir. Düzen bitince Paylaş sekmesine geçilir. Fotoğraflar yalnız
bu bilgisayarın belleğinde işlenir; diske veya dış bir servise gönderilmez.

Uygulama yerel bir Python sunucusu (yalnız `127.0.0.1`) ve tarayıcıda çalışan bir WebGL arayüzünden oluşur.
Windows ve macOS'ta aynı şekilde çalışır.

## Kurulum

### Çift tıklayarak (önerilen)

1. [python.org](https://www.python.org/downloads/) adresinden Python 3.12 veya 3.13 kurun. Windows'ta kurulumun
   ilk ekranında **Add python.exe to PATH** kutusunu işaretleyin.
2. Projeyi indirin: `git clone https://github.com/mnoktaonokta/smartPhotodesign.git` (Git yoksa GitHub'daki
   **Code → Download ZIP** ile indirip bir klasöre çıkarın).
3. Windows'ta `Baslat-Windows.bat`, macOS'ta `Baslat-Mac.command` dosyasına çift tıklayın. İlk açılışta paketler
   kurulur (internet gerekir, birkaç dakika sürer). Sonraki açılışlar birkaç saniyedir ve internet gerekmez.
   Kapatmak için açılan siyah pencereyi kapatın.

macOS 13 veya üstü gerekir. İnternetten indirilen `.command` dosyasını macOS ilk seferde engellerse dosyaya sağ
tıklayıp **Aç**'ı seçin.

### Elle

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

### 1. Düzenle

- Sol çerçeve **Before**, sağ çerçeve **After**. Çerçeveye tıklayın veya sürükleyip bırakın.
- Aktif çerçeve teal kenarlıkla işaretlenir; sağ panel o fotoğrafın ayarlarını gösterir.
- Üst köşedeki **×** yüklenen fotoğrafı kaldırır.
- **Geri / İleri** (Ctrl+Z / Ctrl+Shift+Z) son işlemleri geri alır.

**Kadraj:** oran, yakınlaştırma (fare tekerleği), açı, 90° döndürme; sürükleyerek kaydırma.

**Light / Color:** Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temp, Tint, Vibrance,
Saturation (Lightroom adlarıyla). Değer kutularına sayı yazılabilir.

**Araçlar**
- Doğrusal maske, radyal maske, fırça maske, maske silgi
- **Dişleri otomatik seç** / **Nesne seç**: parlak diş bölgesi veya tıklanan nesne maskelenir; **Invert**
  ile dişlerin dışına ışık ayarı uygulanabilir
- **İyileştir**: fırça çevresindeki dokuya göre yumuşatır (diş eti çizgisi vb.)
- **Klon / rötüş**: Alt+tık kaynak, sonra boyayın

After yüklenince Before ayarları ve kadrajı kopyalanır; otomatik eşleştirme yapılır.

### 2. Paylaş

- Düzen: otomatik / yan yana / alt alta; oran: **4:5, 1:1, 9:16, 16:9**, orijinal
- Tek fotoğraf yüklüyse paylaşım **tek kare** olur
- BEFORE/AFTER yazısı: font, boyut, renk
- Klinik logoları (beyaz / siyah) tıklanarak seçilir; kendi PNG’niz de yüklenebilir
- Fotoğraflar arası ayraç çizgisi aç/kapa
- **Vinyet:** Before, After, ikisine ayrı veya tüm kareye
- PNG / JPEG indirme; iki fotoğraf varken kaydırmalı MP4 video

## Desteklenen dosyalar

- RAW: CR2, CR3, NEF, ARW, DNG, ORF, RW2, RAF (LibRaw ile, doğrusal kamera verisi üzerinden)
- Standart: JPG, PNG
- Logo: şeffaf PNG (`web/logos/beyaz.png`, `web/logos/siyah.png`)

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
| `core/image_composer.py` | Düzen, yazı, logo, vinyet ve dosya kodlama |
| `web/js/main.js` | Yan yana düzenleme, araçlar, paylaşım paneli |
| `web/js/tools.js` | Fırça/nesne maskeleri, iyileştirme ve klon |
| `web/js/history.js` | Geri / ileri alma |
| `web/js/shaders.js`, `renderer.js` | WebGL2 işleme hattı |
| `web/js/color.js` | Kelvin/renk tonu ve beyaz dengesi |
| `web/js/geometry.js` | Kadraj, döndürme, yakınlaştırma ve kaydırma |
| `web/js/match.js` | Fotoğraf ölçümü ve ayar eşleştirme |
| `web/js/slider-video.js` | Kaydırmalı video zaman çizelgesi ve MP4 kodlama |

Etiket fontları `assets/fonts/` altındadır (`DejaVu-LICENSE.txt`). MP4 paketleme için
[mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 projeye kopyalanmıştır (`web/vendor/`, MIT lisansı).

Çıktılar sosyal medya içindir; klinik teşhis kaydının yerine geçmez.

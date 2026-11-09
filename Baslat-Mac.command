#!/bin/bash
# Smart Photo Design: double-click to start. The first run sets up Python packages.
cd "$(dirname "$0")" || exit 1

PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "İlk kurulum yapılıyor, birkaç dakika sürebilir..."
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python bulunamadı. https://www.python.org/downloads/ adresinden Python 3.12 veya 3.13 kurun."
    read -r -p "Kapatmak için Enter'a basın."
    exit 1
  fi
  python3 -m venv .venv || { read -r -p "Kurulum başarısız. Kapatmak için Enter'a basın."; exit 1; }
fi

# Reinstall packages only when requirements.txt has changed since the last setup.
if ! cmp -s requirements.txt .venv/requirements.installed; then
  echo "Paketler kuruluyor..."
  if ! "$PY" -m pip install --disable-pip-version-check -q -r requirements.txt; then
    read -r -p "Paket kurulumu başarısız oldu. İnternet bağlantısını kontrol edin. Enter'a basın."
    exit 1
  fi
  cp requirements.txt .venv/requirements.installed
fi

echo
echo "Smart Photo Design çalışıyor: http://127.0.0.1:8765"
echo "Kapatmak için bu pencereyi kapatın veya Ctrl+C'ye basın."
echo
"$PY" -m smartphoto

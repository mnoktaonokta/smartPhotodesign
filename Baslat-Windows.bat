@echo off
rem Smart Photo Design: double-click to start. The first run sets up Python packages.
setlocal
cd /d "%~dp0"
title Smart Photo Design

set "PY=.venv\Scripts\python.exe"
if exist "%PY%" goto install

echo Ilk kurulum yapiliyor, birkac dakika surebilir...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m venv .venv
) else (
  python -m venv .venv
)
if not exist "%PY%" goto nopython

:install
rem Reinstall packages only when requirements.txt has changed since the last setup.
fc /b requirements.txt .venv\requirements.installed >nul 2>nul
if %errorlevel%==0 goto run
echo Paketler kuruluyor...
"%PY%" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto fail
copy /y requirements.txt .venv\requirements.installed >nul

:run
echo.
echo Smart Photo Design calisiyor: http://127.0.0.1:8765
echo Kapatmak icin bu pencereyi kapatin.
echo.
"%PY%" -m smartphoto
if errorlevel 1 pause
goto end

:nopython
echo.
echo Python bulunamadi.
echo https://www.python.org/downloads/ adresinden Python 3.12 veya 3.13 kurun.
echo Kurulumun ilk ekraninda "Add python.exe to PATH" kutusunu isaretleyin.
pause
goto end

:fail
echo.
echo Paket kurulumu basarisiz oldu. Internet baglantisini kontrol edip tekrar deneyin.
pause

:end
endlocal

"""Start the local server and open the editor: ``python -m smartphoto``."""

from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Smart Photo Design")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="Tarayıcıyı otomatik açma.")
    args = parser.parse_args()

    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.2, webbrowser.open, args=(url,)).start()
    print(f"Smart Photo Design çalışıyor: {url}  (kapatmak için Ctrl+C)")
    uvicorn.run("smartphoto.server:app", host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

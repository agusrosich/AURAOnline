from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote


REPO_ROOT = Path(os.environ.get("AURA_RT_REPO_ROOT", "/content/AURAOnline"))
BACKEND_DIR = REPO_ROOT / "backend"
REQUIREMENTS_PATH = BACKEND_DIR / "requirements-colab.txt"
SERVER_PORT = int(os.environ.get("AURA_RT_PORT", "8000"))
CACHE_ROOT_DEFAULT = Path(
    os.environ.get("AURA_RT_COLAB_CACHE_ROOT", "/content/drive/MyDrive/AURA_RT_CACHE")
)
WEBAPP_URL = os.environ.get("AURA_RT_WEBAPP_URL", "http://127.0.0.1:5173").strip()
WEBAPP_QUERY_PARAM = os.environ.get("AURA_RT_WEBAPP_QUERY_PARAM", "backend").strip() or "backend"


def run_command(command: list[str]) -> None:
    subprocess.run(command, check=True)


def install_dependencies() -> None:
    if not REQUIREMENTS_PATH.exists():
        raise FileNotFoundError(f"No se encontro {REQUIREMENTS_PATH}")
    run_command([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_PATH)])


def mount_drive() -> Path:
    from google.colab import drive  # type: ignore

    drive.mount("/content/drive")
    cache_root = CACHE_ROOT_DEFAULT
    cache_root.mkdir(parents=True, exist_ok=True)
    return cache_root


def prepare_environment(cache_root: Path) -> None:
    os.environ.setdefault("TOTALSEG_HOME_DIR", str(cache_root / "totalsegmentator"))
    os.environ.setdefault("AURA_RT_MODEL_CACHE", str(cache_root))
    os.environ.setdefault("AURA_RT_LOG_LEVEL", "INFO")


def start_uvicorn() -> None:
    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "aura_rt_backend.main:app",
        "--app-dir",
        str(BACKEND_DIR),
        "--host",
        "0.0.0.0",
        "--port",
        str(SERVER_PORT),
    ]
    subprocess.Popen(command)


def start_ngrok() -> str:
    from pyngrok import ngrok

    auth_token = os.environ.get("NGROK_AUTHTOKEN")
    if not auth_token:
        raise RuntimeError("Definir NGROK_AUTHTOKEN en el entorno de Colab antes de arrancar.")

    ngrok.set_auth_token(auth_token)
    tunnel = ngrok.connect(SERVER_PORT, bind_tls=True)
    return tunnel.public_url


def wait_for_server(timeout_seconds: int = 30) -> None:
    import requests

    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            response = requests.get(f"http://127.0.0.1:{SERVER_PORT}/health", timeout=3)
            if response.ok:
                return
        except requests.RequestException:
            time.sleep(1)
    raise TimeoutError("El backend no respondio a /health dentro del tiempo esperado.")


def wait_for_public_health(public_url: str, timeout_seconds: int = 30) -> None:
    import requests

    deadline = time.time() + timeout_seconds
    health_url = f"{public_url.rstrip('/')}/health"
    headers = {"ngrok-skip-browser-warning": "1"}

    while time.time() < deadline:
        try:
            response = requests.get(health_url, timeout=5, headers=headers)
            if response.ok:
                return
        except requests.RequestException:
            time.sleep(1)
    raise TimeoutError("La URL publica de ngrok no respondio a /health dentro del tiempo esperado.")


def build_webapp_link(public_url: str) -> str | None:
    if not WEBAPP_URL:
        return None

    separator = "&" if "?" in WEBAPP_URL else "?"
    encoded_backend_url = quote(public_url, safe="")
    return f"{WEBAPP_URL}{separator}{WEBAPP_QUERY_PARAM}={encoded_backend_url}"


def main() -> None:
    if not REPO_ROOT.exists():
        raise FileNotFoundError(
            f"No se encontro el repositorio en {REPO_ROOT}. Define AURA_RT_REPO_ROOT antes de ejecutar."
        )

    cache_root = mount_drive()
    install_dependencies()
    prepare_environment(cache_root)
    start_uvicorn()
    wait_for_server()
    public_url = start_ngrok()
    wait_for_public_health(public_url)
    os.environ["AURA_RT_PUBLIC_URL"] = public_url
    webapp_link = build_webapp_link(public_url)
    print(f"Repositorio: {REPO_ROOT}")
    print(f"Cache: {cache_root}")
    print(f"AURA-RT backend disponible en: {public_url}")
    if webapp_link:
        print(f"Web app lista para abrir: {webapp_link}")
    print("Mantener esta celda activa mientras se use la web app cliente.")


if __name__ == "__main__":
    main()

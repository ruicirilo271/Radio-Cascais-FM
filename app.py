import asyncio
import os
import re
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests
import urllib3
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from shazamio import Shazam

load_dotenv()

app = Flask(__name__)

STREAM_URL = os.getenv(
    "RADIO_STREAM_URL",
    "https://play.radioregional.pt:8220/stream/2/;;/stream.mp3",
).strip()
LASTFM_API_KEY = os.getenv("LASTFM_API_KEY", "").strip()
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "").strip()
DEFAULT_COVER = "/static/default-cover.webp"
SAMPLE_SECONDS = max(8, min(int(os.getenv("SAMPLE_SECONDS", "13")), 20))
SAMPLE_MAX_BYTES = max(350_000, min(int(os.getenv("SAMPLE_MAX_BYTES", "1600000")), 3_500_000))
IDENTIFY_CACHE_SECONDS = max(20, min(int(os.getenv("IDENTIFY_CACHE_SECONDS", "38")), 180))
REQUEST_TIMEOUT = (8, 20)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

_http = requests.Session()
_http.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; RadioCascais/3.0)",
    "Accept": "application/json, audio/mpeg, */*",
})

_state_lock = threading.Lock()
_identify_lock = threading.Lock()
_state: dict[str, Any] = {
    "title": "Rádio Cascais",
    "artist": "Em reprodução...",
    "cover": DEFAULT_COVER,
    "bio": "Liga a rádio para começar a identificação automática.",
    "lyrics": "Sem letra disponível.",
    "top_tracks": [],
    "identified_at": None,
    "status": "idle",
}
_state_updated_at = 0.0


def _safe_json(response: requests.Response) -> dict[str, Any]:
    try:
        data = response.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _clean_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def _snapshot() -> dict[str, Any]:
    with _state_lock:
        return dict(_state)


def _set_state(**updates: Any) -> dict[str, Any]:
    global _state_updated_at
    with _state_lock:
        _state.update(updates)
        _state_updated_at = time.monotonic()
        return dict(_state)


@app.get("/")
def index():
    return render_template("index.html", stream_url=STREAM_URL)


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "app": "Rádio Cascais Super Deus",
        "platform": "vercel" if os.getenv("VERCEL") else "local",
        "shazam": True,
        "ffmpeg_required": False,
        "youtube_ready": bool(YOUTUBE_API_KEY),
        "lastfm_ready": bool(LASTFM_API_KEY),
        "sample_seconds": SAMPLE_SECONDS,
    })


@app.get("/api/current")
@app.get("/current")
def current():
    response = jsonify(_snapshot())
    response.headers["Cache-Control"] = "no-store"
    return response


def capture_mp3_sample() -> str:
    """Grava diretamente bytes MP3 em /tmp; não depende de FFmpeg."""
    path = os.path.join(tempfile.gettempdir(), f"radio-cascais-{uuid.uuid4().hex}.mp3")
    started = time.monotonic()
    total = 0
    headers = {
        "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.5",
        "Icy-MetaData": "0",
        "Connection": "close",
    }

    with _http.get(
        STREAM_URL,
        headers=headers,
        stream=True,
        timeout=(10, SAMPLE_SECONDS + 15),
        verify=False,
    ) as response:
        response.raise_for_status()
        with open(path, "wb") as audio_file:
            for chunk in response.iter_content(chunk_size=16_384):
                if not chunk:
                    continue
                audio_file.write(chunk)
                total += len(chunk)
                elapsed = time.monotonic() - started
                if elapsed >= SAMPLE_SECONDS or total >= SAMPLE_MAX_BYTES:
                    break

    if total < 45_000:
        try:
            os.remove(path)
        except OSError:
            pass
        raise RuntimeError(f"A amostra ficou demasiado pequena ({total} bytes).")

    return path


async def recognize_sample(path: str) -> tuple[str | None, str | None]:
    shazam = Shazam()
    try:
        result = await shazam.recognize(path)
    except AttributeError:
        result = await shazam.recognize_song(path)

    track = result.get("track", {}) if isinstance(result, dict) else {}
    title = str(track.get("title") or "").strip()
    artist = str(track.get("subtitle") or "").strip()
    return (title or None, artist or None)


def get_cover(title: str, artist: str) -> str:
    try:
        response = _http.get(
            "https://itunes.apple.com/search",
            params={"term": f"{artist} {title}", "entity": "song", "limit": 5},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        results = _safe_json(response).get("results", [])
        for item in results:
            artwork = item.get("artworkUrl100")
            if artwork:
                return artwork.replace("100x100bb", "1000x1000bb").replace("100x100", "1000x1000")
    except Exception as exc:
        print("iTunes cover:", exc)
    return DEFAULT_COVER


def get_bio(artist: str) -> str:
    if not LASTFM_API_KEY:
        return f"{artist} está agora em reprodução na Rádio Cascais."
    try:
        response = _http.get(
            "https://ws.audioscrobbler.com/2.0/",
            params={
                "method": "artist.getinfo",
                "artist": artist,
                "api_key": LASTFM_API_KEY,
                "format": "json",
                "lang": "pt",
                "autocorrect": 1,
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        bio = _clean_html(_safe_json(response).get("artist", {}).get("bio", {}).get("summary", ""))
        return bio or f"{artist} está agora em reprodução na Rádio Cascais."
    except Exception as exc:
        print("Last.fm bio:", exc)
        return f"{artist} está agora em reprodução na Rádio Cascais."


def get_top_tracks(artist: str) -> list[str]:
    if not LASTFM_API_KEY:
        return []
    try:
        response = _http.get(
            "https://ws.audioscrobbler.com/2.0/",
            params={
                "method": "artist.gettoptracks",
                "artist": artist,
                "api_key": LASTFM_API_KEY,
                "format": "json",
                "limit": 10,
                "autocorrect": 1,
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        tracks = _safe_json(response).get("toptracks", {}).get("track", [])
        return [str(track.get("name")).strip() for track in tracks[:10] if track.get("name")]
    except Exception as exc:
        print("Last.fm top tracks:", exc)
        return []


def get_lyrics(artist: str, title: str) -> str:
    try:
        response = _http.get(
            f"https://api.lyrics.ovh/v1/{requests.utils.quote(artist, safe='')}/{requests.utils.quote(title, safe='')}",
            timeout=REQUEST_TIMEOUT,
        )
        if response.ok:
            lyrics = _safe_json(response).get("lyrics")
            if lyrics:
                return str(lyrics).strip()
    except Exception as exc:
        print("Lyrics.ovh:", exc)
    return "Sem letra disponível."


def enrich_track(title: str, artist: str) -> dict[str, Any]:
    with ThreadPoolExecutor(max_workers=4) as pool:
        cover_job = pool.submit(get_cover, title, artist)
        bio_job = pool.submit(get_bio, artist)
        lyrics_job = pool.submit(get_lyrics, artist, title)
        top_job = pool.submit(get_top_tracks, artist)
        return {
            "cover": cover_job.result(),
            "bio": bio_job.result(),
            "lyrics": lyrics_job.result(),
            "top_tracks": top_job.result(),
        }


@app.post("/api/identify")
def identify():
    global _state_updated_at

    force = request.args.get("force") == "1"
    age = time.monotonic() - _state_updated_at
    cached = _snapshot()
    if not force and cached.get("status") == "ok" and age < IDENTIFY_CACHE_SECONDS:
        cached["cached"] = True
        return jsonify(cached)

    if not _identify_lock.acquire(blocking=False):
        cached["status"] = "identifying"
        cached["message"] = "Já existe uma identificação em curso."
        return jsonify(cached), 202

    sample_path = None
    try:
        _set_state(status="identifying")
        sample_path = capture_mp3_sample()
        title, artist = asyncio.run(recognize_sample(sample_path))

        if not title or not artist:
            current_state = _set_state(status="not_found")
            current_state["message"] = "O Shazam não reconheceu esta amostra. Será feita nova tentativa."
            return jsonify(current_state), 404

        details = enrich_track(title, artist)
        result = _set_state(
            title=title,
            artist=artist,
            cover=details["cover"],
            bio=details["bio"],
            lyrics=details["lyrics"],
            top_tracks=details["top_tracks"],
            identified_at=int(time.time()),
            status="ok",
        )
        result["cached"] = False
        return jsonify(result)

    except requests.RequestException as exc:
        print("Erro ao captar stream:", exc)
        state = _set_state(status="stream_error")
        state["message"] = "Não foi possível captar uma amostra da emissão."
        return jsonify(state), 502
    except Exception as exc:
        print("Erro de identificação:", repr(exc))
        state = _set_state(status="error")
        state["message"] = f"Falha ao identificar: {exc}"
        return jsonify(state), 500
    finally:
        if sample_path:
            try:
                os.remove(sample_path)
            except OSError:
                pass
        _identify_lock.release()


@app.get("/api/youtube")
def youtube_search():
    title = request.args.get("title", "").strip()
    artist = request.args.get("artist", "").strip()
    if not title or not artist:
        return jsonify({"ok": False, "error": "Título e artista são obrigatórios."}), 400
    if not YOUTUBE_API_KEY:
        return jsonify({"ok": False, "error": "YOUTUBE_API_KEY não configurada."}), 503

    try:
        response = _http.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": f"{artist} {title} official audio",
                "type": "video",
                "videoEmbeddable": "true",
                "maxResults": 5,
                "key": YOUTUBE_API_KEY,
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        items = _safe_json(response).get("items", [])
        for item in items:
            video_id = item.get("id", {}).get("videoId")
            if video_id:
                return jsonify({"ok": True, "video_id": video_id})
        return jsonify({"ok": False, "error": "Nenhum vídeo incorporável encontrado."}), 404
    except Exception as exc:
        print("YouTube:", exc)
        return jsonify({"ok": False, "error": "Falha na pesquisa do YouTube."}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True, threaded=True)

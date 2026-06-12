"use strict";

const DEFAULT_COVER = "/static/default-cover.webp";
const IDENTIFY_INTERVAL_MS = 45_000;
const HISTORY_LIMIT = 10;

const $ = (selector) => document.querySelector(selector);
const audio = $("#audio");
const startBtn = $("#startBtn");
const identifyBtn = $("#identifyBtn");
const volume = $("#volume");
const canvas = $("#visualizer");
const drawCtx = canvas.getContext("2d");

const els = {
    cover: $("#cover"),
    coverPulse: $("#coverPulse"),
    title: $("#title"),
    artist: $("#artist"),
    bio: $("#bio"),
    lyrics: $("#lyrics"),
    topTracks: $("#topTracks"),
    history: $("#history"),
    topPlayed: $("#topPlayed"),
    ytPlayer: $("#ytPlayer"),
    videoPlaceholder: $("#videoPlaceholder"),
    statusText: $("#statusText"),
    statusDot: $("#statusDot"),
    countdown: $("#identifyCountdown"),
    toast: $("#toast"),
};

let isPlaying = false;
let identifying = false;
let identifyTimer = null;
let countdownTimer = null;
let nextIdentifyAt = 0;
let lastSongKey = localStorage.getItem("rc_last_song") || "";
let audioContext = null;
let analyser = null;
let frequencyData = null;
let useRealSpectrum = false;

function getStorage(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function setStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem espaço */ }
}

function escapeText(value) {
    return String(value ?? "");
}

function validSong(song) {
    return Boolean(song?.title && song?.artist && song.title !== "Rádio Cascais" && !song.artist.includes("reprodução"));
}

function songKey(song) {
    return `${song.title.trim()} — ${song.artist.trim()}`;
}

function showToast(message, type = "info") {
    els.toast.textContent = message;
    els.toast.dataset.type = type;
    els.toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 3800);
}

function setStatus(text, state = "idle") {
    els.statusText.textContent = text;
    els.statusDot.dataset.state = state;
}

function setButtonState() {
    startBtn.classList.toggle("playing", isPlaying);
    startBtn.querySelector(".power-icon").textContent = isPlaying ? "Ⅱ" : "▶";
    startBtn.querySelector(".button-label").textContent = isPlaying ? "RÁDIO LIGADA" : "LIGAR RÁDIO";
    identifyBtn.disabled = !isPlaying || identifying;
    els.coverPulse.classList.toggle("active", isPlaying);
}

async function setupAudio() {
    if (!audio.getAttribute("src")) audio.src = audio.dataset.stream;
    audio.volume = Number(volume.value);

    // O stream toca diretamente no browser para não ser interrompido pelo limite
    // de duração das funções Vercel. Como o servidor da rádio é externo, usamos
    // o visualizador compatível para não correr o risco de o Web Audio silenciar
    // a emissão quando não existem cabeçalhos CORS.
    useRealSpectrum = false;
}

async function toggleRadio() {
    try {
        if (isPlaying) {
            audio.pause();
            isPlaying = false;
            clearIdentifySchedule();
            setStatus("Em pausa", "paused");
            setButtonState();
            return;
        }

        if (!audio.src) await setupAudio();
        if (audioContext?.state === "suspended") await audioContext.resume();
        await audio.play();
        isPlaying = true;
        setStatus("Emissão em direto", "live");
        setButtonState();
        scheduleIdentification(1200);
    } catch (error) {
        console.error(error);
        setStatus("Não foi possível ligar", "error");
        showToast(`Erro ao iniciar a rádio: ${error.message}`, "error");
    }
}

function clearIdentifySchedule() {
    clearTimeout(identifyTimer);
    clearInterval(countdownTimer);
    identifyTimer = null;
    countdownTimer = null;
    els.countdown.textContent = "Shazam em espera";
}

function scheduleIdentification(delay = IDENTIFY_INTERVAL_MS) {
    clearIdentifySchedule();
    if (!isPlaying) return;
    nextIdentifyAt = Date.now() + delay;
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
    identifyTimer = setTimeout(async () => {
        await identifySong();
        if (isPlaying) scheduleIdentification(IDENTIFY_INTERVAL_MS);
    }, delay);
}

function updateCountdown() {
    if (!isPlaying) return;
    const seconds = Math.max(0, Math.ceil((nextIdentifyAt - Date.now()) / 1000));
    els.countdown.textContent = identifying ? "Shazam a ouvir…" : `Nova leitura em ${seconds}s`;
}

async function identifySong(force = false) {
    if (identifying || !isPlaying) return;
    identifying = true;
    identifyBtn.disabled = true;
    identifyBtn.classList.add("loading");
    setStatus("Shazam a ouvir a emissão…", "identifying");
    els.countdown.textContent = "A gravar amostra MP3…";

    try {
        const response = await fetch(`/api/identify${force ? "?force=1" : ""}`, { method: "POST", cache: "no-store" });
        const data = await response.json().catch(() => ({}));

        if (response.status === 202) {
            setStatus("Identificação já em curso", "identifying");
            return;
        }
        if (!response.ok) {
            throw new Error(data.message || data.error || "Música não reconhecida nesta tentativa.");
        }

        applySong(data);
        setStatus(data.cached ? "Música atualizada" : "Identificada pelo Shazam", "live");
    } catch (error) {
        console.warn(error);
        setStatus("Emissão em direto · nova tentativa em breve", "live");
        showToast(error.message, "warning");
    } finally {
        identifying = false;
        identifyBtn.classList.remove("loading");
        identifyBtn.disabled = !isPlaying;
    }
}

function applySong(song) {
    els.title.textContent = escapeText(song.title || "Rádio Cascais");
    els.artist.textContent = escapeText(song.artist || "Em reprodução...");
    els.cover.src = song.cover || DEFAULT_COVER;
    els.cover.onerror = () => { els.cover.onerror = null; els.cover.src = DEFAULT_COVER; };
    els.bio.textContent = song.bio || "Sem biografia disponível.";
    els.lyrics.textContent = song.lyrics || "Sem letra disponível.";
    renderSimpleRanking(els.topTracks, song.top_tracks || [], "Ainda sem dados do artista.");

    if (!validSong(song)) return;
    const key = songKey(song);
    if (key !== lastSongKey) {
        lastSongKey = key;
        localStorage.setItem("rc_last_song", key);
        saveHistory(song);
        saveTop(song);
        searchYoutube(song.title, song.artist);
        showToast(`Reconhecida: ${song.title} — ${song.artist}`, "success");
    }
    renderHistory();
    renderTopPlayed();
}

function saveHistory(song) {
    let history = getStorage("rc_history", []);
    const key = songKey(song);
    history = history.filter((item) => songKey(item) !== key);
    history.unshift({ title: song.title, artist: song.artist, cover: song.cover || DEFAULT_COVER, at: Date.now() });
    setStorage("rc_history", history.slice(0, HISTORY_LIMIT));
}

function saveTop(song) {
    const top = getStorage("rc_top", {});
    const key = songKey(song);
    top[key] = (top[key] || 0) + 1;
    setStorage("rc_top", top);
}

function renderHistory() {
    const history = getStorage("rc_history", []);
    els.history.replaceChildren();
    if (!history.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.innerHTML = "<span>♫</span><p>As últimas 10 músicas vão aparecer aqui.</p>";
        els.history.append(empty);
        return;
    }

    history.forEach((song, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "history-item";
        item.addEventListener("click", () => searchYoutube(song.title, song.artist));

        const img = document.createElement("img");
        img.src = song.cover || DEFAULT_COVER;
        img.alt = "";
        img.onerror = () => { img.src = DEFAULT_COVER; };

        const text = document.createElement("span");
        text.className = "history-copy";
        const strong = document.createElement("strong");
        strong.textContent = song.title;
        const small = document.createElement("small");
        small.textContent = song.artist;
        text.append(strong, small);

        const number = document.createElement("span");
        number.className = "history-number";
        number.textContent = String(index + 1).padStart(2, "0");
        item.append(img, text, number);
        els.history.append(item);
    });
}

function renderTopPlayed() {
    const top = getStorage("rc_top", {});
    const rows = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10);
    els.topPlayed.replaceChildren();
    if (!rows.length) {
        const li = document.createElement("li");
        li.className = "empty-line";
        li.textContent = "Ainda sem dados.";
        els.topPlayed.append(li);
        return;
    }
    rows.forEach(([name, count]) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = name;
        const badge = document.createElement("b");
        badge.textContent = `${count}×`;
        li.append(label, badge);
        els.topPlayed.append(li);
    });
}

function renderSimpleRanking(container, items, emptyText) {
    container.replaceChildren();
    if (!items.length) {
        const li = document.createElement("li");
        li.className = "empty-line";
        li.textContent = emptyText;
        container.append(li);
        return;
    }
    items.slice(0, 10).forEach((name) => {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.textContent = name;
        li.append(span);
        container.append(li);
    });
}

async function searchYoutube(title, artist) {
    els.videoPlaceholder.classList.remove("hidden");
    els.videoPlaceholder.querySelector("p").textContent = "A procurar o vídeo…";
    try {
        const params = new URLSearchParams({ title, artist });
        const response = await fetch(`/api/youtube?${params}`);
        const data = await response.json();
        if (!response.ok || !data.video_id) throw new Error(data.error || "Vídeo não encontrado.");
        els.ytPlayer.src = `https://www.youtube-nocookie.com/embed/${data.video_id}?autoplay=0&rel=0&modestbranding=1`;
        els.videoPlaceholder.classList.add("hidden");
    } catch (error) {
        els.videoPlaceholder.querySelector("p").textContent = error.message;
    }
}

function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    drawCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawSpectrum(time = 0) {
    requestAnimationFrame(drawSpectrum);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    drawCtx.clearRect(0, 0, width, height);

    const bars = Math.max(42, Math.floor(width / 12));
    const gap = 4;
    const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
    let realValues = null;
    if (useRealSpectrum && analyser && frequencyData && isPlaying) {
        analyser.getByteFrequencyData(frequencyData);
        realValues = frequencyData;
    }

    for (let i = 0; i < bars; i++) {
        let level;
        if (!isPlaying) {
            level = 0.08 + 0.025 * Math.sin(time / 900 + i * 0.6);
        } else if (realValues) {
            const index = Math.floor((i / bars) * realValues.length * 0.72);
            level = Math.max(0.08, realValues[index] / 255);
        } else {
            const waveA = Math.sin(time / 240 + i * 0.48);
            const waveB = Math.sin(time / 430 + i * 0.19);
            level = 0.22 + Math.abs(waveA * 0.46 + waveB * 0.24);
        }

        const barHeight = Math.max(4, level * (height - 18));
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;
        const gradient = drawCtx.createLinearGradient(0, y, 0, y + barHeight);
        gradient.addColorStop(0, "rgba(168,247,255,.95)");
        gradient.addColorStop(0.38, "rgba(0,225,255,.95)");
        gradient.addColorStop(1, "rgba(38,83,255,.62)");
        drawCtx.fillStyle = gradient;
        drawCtx.shadowBlur = isPlaying ? 15 : 5;
        drawCtx.shadowColor = "rgba(0,216,255,.8)";
        drawCtx.beginPath();
        drawCtx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        drawCtx.fill();
    }
    drawCtx.shadowBlur = 0;
}

startBtn.addEventListener("click", toggleRadio);
identifyBtn.addEventListener("click", async () => {
    clearIdentifySchedule();
    await identifySong(true);
    if (isPlaying) scheduleIdentification(IDENTIFY_INTERVAL_MS);
});
volume.addEventListener("input", () => { audio.volume = Number(volume.value); });
$("#clearHistory").addEventListener("click", () => {
    localStorage.removeItem("rc_history");
    localStorage.removeItem("rc_top");
    renderHistory();
    renderTopPlayed();
    showToast("Histórico e ranking limpos.");
});
audio.addEventListener("waiting", () => isPlaying && setStatus("A carregar emissão…", "identifying"));
audio.addEventListener("playing", () => isPlaying && setStatus("Emissão em direto", "live"));
audio.addEventListener("error", () => {
    setStatus("Erro no stream", "error");
    showToast("O stream da rádio não respondeu. Tenta novamente.", "error");
});
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isPlaying && !identifyTimer) scheduleIdentification(1500);
});

renderHistory();
renderTopPlayed();
renderSimpleRanking(els.topTracks, [], "Ainda sem dados do artista.");
resizeCanvas();
requestAnimationFrame(drawSpectrum);
setButtonState();

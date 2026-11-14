// js/playwatch.js

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") || "default";
const videoId = params.get("id");

const videoEl = document.getElementById("video");
const audioEl = document.getElementById("audio");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error-message");

// ── UI要素 ──
const container     = document.getElementById("player-container");
const playPauseBtn  = document.getElementById("play-pause-btn");
const bigPlayBtn    = document.getElementById("big-play-btn");
const volumeBtn     = document.getElementById("volume-btn");
const volumeSlider  = document.getElementById("volume-slider");
const timeDisplay   = document.getElementById("time-display");
const progressCtn   = document.getElementById("progress-container");
const playedBar     = document.getElementById("played-bar");
const loadedBar     = document.getElementById("loaded-bar");
const thumbEl       = document.getElementById("thumb");
const settingsBtn   = document.getElementById("settings-btn");
const settingsMenu  = document.getElementById("settings-menu");
const speedMenu     = document.getElementById("speed-menu");
const subtitleMenu  = document.getElementById("subtitle-menu");
const subtitleBtn   = document.getElementById("subtitle-btn");
const subtitleList  = document.getElementById("subtitle-list");
const translateList = document.getElementById("translate-list");
const subtitleOverlay = document.getElementById("subtitle-overlay");
const bufferSpinner = document.getElementById("buffer-spinner");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const pipBtn        = document.getElementById("pip-btn");
const downloadBtn   = document.getElementById("download-btn");

// ==================== ストリームURL変換 ====================
function transformStreamUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    const issuer = u.searchParams.get('issuer');
    if (!issuer) return url;
    u.searchParams.delete('issuer');
    const newHost = issuer.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `https://${newHost}${u.pathname}${u.search}`;
  } catch (e) {
    console.warn('transformStreamUrl failed:', url, e);
    return url;
  }
}

// ==================== トースト表示 ====================
let toastTimer = null;
function showModeToast(message) {
  let toast = document.getElementById("mode-toast");
  if (toast) { toast.remove(); if (toastTimer) clearTimeout(toastTimer); }
  toast = document.createElement("div");
  toast.id = "mode-toast";
  toast.className = "mode-toast";
  toast.innerHTML = `<span class="mode-toast-icon">🔄</span><span class="mode-toast-text">${message}</span>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
  }, 4000);
}

// ==================== フォールバック順序 ====================
const FALLBACK_CHAINS = {
  "official":       ["api1-original2", "api1-original1"],
  "api1-original2": ["api1-original1"],
  "api1-original1": ["api1-original2"],
  "api2-original1": ["api2-original2", "api1-original2", "api1-original1"],
  "api2-original2": ["api2-original1", "api1-original2", "api1-original1"],
};
const API1_LOOP = ["api1-original2", "api1-original1"];

function buildAttemptOrder(startMode) {
  const chain = FALLBACK_CHAINS[startMode];
  if (!chain) return [startMode];
  const order = [startMode, ...chain];
  const lastTwo = order.slice(-2);
  const endsWithApi1Loop =
    lastTwo.length === 2 &&
    API1_LOOP.includes(lastTwo[0]) &&
    API1_LOOP.includes(lastTwo[1]) &&
    lastTwo[0] !== lastTwo[1];
  if (!endsWithApi1Loop) order.push(...API1_LOOP);
  return order;
}

const MODE_LABELS = {
  "official":       "公式プレイヤー",
  "api1-original1": "API1・オリジナル1（高画質）",
  "api1-original2": "API1・オリジナル2（音声込み）",
  "api2-original1": "API2・オリジナル1（高画質）",
  "api2-original2": "API2・オリジナル2（音声込み）",
  "default":        "デフォルト",
  "360":            "360p",
};
function modeLabel(m) { return MODE_LABELS[m] || m; }

// ==================== APIフィルタ ====================
const API_FILTERS = { "api1-high": ["/.netlify/functions"] };
function filterApiList(apiList, mode) {
  const patterns = API_FILTERS[mode];
  if (!patterns || patterns.length === 0) return apiList;
  const filtered = apiList.filter(url => patterns.some(p => url.includes(p)));
  if (filtered.length === 0) return apiList;
  return filtered;
}

// ==================== API.json キャッシュ ====================
let _apiListCache = null;
async function getApiList() {
  if (_apiListCache) return _apiListCache;
  try {
    const cached = sessionStorage.getItem('ktube_api_list');
    if (cached) { _apiListCache = JSON.parse(cached); return _apiListCache; }
  } catch (e) {}
  try {
    const res = await fetch('/API.json');
    if (!res.ok) throw new Error('API.json の読み込みに失敗');
    const list = await res.json();
    _apiListCache = list;
    try { sessionStorage.setItem('ktube_api_list', JSON.stringify(list)); } catch (e) {}
    return list;
  } catch (err) {
    return ["https://splendid-jelly-e731bd.netlify.app/.netlify/functions"];
  }
}

// ==================== 最速APIで動画情報を取得 ====================
async function fetchFastestApi(videoId, mode) {
  let apiList = await getApiList();
  if (!Array.isArray(apiList) || apiList.length === 0) throw new Error('APIリストが空です');
  apiList = filterApiList(apiList, mode);

  const requests = apiList.map(baseUrl => {
    const url = `${baseUrl}/video?v=${videoId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    return fetch(url, { signal: controller.signal })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(data => { clearTimeout(timer); return { data, source: baseUrl }; })
      .catch(err => { clearTimeout(timer); throw err; });
  });

  try {
    const fastest = await Promise.any(requests);
    return fastest.data;
  } catch (err) {
    throw new Error('動画情報の取得に失敗しました（全API失敗）');
  }
}

// ==================== 音声着脱 ====================
function detachAudio() {
  if (!audioEl) return;
  try { audioEl.pause(); } catch (e) {}
  audioEl.removeAttribute('src');
  try { audioEl.load(); } catch (e) {}
  audioEl.style.display = 'none';
}
function attachAudio(src) {
  if (!audioEl) return;
  audioEl.style.display = 'none';
  audioEl.src = src;
}

// ==================== メディア準備待ち ====================
function waitForMediaReady(el, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!el) return resolve();
    let settled = false;
    const cleanup = () => {
      el.removeEventListener('canplay', onOk);
      el.removeEventListener('loadeddata', onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const onOk = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onErr = () => { if (settled) return; settled = true; cleanup(); reject(new Error('メディアの読み込みに失敗しました')); };
    el.addEventListener('canplay', onOk, { once: true });
    el.addEventListener('loadeddata', onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve(); }, timeoutMs);
  });
}

// ==================== 単一モード読み込み ====================
async function tryLoadWithMode(targetMode) {
  let streamData;

  if (targetMode === "api1-original1" || targetMode === "api1-original2") {
    const apiMode = targetMode === "api1-original1" ? "api1-high" : "api1-prog";
    const data = await fetchFastestApi(videoId, apiMode);

    if (targetMode === "api1-original1") {
      const videoFormat = data.adaptiveFormats?.find(f =>
        f.type?.includes("video/mp4") && (f.qualityLabel?.includes("720") || f.qualityLabel?.includes("1080"))
      ) || data.adaptiveFormats?.find(f => f.type?.includes("video/mp4"));
      const audioFormat = data.adaptiveFormats?.find(f =>
        f.type?.includes("audio/mp4") || f.type?.includes("audio")
      );
      if (!videoFormat?.url) throw new Error("高画質ビデオストリームが見つかりません");
      if (!audioFormat?.url) throw new Error("音声ストリームが見つかりません");
      videoEl.src = transformStreamUrl(videoFormat.url);
      attachAudio(transformStreamUrl(audioFormat.url));
      syncVideoAudio();
      await waitForMediaReady(videoEl, 10000);
    } else {
      const prog = data.formatStreams?.find(f =>
        f.type?.includes("video/mp4") && (f.qualityLabel?.includes("360") || f.itag === 18)
      ) || data.formatStreams?.[0];
      if (!prog?.url) throw new Error("音声込みストリームが見つかりません");
      videoEl.src = transformStreamUrl(prog.url);
      detachAudio();
      await waitForMediaReady(videoEl, 10000);
    }
  }
  else if (targetMode === "api2-original1" || targetMode === "api2-original2") {
    const apiEndpoint = targetMode === "api2-original2" ? "/video360" : "/video";
    const res = await fetch(`${apiEndpoint}?id=${videoId}`);
    if (!res.ok) throw new Error(`yt-dlp APIエラー: ${res.status}`);
    streamData = await res.json();
    if (!streamData.video) throw new Error("動画URLが取得できません");
    const transformedVideo = transformStreamUrl(streamData.video);
    videoEl.src = `/proxy?url=${encodeURIComponent(transformedVideo)}`;
    if (targetMode === "api2-original2") {
      detachAudio();
      try { localStorage.setItem("last360VideoUrl", streamData.video); if (window.parent) window.parent.postMessage("video360-ready", "*"); } catch (e) {}
      await waitForMediaReady(videoEl, 10000);
    } else {
      if (!streamData.audio) throw new Error("音声URLが取得できません");
      const transformedAudio = transformStreamUrl(streamData.audio);
      attachAudio(`/proxy?url=${encodeURIComponent(transformedAudio)}`);
      syncVideoAudio();
      await waitForMediaReady(videoEl, 10000);
    }
  }
  else if (targetMode === "official") {
    throw new Error("official はこのプレイヤーでは直接再生できません");
  }
  else {
    const apiEndpoint = targetMode === "360" ? "/video360" : "/video";
    const res = await fetch(`${apiEndpoint}?id=${videoId}`);
    if (!res.ok) throw new Error(`yt-dlp APIエラー: ${res.status}`);
    streamData = await res.json();
    if (!streamData.video) throw new Error("動画URLが取得できません");
    const transformedVideo = transformStreamUrl(streamData.video);
    videoEl.src = `/proxy?url=${encodeURIComponent(transformedVideo)}`;
    if (targetMode === "360") {
      detachAudio();
      try { localStorage.setItem("last360VideoUrl", streamData.video); if (window.parent) window.parent.postMessage("video360-ready", "*"); } catch (e) {}
      await waitForMediaReady(videoEl, 10000);
    } else {
      if (!streamData.audio) throw new Error("音声URLが取得できません");
      const transformedAudio = transformStreamUrl(streamData.audio);
      attachAudio(`/proxy?url=${encodeURIComponent(transformedAudio)}`);
      syncVideoAudio();
      await waitForMediaReady(videoEl, 10000);
    }
  }
}

// ==================== フォールバック付き読み込み ====================
async function loadVideoWithFallback() {
  const order = buildAttemptOrder(mode);
  const MAX_ATTEMPTS = order.length + 8;
  let attempts = 0, index = 0;
  const originalMode = mode;

  while (attempts < MAX_ATTEMPTS) {
    const targetMode = order[index];
    attempts++;

    try {
      await tryLoadWithMode(targetMode);
      if (loadingEl) loadingEl.style.display = "none";

      // 字幕リスト取得（動画読み込み成功後）
      loadSubtitles(videoId).catch(e => console.warn('subtitle load failed:', e));

      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'ktube-player-mode-changed', mode: targetMode, videoId }, '*');
        }
      } catch (e) {}

      if (targetMode !== originalMode) {
        showModeToast(`再生方法を「${modeLabel(targetMode)}」に切り替えました`);
      }
      return;
    } catch (err) {
      console.warn(`[playwatch] 失敗: ${targetMode} → ${err.message}`);
      index++;
      if (index >= order.length) {
        const lastTwo = order.slice(-2);
        const inApi1Loop =
          lastTwo.length === 2 &&
          API1_LOOP.includes(lastTwo[0]) &&
          API1_LOOP.includes(lastTwo[1]) &&
          lastTwo[0] !== lastTwo[1];
        if (inApi1Loop) {
          const lastTried = order[order.length - 1];
          const otherApi1 = API1_LOOP.find(m => m !== lastTried) || API1_LOOP[0];
          order.push(otherApi1);
        } else {
          order.push(...API1_LOOP);
        }
      }
    }
  }

  showError(
    `動画の読み込みに失敗しました<br>` +
    `${attempts}回試行しましたが再生できませんでした<br><br>` +
    `別の再生方法を試してください。`
  );
}

// ==================== 音声同期 ====================
function syncVideoAudio() {
  if (!audioEl) return;
  videoEl.addEventListener("play", () => audioEl.play().catch(() => {}));
  videoEl.addEventListener("pause", () => audioEl.pause());
  videoEl.addEventListener("seeking", () => { audioEl.currentTime = videoEl.currentTime; });
  videoEl.addEventListener("ratechange", () => { audioEl.playbackRate = videoEl.playbackRate; });
  videoEl.addEventListener("volumechange", () => {
    audioEl.volume = videoEl.volume;
    audioEl.muted = videoEl.muted;
  });
}

function showError(message) {
  if (loadingEl) loadingEl.style.display = "none";
  if (errorEl) { errorEl.innerHTML = message; errorEl.style.display = "block"; }
}

// ==================== UI 初期化 ====================
function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updatePlayButton() {
  const icon = videoEl.paused ? 'play_arrow' : 'pause';
  playPauseBtn.querySelector('.material-icons').textContent = icon;
}

function togglePlay() {
  if (videoEl.paused) videoEl.play().catch(() => {});
  else videoEl.pause();
}

playPauseBtn.addEventListener('click', togglePlay);
bigPlayBtn.addEventListener('click', () => { togglePlay(); bigPlayBtn.style.display = 'none'; });

videoEl.addEventListener('play', () => { updatePlayButton(); bigPlayBtn.style.display = 'none'; });
videoEl.addEventListener('pause', () => { updatePlayButton(); bigPlayBtn.style.display = 'flex'; });

videoEl.addEventListener('timeupdate', () => {
  const dur = videoEl.duration || 0;
  const cur = videoEl.currentTime || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  playedBar.style.width = pct + '%';
  thumbEl.style.left = pct + '%';
  timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
});

videoEl.addEventListener('progress', () => {
  const dur = videoEl.duration || 0;
  if (dur > 0 && videoEl.buffered.length > 0) {
    const end = videoEl.buffered.end(videoEl.buffered.length - 1);
    loadedBar.style.width = (end / dur) * 100 + '%';
  }
});

progressCtn.addEventListener('click', (e) => {
  const rect = progressCtn.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (videoEl.duration) videoEl.currentTime = pct * videoEl.duration;
});

volumeSlider.addEventListener('input', () => {
  videoEl.volume = parseFloat(volumeSlider.value);
  if (audioEl) audioEl.volume = videoEl.volume;
  volumeBtn.querySelector('.material-icons').textContent =
    videoEl.volume === 0 ? 'volume_off' : (videoEl.volume < 0.5 ? 'volume_down' : 'volume_up');
});

volumeBtn.addEventListener('click', () => {
  videoEl.muted = !videoEl.muted;
  volumeBtn.querySelector('.material-icons').textContent =
    videoEl.muted ? 'volume_off' : 'volume_up';
});

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else container.requestFullscreen().catch(() => {});
});

pipBtn.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await videoEl.requestPictureInPicture();
  } catch (e) {}
});

downloadBtn.addEventListener('click', () => {
  window.open(`/watch.html?id=${videoId}`, '_blank');
});

// コントロール表示制御
let hideControlsTimer = null;
container.addEventListener('mousemove', () => {
  container.classList.add('show-controls');
  clearTimeout(hideControlsTimer);
  hideControlsTimer = setTimeout(() => container.classList.remove('show-controls'), 2500);
});

// 設定メニュー
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = settingsMenu.style.display !== 'none';
  settingsMenu.style.display = open ? 'none' : 'block';
  speedMenu.style.display = 'none';
  subtitleMenu.style.display = 'none';
});

settingsMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.settings-item');
  if (!item) return;
  const action = item.dataset.action;
  if (action === 'speed') {
    settingsMenu.style.display = 'none';
    speedMenu.style.display = 'block';
  } else if (action === 'subtitles') {
    settingsMenu.style.display = 'none';
    subtitleMenu.style.display = 'block';
  }
});

document.querySelectorAll('.settings-back').forEach(back => {
  back.addEventListener('click', () => {
    speedMenu.style.display = 'none';
    subtitleMenu.style.display = 'none';
    settingsMenu.style.display = 'block';
  });
});

// 再生速度
speedMenu.querySelectorAll('[data-speed]').forEach(item => {
  item.addEventListener('click', () => {
    const speed = parseFloat(item.dataset.speed);
    videoEl.playbackRate = speed;
    if (audioEl) audioEl.playbackRate = speed;
    speedMenu.querySelectorAll('.settings-item').forEach(i => i.classList.remove('selected'));
    item.classList.add('selected');
    speedMenu.style.display = 'none';
  });
});

// クリック外で閉じる
document.addEventListener('click', (e) => {
  if (!settingsBtn.contains(e.target) && !settingsMenu.contains(e.target) &&
      !speedMenu.contains(e.target) && !subtitleMenu.contains(e.target)) {
    settingsMenu.style.display = 'none';
    speedMenu.style.display = 'none';
    subtitleMenu.style.display = 'none';
  }
});

// =============================================
// 字幕機能
// =============================================
let _subtitles = [];       // [{label, languageCode, url}]
let _currentTrack = null;  // 現在の <track>

async function loadSubtitles(videoId) {
  try {
    const res = await fetch(`/captions/${videoId}`);
    if (!res.ok) throw new Error('captions fetch failed');
    const data = await res.json();
    _subtitles = data.captions || [];
    renderSubtitleList();
  } catch (e) {
    console.warn('字幕取得失敗:', e);
    _subtitles = [];
    renderSubtitleList();
  }
}

function renderSubtitleList() {
  subtitleList.innerHTML = '';
  if (_subtitles.length === 0) {
    subtitleList.innerHTML = '<div class="settings-item" style="opacity:0.5;cursor:default;">字幕なし</div>';
    return;
  }
  _subtitles.forEach(sub => {
    const div = document.createElement('div');
    div.className = 'settings-item';
    div.textContent = sub.label || sub.languageCode;
    div.dataset.lang = sub.languageCode;
    div.dataset.url = sub.url;
    div.addEventListener('click', () => selectSubtitle(sub));
    subtitleList.appendChild(div);
  });
}

function selectSubtitle(sub) {
  // 既存トラックを削除
  videoEl.querySelectorAll('track').forEach(t => t.remove());

  if (!sub) {
    subtitleBtn.classList.remove('active');
    subtitleOverlay.style.display = 'none';
    return;
  }

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = sub.label || sub.languageCode;
  track.srclang = sub.languageCode;
  // playwatch.js の selectSubtitle 内
track.src = `/captions/${videoId}?label=${encodeURIComponent(sub.languageCode)}`;
  track.default = true;
  track.addEventListener('load', () => {
    track.track.mode = 'showing';
  });
  videoEl.appendChild(track);
  _currentTrack = track;

  // 字幕リストのselectedを更新
  subtitleList.querySelectorAll('.settings-item').forEach(i => i.classList.remove('selected'));
  [...subtitleList.children].forEach(i => {
    if (i.dataset.lang === sub.languageCode) i.classList.add('selected');
  });

  subtitleBtn.classList.add('active');
  subtitleMenu.style.display = 'none';

  // 字幕ON
  videoEl.addEventListener('loadedmetadata', () => {
    if (track.track) track.track.mode = 'showing';
  }, { once: true });

  // トラック読み込み済みなら即時
  if (track.track) track.track.mode = 'showing';
}

// 字幕OFF
subtitleMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.settings-item[data-sub="off"]');
  if (!item) return;
  videoEl.querySelectorAll('track').forEach(t => t.remove());
  subtitleBtn.classList.remove('active');
  subtitleOverlay.style.display = 'none';
  subtitleList.querySelectorAll('.settings-item').forEach(i => i.classList.remove('selected'));
  subtitleMenu.style.display = 'none';
});

// 字幕ボタン（クイックトグル）
subtitleBtn.addEventListener('click', () => {
  const tracks = videoEl.querySelectorAll('track');
  if (tracks.length === 0) {
    // 字幕なし → メニューを開く
    settingsMenu.style.display = 'none';
    speedMenu.style.display = 'none';
    subtitleMenu.style.display = 'block';
  } else {
    // 字幕あり → OFF
    videoEl.querySelectorAll('track').forEach(t => t.remove());
    subtitleBtn.classList.remove('active');
    subtitleOverlay.style.display = 'none';
  }
});

// 自動翻訳メニュー（簡易版：選択した言語で翻訳字幕を取得）
subtitleMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.settings-item[data-sub="translate"]');
  if (!item) return;
  translateList.style.display = 'block';
  translateList.innerHTML = '<div class="settings-item" style="opacity:0.5;cursor:default;">読み込み中...</div>';

  try {
    const res = await fetch(`/captions/${videoId}/translate-langs`);
    if (!res.ok) throw new Error('translate langs fetch failed');
    const data = await res.json();
    const langs = data.langs || [];
    translateList.innerHTML = '';
    if (langs.length === 0) {
      translateList.innerHTML = '<div class="settings-item" style="opacity:0.5;cursor:default;">翻訳先なし</div>';
      return;
    }
    langs.forEach(l => {
      const div = document.createElement('div');
      div.className = 'settings-item';
      div.textContent = l.name || l.code;
      div.addEventListener('click', () => selectTranslation(l.code, l.name));
      translateList.appendChild(div);
    });
  } catch (e) {
    translateList.innerHTML = '<div class="settings-item" style="opacity:0.5;cursor:default;">翻訳リスト取得失敗</div>';
  }
});

function selectTranslation(langCode, langName) {
  videoEl.querySelectorAll('track').forEach(t => t.remove());
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = langName;
  track.srclang = langCode;
  track.src = `/captions/${videoId}/translate?tlang=${langCode}`;
  track.default = true;

  // 読み込み失敗時（501）はトースト表示
  track.addEventListener('error', () => {
    showModeToast('翻訳字幕は現在利用できません');
    track.remove();
    subtitleBtn.classList.remove('active');
  });

  videoEl.appendChild(track);
  _currentTrack = track;
  subtitleBtn.classList.add('active');
  subtitleMenu.style.display = 'none';
  if (track.track) track.track.mode = 'showing';
}

// ==================== エントリーポイント ====================
if (!videoId) {
  showError("動画IDが指定されていません");
} else {
  loadVideoWithFallback();
}

// js/playwatch.js

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") || "default";
const videoId = params.get("id");

const videoEl = document.getElementById("video");
const audioEl = document.getElementById("audio");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error-message");

// ==================== トースト表示 ====================
let toastTimer = null;

function showModeToast(message) {
  let toast = document.getElementById("mode-toast");
  if (toast) {
    toast.remove();
    if (toastTimer) clearTimeout(toastTimer);
  }

  toast = document.createElement("div");
  toast.id = "mode-toast";
  toast.className = "mode-toast";
  toast.innerHTML = `
    <span class="mode-toast-icon">🔄</span>
    <span class="mode-toast-text">${message}</span>
  `;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add("show"));
  });

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 400);
  }, 4000);
}

// ==================== 親へのエラー通知 ====================
function notifyParentError(reason, currentMode) {
  console.warn(`[playwatch] 親にエラー通知: ${reason} (mode=${currentMode})`);
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      type: 'player-error',
      reason,
      mode: currentMode
    }, '*');
  }
}

// ==================== googlevideo.com ブロック検知 ====================
// videoEl の src が googlevideo.com を含む場合、error イベントで親に通知
let _blockCheckTimer = null;
let _blockNotified = false;

function setupGooglevideoBlockDetector(currentMode) {
  // 前回のタイマーをクリア
  if (_blockCheckTimer) {
    clearTimeout(_blockCheckTimer);
    _blockCheckTimer = null;
  }
  _blockNotified = false;

  const checkSrc = () => {
    const src = videoEl.src || '';
    return src.includes('googlevideo.com') || src.includes('/videoplayback');
  };

  // ① video error イベント
  const onError = () => {
    if (_blockNotified) return;
    if (!checkSrc()) return;
    _blockNotified = true;
    notifyParentError('googlevideo-error', currentMode);
  };
  videoEl.addEventListener('error', onError);

  // ② タイムアウト検知（8秒以内に readyState が 2 以上にならなければブロック扱い）
  _blockCheckTimer = setTimeout(() => {
    if (_blockNotified) return;
    if (!checkSrc()) return;
    if (videoEl.readyState < 2) {
      _blockNotified = true;
      notifyParentError('googlevideo-timeout', currentMode);
    }
  }, 8000);
}

// ==================== フォールバック順序の定義 ====================
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

  if (!endsWithApi1Loop) {
    order.push(...API1_LOOP);
  }

  return order;
}

// ==================== モード名の表示ラベル ====================
const MODE_LABELS = {
  "official":       "公式プレイヤー",
  "api1-original1": "API1・オリジナル1（高画質）",
  "api1-original2": "API1・オリジナル2（音声込み）",
  "api2-original1": "API2・オリジナル1（高画質）",
  "api2-original2": "API2・オリジナル2（音声込み）",
  "default":        "デフォルト",
  "360":            "360p",
};

function modeLabel(m) {
  return MODE_LABELS[m] || m;
}

// ==================== APIフィルタ ====================
const API_FILTERS = {
  "api1-high": ["/.netlify/functions"],
};

function filterApiList(apiList, mode) {
  const patterns = API_FILTERS[mode];
  if (!patterns || patterns.length === 0) return apiList;
  const filtered = apiList.filter(url =>
    patterns.some(pattern => url.includes(pattern))
  );
  if (filtered.length === 0) {
    console.warn(`モード「${mode}」に一致するAPIが無いため、全APIにフォールバックします`);
    return apiList;
  }
  return filtered;
}

async function getApiList() {
  try {
    const res = await fetch('/API.json');
    if (!res.ok) throw new Error('API.json の読み込みに失敗');
    return await res.json();
  } catch (err) {
    console.warn('API.json 読み込みエラー:', err);
    return ["https://splendid-jelly-e731bd.netlify.app/.netlify/functions"];
  }
}

async function fetchFastestApi(videoId, mode) {
  let apiList = await getApiList();
  if (!Array.isArray(apiList) || apiList.length === 0) {
    throw new Error('APIリストが空です');
  }
  apiList = filterApiList(apiList, mode);

  const requests = apiList.map(baseUrl => {
    const url = `${baseUrl}/video?v=${videoId}`;
    return fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => ({ data, source: baseUrl }));
  });

  try {
    const fastest = await Promise.any(requests);
    console.log(`最速API成功: ${fastest.source}`);
    return fastest.data;
  } catch (err) {
    console.error('全てのAPIが失敗しました', err);
    throw new Error('動画情報の取得に失敗しました（全API失敗）');
  }
}

// ==================== 音声要素の安全な着脱 ====================
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

// ==================== 単一モードで動画を読み込む ====================
async function tryLoadWithMode(targetMode) {
  let streamData;

  // ── API1系 ──
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

      videoEl.src = videoFormat.url;
      attachAudio(audioFormat.url);
      syncVideoAudio();
    } else {
      const prog = data.formatStreams?.find(f =>
        f.type?.includes("video/mp4") && (f.qualityLabel?.includes("360") || f.itag === 18)
      ) || data.formatStreams?.[0];

      if (!prog?.url) throw new Error("音声込みストリームが見つかりません");
      videoEl.src = prog.url;
      detachAudio();
    }
  }
  // ── API2系 ──
  else if (targetMode === "api2-original1" || targetMode === "api2-original2") {
    const apiEndpoint = targetMode === "api2-original2" ? "/video360" : "/video";
    const res = await fetch(`${apiEndpoint}?id=${videoId}`);
    if (!res.ok) throw new Error(`yt-dlp APIエラー: ${res.status}`);
    streamData = await res.json();

    if (!streamData.video) throw new Error("動画URLが取得できません");

    videoEl.src = `/proxy?url=${encodeURIComponent(streamData.video)}`;

    if (targetMode === "api2-original2") {
      detachAudio();
      try {
        localStorage.setItem("last360VideoUrl", streamData.video);
        if (window.parent) window.parent.postMessage("video360-ready", "*");
      } catch (e) {
        console.warn("localStorage保存失敗", e);
      }
    } else {
      if (!streamData.audio) throw new Error("音声URLが取得できません");
      attachAudio(`/proxy?url=${encodeURIComponent(streamData.audio)}`);
      syncVideoAudio();
    }
  }
  // ── official ──
  else if (targetMode === "official") {
    throw new Error("official はこのプレイヤーでは直接再生できません");
  }
  // ── default / 360 ──
  else {
    const apiEndpoint = targetMode === "360" ? "/video360" : "/video";
    const res = await fetch(`${apiEndpoint}?id=${videoId}`);
    if (!res.ok) throw new Error(`yt-dlp APIエラー: ${res.status}`);
    streamData = await res.json();

    if (!streamData.video) throw new Error("動画URLが取得できません");

    videoEl.src = `/proxy?url=${encodeURIComponent(streamData.video)}`;

    if (targetMode === "360") {
      detachAudio();
      try {
        localStorage.setItem("last360VideoUrl", streamData.video);
        if (window.parent) window.parent.postMessage("video360-ready", "*");
      } catch (e) {
        console.warn("localStorage保存失敗", e);
      }
    } else {
      if (!streamData.audio) throw new Error("音声URLが取得できません");
      attachAudio(`/proxy?url=${encodeURIComponent(streamData.audio)}`);
      syncVideoAudio();
    }
  }
}

// ==================== 動画読み込み（フォールバック付き） ====================
async function loadVideoWithFallback() {
  const order = buildAttemptOrder(mode);
  console.log(`[playwatch] 試行順序:`, order);

  const MAX_ATTEMPTS = order.length + 8;
  let attempts = 0;
  let index = 0;
  const originalMode = mode;

  while (attempts < MAX_ATTEMPTS) {
    const targetMode = order[index];
    attempts++;
    console.log(`[playwatch] 試行 ${attempts}: ${targetMode}`);

    try {
      await tryLoadWithMode(targetMode);
      console.log(`[playwatch] 成功: ${targetMode}`);
      if (loadingEl) loadingEl.style.display = "none";

      // googlevideo.com ブロック検知をセット
      setupGooglevideoBlockDetector(targetMode);

      // 最初のモードと違うモードで成功した場合のみトースト表示
      if (targetMode !== originalMode) {
        showModeToast(
          `再生方法を「${modeLabel(targetMode)}」に切り替えました`
        );
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
  if (errorEl) {
    errorEl.innerHTML = message;
    errorEl.style.display = "block";
  }
}

// ==================== エントリーポイント ====================
if (!videoId) {
  showError("動画IDが指定されていません");
} else {
  loadVideoWithFallback();
}

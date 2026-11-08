// js/playwatch.js

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") || "default";
const videoId = params.get("id");

const videoEl = document.getElementById("video");
const audioEl = document.getElementById("audio");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error-message");

// ==================== フォールバック順序の定義 ====================
// 各モードから「失敗したときに次に試すモード」の順序リスト
// 末尾まで行ったら API1系（api1-original2 ⇄ api1-original1）をループする
const FALLBACK_CHAINS = {
  "official":       ["api1-original2", "api1-original1"],
  "api1-original2": ["api1-original1"],
  "api1-original1": ["api1-original2"],
  "api2-original1": ["api2-original2", "api1-original2", "api1-original1"],
  "api2-original2": ["api2-original1", "api1-original2", "api1-original1"],
};

// API1系ループ（末尾まで行ったあとに交互に試す）
const API1_LOOP = ["api1-original2", "api1-original1"];

// 現在のモードから始まる「試行順序」を組み立てる
function buildAttemptOrder(startMode) {
  const chain = FALLBACK_CHAINS[startMode];

  // チェーン未定義（"default", "360" など）→ そのモード単体のみ
  if (!chain) {
    return [startMode];
  }

  // 開始モード + フォールバックチェーン
  const order = [startMode, ...chain];

  // 末尾がAPI1系ループ（交互）で終わっているか判定
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

// ==================== モードごとのAPIフィルタ設定 ====================
const API_FILTERS = {
  "api1-high": [
    "/.netlify/functions",
  ],
};

function filterApiList(apiList, mode) {
  const patterns = API_FILTERS[mode];
  if (!patterns || patterns.length === 0) {
    return apiList;
  }
  const filtered = apiList.filter(url =>
    patterns.some(pattern => url.includes(pattern))
  );
  if (filtered.length === 0) {
    console.warn(`モード「${mode}」に一致するAPIが無いため、全APIにフォールバックします`);
    return apiList;
  }
  return filtered;
}

// ==================== API.jsonからAPIリストを取得 ====================
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

// ==================== 最速APIで動画情報を取得（レース） ====================
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
// audioEl を remove() すると、その後 api1-original1 に戻ったときに
// audioEl が DOM に存在せずエラーになるため、src クリアで対応する
function detachAudio() {
  if (!audioEl) return;
  try { audioEl.pause(); } catch (e) {}
  audioEl.removeAttribute('src');
  try { audioEl.load(); } catch (e) {}
  audioEl.style.display = 'none';
}

function attachAudio(src) {
  if (!audioEl) return;
  audioEl.style.display = 'none'; // 音声のみなので非表示のまま
  audioEl.src = src;
}

// ==================== 単一モードで動画を読み込む ====================
// 成功したら true、失敗したら例外を投げる（呼び出し側で catch）
async function tryLoadWithMode(targetMode) {
  let streamData;

  // ── 1. API1系（API.jsonから動的に取得） ──
  if (targetMode === "api1-original1" || targetMode === "api1-original2") {
    // 既存コードの mode 名 "api1-high"/"api1-prog" に変換
    const apiMode = targetMode === "api1-original1" ? "api1-high" : "api1-prog";
    const data = await fetchFastestApi(videoId, apiMode);

    if (targetMode === "api1-original1") {
      // 高画質：adaptive video + audio を分離
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
      // api1-original2：音声込み（progressive）
      const prog = data.formatStreams?.find(f =>
        f.type?.includes("video/mp4") && (f.qualityLabel?.includes("360") || f.itag === 18)
      ) || data.formatStreams?.[0];

      if (!prog?.url) throw new Error("音声込みストリームが見つかりません");
      videoEl.src = prog.url;
      detachAudio();
    }
  }
  // ── 2. API2系（yt-dlp モード） ──
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
  // ── 3. official（YouTube埋め込み） ──
  else if (targetMode === "official") {
    // このファイル（playwatch.js）はYouTube iframeを扱わないため、
    // officialは「メタデータ取得の成否」だけ確認して、成功扱いにする。
    // （実際の公式プレイヤー切り替えは main.js 側の iframe が担当）
    throw new Error("official はこのプレイヤーでは直接再生できません");
  }
  // ── 4. その他（default / 360 など、従来のyt-dlpモード） ──
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

  // API1系ループは無限に続くので、安全のため最大試行回数を設定
  const MAX_ATTEMPTS = order.length + 8; // ループ分の余裕
  let attempts = 0;
  let index = 0;

  while (attempts < MAX_ATTEMPTS) {
    const targetMode = order[index];
    attempts++;
    console.log(`[playwatch] 試行 ${attempts}: ${targetMode}`);

    try {
      await tryLoadWithMode(targetMode);
      console.log(`[playwatch] 成功: ${targetMode}`);
      if (loadingEl) loadingEl.style.display = "none";
      return; // 成功したら終了
    } catch (err) {
      console.warn(`[playwatch] 失敗: ${targetMode} → ${err.message}`);

      // 次へ進む
      index++;

      // 末尾まで行ったらAPI1ループに突入
      if (index >= order.length) {
        const lastTwo = order.slice(-2);
        const inApi1Loop =
          lastTwo.length === 2 &&
          API1_LOOP.includes(lastTwo[0]) &&
          API1_LOOP.includes(lastTwo[1]) &&
          lastTwo[0] !== lastTwo[1];

        if (inApi1Loop) {
          // 最後に試したAPI1の「もう一方」から再開
          const lastTried = order[order.length - 1];
          const otherApi1 = API1_LOOP.find(m => m !== lastTried) || API1_LOOP[0];
          order.push(otherApi1);
        } else {
          order.push(...API1_LOOP);
        }
      }
    }
  }

  // 最大試行回数に達した
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

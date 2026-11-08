const PIPED_API_BASE = '/piped';
const INVIDIOUS_API_BASE = '/invidious'

const MAX_RESULTS = 12;
const el = id => document.getElementById(id);
const app = el('app');
const searchInput = el('searchInput');
const homeBtn = el('homeBtn');

let channelThumbCache = {};
let homeLoading = false;
let observerMap = new Map();


let commentsPageToken = {};

function fmtNum(n) {
  if (n == null || isNaN(n)) return '0';
  n = Number(n);

  return n.toLocaleString('en-US');
}

function timeAgo(dateStr){
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const s = Math.floor((Date.now()-d.getTime())/1000);
  if(s<60) return s + '秒前';
  if(s<3600) return Math.floor(s/60)+'分前';
  if(s<86400) return Math.floor(s/3600)+'時間前';
  if(s<2592000) return Math.floor(s/86400)+'日前';
  if(s<31536000) return Math.floor(s/2592000)+'ヶ月前';
  return Math.floor(s/31536000)+'年以上前';
}

// ─────────────────────────────────────────────
// 生fetch（タイムアウト付き）
// ─────────────────────────────────────────────
async function rawFetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// Invidious → Piped 形式に正規化
// ─────────────────────────────────────────────
function normalizeInvidious(endpoint, data) {
  // ── 検索 / トレンド（配列）
  if (endpoint.startsWith('/trending') || endpoint.startsWith('/search')) {
    const arr = Array.isArray(data) ? data : (data.items || data.videos || []);
    return arr.map(v => {
      const vid = v.videoId || '';
      return {
        url: `/watch?v=${vid}`,
        title: v.title || '',
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        uploaderName: v.author || '',
        uploaderUrl: `/channel/${v.authorId || ''}`,
        views: v.viewCount || 0,
        uploaded: v.published ? new Date(v.published * 1000).toISOString() : '',
        uploadedDate: v.published ? new Date(v.published * 1000).toISOString() : '',
        duration: v.lengthSeconds || 0,
        shortDescription: v.description || ''
      };
    });
  }

  // ── チャンネル
if (endpoint.startsWith('/channel/')) {
  const vids = (data.latestVideos || []).map(v => {
      const vid = v.videoId || '';
      return {
        url: `/watch?v=${vid}`,
        title: v.title || '',
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        uploaderName: v.author || data.author || '',
        uploaderUrl: `/channel/${v.authorId || data.authorId || ''}`,
        views: v.viewCount || 0,
        uploaded: v.published ? new Date(v.published * 1000).toISOString() : '',
        uploadedDate: v.published ? new Date(v.published * 1000).toISOString() : ''
      };
    });
  return {
    name: data.author || '',
    description: data.description || '',
    avatarUrl: toYt3Avatar(data.authorThumbnails?.slice(-1)[0]?.url || '', 176),
    subscriberCount: data.subCount || 0,
    relatedStreams: vids,
    videos: vids
  };
}

  // ── コメント
  if (endpoint.startsWith('/comments/')) {
    return {
      comments: (data.comments || []).map(c => ({
        author: c.author || '',
        thumbnail: c.authorThumbnails?.[0]?.url || '',
        commentText: c.content || '',
        commentedTime: c.publishedText || '',
        likeCount: c.likeCount || 0
      })),
      nextpage: data.continuation || null
    };
  }

  // ── 動画詳細
  if (endpoint.startsWith('/streams/')) {
    const vid = endpoint.split('/').pop();
    return {
      title: data.title || '',
      description: data.description || '',
      viewCount: data.viewCount || 0,
      likeCount: data.likeCount || 0,
      published: data.published ? new Date(data.published * 1000).toISOString() : '',
      uploader: data.author || '',
      channelId: data.authorId || '',
      uploaderAvatar: data.authorThumbnails?.slice(-1)[0]?.url || '',
      thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      lengthSeconds: data.lengthSeconds || 0,
      formatStreams: data.formatStreams || [],
      adaptiveFormats: data.adaptiveFormats || [],
      relatedStreams: (data.recommendedVideos || []).map(v => ({
        url: `/watch?v=${v.videoId}`,
        title: v.title,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        uploaderName: v.author,
        uploaderUrl: `/channel/${v.authorId}`,
        views: v.viewCount,
        uploaded: v.published ? new Date(v.published * 1000).toISOString() : ''
      }))
    };
  }

  return data;
}

// ─────────────────────────────────────────────
// Piped と Invidious を並列で叩いて先勝ち採用
// ─────────────────────────────────────────────
async function pipedFetch(endpoint, params = {}) {
  const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const qs = new URLSearchParams(params).toString();
  const full = qs ? `${path}?${qs}` : path;

  const pipedUrl = `${PIPED_API_BASE}${full}`;
  const invUrl   = `${INVIDIOUS_API_BASE}${full}`;

  try {
    const result = await Promise.any([
      rawFetchJson(pipedUrl, 12000).then(data => ({ source: 'piped', data })),
      rawFetchJson(invUrl,   12000).then(data => ({
        source: 'invidious',
        data: normalizeInvidious(endpoint, data)
      }))
    ]);

    console.log(`[pipedFetch] ${endpoint} → ${result.source} 成功`);
    return result.data;

  } catch (e) {
    console.error(`[pipedFetch] ${endpoint} → 全滅:`, e.message);
    throw new Error('Piped / Invidious の両方で取得に失敗しました');
  }
}

// ─────────────────────────────────────────────
// チャンネルアイコンURLを yt3.ggpht.com に変換
// ─────────────────────────────────────────────
function toYt3Avatar(url, size = 88) {
  if (!url || typeof url !== 'string') return '';

  if (url.startsWith('data:')) return '';

  try {
    if (url.includes('yt3.ggpht.com')) {
      return url.replace(/=s\d+[^=]*$/, `=s${size}-c-k-c0x00ffffff-no-rj`);
    }

    const u = new URL(url, location.origin);

    const ytcIndex = u.pathname.indexOf('/ytc/');
    if (ytcIndex !== -1) {
      const ytcPath = u.pathname.slice(ytcIndex);
      const query = u.search || '';
      return `https://yt3.ggpht.com${ytcPath}${query}`;
    }

    if (url.includes('ggpht.com') || url.includes('googleusercontent.com')) {
      return `https://yt3.ggpht.com${u.pathname}${u.search}`;
    }

    return '';
  } catch (e) {
    console.warn('toYt3Avatar failed:', url, e);
    return '';
  }
}

async function getChannelThumbPiped(channelId) {
  if (channelThumbCache[channelId]) return channelThumbCache[channelId];
  try {
    const data = await pipedFetch(`/channel/${channelId}`);
    const rawThumb = data.avatarUrl || '';
    const thumb = toYt3Avatar(rawThumb, 88);
    channelThumbCache[channelId] = thumb;
    return thumb;
  } catch (e) {
    console.warn('channel thumb failed', e);
    return '';
  }
}

window.addEventListener('hashchange', renderByHash);
homeBtn.addEventListener('click', () => { location.hash = ''; });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performSearch(searchInput.value.trim());
});
renderByHash();

function renderByHash() {
  const h = location.hash.slice(1);

  document.body.classList.remove('watch-page');

  if (!h) {
    renderHome();
    toggleFixedSidebar(true);
  } else {
    const [k, v] = h.split('=');
    if (k === 'watch') {
      renderWatch(v);
      document.body.classList.add('watch-page');
      toggleFixedSidebar(false);
    } else if (k === 'channel') {
      renderChannel(v);
      toggleFixedSidebar(true);
    } else if (k === 'search') {
      searchInput.value = decodeURIComponent(v || '');
      performSearch(decodeURIComponent(v || ''));
      toggleFixedSidebar(true);
    } else if (k === 'games') {
      renderGames();
      toggleFixedSidebar(true);
    } else if (k === 'tools') {
      renderTools();
      toggleFixedSidebar(true);
    } else if (k === 'history') {
      renderHistory();
      toggleFixedSidebar(true);
    } else if (k === 'settings') {
      renderSettings();
      toggleFixedSidebar(true);
    } else if (k === 'about') {
      renderAbout();
      toggleFixedSidebar(true);
    } else if (k === 'contact') {
      renderContact();
      toggleFixedSidebar(true);
    } else {
      renderHome();
      toggleFixedSidebar(true);
    }
  }
}


function renderHome() {
  app.innerHTML = `
    <section id="homeSection">
      <div style="margin:16px 0 8px; font-weight:700; font-size:20px; color:#0f0f0f;">
        おすすめ
      </div>

      <div class="video-grid" id="videoGrid"></div>

      <!-- 統計表示ブロック -->
      <div id="statsBlock" style="
        margin: 1px auto 3px;
        max-width: 10000px;
        padding: 24px 16px;
        background: linear-gradient(135deg, #f8f9fa, #ffffff);
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        text-align: center;
      ">

        <div style="
          display: flex;
          justify-content: center;
          gap: 60px;
          flex-wrap: wrap;
        ">

          <!-- 総合アクセス数 -->
          <div style="min-width: 140px;">
            <div id="totalViews" style="
              font-size: 36px;
              font-weight: 800;
              color: #065fd4;
              line-height: 1.1;
            ">---</div>
            <div style="
              margin-top: 6px;
              font-size: 14px;
              color: #606060;
            ">総合アクセス数</div>
          </div>

          <!-- 今日のアクセス数 -->
          <div style="min-width: 140px;">
            <div id="todayViews" style="
              font-size: 36px;
              font-weight: 800;
              color: #065fd4;
              line-height: 1.1;
            ">---</div>
            <div style="
              margin-top: 6px;
              font-size: 14px;
              color: #606060;
            ">今日のアクセス数</div>
          </div>

        </div>

       <h3 style="
  margin: 15px 0 0;
  font-size: 18px;
  font-weight: 700;
  color: #6c6c6c;
">ⓒ K-tube　V.2.32</h3>

<div style="margin-top: 20px; font-size: 15px; color: #065fd4; text-align: center;">
  <span id="aboutLink" style="cursor: pointer; margin: 0 16px; text-decoration: underline; transition: color 0.2s;">K-tubeについて</span>
  <span id="contactLink" style="cursor: pointer; margin: 0 16px; text-decoration: underline; transition: color 0.2s;">お問い合わせ</span>
</div>
      <div id="homeSentinel" style="height:0px"></div>



      
    </section>
  `;


 
  loadHome();
  loadStats();   


document.getElementById('aboutLink')?.addEventListener('click', () => {
  location.hash = 'about';
});

document.getElementById('contactLink')?.addEventListener('click', () => {
  location.hash = 'contact';
});
 
}



async function loadHome() {
  if (homeLoading) return;
  homeLoading = true;
  const grid = el('videoGrid');
  try {
    const data = await pipedFetch('/trending', { region: 'JP' });
    for (const item of data || []) {
      const card = await makeVideoCard(item);
      grid.appendChild(card);
    }
  } catch (e) {
    console.error(e);
    grid.innerHTML += `<div style="color:#c00; padding:16px; text-align:center;">
      読み込み失敗: ${escapeHtml(e.message)}
    </div>`;
  } finally {
    homeLoading = false;
  }
}

// 動画カード作成
async function makeVideoCard(item) {
  const vid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
  const title = item.title || '';
  
const th = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  const chId = item.uploaderUrl?.split('/').pop() || '';
  const chTitle = item.uploaderName || '';
  const views = item.views || 0;
  const publishedAt = item.uploadedDate || item.uploaded || '';
  const channelThumb = await getChannelThumbPiped(chId);

  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `
    <div class="thumb" data-vid="${vid}">
      <img src="${th}" alt="">
    </div>
    <div class="meta">
      <div class="channel-thumb"><img src="${channelThumb}" alt=""></div>
      <div class="info">
        <div class="title">${escapeHtml(title)}</div>
        <div class="sub">
          <a href="#channel=${chId}" data-channel="${chId}" class="ch-link">${escapeHtml(chTitle)}</a>
          ・ ${fmtNum(views)} 回視聴 ・ ${timeAgo(publishedAt)}
        </div>
      </div>
    </div>
  `;

  div.querySelector('.thumb').addEventListener('click', () => {
    location.hash = `watch=${vid}`;
  });

  div.querySelector('.ch-link').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `channel=${chId}`;
  });

  return div;
}




async function loadStats() {
  try {
    const res = await fetch('/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json();

    const onlineEl  = document.getElementById('onlineNow');
    const totalEl   = document.getElementById('totalViews');
    const todayEl   = document.getElementById('todayViews');

    if (onlineEl)  onlineEl.textContent  = fmtNum(data.online_now  || 0);
    if (totalEl)   totalEl.textContent   = fmtNum(data.total_views || 0);
    if (todayEl)   todayEl.textContent   = fmtNum(data.today_views  || 0);
  } catch (err) {
    console.warn('統計読み込みエラー:', err);
  
  }
}

      async function performSearch(q) {
        if (!q) return renderHome();
        location.hash = `search=${encodeURIComponent(q)}`;
        app.innerHTML = `
          <section>
            <div style="margin:12px 0;font-weight:700;font-size:18px">検索結果: ${escapeHtml(q)}</div>
            <div class="video-grid" id="videoGrid"></div>
            <div id="searchSentinel" style="height:32px"></div>
          </section>
        `;
        const grid = el('videoGrid');
        let loading = false;
        const loadMore = async () => {
          if (loading) return;
          loading = true;
          try {
            const data = await pipedFetch('/search', { q, filter: 'videos' });
            let items = [];
            if (Array.isArray(data)) {
              items = data;
            } else if (data && typeof data === 'object') {
              items = data.items || data.results || data.videos || data || [];
            }
            for (const item of items) {
              const card = await makeVideoCard(item);
              grid.appendChild(card);
            }
          } catch (e) {
            console.error(e);
            grid.innerHTML += `<div style="color:#c00">読み込み失敗: ${escapeHtml(e.message)}</div>`;
          } finally {
            loading = false;
          }
        };
        const sentinel = el('searchSentinel');
        const io = new IntersectionObserver(entries => {
          entries.forEach(ent => { if (ent.isIntersecting) loadMore(); });
        }, { rootMargin: '400px' });
        io.observe(sentinel);
        observerMap.set('search', io);
        loadMore();
      }

async function setupComments(videoId) {
  const list = document.getElementById('commentsList');
  if (!list) {
    console.error('commentsList が見つかりません');
    return;
  }

 
  list.innerHTML = '<div style="padding: 20px; text-align: center; color: #606060;">コメントを読み込んでいます...</div>';

  commentsPageToken[videoId] = null;
  let loading = false;
  let hasMore = true;

  const loadMore = async () => {
    if (loading || !hasMore) return;
    loading = true;

    try {
      const params = { sort_by: 'top' };
      if (commentsPageToken[videoId]) {
        params.nextpage = commentsPageToken[videoId];
      }

      const res = await pipedFetch(`/comments/${videoId}`, params);
      console.log(`コメント取得 (${videoId}):`, res); 
      commentsPageToken[videoId] = res.nextpage || null;
      hasMore = !!res.nextpage && res.nextpage !== null;


      if (list.innerHTML.includes('読み込んでいます')) {
        list.innerHTML = '';
      }
     
if (res.comments && res.comments.length > 0) {
  res.comments.forEach(c => {
    const rawThumb = c.thumbnail || '';
    const proxiedThumb = toYt3Avatar(rawThumb, 40)
      || (rawThumb ? `/thumb-proxy?url=${encodeURIComponent(rawThumb)}` : '')
      || 'https://www.gstatic.com/youtube/img/no_thumbnail_140-vflXmJqzd.png';

    const div = document.createElement('div');
    div.className = 'comment';
    div.innerHTML = `
      <img src="${proxiedThumb}" alt=""
           style="width:40px; height:40px; border-radius:50%; object-fit: cover; flex-shrink:0;"
           loading="lazy"
           referrerpolicy="no-referrer"
           onerror="this.src='https://upload.wikimedia.org/wikipedia/commons/8/89/Portrait_Placeholder.png'; this.onerror=null;">
      <div class="c-body">
        <div class="name" style="display:flex; align-items:center; gap:6px; font-size:13px;">
          <span style="font-weight:500;">${escapeHtml(c.author || '匿名ユーザー')}</span>
          <span style="color:#606060; font-size:12px;">
            ${timeAgo(c.commentedTime || '')}
          </span>
        </div>
<div class="text" style="margin-top:4px; line-height:1.4; font-size:14px; white-space: pre-wrap; word-break: break-word; color:#0f0f0f;">${escapeHtml(c.commentText || '(内容がありません)')
  .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
  .replace(/\r?\n/g, '<br>')
  .replace(/^(?:\s|　|<br>)+/gi, '')
}</div>

      </div>
    `;
    list.appendChild(div);
  });
}
     
      if (list.children.length === 0 && !hasMore) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #606060; font-size:14px;">コメントは非表示に設定されているか、コメントがありません</div>';
      }

    } catch (e) {
      console.error('コメント読み込みエラー:', e);
      list.innerHTML += `<div style="color:#c00; padding:12px; font-size:14px;">コメントの読み込みに失敗しました</div>`;
    } finally {
      loading = false;
    }
  };

  
  await loadMore();


  const sentinel = document.getElementById('commentsSentinel');
  if (sentinel) {
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) {
        loadMore();
      }
    }, {
      root: document.querySelector('.comments'),
      rootMargin: '400px 0px 200px 0px'
    });
    io.observe(sentinel);
    observerMap.set(`comments_${videoId}`, io);
  }
}

async function fetchFastestNetlify(videoId) {
  try {
    const apiRes = await fetch('/API.json');
    const apiList = await apiRes.json();

    if (!Array.isArray(apiList) || apiList.length === 0) {
      throw new Error('API.json が空です');
    }


    const requests = apiList.map(base =>
      fetch(`${base}/video?v=${videoId}`)
        .then(res => {
          if (!res.ok) throw new Error('response not ok');
          return res.json();
        })
    );

    const fastest = await Promise.any(requests);
    console.log('最速API成功');
    return fastest;

  } catch (err) {
    console.warn('全API失敗:', err);
    return null;
  }
}     
     
async function renderWatch(videoId) {
  try {
    observerMap.forEach(o => o.disconnect());
    observerMap.clear();
    app.innerHTML = `<div style="padding:40px; text-align:center; color:#606060;">読み込み中...</div>`;

    let metaData = {};
    let source = "none";

   // ── メタデータ取得
    const backends = [
      { name: "K-tube API (race)", custom: () => fetchFastestNetlify(videoId) },


    ];

for (const backend of backends) {
  try {
    console.log(`Trying metadata backend: ${backend.name}`);

    let data;

    if (backend.custom) {
      data = await backend.custom();
    } else {
      const res = await fetch(backend.url(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) continue;
      data = await res.json();
    }

    if (!data || data.error || data.status === "fail") continue;

    metaData = normalizeMetadata(data, backend.name);
    source = backend.name;
    console.log(`Metadata obtained from: ${source} (成功)`);
    break;

  } catch (err) {
    console.warn(`${backend.name} failed:`, err.message);
  }
}


    if (!metaData.title) {
      try {
        const searchData = await pipedFetch('/search', { q: videoId, filter: 'videos' });
        const item = (searchData?.items || searchData || []).find(it =>
          it.url?.includes(videoId) || it.url?.includes(`v=${videoId}`)
        );
        if (item) {
          metaData = {
            title: item.title || `動画（ID: ${videoId}）`,
            description: item.shortDescription || '説明文なし',
            thumbnail: item.thumbnail || '',
            uploader: item.uploaderName || '不明',
            viewCount: item.views || 0,
            uploaded: item.uploaded || '',
            channelName: item.uploaderName || '',
            channelId: item.uploaderUrl?.split('/').pop() || '',
          };
          source = "Piped Search (minimal)";
        }
      } catch (e) {
        console.warn("最終フォールバック失敗", e);
      }
    }


    const title = metaData.title || `動画（ID: ${videoId}）`;
    const views = fmtNum(metaData.viewCount ?? metaData.views ?? 0);
    const likes = fmtNum(metaData.likeCount ?? 0);
    let uploaded = '---';
    if (metaData.published || metaData.uploadDate || metaData.uploaded) {
      try {
        uploaded = timeAgo(new Date(metaData.published || metaData.uploadDate || metaData.uploaded).toISOString());
      } catch {}
    }


    let rawDesc = metaData.description || metaData.shortDescription || '説明文は現在取得できませんでした';
    rawDesc = rawDesc.trim();
    rawDesc = rawDesc.replace(/^\s+|\s+$/g, '');
    rawDesc = rawDesc.replace(/^(?:\r\n|\r|\n|　)+/, '');
    rawDesc = rawDesc.replace(/\s{2,}/g, ' ');
    rawDesc = rawDesc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#065fd4; text-decoration:underline;">$1</a>');
    const escapedDesc = rawDesc;

    let chName = metaData.uploader || metaData.author || metaData.channelName || metaData.uploaderName || '不明';
let chId = metaData.channelId || metaData.authorId || (metaData.uploaderUrl?.split('/').pop() || '');

// 初期値は metaData から（あれば）
let chThumb = toYt3Avatar(
  metaData.uploaderAvatar || metaData.avatar || '',
  88
);

let subscriberCount = metaData.subscriberCount ?? 0;

// chId があれば /channel/ で必ず上書き取得（ホームと同じ経路）
if (chId) {
  try {
    const thumb = await getChannelThumbPiped(chId);
    if (thumb) {
      chThumb = thumb;
    }

    const channelData = await pipedFetch(`/channel/${chId}`);
    if (channelData) {
      if (!chName || chName === '不明') {
        chName = channelData.name || chName;
      }
      if (typeof channelData.subscriberCount === 'number' && channelData.subscriberCount > 0) {
        subscriberCount = channelData.subscriberCount;
      } else if (channelData.subscriberCount === -1 || channelData.subscriberCount === null) {
        subscriberCount = '非公開';
      }
    }
  } catch (err) {
    console.warn('チャンネル情報取得失敗:', err);
  }
}

    const chSubs = typeof subscriberCount === 'number' 
      ? fmtNum(subscriberCount) 
      : (subscriberCount === '非公開' ? '非公開' : '---');

    if (metaData.title) {
      addToHistory(videoId, metaData.title, metaData.thumbnail || '', chName, metaData.uploaderUrl || (chId ? `/channel/${chId}` : ''));
    }

    const defaultPlayer = localStorage.getItem('defaultPlayer') || 'api2-original2';

    // HTML描画 
    app.innerHTML = `
      <div class="watch-container">
        <div class="main-col">

<div class="player-box">
            <iframe id="videoIframe"
                    src="https://www.youtube.com/embed/${videoId}"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen
                    style="width:100%;height:100%;">
            </iframe>
          </div>
          <div class="player-meta">
            <h1>${escapeHtml(title)}</h1>
            <div class="stats">
              <div>${views} 回視聴</div>
              <div>・</div>
              <div>${uploaded}</div>
              <div style="margin-left:auto;font-weight:700">${likes} 👍</div>
    <select id="playerSelect">
  <option value="official" ${defaultPlayer === 'official' ? 'selected' : ''}>
    公式プレイヤー（YouTube埋め込み）
  </option>
  <option value="api1-original1" ${defaultPlayer === 'api1-original1' ? 'selected' : ''}>
    API1・オリジナル1（高画質）
  </option>
  <option value="api1-original2" ${defaultPlayer === 'api1-original2' ? 'selected' : ''}>
    API1・オリジナル2（音声込み）
  </option>
  <option value="api2-original1" ${defaultPlayer === 'api2-original1' ? 'selected' : ''}>
    API2・オリジナル1（高画質）
  </option>
  <option value="api2-original2" ${defaultPlayer === 'api2-original2' ? 'selected' : ''}>
    API2・オリジナル2（音声込み）
  </option>
</select>
            </div>
            <div class="channel-row">

            <img src="${chThumb}" alt="" onerror="this.src='https://via.placeholder.com/48?text=Ch'" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">
            <div class="ch-info">
              <div style="font-weight:700">
                <a href="#channel=${chId}" class="watch-ch-link" style="text-decoration:none;color:inherit">
                  ${escapeHtml(chName)}
                </a>
              </div>
              <div style="color:#606060;font-size:13px">${chSubs} 人の登録者</div>  
            </div>
            <button class="btn-sub" id="downloadMainBtn">ダウンロード</button>
          </div>

          <div id="descriptionArea" style="margin-top:16px; color:#333; line-height:1.5; word-break:break-word;">
            <div id="descriptionContainer" style="max-height:4.8em; overflow:hidden; transition:max-height 0.4s ease;">
              ${escapedDesc || '（説明がありません）'}
            </div>
            ${escapedDesc.length > 300 ? `
              <div style="margin-top:8px;">
                <a id="expandDesc" href="#" style="color:#065fd4; font-weight:500; cursor:pointer; text-decoration:none; display:block;">
                  もっと見る
                </a>
                <a id="collapseDesc" href="#" style="color:#065fd4; font-weight:500; cursor:pointer; text-decoration:none; display:none;">
                  折りたたむ
                </a>
              </div>
            ` : ''}
          </div>
<div class="comments" id="commentsArea">
              <h3 style="margin:24px 0 12px;">コメント</h3>
              <div id="commentsList"></div>
              <div id="commentsSentinel" style="height:32px"></div>
            </div>
          </div>
        </div>

        <aside class="side-col">
          <div style="font-weight:700; margin-bottom:12px;">次に再生</div>
          <div id="relatedList"></div>
        </aside>
      </div>
    `;


const playerSelect = document.getElementById('playerSelect');
const iframe = document.getElementById('videoIframe');

if (playerSelect && iframe) {
  const defaultPlayer = localStorage.getItem('defaultPlayer') || 'official';
  let initialSrc = `https://www.youtube.com/embed/${videoId}?rel=0`;
  let selectedValue = 'official';

  switch (defaultPlayer) {
    case 'official':
      initialSrc = `https://www.youtube.com/embed/${videoId}?rel=0`;
      selectedValue = 'official';
      break;

    case 'api1-original1':
      initialSrc = `/watch.html?id=${videoId}&mode=api1-high`;
      selectedValue = 'api1-original1';
      break;

    case 'api1-original2':
      initialSrc = `/watch.html?id=${videoId}&mode=api1-prog`;
      selectedValue = 'api1-original2';
      break;

    case 'api2-original1':
      initialSrc = `/watch.html?id=${videoId}`;
      selectedValue = 'api2-original1';
      break;

    case 'api2-original2':
      initialSrc = `/watch.html?id=${videoId}&mode=360`;
      selectedValue = 'api2-original2';
      break;

    default:

      initialSrc = `https://www.youtube.com/embed/${videoId}?rel=0`;
      selectedValue = 'official';
  }

  iframe.src = initialSrc;
  playerSelect.value = selectedValue;


  playerSelect.addEventListener('change', () => {
    const val = playerSelect.value;
    let newSrc = `https://www.youtube.com/embed/${videoId}?rel=0`;

    switch (val) {
      case 'official':
        newSrc = `https://www.youtube.com/embed/${videoId}?rel=0`;
        break;
      case 'api1-original1':
        newSrc = `/watch.html?id=${videoId}&mode=api1-high`;
        break;
      case 'api1-original2':
        newSrc = `/watch.html?id=${videoId}&mode=api1-prog`;
        break;
      case 'api2-original1':
        newSrc = `/watch.html?id=${videoId}`;
        break;
      case 'api2-original2':
        newSrc = `/watch.html?id=${videoId}&mode=360`;
        break;
    }

    iframe.src = newSrc;
  });
}
   
   // ダウンロードボタン 
const downloadBtn = document.getElementById('downloadMainBtn');
if (downloadBtn) {
  downloadBtn.classList.remove('disabled');
  downloadBtn.addEventListener('click', async () => {
    try {
     
      let videoData = null;

  
try {
  videoData = await fetchFastestNetlify(videoId);
  if (videoData) {
    console.log('ダウンロード用データ: K-tube API成功');
  }
} catch (e) {
  console.warn('K-tubeダウンロードAPI失敗:', e);
}

   
      if (!videoData) {
        const proxyRes = await fetch(`/api/v2/video?v=${videoId}`);
        if (proxyRes.ok) {
          videoData = await proxyRes.json();
          console.log('ダウンロード用データ: /api/v2/video から取得');
        }
      }


      if (!videoData) {
        throw new Error('ダウンロード用メタデータを取得できませんでした');
      }

     
      const prog = videoData.videoFormats?.find(f =>
        f.type?.includes('video/mp4') &&
        (f.qualityLabel?.includes('360') || f.itag === '18' || f.itag === 18)
      ) || videoData.formatStreams?.find(f => f.itag === '18');

      if (prog?.url) {
     
        let downloadUrl = prog.url;
        if (!downloadUrl.startsWith('http')) {
          downloadUrl = `https://splendid-jelly-e731bd.netlify.app/${downloadUrl}`;
        }
        window.open(downloadUrl, '_blank');
      } else {
        alert("ストリームが見つかりませんでした。\n他の画質を試すか、後ほどお試しください。");
      }

    } catch (e) {
      console.error('ダウンロードエラー:', e);
      alert("ダウンロードの準備に失敗しました。\nコンソールを確認するか、後ほどお試しください。");
    }
  });
}


    const watchChLink = app.querySelector('.watch-ch-link');
    if (watchChLink) {
      watchChLink.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (chId) location.hash = `channel=${chId}`;
      });
    }   


    const commentsArea = document.getElementById('commentsArea');
    if (commentsArea) setupComments(videoId);

 
  const relatedList = document.getElementById('relatedList');
if (relatedList) {
  relatedList.innerHTML = '<div style="padding:20px; text-align:center; color:#606060;">読み込み中...</div>';

  try {
    let items = [];

    // 🔥 強化検索クエリ
    let searchQuery = metaData.title || videoId;

    if ((metaData.uploader || metaData.uploaderName)) {
      searchQuery += ' ' + (metaData.uploader || metaData.uploaderName);
    }

    // ① 1回目検索（多めに取得）
    const relatedData = await pipedFetch('/search', {
      q: searchQuery,
      filter: 'videos'
    });

    items = Array.isArray(relatedData) ? relatedData :
            (relatedData?.items || relatedData?.results || relatedData?.videos || []);

    // 🔥 型フィルタ + 重複排除
    items = items.filter(item => {
      const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
      return relVid && relVid !== videoId;
    });

    // ② 足りなければタイトルのみで再検索
    if (items.length < 6) {
      const fallback = await pipedFetch('/search', {
        q: metaData.title || videoId
      });

      let more = Array.isArray(fallback) ? fallback :
                 (fallback?.items || fallback?.results || fallback?.videos || []);

      more = more.filter(item => {
        const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
        return relVid && relVid !== videoId;
      });

      items = [...items, ...more];
    }

    // 🔥 重複動画ID削除
    const seen = new Set();
    items = items.filter(item => {
      const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
      if (seen.has(relVid)) return false;
      seen.add(relVid);
      return true;
    });

    // 🔥 最低6件保証
    const finalItems = items.slice(0, 6);

    if (finalItems.length) {
      relatedList.innerHTML = '';

      finalItems.forEach(item => {
        const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
        const thumb = `https://i.ytimg.com/vi/${relVid}/hqdefault.jpg`;

        const div = document.createElement('div');
        div.className = 'related-item';
        div.innerHTML = `
          <div class="related-thumb">
            <img src="${thumb}" alt="" loading="lazy" decoding="async"
              onerror="this.src='https://i.ytimg.com/vi/${relVid}/mqdefault.jpg'">
          </div>
          <div class="related-info">
            <div class="title">${escapeHtml(item.title || '(タイトルなし)')}</div>
            <div style="color:#606060;font-size:13px">
              ${escapeHtml(item.uploaderName || item.uploader || '不明')} ・ ${fmtNum(item.views || 0)} 回
            </div>
          </div>
        `;
        div.addEventListener('click', () => location.hash = `watch=${relVid}`);
        relatedList.appendChild(div);
      });

    } else {
      relatedList.innerHTML = '<div style="padding:20px; color:#606060;">関連動画が見つかりませんでした</div>';
    }

  } catch (e) {
    console.error('関連動画取得失敗:', e);
    relatedList.innerHTML = '<div style="padding:20px; color:#c00;">関連動画の読み込みに失敗しました</div>';
  }
}
    
    setTimeout(() => {
      const container = document.getElementById('descriptionContainer');
      const expandLink = document.getElementById('expandDesc');
      const collapseLink = document.getElementById('collapseDesc');

      if (container && expandLink) {
        expandLink.addEventListener('click', e => {
          e.preventDefault();
          container.style.maxHeight = 'none';
          expandLink.style.display = 'none';
          if (collapseLink) collapseLink.style.display = 'block';
        });
      }

      if (collapseLink) {
        collapseLink.addEventListener('click', e => {
          e.preventDefault();
          container.style.maxHeight = '4.8em';
          collapseLink.style.display = 'none';
          if (expandLink) expandLink.style.display = 'block';
        });
      }
    }, 300);

  } catch (fatalErr) {
    console.error('renderWatch 全体エラー:', fatalErr);
    app.innerHTML = `
      <div style="padding:40px; text-align:center; color:#c00;">
        <h2>再生ページの読み込みに失敗しました</h2>
        <p>${escapeHtml(fatalErr.message || '不明なエラー')}</p>
        <p style="margin-top:16px;">
          公式YouTubeプレイヤーなら再生できる可能性があります。<br>
          <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" style="color:#065fd4;">YouTubeで開く</a>
        </p>
      </div>
    `;
  }
}
     
 function normalizeMetadata(data, source) {
  // パターンB（独自形式）の channel オブジェクトを展開
  const ch = data.channel || {};

  // viewCount が "29,415,176回視聴" のような文字列の場合、数値に変換
  function parseViewCount(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return 0;
    // "29,415,176回視聴" → 29415176
    const cleaned = v.replace(/[^\d]/g, '');
    return cleaned ? parseInt(cleaned, 10) : 0;
  }

  // likeCount も同様
  function parseLikeCount(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return 0;
    const cleaned = v.replace(/[^\d]/g, '');
    return cleaned ? parseInt(cleaned, 10) : 0;
  }

  // published が数値（UNIX秒）か文字列かを判定
  function parsePublished(v) {
    if (!v) return '';
    if (typeof v === 'number') {
      return new Date(v * 1000).toISOString();
    }
    if (typeof v === 'string') {
      // "2024/10/16" のような形式
      const d = new Date(v.replace(/\//g, '-'));
      if (!isNaN(d.getTime())) return d.toISOString();
      return v;
    }
    return '';
  }

  return {
    title: data.title || data.name || '',
    description: data.description || data.desc || data.shortDescription || '',
    viewCount: parseViewCount(data.viewCount || data.views || data.view_count || 0),
    likeCount: parseLikeCount(data.likeCount || data.likes || 0),
    published: parsePublished(data.published || data.uploadDate || data.uploaded || data.dateText || data.released || ''),
    
    // パターンA（Invidious形式）とパターンB（独自形式）の両方に対応
    uploader: data.uploader || data.author || data.channelName || ch.name || '',
    channelId: data.channelId || data.authorId || ch.id || '',
    uploaderAvatar: data.uploaderAvatar || data.avatar || data.authorThumbnails?.slice(-1)[0]?.url || ch.avatar || '',
    
    thumbnail: data.thumbnail || data.videoThumbnails?.find(t => t.quality === 'maxres')?.url || data.videoThumbnails?.[0]?.url || '',
    lengthSeconds: data.lengthSeconds || data.duration || 0,
    
    // 登録者数（パターンBは "チャンネル登録者数 334万人" のような文字列）
    subscriberCount: (() => {
      if (typeof data.subscriberCount === 'number') return data.subscriberCount;
      if (typeof data.subCount === 'number') return data.subCount;
      const subsStr = data.subs || ch.subs || data.subCountText || '';
      if (!subsStr) return 0;
      // "4.55M" → 4550000、"チャンネル登録者数 334万人" → 3340000
      const m = subsStr.match(/([\d.,]+)\s*([万億MKB]?)/);
      if (!m) return 0;
      const num = parseFloat(m[1].replace(/,/g, ''));
      const unit = m[2];
      if (unit === '万') return Math.round(num * 10000);
      if (unit === '億') return Math.round(num * 100000000);
      if (unit === 'M') return Math.round(num * 1000000);
      if (unit === 'K') return Math.round(num * 1000);
      if (unit === 'B') return Math.round(num * 1000000000);
      return Math.round(num);
    })(),
    
    formatStreams: data.formatStreams || data.videoFormats || [],
    adaptiveFormats: data.adaptiveFormats || [],
    relatedStreams: data.related || data.recommendedVideos || [],
    source
  };
}

      async function renderChannel(channelId) {
        app.innerHTML = `<div>チャンネル読み込み中…</div>`;
        try {
          const data = await pipedFetch(`/channel/${channelId}`);
          if (!data || !data.name) throw new Error('チャンネルが見つかりません');
          const title = data.name;
          const desc = data.description || '';
          const thumb = toYt3Avatar(data.avatarUrl || '', 176);
          const subs = data.subscriberCount || 0;
          app.innerHTML = `
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
              <img src="${thumb}" style="width:88px;height:88px;border-radius:50%">
              <div>
                <div style="font-weight:700;font-size:18px">${escapeHtml(title)}</div>
                <div style="color:#606060">${fmtNum(subs)} 人の登録者</div>
                <div style="margin-top:8px"><button class="btn-sub">登録</button></div>
              </div>
            </div>
            <div style="font-size:13px;color:#333;margin-bottom:12px">${escapeHtml(desc).slice(0,500)}${desc.length>500?'…':''}</div>
            <div style="font-weight:700;margin:12px 0">動画</div>
            <div class="video-grid" id="channelVideos"></div>
            <div id="channelSentinel" style="height:32px"></div>
          `;
const grid = el('channelVideos');
let loading = false;
const loadMore = async () => {
  if (loading) return;
  loading = true;
  try {
    let rawVideos = [];
    let chData = null;

    // ① まず pipedFetch（Piped/Invidious 並列レース）
    chData = await pipedFetch(`/channel/${channelId}`);
    rawVideos =
      chData.relatedStreams ||
      chData.latestVideos ||
      chData.videos ||
      [];

    // ② Piped が勝って relatedStreams が空の場合、Invidious を直接叩く
    if (rawVideos.length === 0) {
      console.warn(`[renderChannel] ${channelId} 動画0件 → Invidious 直接取得へ`);
      try {
        const invData = await rawFetchJson(`/invidious/channel/${channelId}`, 12000);
        const normalized = normalizeInvidious(`/channel/${channelId}`, invData);
        rawVideos =
          normalized.relatedStreams ||
          normalized.latestVideos ||
          normalized.videos ||
          [];
        console.log(`[renderChannel] Invidious 直接取得: ${rawVideos.length}件`);
      } catch (e) {
        console.warn('[renderChannel] Invidious 直接取得も失敗:', e.message);
      }
    }

    // ③ Piped の nextpage トークンで追加取得（両方空だった場合の保険）
    if (rawVideos.length === 0 && chData?.nextpage) {
      try {
        const nextData = await pipedFetch(`/nextpage/channel/${channelId}`, {
          nextpage: chData.nextpage
        });
        rawVideos = nextData.relatedStreams || nextData.videos || [];
        console.log(`[renderChannel] nextpage 取得: ${rawVideos.length}件`);
      } catch (e) {
        console.warn('[renderChannel] nextpage 取得失敗:', e.message);
      }
    }

    console.log(`[renderChannel] ${channelId} 最終動画数:`, rawVideos.length);

    if (rawVideos.length === 0) {
      grid.innerHTML += `<div style="padding:20px;color:#606060;">このチャンネルの動画を取得できませんでした</div>`;
      return;
    }

    for (const v of rawVideos) {
      const card = await makeVideoCard(v);
      grid.appendChild(card);
    }
  } catch (e) {
    console.error('チャンネル動画取得エラー:', e);
    grid.innerHTML += `<div style="color:#c00">読み込み失敗: ${escapeHtml(e.message)}</div>`;
  } finally {
    loading = false;
  }
};
          const sentinel = el('channelSentinel');
          const io = new IntersectionObserver(entries => {
            entries.forEach(ent => { if (ent.isIntersecting) loadMore(); });
          }, { rootMargin: '400px' });
          io.observe(sentinel);
          observerMap.set(`channel_${channelId}`, io);
          loadMore();
        } catch (e) {
          app.innerHTML = `<div style="color:#c00">チャンネル読み込み失敗: ${escapeHtml(e.message)}</div>`;
        }
      }

      function escapeHtml(s = '') {
        return String(s)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }


window.addEventListener('load', () => {
  fetch('/fake-views?times=1')
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP エラー: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      console.log('ページオープン時に自動でアクセス数 +1 しました', data);
      loadStats();  
    })
    .catch(err => {
      console.error('自動 +1 に失敗:', err);
    });
});

// =============================================
// 固定サイドバー開閉（Vercel版と同じ挙動）
// =============================================
const menuBtn = document.getElementById('menuBtn');

function toggleFixedSidebar(show = null) {
  const fixedSidebar = document.getElementById('sidebarFixed');
  const contentMain = document.querySelector('.content-main');
  if (!fixedSidebar || !contentMain) return;

  if (show === true) {
    fixedSidebar.classList.remove('hidden');
  } else if (show === false) {
    fixedSidebar.classList.add('hidden');
  } else {
    fixedSidebar.classList.toggle('hidden');
  }

  if (fixedSidebar.classList.contains('hidden')) {
    contentMain.style.setProperty('margin-left', '0', 'important');
    document.body.classList.add('sidebar-hidden');
  } else {
    contentMain.style.setProperty('margin-left', '72px', 'important');
    document.body.classList.remove('sidebar-hidden');
  }
}

if (menuBtn) {
  menuBtn.addEventListener('click', () => toggleFixedSidebar());
}

window.addEventListener('DOMContentLoaded', () => {
  toggleFixedSidebar(true);
});

// =============================================
// サイドバー active 状態更新
// =============================================
function updateSidebarActive() {
  const hash = location.hash.slice(1);
  const items = document.querySelectorAll('.sidebar-item');

  items.forEach(item => {
    item.classList.remove('active');

    const target = item.dataset.target;

    if (!hash) {
      if (target === 'home') item.classList.add('active');
    }
    else if (hash === 'games' && target === 'games') {
      item.classList.add('active');
    }
    else if (hash === 'tools' && target === 'tools') {
      item.classList.add('active');
    }
    else if (hash === 'history' && target === 'history') {
      item.classList.add('active');
   } else if (hash === 'settings' && target === 'settings') { 
      item.classList.add('active');
     
    }
    
  });
}


window.addEventListener('load', () => {
  const darkMode = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark-mode', darkMode);
  
});

window.addEventListener('hashchange', updateSidebarActive);
window.addEventListener('load', updateSidebarActive);


document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    const target = item.dataset.target;

    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    if (target === 'home') {
      location.hash = '';
    } else if (target === 'games') {
      location.hash = 'games';
      renderGames();
    } else if (target === 'tools') {
      location.hash = 'tools';
      renderTools();
    } else if (target === 'history') {
      location.hash = 'history';
      renderHistory();
    } else if (target === 'settings') {          
      location.hash = 'settings';
      renderSettings();
    }

    toggleFixedSidebar(false);
  });
});


function renderGames() {
  app.innerHTML = `
    <section id="gamesSection">
      <div style="margin:16px 0 8px; font-weight:700; font-size:20px; color:#0f0f0f;">
        ゲーム
      </div>
      <div class="video-grid" id="gameGrid"></div>
    </section>
  `;
  loadGames();
}

function renderTools() {
  app.innerHTML = `
    <section id="toolsSection">
      <div style="margin:16px 0 8px; font-weight:700; font-size:20px; color:#0f0f0f;">
        ツール
      </div>
      <div class="video-grid" id="toolGrid"></div>
    </section>
  `;
  loadTools();
}


function renderHistory() {
  app.innerHTML = `
    <section>
      <div style="margin:16px 0 8px; font-weight:700; font-size:20px; color:#0f0f0f; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        再生履歴
        <button id="clearHistoryBtn" style="padding:8px 16px; background:#dc3545; color:white; border:none; border-radius:20px; cursor:pointer; font-weight:600; white-space:nowrap;">
          すべてクリア
        </button>
      </div>

      <div class="video-grid" id="historyGrid"></div>
      <div id="historyEmpty" style="display:none; padding:60px 20px; text-align:center; color:#606060; font-size:16px;">
        まだ視聴履歴がありません
      </div>
    </section>
  `;

  const grid = document.getElementById('historyGrid');
  const emptyMsg = document.getElementById('historyEmpty');
  const history = getHistory();

  if (history.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }

  history.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="thumb" data-vid="${item.videoId}">
        <img src="https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg"
     alt="${escapeHtml(item.title)}"
     loading="lazy"
     onerror="this.src='https://via.placeholder.com/320x180?text=No+Thumb';">
      </div>
      <div class="meta">
        <div class="info">
          <div class="title" style="display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${escapeHtml(item.title)}</div>
          <div class="sub">
            ${escapeHtml(item.uploaderName)} ・ ${timeAgo(item.watchedAt)}
          </div>
        </div>
      </div>
    `;

    card.querySelector('.thumb').addEventListener('click', () => {
      location.hash = `watch=${item.videoId}`;
    });

    grid.appendChild(card);
  });

  
  const clearBtn = document.getElementById('clearHistoryBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('すべての再生履歴を削除してもよろしいですか？')) {
        clearHistory();
      }
    });
  }
}    


const HISTORY_KEY = 'kTube_watch_history';
const MAX_HISTORY = 50;  

function addToHistory(videoId, title, thumbnail, uploaderName, uploaderUrl) {
  if (!videoId || !title) return;

  let history = getHistory();

 
  history = history.filter(item => item.videoId !== videoId);


  history.unshift({
    videoId,
    title         : title         || '（タイトル不明）',
    thumbnail     : thumbnail     || '',
    uploaderName  : uploaderName  || '不明',
    uploaderUrl   : uploaderUrl   || '',
    watchedAt     : new Date().toISOString()
  });


  if (history.length > MAX_HISTORY) {
    history = history.slice(0, MAX_HISTORY);
  }

  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function getHistory() {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.warn('履歴の読み込みに失敗しました', e);
    return [];
  }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();  
}



function renderSettings() {
  
  const settings = {
    darkMode: localStorage.getItem('darkMode') === 'true',
    autoPlay: localStorage.getItem('autoPlay') !== 'false',   
    defaultPlayer: localStorage.getItem('defaultPlayer') || 'official',
    defaultRegion: localStorage.getItem('defaultRegion') || 'JP',
    commentSort: localStorage.getItem('commentSort') || 'top',          
    defaultQuality: localStorage.getItem('defaultQuality') || 'auto',
    notifications: localStorage.getItem('notifications') === 'true',
    playlistEnabled: localStorage.getItem('playlistEnabled') !== 'false', 
    language: localStorage.getItem('language') || 'ja'                
  };

  app.innerHTML = `
    <section style="max-width:800px; margin:0 auto; padding:24px 16px;">
      <h1 style="font-size:28px; font-weight:700; margin:0 0 32px; color:#0f0f0f;">設定</h1>

      
      <div class="setting-group">
        <h2>外観</h2>
        <label class="setting-label">
          <input type="checkbox" id="darkModeToggle" ${settings.darkMode ? 'checked' : ''}>
          ダークモードにする
        </label>
      </div>

    
<div class="setting-group">
  <h2>再生</h2>
  <label class="setting-label">
    <input type="checkbox" id="autoPlayToggle" ${settings.autoPlay ? 'checked' : ''}>
    自動再生を有効にする
  </label>


  <div style="margin:16px 0;">
    <label>デフォルト画質（高画質プレイヤー選択時）</label>
    <select id="defaultQualitySelect">
      <option value="auto" ${settings.defaultQuality === 'auto' ? 'selected' : ''}>自動（推奨）</option>
      <option value="360" ${settings.defaultQuality === '360' ? 'selected' : ''}>360p（軽量）</option>
      <option value="720" ${settings.defaultQuality === '720' ? 'selected' : ''}>720p</option>
      <option value="1080" ${settings.defaultQuality === '1080' ? 'selected' : ''}>1080p（高画質）</option>
    </select>
    <p style="font-size:13px; color:#606060; margin-top:6px;">
      ※現在は一部プレイヤーで有効。将来的に拡張予定です。
    </p>
  </div>
</div>


<div class="setting-group">
  <h2>デフォルト再生方法</h2>
  <label>動画を開いたときの初期プレイヤー</label>
  <select id="defaultPlayerSelect">
    <option value="official" ${settings.defaultPlayer === 'official' ? 'selected' : ''}>
      公式プレイヤー（YouTube埋め込み）
    </option>
    <option value="api1-original1" ${settings.defaultPlayer === 'api1-original1' ? 'selected' : ''}>
      API1・オリジナル1（高画質・おすすめ・高速）
    </option>
    <option value="api1-original2" ${settings.defaultPlayer === 'api1-original2' ? 'selected' : ''}>
      API1・オリジナル2（音声込み・おすすめ・高速）
    </option>
    <option value="api2-original1" ${settings.defaultPlayer === 'api2-original1' ? 'selected' : ''}>
      API2・オリジナル1（高画質・確実・速さは、まあまあ）
    </option>
    <option value="api2-original2" ${settings.defaultPlayer === 'api2-original2' ? 'selected' : ''}>
      API2・オリジナル2（音声込み・確実・速さは、まあまあ）
    </option>
  </select>
  <p style="font-size:13px; color:#606060; margin-top:8px;">
    ※変更後、次に開く動画から適用されます<br>
    API1系は安定性が高い傾向があります
  </p>
</div>

     
      <div class="setting-group">
        <h2>検索・地域</h2>
        <label>デフォルト地域</label>
        <select id="defaultRegionSelect">
          <option value="JP" ${settings.defaultRegion === 'JP' ? 'selected' : ''}>日本</option>
          <option value="Global" ${settings.defaultRegion === 'Global' ? 'selected' : ''}>全世界</option>
          <option value="US" ${settings.defaultRegion === 'US' ? 'selected' : ''}>アメリカ</option>
        </select>
      </div>

  
      <div class="setting-group">
        <h2>コメント</h2>
        <label>デフォルト表示順</label>
        <select id="commentSortSelect">
          <option value="top" ${settings.commentSort === 'top' ? 'selected' : ''}>トップコメント</option>
          <option value="new" ${settings.commentSort === 'new' ? 'selected' : ''}>新着順</option>
        </select>
      </div>

      
      <div class="setting-group">
        <h2>通知</h2>
        <label class="setting-label">
          <input type="checkbox" id="notificationsToggle" ${settings.notifications ? 'checked' : ''}>
          新着動画の通知を受け取る（ブラウザ通知）
        </label>
        <p style="font-size:13px; color:#606060; margin-top:8px;">
          ※初回ONにするとブラウザから許可を求められます
        </p>
      </div>

    
      <div class="setting-group">
        <h2>プレイリスト機能（準備中）</h2>
        <label class="setting-label">
          <input type="checkbox" id="playlistToggle" ${settings.playlistEnabled ? 'checked' : ''}>
          お気に入り・プレイリスト機能を有効にする
        </label>
        <p style="font-size:13px; color:#606060; margin-top:8px;">
          ※現在準備中です。将来的に動画をお気に入り登録できます
        </p>
      </div>


      <div class="setting-group">
        <h2>再生履歴</h2>
        <label class="setting-label">
          <input type="checkbox" id="autoClearHistory" ${settings.autoClearHistory ? 'checked' : ''}>
          30日以上前の履歴を自動削除
        </label>
        <button id="clearAllHistoryBtn" class="danger-btn" style="margin-top:16px;">
          すべての履歴を今すぐ削除
        </button>
      </div>

      
      <div class="setting-group">
        <h2>言語</h2>
        <select id="languageSelect">
          <option value="ja" ${settings.language === 'ja' ? 'selected' : ''}>日本語</option>
          <option value="en" ${settings.language === 'en' ? 'selected' : ''}>English</option>
        </select>
        <p style="font-size:13px; color:#606060; margin-top:8px;">
          ※英語版は準備中です（UIはまだ日本語固定）
        </p>
      </div>

  
      <div class="setting-group" style="border-top:1px solid #eee; padding-top:24px;">
        <h2>データリセット</h2>
        <button id="clearCacheBtn" class="danger-btn">
          すべての設定とデータをリセット（キャッシュクリア）
        </button>
        <p style="font-size:13px; color:#c00; margin-top:8px;">
          ※この操作は元に戻せません。アプリが再読み込みされます。
        </p>
      </div>


      <div style="text-align:center; margin:48px 0; color:#606060; font-size:14px;">
        K-tube バージョン 2.32
        <br>© 2025-2026
      </div>
    </section>
  `;


  document.getElementById('darkModeToggle')?.addEventListener('change', e => {
    const enabled = e.target.checked;
    localStorage.setItem('darkMode', enabled);
    document.body.classList.toggle('dark-mode', enabled);
  });

document.getElementById('autoPlayToggle')?.addEventListener('change', e => {
  localStorage.setItem('autoPlay', e.target.checked);
});

document.getElementById('defaultQualitySelect')?.addEventListener('change', e => {
  localStorage.setItem('defaultQuality', e.target.value);
  
});

document.getElementById('defaultPlayerSelect')?.addEventListener('change', e => {
  localStorage.setItem('defaultPlayer', e.target.value);
  alert('デフォルト再生方法を変更しました。\n次に開く動画から新しい設定が適用されます。');
});

  document.getElementById('defaultQualitySelect')?.addEventListener('change', e => {
    localStorage.setItem('defaultQuality', e.target.value);
  });

  document.getElementById('defaultRegionSelect')?.addEventListener('change', e => {
    localStorage.setItem('defaultRegion', e.target.value);
  });

  document.getElementById('commentSortSelect')?.addEventListener('change', e => {
    localStorage.setItem('commentSort', e.target.value);
  });

  document.getElementById('notificationsToggle')?.addEventListener('change', async e => {
    const enabled = e.target.checked;
    if (enabled) {
   
      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          e.target.checked = false;
          alert('通知が許可されませんでした');
          return;
        }
      }
    }
    localStorage.setItem('notifications', enabled);
  });

  document.getElementById('playlistToggle')?.addEventListener('change', e => {
    localStorage.setItem('playlistEnabled', e.target.checked);
  });

  document.getElementById('autoClearHistory')?.addEventListener('change', e => {
    localStorage.setItem('autoClearHistory', e.target.checked);
  });

  document.getElementById('languageSelect')?.addEventListener('change', e => {
    localStorage.setItem('language', e.target.value);
    alert('言語変更は次回リロード後に反映されます（現在準備中）');
  });


  document.getElementById('clearAllHistoryBtn')?.addEventListener('click', () => {
    if (confirm('すべての再生履歴を削除しますか？この操作は元に戻せません。')) {
      clearHistory();
      alert('履歴をすべて削除しました');
    }
  });

 
  document.getElementById('clearCacheBtn')?.addEventListener('click', () => {
    if (confirm('すべての設定・履歴・キャッシュを削除しますか？アプリが再読み込みされます。')) {
      localStorage.clear();
      location.reload();
    }
  });
}   


function renderAbout() {
  app.innerHTML = `
    <div class="play-fullscreen" style="background: #f9f9f9; color: #111; overflow-y: auto; padding: 80px 20px 40px;">
      <div style="max-width: 860px; margin: 0 auto; background: white; border-radius: 16px; padding: 40px; box-shadow: 0 8px 32px rgba(0,0,0,0.1);">
        <h1 style="font-size: 42px; font-weight: 800; color: #cc0000; text-align: center; margin-bottom: 12px;">K-tube</h1>
        <p style="font-size: 18px; color: #065fd4; text-align: center; margin-bottom: 40px;">YouTubeの最速非公式クライアント</p>
        
        <div style="font-size: 17px; line-height: 1.8; color: #333;">

    <p>
      K-tubeは、YouTubeが見られない環境でも動画を視聴できるよう設計された非公式クライアントです。
    </p>
    <p>
      広告やトラッキングを排除し、プライバシーを守りながら、
      高速再生・履歴管理・ゲームやツール機能などを提供します。
    </p>
          
          <h2 style="font-size: 26px; margin: 48px 0 24px; color: #cc0000;">主な特徴</h2>
          <ul style="list-style: none; padding-left: 0; font-size: 17px; line-height: 2.2;">
      <li>✅️　K-tubeオリジナルのK-tube APIを使用</li>
      <li>✅️　広告なし・トラッキングなしの快適視聴</li>
      <li>✅️　高速オリジナルプレイヤー（高画質対応）</li>
      <li>✅️　ゲーム・ツールの提供</li>
      <li>✅️　再生履歴の自動保存＆クリア機能</li>
      <li>✅️　ダークモードや画質設定などのカスタマイズ</li>
      <li>✅️　youtube動画の高速ダウンロード</li>
          </ul>
        </div>
        
        <div style="text-align: center; margin: 60px 0; color: #666; font-size: 15px;">
          © 2025-2026 K-tube All Rights Reserved.<br>
  
        </div>
        
        <button onclick="history.back()" style="
          display: block;
          margin: 40px auto 0;
          padding: 14px 48px;
          font-size: 18px;
          background: #065fd4;
          color: white;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(6,95,212,0.3);
        ">閉じる</button>
      </div>
    </div>
  `;
}


function renderContact() {
  app.innerHTML = `
    <div class="play-fullscreen" style="background: #fff5f5; color: #111; overflow-y: auto; padding: 80px 20px 40px;">
      <div style="max-width: 720px; margin: 0 auto; background: white; border-radius: 16px; padding: 40px; box-shadow: 0 8px 32px rgba(0,0,0,0.1); text-align: center;">
        <h1 style="font-size: 42px; font-weight: 700; color: #cc0000; margin-bottom: 24px;">お問い合わせ</h1>
        
        <p style="font-size: 20px; line-height: 1.6; margin: 0 0 40px;">
          K-tubeの使い心地はいかがですか？<br>
          不具合・改善提案・新機能のリクエストなど、<br>
          どんな小さなことでも大歓迎です！
        </p>
        
        <div style="margin: 40px 0;">
          <p style="font-size: 18px; margin-bottom: 20px; font-weight: 600;">現在の主な連絡先</p>
          <a href="https://scratch.mit.edu/users/I-love-Proxy/" target="_blank" style="
            display: inline-block;
            padding: 16px 48px;
            background: #ff6600;
            color: white;
            font-size: 18px;
            font-weight: 600;
            border-radius: 12px;
            text-decoration: none;
            box-shadow: 0 6px 16px rgba(255,102,0,0.3);
            transition: transform 0.2s;
          ">Scratch: @I-love-Proxy</a>
        </div>
        
        <p style="font-size: 16px; color: #555; margin: 32px 0;">
          Scratchのプロフィールページ、またはコメント欄から<br>
          直接メッセージを送っていただければすぐに確認します！
        </p>
        
        <p style="font-size: 15px; color: #888; margin-top: 48px;">
          Twitter・Discord・メールなどの連絡先は準備中です。<br>
          ご意見お待ちしています！
        </p>
        
        <button onclick="history.back()" style="
          margin-top: 48px;
          padding: 14px 48px;
          font-size: 18px;
          background: #cc0000;
          color: white;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(204,0,0,0.3);
        ">閉じる</button>
      </div>
    </div>
  `;
}


import('./games.js').then(() => console.log('games.js loaded'));
import('./tools.js').then(() => console.log('tools.js loaded'));

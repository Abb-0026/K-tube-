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

// ─────────────────────────────────────────────
// 数値フォーマット（Intl キャッシュで高速化）
// ─────────────────────────────────────────────
const _numFmt = new Intl.NumberFormat('en-US');
function fmtNum(n) {
  if (n == null || isNaN(n)) return '0';
  return _numFmt.format(Number(n));
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
// Piped と Invidious を並列で叩いて先勝ち採用（タイムアウト6秒）
// ─────────────────────────────────────────────
async function pipedFetch(endpoint, params = {}) {
  const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const qs = new URLSearchParams(params).toString();
  const full = qs ? `${path}?${qs}` : path;

  const pipedUrl = `${PIPED_API_BASE}${full}`;
  const invUrl   = `${INVIDIOUS_API_BASE}${full}`;

  try {
    const result = await Promise.any([
      rawFetchJson(pipedUrl, 6000).then(data => ({ source: 'piped', data })),
      rawFetchJson(invUrl,   6000).then(data => ({
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

// ─────────────────────────────────────────────
// 同時実行数制限付きヘルパー
// ─────────────────────────────────────────────
async function runWithConcurrency(tasks, limit = 6) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// カード群のチャンネルアイコンを一括で埋める（重複排除 + 並列）
async function fillChannelThumbs(cards) {
  const idToImgs = new Map();
  cards.forEach(card => {
    const chId = card.querySelector('.ch-link')?.dataset.channel;
    const img = card.querySelector('.channel-thumb img');
    if (!chId || !img) return;
    if (!idToImgs.has(chId)) idToImgs.set(chId, []);
    idToImgs.get(chId).push(img);
  });

  const entries = [...idToImgs.entries()];
  await runWithConcurrency(
    entries.map(([chId, imgs]) => async () => {
      const thumb = await getChannelThumbPiped(chId);
      if (thumb) {
        imgs.forEach(img => { img.src = thumb; });
      }
    }),
    6
  );
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
    const items = data || [];

    const frag = document.createDocumentFragment();
    const cards = [];
    for (const item of items) {
      const card = makeVideoCard(item);
      cards.push(card);
      frag.appendChild(card);
    }
    grid.appendChild(frag); // 即座に一括表示

    // アイコンは後から並列で埋める
    fillChannelThumbs(cards);
  } catch (e) {
    console.error(e);
    grid.innerHTML += `<div style="color:#c00; padding:16px; text-align:center;">
      読み込み失敗: ${escapeHtml(e.message)}
    </div>`;
  } finally {
    homeLoading = false;
  }
}

// 動画カード作成（アイコンなし即返し・サムネイル遅延+低解像度→高解像度）
function makeVideoCard(item) {
  const vid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
  const title = item.title || '';
  const th = `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
  const thHi = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  const chId = item.uploaderUrl?.split('/').pop() || '';
  const chTitle = item.uploaderName || '';
  const views = item.views || 0;
  const publishedAt = item.uploadedDate || item.uploaded || '';

  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `
    <div class="thumb" data-vid="${vid}">
      <img src="${th}"
           data-hi="${thHi}"
           alt=""
           loading="lazy"
           decoding="async"
           onload="if(this.dataset.hi&&this.src.includes('mqdefault')){const i=new Image();i.onload=()=>{this.src=this.dataset.hi;};i.src=this.dataset.hi;}">
    </div>
    <div class="meta">
      <div class="channel-thumb"><img src="" alt="" loading="lazy" decoding="async"></div>
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

            const frag = document.createDocumentFragment();
            const cards = [];
            for (const item of items) {
              const card = makeVideoCard(item);
              cards.push(card);
              frag.appendChild(card);
            }
            grid.appendChild(frag);

            fillChannelThumbs(cards);
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
        }, { rootMargin: '800px' });
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

// =============================================
// /API.json のキャッシュ（sessionStorage）
// =============================================
let _apiListCache = null;
async function getCachedApiList() {
  if (_apiListCache) return _apiListCache;
  try {
    const cached = sessionStorage.getItem('ktube_api_list');
    if (cached) {
      _apiListCache = JSON.parse(cached);
      return _apiListCache;
    }
  } catch (e) {}
  try {
    const res = await fetch('/API.json');
    if (!res.ok) throw new Error('API.json fetch failed');
    const list = await res.json();
    _apiListCache = list;
    try { sessionStorage.setItem('ktube_api_list', JSON.stringify(list)); } catch (e) {}
    return list;
  } catch (e) {
    console.warn('API.json 取得失敗:', e);
    return ["https://splendid-jelly-e731bd.netlify.app/.netlify/functions"];
  }
}

async function fetchFastestNetlify(videoId) {
  try {
    const apiList = await getCachedApiList();
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


// =============================================
// 再生ページ（超高速化版 + googlevideo ブロック検知）
// =============================================
async function renderWatch(videoId) {
  try {
    observerMap.forEach(o => o.disconnect());
    observerMap.clear();

    // ── ① 骨組みを即描画 ──
    const defaultPlayer = localStorage.getItem('defaultPlayer') || 'api2-original2';

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
    }

    app.innerHTML = `
      <div class="watch-container">
        <div class="main-col">
          <div class="player-box">
            <iframe id="videoIframe"
                    src="${initialSrc}"
                    frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen
                    style="width:100%;height:100%;">
            </iframe>
          </div>
          <div class="player-meta">
            <h1 id="watchTitle">読み込み中...</h1>
            <div class="stats" id="watchStats">
              <div id="watchViews">--- 回視聴</div>
              <div>・</div>
              <div id="watchUploaded">---</div>
              <div style="margin-left:auto;font-weight:700" id="watchLikes">--- 👍</div>
              <select id="playerSelect">
                <option value="official" ${selectedValue === 'official' ? 'selected' : ''}>公式プレイヤー（YouTube埋め込み）</option>
                <option value="api1-original1" ${selectedValue === 'api1-original1' ? 'selected' : ''}>API1・オリジナル1（高画質）</option>
                <option value="api1-original2" ${selectedValue === 'api1-original2' ? 'selected' : ''}>API1・オリジナル2（音声込み）</option>
                <option value="api2-original1" ${selectedValue === 'api2-original1' ? 'selected' : ''}>API2・オリジナル1（高画質）</option>
                <option value="api2-original2" ${selectedValue === 'api2-original2' ? 'selected' : ''}>API2・オリジナル2（音声込み）</option>
              </select>
            </div>
            <div class="channel-row">
              <img id="watchChThumb" src="" alt="" onerror="this.src='https://via.placeholder.com/48?text=Ch'" style="width:48px;height:48px;border-radius:50%;object-fit:cover;background:#eee;">
              <div class="ch-info">
                <div style="font-weight:700">
                  <a id="watchChLink" href="#" class="watch-ch-link" style="text-decoration:none;color:inherit">---</a>
                </div>
                <div style="color:#606060;font-size:13px" id="watchChSubs">--- 人の登録者</div>
              </div>
              <button class="btn-sub" id="downloadMainBtn">ダウンロード</button>
            </div>

            <div id="descriptionArea" style="margin-top:16px; color:#333; line-height:1.5; word-break:break-word;">
              <div id="descriptionContainer" style="max-height:4.8em; overflow:hidden; transition:max-height 0.4s ease;">
                （説明を読み込み中...）
              </div>
              <div id="descToggleArea" style="margin-top:8px; display:none;">
                <a id="expandDesc" href="#" style="color:#065fd4; font-weight:500; cursor:pointer; text-decoration:none; display:block;">もっと見る</a>
                <a id="collapseDesc" href="#" style="color:#065fd4; font-weight:500; cursor:pointer; text-decoration:none; display:none;">折りたたむ</a>
              </div>
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

    // ── ② プレイヤー切り替えイベント + googlevideo ブロック検知 ──
    const playerSelect = document.getElementById('playerSelect');
    const iframe = document.getElementById('videoIframe');
    let currentMode = selectedValue;
    let _errorHandled = false;

    // グローバルリスナーは1つだけにする（多重登録防止）
    if (window._ktubePlayerErrorHandler) {
      window.removeEventListener('message', window._ktubePlayerErrorHandler);
    }
    window._ktubePlayerErrorHandler = function(e) {
      if (!e.data || e.data.type !== 'player-error') return;
      if (_errorHandled) return;

      const errMode = e.data.mode || currentMode;
      console.warn(`[renderWatch] player-error 受信: reason=${e.data.reason} mode=${errMode}`);

      // api1-original2 なら再試行（ループ）
      if (errMode === 'api1-original2') {
        console.log('[renderWatch] api1-original2 を再試行（ループ）');
        if (iframe) {
          iframe.src = `/watch.html?id=${videoId}&mode=api1-prog&t=${Date.now()}`;
        }
        if (typeof showModeToast === 'function') {
          showModeToast('「API1・オリジナル2」で再試行しています');
        }
        return;
      }

      // それ以外（api2-original1 / api2-original2 / api1-original1）→ api1-original2 に切り替え
      _errorHandled = true;
      currentMode = 'api1-original2';
      if (playerSelect) playerSelect.value = 'api1-original2';
      if (iframe) {
        iframe.src = `/watch.html?id=${videoId}&mode=api1-prog&t=${Date.now()}`;
      }
      if (typeof showModeToast === 'function') {
        showModeToast('埋め込みがブロックされたため「API1・オリジナル2」に切り替えました');
      }
    };
    window.addEventListener('message', window._ktubePlayerErrorHandler);

    if (playerSelect && iframe) {
      playerSelect.addEventListener('change', () => {
        const val = playerSelect.value;
        let newSrc = `https://www.youtube.com/embed/${videoId}?rel=0`;
        switch (val) {
          case 'official': newSrc = `https://www.youtube.com/embed/${videoId}?rel=0`; break;
          case 'api1-original1': newSrc = `/watch.html?id=${videoId}&mode=api1-high`; break;
          case 'api1-original2': newSrc = `/watch.html?id=${videoId}&mode=api1-prog`; break;
          case 'api2-original1': newSrc = `/watch.html?id=${videoId}`; break;
          case 'api2-original2': newSrc = `/watch.html?id=${videoId}&mode=360`; break;
        }
        iframe.src = newSrc;
        currentMode = val;
        _errorHandled = false; // 手動変更でエラーフラグをリセット
      });
    }

    // ── ③ ダウンロードボタンも即時登録 ──
    const downloadBtn = document.getElementById('downloadMainBtn');
    if (downloadBtn) {
      downloadBtn.classList.remove('disabled');
      downloadBtn.addEventListener('click', async () => {
        try {
          let videoData = null;
          try {
            videoData = await fetchFastestNetlify(videoId);
          } catch (e) {}
          if (!videoData) {
            const proxyRes = await fetch(`/api/v2/video?v=${videoId}`);
            if (proxyRes.ok) videoData = await proxyRes.json();
          }
          if (!videoData) throw new Error('ダウンロード用メタデータを取得できませんでした');

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

    // ── ④ コメント・関連動画は即時開始 ──
    setupComments(videoId);

    const relatedList = document.getElementById('relatedList');
    if (relatedList) {
      relatedList.innerHTML = '<div style="padding:20px; text-align:center; color:#606060;">読み込み中...</div>';
    }

    // ── ⑤ メタデータ取得（await するが、骨組みは既に出ている） ──
    const rawMeta = await fetchFastestNetlify(videoId).catch(() => null);
    const metaData = normalizeMetadata(rawMeta || {}, 'K-tube API (race)');

    const title = metaData.title || `動画（ID: ${videoId}）`;
    const views = fmtNum(metaData.viewCount ?? metaData.views ?? 0);
    const likes = fmtNum(metaData.likeCount ?? 0);
    let uploaded = '---';
    if (metaData.published || metaData.uploadDate || metaData.uploaded) {
      try {
        uploaded = timeAgo(new Date(metaData.published || metaData.uploadDate || metaData.uploaded).toISOString());
      } catch {}
    }

    const titleEl = document.getElementById('watchTitle');
    if (titleEl) titleEl.textContent = title;
    const viewsEl = document.getElementById('watchViews');
    if (viewsEl) viewsEl.textContent = `${views} 回視聴`;
    const uploadedEl = document.getElementById('watchUploaded');
    if (uploadedEl) uploadedEl.textContent = uploaded;
    const likesEl = document.getElementById('watchLikes');
    if (likesEl) likesEl.textContent = `${likes} 👍`;

    // 説明文
    let rawDesc = metaData.description || metaData.shortDescription || '説明文は現在取得できませんでした';
    rawDesc = rawDesc.trim().replace(/^\s+|\s+$/g, '').replace(/^(?:\r\n|\r|\n|　)+/, '').replace(/\s{2,}/g, ' ');
    rawDesc = rawDesc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#065fd4; text-decoration:underline;">$1</a>');
    const descContainer = document.getElementById('descriptionContainer');
    if (descContainer) descContainer.innerHTML = rawDesc || '（説明がありません）';
    if (rawDesc.length > 300) {
      const toggleArea = document.getElementById('descToggleArea');
      if (toggleArea) toggleArea.style.display = 'block';
    }

    // 説明文の展開/折りたたみ
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
    }, 0);

    // ── ⑥ チャンネル情報（仮表示 → 後から埋める） ──
    let chName = metaData.uploader || metaData.author || metaData.channelName || metaData.uploaderName || '不明';
    let chId = metaData.channelId || metaData.authorId || (metaData.uploaderUrl?.split('/').pop() || '');
    let chThumb = toYt3Avatar(metaData.uploaderAvatar || metaData.avatar || '', 88);
    let subscriberCount = metaData.subscriberCount ?? 0;

    const chLinkEl = document.getElementById('watchChLink');
    if (chLinkEl) {
      chLinkEl.textContent = chName;
      chLinkEl.href = chId ? `#channel=${chId}` : '#';
      chLinkEl.addEventListener('click', e => {
        e.preventDefault();
        if (chId) location.hash = `channel=${chId}`;
      });
    }
    if (chThumb) {
      const img = document.getElementById('watchChThumb');
      if (img) img.src = chThumb;
    }
    const subsEl0 = document.getElementById('watchChSubs');
    if (subsEl0) {
      subsEl0.textContent = (typeof subscriberCount === 'number' ? fmtNum(subscriberCount) : '---') + ' 人の登録者';
    }

    // チャンネル情報を後から取得（待たない）
    if (chId) {
      (async () => {
        try {
          const thumb = await getChannelThumbPiped(chId);
          if (thumb) {
            const img = document.getElementById('watchChThumb');
            if (img) img.src = thumb;
          }
        } catch (e) {}
        try {
          const channelData = await pipedFetch(`/channel/${chId}`);
          if (channelData) {
            if (channelData.name) {
              const link = document.getElementById('watchChLink');
              if (link) link.textContent = channelData.name;
            }
            if (typeof channelData.subscriberCount === 'number' && channelData.subscriberCount > 0) {
              const subsEl = document.getElementById('watchChSubs');
              if (subsEl) subsEl.textContent = `${fmtNum(channelData.subscriberCount)} 人の登録者`;
            } else if (channelData.subscriberCount === -1 || channelData.subscriberCount === null) {
              const subsEl = document.getElementById('watchChSubs');
              if (subsEl) subsEl.textContent = '非公開';
            }
          }
        } catch (e) {}
      })();
    }

    // 履歴追加
    if (metaData.title) {
      addToHistory(videoId, metaData.title, metaData.thumbnail || '', chName, metaData.uploaderUrl || (chId ? `/channel/${chId}` : ''));
    }

    // ── ⑦ 関連動画を非同期取得 ──
    if (relatedList) {
      (async () => {
        try {
          let items = [];
          let searchQuery = metaData.title || videoId;
          if (metaData.uploader || metaData.uploaderName) {
            searchQuery += ' ' + (metaData.uploader || metaData.uploaderName);
          }

          const relatedData = await pipedFetch('/search', { q: searchQuery, filter: 'videos' });
          items = Array.isArray(relatedData) ? relatedData :
                  (relatedData?.items || relatedData?.results || relatedData?.videos || []);

          items = items.filter(item => {
            const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
            return relVid && relVid !== videoId;
          });

          if (items.length < 6) {
            const fallback = await pipedFetch('/search', { q: metaData.title || videoId });
            let more = Array.isArray(fallback) ? fallback :
                       (fallback?.items || fallback?.results || fallback?.videos || []);
            more = more.filter(item => {
              const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
              return relVid && relVid !== videoId;
            });
            items = [...items, ...more];
          }

          const seen = new Set();
          items = items.filter(item => {
            const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
            if (seen.has(relVid)) return false;
            seen.add(relVid);
            return true;
          });

          const finalItems = items.slice(0, 6);
          if (finalItems.length) {
            relatedList.innerHTML = '';
            finalItems.forEach(item => {
              const relVid = item.url?.split('v=')[1] || item.url?.split('/').pop() || '';
              const thumb = `https://i.ytimg.com/vi/${relVid}/mqdefault.jpg`;
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
      })();
    }

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
  const ch = data.channel || {};

  function parseViewCount(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return 0;
    const cleaned = v.replace(/[^\d]/g, '');
    return cleaned ? parseInt(cleaned, 10) : 0;
  }

  function parseLikeCount(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return 0;
    const cleaned = v.replace(/[^\d]/g, '');
    return cleaned ? parseInt(cleaned, 10) : 0;
  }

  function parsePublished(v) {
    if (!v) return '';
    if (typeof v === 'number') {
      return new Date(v * 1000).toISOString();
    }
    if (typeof v === 'string') {
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
    
    uploader: data.uploader || data.author || data.channelName || ch.name || '',
    channelId: data.channelId || data.authorId || ch.id || '',
    uploaderAvatar: data.uploaderAvatar || data.avatar || data.authorThumbnails?.slice(-1)[0]?.url || ch.avatar || '',
    
    thumbnail: data.thumbnail || data.videoThumbnails?.find(t => t.quality === 'maxres')?.url || data.videoThumbnails?.[0]?.url || '',
    lengthSeconds: data.lengthSeconds || data.duration || 0,
    
    subscriberCount: (() => {
      if (typeof data.subscriberCount === 'number') return data.subscriberCount;
      if (typeof data.subCount === 'number') return data.subCount;
      const subsStr = data.subs || ch.subs || data.subCountText || '';
      if (!subsStr) return 0;
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

    chData = await pipedFetch(`/channel/${channelId}`);
    rawVideos =
      chData.relatedStreams ||
      chData.latestVideos ||
      chData.videos ||
      [];

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

    const frag = document.createDocumentFragment();
    const cards = [];
    for (const v of rawVideos) {
      const card = makeVideoCard(v);
      cards.push(card);
      frag.appendChild(card);
    }
    grid.appendChild(frag);

    fillChannelThumbs(cards);
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
          }, { rootMargin: '800px' });
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
          © 2024-2026 K-tube All Rights Reserved.<br>
  
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

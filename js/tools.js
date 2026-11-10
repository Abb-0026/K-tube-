
// js/tools.js

async function loadTools() {
  const grid = document.getElementById('toolGrid');
  if (!grid) return;

  try {
    const res = await fetch('/Tools.json');
    if (!res.ok) throw new Error('Tools.json 読み込み失敗');
    const data = await res.json();
    const tools = data.tools || [];

    const frag = document.createDocumentFragment();

    for (const tool of tools) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="thumb" data-tool="${tool.embedUrl}">
          <img src="${tool.thumbnail}"
               alt="${escapeHtml(tool.title)}"
               loading="lazy"
               decoding="async"
               style="aspect-ratio:16/9; object-fit:cover;">
        </div>
        <div class="meta">
          <div class="info">
            <div class="title">${escapeHtml(tool.title)}</div>
            <div class="sub">${escapeHtml(tool.description || '')}</div>
          </div>
        </div>
      `;

      card.querySelector('.thumb').addEventListener('click', () => {
        location.hash = `playtool=${encodeURIComponent(tool.embedUrl)}`;
      });

      frag.appendChild(card);
    }

    grid.innerHTML = '';
    grid.appendChild(frag);
  } catch (err) {
    console.error('ツール一覧読み込みエラー:', err);
    grid.innerHTML = `<div style="color:#c00;padding:40px;text-align:center;">ツール一覧の読み込みに失敗しました</div>`;
  }
}

function renderToolPlay(tool) {
  app.innerHTML = `
    <div class="play-fullscreen">
      <iframe src="${tool.embedUrl}" frameborder="0" allowfullscreen></iframe>
    </div>
  `;
}

window.loadTools = loadTools;
window.renderToolPlay = renderToolPlay;

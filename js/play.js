// js/play.js

async function loadGames() {
  const grid = document.getElementById('gameGrid');
  if (!grid) return;

  try {
    const res = await fetch('/Games.json');
    if (!res.ok) throw new Error('Games.json 読み込み失敗');
    const data = await res.json();
    const games = data.games || [];

    const frag = document.createDocumentFragment();

    for (const game of games) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="thumb" data-game="${game.embedUrl}">
          <img src="${game.thumbnail}"
               alt="${escapeHtml(game.title)}"
               loading="lazy"
               decoding="async"
               style="aspect-ratio:16/9; object-fit:cover;">
        </div>
        <div class="meta">
          <div class="info">
            <div class="title">${escapeHtml(game.title)}</div>
            <div class="sub">${escapeHtml(game.description || '')}</div>
          </div>
        </div>
      `;

      card.querySelector('.thumb').addEventListener('click', () => {
        location.hash = `playgame=${encodeURIComponent(game.embedUrl)}`;
      });

      frag.appendChild(card);
    }

    grid.innerHTML = '';
    grid.appendChild(frag);
  } catch (err) {
    console.error('ゲーム一覧読み込みエラー:', err);
    grid.innerHTML = `<div style="color:#c00;padding:40px;text-align:center;">ゲーム一覧の読み込みに失敗しました</div>`;
  }
}

function renderGamePlay(game) {
  app.innerHTML = `
    <div class="play-fullscreen">
      <iframe src="${game.embedUrl}" frameborder="0" allowfullscreen></iframe>
    </div>
  `;
}

window.loadGames = loadGames;
window.renderGamePlay = renderGamePlay;

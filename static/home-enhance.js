/* VaultDrive home enhance — feed / badges / drawer / search / PWA */
(function () {
  const HIST_KEY = 'vd_search_hist_v1';
  let acTimer = null;
  let acItems = [];
  let acIndex = -1;
  let deferredInstall = null;

  function esc(s) {
    if (window.esc) return window.esc(s);
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function getHist() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function pushHist(q) {
    q = (q || '').trim();
    if (!q) return;
    const list = getHist().filter(x => x !== q);
    list.unshift(q);
    localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 8)));
    renderHist();
  }

  function ensureHomeSections() {
    const home = document.getElementById('page-home');
    if (!home || document.getElementById('homePersonal')) return;

    const hero = home.querySelector('.archive-hero-content');
    if (hero && !document.getElementById('homeSearchTools')) {
      const tools = document.createElement('div');
      tools.className = 'home-search-tools';
      tools.id = 'homeSearchTools';
      tools.innerHTML = `
        <div class="home-hist-row" id="homeHistRow"></div>
      `;
      hero.appendChild(tools);

      const box = hero.querySelector('.home-search-box');
      if (box && !document.getElementById('homeAcPanel')) {
        const panel = document.createElement('div');
        panel.className = 'home-ac-panel';
        panel.id = 'homeAcPanel';
        box.appendChild(panel);
      }
    }

    const wallHead = home.querySelector('.poster-wall-head');
    if (!wallHead) return;

    const personal = document.createElement('div');
    personal.className = 'home-personal hidden';
    personal.id = 'homePersonal';
    personal.innerHTML = `
      <div class="home-rail-head" style="margin-bottom:10px">
        <div>
          <h2>为你准备</h2>
          <p>订阅新货 · 想看有源 · 收藏</p>
        </div>
      </div>
      <div class="home-personal-grid" id="homePersonalGrid"></div>
    `;

    wallHead.parentNode.insertBefore(personal, wallHead);

    if (!document.getElementById('pwaHint')) {
      const hint = document.createElement('div');
      hint.className = 'pwa-hint';
      hint.id = 'pwaHint';
      hint.innerHTML = `
        <div style="font-size:.85rem;color:var(--text-secondary)">安装 VaultDrive 到主屏幕，当 App 用</div>
        <div style="display:flex;gap:6px">
          <button type="button" class="no" id="pwaNo">稍后</button>
          <button type="button" class="ok" id="pwaOk">安装</button>
        </div>
      `;
      document.body.appendChild(hint);
    }
    renderHist();
    bindHomeSearch();
  }


  function renderHist() {
    const el = document.getElementById('homeHistRow');
    if (!el) return;
    const list = getHist();
    if (!list.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = list.map(q =>
      `<button type="button" class="home-hist-chip" data-q="${esc(q)}">${esc(q)}</button>`
    ).join('');
    el.querySelectorAll('.home-hist-chip').forEach(btn => {
      btn.onclick = () => {
        const q = btn.getAttribute('data-q') || '';
        const input = document.getElementById('homeSearchInput');
        if (input) input.value = q;
        runHomeSearch(q);
      };
    });
  }

  function bindHomeSearch() {
    const input = document.getElementById('homeSearchInput');
    if (!input || input.dataset.enhanceBound === '1') return;
    input.dataset.enhanceBound = '1';
    input.addEventListener('input', () => {
      clearTimeout(acTimer);
      acTimer = setTimeout(() => loadAutocomplete(input.value.trim()), 180);
    });
    input.addEventListener('keydown', (e) => {
      const panel = document.getElementById('homeAcPanel');
      if (e.key === 'ArrowDown' && acItems.length) {
        e.preventDefault();
        acIndex = Math.min(acIndex + 1, acItems.length - 1);
        paintAc();
      } else if (e.key === 'ArrowUp' && acItems.length) {
        e.preventDefault();
        acIndex = Math.max(acIndex - 1, 0);
        paintAc();
      } else if (e.key === 'Enter') {
        if (acIndex >= 0 && acItems[acIndex]) {
          e.preventDefault();
          pickAc(acItems[acIndex].keyword);
        }
      } else if (e.key === 'Escape' && panel) {
        panel.classList.remove('open');
      }
    });
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('homeAcPanel');
      const box = document.querySelector('.home-search-box');
      if (panel && box && !box.contains(e.target)) panel.classList.remove('open');
    });

    // override executeHomeSearch if present
    window.executeHomeSearch = function () {
      const q = (document.getElementById('homeSearchInput') || {}).value || '';
      runHomeSearch(q.trim());
    };
  }

  async function loadAutocomplete(q) {
    const panel = document.getElementById('homeAcPanel');
    if (!panel) return;
    if (!q) {
      panel.classList.remove('open');
      panel.innerHTML = '';
      acItems = [];
      acIndex = -1;
      return;
    }
    try {
      const r = await fetch('/api/autocomplete?q=' + encodeURIComponent(q));
      const d = await r.json();
      acItems = d.items || [];
      acIndex = -1;
      paintAc();
    } catch (e) {
      panel.classList.remove('open');
    }
  }

  function paintAc() {
    const panel = document.getElementById('homeAcPanel');
    if (!panel) return;
    if (!acItems.length) {
      panel.classList.remove('open');
      panel.innerHTML = '';
      return;
    }
    panel.innerHTML = acItems.map((it, i) =>
      `<div class="home-ac-item${i === acIndex ? ' active' : ''}" data-i="${i}">
        <span>${esc(it.keyword || '')}</span>
        <span style="color:var(--text-muted);font-size:.72rem">${it.hit_count != null ? it.hit_count : ''}</span>
      </div>`
    ).join('');
    panel.classList.add('open');
    panel.querySelectorAll('.home-ac-item').forEach(el => {
      el.onclick = () => pickAc(acItems[Number(el.getAttribute('data-i'))].keyword);
    });
  }

  function pickAc(keyword) {
    const input = document.getElementById('homeSearchInput');
    if (input) input.value = keyword;
    const panel = document.getElementById('homeAcPanel');
    if (panel) panel.classList.remove('open');
    runHomeSearch(keyword);
  }

  function runHomeSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    pushHist(q);
    if (typeof window.searchResource === 'function') {
      window.searchResource(q);
    }
  }

  function skelRow(el, n) {
    if (!el) return;
    el.innerHTML = `<div class="home-skel-row">${Array.from({ length: n || 6 }, () => '<div class="home-skel"></div>').join('')}</div>`;
  }

  function cardHtml(it) {
    const title = it.display_title || it.hot_keyword || it.title || it.keyword || '';
    const poster = it.poster || '';
    const src = it.source_label || it.source || '';
    const titleJs = JSON.stringify(it.hot_keyword || title);
    const ch = (title.trim()[0] || '·');
    return `
      <article class="home-chip-card" data-q="${esc(title)}" onclick='searchResource(${titleJs})'>
        <div class="thumb">
          ${poster
            ? `<img src="${esc(poster)}" alt="${esc(title)}" loading="lazy" decoding="async" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.hidden=false">
               <div class="home-chip-ph" hidden>${esc(ch)}</div>`
            : `<div class="home-chip-ph">${esc(ch)}</div>`}
        </div>
        <div class="meta">
          <div class="t">${esc(title)}</div>
          <div class="s">${esc([src, it.year].filter(Boolean).join(' · '))}</div>
        </div>
      </article>
    `;
  }

  async function fillMissingPosters(items, rowEl) {
    if (!rowEl || !items || !items.length) return;
    const need = [];
    items.forEach(it => {
      if (it.poster) return;
      const q = it.display_title || it.hot_keyword || it.title || '';
      if (q) need.push(q);
    });
    if (!need.length) return;
    try {
      const r = await fetch('/api/home/posters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles: need.slice(0, 24) }),
      });
      const d = await r.json();
      const map = d.items || {};
      let changed = false;
      items.forEach(it => {
        const q = it.display_title || it.hot_keyword || it.title || '';
        if (!it.poster && map[q]) {
          it.poster = map[q];
          changed = true;
        }
      });
      if (changed) rowEl.innerHTML = items.map(cardHtml).join('');
    } catch (e) {}
  }

  async function loadPersonal() {
    const wrap = document.getElementById('homePersonal');
    const grid = document.getElementById('homePersonalGrid');
    if (!wrap || !grid) return;
    try {
      const r = await fetch('/api/home/personal');
      const d = await r.json();
      if (!d.login) {
        wrap.classList.add('hidden');
        return;
      }
      const pills = [];
      if (d.subscription_new_total > 0) {
        pills.push(`<button type="button" class="home-pill" data-act="subs">订阅新货 <strong>${d.subscription_new_total}</strong></button>`);
      } else if ((d.subscriptions || []).length) {
        pills.push(`<button type="button" class="home-pill" data-act="subs">已订阅 <strong>${d.subscriptions.length}</strong></button>`);
      }
      if ((d.watchlist_ready || []).length) {
        pills.push(`<button type="button" class="home-pill" data-act="wl">想看有源 <strong>${d.watchlist_ready.length}</strong></button>`);
      }
      pills.push(`<button type="button" class="home-pill" data-act="fav" onclick="if(typeof guardFavoritesNav==='function' && !window.VD_IN_GROUP){guardFavoritesNav();return;} location.href='/profile'">收藏 <strong>${d.favorites_count || 0}</strong></button>`);
      if (!pills.length) {
        wrap.classList.add('hidden');
        return;
      }
      wrap.classList.remove('hidden');
      grid.innerHTML = pills.join('');
      grid.querySelectorAll('.home-pill').forEach(btn => {
        const act = btn.getAttribute('data-act');
        if (act === 'subs') {
          btn.onclick = () => {
            const first = (d.subscriptions || []).find(s => s.new_count > 0) || (d.subscriptions || [])[0];
            if (first) runHomeSearch(first.keyword);
          };
        } else if (act === 'wl') {
          btn.onclick = () => {
            const first = (d.watchlist_ready || [])[0];
            if (first) {
              if (typeof window.searchResource === 'function') window.searchResource(first.title);
            }
          };
        }
      });
    } catch (e) {
      wrap.classList.add('hidden');
    }
  }

  function badgeHtml(info) {
    if (!info) return '';
    const st = info.status || 'none';
    let text = '无源';
    if (st === 'live') text = `有源 ${info.count || ''}`.trim();
    else if (st === 'mixed') text = `部分失效`;
    else if (st === 'dead') text = '已失效';
    const pans = (info.source_labels || []).slice(0, 2).join('/');
    return `
      <div class="poster-badges">
        <span class="poster-badge ${st}">${esc(text)}</span>
        ${pans ? `<span class="poster-badge ${st}">${esc(pans)}</span>` : ''}
      </div>
    `;
  }

  async function enrichPosterBadges(items) {
    if (!window.VD_LOGGED_IN) return {};
    const titles = (items || []).map(it => it.title).filter(Boolean);
    if (!titles.length) return {};
    try {
      const r = await fetch('/api/home/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles }),
      });
      if (r.status === 401) return {};
      const d = await r.json();
      return d.items || {};
    } catch (e) {
      return {};
    }
  }

  // monkey-patch renderPosterCard + loadPosterWall
  function patchPosterWall() {
    if (typeof window.renderPosterCard !== 'function') return;
    if (window.renderPosterCard.__enhanced) return;
    const orig = window.renderPosterCard;
    window.renderPosterCard = function (it) {
      let out = orig(it);
      // 注入角标容器
      if (!out.includes('poster-badges')) {
        out = out.replace(
          '<div class="poster-wrap">',
          `<div class="poster-wrap" data-title="${esc(it.title || '')}"><div class="poster-badges" data-badge-for="${esc(it.title || '')}"></div>`
        );
      }
      return out;
    };
    window.renderPosterCard.__enhanced = true;

    if (typeof window.loadPosterWall === 'function' && !window.loadPosterWall.__enhanced) {
      const origLoad = window.loadPosterWall;
      window.loadPosterWall = async function (type) {
        await origLoad(type);
        try { stampWallBadges(); } catch (e) {}
      };
      window.loadPosterWall.__enhanced = true;
    }
  }

  function stampWallBadges() {
    const cards = document.querySelectorAll('#posterWallGrid .poster-wall-card');
    if (!cards.length) return;
    const titles = [];
    cards.forEach(card => {
      const wrap = card.querySelector('.poster-wrap');
      if (!wrap) return;
      const title = (card.querySelector('[data-title]') || {}).getAttribute?.('data-title')
        || (card.querySelector('.poster-overlay-title') || {}).textContent
        || '';
      if (!title) return;
      wrap.setAttribute('data-title', title);
      if (!wrap.querySelector('.poster-badges')) {
        const slot = document.createElement('div');
        slot.className = 'poster-badges';
        slot.setAttribute('data-badge-for', title);
        wrap.appendChild(slot);
      }
      card.onclick = function (e) {
        if (e.target.closest && e.target.closest('.poster-fav-btn')) return;
        if (typeof window.searchResource === 'function') {
          window.searchResource(title);
        }
      };
      titles.push(title);
    });
    enrichPosterBadges(titles.map(t => ({ title: t }))).then(map => {
      document.querySelectorAll('#posterWallGrid .poster-wrap[data-title]').forEach(el => {
        const t = el.getAttribute('data-title');
        const slot = el.querySelector('[data-badge-for]');
        if (slot && map[t]) slot.outerHTML = badgeHtml(map[t]);
      });
    }).catch(() => {});
  }

  window.openDetailDrawer = function (title) {
    if (typeof window.searchResource === 'function') {
      window.searchResource(title);
    }
  };

  window.closeDetailDrawer = function () {
    document.getElementById('detailDrawerMask')?.remove();
    document.getElementById('detailDrawer')?.remove();
    document.body.style.overflow = '';
  };


  function setupPwa() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstall = e;
      const hint = document.getElementById('pwaHint');
      if (hint && !localStorage.getItem('vd_pwa_dismiss')) hint.classList.add('show');
    });
    document.getElementById('pwaOk')?.addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      document.getElementById('pwaHint')?.classList.remove('show');
    });
    document.getElementById('pwaNo')?.addEventListener('click', () => {
      localStorage.setItem('vd_pwa_dismiss', '1');
      document.getElementById('pwaHint')?.classList.remove('show');
    });
  }

  function boot() {
    ensureHomeSections();
    patchPosterWall();
    loadPersonal();
    setupPwa();
    // 不重绘海报墙（会骨架屏闪一下、随机打乱、看起来像改布局）
    // 只在已有卡片上盖角标
    setTimeout(() => { try { stampWallBadges(); } catch (e) {} }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 50));
  } else {
    setTimeout(boot, 50);
  }
  // 主页脚本较晚执行时再补丁一次
  window.addEventListener('load', () => {
    patchPosterWall();
    ensureHomeSections();
  });
})();

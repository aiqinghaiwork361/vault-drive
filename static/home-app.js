// HTML转义函数（全局）
const esc = (s) => {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
};

// ==================== 无障碍：卡片键盘导航 ====================
// 聚焦在资源卡片上时，Enter/Space 触发卡片点击（等同鼠标点击）
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target && e.target.closest ? e.target.closest('.resource-card') : null;
  if (!card) return;
  if (e.target !== card && e.target.closest('button, a, input, textarea')) return;
  e.preventDefault();
  card.click();
});

function linkifyAnn(text) {
  const raw = String(text || '');
  const parts = [];
  const re = /(https?:\/\/[^\s<>]+)|(@[a-zA-Z][a-zA-Z0-9_]{3,31})/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    if (m.index > last) parts.push(esc(raw.slice(last, m.index)));
    if (m[1]) {
      const url = m[1].replace(/[),.;]+$/, '');
      const tail = m[1].slice(url.length);
      parts.push(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ''))}</a>${esc(tail)}`);
    } else {
      const handle = m[2];
      parts.push(`<a href="https://t.me/${esc(handle.slice(1))}" target="_blank" rel="noopener">${esc(handle)}</a>`);
    }
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push(esc(raw.slice(last)));
  return parts.join('');
}

// ============================================================
// APPLICATION STATE & DATA
// ============================================================
const APP = {
  sourceFilter: 'all',
  searchQuery: '',
  searchPage: 1,
  searchResults: [],
  viewMode: localStorage.getItem('res_view_mode') || 'aggregate',
  searchTotal: 0,
  currentPage: 'home',
  currentSlide: 0,
  slideCount: 3,
  slideInterval: null,
  searchEngines: ['网盘搜索A', 'Pansou', '大力盘', '猪猪盘', '凌风云', '如风搜'],
};

// 真实数据从API加载
let RESOURCES = [];

// 搜索结果从API加载
let SEARCH_RESULTS = [];

// TMDB数据从API加载

// 真正刷新最新收录（v20260807_144417 重做版）：3 个骨架卡片 + 顶部进度条


// v20260807_154100: 主页 TMDB 海报墙（交错列）
let POSTER_WALL_TYPE = 'all';  // 'all' | 'movie' | 'tv' | 'anime' | 'top_rated'

function posterWallColCount() {
  const w = window.innerWidth || 1200;
  if (w <= 768) return 2;
  if (w <= 1200) return 5;
  return 6;
}

/** 轮询均分，避免短列留大块空白；总数取列数整数倍 */
function distributePosterItems(items, cols) {
  const n = Math.floor(items.length / cols) * cols;
  const list = items.slice(0, n || items.length);
  const columns = Array.from({ length: cols }, () => []);
  list.forEach((it, i) => columns[i % cols].push(it));
  return columns;
}

function renderPosterWallSkeleton(grid) {
  const cols = posterWallColCount();
  const per = 3;
  grid.innerHTML = Array.from({ length: cols }, () =>
    `<div class="poster-col">${Array.from({ length: per }, () =>
      '<div class="poster-skel skeleton-pulse"></div>'
    ).join('')}</div>`
  ).join('');
}

function renderPosterCard(it) {
  const poster = it.poster || it.backdrop || '';
  const year = it.year || it.date || '';
  const rating = it.rating || '';
  const tmdbId = it.tmdb_id || it.id || '';
  const mediaType = it.media_type || 'movie';
  const titleEsc = esc(it.title || '');
  const posterEsc = esc(poster);
  const titleJs = (it.title || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `
    <div class="resource-card poster-wall-card" onclick="searchResource('${titleJs}')" role="button" tabindex="0" aria-label="检索片源：${titleEsc}" style="cursor:pointer">
      <div class="poster-wrap">
        <img src="${posterEsc}" alt="${titleEsc}" loading="lazy" decoding="async" class="poster-item"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/>
        <div style="display:none;position:absolute;inset:0;background:var(--bg-card);place-items:center;color:var(--text-muted);font-size:0.75rem">无海报</div>
        <button type="button" class="poster-fav-btn"
          data-tmdb-id="${tmdbId}"
          data-media-type="${esc(mediaType)}"
          data-title="${titleEsc}"
          data-poster="${posterEsc}"
          data-year="${esc(String(year))}"
          data-rating="${esc(String(rating))}"
          onclick="event.stopPropagation();toggleWatchlist(this)"
          title="收藏">♡</button>
        ${rating ? `<div class="poster-rating">★ ${rating}</div>` : ''}
        <div class="poster-overlay">
          <div class="poster-overlay-title">${titleEsc}</div>
          <div class="poster-overlay-text">检索片源</div>
        </div>
      </div>
    </div>
  `;
}

async function loadPosterWall(type) {
  POSTER_WALL_TYPE = type;
  const grid = document.getElementById('posterWallGrid');
  const title = document.getElementById('posterWallTitle');
  if (!grid) return;

  const titles = {
    all: '本周热门影视',
    movie: '本周热门电影',
    tv: '本周热门剧集',
    anime: '热门动画',
    top_rated: '高分经典'
  };
  if (title) title.textContent = titles[type] || titles.all;

  renderPosterWallSkeleton(grid);

  try {
    let url = '/api/tmdb/trending?type=';
    if (type === 'movie') url += 'movie';
    else if (type === 'tv') url += 'tv';
    else if (type === 'anime') url = '/api/tmdb/discover?type=tv&genre=16&page=1&with_original_language=ja';
    else if (type === 'top_rated') url = '/api/tmdb/discover?type=movie&page=1&sort=vote_average.desc&vote=300';
    else url += 'week';

    const r = await fetch(url);
    const d = await r.json();
    // 无海报的条目会留下空白格，先丢掉
    let items = (d.items || []).filter(it => it.poster || it.backdrop);

    // v20260808: 每次刷新随机 shuffle — 前3固定热门，后面随机排序
    if (items.length > 3) {
      const top3 = items.slice(0, 3);
      const rest = items.slice(3);
      let seed = Date.now();
      const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      items = [...top3, ...rest];
    }

    const cols = posterWallColCount();
    const perCol = 3;
    items = items.slice(0, cols * perCol);

    if (!items.length) {
      grid.innerHTML = '<div style="width:100%;text-align:center;padding:60px;color:var(--text-secondary)">暂无数据</div>';
      return;
    }

    paintArchiveHero(items);

    const columns = distributePosterItems(items, cols);
    grid.innerHTML = columns.map((col) =>
      `<div class="poster-col">${col.map(renderPosterCard).join('')}</div>`
    ).join('');
    checkWatchlistStatus();
  } catch (e) {
    grid.innerHTML = '<div style="width:100%;text-align:center;padding:60px;color:var(--error,#f85149)">加载失败: ' + e.message + '</div>';
  }
}

// v20260816: 首屏胶片墙 — 用 TMDB 海报铺成缓慢漂移的背景
const TMDB_GENRE_ZH = {
  28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录',
  18: '剧情', 10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐',
  9648: '悬疑', 10749: '爱情', 878: '科幻', 10770: '电视电影', 53: '惊悚',
  10752: '战争', 37: '西部', 10759: '动作冒险', 10762: '儿童', 10763: '新闻',
  10764: '真人秀', 10765: '科幻奇幻', 10766: '肥皂剧', 10767: '脱口秀', 10768: '战争政治'
};
let HERO_FEATURE_ITEMS = [];
let HERO_FEATURE_IDX = 0;
let HERO_FEATURE_TIMER = null;

function formatHeroGenreLine(it) {
  const names = (it.genre_ids || [])
    .map(id => TMDB_GENRE_ZH[id])
    .filter(Boolean)
    .slice(0, 2);
  const kind = it.media_type === 'tv' ? '剧集' : (it.media_type === 'movie' ? '电影' : '');
  const parts = names.length ? names : [kind, it.year].filter(Boolean);
  if (names.length && it.year) parts.push(it.year);
  return parts.join(' · ') || '热门精选';
}

function paintHeroFeature(items) {
  const el = document.getElementById('heroFeature');
  if (!el) return;
  const list = (items || []).filter(it => it.title && (it.overview || '').trim());
  if (!list.length) {
    el.hidden = true;
    return;
  }
  HERO_FEATURE_ITEMS = list.slice(0, 8);
  HERO_FEATURE_IDX = 0;
  el.hidden = false;
  renderHeroFeature(false);
  if (HERO_FEATURE_TIMER) clearInterval(HERO_FEATURE_TIMER);
  if (HERO_FEATURE_ITEMS.length > 1) {
    HERO_FEATURE_TIMER = setInterval(() => {
      HERO_FEATURE_IDX = (HERO_FEATURE_IDX + 1) % HERO_FEATURE_ITEMS.length;
      renderHeroFeature(true);
    }, 7000);
  }
}

function renderHeroFeature(animate) {
  const el = document.getElementById('heroFeature');
  const it = HERO_FEATURE_ITEMS[HERO_FEATURE_IDX];
  if (!el || !it) return;
  const paint = () => {
    el.innerHTML = `
      <p class="hero-feature-genre">${esc(formatHeroGenreLine(it))}</p>
      <h4 class="hero-feature-title">${esc(it.title || '')}</h4>
      <p class="hero-feature-overview">${esc(it.overview || '')}</p>
    `;
    el.dataset.title = it.title || '';
    el.classList.remove('is-fading');
  };
  if (animate) {
    el.classList.add('is-fading');
    setTimeout(paint, 280);
  } else {
    paint();
  }
}

function searchHeroFeature() {
  const el = document.getElementById('heroFeature');
  const title = (el && el.dataset.title) || '';
  if (title) searchResource(title);
}

function paintArchiveHero(items) {
  const bg = document.querySelector('.archive-hero-bg');
  if (!bg || !items || !items.length) return;
  const posters = items
    .map(it => it.poster || it.backdrop || '')
    .filter(Boolean)
    .slice(0, 24);
  if (!posters.length) return;
  // 铺满 8 列网格：循环补齐
  while (posters.length < 24) posters.push(...posters.slice(0, Math.min(8, posters.length)));
  bg.classList.add('has-mosaic');
  bg.innerHTML = posters.slice(0, 24).map((src, i) =>
    `<div class="archive-hero-tile" style="animation-delay:${(i % 8) * 0.08}s"><img src="${src}" alt="" loading="lazy" decoding="async"></div>`
  ).join('');
  paintHeroFeature(items);
  // 海报墙就绪后再洗一次建议词（混入真实热门片名）
  try { loadDynamicSuggestions(items); } catch (e) {}
}

// v20260807_154100: 主页 chips 切换
function setHomeChip(el, type) {
  document.querySelectorAll('#posterFilterBar .filter-chip').forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-pressed', 'false');
  });
  if (el) {
    el.classList.add('active');
    el.setAttribute('aria-pressed', 'true');
  }
  loadPosterWall(type);
}

// v20260807_154100: 主页搜索
function executeHomeSearch() {
  const q = document.getElementById('homeSearchInput').value.trim();
  if (!q) return;
  searchResource(q);
}

// v20260817: 搜索建议 — 真随机 + 类目打散 + 避开上次结果 + 混入热门片名
const SUGGESTION_ICONS = ['🔥','🎬','📺','📦','🎌','🧟','🎭','🎨','🚀','🏜️','✨','🏆','🏰','💿','🎸','🧊','🌙','⚡'];

const SUGGESTION_POOL = [
  { q: '蜘蛛侠', cat: 'movie' }, { q: '奥德赛', cat: 'movie' }, { q: '权力的游戏', cat: 'tv' },
  { q: '4K HDR', cat: 'tech' }, { q: '鬼灭之刃', cat: 'anime' }, { q: '龙珠', cat: 'anime' },
  { q: '釜山行', cat: 'horror' }, { q: '周星驰', cat: 'actor' }, { q: '宫崎骏', cat: 'anime' },
  { q: '刘德华', cat: 'actor' }, { q: '张艺谋', cat: 'director' }, { q: '蓝光原盘', cat: 'tech' },
  { q: '星际穿越', cat: 'scifi' }, { q: '沙丘', cat: 'scifi' }, { q: '新片推荐', cat: 'new' },
  { q: 'Netflix', cat: 'streaming' }, { q: 'Disney+', cat: 'streaming' }, { q: '黑镜', cat: 'tv' },
  { q: '进击的巨人', cat: 'anime' }, { q: '流浪地球', cat: 'scifi' }, { q: '疯狂动物城', cat: 'movie' },
  { q: '三体', cat: 'scifi' }, { q: '奥本海默', cat: 'movie' }, { q: '芭比', cat: 'movie' },
  { q: '漫长的季节', cat: 'tv' }, { q: '狂飙', cat: 'tv' }, { q: '去有风的地方', cat: 'tv' },
  { q: '灌篮高手', cat: 'anime' }, { q: '海贼王', cat: 'anime' }, { q: '咒术回战', cat: 'anime' },
  { q: '诺兰', cat: 'director' }, { q: '克里斯托弗·诺兰', cat: 'director' }, { q: '昆汀', cat: 'director' },
  { q: '成龙', cat: 'actor' }, { q: '梁朝伟', cat: 'actor' }, { q: '汤姆·克鲁斯', cat: 'actor' },
  { q: '阿凡达', cat: 'movie' }, { q: '泰坦尼克号', cat: 'movie' }, { q: '盗梦空间', cat: 'scifi' },
  { q: '西部世界', cat: 'tv' }, { q: '绝命毒师', cat: 'tv' }, { q: '老友记', cat: 'tv' },
  { q: 'Dolby Vision', cat: 'tech' }, { q: '杜比视界', cat: 'tech' }, { q: 'IMAX', cat: 'tech' },
  { q: '港剧', cat: 'tv' }, { q: '日剧', cat: 'tv' }, { q: '韩剧', cat: 'tv' },
  { q: '纪录片', cat: 'doc' }, { q: '相声', cat: 'variety' }, { q: '演唱会', cat: 'music' },
  { q: '变形金刚', cat: 'movie' }, { q: '速度与激情', cat: 'movie' }, { q: '碟中谍', cat: 'movie' },
  { q: '复联', cat: 'movie' }, { q: '蝙蝠侠', cat: 'movie' }, { q: '小丑', cat: 'movie' },
  { q: '权游', cat: 'tv' }, { q: '漫威', cat: 'movie' }, { q: 'DC', cat: 'movie' },
  { q: '你的名字', cat: 'anime' }, { q: '千与千寻', cat: 'anime' }, { q: '铃芽之旅', cat: 'anime' },
  { q: '美剧', cat: 'tv' }, { q: '英剧', cat: 'tv' }, { q: '独立电影', cat: 'movie' }
];

function _suggestRand() {
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  } catch (e) {
    return Math.random();
  }
}

function _shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(_suggestRand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _pickDiverseSuggestions(pool, n) {
  const last = (() => {
    try { return JSON.parse(sessionStorage.getItem('vd_suggest_last') || '[]'); }
    catch (e) { return []; }
  })();
  const lastSet = new Set(last);
  let candidates = pool.filter(s => s.q && !lastSet.has(s.q));
  if (candidates.length < n) candidates = pool.slice();
  _shuffleInPlace(candidates);

  const picked = [];
  const usedCat = new Set();
  // 先尽量不同类目
  for (const s of candidates) {
    if (picked.length >= n) break;
    const cat = s.cat || 'x';
    if (usedCat.has(cat) && picked.length < n - 1) continue;
    picked.push(s);
    usedCat.add(cat);
  }
  // 补足
  for (const s of candidates) {
    if (picked.length >= n) break;
    if (picked.some(p => p.q === s.q)) continue;
    picked.push(s);
  }
  try { sessionStorage.setItem('vd_suggest_last', JSON.stringify(picked.map(p => p.q))); }
  catch (e) {}
  return picked;
}

function renderSuggestionTags(items) {
  const el = document.getElementById('dynamicSuggestions');
  if (!el) return;
  el.innerHTML = items.map(s => {
    const icon = s.icon || SUGGESTION_ICONS[Math.floor(_suggestRand() * SUGGESTION_ICONS.length)];
    const qJs = String(s.q).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<span class="suggestion-tag" onclick="quickSearch(\'' + qJs + '\')">' + icon + ' ' + esc(s.q) + '</span>';
  }).join('');
}

function loadDynamicSuggestions(extraTitles) {
  const extras = (extraTitles || [])
    .map(t => (typeof t === 'string' ? t : (t && t.title) || ''))
    .filter(Boolean)
    .map(title => ({ q: title, cat: 'hot', icon: '✨' }));
  // 热门片名最多掺 2 个，其余来自大词库，避免老四样
  _shuffleInPlace(extras);
  const mix = extras.slice(0, 2).concat(SUGGESTION_POOL);
  renderSuggestionTags(_pickDiverseSuggestions(mix, 4));
}

loadDynamicSuggestions();

function quickSearch(q) {
  document.getElementById('homeSearchInput').value = q;
  searchResource(q);
}


// 日志从API加载


// ============================================================
// NAVIGATION
// ============================================================
async function checkAdminAndNavigate(pageId, el) {
  try {
    const r = await fetch('/api/user/me');
    const d = await r.json();
    if (d.is_admin) {
      navigateTo(pageId, el);
    } else {
      showToast('需要管理员权限，请先登录', 'error');
      window.location.href = '/login';
    }
  } catch(e) {
    showToast('请先登录管理员账号', 'error');
    window.location.href = '/login';
  }
}

function showAdminLoginModal() {
  const modal = document.getElementById('adminLoginModal');
  if (modal) {
    modal.classList.add('show');
  } else {
    // 创建登录模态框
    const div = document.createElement('div');
    div.id = 'adminLoginModal';
    div.className = 'modal-overlay show';
    div.innerHTML = `
      <div class="modal-content" style="max-width:360px">
        <h3 style="margin-bottom:16px">管理员登录</h3>
        <form onsubmit="doAdminLogin(event)">
          <input type="text" id="adminUser" placeholder="用户名" class="form-input" style="width:100%;margin-bottom:12px;padding:10px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border-subtle);color:var(--text-primary)">
          <input type="password" id="adminPass" placeholder="密码" class="form-input" style="width:100%;margin-bottom:16px;padding:10px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border-subtle);color:var(--text-primary)">
          <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center">
            <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('adminLoginModal').classList.remove('show')">取消</button>
            <button type="submit" class="btn btn-primary btn-sm">登录</button>
            <a href="/login/github" class="btn btn-github btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              GitHub
            </a>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(div);
  }
}

async function doAdminLogin(e) {
  e.preventDefault();
  const user = document.getElementById('adminUser').value;
  const pass = document.getElementById('adminPass').value;
  try {
    // 获取CSRF token
    const csrfR = await fetch('/api/csrf-token');
    const csrfD = await csrfR.json();
    const csrfToken = csrfD.csrf_token || '';

    const r = await fetch('/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({username: user, password: pass})
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('adminLoginModal')?.classList.remove('show');
      showToast('登录成功', 'success');
      window.location.href = (d.role === 'admin' || d.role === 'superadmin' || d.redirect==='/admin') ? (d.redirect||'/admin') : (d.redirect||'/');
    } else {
      showToast(d.error || '用户名或密码错误', 'error');
    }
  } catch(e) {
    showToast('登录失败: ' + e.message, 'error');
  }
}

function navigateTo(pageId, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + pageId);
  if (target) target.classList.add('active');
  APP.currentPage = pageId;

  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('mode-home', pageId === 'home');
    app.classList.toggle('mode-search', pageId === 'search');
  }

  if (pageId === 'home') {
    document.querySelectorAll('#page-home .section-header').forEach(h => h.style.display = '');
    const wall = document.getElementById('posterWallGrid');
    if (wall) wall.style.display = '';
    const grid = document.getElementById('resourceGrid');
    if (grid) grid.style.display = 'none';
  }

  if (pageId === 'search') {
    const g = document.getElementById('globalSearch');
    if (g && !g.value && APP.searchQuery) g.value = APP.searchQuery;
  }
}


// ============================================================
// PROFILE FAVORITES
// ============================================================
async function loadProfileFavorites() {
  const container = document.getElementById('profileContent');
  if (!container) return;
  try {
    const r = await fetch('/api/favorites');
    if (r.status === 401 || r.status === 403) { handleFavoriteBlocked(r, await r.json().catch(() => ({}))); return; }
    const d = await r.json();
    const items = d.items || [];
    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">◇</div>
          <div>还没有收藏任何资源</div>
          <div style="margin-top:8px;font-size:0.85rem">浏览首页，点击资源卡片上的收藏按钮添加</div>
          <a href="/" class="btn btn-primary" style="margin-top:20px;display:inline-block">去逛逛</a>
        </div>`;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'card';
      const posterHtml = item.images ? `<img src="${item.images.split(',')[0]}" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='<div class=\\'card-poster-placeholder\\'>🎬</div>'">` : `<div class="card-poster-placeholder">🎬</div>`;
      const tags = [];
      if (item.type) tags.push(item.type);
      if (item.quality) tags.push(item.quality);
      if (item.year) tags.push(String(item.year));
      const tagHtml = tags.map(t => `<span class="card-tag">${t}</span>`).join('');
      card.innerHTML = `
        <div class="card-poster">${posterHtml}</div>
        <div class="card-body">
          <div class="card-title">${item.title || '无标题'}</div>
          <div class="card-meta">
            ${tagHtml}
            ${item.rating ? `<span class="card-rating">★ ${item.rating}</span>` : ''}
          </div>
          <div class="card-actions">
            <a href="${item.url}" target="_blank" class="btn btn-primary">查看资源</a>
            <button class="btn" onclick="removeProfileFav(${item.resource_id}, this)">取消收藏</button>
          </div>
        </div>`;
      grid.appendChild(card);
    }
    container.innerHTML = '';
    container.appendChild(grid);
  } catch(e) {
    container.innerHTML = `<div class="empty-state">加载失败: ${e.message}</div>`;
  }
}

async function removeProfileFav(rid, btn) {
  try {
    const r = await fetch(`/api/favorites/${rid}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      showToast('已取消收藏');
      const card = btn.closest('.card');
      if (card) card.remove();
      const grid = document.querySelector('#profileContent .card-grid');
      if (grid && grid.children.length === 0) loadProfileFavorites();
    } else {
      showToast(d.error || '操作失败');
    }
  } catch(e) {
    showToast('网络错误');
  }
}

async function getCsrfToken() {
  if (window._csrfToken) return window._csrfToken;
  try {
    const r = await fetch('/api/csrf-token');
    const d = await r.json();
    window._csrfToken = d.csrf_token || '';
  } catch (e) {
    window._csrfToken = '';
  }
  return window._csrfToken;
}

async function toggleFavorite(btn, rid) {
  if (!btn || !rid) return;
  const isFav = btn.classList.contains('is-fav');
  const csrf = await getCsrfToken();
  try {
    let r;
    if (isFav) {
      r = await fetch(`/api/favorites/${rid}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf }
      });
    } else {
      r = await fetch('/api/favorites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ resource_id: rid })
      });
    }
    const d = await r.json().catch(() => ({}));
    if (d.ok || d.success) {
      if (isFav) {
        btn.classList.remove('is-fav');
        btn.innerHTML = '♡';
        btn.title = '收藏';
        showToast('已取消收藏');
      } else {
        btn.classList.add('is-fav');
        btn.innerHTML = '♥';
        btn.title = '取消收藏';
        showToast('已收藏', 'success');
      }
    } else {
      if (handleFavoriteBlocked(r, d)) return;
      showToast(d.error || '操作失败', 'error');
    }
  } catch(e) {
    showToast('网络错误', 'error');
  }
}

async function toggleWatchlist(btn) {
  if (!btn) return;
  const tmdbId = parseInt(btn.getAttribute('data-tmdb-id'), 10);
  const mediaType = btn.getAttribute('data-media-type') || 'movie';
  if (!tmdbId) {
    showToast('无法收藏：缺少 TMDB ID', 'error');
    return;
  }
  const isFav = btn.classList.contains('is-fav');
  const csrf = await getCsrfToken();
  try {
    let r;
    if (isFav) {
      r = await fetch(`/api/watchlist/${tmdbId}?media_type=${encodeURIComponent(mediaType)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf }
      });
    } else {
      r = await fetch('/api/watchlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({
          tmdb_id: tmdbId,
          media_type: mediaType,
          title: btn.getAttribute('data-title') || '',
          poster: btn.getAttribute('data-poster') || '',
          year: btn.getAttribute('data-year') || '',
          rating: btn.getAttribute('data-rating') || ''
        })
      });
    }
    const d = await r.json().catch(() => ({}));
    if (d.ok || d.success) {
      if (isFav) {
        btn.classList.remove('is-fav');
        btn.textContent = '♡';
        btn.title = '收藏';
        showToast('已取消收藏');
      } else {
        btn.classList.add('is-fav');
        btn.textContent = '♥';
        btn.title = '取消收藏';
        showToast('已收藏', 'success');
      }
    } else if (handleFavoriteBlocked(r, d)) {
      return;
    } else {
      showToast(d.error || '操作失败', 'error');
    }
  } catch (e) {
    showToast('网络错误', 'error');
  }
}

async function checkFavoriteStatus(rids) {
  if (!rids.length) return;
  try {
    const r = await fetch('/api/favorites');
    if (r.status === 401 || r.status === 403) return;
    const d = await r.json();
    if (!d.items) return;
    const favIds = new Set(d.items.map(it => it.resource_id));
    document.querySelectorAll('.fav-btn').forEach(btn => {
      const id = parseInt(btn.getAttribute('data-id'), 10);
      if (favIds.has(id)) {
        btn.classList.add('is-fav');
        btn.innerHTML = '♥';
        btn.title = '取消收藏';
      }
    });
  } catch(e) {}
}

async function checkWatchlistStatus() {
  const buttons = document.querySelectorAll('.poster-fav-btn[data-tmdb-id]');
  if (!buttons.length) return;
  try {
    const r = await fetch('/api/watchlist');
    if (r.status === 401 || r.status === 403) return;
    const d = await r.json();
    if (!d.items) return;
    const keys = new Set(d.items.map(it => `${it.tmdb_id}:${it.media_type || 'movie'}`));
    buttons.forEach(btn => {
      const key = `${btn.getAttribute('data-tmdb-id')}:${btn.getAttribute('data-media-type') || 'movie'}`;
      if (keys.has(key)) {
        btn.classList.add('is-fav');
        btn.textContent = '♥';
        btn.title = '取消收藏';
      }
    });
  } catch (e) {}
}


// ============================================================
// HERO CAROUSEL
// ============================================================





// ============================================================
// CARD RENDERING
// ============================================================
function renderResourceCards(containerId, resources) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = resources.map(r => {
    const title = esc(r.title);
    const shortTitle = title.substring(0, 6);
    const posterHtml = r.poster
      ? `<img src="${esc(r.poster)}" alt="${title}" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="card-placeholder" style="display:none">${shortTitle}</div>`
      : `<div class="card-placeholder" style="display:flex">${shortTitle}</div>`;
    const ratingHtml = r.rating ? `<div class="card-rating">★ ${esc(r.rating)}</div>` : '';
    const qualityHtml = r.quality ? `<div class="card-quality">${esc(r.quality)}</div>` : '';
    const copyUrl = esc(r.url || '');
    return `
    <div class="resource-card" onclick="searchResource(this.querySelector('.card-title').textContent)" role="button" tabindex="0" aria-label="检索片源" style="cursor:pointer">
      <div class="card-poster">
        ${posterHtml}
        ${ratingHtml}
        ${qualityHtml}
        <div class="overlay-actions">
          <button class="btn-icon" onclick="event.stopPropagation();copyToClipboard('${copyUrl}')" title="复制链接">⎘</button>
          <button class="btn-icon fav-btn" data-id="${r.id}" onclick="event.stopPropagation();toggleFavorite(this, ${r.id})" title="收藏">♡</button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${title}</div>
        <div class="card-meta">
          <span class="source-dot" style="background:${esc(r.color || 'var(--text-muted)')}"></span>
          <span>${esc(r.source || r.year || '')}</span>
          ${r.year ? '<span>·</span><span>'+esc(r.year)+'</span>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function cleanTitle(title) {
  if (!title) return '未知标题';
  // 清理标题：去掉多余元数据
  let t = title
    .replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '') // 日期
    .replace(/(bd|hd|4k|1080p|720p|2160p)/gi, '') // 画质
    .replace(/[中英简繁日韩双字幕语]+/g, '') // 字幕
    .replace(/[　\s]+/g, ' ') // 全角空格
    .replace(/[-_]+/g, ' ') // 分隔符
    .replace(/\.(mp4|mkv|avi|rmvb|torrent)$/i, '') // 扩展名
    .replace(/(夸克|百度|阿里|迅雷|天翼|115|UC|PikPak|磁力)/gi, '') // 来源
    .replace(/(电影|剧集|动漫|综艺|纪录片)/g, '') // 类型
    .replace(/(国语|粤语|英语|日语|韩语)/g, '') // 语言
    .replace(/[|｜·]+/g, ' ') // 分隔符
    .replace(/\s+/g, ' ') // 多空格
    .trim();
  // 截取前30字符
  if (t.length > 35) t = t.substring(0, 35) + '...';
  return t || title.substring(0, 30);
}

function sourceKey(source) {
  return String(source || '').replace(/^plugin:/i, '').trim();
}

function getSourceColor(source) {
  const key = sourceKey(source);
  const colors = {
    quark: '#e4a853', aliyun: '#58a6ff', baidu: '#3fb950', xunlei: '#f85149',
    tianyi: '#bc8cff', '115': '#ff7b72', uc: '#79c0ff', pikpak: '#d2a8ff',
    guangya: '#fbbf24', magnet: '#c084fc', thunder: '#22d3ee', '123': '#fb923c',
    yidong: '#4ade80', thepiratebay: '#94a3b8', nyaa: '#94a3b8', hunhepan: '#a3a3a3'
  };
  return colors[key] || 'var(--text-muted)';
}

function detectSource(url) {
  if (!url) return '';
  url = url.toLowerCase();
  if (url.startsWith('magnet:')) return 'magnet';
  if (url.startsWith('thunder://')) return 'thunder';
  if (url.includes('pan.quark.cn') || url.includes('quark.cn')) return 'quark';
  if (url.includes('www.alipan.com') || url.includes('aliyundrive.com') || url.includes('alipan.com')) return 'aliyun';
  if (url.includes('pan.baidu.com') || url.includes('yun.baidu.com')) return 'baidu';
  if (url.includes('pan.xunlei.com') || url.includes('xunlei.com')) return 'xunlei';
  if (url.includes('cloud.189.cn') || url.includes('tianyi')) return 'tianyi';
  if (url.includes('115.com') || url.includes('115cdn.com')) return '115';
  if (url.includes('drive.uc.cn') || url.includes('www.uc.cn')) return 'uc';
  if (url.includes('mypikpak.com') || url.includes('pikpak')) return 'pikpak';
  if (url.includes('www.123pan.com') || url.includes('123pan.com') || url.includes('123云盘')) return '123';
  if (url.includes('yun.139.com') || url.includes('移动云')) return 'yidong';
  if (url.includes('wenshuliu')) return 'wenshuliu';
  if (url.includes('kuake')) return 'kuake';
  if (url.includes('mzclk')) return 'mzclk';
  return '';
}

function getSourceName(source) {
  if (!source) return '未知';
  const key = sourceKey(source);
  const names = {
    quark: '夸克网盘', aliyun: '阿里云盘', baidu: '百度网盘', xunlei: '迅雷网盘',
    tianyi: '天翼网盘', '115': '115网盘', uc: 'UC网盘', pikpak: 'PikPak',
    guangya: '光鸭盘', magnet: '磁力', thunder: '迅雷链',
    quark4k: '夸克4K', yuhuage: '玉花阁', thepiratebay: '海盗湾', nyaa: 'Nyaa',
    hunhepan: '混合盘', xiaozhang: '小张', wanou: '万欧', mizixing: '米子星',
    muou: '木偶', duoduo: '多多', qupanshe: '趣盘社', aikanzy: '爱看资源',
    ash: 'Ash', kkv: 'KKV', daishudj: '带书DJ', jutoushe: '聚头社',
    ouge: '欧哥', labi: '辣笔', u3c3: 'U3C3', mobile: '移动端', '123': '123云盘', yidong: '移动云'
  };
  return names[key] || key;
}

function toggleViewMode(mode) {
  APP.viewMode = mode;
  localStorage.setItem('res_view_mode', mode);
  renderSearchResults(APP.searchResults, APP.searchTotal, false);
}

async function reportDeadLink(rid, btn) {
  if (!rid) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '提交中…';
  }
  try {
    const res = await fetch('/api/resource/' + rid + '/report_dead', { method: 'POST' });
    const data = await res.json();
    if (data && data.ok) {
      if (btn) {
        btn.textContent = '已反馈';
        btn.style.color = '#34d399';
      }
      if (typeof showToast === 'function') showToast('感谢反馈！已加入复检队列', 'success');
      else alert('感谢反馈！已加入优先复检队列');
    } else {
      if (btn) {
        btn.textContent = '已提交';
        btn.disabled = true;
      }
      if (typeof showToast === 'function') showToast(data.error || '已提交', 'info');
    }
  } catch(e) {
    if (btn) {
      btn.textContent = '已提交';
      btn.disabled = true;
    }
  }
}

function renderSearchResults(results, total, hasMore) {
  const container = document.getElementById('searchResults');
  if (!container) return;

  if (results.length) {
    container.style.transition = 'none';
    container.style.opacity = '0.3';
    const grouped = {};
    results.forEach(r => {
      const src = r.source || '未知';
      if (!grouped[src]) grouped[src] = [];
      grouped[src].push(r);
    });
    if (!APP.sourceFilter || APP.sourceFilter === 'all') {
      APP.sourceChipStats = {};
      Object.keys(grouped).forEach(src => { APP.sourceChipStats[src] = grouped[src].length; });
      APP.sourceChipStats._total = total;
    }
    const chipStats = APP.sourceChipStats || {};
    const sources = Object.keys(chipStats).filter(k => k !== '_total').sort((a, b) => (chipStats[b]||0) - (chipStats[a]||0));

    if (!APP.sourceFilter) APP.sourceFilter = 'all';
    const isFiltered = APP.sourceFilter !== 'all';
    const chipTotal = (chipStats._total != null) ? chipStats._total : total;
    const totalPages = Math.ceil(total / APP.pageSize) || 1;
    const currentPage = APP.searchPage || 1;
    const isAggregate = APP.viewMode === 'aggregate';

    const chipHtml = (src, label, count, active) => {
      const color = src === 'all' ? 'var(--green)' : getSourceColor(src);
      const cls = active ? 'filter-chip active' : 'filter-chip';
      const extra = active && src !== 'all' ? ` style="background:${color}22;border-color:${color};color:${color}"` : '';
      return `<button type="button" class="${cls}" onclick="filterBySource('${String(src).replace(/'/g, "\'")}')"${extra}>${esc(label)} <strong>${count}</strong></button>`;
    };

    let contentHtml = '';
    if (isAggregate) {
      const aggMap = new Map();
      results.forEach(r => {
        const titleKey = cleanTitle(r.title || '').trim().toLowerCase();
        if (!aggMap.has(titleKey)) {
          aggMap.set(titleKey, {
            mainTitle: cleanTitle(r.title || ''),
            type: r.type || '',
            year: r.year || '',
            rating: r.rating || '',
            items: []
          });
        }
        const g = aggMap.get(titleKey);
        g.items.push(r);
        if (!g.type && r.type) g.type = r.type;
        if (!g.year && r.year) g.year = r.year;
        if (!g.rating && r.rating) g.rating = r.rating;
      });

      const groups = Array.from(aggMap.values());
      contentHtml = `
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${groups.map(g => {
            const srcCounts = {};
            let has4k = false;
            let has1080 = false;
            g.items.forEach(it => {
              const s = it.source || 'other';
              srcCounts[s] = (srcCounts[s] || 0) + 1;
              const q = (it.quality || it.title || '').toUpperCase();
              if (q.includes('4K') || q.includes('2160')) has4k = true;
              else if (q.includes('1080')) has1080 = true;
            });
            const topQuality = has4k ? '4K UHD' : (has1080 ? '1080P' : (g.items[0]?.quality || ''));
            const srcPills = Object.keys(srcCounts).slice(0, 4).map(s => {
              const col = getSourceColor(s);
              return `<span class="group-pill" style="color:${col};background:${col}18;border:1px solid ${col}44;">${esc(getSourceName(s))} (${srcCounts[s]})</span>`;
            }).join('');

            return `
              <article class="search-group-card">
                <div class="group-header">
                  <div class="group-title-wrap">
                    <div class="group-main-title">${esc(g.mainTitle)}</div>
                    <div class="group-meta-tags">
                      <span class="group-pill group-pill-count">收录 ${g.items.length} 个版本</span>
                      ${topQuality ? `<span class="group-pill group-pill-quality">${esc(topQuality)}</span>` : ''}
                      ${g.type ? `<span class="group-pill" style="background:rgba(255,255,255,0.06);color:var(--text-secondary);">${esc(g.type)}</span>` : ''}
                      ${g.year ? `<span style="font-size:0.75rem;color:var(--text-muted);">${esc(g.year)}</span>` : ''}
                      ${g.rating ? `<span style="font-size:0.75rem;color:#f59e0b;">★ ${esc(g.rating)}</span>` : ''}
                      ${srcPills}
                    </div>
                  </div>
                </div>
                <div class="group-versions-list">
                  ${g.items.map(it => {
                    const srcCol = getSourceColor(it.source);
                    const isMagnet = it.source === 'magnet' || (it.url && String(it.url).startsWith('magnet:'));
                    const qTag = it.quality ? `<span style="color:#10b981;font-size:0.72rem;font-weight:600;">[${esc(it.quality)}]</span> ` : '';
                    return `
                      <div class="version-row">
                        <div class="version-info">
                          <span class="version-src" style="color:${srcCol};background:${srcCol}22;border:1px solid ${srcCol}55;">${esc(getSourceName(it.source))}</span>
                          <span class="version-title" title="${esc(it.title)}">${qTag}${esc(it.title)}</span>
                        </div>
                        <div class="version-actions">
                          <button type="button" class="btn btn-primary btn-sm" data-url="${esc(it.url || '')}" onclick="event.stopPropagation();copyToClipboard(this.dataset.url)" style="padding:3px 8px;font-size:0.75rem;">复制</button>
                          ${isMagnet ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-url="${esc(it.url || '')}" onclick="event.stopPropagation();if(this.dataset.url) window.open(this.dataset.url,'_blank')" style="padding:3px 8px;font-size:0.75rem;">打开</button>`}
                          <button type="button" class="btn btn-ghost btn-sm btn-report" onclick="event.stopPropagation();reportDeadLink(${Number(it.id)||0}, this)" title="失效报错" style="padding:3px 6px;font-size:0.72rem;">⚠️ 报错</button>
                        </div>
                      </div>`;
                  }).join('')}
                </div>
              </article>`;
          }).join('')}
        </div>`;
    } else {
      contentHtml = `
        <div class="search-card-grid">
          ${results.map(r => {
            const clean = cleanTitle(r.title);
            const srcColor = getSourceColor(r.source);
            const srcName = getSourceName(r.source);
            const isMagnet = r.source === 'magnet' || (r.url && String(r.url).startsWith('magnet:'));
            const meta = [r.type, r.year, r.quality].filter(Boolean).join(' · ');
            return `
              <article class="search-card">
                <div class="search-card-top">
                  <span class="search-card-source" style="color:${srcColor};background:${srcColor}22;border:1px solid ${srcColor}55">${esc(srcName)}</span>
                  <div style="display:flex;gap:4px;">
                    <button type="button" class="btn btn-ghost btn-sm btn-report" onclick="event.stopPropagation();reportDeadLink(${Number(r.id)||0}, this)" title="失效报错" style="font-size:0.7rem;padding:2px 5px;">⚠️ 报错</button>
                    <button type="button" class="btn btn-ghost btn-sm fav-btn" data-id="${r.id || ''}" onclick="event.stopPropagation();toggleFavorite(this,${Number(r.id)||0})" title="收藏">♡</button>
                  </div>
                </div>
                <div class="search-card-title" title="${esc(clean)}">${esc(clean)}</div>
                ${meta ? `<div class="search-card-meta">${esc(meta)}</div>` : '<div class="search-card-meta">网盘资源</div>'}
                <div class="search-card-actions">
                  <button type="button" class="btn btn-primary btn-sm" data-url="${esc(r.url || '')}" onclick="event.stopPropagation();copyToClipboard(this.dataset.url)">复制链接</button>
                  ${isMagnet ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-url="${esc(r.url || '')}" onclick="event.stopPropagation();if(this.dataset.url) window.open(this.dataset.url,'_blank')">打开</button>`}
                </div>
              </article>`;
          }).join('')}
        </div>`;
    }

    container.innerHTML = `
      <div class="search-toolbar">
        <div class="search-toolbar-count">找到 <em>${total}</em> 条结果${isFiltered && chipTotal !== total ? ` <span style="font-size:.75rem;color:var(--text-secondary);font-weight:400">（筛选自 ${chipTotal} 条）</span>` : ''}</div>
        <div style="display:flex;align-items:center;gap:12px;">
          <div class="search-view-toggle">
            <button type="button" class="search-view-btn ${isAggregate ? 'active' : ''}" onclick="toggleViewMode('aggregate')">⚡ 聚合折叠</button>
            <button type="button" class="search-view-btn ${!isAggregate ? 'active' : ''}" onclick="toggleViewMode('flat')">☰ 平铺列表</button>
          </div>
          <div class="search-toolbar-size">
            每页
            <select id="pageSizeSelect" onchange="changePageSize(this.value)">
              ${[10,20,30,50].map(n => '<option value="' + n + '"' + (n === APP.pageSize ? ' selected' : '') + '>' + n + '</option>').join('')}
            </select>
            条
          </div>
        </div>
      </div>
      <div class="search-source-chips">
        ${chipHtml('all', '全部', chipTotal, APP.sourceFilter === 'all')}
        ${sources.map(src => chipHtml(src, getSourceName(src), chipStats[src]||0, APP.sourceFilter === src)).join('')}
      </div>
      ${contentHtml}
      ${totalPages > 1 ? `
        <div class="search-pager">
          <button type="button" onclick="goSearchPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
          ${Array.from({length: Math.min(totalPages, 7)}, (_, i) => {
            let p;
            if (totalPages <= 7) p = i + 1;
            else if (currentPage <= 4) p = i + 1;
            else if (currentPage >= totalPages - 3) p = totalPages - 6 + i;
            else p = currentPage - 3 + i;
            return '<button type="button" class="' + (p === currentPage ? 'is-current' : '') + '" onclick="goSearchPage(' + p + ')">' + p + '</button>';
          }).join('')}
          <button type="button" onclick="goSearchPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>
          <span class="pg-meta">${currentPage}/${totalPages}页</span>
        </div>` : ''}
    `;
    requestAnimationFrame(() => {
      container.style.transition = 'opacity 0.12s ease';
      container.style.opacity = '1';
    });
    checkFavoriteStatus(results.map(r => r.id).filter(Boolean));
  } else {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⌕</div>
        <div class="empty-title">没有找到相关资源</div>
        <div class="empty-desc">换个片名试试，或回到首页点一张海报</div>
      </div>`;
  }
}

// 按来源筛选：走 API，避免只筛当前页 30 条
function filterBySource(source) {
  APP.sourceFilter = source || 'all';
  APP.searchPage = 1;
  const q = APP.searchQuery || document.getElementById('globalSearch')?.value?.trim() || '';
  if (!q) {
    renderSearchResults(APP.searchResults, APP.searchTotal, false);
    return;
  }
  loadSearchResults(q, 1, true);
}


// ============================================================
// SEARCH
// ============================================================
window.VD_LOGGED_IN = false;
window.VD_IN_GROUP = false;

function goLoginForFavorites() {
  window.location.href = '/login?next=' + encodeURIComponent('/profile');
}

function guardFavoritesNav(e) {
  if (window.VD_IN_GROUP) return true;
  if (e) e.preventDefault();
  goLoginForFavorites();
  return false;
}

function handleFavoriteBlocked(r, d) {
  if (r && (r.status === 401 || r.status === 403 || (d && d.join_required))) {
    goLoginForFavorites();
    return true;
  }
  return false;
}

function requireLogin(opts) {
  // 前台搜索/片源暂不强制登录；收藏走登录页引流
  return true;
}

function executeSearch() {
  const q = (document.getElementById('globalSearch')?.value || '').trim();
  if (!q) return;
  searchResource(q);
}

function searchResource(query) {
  const q = (query || '').trim();
  if (!q) return;
  const g = document.getElementById('globalSearch');
  if (g) g.value = q;
  const h = document.getElementById('homeSearchInput');
  if (h) h.value = q;
  navigateTo('search');
  executeAggSearch();
}

let _searchTimer = null;
function executeAggSearch() {
  const q = (document.getElementById('globalSearch')?.value || '').trim();
  if (!q) return;
  // 防抖：300ms内多次输入只执行最后一次
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => _doSearch(q), 300);
}
function _doSearch(q) {
  APP.searchQuery = q;
  APP.searchPage = 1;
  APP.searchResults = [];
  APP.sourceFilter = 'all';  // 重置筛选
  APP._onlinePollTimer = null;
  APP.searchTotal = 0;
  APP.sourceChipStats = null;
  document.getElementById('onlineStatusBanner')?.remove();
  
  const container = document.getElementById('searchResults');
  const skelRows = [0, 1, 2, 3, 4, 5].map(() => `
    <div class="search-skel-row" aria-hidden="true">
      <div class="search-skel-thumb"></div>
      <div class="search-skel-body">
        <div class="search-skel-line w-65"></div>
        <div class="search-skel-line w-42"></div>
        <div class="search-skel-line w-28"></div>
      </div>
    </div>
  `).join('');
  container.innerHTML = `
    <div id="searchLoadingAnim" class="search-loading" role="status" aria-live="polite">
      <div class="search-loading-head">
        <span class="search-loading-spinner" aria-hidden="true"></span>
        <span class="search-loading-label">正在检索 <em>${q.replace(/[<>&"']/g, '')}</em></span>
      </div>
      <div class="search-card-grid">${skelRows}</div>
    </div>
  `;
  
  // v20260816: 先等本地库结果落盘，再启动在线轮询，避免「本地 0 · 新增=总计」假数据
  loadSearchResults(q, 1, true).then((localTotal) => {
    _pollOnlineResults(q, typeof localTotal === 'number' ? localTotal : (APP.searchTotal || 0));
  });
}

// 加载搜索结果（首批30条动画滑入，剩余分页）
// 每页条数（可切换）
if (!APP.pageSize) APP.pageSize = 30;
function loadSearchResults(q, page, isNew, appendOnly) {
  const container = document.getElementById('searchResults');
  if (!container) return Promise.resolve(0);
  
  const srcParam = (APP.sourceFilter && APP.sourceFilter !== 'all') ? '&source=' + encodeURIComponent(APP.sourceFilter) : '';
  const resourcesUrl = '/api/resources?q=' + encodeURIComponent(q) + '&page=' + page + '&per_page=' + APP.pageSize + srcParam;
  const tagsPromise = (!srcParam && isNew && !appendOnly)
    ? fetch('/api/src_tags?q=' + encodeURIComponent(q)).then(r => r.json()).catch(() => null)
    : Promise.resolve(null);

  return Promise.all([
    fetch(resourcesUrl).then(r => r.json()),
    tagsPromise
  ]).then(([d, tagsData]) => {
      const total = d.total || 0;
      if (tagsData && tagsData.ok && Array.isArray(tagsData.tags)) {
        APP.sourceChipStats = { _total: total };
        tagsData.tags.forEach(t => {
          if (t && t.source) APP.sourceChipStats[t.source] = t.cnt || 0;
        });
      }
      const items = (d.items || d.resources || []).map(it => {
        const src = detectSource(it.url) || it.source || '';
        return {
          id: it.id,
          title: it.title || it.note || '',
          source: src,
          desc: [src, it.type, it.year].filter(Boolean).join(' · '),
          tags: [it.quality, src, it.type].filter(Boolean),
          poster: it.poster || '',
          url: it.url || '',
          password: it.password || ''
        };
      });
      
      // 增量追加模式：在线搜索结果到达时，只追加新条目
      if (appendOnly) {
        const oldSet = new Set(APP.searchResults.map(r => r.url || r.title));
        const newItems = items.filter(it => !oldSet.has(it.url || it.title));
        if (newItems.length > 0) {
          APP.searchResults = APP.searchResults.concat(newItems);
          APP.searchTotal = total;
          _appendSearchResultCards(newItems, total);
          _updateResultCount(total);
        } else {
          APP.searchTotal = total;
          _updateResultCount(total);
        }
        return total;
      }
      
      if (isNew) {
        APP.searchResults = items;
      } else {
        APP.searchResults = APP.searchResults.concat(items);
      }
      
      APP.searchPage = page;
      APP.searchTotal = total;
      
      renderSearchResults(APP.searchResults, total, APP.searchResults.length < total);
      return total;
    })
    .catch(e => {
      container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-secondary)">搜索出错: ' + e.message + '</div>';
      return 0;
    });
}

// 增量追加搜索结果卡片（不替换已有DOM）
function _appendSearchResultCards(newItems, total) {
  const container = document.getElementById('searchResults');
  if (!container || !newItems.length) return;
  const cardContainer = container.querySelector('div[style*="flex-direction:column"]');
  if (!cardContainer) return;
  
  const sourceColors = {quark:'#e4a853', aliyun:'#58a6ff', baidu:'#3fb950', xunlei:'#f85149', tianyi:'#bc8cff', 115:'#ff7b72', uc:'#79c0ff', pikpak:'#d2a8ff', guangya:'#00bcd4', magnet:'#9c27b0', thunder:'#00bcd4', '123':'#ff9800', yidong:'#4caf50'};
  const sourceNames = {quark:'夸克网盘', aliyun:'阿里云盘', baidu:'百度网盘', xunlei:'迅雷网盘', tianyi:'天翼网盘', 115:'115网盘', uc:'UC网盘', pikpak:'PikPak', guangya:'光鸭盘', magnet:'磁力链接', thunder:'迅雷链接', '123':'123云盘', yidong:'移动云'};
  
  const html = newItems.map(r => {
    const clean = cleanTitle(r.title);
    const srcColor = sourceColors[r.source] || 'var(--text-muted)';
    const srcName = sourceNames[r.source] || r.source || '其他';
    return `
      <div class="resource-card" style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px;animation:fadeInUp 0.3s ease">
        <div style="width:36px;height:36px;border-radius:8px;background:${srcColor}15;color:${srcColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex-shrink:0">${r.source === 'quark' ? '夸' : r.source === 'aliyun' ? '阿' : r.source === 'baidu' ? '百' : r.source === 'uc' ? 'UC' : r.source === 'guangya' ? '光' : r.source === 'magnet' ? '⛓' : r.source === 'thunder' ? '⚡' : r.source === '123' ? '123' : r.source === 'xunlei' ? '迅' : r.source === 'tianyi' ? '天' : r.source === '115' ? '15' : r.source === 'yidong' ? '移' : '盘'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.85rem;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${clean}</div>
          <div style="font-size:.72rem;color:${srcColor};margin-top:2px">${srcName}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();copyToClipboard('${(r.url||'').replace(/'/g,"\\'")}')" style="font-size:.72rem;padding:4px 8px">复制</button>
          <button class="btn btn-ghost btn-sm fav-btn" data-id="${r.id || ''}" onclick="event.stopPropagation();toggleFavorite(this,${r.id || 0})" style="font-size:.72rem;padding:4px 8px">♡</button>
          ${(r.url && r.url.startsWith('magnet:')) ? '' : `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.open('${(r.url||'').replace(/'/g,"\\'")}','_blank')" style="font-size:.72rem;padding:4px 8px">打开</button>`}
        </div>
      </div>`;
  }).join('');
  
  cardContainer.insertAdjacentHTML('beforeend', html);
}

// 更新结果计数（不替换整个DOM）
function _updateResultCount(total) {
  const container = document.getElementById('searchResults');
  if (!container) return;
  const countSpan = container.querySelector('span[style*="color:var(--blue)"]');
  if (countSpan) countSpan.textContent = total;
}

// 轮询在线搜索结果（v20260807_142510 hybrid 重构版 + v20260807_152131 防循环修复）
// 改用 DB 轮询：在线结果已经入库，前端每次调 /api/resources 看 DB total 增长
// 配合 /api/online_status 状态判断何时停止
let _onlinePollCount = 0;
let _onlineInitialCount = 0;  // 初次 DB 结果数（基准）
let _onlineLastTotal = 0;
function _pollOnlineResults(q, localBaseline) {
  // v20260807_152131: 防重复轮询 — 同一 keyword 已轮询中就跳过
  if (APP._onlinePollKeyword === q && APP._onlinePollTimer) {
    return;
  }
  // 不同 keyword 或没轮询 → 重置
  if (APP._onlinePollTimer) {
    clearInterval(APP._onlinePollTimer);
    APP._onlinePollTimer = null;
  }
  APP._onlinePollKeyword = q;
  _onlinePollCount = 0;
  // v20260816: 基准必须来自「本轮本地查询完成」后的 total，禁止用默认 0
  _onlineInitialCount = Math.max(0, Number(localBaseline) || APP.searchTotal || 0);
  _onlineLastTotal = _onlineInitialCount;
  const initialPage1Count = APP.searchResults.length;

  // 本地已有结果时，后端不会再触发在线搜：直接展示库内条数，短轮询确认状态即可
  _updateOnlineStatusBanner(q, _onlineInitialCount, _onlineInitialCount, _onlineInitialCount > 0 ? 'local' : 'pending', 0);

  APP._onlinePollTimer = setInterval(() => {
    _onlinePollCount++;
    if (_onlinePollCount > 25) { // 最多25秒
      clearInterval(APP._onlinePollTimer);
      APP._onlinePollTimer = null;
      APP._onlinePollKeyword = null;
      _removeOnlineSkeleton();
      _updateOnlineStatusBanner(q, _onlineLastTotal, _onlineInitialCount, 'done');
      return;
    }
    // 并行查 DB + 状态
    Promise.all([
      fetch('/api/resources?q=' + encodeURIComponent(q) + '&page=1&per_page=' + APP.pageSize).then(r => r.json()),
      fetch('/api/online_status?q=' + encodeURIComponent(q)).then(r => r.json())
    ]).then(([dbData, statusData]) => {
      // v20260807_152131: 用户已切到别的 keyword，忽略本轮结果
      if (APP._onlinePollKeyword !== q) return;

      const newTotal = dbData.total || 0;
      _onlineLastTotal = newTotal;
      const onlineAdded = statusData.imported || 0;
      let status = statusData.status || 'pending';

      // 本地已有数据且未在跑在线搜：视为库内命中，不要把旧 Redis done 当成「本次新增」
      if (_onlineInitialCount > 0 && status !== 'running') {
        if (status === 'pending' || (status === 'done' && newTotal <= _onlineInitialCount)) {
          clearInterval(APP._onlinePollTimer);
          APP._onlinePollTimer = null;
          APP._onlinePollKeyword = null;
          _removeOnlineSkeleton();
          _updateOnlineStatusBanner(q, newTotal, _onlineInitialCount, 'local', 0);
          return;
        }
      }

      // 本地 0 且一直 pending：后端可能未启动，继续等；超时后上面会收尾
      _updateOnlineStatusBanner(q, newTotal, _onlineInitialCount, status, onlineAdded);

      if (status === 'done' || status === 'error') {
        clearInterval(APP._onlinePollTimer);
        APP._onlinePollTimer = null;
        APP._onlinePollKeyword = null;
        _removeOnlineSkeleton();
        const gained = Math.max(0, newTotal - _onlineInitialCount);
        if (gained > 0) {
          showToast(`在线搜索完成，新增 ${gained} 条`, 'success');
          loadSearchResults(q, 1, true, true);
        } else if (status === 'done' && _onlineInitialCount === 0) {
          showToast('在线搜索完成，无新增结果', 'info');
        }
      } else if (status === 'running') {
        if (_onlinePollCount % 3 === 0 && newTotal > initialPage1Count) {
          loadSearchResults(q, 1, true, true);
        }
      }
    }).catch(() => {});
  }, 1000);
}

// 更新在线搜索状态横幅
function _updateOnlineStatusBanner(q, total, initialTotal, status, imported) {
  let banner = document.getElementById('onlineStatusBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'onlineStatusBanner';
    banner.style.cssText = 'margin:8px 16px;padding:8px 14px;border-radius:8px;background:rgba(10,107,92,0.08);border:1px solid rgba(10,107,92,0.2);font-size:.85rem;color:var(--text-primary);display:flex;align-items:center;justify-content:space-between;gap:12px';
    const container = document.getElementById('searchResults');
    if (container && container.parentNode) {
      container.parentNode.insertBefore(banner, container);
    }
  }
  const onlineCount = Math.max(0, total - initialTotal);
  let statusText = '';
  if (status === 'local') {
    statusText = '<span style="color:var(--green)">✓ 库内结果</span>';
  } else if (status === 'running' || (status === 'pending' && initialTotal === 0)) {
    statusText = '<span class="search-loading-spinner" style="width:12px;height:12px;border-width:1.5px;display:inline-block;vertical-align:-2px"></span> 在线补充中…';
  } else if (status === 'pending') {
    statusText = '<span style="color:var(--text-secondary)">库内检索</span>';
  } else if (status === 'done') {
    statusText = onlineCount > 0
      ? '<span style="color:#3fb950">✓ 在线搜索完成</span>'
      : '<span style="color:var(--green)">✓ 库内结果</span>';
  } else if (status === 'error') {
    statusText = '<span style="color:#f85149">⚠ 在线搜索出错</span>';
  }

  let countHtml = '';
  if (status === 'local' || (status === 'done' && onlineCount === 0)) {
    countHtml = `库内 <strong style="color:var(--text-primary)">${total}</strong> 条`;
  } else if (onlineCount > 0) {
    countHtml = `库内 <strong style="color:var(--text-primary)">${initialTotal}</strong> 条 · 本次新增 <strong style="color:var(--blue)">${onlineCount}</strong> 条 · 合计 <strong style="color:var(--text-primary)">${total}</strong> 条`;
  } else {
    countHtml = `库内 <strong style="color:var(--text-primary)">${initialTotal}</strong> 条`;
  }

  banner.innerHTML = `
    <span>${statusText}</span>
    <span style="color:var(--text-secondary);font-size:.8rem">${countHtml}</span>
  `;
}

// 插入在线搜索加载骨架
function _insertOnlineSkeleton(afterIndex) {
  _removeOnlineSkeleton();
  const container = document.getElementById('searchResults');
  if (!container) return;
  const cardContainer = container.querySelector('div[style*="flex-direction:column"]');
  if (!cardContainer) return;
  const cards = cardContainer.querySelectorAll('.resource-card');
  
  const skeleton = document.createElement('div');
  skeleton.className = 'online-loading-skeleton';
  skeleton.innerHTML = `
    <div class="online-loading-divider">
      <span class="online-loading-label">
        <span class="search-loading-spinner" aria-hidden="true"></span>
        在线补充中…
      </span>
    </div>
    ${[1, 2, 3].map(() => `
      <div class="search-skel-row" aria-hidden="true" style="margin-bottom:8px;opacity:.85">
        <div class="search-skel-thumb" style="width:36px;height:36px;border-radius:8px"></div>
        <div class="search-skel-body">
          <div class="search-skel-line w-65"></div>
          <div class="search-skel-line w-28"></div>
        </div>
      </div>
    `).join('')}
  `;

  if (afterIndex < cards.length) {
    cards[afterIndex].parentNode.insertBefore(skeleton, cards[afterIndex]);
  } else {
    cardContainer.appendChild(skeleton);
  }
}

// 移除加载骨架
function _removeOnlineSkeleton() {
  document.querySelectorAll('.online-loading-skeleton').forEach(el => el.remove());
}

// 直接追加卡片到DOM（不重新渲染已有内容，避免跳动）
const _srcColors = {quark:'#e4a853', aliyun:'#58a6ff', baidu:'#3fb950', xunlei:'#f85149', tianyi:'#bc8cff', 115:'#ff7b72', uc:'#79c0ff', pikpak:'#d2a8ff', guangya:'#00bcd4', magnet:'#9c27b0', thunder:'#00bcd4', '123':'#ff9800', yidong:'#4caf50'};
const _srcNames = {quark:'夸克网盘', aliyun:'阿里云盘', baidu:'百度网盘', xunlei:'迅雷网盘', tianyi:'天翼网盘', 115:'115网盘', uc:'UC网盘', pikpak:'PikPak', guangya:'光鸭盘', magnet:'磁力链接', thunder:'迅雷链接', '123':'123云盘', yidong:'移动云'};

function _appendCardsToDOM(items) {
  const container = document.getElementById('searchResults');
  if (!container) return;
  const cardContainer = container.querySelector('div[style*="flex-direction:column"]');
  if (!cardContainer) return;
  
  const frag = document.createDocumentFragment();
  items.forEach(r => {
    const clean = cleanTitle(r.title);
    const src = r.source || '其他';
    const srcColor = _srcColors[src] || 'var(--text-muted)';
    const srcName = _srcNames[src] || src;
    const isMagnet = src === 'magnet' || (r.url && r.url.startsWith('magnet:'));
    const card = document.createElement('div');
    card.className = 'resource-card';
    card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px';
    card.innerHTML = `
      <div style="width:36px;height:36px;border-radius:8px;background:${srcColor}15;color:${srcColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex-shrink:0">${src==='quark'?'夸':src==='aliyun'?'阿':src==='baidu'?'百':src==='uc'?'UC':src==='guangya'?'光':src==='magnet'?'⛓':src==='thunder'?'⚡':src==='123'?'123':src==='xunlei'?'迅':src==='tianyi'?'天':src==='115'?'15':src==='yidong'?'移':'盘'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:.85rem;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${clean}</div>
        <div style="font-size:.72rem;color:${srcColor};margin-top:2px">${srcName}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();copyToClipboard('${(r.url||'').replace(/'/g,"\\'")}')\" style="font-size:.72rem;padding:4px 8px">复制</button>
        <button class="btn btn-ghost btn-sm fav-btn" data-id="${r.id || ''}" onclick="event.stopPropagation();toggleFavorite(this,${r.id || 0})" style="font-size:.72rem;padding:4px 8px">♡</button>
        ${isMagnet ? '' : `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.open('${(r.url||'').replace(/'/g,"\\'")}','_blank')" style="font-size:.72rem;padding:4px 8px">打开</button>`}
      </div>
    `;
    frag.appendChild(card);
  });
  cardContainer.appendChild(frag);
}

// 卡片入场动画：从下方滑入+淡入+分隔线（通用：首次加载/加载更多/在线结果）
function _animateCards(fromIndex) {
  // 直接显示，无动画
}

// 切换每页条数
function changePageSize(val) {
  APP.pageSize = parseInt(val);
  APP.searchPage = 1;
  // 重新搜索当前页
  loadSearchResults(APP.searchQuery, 1, true);
}

// 跳转搜索页
function goSearchPage(page) {
  if (page < 1) return;
  loadSearchResults(APP.searchQuery, page, true);
  document.getElementById('searchResults')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadAnimeCategory(el) {
  // 导航到首页
  navigateTo('home', document.querySelector('[data-page="home"]'));
  document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="home"]')?.classList.add('active');

  // 侧栏分类已移除；兼容旧调用
  const movieSub = document.getElementById('movieSub');
  const tvSub = document.getElementById('tvSub');
  if (movieSub) movieSub.style.display = 'none';
  if (tvSub) tvSub.style.display = 'none';

  const hdhiveSec = document.getElementById('hdhiveSections');
  if (hdhiveSec) hdhiveSec.style.display = 'none';
  // 隐藏section-header和filter-bar
  document.querySelectorAll('.section-header').forEach(h => h.style.display = 'none');
  document.querySelectorAll('.filter-bar').forEach(b => b.style.display = 'none');

  // 分类模式：切到 resourceGrid，隐藏海报墙（v20260807_1937 精简首页）
  const wall = document.getElementById('posterWallGrid');
  if (wall) wall.style.display = 'none';
  const grid = document.getElementById('resourceGrid');
  if (grid) grid.style.display = '';

  // 更新标题
  const sectionTitle = document.querySelector('.section-title');
  if (sectionTitle) sectionTitle.textContent = '动画';

  if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载中…</div>';

  try {
    // TV类型 动画genre=16 热门降序
    const r = await fetch('/api/tmdb/discover?type=tv&genre=16&sort=popularity.desc');
    const d = await r.json();
    const items = (d.items || []).map(it => ({
      title: it.title || '', year: it.year || '', rating: String(it.rating || ''),
      quality: '', type: 'tv', source: 'TMDB', color: '#58a6ff',
      poster: it.poster || '', overview: it.overview || ''
    }));
    renderResourceCards('resourceGrid', items);
  } catch(e) {
    if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载失败</div>';
  }
}

function goToTopRated(mediaType) {
  // 侧栏入口已删除；保留兼容
  const movieSub = document.getElementById('movieSub');
  const tvSub = document.getElementById('tvSub');
  if (movieSub) movieSub.style.display = (mediaType === 'movie') ? 'block' : 'none';
  if (tvSub) tvSub.style.display = (mediaType === 'tv') ? 'block' : 'none';

  const subMenu = document.getElementById(mediaType + 'Sub');
  if (subMenu) {
    subMenu.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const topRatedBtn = subMenu.querySelector('[onclick*="top_rated"]');
    if (topRatedBtn) topRatedBtn.classList.add('active');
  }

  loadSubCategory(mediaType, 'top_rated');
}

function filterCategory(type) {
  // 导航到首页
  navigateTo('home', document.querySelector('[data-page="home"]'));
  document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="home"]')?.classList.add('active');

  const movieSub = document.getElementById('movieSub');
  const tvSub = document.getElementById('tvSub');
  if (movieSub) movieSub.style.display = (type === 'movie') ? 'block' : 'none';
  if (tvSub) tvSub.style.display = (type === 'tv') ? 'block' : 'none';

  const hdhiveSec = document.getElementById('hdhiveSections');
  if (hdhiveSec) hdhiveSec.style.display = 'block';

  // 显示section-header和filter-bar
  document.querySelectorAll('.section-header').forEach(h => h.style.display = '');
  document.querySelectorAll('.filter-bar').forEach(b => b.style.display = '');

  // 分类模式：切到 resourceGrid，隐藏海报墙（v20260807_1937 精简首页）
  const wall = document.getElementById('posterWallGrid');
  if (wall) wall.style.display = 'none';
  const grid = document.getElementById('resourceGrid');
  if (grid) grid.style.display = '';

  // 更新标题
  const titles = { movie: '电影', tv: '剧集', anime: '动画' };
  const sectionTitle = document.querySelector('.section-title');
  if (sectionTitle) sectionTitle.textContent = titles[type] || '最新收录';

  // 默认加载热门
  if (type === 'movie') loadSubCategory('movie', 'popular');
  else if (type === 'tv') loadSubCategory('tv', 'popular');
  else loadCategoryResources(type);
}

async function loadSubCategory(mediaType, subType, el) {
  // 导航到首页（如果不在首页）
  if (APP.currentPage !== 'home') {
    navigateTo('home', document.querySelector('[data-page="home"]'));
  }
  document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.remove('active'));
  document.querySelector('[data-page="home"]')?.classList.add('active');

  // 侧栏子菜单已移除
  const movieSub = document.getElementById('movieSub');
  const tvSub = document.getElementById('tvSub');
  if (movieSub) movieSub.style.display = (mediaType === 'movie') ? 'block' : 'none';
  if (tvSub) tvSub.style.display = (mediaType === 'tv') ? 'block' : 'none';

  // 显示section-header和filter-bar
  document.querySelectorAll('.section-header').forEach(h => h.style.display = '');
  document.querySelectorAll('.filter-bar').forEach(b => b.style.display = '');

  // 分类模式：切到 resourceGrid，隐藏海报墙（v20260807_1937 精简首页）
  const wall = document.getElementById('posterWallGrid');
  if (wall) wall.style.display = 'none';
  const grid = document.getElementById('resourceGrid');
  if (grid) grid.style.display = '';

  // 更新子分类选中状态
  const parent = el ? el.parentElement : document.getElementById(mediaType + 'Sub');
  if (parent) parent.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');

  if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载中…</div>';

  const titles = {
    'popular': '热门', 'now_playing': '正在上映', 'upcoming': '即将上映', 'top_rated': '经典',
    'airing_today': '今日热门', 'on_the_air': '电视播出'
  };
  const sectionTitle = document.querySelector('.section-title');
  const mediaName = mediaType === 'movie' ? '电影' : '节目';
  if (sectionTitle) sectionTitle.textContent = mediaName + ' · ' + (titles[subType] || subType);

  let url;
  if (subType === 'popular') {
    url = '/api/tmdb/trending?type=' + mediaType;
  } else if (subType === 'top_rated') {
    url = '/api/tmdb/discover?type=' + mediaType + '&sort=vote_average.desc&vote=500';
  } else {
    url = '/api/tmdb/discover?type=' + mediaType + '&endpoint=' + subType;
  }

  try {
    const r = await fetch(url);
    const d = await r.json();
    const items = (d.items || []).map(it => ({
      title: it.title || '', year: it.year || '', rating: String(it.rating || ''),
      quality: '', type: mediaType, source: 'TMDB', color: '#58a6ff',
      poster: it.poster || '', overview: it.overview || ''
    }));
    renderResourceCards('resourceGrid', items);
  } catch(e) {
    if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载失败</div>';
  }
}

async function loadCategoryResources(type) {
  const grid = document.getElementById('resourceGrid');
  if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载中…</div>';

  try {
    let items = [];
    const mapItem = it => ({
      title: it.title || '',
      year: it.year || '',
      rating: String(it.rating || ''),
      quality: '',
      type: it.media_type || 'movie',
      source: 'TMDB',
      color: '#58a6ff',
      poster: it.poster || '',
      overview: it.overview || '',
      url: it.url || ''
    });

    if (type === 'movie') {
      const r = await fetch('/api/tmdb/trending?type=movie');
      const d = await r.json();
      items = (d.items || []).map(mapItem);
    } else if (type === 'tv') {
      const r = await fetch('/api/tmdb/trending?type=tv');
      const d = await r.json();
      items = (d.items || []).map(mapItem);
    } else if (type === 'top_movies') {
      const r = await fetch('/api/tmdb/discover?type=movie&sort=vote_average.desc&vote=500');
      const d = await r.json();
      items = (d.items || []).map(mapItem);
    } else if (type === 'top_tv') {
      const r = await fetch('/api/tmdb/discover?type=tv&sort=vote_average.desc&vote=500');
      const d = await r.json();
      items = (d.items || []).map(mapItem);
    } else if (type === 'anime') {
      // v20260807_145052: filter-bar 动画 chip 走这里，调用 loadAnimeCategory 的逻辑
      const r = await fetch('/api/tmdb/discover?type=tv&genre=16&sort=popularity.desc');
      const d = await r.json();
      items = (d.items || []).map(mapItem);
    }

    renderResourceCards('resourceGrid', items);
    if (!items.length) showToast('暂无数据', 'info');
  } catch(e) {
    if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载失败: ' + e.message + '</div>';
  }
}


// ============================================================
// TMDB TRENDING
// ============================================================
async function loadTrending(type) {
  try {
    const r = await fetch('/api/tmdb/trending?type=' + type);
    const d = await r.json();
    const items = (d.items || []).map(it => ({
      title: it.title || '',
      year: it.year || '',
      rating: String(it.rating || ''),
      quality: '',
      type: it.media_type || type,
      source: 'TMDB',
      color: '#58a6ff',
      poster: it.poster ? (it.poster.startsWith('http') ? it.poster : '/api/img_proxy?url=' + encodeURIComponent(it.poster)) : ''
    }));
    renderResourceCards('trendingGrid', items);
  } catch(e) { console.error('loadTrending error:', e); }
}


// ============================================================
// FILTER CHIPS
// ============================================================
function setFilter(el) {
  const bar = el.parentElement;
  bar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');

  // 获取筛选类型
  const text = el.textContent.trim();
  const typeMap = { '全部': 'all', '电影': 'movie', '剧集': 'tv', '动画': 'anime' };
  const type = typeMap[text] || 'all';

  if (type === 'all') {
    // v20260807_1937: 首页精简，全部→海报墙（原 loadLatestResources 已移除）
    const wall = document.getElementById('posterWallGrid');
    if (wall) wall.style.display = '';
    const grid = document.getElementById('resourceGrid');
    if (grid) grid.style.display = 'none';
    loadPosterWall('all');
    const sectionTitle = document.querySelector('.section-title');
    if (sectionTitle) sectionTitle.textContent = '本周热门影视';
  } else {
    filterCategory(type);
  }
}


// ============================================================
// LOGS
// ============================================================


// ============================================================
// MODALS
// ============================================================
function showModal(id) {
  document.getElementById(id)?.classList.add('show');
}

function hideModal(id) {
  document.getElementById(id)?.classList.remove('show');
}


// ============================================================
// TOAST
// ============================================================
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  // v20260807_150308: 去重 — 相同 message + type 已存在则不重复 push
  const existing = container.querySelector(`.toast.${type}[data-msg="${CSS.escape(message)}"]`);
  if (existing) {
    // 已存在：重置它的消失计时器
    if (existing._toastTimer) clearTimeout(existing._toastTimer);
    existing._toastTimer = setTimeout(() => {
      existing.style.opacity = '0';
      existing.style.transform = 'translateX(20px)';
      existing.style.transition = 'all 0.3s ease';
      setTimeout(() => existing.remove(), 300);
    }, duration);
    return existing;
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.dataset.msg = message;
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span> ${message}`;
  container.appendChild(toast);
  toast._toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
  return toast;
}

function copyToClipboard(text) {
  if (!text) { showToast('没有可复制的链接', 'error'); return; }
  navigator.clipboard.writeText(text).then(() => {
    showToast('链接已复制到剪贴板', 'success');
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('链接已复制到剪贴板', 'success');
  });
}


// ============================================================
// LOCAL STORAGE CACHE LAYER
// ============================================================
const Cache = {
  set(key, data, ttlSeconds = 1800) {
    const item = { data, expiry: Date.now() + ttlSeconds * 1000 };
    try {
      localStorage.setItem('vd_' + key, JSON.stringify(item));
    } catch (e) {
      // Storage full — clear old items
      Object.keys(localStorage).filter(k => k.startsWith('vd_')).forEach(k => localStorage.removeItem(k));
    }
  },
  get(key) {
    try {
      const raw = localStorage.getItem('vd_' + key);
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (Date.now() > item.expiry) {
        localStorage.removeItem('vd_' + key);
        return null;
      }
      return item.data;
    } catch { return null; }
  }
};


// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + K → focus contextual search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const page = APP.currentPage || 'home';
    const el = page === 'home'
      ? document.getElementById('homeSearchInput')
      : document.getElementById('globalSearch');
    (el || document.getElementById('globalSearch'))?.focus();
  }
  // Escape → close modals
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
  }
});

// Search on Enter
document.getElementById('globalSearch')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') executeSearch();
});


// ============================================================
// INIT
// ============================================================
(async function init() {
  // 检查登录状态
  try {
    const ur = await fetch('/api/user/me');
    const ud = await ur.json();
    window.VD_LOGGED_IN = !!ud.logged_in;
    window.VD_IN_GROUP = !!ud.in_group;
    const userArea = document.getElementById('userArea');
    if (userArea) {
      if (ud.logged_in) {
        const name = (ud.nickname || ud.username || '用户').replace(/[<>&"']/g, '');
        const roleBadge = ud.is_superadmin ? '👑' : (ud.is_admin ? '🛡️' : '⭐');
        const points = ud.points || 0;
        const homeLink = ud.is_admin
          ? `<a class="btn btn-ghost btn-sm" href="/admin" title="后台管理">管理</a>`
          : ``;
        userArea.innerHTML = `
          <div class="user-chip" style="display:inline-flex;align-items:center;gap:8px;">
            ${homeLink}
            <a href="/profile" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;color:inherit;" title="进入个人中心">
              <span class="badge-role" style="font-size:0.75rem;">${roleBadge}</span>
              <span class="user-name" style="font-weight:600;color:var(--teal);">${name}</span>
              <span style="font-size:0.72rem;background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:999px;color:var(--text-secondary);">${points} 积分</span>
            </a>
            <a class="btn btn-ghost btn-sm btn-switch" href="/logout?next=/login" title="退出并换账号登录">换号</a>
            <a class="btn btn-ghost btn-sm" href="/logout?next=/login">退出</a>
          </div>
        `;
      } else {
        // 未登录：强制渲染可跳转的登录链接（不用 onclick，避免缓存/拦截）
        userArea.innerHTML = `<a class="btn btn-ghost btn-sm" href="/login?next=${encodeURIComponent('/')}" id="headerLoginBtn">登录</a>`;
      }
    }
  } catch(e) {
    window.VD_LOGGED_IN = false;
    const userArea = document.getElementById('userArea');
    if (userArea) {
      userArea.innerHTML = `<a class="btn btn-ghost btn-sm" href="/login" id="headerLoginBtn">登录</a>`;
    }
  }

  // 登录回来：继续未完成的搜索 / 详情
  if (window.VD_LOGGED_IN) {
    try {
      const pendingSearch = sessionStorage.getItem('vd_pending_search');
      const pendingDetail = sessionStorage.getItem('vd_pending_detail');
      if (pendingSearch) {
        sessionStorage.removeItem('vd_pending_search');
        setTimeout(() => searchResource(pendingSearch), 250);
      } else if (pendingDetail) {
        sessionStorage.removeItem('vd_pending_detail');
        setTimeout(() => searchResource(pendingDetail), 250);
      }
    } catch (e) {}
  }

  // 加载统计
  // 累计访问打点（30 分钟内同浏览器只计 1 次）
  try {
    fetch('/api/visit', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  } catch(e) {}

  try {
    const sr = await fetch('/api/stats');
    const sd = await sr.json();
    const total = (sd.total || 0).toLocaleString();
    document.querySelectorAll('.header-stat .count').forEach(e => e.textContent = total);
    const statEl = document.getElementById('statTotal');
    if (statEl) statEl.textContent = total;
  } catch(e) {}

  // 加载公告
  try {
    const ar = await fetch('/api/announcements');
    const ad = await ar.json();
    const banner = document.getElementById('announcementBanner');
    if (banner && (ad.title || ad.content)) {
      const dismissKey = 'vd_ann_dismiss_' + (ad.id || 'x');
      let dismissed = false;
      try { dismissed = !!localStorage.getItem(dismissKey); } catch (e) {}
      if (!dismissed) {
        const typeClass = ad.type === 'alert' ? 'ann-alert' : ad.type === 'info' ? 'ann-info' : 'ann-banner';
        const title = String(ad.title || '').replace(/^[【\[]+|[\】\]]+$/g, '').trim();
        banner.className = `announcement-banner ${typeClass}`;
        banner.innerHTML = `<div class="ann-inner">
          ${title ? `<span class="ann-kicker">${esc(title)}</span>` : ''}
          <p class="ann-copy">${linkifyAnn(ad.content || '')}</p>
          <button type="button" class="ann-close" aria-label="关闭公告">×</button>
        </div>`;
        banner.style.display = 'block';
        banner.querySelector('.ann-close')?.addEventListener('click', () => {
          banner.style.display = 'none';
          try { localStorage.setItem(dismissKey, '1'); } catch (e) {}
        });
      }
    }
  } catch(e) {}

// ==================== HDHIVE STYLE TOP 10 RANKINGS ====================

  // 并行加载热门影视海报墙（v20260807_1937: 精简首页，去掉轮播+最新收录）
  await Promise.all([
    loadPosterWall(POSTER_WALL_TYPE)  // v20260807_154100 海报墙
  ]);

  // 支持 /?q=关键词 直达检索（收藏页「搜索」跳转）
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q && q.trim()) {
      searchResource(q.trim());
      history.replaceState({}, '', '/');
    }
  } catch (e) {}


  console.log('[VaultDrive] Daylight Archive UI — connected to backend');
})();

// 骨架屏加载

// v20260807_160827: NovaMind 粒子动画


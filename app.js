/* Prediction Watch — read-only Kalshi + Polymarket feed.
 *
 * Kalshi comes from data/kalshi.json (refreshed server-side by GitHub Actions,
 * because Kalshi's API only allows CORS from kalshi.com).
 * Polymarket is fetched live in the browser (they allow any origin).
 */

const PM_API = 'https://gamma-api.polymarket.com/events/pagination';
const PM_PAGES = 5;      // 100 events each, ordered by 24h volume
const PM_PAGE_SIZE = 100;
const KALSHI_URL = 'data/kalshi.json';

/* ---------- topic taxonomy ---------- */
/* Word-boundary matched against title + subtitle + tags + source category. */
const TOPICS = [
  { id: 'politics', label: 'Politics',
    cats: ['Politics', 'Elections', 'World', 'Mentions'],
    kw: ['election','elections','president','presidential','senate','congress','congressional',
         'governor','primary','nominee','nomination','impeach','impeachment','cabinet','ballot',
         'approval rating','government shutdown','speaker of the house','parliament','prime minister',
         'referendum','white house','trump','biden','vance','newsom','midterm','electoral','candidate',
         'political party','geopolitic','geopolitical','coup','summit','treaty','nato','united nations'] },

  { id: 'markets', label: 'Financial markets',
    cats: ['Financials', 'Crypto', 'Commodities', 'Companies'],
    kw: ['s&p','s&p 500','nasdaq','dow jones','stock','stocks','share price','shares','equity','equities',
         'bitcoin','btc','ethereum','eth','solana','crypto','cryptocurrency','gold','silver','oil',
         'crude','natural gas','treasury','treasuries','bond yield','yield','ipo','earnings','market cap',
         'all-time high','bear market','bull market','index','vix','etf','valuation','acquisition',
         'merger','buyout','bankruptcy','stock split'] },

  { id: 'economy', label: 'Economy & Fed',
    cats: ['Economics'],
    kw: ['fed','federal reserve','fomc','interest rate','interest rates','rate cut','rate hike',
         'inflation','cpi','pce','core inflation','gdp','recession','unemployment','jobs report',
         'nonfarm','payroll','payrolls','jerome powell','powell','tariff','tariffs','debt ceiling',
         'national debt','deficit','housing starts','mortgage rate','consumer confidence','layoffs',
         'minimum wage','trade deal','stimulus'] },

  { id: 'ai', label: 'AI & tech',
    cats: ['Science and Technology'],
    kw: ['ai','a.i.','artificial intelligence','openai','anthropic','chatgpt','gpt','gpt-5','claude',
         'gemini','llama','deepseek','grok','xai','llm','agi','superintelligence','nvidia','chips',
         'semiconductor','semiconductors','tsmc','data center','robotaxi','waymo','tesla fsd','quantum',
         'quantum computing','apple intelligence','deepmind','copilot','autonomous','self-driving',
         'space x','spacex','starship','satellite','cybersecurity','data breach'] },

  { id: 'media', label: 'Media & streaming',
    cats: [],
    kw: ['netflix','streaming','streamer','subscriber','subscribers','disney+','hulu','hbo max',
         'peacock','paramount+','apple tv','apple tv+','prime video','spotify','youtube','tiktok',
         'podcast','podcasts','substack','twitch','cord cutting','advertising revenue','ad revenue',
         'linear tv','cable news','fox news','cnn','msnbc','new york times','media company'] },

  { id: 'entertainment', label: 'Entertainment industry',
    cats: ['Entertainment'],
    kw: ['oscar','oscars','academy award','academy awards','best picture','emmy','emmys','grammy',
         'grammys','golden globe','golden globes','tony award','box office','opening weekend','film',
         'movie','movies','sequel','franchise','studio','sag-aftra','sag','wga','writers guild',
         'directors guild','iatse','actor','actress','director','screenplay','album','billboard',
         'tour','concert','touring','record label','music label','recording artist','streaming numbers',
         'rotten tomatoes','imdb','disney','warner bros','warner bros. discovery','paramount',
         'universal pictures','sony pictures','a24','lionsgate','mgm','comcast','superbowl halftime',
         'halftime show','celebrity','taylor swift','beyonce','drake','video game','gaming'] },

  { id: 'law', label: 'Law & regulation',
    cats: [],
    kw: ['supreme court','scotus','lawsuit','lawsuits','sued','court','courts','judge','indict','indicted',
         'indictment','convict','convicted','conviction','verdict','acquit','trial','antitrust',
         'monopoly','department of justice','doj','ftc','fcc','securities and exchange commission',
         'regulator','regulators','regulation','regulatory','ruling','appeals court',
         'settlement','sanctions','pardon','executive order','legislation','bill passes',
         'copyright','patent','injunction','subpoena','plea deal','sentenced','prison','impeachment trial'] },
];

/* Topics that make up the default "For You" feed. */
const FOR_YOU = TOPICS.map(t => t.id);

/* Build one boundary-safe regex per topic. */
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const t of TOPICS) {
  const alts = t.kw.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
  t.re = new RegExp(`(?:^|[^a-z0-9])(?:${alts})(?![a-z0-9])`, 'i');
  t.catSet = new Set(t.cats);
}

/* Sports and esports are the loudest thing on both venues and none of it is
 * wanted here. Anything matching this is left untagged, so it stays out of
 * "For you" and every topic — it's still reachable under "All" and search. */
const SPORTS_KW = ['nfl','nba','mlb','nhl','ncaa','ufc','mma','boxing','soccer','football',
  'basketball','baseball','hockey','tennis','golf','pga','masters tournament','wimbledon',
  'us open','premier league','la liga','serie a','bundesliga','champions league','world cup',
  'olympics','olympic','formula 1','f1','nascar','grand prix','super bowl','world series',
  'stanley cup','playoffs','mvp','esports','lol','league of legends','dota','cs2',
  'counter-strike','valorant','overwatch','rocket league','quadra kill','penta kill',
  'moneyline','point spread','parlay','cricket','rugby','marathon','heisman','draft pick'];
const SPORTS_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${SPORTS_KW.slice().sort((a,b)=>b.length-a.length).map(esc).join('|')})(?![a-z0-9])`, 'i');
const SPORTS_TAGS = new Set(['sports','esports','games','nfl','nba','mlb','nhl','soccer','football',
  'tennis','golf','ufc','mma','boxing','cricket','olympics','f1','racing','lol','csgo','dota']);
/* Culture events that live inside a sports broadcast are still entertainment. */
const SPORTS_EXEMPT = /halftime|national anthem|commercial|advertis|super bowl ad/i;

function isSports(card) {
  const tags = (card.tags || []).map(t => String(t).toLowerCase());
  const hay = [card.title, card.subtitle, tags.join(' ')].filter(Boolean).join(' ');
  if (SPORTS_EXEMPT.test(hay)) return false;
  if (tags.some(t => SPORTS_TAGS.has(t))) return true;
  return SPORTS_RE.test(hay);
}

function classify(card) {
  if (isSports(card)) return [];
  const hay = [card.title, card.subtitle, (card.tags || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
  const out = [];
  for (const t of TOPICS) {
    if (t.catSet.has(card.category) || t.re.test(hay)) out.push(t.id);
  }
  return out;
}

/* ---------- state ---------- */
const PAGE = 40;   // cards rendered per chunk

const state = {
  cards: [],
  filter: 'foryou',
  query: '',
  sort: 'vol24',
  shown: PAGE,
  favs: new Set(),
  kalshiAt: null,
  errors: [],
  loading: true,
};

const FAV_KEY = 'pw:favs';
try { state.favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { /* ignore */ }
const saveFavs = () => {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...state.favs])); } catch { /* ignore */ }
};

/* ---------- fetching ---------- */
async function loadKalshi() {
  const r = await fetch(`${KALSHI_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`kalshi snapshot ${r.status}`);
  const d = await r.json();
  state.kalshiAt = d.generatedAt || null;
  return (d.cards || []).map(c => ({ ...c, topics: classify(c) }));
}

const jparse = v => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try { return JSON.parse(v); } catch { return []; }
};

function pmCard(ev) {
  const mkts = (ev.markets || []).filter(m => m.active && !m.closed && !m.archived);
  if (!mkts.length) return null;

  const yesProb = m => {
    const names = jparse(m.outcomes).map(s => String(s).toLowerCase());
    const prices = jparse(m.outcomePrices).map(Number);
    let i = names.indexOf('yes');
    if (i === -1) i = 0;
    const p = prices[i];
    if (Number.isFinite(p) && p > 0 && p < 1) return p;
    const lt = Number(m.lastTradePrice);
    return Number.isFinite(lt) ? lt : null;
  };

  let outcomes, title = ev.title || '';
  if (mkts.length === 1) {
    const p = yesProb(mkts[0]);
    if (p == null) return null;
    outcomes = [{ label: 'Yes', prob: p }];
    title = mkts[0].question || title;
  } else {
    outcomes = mkts
      .map(m => ({ label: m.groupItemTitle || m.question || '?', prob: yesProb(m) }))
      .filter(o => o.prob != null)
      .sort((a, b) => b.prob - a.prob);
    if (!outcomes.length) return null;
  }

  const tags = (ev.tags || []).map(t => t.label).filter(Boolean);
  const card = {
    id: 'p:' + ev.id,
    source: 'polymarket',
    title: title.trim(),
    subtitle: '',
    category: tags[0] || 'Other',
    tags,
    outcomes: outcomes.slice(0, 5),
    outcomeCount: outcomes.length,
    volume: Math.round(Number(ev.volume) || 0),
    volume24h: Math.round(Number(ev.volume24hr) || 0),
    close: ev.endDate || null,
    url: ev.slug ? `https://polymarket.com/event/${ev.slug}` : 'https://polymarket.com',
  };
  card.topics = classify(card);
  return card;
}

async function loadPolymarket() {
  const reqs = Array.from({ length: PM_PAGES }, (_, i) => {
    const u = `${PM_API}?closed=false&active=true&archived=false&limit=${PM_PAGE_SIZE}` +
              `&offset=${i * PM_PAGE_SIZE}&order=volume24hr&ascending=false`;
    return fetch(u).then(r => {
      if (!r.ok) throw new Error(`polymarket ${r.status}`);
      return r.json();
    });
  });
  const pages = await Promise.all(reqs);
  const seen = new Set();
  const out = [];
  for (const pg of pages) {
    for (const ev of (pg.data || [])) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const c = pmCard(ev);
      if (c) out.push(c);
    }
  }
  return out;
}

async function loadAll() {
  state.loading = true;
  state.errors = [];
  render();

  const [k, p] = await Promise.allSettled([loadKalshi(), loadPolymarket()]);
  const cards = [];

  if (k.status === 'fulfilled') cards.push(...k.value);
  else state.errors.push(`Kalshi snapshot unavailable (${k.reason.message}).`);

  if (p.status === 'fulfilled') cards.push(...p.value);
  else state.errors.push(`Polymarket live feed unavailable (${p.reason.message}).`);

  state.cards = cards;
  state.loading = false;
  render();
}

/* ---------- formatting ---------- */
const fmtVol = n => {
  if (!n) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + n;
};

function fmtClose(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.round((t - Date.now()) / 86400000);
  // Polymarket leaves a stale endDate on plenty of still-trading markets,
  // so a past date is not trustworthy enough to label "closed".
  if (days < 0) return null;
  if (days === 0) return 'closes today';
  if (days === 1) return 'closes tomorrow';
  if (days < 30) return `closes in ${days}d`;
  if (days < 365) return `closes in ${Math.round(days / 30)}mo`;
  return `closes ${new Date(t).getFullYear()}`;
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const escHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- filtering + sorting ---------- */
function visible() {
  let out = state.cards;

  if (state.filter === 'saved') {
    out = out.filter(c => state.favs.has(c.id));
  } else if (state.filter === 'foryou') {
    out = out.filter(c => c.topics.some(t => FOR_YOU.includes(t)));
  } else if (state.filter !== 'all') {
    out = out.filter(c => c.topics.includes(state.filter));
  }

  const q = state.query.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    out = out.filter(c => {
      const hay = (c.title + ' ' + c.subtitle + ' ' + c.tags.join(' ') + ' ' +
                   c.outcomes.map(o => o.label).join(' ')).toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }

  const top = c => (c.outcomes[0] ? c.outcomes[0].prob : 0);
  const sorts = {
    vol24: (a, b) => b.volume24h - a.volume24h || b.volume - a.volume,
    vol:   (a, b) => b.volume - a.volume,
    soon:  (a, b) => (Date.parse(a.close) || 8e15) - (Date.parse(b.close) || 8e15),
    moved: (a, b) => top(b) - top(a),
  };
  return out.slice().sort(sorts[state.sort] || sorts.vol24);
}

/* ---------- render ---------- */
const $ = s => document.querySelector(s);
const feed = $('#feed');

function chipDefs() {
  return [
    { id: 'foryou', label: 'For you' },
    { id: 'saved', label: `★ Saved${state.favs.size ? ' ' + state.favs.size : ''}`, cls: 'star' },
    { id: 'all', label: 'All' },
    ...TOPICS.map(t => ({ id: t.id, label: t.label })),
  ];
}

function renderChips() {
  $('#chips').innerHTML = chipDefs().map(c =>
    `<button class="chip ${c.cls || ''}" data-f="${c.id}" aria-pressed="${state.filter === c.id}">${escHtml(c.label)}</button>`
  ).join('');
}

function cardHtml(c) {
  const fav = state.favs.has(c.id);
  const srcCls = c.source === 'kalshi' ? 'kalshi' : 'poly';
  const srcLbl = c.source === 'kalshi' ? 'Kalshi' : 'Polymarket';
  const binary = c.outcomes.length === 1 && c.outcomes[0].label === 'Yes';

  const rows = c.outcomes.map(o => {
    const pct = Math.round(o.prob * 100);
    const cls = pct >= 65 ? 'hi' : pct <= 35 ? 'lo' : '';
    return `<div class="out">
        <span class="out-label">${escHtml(binary ? 'Yes' : o.label)}</span>
        <span class="out-pct">${pct}%</span>
        <div class="track"><div class="fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  const hidden = c.outcomeCount - c.outcomes.length;
  const close = fmtClose(c.close);

  return `<article class="card">
    <div class="card-head">
      <span class="src ${srcCls}">${srcLbl}</span>
      <h2 class="card-title"><a href="${escHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escHtml(c.title)}</a></h2>
      <button class="fav" data-id="${escHtml(c.id)}" aria-pressed="${fav}" aria-label="${fav ? 'Remove from saved' : 'Save'}">
        <svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>
      </button>
    </div>
    ${c.subtitle ? `<p class="sub">${escHtml(c.subtitle)}</p>` : ''}
    <div class="outcomes">${rows}</div>
    ${hidden > 0 ? `<p class="more">+${hidden} more outcome${hidden > 1 ? 's' : ''}</p>` : ''}
    <div class="meta">
      <span>Vol <b>${fmtVol(c.volume)}</b></span>
      <span>24h <b>${fmtVol(c.volume24h)}</b></span>
      ${close ? `<span>${escHtml(close)}</span>` : ''}
      <a class="go" href="${escHtml(c.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
    </div>
  </article>`;
}

function render() {
  renderChips();

  const errHtml = state.errors.length
    ? `<div class="err"><b>Some data didn't load</b>${state.errors.map(escHtml).join('<br>')}</div>`
    : '';

  if (state.loading && !state.cards.length) {
    feed.innerHTML = errHtml + `<p class="empty">Loading markets…</p>`;
    $('#status').textContent = 'Loading…';
    return;
  }

  const list = visible();
  $('#status').textContent = `${list.length} market${list.length === 1 ? '' : 's'}`;

  // Render in chunks — a phone stalls badly if we drop 1,600 cards in at once.
  const shown = Math.min(state.shown, list.length);
  let body;
  if (!list.length) {
    body = `<p class="empty">${state.filter === 'saved'
      ? 'No saved markets yet. Tap ☆ on any card to save it.'
      : 'Nothing matches that filter.'}</p>`;
  } else {
    body = list.slice(0, shown).map(cardHtml).join('');
    if (shown < list.length) {
      body += `<button id="more" class="more-btn">Show more · ${list.length - shown} left</button>`;
    }
  }
  feed.innerHTML = errHtml + body;

  const bits = [];
  if (state.kalshiAt) bits.push(`Kalshi updated ${ago(state.kalshiAt)}`);
  bits.push('Polymarket live');
  $('#freshness').textContent = bits.join(' · ');
}

/* Grow the rendered slice. Driven by a scroll listener (works everywhere) with
 * an always-present button as the guaranteed fallback. */
function showMore() {
  if (state.shown >= visible().length) return;
  state.shown += PAGE;
  render();
}

let lastScrollCheck = 0;
window.addEventListener('scroll', () => {
  const now = Date.now();
  if (now - lastScrollCheck < 120) return;
  lastScrollCheck = now;
  const left = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  if (left < 700) showMore();
}, { passive: true });

/* Any change to what's listed restarts the slice at the top. */
function reset() {
  state.shown = PAGE;
  render();
}

/* ---------- events ---------- */
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.filter = b.dataset.f;
  reset();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

feed.addEventListener('click', e => {
  if (e.target.closest('#more')) { showMore(); return; }
  const b = e.target.closest('.fav');
  if (!b) return;
  const id = b.dataset.id;
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  saveFavs();
  render();
});

let qt;
$('#search').addEventListener('input', e => {
  clearTimeout(qt);
  const v = e.target.value;
  qt = setTimeout(() => { state.query = v; reset(); }, 140);
});

$('#sort').addEventListener('change', e => { state.sort = e.target.value; reset(); });

$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh');
  b.classList.add('spin');
  try { await loadAll(); } finally { b.classList.remove('spin'); }
});

loadAll();

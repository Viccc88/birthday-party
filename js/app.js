'use strict';

// ===================== Утилиты =====================

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

(function readApiParam() {
  const p = new URLSearchParams(location.search).get('api');
  if (p) { store.set('api', p); history.replaceState(null, '', location.pathname); }
})();

// Локально (node dev/server.js) — всегда тестовый сервер, чтобы не трогать настоящую таблицу.
const API = store.get('api', '') ||
  (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '/api' : window.CONFIG.API_URL);
const POLL_MS = window.CONFIG.POLL_MS || 1500;

const SCREEN_TITLES = {
  plan: 'План / ожидание',
  facts: 'Угадай, чей факт',
  iq: 'IQ-тест',
  challenge: 'Испытание',
  results: 'Результаты',
  sigame: 'Своя игра',
  scores: 'Таблица баллов',
  splash: 'Заставка',
};
const GAME_TITLES = { iq: 'IQ-тест' };

const app = {
  role: store.get('role', null), // {type:'team', team} | {type:'screen'} | {type:'admin', pin}
  state: null,
  data: null,
  dataRaw: '',
  dataAt: 0,
  admin: null,
  adminRaw: '',
  adminAt: 0,
  online: true,
  started: false,
  tab: 'now',
  adminTab: store.get('adminTab', 'control'),
  viewKey: '',
  busy: {},
  offset: 0, // серверное время минус локальное
  bestRtt: Infinity,
};
let drafts = {};

async function apiGet(params) {
  const qs = new URLSearchParams(Object.assign({}, params, { _: Date.now() }));
  const r = await fetch(API + '?' + qs);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Ошибка');
  return j;
}

async function apiPost(body) {
  const r = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Ошибка');
  return j;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3200);
}

function deviceName() {
  if (!app.role) return '';
  if (app.role.type === 'team') return app.role.team;
  if (app.role.type === 'admin') return 'Пульт';
  return 'Экран';
}

function isAdmin() { return app.role && app.role.type === 'admin'; }
function myTeam() { return app.role && app.role.type === 'team' ? app.role.team : null; }

// ===================== Звук, будильник экрана =====================

const sound = {
  ctx: null,
  siren: null,
  unlock() {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume();
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) {}
  },
  startSiren() {
    if (this.siren || !this.ctx) return;
    const c = this.ctx;
    const out = c.createGain();
    out.gain.value = 0.5;
    out.connect(c.destination);
    const lfo = c.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 1.2;
    const depth = c.createGain();
    depth.gain.value = 380;
    lfo.connect(depth);
    const oscs = [['sawtooth', 880], ['square', 885]].map(([type, f]) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      depth.connect(o.frequency);
      const g = c.createGain();
      g.gain.value = type === 'square' ? 0.25 : 0.5;
      o.connect(g); g.connect(out); o.start();
      return o;
    });
    lfo.start();
    this.siren = { out, lfo, oscs, timer: setTimeout(() => this.stopSiren(), 60000) };
  },
  stopSiren() {
    if (!this.siren) return;
    clearTimeout(this.siren.timer);
    try { this.siren.oscs.forEach(o => o.stop()); this.siren.lfo.stop(); this.siren.out.disconnect(); } catch (e) {}
    this.siren = null;
  },
  fanfare() {
    if (!this.ctx) return;
    const c = this.ctx;
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = c.currentTime + i * 0.13;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i === 5 ? 0.9 : 0.25));
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + 1);
    });
  },
  chime() {
    if (!this.ctx) return;
    const c = this.ctx;
    [660, 880, 1320].forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = c.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + 0.55);
    });
  },
};

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (app.started) keepAwake(); });

// ===================== Синхронизация =====================

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const t0 = Date.now();
    const j = await apiGet({ a: 'state', d: deviceName(), dk: app.data ? app.data.key || '' : '' });
    syncClock(j.now, t0, Date.now());
    setOnline(true);
    if (j.data) setData(j.data);
    onState(j.state);
  } catch (e) {
    setOnline(false);
  } finally {
    pollTimer = setTimeout(poll, document.hidden ? 6000 : POLL_MS);
  }
}

// Оценка разницы часов с сервером по самому быстрому из недавних запросов.
function syncClock(now, t0, t1) {
  if (!now) return;
  app.bestRtt *= 1.05;
  if (t1 - t0 <= app.bestRtt) { app.bestRtt = t1 - t0; app.offset = now - (t0 + t1) / 2; }
}
function serverNow() { return Date.now() + app.offset; }

function setOnline(v) {
  if (app.online === v) return;
  app.online = v;
  const el = $('#net');
  if (el) { el.className = 'net ' + (v ? 'on' : 'off'); el.textContent = v ? '' : 'нет связи'; }
}

function onState(st) {
  if (!st) return;
  // Чуть более старая версия — запоздавший ответ, пропускаем. Резкий откат — состояние на сервере сбросили, принимаем.
  if (app.state && st.v < app.state.v && app.state.v - st.v < 50) return;
  const prev = app.state;
  app.state = st;
  // Обычно данные уже пришли вместе с опросом; отдельный запрос — после своих действий и раз в 30 с.
  if (!app.data || app.data.key !== dataKey(st) || Date.now() - app.dataAt > 30000) loadData();
  if (isAdmin() && (!prev || prev.dataV !== st.dataV || Date.now() - app.adminAt > 10000)) loadAdmin();
  if (prev && prev.screen !== st.screen && !isAdmin()) { sound.chime(); app.tab = 'now'; }
  else if (prev && !isAdmin() && st.screen === 'challenge' &&
    (prev.challenge.phase !== st.challenge.phase || prev.challenge.presenter !== st.challenge.presenter)) sound.chime();
  renderBuzzer();
  renderView();
}

function dataKey(st) { return st.dataV + (st.screen === 'results' ? '_r' : ''); }

function setData(data) {
  app.dataAt = Date.now();
  const raw = JSON.stringify(data);
  if (raw !== app.dataRaw) { app.dataRaw = raw; app.data = data; renderView(); }
}

let dataLoading = false;
async function loadData() {
  if (dataLoading) return;
  dataLoading = true;
  try {
    const j = await apiGet({ a: 'data' });
    setData(j.data);
  } catch (e) {} finally { dataLoading = false; }
}

let adminLoading = false;
async function loadAdmin() {
  if (adminLoading) return;
  adminLoading = true;
  try {
    const j = await apiGet({ a: 'admin', pin: app.role.pin });
    app.adminAt = Date.now();
    const raw = JSON.stringify(j.data);
    if (raw !== app.adminRaw) { app.adminRaw = raw; app.admin = j.data; renderView(); }
  } catch (e) {
    if (/PIN/.test(e.message)) { toast('PIN не подходит, войдите заново', 'err'); logout(); }
  } finally { adminLoading = false; }
}

// Действие пульта: отправить, применить новое состояние, обновить данные.
async function act(a, extra = {}) {
  try {
    const j = await apiPost(Object.assign({ a, pin: app.role && app.role.pin }, extra));
    if (j.state) onState(j.state);
    if (isAdmin()) loadAdmin();
    return j;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
}

// ===================== Рендер: каркас =====================

function render() {
  const root = $('#app');
  // Каркас рисуется заново — экран внутри тоже нужно нарисовать заново.
  app.viewKey = '';
  app.lastHtml = '';
  app.scene = '';
  if (!API) { root.innerHTML = viewNoApi(); return; }
  if (!app.role) { root.innerHTML = viewLogin(); if (!app.data) loadData(); return; }
  if (!app.started) { root.innerHTML = viewStart(); if (!app.data) loadData(); return; }
  root.innerHTML = isAdmin() ? shellAdmin() : shellGuest();
  renderView(true);
  renderBuzzer();
}

function renderView(force) {
  if (!app.started || !app.role || !$('#main')) {
    if (!app.role && app.data && $('#login-teams')) $('#app').innerHTML = viewLogin();
    const names = $('.splash-names');
    if (names && !names.textContent) names.textContent = birthdayNames();
    return;
  }
  const st = app.state ? Object.assign({}, app.state, { v: 0 }) : null;
  const key = JSON.stringify([app.tab, app.adminTab, st, app.dataRaw, isAdmin() ? app.adminRaw : '', iqLocal()]);
  if (!force && key === app.viewKey) return;
  app.viewKey = key;
  let html;
  try {
    html = isAdmin() ? viewAdmin() : viewGuest();
  } catch (e) {
    console.error(e);
    html = `<section class="card narrow center"><div class="big-emoji">⚠️</div><h2>Не удалось показать этот экран</h2>
      <p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Обновить страницу</button></section>`;
  }
  const main = $('#main');
  const scene = sceneKey();
  const entering = scene !== app.scene;
  app.scene = scene;
  if (entering) app.sceneSeq = (app.sceneSeq || 0) + 1;
  // Разметка не изменилась — не трогаем экран, иначе анимации начнутся заново.
  const same = !entering && html === app.lastHtml;
  app.lastHtml = html;
  if (!same) {
    paint(main, html);
    if (main) {
      main.classList.remove('enter');
      if (entering) { void main.offsetWidth; main.classList.add('enter'); }
    }
  }
  const hdr = $('#hdr-now');
  if (hdr) hdr.innerHTML = headerNow();
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === app.tab));
  document.querySelectorAll('[data-atab]').forEach(b => b.classList.toggle('on', b.dataset.atab === app.adminTab));
  if (!same) afterPaint();
}

// Перерисовка без потери набранного текста и фокуса.
function paint(main, html) {
  if (!main) return;
  const act = document.activeElement;
  const focusId = act && act.id && main.contains(act) ? act.id : null;
  let sel = null;
  try { if (focusId && act.selectionStart != null) sel = [act.selectionStart, act.selectionEnd]; } catch (e) {}
  const y = window.scrollY;
  main.innerHTML = html;
  Object.keys(drafts).forEach(id => {
    const el = document.getElementById(id);
    if (el && 'value' in el) el.value = drafts[id];
  });
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
  }
  window.scrollTo(0, y);
}

// Что сейчас на экране: при смене — проигрываем анимацию появления.
function sceneKey() {
  const st = app.state || {};
  const ch = st.challenge || {};
  return [isAdmin() ? app.adminTab : app.tab, st.screen, ch.id, ch.phase, st.facts && st.facts.current, !!app.data, !!app.admin,
    st.screen === 'splash' && !isAdmin() ? JSON.stringify(st.splash) : ''].join('|');
}

function reducedMotion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

// Салют (canvas-confetti). Каждое событие празднуется один раз.
const celebrated = new Set();
function celebrate(kind, onceKey) {
  if (onceKey) { if (celebrated.has(onceKey)) return; celebrated.add(onceKey); }
  if (!window.confetti || reducedMotion()) return;
  const colors = ['#ffcc33', '#ff4d8d', '#7b5cff', '#36d67f', '#5aa9ff', '#ffffff'];
  if (kind === 'big') {
    confetti({ particleCount: 140, spread: 100, origin: { y: 0.6 }, colors });
    setTimeout(() => {
      confetti({ particleCount: 70, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors });
      confetti({ particleCount: 70, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors });
    }, 250);
  } else {
    confetti({ particleCount: 60, spread: 70, startVelocity: 35, origin: { y: 0.7 }, colors });
  }
}

// Плавный счёт чисел (баллы) при появлении экрана.
function countUp() {
  if (reducedMotion()) return;
  document.querySelectorAll('.enter [data-count]').forEach(el => {
    const target = Number(el.dataset.count) || 0;
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 900);
      el.textContent = fmtPts(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// Поводы для салюта на планшетах.
function celebrateMoments() {
  if (!app.data || !app.state || isAdmin()) return;
  const team = myTeam();
  const st = app.state;
  const ch = app.data.challenge;
  if (st.screen === 'challenge' && ch && ch.phase === 'reveal' && ch.results) {
    const mine = ch.results.find(r => r.team === team);
    if (mine && mine.pts > 0) celebrate('big', 'ch:' + ch.id + ':' + ch.startedAt);
    else if (!team) celebrate('small', 'ch:' + ch.id + ':' + ch.startedAt);
  }
  const f = st.facts;
  if (st.screen === 'facts' && f && f.current && f.reveal && f.opened[f.current] && f.opened[f.current].ok === true) {
    celebrate('big', 'fact:' + f.current);
  }
  const done = team && (app.data.iqDone || {})[team];
  if (st.screen === 'iq' && done) celebrate('big', 'iq:' + team + ':' + done.score);
  if (st.screen === 'scores' || app.tab === 'scores') celebrate('small', 'scores:' + app.sceneSeq);
}

function afterPaint() {
  countUp();
  celebrateMoments();
  const qr = $('#qr');
  if (qr && window.QRCode && qr.dataset.url) {
    qr.innerHTML = '';
    new QRCode(qr, { text: qr.dataset.url, width: 220, height: 220, colorDark: '#140b24', colorLight: '#ffffff' });
  }
  iqTick();
  chTick();
}

function viewNoApi() {
  return `<div class="center-page"><div class="card narrow">
    <div class="big-emoji">🔌</div>
    <h1>Сайт ещё не подключён к таблице</h1>
    <p class="muted">Вставьте URL веб-приложения Apps Script в <code>js/config.js</code> или откройте сайт с параметром <code>?api=URL</code>.</p>
  </div></div>`;
}

function viewLogin() {
  const teams = app.data ? app.data.teams.filter(t => !t.birthday) : null;
  return `<div class="center-page"><div class="card narrow login">
    <div class="big-emoji">🎂</div>
    <h1>Кто за этим устройством?</h1>
    <div id="login-teams" class="login-teams">
      ${teams ? teams.map(t => `<button class="btn team-btn" data-act="pickTeam" data-team="${esc(t.name)}">
          <b>${esc(t.name)}</b><span>${esc(t.members.map(m => m.name).join(', '))}</span></button>`).join('')
        : '<div class="muted">Загружаем команды из таблицы…</div>'}
    </div>
    <button class="btn ghost" data-act="pickScreen">📺 Экран — только смотреть</button>
    <details class="admin-login">
      <summary>🎂 Пульт именинников</summary>
      <div class="row"><input id="pin" type="password" inputmode="numeric" placeholder="PIN" autocomplete="off">
      <button class="btn" data-act="adminLogin">Войти</button></div>
    </details>
  </div></div>`;
}

const FLOATERS = ['🎈', '🎉', '✨', '🎁', '🥳', '🎊', '🎂', '⭐'];

function birthdayNames() {
  const t = app.data && app.data.teams.find(x => x.birthday);
  return t ? t.members.map(m => m.name).join(' & ') : '';
}

// Буквы заголовка падают по очереди (--i задаёт задержку).
function splitLetters(text) {
  let i = 0;
  return text.split(' ').map(word => `<span class="word">${[...word].map(ch => `<span class="ltr" style="--i:${i++}">${esc(ch)}</span>`).join('')}</span>`).join(' ');
}

function splashBackdrop() {
  const floaters = Array.from({ length: 18 }, (_, i) =>
    `<span style="--x:${(i * 53) % 100}%;--d:${7 + (i * 7) % 6}s;--delay:-${(i * 1.3) % 8}s;--s:${0.8 + (i % 4) * 0.25}">${FLOATERS[i % FLOATERS.length]}</span>`).join('');
  return `<div class="splash-floaters" aria-hidden="true">${floaters}</div><div class="splash-ring" aria-hidden="true"></div>`;
}

// Заставка, которую именинники запускают на планшетах (текст — с пульта).
function viewSplash() {
  const sp = app.state.splash || {};
  const sub = sp.sub || birthdayNames();
  return `<div class="splash splash-show">
    ${splashBackdrop()}
    ${sp.emoji ? `<div class="splash-cake">${esc(sp.emoji)}</div>` : ''}
    <h1 class="splash-title">${splitLetters(sp.title || 'С днём рождения!')}</h1>
    ${sub ? `<div class="splash-names">${esc(sub)}</div>` : ''}
  </div>`;
}

function viewStart() {
  const who = isAdmin() ? 'Пульт именинников' : app.role.type === 'team' ? app.role.team : 'Экран';
  return `<div class="splash" data-act="start">
    ${splashBackdrop()}
    <div class="splash-cake">🎂</div>
    <h1 class="splash-title">${splitLetters('С днём рождения!')}</h1>
    <div class="splash-names">${esc(birthdayNames())}</div>
    <div class="splash-who">${esc(who)}</div>
    <div class="splash-tap">Нажмите, чтобы начать</div>
    <p class="muted small splash-note">Включит звук тревоги и не даст экрану погаснуть</p>
  </div>`;
}

function shellGuest() {
  return `<header class="top">
      <div class="brand">🎂 <b>${esc(app.role.type === 'team' ? app.role.team : 'Экран')}</b></div>
      <div id="hdr-now" class="hdr-now"></div>
      <nav class="tabs"><button data-tab="now">Сейчас</button><button data-tab="plan">План</button><button data-tab="scores">Баллы</button></nav>
      <span id="net" class="net on"></span>
      <button class="icon-btn" data-act="logout" title="Сменить устройство">⚙</button>
    </header>
    <main id="main" class="main"></main>`;
}

function headerNow() {
  const p = app.data && app.state && app.data.plan[app.state.planCurrent];
  return p ? `<span class="muted">Сейчас:</span> ${esc(p.event)}` : '';
}

// ===================== Гостевые экраны =====================

function viewGuest() {
  if (!app.state || !app.data) return `<div class="loading">Загрузка…</div>`;
  if (app.tab === 'plan') return viewPlan();
  if (app.tab === 'scores') return viewScores(app.data.scores);
  switch (app.state.screen) {
    case 'facts': return viewFacts(false);
    case 'iq': return viewIq();
    case 'challenge': return viewChallenge();
    case 'results': return viewResults();
    case 'sigame': return viewSigame();
    case 'scores': return viewScores(app.data.scores);
    case 'splash': return viewSplash();
    default: return viewWelcome();
  }
}

function viewWelcome() {
  const plan = app.data.plan;
  const i = app.state.planCurrent;
  const cur = plan[i];
  const next = plan[i + 1];
  return `<section class="hero">
      <div class="hero-kicker">${cur ? 'Сейчас' : 'Добро пожаловать!'}</div>
      <h1 class="hero-title">${esc(cur ? cur.event : 'С днём рождения! 🎉')}</h1>
      ${cur ? `<div class="hero-time">${esc(cur.time)}</div>` : ''}
      ${next ? `<div class="hero-next">Дальше: <b>${esc(next.event)}</b> <span class="muted">${esc(next.time)}</span></div>` : ''}
    </section>
    ${viewPlan()}`;
}

function viewPlan() {
  const cur = app.state.planCurrent;
  return `<section class="card plan">
    <h2>План дня <span class="muted small">возможны изменения</span></h2>
    <ol class="plan-list">
      ${app.data.plan.map((p, i) => `<li class="${i === cur ? 'cur' : i < cur ? 'done' : ''}">
        <span class="plan-time">${esc(p.time)}</span><span class="plan-event">${esc(p.event)}</span>
        ${i === cur ? '<span class="pill">сейчас</span>' : ''}</li>`).join('')}
    </ol>
  </section>`;
}

// ----- Факты -----

function factCells() {
  const ids = app.data.facts.map(f => f.id);
  const order = (app.state.facts.order || []).filter(id => ids.includes(id));
  ids.forEach(id => { if (!order.includes(id)) order.push(id); });
  return order.map((id, i) => ({ id, n: i + 1, fact: app.data.facts.find(f => f.id === id), open: app.state.facts.opened[id] }));
}

function viewFacts(adminMode) {
  const f = app.state.facts;
  const cells = factCells();
  const canOpen = f.turn && !f.current && !app.busy.fact;
  const cur = f.current && app.data.facts.find(x => x.id === f.current);
  const curCell = cells.find(c => c.id === f.current);
  const opened = f.current && f.opened[f.current];
  if (!cells.length) return `<section class="card center"><h2>Факты ещё не добавлены</h2></section>`;
  return `<section class="facts">
    ${adminMode ? '' : `<div class="facts-head">${f.turn
      ? `<div class="turn">Открывает: <b>${esc(f.turn)}</b></div>${f.current ? '' : '<div class="muted">Нажми на любую закрытую ячейку</div>'}`
      : '<div class="turn muted">Ждём, кто откроет следующую ячейку…</div>'}</div>`}
    <div class="fact-grid">
      ${cells.map(c => `<button class="cell ${c.open ? 'opened' : ''} ${c.id === f.current ? 'current' : ''} c${c.n % 6}"
          ${!c.open && canOpen ? `data-act="openFact" data-id="${c.id}"` : 'disabled'}>
          <span class="cell-n">${c.n}</span>
          ${c.open ? `<span class="cell-by">${esc(c.open.who || c.open.by)}${c.open.ok === true ? ' ✓' : c.open.ok === false ? ' ✗' : ''}</span>` : ''}
        </button>`).join('')}
    </div>
    ${cur && !adminMode ? `<div class="fact-modal"><div class="fact-card">
        <div class="fact-kicker">Факт №${curCell ? curCell.n : ''} · открыл(а) ${esc(opened && opened.by)}</div>
        <div class="fact-text">${esc(cur.text)}</div>
        ${f.reveal
          ? `<div class="fact-answer">Это про: <b>${esc(f.answer)}</b>${opened && opened.ok === true ? '<div class="ok">Угадано! 🎉</div>' : opened && opened.ok === false ? '<div class="bad">Не угадано</div>' : ''}</div>`
          : '<div class="fact-q">Кто это? 🤔</div>'}
      </div></div>` : ''}
  </section>`;
}

// ----- IQ -----

function iqKey() { return 'iq_' + (myTeam() || ''); }
function iqLocal() { return myTeam() ? store.get(iqKey(), null) : null; }
function iqSave(v) { store.set(iqKey(), v); renderView(true); }

// Тест проходит вся группа вместе на своём планшете: одна попытка на группу.
function viewIq() {
  const team = myTeam();
  const iq = app.data.iq;
  if (!team) return `<section class="hero"><div class="hero-kicker">Идёт</div><h1 class="hero-title">IQ-тест 🧠</h1><p class="muted">Группы проходят тест на своих планшетах</p></section>`;
  let done = (app.data.iqDone || {})[team];
  let loc = iqLocal();
  // Пульт сбросил попытку группы — начинаем с чистого листа.
  if (loc && loc.phase === 'done' && !done && app.data.dataV >= (loc.dataV || 0)) { store.del(iqKey()); loc = null; }
  if (loc && loc.phase === 'done' && !done) done = { score: loc.score, max: loc.max };
  if (done && (!loc || loc.phase !== 'test')) {
    return `<section class="card narrow center">
      <div class="big-emoji">🧠</div>
      <div class="muted">${esc(team)} прошла тест</div>
      <div class="score-big"><span class="n" data-count="${done.score}">${done.score}</span> <span>из ${done.max}</span></div>
      <div class="iq-num">IQ группы ≈ ${iqNumber(done.score, done.max)}</div>
      <p class="muted small">Рейтинг групп покажут именинники</p>
    </section>`;
  }
  if (!loc || loc.phase === 'pick') {
    if (!app.state.iq.open) return `<section class="hero"><h1 class="hero-title">IQ-тест скоро начнётся</h1><p class="muted">Ждём команду от именинников</p></section>`;
    return `<section class="card narrow center">
      <div class="big-emoji">🧠</div>
      <h1>IQ-тест</h1>
      <p>${iq.questions.length} вопросов${iq.minutes ? `, ${iq.minutes} мин` : ''}.</p>
      <p class="muted">Решайте всей группой вместе — у группы одна попытка. Соберитесь у планшета и нажмите «Начать».</p>
      <button class="btn big" data-act="iqStart">Начать тест</button>
    </section>`;
  }
  if (loc.phase === 'test') {
    const q = iq.questions[loc.idx];
    const n = iq.questions.length;
    if (!q) return '';
    const answered = Object.keys(loc.answers).length;
    return `<section class="card narrow iq">
      <div class="iq-top"><span>Вопрос ${loc.idx + 1} из ${n}</span><span id="iq-timer" class="iq-timer"></span></div>
      <div class="progress"><i style="width:${(answered / n) * 100}%"></i></div>
      <h2 class="iq-q">${esc(q.q)}</h2>
      <div class="iq-opts">${q.opts.map(([L, t]) => `<button class="opt ${loc.answers[q.id] === L ? 'on' : ''}" data-act="iqAnswer" data-l="${L}"><b>${L}</b>${esc(t)}</button>`).join('')}</div>
      <div class="row between">
        <button class="btn ghost" data-act="iqNav" data-d="-1" ${loc.idx ? '' : 'disabled'}>← Назад</button>
        ${loc.idx < n - 1
          ? `<button class="btn" data-act="iqNav" data-d="1">Далее →</button>`
          : `<button class="btn green" data-act="iqFinish">Завершить ✓</button>`}
      </div>
      <div class="dots">${iq.questions.map((qq, i) => `<button class="dot ${loc.answers[qq.id] ? 'done' : ''} ${i === loc.idx ? 'cur' : ''}" data-act="iqGo" data-i="${i}">${i + 1}</button>`).join('')}</div>
    </section>`;
  }
  if (loc.phase === 'sending') return `<section class="card narrow center"><h2>Отправляем ответы…</h2>
    ${loc.error ? `<p class="bad">${esc(loc.error)}</p><button class="btn" data-act="iqFinish" data-force="1">Повторить</button>` : ''}</section>`;
  return `<div class="loading">Сохраняем результат…</div>`;
}

function iqNumber(score, max) { return max ? Math.round(80 + 70 * score / max) : 0; }

let iqInterval = null;
function iqTick() {
  clearInterval(iqInterval);
  const loc = iqLocal();
  const min = app.data && app.data.iq.minutes;
  if (!loc || loc.phase !== 'test' || !min) return;
  const upd = () => {
    const left = Math.max(0, Math.round(min * 60 - (Date.now() - loc.startedAt) / 1000));
    const el = $('#iq-timer');
    if (el) { el.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; el.classList.toggle('low', left < 60); }
    if (left <= 0) { clearInterval(iqInterval); iqSubmit(); }
  };
  upd();
  iqInterval = setInterval(upd, 1000);
}

async function iqSubmit() {
  const loc = iqLocal();
  if (!loc || (loc.phase !== 'test' && loc.phase !== 'sending')) return;
  loc.phase = 'sending';
  loc.error = '';
  iqSave(loc);
  try {
    const j = await apiPost({ a: 'iqSubmit', team: myTeam(), answers: loc.answers, attemptId: loc.attemptId });
    iqSave(Object.assign(loc, { phase: 'done', score: j.score, max: j.max, dataV: j.state ? j.state.dataV : 0 }));
    if (j.state) onState(j.state);
  } catch (e) {
    if (/уже прошла/.test(e.message)) { store.del(iqKey()); loadData(); renderView(true); return; }
    iqSave(Object.assign(loc, { error: 'Не получилось отправить: ' + e.message }));
  }
}

// ----- Результаты -----

function viewResults() {
  const r = app.data.results;
  if (!r) return `<div class="loading">Считаем результаты…</div>`;
  return viewIqRating(r.iq);
}

const MEDALS = ['🥇', '🥈', '🥉'];

function viewIqRating(list, compact) {
  return `<section class="card ${compact ? '' : 'narrow'}">
    ${compact ? '' : '<h1>🧠 Рейтинг IQ-теста по группам</h1>'}
    ${list.length ? `<ol class="rating">${list.map((x, i) => `<li>
      <span class="place">${MEDALS[i] || i + 1}</span>
      <span class="who"><b>${esc(x.team)}</b><span class="muted small">${esc(x.people)}</span></span>
      <span class="pts">${x.score}<span class="muted">/${x.max}</span></span>
      <span class="iqv muted small">IQ ${iqNumber(x.score, x.max)}</span></li>`).join('')}</ol>` : '<p class="muted">Пока никто не прошёл тест</p>'}
  </section>`;
}

function verdictIcon(ok) { return ok === true ? '<b class="ok">✓</b>' : ok === false ? '<b class="bad">✗</b>' : '<b class="muted">?</b>'; }

// ----- Испытания для всех групп -----

const CH_TYPE_TITLES = { choice: 'выбор', text: 'текст', number: 'число', words: '4 слова', spy: 'шпионы', case: 'кейс' };
// Подпись «кто сейчас» для испытаний, где группы выходят по очереди.
const CH_TURN = {
  words: { admin: '🎭', other: 'Показывает', mine: 'Ваша очередь показывать!', hint: 'Кто сейчас выходит показывать (под названием — слово группы). Предложение группы пишут в любой момент, пока приём открыт.' },
  spy: { admin: '🚪', other: 'Сейчас в комнате', mine: 'Ваша очередь заходить в комнату!', hint: 'Кто сейчас в комнате. Голосовать группы могут в любой момент, пока приём открыт.' },
  case: { admin: '🚪', other: 'Сейчас в комнате', mine: 'Ваша очередь заходить в комнату!', hint: 'Кто сейчас в комнате. Сумму группа вводит на своём планшете — или впишите её сами в таблицу ниже.' },
};

// Своё секретное слово в «4 словах» приходит отдельным запросом.
let wordLoading = '';
function loadMyWord(ch) {
  const team = myTeam();
  const key = ch.id + ':' + ch.startedAt;
  if (!team || ch.type !== 'words' || (app.myWord && app.myWord.key === key) || wordLoading === key) return;
  wordLoading = key;
  apiGet({ a: 'word', team }).then(j => { app.myWord = { key, word: j.word }; renderView(true); })
    .catch(() => {}).finally(() => { wordLoading = ''; });
}

function chTimeLeft(ch) { return ch.endsAt ? Math.max(0, Math.round((ch.endsAt - 3000 - serverNow()) / 1000)) : null; }

function viewChallenge() {
  const ch = app.data.challenge;
  if (!ch) return `<section class="hero"><h1 class="hero-title">Испытание скоро начнётся</h1><p class="muted">Ждём команду от именинников</p></section>`;
  const team = myTeam();
  const words = ch.type === 'words';
  const spy = ch.type === 'spy';
  const turn = CH_TURN[ch.type];
  if (words) loadMyWord(ch);
  const myWord = words && app.myWord && app.myWord.key === ch.id + ':' + ch.startedAt ? app.myWord.word : '';
  const mine = team ? ch.answers[team] : '';
  const left = chTimeLeft(ch);
  const open = ch.phase === 'answer' && left !== 0;
  const nTeams = app.data.teams.filter(t => !t.birthday).length;
  let body = '';

  if (ch.phase === 'reveal' && spy) {
    const sp = ch.results.find(r => r.spy);
    body = `<div class="ch-correct">${sp ? `🕵️ Шпионы — <b>${esc(sp.team)}</b>` : 'Шпионы не указаны'}</div>
      <ol class="rating ch-results">${ch.results.map(r => `<li class="${r.team === team ? 'mine' : ''}">
        <span class="place">${r.spy ? '🕵️' : r.ok === true ? '✓' : r.ok === false ? '✗' : '?'}</span>
        <span class="who"><b>${esc(r.team)}</b><span class="muted small">${r.spy ? `шпионы · вычислили: ${r.found}` : r.answer ? 'голос: ' + esc(r.answer) : 'не голосовали'}</span></span>
        <span class="pts">${r.pts ? '+' + fmtPts(r.pts) : '0'}</span></li>`).join('')}</ol>`;
  } else if (ch.phase === 'reveal' && ch.type === 'case') {
    const winners = ch.results.filter(r => r.ok);
    const all = winners.length && winners.length === ch.results.length;
    body = `<div class="ch-correct">${all ? 'Все взяли поровну — <b>балл каждому!</b>' : winners.length ? `Больше всех взяли: <b>${esc(winners.map(r => r.team).join(', '))}</b>` : 'Никто ничего не взял'}</div>
      <ol class="rating ch-results">${ch.results.map(r => `<li class="${r.team === team ? 'mine' : ''}">
        <span class="place">${r.ok ? '💰' : '·'}</span>
        <span class="who"><b>${esc(r.team)}</b><span class="muted small">${r.answer ? 'взяли: ' + esc(r.answer) : 'нет ответа'}</span></span>
        <span class="pts">${r.pts ? '+' + fmtPts(r.pts) : '0'}</span></li>`).join('')}</ol>`;
  } else if (ch.phase === 'reveal') {
    body = `<div class="ch-correct">${words ? 'Правильное предложение:' : 'Правильный ответ:'} <b>${esc(ch.correct) || '—'}</b></div>
      ${ch.words ? `<div class="ch-words">${ch.words.map(w => `<span><b>${esc(w.word)}</b>${esc(w.team)}</span>`).join('')}</div>` : ''}
      <ol class="rating ch-results">${ch.results.map(r => `<li class="${r.team === team ? 'mine' : ''}">
        <span class="place">${r.ok === true ? '✓' : r.ok === false ? '✗' : '?'}</span>
        <span class="who"><b>${esc(r.team)}</b><span class="muted small">${esc(r.answer) || 'нет ответа'}</span></span>
        <span class="pts">${r.pts ? '+' + fmtPts(r.pts) : '0'}</span></li>`).join('')}</ol>`;
  } else if (!team) {
    body = `<p class="notice">${ch.phase === 'answer' ? `Ответили: ${Object.keys(ch.answers).filter(t => ch.answers[t]).length} из ${nTeams}` : 'Приём ответов закрыт'}</p>`;
  } else if (!open) {
    body = `<p class="notice">Приём ответов закрыт</p>${mine ? `<p class="center">Ваш ответ: <b>${esc(mine)}</b></p>` : ''}`;
  } else {
    const id = `ch-ans-${ch.id}`;
    const q = words ? 'Итоговое предложение из всех слов' : ch.type === 'case' ? 'Сколько вы взяли из кейса?' : 'Ваш ответ';
    if (spy) {
      body = `<label>Кто шпионы?</label><div class="iq-opts">${ch.options.filter(o => o !== team).map(o => `<button class="opt ${mine === o ? 'on' : ''}" data-act="chChoice" data-v="${esc(o)}" ${app.busy.ch ? 'disabled' : ''}><b>🕵️</b>${esc(o)}</button>`).join('')}</div>`;
    } else if (ch.type === 'choice') {
      body = `<div class="iq-opts">${ch.options.map((o, i) => `<button class="opt ${mine === o ? 'on' : ''}" data-act="chChoice" data-v="${esc(o)}" ${app.busy.ch ? 'disabled' : ''}><b>${'ABCDEFGH'[i] || i + 1}</b>${esc(o)}</button>`).join('')}</div>`;
    } else {
      const input = ch.type === 'number' || ch.type === 'case'
        ? `<input id="${id}" data-draft inputmode="decimal" value="${esc(mine)}" placeholder="${ch.type === 'case' ? 'сумма' : 'число'}" autocomplete="off">`
        : words
          ? `<textarea id="${id}" data-draft rows="2" placeholder="предложение">${esc(mine)}</textarea>`
          : `<input id="${id}" data-draft value="${esc(mine)}" placeholder="ответ" autocomplete="off">`;
      body = `<label>${q}</label>${input}
        <button class="btn big" data-act="chSend" data-input="${id}" ${app.busy.ch ? 'disabled' : ''}>${app.busy.ch ? 'Отправляем…' : 'Отправить'}</button>`;
    }
    if (mine) body += `<p class="muted center small">✓ ${spy ? 'Ваш голос' : 'Ответ отправлен'}: <b>${esc(mine)}</b>. Можно изменить, пока приём открыт.</p>`;
  }

  return `<section class="card narrow ch">
    <div class="iq-top"><span>🎯 Испытание</span><span id="ch-timer" class="iq-timer"></span></div>
    <h1>${esc(ch.name)}</h1>
    ${ch.task ? `<p class="ch-task">${esc(ch.task)}</p>` : ''}
    ${words && team ? `<div class="ch-word">Ваше слово: <b>${esc(myWord) || '…'}</b><span class="muted small">никому не говорите — только показывайте</span></div>` : ''}
    ${turn && ch.presenter && ch.phase === 'answer' ? (ch.presenter === team
      ? `<div class="ch-present">${turn.admin} ${turn.mine}</div>`
      : `<div class="ch-present">${turn.admin} ${turn.other}: ${esc(ch.presenter)}</div>`) : ''}
    ${body}
  </section>`;
}

let chInterval = null;
function chTick() {
  clearInterval(chInterval);
  const ch = app.data && app.state && app.state.screen === 'challenge' && app.data.challenge;
  if (!ch || ch.phase !== 'answer' || !ch.endsAt) return;
  let wasOpen = chTimeLeft(ch) > 0;
  const upd = () => {
    const left = chTimeLeft(ch);
    const el = $('#ch-timer');
    if (el) { el.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; el.classList.toggle('low', left < 15); }
    if (left === 0) {
      clearInterval(chInterval);
      // Перерисовать только в момент, когда время вышло, иначе отрисовка запустит таймер снова.
      if (wasOpen) { wasOpen = false; renderView(true); }
    }
  };
  upd();
  chInterval = setInterval(upd, 1000);
}

async function chSend(answer) {
  const ch = app.data.challenge;
  app.busy.ch = true;
  renderView(true);
  try {
    const j = await apiPost({ a: 'chAnswer', team: myTeam(), id: ch.id, answer });
    ch.answers[myTeam()] = answer;
    toast('Ответ отправлен ✓', 'ok');
    onState(j.state);
  } catch (e) { toast(e.message, 'err'); }
  finally { app.busy.ch = false; renderView(true); }
}

// ----- Своя игра -----

function viewSigame() {
  const url = app.state.sigame;
  return `<section class="card narrow center sigame">
    <div class="big-emoji">🎯</div>
    <h1>Своя игра</h1>
    ${url ? `<a class="btn big" href="${esc(url)}" target="_blank" rel="noopener">Открыть лобби →</a>
      <div id="qr" class="qr" data-url="${esc(url)}"></div>
      <div class="muted small break">${esc(url)}</div>` : '<p class="muted">Ссылка на лобби скоро появится</p>'}
  </section>`;
}

// ----- Таблица баллов -----

const fmtPts = n => String(Math.round(n * 100) / 100).replace('.', ',');

function viewScores(sc) {
  if (!sc) return `<section class="card narrow center"><div class="big-emoji">🙈</div><h2>Баллы пока скрыты</h2><p class="muted">Именинники покажут их позже</p></section>`;
  const order = sc.teams.map((t, i) => i).sort((a, b) => sc.totals[b] - sc.totals[a]);
  return `<section class="card narrow">
      <h1>🏆 Таблица баллов</h1>
      <ol class="rating">${order.map((i, k) => `<li class="${myTeam() === sc.teams[i] ? 'mine' : ''}">
        <span class="place">${MEDALS[k] || k + 1}</span>
        <span class="who"><b>${esc(sc.teams[i])}</b></span>
        <span class="pts" data-count="${sc.totals[i]}">${fmtPts(sc.totals[i])}</span></li>`).join('')}</ol>
    </section>
    <section class="card">
      <h2>По дисциплинам</h2>
      ${scoresTable(sc, false)}
    </section>`;
}

function scoresTable(sc, adminMode) {
  const cell = (r, i) => adminMode
    ? `<td class="score-cell"><button class="mini" data-act="scoreAdd" data-d="${esc(r.name)}" data-team="${esc(sc.teams[i])}" data-delta="-1">−</button><b>${fmtPts(r.pts[i])}</b><button class="mini" data-act="scoreAdd" data-d="${esc(r.name)}" data-team="${esc(sc.teams[i])}" data-delta="1">+</button></td>`
    : `<td>${r.pts[i] ? fmtPts(r.pts[i]) : '<span class="muted">—</span>'}</td>`;
  return `<div class="table-wrap"><table class="res-table scores-table">
    <thead><tr><th>Дисциплина</th>${sc.teams.map(t => `<th>${esc(t)}</th>`).join('')}</tr></thead>
    <tbody>${sc.rows.map(r => `<tr><th>${esc(r.name)}</th>${sc.teams.map((t, i) => cell(r, i)).join('')}</tr>`).join('')}
      <tr class="total-row"><th>Итого</th>${sc.totals.map(t => `<td><b>${fmtPts(t)}</b></td>`).join('')}</tr></tbody>
  </table></div>`;
}

// ===================== Пульт именинников =====================

const ADMIN_TABS = [
  ['control', '🎛 Пульт'], ['scores', '🏆 Баллы'], ['plan', '🗓 План'], ['facts', '🃏 Факты'], ['iq', '🧠 IQ-тест'],
  ['challenges', '🎯 Испытания'], ['sigame', '🎯 Своя игра'],
];

function shellAdmin() {
  return `<header class="top admin-top">
      <div class="brand">🎂 <b>Пульт именинников</b></div>
      <div id="hdr-now" class="hdr-now"></div>
      <span id="net" class="net on"></span>
      <button class="icon-btn" data-act="logout" title="Выйти">⎋</button>
    </header>
    <div class="admin-layout">
      <aside class="side">
        <div id="buzz-box" class="side-box"></div>
        <nav class="side-nav">${ADMIN_TABS.map(([k, t]) => `<button data-atab="${k}">${t}</button>`).join('')}</nav>
      </aside>
      <main id="main" class="main admin-main"></main>
    </div>
    <button id="buzz-fab" class="buzz-fab" data-act="buzzerQuick" title="Запустить тревогу-кнопку"><b>🚨</b><span>ТРЕВОГА</span></button>`;
}

function viewAdmin() {
  const st = app.state;
  const a = app.admin;
  if (!st || !a || !app.data) return `<div class="loading">Загрузка…</div>`;
  if (!a.challenges || !a.scores) {
    return `<section class="card narrow center"><div class="big-emoji">🔄</div><h2>Скрипт таблицы старой версии</h2>
      <p class="muted">Вставьте новый Code.gs в Apps Script и выпустите новую версию развертывания, затем обновите страницу.</p>
      <button class="btn" onclick="location.reload()">Обновить страницу</button></section>`;
  }
  const nowBar = `<div class="now-bar">На планшетах: <b>${esc(SCREEN_TITLES[st.screen] || st.screen)}${st.screen === 'results' ? ' — ' + esc(GAME_TITLES[st.results]) : ''}</b></div>`;
  switch (app.adminTab) {
    case 'plan': return nowBar + adminPlan();
    case 'facts': return nowBar + adminFacts();
    case 'iq': return nowBar + adminIq();
    case 'challenges': return nowBar + adminChallenges();
    case 'sigame': return nowBar + adminSigame();
    case 'scores': return nowBar + adminScores();
    default: return nowBar + adminControl();
  }
}

function screenBtn(screen, label, extra = '') {
  const st = app.state;
  const on = st.screen === screen && (screen !== 'results' || !extra || extra.includes(`data-results="${st.results}"`));
  return `<button class="btn ${on ? 'active' : 'ghost'}" data-act="setScreen" data-screen="${screen}" ${extra}>${on ? '● ' : ''}${label}</button>`;
}

function adminControl() {
  const a = app.admin;
  const devs = Object.keys(a.seen).map(d => {
    const ago = a.seen[d] ? Math.round((a.now - a.seen[d]) / 1000) : null;
    const on = ago !== null && ago < 20;
    return `<li class="${on ? 'on' : 'off'}"><span class="dot-s"></span>${esc(d)}<span class="muted small">${ago === null ? 'не подключался' : on ? 'онлайн' : ago < 3600 ? Math.round(ago / 60) + ' мин назад' : 'давно'}</span></li>`;
  }).join('');
  return `<div class="cards-grid">
    <section class="card">
      <h2>Что показать на планшетах</h2>
      <div class="screen-btns">
        ${screenBtn('plan', '🗓 План / ожидание')}
        ${screenBtn('facts', '🃏 Факты')}
        ${screenBtn('iq', '🧠 IQ-тест')}
        ${screenBtn('challenge', '🎯 Испытание')}
        ${screenBtn('results', '🏆 Рейтинг IQ', 'data-results="iq"')}
        ${screenBtn('sigame', '🎯 Своя игра')}
        ${screenBtn('scores', '🏆 Таблица баллов')}
        ${screenBtn('splash', '🎬 Заставка')}
      </div>
    </section>
    ${adminSplash()}
    <section class="card">
      <h2>Устройства</h2>
      <ul class="devices">${devs}</ul>
      <button class="btn ghost" data-act="refresh">↻ Перечитать таблицу</button>
      <p class="muted small">Правки в таблице подтягиваются сами за ~30 секунд, кнопка — сразу.</p>
    </section>
    <section class="card">
      <h2>Сейчас по плану</h2>
      ${adminPlanList(true)}
    </section>
  </div>`;
}

function adminSplash() {
  const sp = app.state.splash || {};
  return `<section class="card">
      <h2>🎬 Заставка для игроков</h2>
      <p class="muted small">Текст меняется сразу на всех планшетах. Пустой подзаголовок — имена именинников.</p>
      <label>Заголовок</label>
      <input id="sp-title" data-draft data-change="setSplash" value="${esc(sp.title)}" placeholder="С днём рождения!" maxlength="120" autocomplete="off">
      <label>Подзаголовок</label>
      <input id="sp-sub" data-draft data-change="setSplash" value="${esc(sp.sub)}" placeholder="${esc(birthdayNames() || 'например: Через 5 минут — Своя игра!')}" maxlength="200" autocomplete="off">
      <label>Эмодзи над заголовком</label>
      <input id="sp-emoji" data-draft data-change="setSplash" value="${esc(sp.emoji)}" placeholder="🎂" maxlength="16" autocomplete="off">
      <div class="row">${screenBtn('splash', app.state.screen === 'splash' ? 'Заставка на планшетах' : '▶ Показать заставку на планшетах')}</div>
    </section>`;
}

function adminScores() {
  const sc = app.admin.scores;
  if (!sc) return `<div class="loading">Загрузка…</div>`;
  return `<section class="card">
      <div class="row between"><h2>🏆 Баллы групп</h2>${screenBtn('scores', app.state.screen === 'scores' ? 'Баллы на планшетах' : '▶ Показать на планшетах')}</div>
      <label class="check"><input type="checkbox" data-act="scoresVisible" ${app.state.scoresHidden ? '' : 'checked'}> гости видят баллы (вкладка «Баллы» на планшетах)</label>
      <p class="muted small">+ / − сразу меняют лист «Баллы». Дробные баллы и названия дисциплин можно править прямо в таблице.</p>
      ${scoresTable(sc, true)}
      <div class="row"><input id="disc-name" data-draft placeholder="Новая дисциплина" autocomplete="off"><button class="btn ghost" data-act="disciplineAdd">+ Добавить дисциплину</button></div>
    </section>`;
}

function adminPlanList(compact) {
  const cur = app.state.planCurrent;
  return `<ol class="plan-list admin-plan ${compact ? 'compact' : ''}">${app.data.plan.map((p, i) => `<li class="${i === cur ? 'cur' : i < cur ? 'done' : ''}" data-act="planCurrent" data-i="${i === cur ? -1 : i}">
    <span class="plan-time">${esc(p.time)}</span><span class="plan-event">${esc(p.event)}</span>${i === cur ? '<span class="pill">сейчас</span>' : ''}</li>`).join('')}</ol>`;
}

function adminPlan() {
  return `<section class="card">
    <h2>План дня</h2>
    <p class="muted">Нажмите на пункт, чтобы отметить его как «сейчас» (повторное нажатие снимает отметку). Сам план редактируется в листе «План».</p>
    ${adminPlanList(false)}
  </section>`;
}

function peopleOptions(selected) {
  return app.admin.teams.map(t => `<optgroup label="${esc(t.name)}">${t.members.map(m =>
    `<option value="${esc(m.label)}" ${m.label === selected ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</optgroup>`).join('');
}

function adminFacts() {
  const st = app.state;
  const f = st.facts;
  const facts = app.admin.facts;
  const cur = f.current && facts.find(x => x.id === f.current);
  const opened = f.current && f.opened[f.current];
  const allPeople = app.admin.teams.flatMap(t => t.members.map(m => m.label));
  const notYet = allPeople.filter(p => !f.taken.includes(p));
  const score = {};
  Object.values(f.opened).forEach(o => {
    score[o.by] = score[o.by] || { ok: 0, n: 0 };
    score[o.by].n++;
    if (o.ok) score[o.by].ok++;
  });
  const openedCount = Object.keys(f.opened).length;
  return `<div class="cards-grid facts-admin">
    <section class="card span2">
      <div class="row between"><h2>Игра</h2>${screenBtn('facts', st.screen === 'facts' ? 'Факты на планшетах' : '▶ Показать на планшетах')}</div>
      <div class="turn-box">
        <label>Кто открывает следующий:</label>
        <div class="row">
          <select id="turn-who" data-draft><option value="">— выберите —</option>${peopleOptions(f.turn)}</select>
          <button class="btn" data-act="factsTurn">Дать ход</button>
          <button class="btn ghost" data-act="factsRandom" title="Из тех, кто ещё не открывал">🎲 Случайный</button>
        </div>
        <div class="muted small">Ещё не открывали (${notYet.length}): ${esc(notYet.join(', ')) || '—'}</div>
      </div>
      ${f.turn ? `<div class="now-turn">Ход: <b>${esc(f.turn)}</b> ${f.current ? '' : '— ждём, пока выберет ячейку (можно нажать за него ниже)'}</div>` : ''}
      ${cur ? `<div class="admin-fact">
          <div class="fact-text sm">${esc(cur.text)}</div>
          <div>Ответ: <b>${esc(cur.who || '— не указан —')}</b></div>
          <div class="row">
            <button class="btn" data-act="factsReveal" ${f.reveal ? 'disabled' : ''}>👁 Показать ответ всем</button>
            <button class="btn green ${opened && opened.ok === true ? 'active' : ''}" data-act="factsMark" data-ok="1">✓ Угадал</button>
            <button class="btn red ${opened && opened.ok === false ? 'active' : ''}" data-act="factsMark" data-ok="0">✗ Не угадал</button>
            <button class="btn ghost" data-act="factsHide">Закрыть факт</button>
          </div>
        </div>` : ''}
      <div class="admin-grid">${viewFacts(true)}</div>
      <div class="row">
        <span class="muted">Открыто ${openedCount} из ${facts.length}</span>
        <button class="btn ghost" data-act="factsShuffle">🔀 Перемешать ячейки</button>
        <button class="btn ghost" data-act="factsReset">⟲ Начать игру заново</button>
      </div>
      ${Object.keys(score).length ? `<h3>Кто угадал</h3><ul class="score-list">${Object.entries(score).sort((x, y) => y[1].ok - x[1].ok)
        .map(([k, v]) => `<li><b>${esc(k)}</b> ${v.ok}/${v.n}</li>`).join('')}</ul>` : ''}
    </section>
    <section class="card">
      <h2>Добавить факт</h2>
      <label>О ком</label>
      <select id="fact-who" data-draft>${peopleOptions(drafts['fact-who'])}</select>
      <label>Факт</label>
      <textarea id="fact-text" data-draft rows="3" placeholder="Например: прыгал с парашютом"></textarea>
      <button class="btn" data-act="factAdd">Добавить</button>
      <h3>Все факты (${facts.length})</h3>
      <ol class="fact-list">${facts.map(x => `<li class="${f.opened[x.id] ? 'done' : ''}">
        <span>${esc(x.text)} <span class="muted">— ${esc(x.who || '?')}</span></span>
        <button class="icon-btn" data-act="factDelete" data-id="${x.id}" title="Удалить">✕</button></li>`).join('')}</ol>
    </section>
  </div>`;
}

function adminIq() {
  const st = app.state;
  return `<div class="cards-grid">
    <section class="card">
      <h2>IQ-тест</h2>
      <p class="muted">${app.admin.iqQuestions} вопросов, ${app.admin.settings.iqMinutes || 'без'} мин. Вопросы и ответы — в листе «IQ вопросы». Баллы пишутся в лист «4 комнаты».</p>
      <div class="row">
        ${screenBtn('iq', st.screen === 'iq' ? 'Тест на планшетах' : '▶ Запустить тест на планшетах')}
        <button class="btn ${st.iq.open ? 'red' : 'green'}" data-act="setOpen" data-game="iq" data-open="${st.iq.open ? 0 : 1}">${st.iq.open ? 'Закрыть новые попытки' : 'Открыть тест'}</button>
      </div>
      ${screenBtn('results', '🏆 Показать рейтинг на планшетах', 'data-results="iq"')}
      <h3>Группы</h3>
      <p class="muted small">Тест проходит вся группа вместе, одна попытка. «Заново» удаляет результат группы.</p>
      <ul class="devices">${app.admin.teams.filter(t => !t.birthday).map(t => {
        const r = app.admin.iq.find(x => x.team === t.name);
        return `<li class="${r ? 'on' : 'off'}"><span class="dot-s"></span>${esc(t.name)}
          <span class="muted">${r ? `${r.score}/${r.max} · ${esc(r.time)}` : 'ещё не прошла'}</span>
          ${r ? `<button class="icon-btn" data-act="iqReset" data-team="${esc(t.name)}" title="Дать пройти заново">↺ заново</button>` : ''}</li>`;
      }).join('')}</ul>
    </section>
    <section class="card span2">
      <h2>Рейтинг групп</h2>
      ${viewIqRating(app.admin.iq, true)}
    </section>
  </div>`;
}

const CH_PHASES = { answer: 'идёт приём ответов', closed: 'приём закрыт', reveal: 'ответ показан' };

function adminChallenges() {
  const st = app.state;
  const cur = st.challenge;
  const list = app.admin.challenges;
  const ch = cur.id ? list.find(c => c.id === cur.id) : null;
  const teams = app.admin.teams.filter(t => !t.birthday).map(t => t.name);
  let current = '';
  if (ch) {
    const words = ch.type === 'words';
    const turn = CH_TURN[ch.type];
    const results = ch.results;
    const awarded = results.length && results.every(r => ch.awarded[r.team] === r.pts);
    current = `<section class="card span2 ch-current">
      <div class="row between"><h2>▶ ${esc(ch.name)}</h2><span class="pill">${esc(CH_PHASES[cur.phase] || cur.phase)}</span></div>
      ${st.screen !== 'challenge' ? `<div class="row">${screenBtn('challenge', '▶ Вернуть испытание на планшеты')}</div>` : ''}
      ${turn ? `<div class="row">${teams.map((t, i) => `<button class="btn ${cur.presenter === t ? 'active' : 'ghost'}" data-act="chPresenter" data-team="${esc(t)}">${turn.admin} ${esc(t)}${words ? `<span class="muted small">${esc(ch.options[i] || '—')}</span>` : ''}</button>`).join('')}</div>
        <p class="muted small">${turn.hint}</p>` : ''}
      <div class="row">
        <button class="btn ${cur.phase === 'answer' ? 'active' : 'ghost'}" data-act="chPhase" data-phase="answer">Открыть приём</button>
        <button class="btn ${cur.phase === 'closed' ? 'active' : 'ghost'}" data-act="chPhase" data-phase="closed">Закрыть приём</button>
        <button class="btn ${cur.phase === 'reveal' ? 'active' : 'ghost'}" data-act="chPhase" data-phase="reveal">👁 Показать ответ</button>
        <button class="btn green" data-act="chAward" data-id="${ch.id}" ${!results.length ? 'disabled' : ''}>${awarded ? '✓ Баллы начислены' : '💰 Начислить баллы'}</button>
      </div>
      ${results.length ? `<table class="res-table ch-table"><thead><tr><th>Группа</th><th>Ответ</th><th>Проверка</th><th>Баллы</th></tr></thead><tbody>
        ${results.map(r => r.spy
          ? `<tr><th>🕵️ ${esc(r.team)}</th><td>шпионы${r.answer ? ` · голос: ${esc(r.answer)}` : ''}</td><td>вычислили: ${r.found}</td><td>${fmtPts(r.pts)}</td></tr>`
          : `<tr><th>${esc(r.team)}</th><td>${ch.type === 'case'
            ? `<input id="case-${ch.id}-${esc(r.team)}" class="case-input" data-draft data-change="chSetAnswer" data-id="${ch.id}" data-team="${esc(r.team)}" inputmode="decimal" value="${esc(r.answer)}" placeholder="сумма">`
            : esc(r.answer) || '<span class="muted">—</span>'}</td>
            <td class="vcell ${r.ok === true ? 'is-ok' : r.ok === false ? 'is-bad' : ''}" data-act="chVerdict" data-id="${ch.id}" data-team="${esc(r.team)}" data-ok="${r.ok}" data-manual="${r.manual}">${verdictIcon(r.ok)}${r.manual ? ' ✎ вручную' : ' авто'}</td>
            <td>${fmtPts(r.pts)}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">Нажмите на проверку, чтобы засчитать вручную: авто → ✓ → ✗ → авто. После исправлений нажмите «Начислить» ещё раз — добавится только разница.</p>` : ''}
    </section>`;
  }
  return `<div class="cards-grid">${current}
    <section class="card span2">
      <div class="row between"><h2>🎯 Испытания</h2><button class="btn ghost" data-act="refresh">↻ Перечитать таблицу</button></div>
      <p class="muted small">Задания, варианты, баллы и таймер — в листе «Испытания». Тип: выбор / текст / число / слова / шпион / кейс. Баллы идут в дисциплину из колонки «Дисциплина».</p>
      <div class="ch-list">${list.map(c => `<div class="ch-item ${c.id === cur.id ? 'cur' : ''}">
        <div class="ch-item-head"><b>${c.id}. ${esc(c.name)}</b><span class="pill">${esc(CH_TYPE_TITLES[c.type])}</span>
          <span class="muted small">${fmtPts(c.pts)} б.${c.seconds ? ` · ${c.seconds} с` : ''}</span>
          <button class="btn ${c.id === cur.id ? 'active' : ''}" data-act="chStart" data-id="${c.id}">${c.id === cur.id ? 'Перезапустить' : '▶ Запустить'}</button></div>
        <div class="muted small">${esc(c.task)}${c.options.length ? ` — <b>${esc(c.options.join(' · '))}</b>` : ''}</div>
        ${c.type === 'words' || c.type === 'choice' ? `<label class="room-row"><span class="room-n">${c.type === 'words' ? 'Слова групп (через ;)' : 'Варианты (через ;)'}</span>
          <input id="opt-ch-${c.id}" data-draft data-change="chSetOptions" data-id="${c.id}" value="${esc(c.options.join(';'))}" placeholder="${c.type === 'words' ? teams.map((t, i) => 'слово ' + (i + 1)).join(';') : 'Правда;Ложь'}" autocomplete="off"></label>
          ${c.type === 'words' ? `<div class="muted small">${teams.map((t, i) => `${esc(t)}: <b>${esc(c.options[i] || '—')}</b>`).join(' · ')}</div>` : ''}` : ''}
        ${c.type === 'case' ? '' : `<label class="room-row"><span class="room-n">${c.type === 'words' ? 'Правильное предложение' : c.type === 'spy' ? 'Шпионы (секрет)' : 'Правильный ответ'}</span>`}
          ${c.type === 'spy'
            ? `<select id="cor-ch-${c.id}" data-draft data-change="chSetCorrect" data-id="${c.id}"><option value="">— выберите —</option>${teams.map(t => `<option ${t === c.correct ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`
            : c.type === 'case' ? '' : `<input id="cor-ch-${c.id}" data-draft data-change="chSetCorrect" data-id="${c.id}" value="${esc(c.correct)}" placeholder="${c.type === 'number' ? 'число' : c.type === 'choice' ? 'один из вариантов' : 'можно несколько через /'}" autocomplete="off">`}${c.type === 'case' ? '' : '</label>'}
      </div>`).join('')}</div>
    </section>
  </div>`;
}

function adminSigame() {
  const st = app.state;
  return `<section class="card narrow">
    <h2>🎯 Своя игра</h2>
    <label>Ссылка на лобби</label>
    <input id="sigame-url" data-draft data-change="setLink" value="${esc(st.sigame)}" placeholder="https://…" autocomplete="off">
    <div class="row">${screenBtn('sigame', st.screen === 'sigame' ? 'Ссылка на планшетах' : '▶ Показать ссылку на планшетах')}</div>
    ${st.sigame ? `<div id="qr" class="qr" data-url="${esc(st.sigame)}"></div>` : ''}
  </section>`;
}

// ===================== Кнопка «Кто первый» =====================

const secFmt = ms => (ms / 1000).toFixed(2).replace('.', ',') + ' с';
function buzzLocal() { return store.get('buzz', {}); }
let buzzTimer = null;

// Внезапная тревога-кнопка: пульт запускает её в любой момент дня, на всех планшетах
// одновременно (в общий момент startAt) воет сирена. Время считается от startAt по часам
// сервера, поэтому планшет, получивший сигнал позже, не проигрывает и не выигрывает.
function renderBuzzer() {
  if (isAdmin()) { renderBuzzAdmin(); return; }
  const el = $('#buzz');
  const bz = app.state && app.state.buzzer;
  clearTimeout(buzzTimer);
  const waiting = bz && bz.on && !bz.done && serverNow() < bz.startAt;
  if (waiting) buzzTimer = setTimeout(renderBuzzer, Math.max(0, bz.startAt - serverNow()));
  if (!app.started || !bz || !bz.on || waiting || store.get('buzzSeen', 0) === bz.id) {
    if (!el.hidden) { el.hidden = true; el.innerHTML = ''; el.dataset.key = ''; sound.stopSiren(); }
    return;
  }
  const team = myTeam();
  const mine = buzzLocal().id === bz.id ? buzzLocal() : {};
  const phase = bz.done ? 'result' : mine.ms !== undefined ? 'pressed' : 'go';
  const key = bz.id + phase + (phase === 'result' ? JSON.stringify(bz.presses) : '');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.className = 'buzz-' + phase;
  el.hidden = false;
  if (phase === 'go') {
    el.innerHTML = `<div class="buzz-title">ТРЕВОГА!</div>
      <div class="buzz-sub">Кто первым нажмёт — получит ${bz.points ? '+' + bz.points : 'победу'}</div>
      ${team ? '<button class="buzz-btn go" id="buzz-btn">ЖМИ!</button>' : ''}`;
    sound.startSiren();
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
  } else if (phase === 'pressed') {
    sound.stopSiren();
    el.innerHTML = `<div class="buzz-title">Нажато!</div><div class="buzz-sub">Ваше время: <b>${secFmt(mine.ms)}</b><br>Ждём остальных…</div>`;
  } else {
    sound.stopSiren();
    const list = Object.keys(bz.presses).sort((a, b) => bz.presses[a] - bz.presses[b]);
    const won = bz.winner && bz.winner === team;
    if (won) { sound.fanfare(); celebrate('big'); }
    el.innerHTML = `<div class="buzz-title">${bz.winner ? (won ? 'ВЫ ПЕРВЫЕ! 🎉' : esc(bz.winner) + ' — первые!') : 'Никто не успел'}</div>
      ${bz.winner && bz.points ? `<div class="buzz-sub">+${bz.points} в «${esc(bz.discipline)}»</div>` : ''}
      <ol class="buzz-list">${list.map((t, i) => `<li class="${t === team ? 'mine' : ''}">${MEDALS[i] || i + 1} ${esc(t)} <span>${secFmt(bz.presses[t])}</span></li>`).join('')}</ol>
      <button class="btn big buzz-ok" data-act="buzzSeen">OK</button>`;
  }
  const btn = $('#buzz-btn');
  if (btn) btn.addEventListener('pointerdown', buzzPress, { once: true });
}

async function buzzPress(e) {
  e.preventDefault();
  const bz = app.state.buzzer;
  const local = { id: bz.id, ms: Math.max(0, Math.round(serverNow() - bz.startAt)) };
  store.set('buzz', local);
  renderBuzzer();
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const j = await apiPost(Object.assign({ a: 'buzzerPress', team: myTeam() }, local));
      onState(j.state);
      return;
    } catch (err) {
      // Ответ сервера с ошибкой (раунд закрыт) не повторяем; обрыв сети — повторяем.
      if (!(err instanceof TypeError) || attempt === 4) { toast(err.message, 'err'); return; }
      await new Promise(r => setTimeout(r, 700 * attempt));
    }
  }
}

let finalizing = 0;
function buzzSettings() {
  const rows = (app.admin && app.admin.scores && app.admin.scores.rows) || [];
  const saved = store.get('bzDisc', '');
  const disc = drafts['bz-disc'] || (rows.some(r => r.name === saved) ? saved : (rows.find(r => /Кто первый/.test(r.name)) || rows[0] || { name: 'Кнопка «Кто первый»' }).name);
  const pts = Number(drafts['bz-pts'] !== undefined ? drafts['bz-pts'] : store.get('bzPts', 1));
  return { rows, disc, pts: isNaN(pts) ? 1 : pts };
}

function renderBuzzAdmin() {
  const box = $('#buzz-box');
  // Кнопка показывается всегда — даже если состояние пришло от старой версии скрипта.
  const bz = (app.state && app.state.buzzer) || { on: false, done: false, presses: {} };
  const fab = $('#buzz-fab');
  if (fab) {
    const live = bz.on && !bz.done;
    fab.classList.toggle('live', live);
    fab.classList.toggle('done', bz.on && bz.done);
    fab.querySelector('span').textContent = live ? 'ИДЁТ…' : bz.on && bz.done ? (bz.winner ? '🏆 ' + bz.winner : 'ИТОГ') : 'ТРЕВОГА';
  }
  if (!box) return;
  const pressed = Object.keys(bz.presses).sort((a, b) => bz.presses[a] - bz.presses[b]);
  // Итог подводится сам через 3 с после первого нажатия.
  if (bz.on && !bz.done && bz.firstAt && serverNow() > bz.firstAt + 3000 && finalizing !== bz.id) {
    finalizing = bz.id;
    act('buzzerFinalize').catch(() => { finalizing = 0; });
  }
  let html;
  if (bz.on && !bz.done) {
    html = `<div class="buzz-admin-status">🔔 ${serverNow() < bz.startAt ? 'Сигнал скоро…' : 'Сигнал дан!'}</div>
      <div class="small">${pressed.map(t => `${esc(t)} — ${secFmt(bz.presses[t])}`).join('<br>') || '<span class="muted">Пока никто не нажал</span>'}</div>
      <div class="row"><button class="btn ghost" data-act="buzzerFinalize">Итог</button><button class="btn ghost" data-act="buzzerClose">Отменить</button></div>`;
  } else if (bz.on && bz.done) {
    html = `<div class="buzz-admin-status">🏆 ${bz.winner ? esc(bz.winner) + (bz.points ? ` +${bz.points}` : '') : 'Никто не нажал'}</div>
      <div class="small">${pressed.map(t => `${esc(t)} — ${secFmt(bz.presses[t])}`).join('<br>')}</div>
      <button class="btn ghost" data-act="buzzerClose">Закрыть на планшетах</button>`;
  } else {
    const { rows, disc, pts } = buzzSettings();
    html = `<div class="small muted">🚨 Тревога-кнопка — в дисциплину:</div>
      <select id="bz-disc" data-draft>${(rows.length ? rows : [{ name: disc }]).map(r => `<option ${r.name === disc ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      <div class="row"><span class="small muted">Баллов победителю:</span><input id="bz-pts" data-draft type="number" value="${pts}" min="0" step="1"></div>
      <button class="btn big buzz-start" data-act="buzzerStart">🚨 Запустить тревогу</button>`;
  }
  if (box.dataset.html !== html) { box.dataset.html = html; paint(box, html); }
}

// ===================== Обработчики =====================

const ACTIONS = {
  pickTeam(el) { setRole({ type: 'team', team: el.dataset.team }); },
  pickScreen() { setRole({ type: 'screen' }); },
  async adminLogin() {
    const pin = $('#pin').value.trim();
    try { await apiPost({ a: 'login', pin }); setRole({ type: 'admin', pin }); } catch (e) { toast(e.message, 'err'); }
  },
  start() {
    if (app.started) return;
    sound.unlock();
    keepAwake();
    try { if (!isAdmin() && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}
    app.started = true;
    sound.chime();
    celebrate('small');
    const splash = $('.splash');
    if (splash) splash.classList.add('leaving');
    poll();
    setTimeout(render, splash && !reducedMotion() ? 450 : 0);
  },
  logout() {
    if (!isAdmin() && !confirm('Сменить устройство? (Команда / экран / пульт)')) return;
    logout();
  },
  buzzSeen() { store.set('buzzSeen', app.state.buzzer.id); renderBuzzer(); },
  buzzerStart() {
    const { disc, pts } = buzzSettings();
    const discipline = ($('#bz-disc') || {}).value || disc;
    const points = $('#bz-pts') ? Number($('#bz-pts').value) || 0 : pts;
    store.set('bzDisc', discipline);
    store.set('bzPts', points);
    act('buzzerStart', { discipline, points });
  },
  // Плавающая кнопка: запуск с последними настройками, во время раунда — итог/закрытие.
  buzzerQuick() {
    const bz = (app.state && app.state.buzzer) || {};
    if (bz.on && !bz.done) return toast('Тревога уже идёт — итог подведётся сам');
    if (bz.on && bz.done) return act('buzzerClose');
    ACTIONS.buzzerStart();
  },
  buzzerFinalize() { act('buzzerFinalize'); },
  buzzerClose() { act('buzzerClose'); },
  scoreAdd(el) { act('scoreAdd', { discipline: el.dataset.d, team: el.dataset.team, delta: Number(el.dataset.delta) }); },
  scoresVisible(el) { act('scoresVisible', { on: el.checked }); },
  async disciplineAdd() {
    const name = $('#disc-name').value.trim();
    if (!name) return toast('Введите название', 'err');
    await act('disciplineAdd', { name });
    delete drafts['disc-name'];
    $('#disc-name').value = '';
  },

  // --- гости ---
  async openFact(el) {
    app.busy.fact = true;
    renderView(true);
    try { const j = await apiPost({ a: 'factOpen', id: Number(el.dataset.id) }); onState(j.state); }
    catch (e) { toast(e.message, 'err'); }
    finally { app.busy.fact = false; renderView(true); }
  },
  iqStart() {
    iqSave({ phase: 'test', answers: {}, idx: 0, startedAt: Date.now(), attemptId: Date.now() + '-' + Math.random().toString(36).slice(2, 8) });
  },
  iqAnswer(el) {
    const loc = iqLocal();
    const q = app.data.iq.questions[loc.idx];
    loc.answers[q.id] = el.dataset.l;
    iqSave(loc);
    if (loc.idx < app.data.iq.questions.length - 1) setTimeout(() => { const l = iqLocal(); if (l.idx === loc.idx) { l.idx++; iqSave(l); } }, 350);
  },
  iqNav(el) { const loc = iqLocal(); loc.idx = Math.max(0, Math.min(app.data.iq.questions.length - 1, loc.idx + Number(el.dataset.d))); iqSave(loc); },
  iqGo(el) { const loc = iqLocal(); loc.idx = Number(el.dataset.i); iqSave(loc); },
  iqFinish(el) {
    const loc = iqLocal();
    const left = app.data.iq.questions.length - Object.keys(loc.answers).length;
    if (!el.dataset.force && left && !confirm(`Без ответа ${left} вопр. Завершить тест?`)) return;
    iqSubmit();
  },


  // --- пульт ---
  setScreen(el) { act('setScreen', { screen: el.dataset.screen, results: el.dataset.results }); },
  planCurrent(el) { act('planCurrent', { i: Number(el.dataset.i) }); },
  refresh() { act('refresh').then(() => toast('Данные перечитаны', 'ok')); },
  iqReset(el) { if (confirm(`Удалить результат «${el.dataset.team}» и дать группе пройти тест заново?`)) act('iqReset', { team: el.dataset.team }); },
  setOpen(el) { act('setOpen', { game: el.dataset.game, open: el.dataset.open === '1' }); },
  factsTurn() {
    const who = $('#turn-who').value;
    if (!who) return toast('Выберите, кто открывает', 'err');
    act('factsTurn', { who });
  },
  factsRandom() {
    const f = app.state.facts;
    const all = app.admin.teams.flatMap(t => t.members.map(m => m.label));
    const pool = all.filter(p => !f.taken.includes(p) && p !== f.turn);
    if (!pool.length) return toast('Все уже открывали ячейки', 'err');
    act('factsTurn', { who: pool[Math.floor(Math.random() * pool.length)] });
  },
  factsHide() { act('factsTurn', { who: null }); },
  factsReveal() { act('factsReveal'); },
  factsMark(el) { act('factsMark', { ok: el.dataset.ok === '1' }); },
  factsShuffle() { act('factsShuffle'); },
  factsReset() { if (confirm('Закрыть все ячейки и начать игру с фактами заново?')) act('factsReset'); },
  async factAdd() {
    const text = $('#fact-text').value.trim();
    const who = $('#fact-who').value;
    if (!text) return toast('Напишите факт', 'err');
    await act('factAdd', { text, who });
    delete drafts['fact-text'];
    $('#fact-text').value = '';
    $('#fact-text').focus();
    toast('Факт добавлен', 'ok');
  },
  chStart(el) {
    const cur = app.state.challenge;
    if (cur.id === Number(el.dataset.id) && !confirm('Перезапустить испытание? Ответы останутся, приём откроется заново.')) return;
    act('chStart', { id: Number(el.dataset.id) });
  },
  chPhase(el) { act('chPhase', { phase: el.dataset.phase }); },
  chPresenter(el) { act('chPresenter', { team: el.dataset.team }); },
  chAward(el) { act('chAward', { id: Number(el.dataset.id) }).then(() => toast('Баллы начислены', 'ok')); },
  chVerdict(el) {
    const manual = el.dataset.manual === 'true';
    const next = !manual ? true : el.dataset.ok === 'true' ? false : null;
    act('chVerdict', { id: Number(el.dataset.id), team: el.dataset.team, verdict: next });
  },
  chChoice(el) { chSend(el.dataset.v); },
  chSend(el) {
    const v = (document.getElementById(el.dataset.input) || {}).value || '';
    if (!v.trim()) return toast('Введите ответ', 'err');
    chSend(v.trim());
  },
  factDelete(el) { if (confirm('Удалить факт?')) act('factDelete', { id: Number(el.dataset.id) }); },

};

const CHANGES = {
  async chSetOptions(el) {
    await act('chSetOptions', { id: Number(el.dataset.id), value: el.value.trim() });
    delete drafts[el.id];
    toast('Сохранено', 'ok');
  },
  async chSetAnswer(el) {
    await act('chSetAnswer', { id: Number(el.dataset.id), team: el.dataset.team, answer: el.value.trim() });
    delete drafts[el.id];
    toast('Сумма сохранена', 'ok');
  },
  async chSetCorrect(el) {
    await act('chSetCorrect', { id: Number(el.dataset.id), value: el.value.trim() });
    delete drafts[el.id];
    toast('Сохранено', 'ok');
  },
  async setSplash(el) {
    await act('setSplash', {
      title: ($('#sp-title') || {}).value || '',
      sub: ($('#sp-sub') || {}).value || '',
      emoji: ($('#sp-emoji') || {}).value || '',
    });
    ['sp-title', 'sp-sub', 'sp-emoji'].forEach(id => delete drafts[id]);
    toast('Заставка обновлена', 'ok');
  },
  async setLink(el) {
    await act('setLink', { url: el.value.trim() });
    delete drafts[el.id];
    toast('Ссылка сохранена', 'ok');
  },
};

document.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { app.tab = tab.dataset.tab; renderView(true); return; }
  const atab = e.target.closest('[data-atab]');
  if (atab) { app.adminTab = atab.dataset.atab; store.set('adminTab', app.adminTab); renderView(true); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, e);
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id && el.hasAttribute('data-draft')) {
    drafts[el.id] = el.value;
    if (myTeam()) store.set('drafts_' + myTeam(), drafts);
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.id && el.hasAttribute('data-draft')) drafts[el.id] = el.value;
  const fn = CHANGES[el.dataset.change];
  if (fn) fn(el).catch(() => {});
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'pin') ACTIONS.adminLogin();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'fact-text') ACTIONS.factAdd();
});

function setRole(role) {
  app.role = role;
  store.set('role', role);
  drafts = myTeam() ? store.get('drafts_' + myTeam(), {}) : {};
  render();
}

function logout() {
  app.role = null;
  app.started = false;
  app.admin = null;
  app.adminRaw = '';
  store.del('role');
  clearTimeout(pollTimer);
  sound.stopSiren();
  render();
}

// ===================== Старт =====================

drafts = myTeam() ? store.get('drafts_' + myTeam(), {}) : {};
render();

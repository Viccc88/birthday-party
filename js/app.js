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
const POLL_MS = window.CONFIG.POLL_MS || 2000;

const SCREEN_TITLES = {
  plan: 'План / ожидание',
  facts: 'Угадай, чей факт',
  iq: 'IQ-тест',
  items: 'Врать или не врать: предметы',
  words: '4 слова',
  results: 'Результаты',
  sigame: 'Своя игра',
};
const GAME_TITLES = { iq: 'IQ-тест', items: 'Предметы в комнатах', words: '4 слова' };

const app = {
  role: store.get('role', null), // {type:'team', team} | {type:'screen'} | {type:'admin', pin}
  state: null,
  data: null,
  dataRaw: '',
  dataKey: '',
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
    const j = await apiGet({ a: 'state', d: deviceName() });
    setOnline(true);
    onState(j.state);
  } catch (e) {
    setOnline(false);
  } finally {
    pollTimer = setTimeout(poll, document.hidden ? 6000 : POLL_MS);
  }
}

function setOnline(v) {
  if (app.online === v) return;
  app.online = v;
  const el = $('#net');
  if (el) { el.className = 'net ' + (v ? 'on' : 'off'); el.textContent = v ? '' : 'нет связи'; }
}

function onState(st) {
  if (!st) return;
  if (app.state && st.v < app.state.v) return;
  const prev = app.state;
  app.state = st;
  const key = st.dataV + '|' + (st.screen === 'results' ? 'r' + st.showAnswers : '');
  if (key !== app.dataKey || Date.now() - app.dataAt > 30000) loadData(key);
  if (isAdmin() && (!prev || prev.dataV !== st.dataV || Date.now() - app.adminAt > 10000)) loadAdmin();
  if (prev && prev.screen !== st.screen && !isAdmin()) { sound.chime(); app.tab = 'now'; }
  renderAlarm();
  renderView();
}

let dataLoading = false;
async function loadData(key) {
  if (dataLoading) return;
  dataLoading = true;
  try {
    const j = await apiGet({ a: 'data' });
    app.dataAt = Date.now();
    app.dataKey = key || app.dataKey;
    const raw = JSON.stringify(j.data);
    if (raw !== app.dataRaw) { app.dataRaw = raw; app.data = j.data; renderView(); }
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
  app.viewKey = '';
  if (!API) { root.innerHTML = viewNoApi(); return; }
  if (!app.role) { root.innerHTML = viewLogin(); if (!app.data) loadData(); return; }
  if (!app.started) { root.innerHTML = viewStart(); return; }
  root.innerHTML = isAdmin() ? shellAdmin() : shellGuest();
  renderAlarm();
  renderView(true);
}

function renderView(force) {
  if (!app.started || !app.role) {
    if (!app.role && app.data && $('#login-teams')) $('#app').innerHTML = viewLogin();
    return;
  }
  const st = app.state ? Object.assign({}, app.state, { v: 0, alarm: null }) : null;
  const key = JSON.stringify([app.tab, app.adminTab, st, app.dataRaw.length, app.dataRaw, isAdmin() ? app.adminRaw : '', iqLocal()]);
  if (!force && key === app.viewKey) return;
  app.viewKey = key;
  const html = isAdmin() ? viewAdmin() : viewGuest();
  paint($('#main'), html);
  const hdr = $('#hdr-now');
  if (hdr) hdr.innerHTML = headerNow();
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === app.tab));
  document.querySelectorAll('[data-atab]').forEach(b => b.classList.toggle('on', b.dataset.atab === app.adminTab));
  afterPaint();
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

function afterPaint() {
  const qr = $('#qr');
  if (qr && window.QRCode && qr.dataset.url) {
    qr.innerHTML = '';
    new QRCode(qr, { text: qr.dataset.url, width: 220, height: 220, colorDark: '#140b24', colorLight: '#ffffff' });
  }
  iqTick();
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

function viewStart() {
  const who = isAdmin() ? 'Пульт именинников' : app.role.type === 'team' ? app.role.team : 'Экран';
  return `<div class="center-page start" data-act="start">
    <div class="big-emoji">🎉</div>
    <h1>${esc(who)}</h1>
    <p>Нажмите в любом месте, чтобы начать</p>
    <p class="muted small">Это включит звук уведомлений и не даст экрану погаснуть</p>
  </div>`;
}

function shellGuest() {
  return `<header class="top">
      <div class="brand">🎂 <b>${esc(app.role.type === 'team' ? app.role.team : 'Экран')}</b></div>
      <div id="hdr-now" class="hdr-now"></div>
      <nav class="tabs"><button data-tab="now">Сейчас</button><button data-tab="plan">План</button></nav>
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
  switch (app.state.screen) {
    case 'facts': return viewFacts(false);
    case 'iq': return viewIq();
    case 'items': return viewRoomForm('items');
    case 'words': return viewRoomForm('words');
    case 'results': return viewResults(app.state.results);
    case 'sigame': return viewSigame();
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
  const done = (app.data.iqDone || {})[team];
  let loc = iqLocal();
  // Пульт сбросил попытку группы — начинаем с чистого листа.
  if (loc && loc.phase === 'done' && !done && app.data.dataV >= (loc.dataV || 0)) { store.del(iqKey()); loc = null; }
  if (done && (!loc || loc.phase !== 'test')) {
    return `<section class="card narrow center">
      <div class="big-emoji">🧠</div>
      <div class="muted">${esc(team)} прошла тест</div>
      <div class="score-big">${done.score} <span>из ${done.max}</span></div>
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

// ----- Комнаты: предметы и 4 слова -----

function viewRoomForm(game) {
  const team = myTeam();
  const n = app.data.rooms[game];
  const title = game === 'items' ? '🔎 Врать или не врать' : '🧩 4 слова';
  const hint = game === 'items' ? 'Какой уникальный предмет был в каждой комнате?' : 'Составьте верное предложение для каждой комнаты';
  if (!team) return `<section class="hero"><h1 class="hero-title">${title}</h1><p class="muted">${hint}</p></section>`;
  const open = app.state[game].open;
  const sub = (app.data.submitted[team] || {})[game] || {};
  const sentAt = store.get(`sent_${team}_${game}`, '');
  const rows = [];
  for (let r = 1; r <= n; r++) {
    const id = `ans-${game}-${r}`;
    rows.push(`<label class="room-row"><span class="room-n">${r} комната —</span>
      ${game === 'items'
        ? `<input id="${id}" data-draft value="${esc(sub[r] || '')}" placeholder="предмет" ${open ? '' : 'disabled'} autocomplete="off">`
        : `<textarea id="${id}" data-draft rows="2" placeholder="предложение" ${open ? '' : 'disabled'}>${esc(sub[r] || '')}</textarea>`}
      ${sub[r] ? '<span class="sent-mark" title="Отправлено">✓</span>' : ''}</label>`);
  }
  return `<section class="card narrow">
    <h1>${title}</h1>
    <p class="muted">${hint}</p>
    <div class="rooms">${rows.join('')}</div>
    ${open
      ? `<button class="btn big" data-act="roomSubmit" data-game="${game}" ${app.busy[game] ? 'disabled' : ''}>${app.busy[game] ? 'Отправляем…' : 'Отправить ответы'}</button>
         ${sentAt ? `<p class="muted center small">✓ Отправлено в ${esc(sentAt)}. Можно исправить и отправить ещё раз, пока приём открыт.</p>` : ''}`
      : `<p class="notice">Приём ответов закрыт</p>`}
  </section>`;
}

// ----- Результаты -----

function viewResults(which) {
  const r = app.data.results;
  if (!r) return `<div class="loading">Считаем результаты…</div>`;
  if (which === 'iq') return viewIqRating(r.iq);
  return viewGameResults(which, r[which]);
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

function viewGameResults(game, res, adminMode) {
  if (!res) return '';
  const head = [];
  for (let i = 1; i <= res.rooms; i++) head.push(`<th>${i} комн.</th>`);
  return `<section class="card wide">
    ${adminMode ? '' : `<h1>${game === 'items' ? '🔎' : '🧩'} ${esc(GAME_TITLES[game])}</h1>`}
    <ol class="rating">${res.teams.map((t, i) => `<li><span class="place">${t.score ? MEDALS[i] || i + 1 : i + 1}</span>
      <span class="who"><b>${esc(t.team)}</b></span><span class="pts">${t.score}<span class="muted">/${res.rooms}</span></span></li>`).join('')}</ol>
    <div class="table-wrap"><table class="res-table">
      <thead><tr><th></th>${head.join('')}</tr></thead>
      <tbody>
        ${res.teams.map(t => `<tr><th>${esc(t.team)}</th>${t.rooms.map(c => adminMode
          ? `<td class="vcell ${c.ok === true ? 'is-ok' : c.ok === false ? 'is-bad' : ''}" data-act="cycleVerdict" data-game="${game}" data-team="${esc(t.team)}" data-room="${c.room}" data-ok="${c.ok}" data-manual="${c.manual}">
              ${verdictIcon(c.ok)} ${esc(c.answer) || '<span class="muted">—</span>'}${c.manual ? '<sup title="Проверено вручную">✎</sup>' : ''}</td>`
          : `<td class="${c.ok === true ? 'is-ok' : c.ok === false ? 'is-bad' : ''}">${verdictIcon(c.ok)} ${esc(c.answer) || '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}
        ${res.correct && !adminMode ? `<tr class="correct-row"><th>Правильно</th>${res.correct.map(c => `<td>${esc(c)}</td>`).join('')}</tr>` : ''}
      </tbody>
    </table></div>
  </section>`;
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

// ===================== Пульт именинников =====================

const ADMIN_TABS = [
  ['control', '🎛 Пульт'], ['plan', '🗓 План'], ['facts', '🃏 Факты'], ['iq', '🧠 IQ-тест'],
  ['items', '🔎 Предметы'], ['words', '🧩 4 слова'], ['sigame', '🎯 Своя игра'],
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
        <div class="alarm-box">
          <input id="alarm-msg" data-draft placeholder="Где сбор? (необязательно)" autocomplete="off">
          <button class="btn red big" data-act="alarmOn">📢 СБОР</button>
          <button class="btn ghost" data-act="alarmOff">Отбой</button>
          <div id="alarm-status" class="small"></div>
        </div>
        <nav class="side-nav">${ADMIN_TABS.map(([k, t]) => `<button data-atab="${k}">${t}</button>`).join('')}</nav>
      </aside>
      <main id="main" class="main admin-main"></main>
    </div>`;
}

function viewAdmin() {
  const st = app.state;
  const a = app.admin;
  const s = $('#alarm-status');
  if (s && st) s.innerHTML = st.alarm.on ? `<span class="bad blink">● Сбор объявлен${st.alarm.msg ? ': ' + esc(st.alarm.msg) : ''}</span>` : '<span class="muted">Сбора нет</span>';
  if (!st || !a || !app.data) return `<div class="loading">Загрузка…</div>`;
  const nowBar = `<div class="now-bar">На планшетах: <b>${esc(SCREEN_TITLES[st.screen] || st.screen)}${st.screen === 'results' ? ' — ' + esc(GAME_TITLES[st.results]) : ''}</b></div>`;
  switch (app.adminTab) {
    case 'plan': return nowBar + adminPlan();
    case 'facts': return nowBar + adminFacts();
    case 'iq': return nowBar + adminIq();
    case 'items': return nowBar + adminGame('items');
    case 'words': return nowBar + adminGame('words');
    case 'sigame': return nowBar + adminSigame();
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
        ${screenBtn('items', '🔎 Предметы')}
        ${screenBtn('words', '🧩 4 слова')}
        ${screenBtn('results', '🏆 Рейтинг IQ', 'data-results="iq"')}
        ${screenBtn('results', '🏆 Итоги: предметы', 'data-results="items"')}
        ${screenBtn('results', '🏆 Итоги: 4 слова', 'data-results="words"')}
        ${screenBtn('sigame', '🎯 Своя игра')}
      </div>
    </section>
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
          <select id="turn-who"><option value="">— выберите —</option>${peopleOptions(f.turn)}</select>
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

function adminGame(game) {
  const st = app.state;
  const res = app.admin[game];
  const correctInputs = [];
  for (let r = 1; r <= res.rooms; r++) {
    const id = `cor-${game}-${r}`;
    correctInputs.push(`<label class="room-row"><span class="room-n">${r} комната</span>
      <input id="${id}" data-draft data-change="setCorrect" data-game="${game}" data-room="${r}" value="${esc(res.correct[r - 1])}" placeholder="пока не известно" autocomplete="off"></label>`);
  }
  return `<div class="cards-grid">
    <section class="card">
      <h2>${esc(GAME_TITLES[game])}</h2>
      <div class="row">
        ${screenBtn(game, st.screen === game ? 'Форма на планшетах' : '▶ Показать форму на планшетах')}
        <button class="btn ${st[game].open ? 'red' : 'green'}" data-act="setOpen" data-game="${game}" data-open="${st[game].open ? 0 : 1}">${st[game].open ? 'Закрыть приём ответов' : 'Открыть приём ответов'}</button>
      </div>
      <div class="row">
        ${screenBtn('results', '🏆 Показать итоги', `data-results="${game}"`)}
        <label class="check"><input type="checkbox" data-act="showAnswers" ${st.showAnswers ? 'checked' : ''}> показывать правильные ответы в итогах</label>
      </div>
      <h3>Правильные ответы</h3>
      <p class="muted small">Сохраняются при выходе из поля. Несколько вариантов — через «/». ${game === 'items' ? 'Засчитывается, если ответ содержит правильное слово.' : 'Сравнивается без учёта регистра и знаков препинания.'}</p>
      <div class="rooms">${correctInputs.join('')}</div>
    </section>
    <section class="card span2">
      <h2>Ответы команд</h2>
      <p class="muted small">Нажмите на ячейку, чтобы засчитать/не засчитать вручную: авто → ✓ → ✗ → авто.</p>
      ${viewGameResults(game, res, true)}
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

// ===================== Сбор (тревога) =====================

function renderAlarm() {
  const el = $('#alarm');
  const al = app.state && app.state.alarm;
  const show = app.started && !isAdmin() && al && al.on && store.get('alarmSeen', 0) !== al.id;
  if (!show) {
    if (!el.hidden) { el.hidden = true; el.innerHTML = ''; }
    sound.stopSiren();
    return;
  }
  if (el.hidden || el.dataset.id !== String(al.id)) {
    el.dataset.id = al.id;
    el.innerHTML = `<div class="alarm-word">СБОР</div>${al.msg ? `<div class="alarm-msg">${esc(al.msg)}</div>` : ''}
      <button class="btn big alarm-ok" data-act="alarmSeen">Иду! 🏃</button>`;
    el.hidden = false;
    sound.startSiren();
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
  }
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
    sound.unlock();
    keepAwake();
    try { if (!isAdmin() && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); } catch (e) {}
    app.started = true;
    render();
    poll();
  },
  logout() {
    if (!isAdmin() && !confirm('Сменить устройство? (Команда / экран / пульт)')) return;
    logout();
  },
  alarmSeen() { store.set('alarmSeen', app.state.alarm.id); renderAlarm(); },

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
  async roomSubmit(el) {
    const game = el.dataset.game;
    const team = myTeam();
    const answers = {};
    for (let r = 1; r <= app.data.rooms[game]; r++) {
      const inp = document.getElementById(`ans-${game}-${r}`);
      answers[r] = inp ? inp.value.trim() : '';
    }
    app.busy[game] = true;
    renderView(true);
    try {
      const j = await apiPost({ a: 'roomSubmit', team, game, answers });
      store.set(`sent_${team}_${game}`, j.time);
      toast('Ответы отправлены ✓', 'ok');
      onState(j.state);
    } catch (e) { toast(e.message, 'err'); }
    finally { app.busy[game] = false; renderView(true); }
  },

  // --- пульт ---
  alarmOn() { act('alarm', { on: true, msg: ($('#alarm-msg') || {}).value || '' }); },
  alarmOff() { act('alarm', { on: false }); },
  setScreen(el) { act('setScreen', { screen: el.dataset.screen, results: el.dataset.results }); },
  planCurrent(el) { act('planCurrent', { i: Number(el.dataset.i) }); },
  refresh() { act('refresh').then(() => toast('Данные перечитаны', 'ok')); },
  iqReset(el) { if (confirm(`Удалить результат «${el.dataset.team}» и дать группе пройти тест заново?`)) act('iqReset', { team: el.dataset.team }); },
  setOpen(el) { act('setOpen', { game: el.dataset.game, open: el.dataset.open === '1' }); },
  showAnswers(el) { act('showAnswers', { on: el.checked }); },
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
  factDelete(el) { if (confirm('Удалить факт?')) act('factDelete', { id: Number(el.dataset.id) }); },
  cycleVerdict(el) {
    const ok = el.dataset.ok;
    const manual = el.dataset.manual === 'true';
    const next = !manual ? true : ok === 'true' ? false : null;
    act('setVerdict', { game: el.dataset.game, team: el.dataset.team, room: Number(el.dataset.room), verdict: next });
  },
};

const CHANGES = {
  async setCorrect(el) {
    await act('setCorrect', { game: el.dataset.game, room: Number(el.dataset.room), value: el.value.trim() });
    delete drafts[el.id];
    toast('Сохранено', 'ok');
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

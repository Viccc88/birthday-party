/**
 * Бэкенд сайта дня рождения. Живёт внутри Google-таблицы.
 *
 * Установка: Расширения → Apps Script → вставить этот файл целиком →
 * Развернуть → Новое развертывание → Веб-приложение
 * (Выполнять от: «Меня», Доступ: «Все») → скопировать URL в js/config.js.
 */

// ← PIN для пульта именинников. Поменяйте в своей копии скрипта.
const ADMIN_PIN = '0000';

const SH = {
  groups: 'Группы',
  plan: 'План',
  rooms: '4 комнаты',
  settings: 'Настройки',
  facts: 'Факты',
  iqQ: 'IQ вопросы',
  iqR: 'IQ результаты',
  answers: 'Ответы команд',
  correct: 'Правильные ответы',
  state: '_state',
};
const BIRTHDAY_TEAM = 'Именинники';
const GAMES = { items: 'Предметы', words: '4 слова' };
const SCREENS = ['plan', 'facts', 'iq', 'items', 'words', 'results', 'sigame'];

// Вопросы IQ-теста уровня 11 класса (можно править прямо в листе «IQ вопросы»).
// Колонки: №, вопрос, варианты A–D, правильная буква, баллы.
const IQ_SEED = [
  [1, 'Продолжите ряд: 2, 3, 5, 9, 17, …', '25', '31', '33', '34', 'C', 1],
  [2, 'Чему равно log₂8 + log₃81?', '12', '24', '7', '5', 'C', 1],
  [3, 'Какое число лишнее: 17, 23, 29, 39?', '17', '23', '29', '39', 'D', 1],
  [4, 'Интеграл относится к производной, как умножение к …', 'делению', 'сложению', 'вычитанию', 'возведению в степень', 'A', 1],
  [5, 'Сколькими способами можно рассадить 5 человек на 5 стульев в ряд?', '120', '25', '60', '3125', 'A', 1],
  [6, 'Продолжите ряд: 1, 4, 27, 256, …', '1024', '3125', '4096', '625', 'B', 2],
  [7, 'Сколько диагоналей у выпуклого десятиугольника?', '20', '45', '70', '35', 'D', 2],
  [8, 'Монету бросают 3 раза. Какова вероятность, что орёл выпадет хотя бы один раз?', '1/2', '3/4', '2/3', '7/8', 'D', 2],
  [9, 'Некоторые А являются Б, а все Б являются В. Что обязательно верно?', 'Все А являются В', 'Некоторые А являются В', 'Ни одно А не является В', 'Все В являются А', 'B', 2],
  [10, 'Позавчера был день, который наступает за 3 дня до воскресенья. Какой день сегодня?', 'Пятница', 'Суббота', 'Воскресенье', 'Понедельник', 'B', 2],
  [11, 'Найдите наименьшее значение функции f(x) = x² − 6x + 5', '−5', '5', '−4', '3', 'C', 2],
  [12, 'Часы показывают 3:15. Какой угол между часовой и минутной стрелками?', '0°', '7,5°', '15°', '22,5°', 'B', 3],
  [13, 'Поезд проезжает мимо столба за 10 секунд, а по мосту длиной 400 м — за 30 секунд. Какова длина поезда?', '100 м', '150 м', '200 м', '400 м', 'C', 3],
  [14, 'Какой последней цифрой оканчивается число 7²⁰²⁶?', '1', '3', '7', '9', 'D', 3],
  [15, 'Деревянный куб 3×3×3 покрасили снаружи и распилили на 27 кубиков. Сколько кубиков окрашено ровно с двух сторон?', '6', '8', '12', '24', 'C', 3],
];
const IQ_MINUTES = 10;

// ===================== HTTP =====================

function doGet(e) { return respond_(e && e.parameter || {}, null); }

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return respond_(e && e.parameter || {}, body);
}

function respond_(params, body) {
  let out;
  try {
    out = route_(params, body);
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function route_(p, b) {
  b = b || {};
  const a = b.a || p.a;
  if (a === 'state') {
    if (p.d) cache_().put('seen_' + p.d, String(Date.now()), 600);
    return { ok: true, state: getState_() };
  }
  if (a === 'data') return { ok: true, data: getPublicData_() };
  if (a === 'login') { checkPin_(b.pin || p.pin); return { ok: true }; }
  if (a === 'admin') { checkPin_(p.pin); return { ok: true, data: getAdminData_(), state: getState_() }; }
  if (TEAM_ACTIONS[a]) return TEAM_ACTIONS[a](b);
  if (ADMIN_ACTIONS[a]) { checkPin_(b.pin); return ADMIN_ACTIONS[a](b); }
  throw new Error('Неизвестное действие: ' + a);
}

function checkPin_(pin) {
  if (String(pin || '') !== String(ADMIN_PIN)) throw new Error('Неверный PIN');
}

// ===================== Меню таблицы =====================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🎂 ДР')
    .addItem('Создать служебные листы', 'setup')
    .addItem('Загрузить вопросы IQ (11 класс)', 'loadIqQuestions')
    .addItem('Сбросить состояние сайта', 'resetState')
    .addToUi();
}

// Любая ручная правка таблицы — сигнал сайту перечитать данные.
function onEdit(e) {
  try {
    if (e && e.range && e.range.getSheet().getName() === SH.state) return;
    mutate_(st => { st.dataV++; });
  } catch (err) {}
}

function setup() { ensureSheets_(true); }

// Заменяет вопросы в листе «IQ вопросы» на IQ_SEED и ставит время на тест.
function loadIqQuestions() {
  ensureSheets_(true);
  const sh = ss_().getSheetByName(SH.iqQ);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 8).clearContent();
  sh.getRange(2, 1, IQ_SEED.length, 8).setValues(IQ_SEED);
  const set = ss_().getSheetByName(SH.settings);
  const vals = set.getDataRange().getDisplayValues();
  const row = vals.findIndex(r => str_(r[0]) === 'IQ: минут на тест');
  if (row > 0) set.getRange(row + 1, 2).setValue(String(IQ_MINUTES));
  mutate_(st => { st.dataV++; });
}

function resetState() {
  ensureSheets_(true);
  // Счётчики только растут, иначе планшеты сочтут новое состояние устаревшим.
  const old = getState_();
  const st = defaultState_();
  st.v = old.v;
  st.dataV = old.dataV + 1;
  saveState_(st);
}

// ===================== Утилиты =====================

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function cache_() { return CacheService.getScriptCache(); }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function norm_(s) { return str_(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim(); }
function now_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss'); }

function rows_(name) {
  const sh = ss_().getSheetByName(name);
  return sh ? sh.getDataRange().getDisplayValues() : [];
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const res = fn();
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function ensureSheets_(force) {
  if (!force && cache_().get('ensured')) return;
  const ss = ss_();
  const mk = (name, header, rows) => {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    sh.setFrozenRows(1);
  };
  mk(SH.settings, ['Параметр', 'Значение', 'Пояснение'], [
    ['Именинники', 'Илья, Арсений', 'Через запятую. Участвуют в игре с фактами'],
    ['Комнат: предметы', '6', 'Сколько полей «Комната N — предмет» на планшетах'],
    ['Комнат: 4 слова', '6', 'Сколько полей для предложений'],
    ['IQ: минут на тест', String(IQ_MINUTES), '0 — без таймера'],
  ]);
  mk(SH.facts, ['№', 'Факт', 'О ком', 'Открыл', 'Угадал'], []);
  mk(SH.iqQ, ['№', 'Вопрос', 'A', 'B', 'C', 'D', 'Ответ (буква)', 'Баллы'], IQ_SEED);
  mk(SH.iqR, ['Время', 'Команда', 'Участники', 'Баллы', 'Из', 'Ответы', 'ID'], []);
  mk(SH.answers, ['Команда', 'Игра', 'Комната', 'Ответ', 'Время', 'Проверка (+ / -)'], []);
  mk(SH.correct, ['Комната', 'Предмет (врать или не врать)', 'Предложение (4 слова)'],
    [1, 2, 3, 4, 5, 6].map(n => [n, '', '']));
  if (!ss.getSheetByName(SH.state)) {
    const sh = ss.insertSheet(SH.state);
    sh.getRange(1, 1).setValue(JSON.stringify(defaultState_()));
    sh.hideSheet();
  }
  cache_().put('ensured', '1', 21600);
}

// ===================== Состояние (общий «пульт») =====================

function defaultState_() {
  return {
    v: 1,
    dataV: 1,
    screen: 'plan',
    results: 'iq',
    showAnswers: false,
    planCurrent: -1,
    alarm: { on: false, msg: '', id: 0 },
    facts: { order: [], opened: {}, turn: null, current: null, reveal: false, answer: null, taken: [] },
    iq: { open: false },
    items: { open: false },
    words: { open: false },
    sigame: '',
  };
}

function getState_() {
  const hit = cache_().get('state');
  if (hit) return JSON.parse(hit);
  let saved = null;
  const sh = ss_().getSheetByName(SH.state);
  if (sh) { try { saved = JSON.parse(sh.getRange(1, 1).getValue()); } catch (e) {} }
  const st = Object.assign(defaultState_(), saved || {});
  cache_().put('state', JSON.stringify(st), 21600);
  return st;
}

function saveState_(st) {
  st.v = (st.v || 0) + 1;
  const json = JSON.stringify(st);
  let sh = ss_().getSheetByName(SH.state);
  if (!sh) { sh = ss_().insertSheet(SH.state); sh.hideSheet(); }
  sh.getRange(1, 1).setValue(json);
  cache_().put('state', json, 21600);
}

// Изменить состояние под блокировкой и вернуть его клиенту.
function mutate_(fn) {
  return withLock_(() => {
    const st = getState_();
    const extra = fn(st) || {};
    saveState_(st);
    return Object.assign({ ok: true, state: st }, extra);
  });
}

// ===================== Чтение таблицы =====================

function readSettings_() {
  const map = {};
  rows_(SH.settings).slice(1).forEach(r => { if (str_(r[0])) map[str_(r[0])] = str_(r[1]); });
  const num = (k, d) => { const n = parseInt(map[k], 10); return isNaN(n) ? d : n; };
  return {
    birthday: (map['Именинники'] || '').split(',').map(str_).filter(Boolean),
    itemsRooms: num('Комнат: предметы', 6),
    wordsRooms: num('Комнат: 4 слова', 6),
    iqMinutes: num('IQ: минут на тест', 7),
  };
}

// Команды из листа «Группы» + именинники. label уникален даже для тёзок.
function readTeams_(settings) {
  const teams = [];
  const byName = {};
  rows_(SH.groups).slice(1).forEach(r => {
    const team = str_(r[0]);
    const name = str_(r[2]);
    if (!team || !name) return;
    if (!byName[team]) { byName[team] = { name: team, members: [] }; teams.push(byName[team]); }
    byName[team].members.push({ name: name });
  });
  if (settings.birthday.length) {
    teams.push({ name: BIRTHDAY_TEAM, birthday: true, members: settings.birthday.map(n => ({ name: n })) });
  }
  const count = {};
  teams.forEach(t => t.members.forEach(m => { count[m.name] = (count[m.name] || 0) + 1; }));
  teams.forEach(t => t.members.forEach(m => { m.label = count[m.name] > 1 ? m.name + ' (' + t.name + ')' : m.name; }));
  return teams;
}

function readPlan_() {
  return rows_(SH.plan).slice(1)
    .map(r => ({ time: str_(r[0]), event: str_(r[1]) }))
    .filter(x => x.time || x.event);
}

function readFacts_() {
  const sh = ss_().getSheetByName(SH.facts);
  if (!sh) return [];
  const vals = sh.getDataRange().getDisplayValues();
  let max = 0;
  vals.slice(1).forEach(r => { max = Math.max(max, parseInt(r[0], 10) || 0); });
  const facts = [];
  vals.slice(1).forEach((r, i) => {
    if (!str_(r[1])) return;
    let id = parseInt(r[0], 10);
    if (!id) { id = ++max; sh.getRange(i + 2, 1).setValue(id); }
    facts.push({ id: id, row: i + 2, text: str_(r[1]), who: str_(r[2]) });
  });
  return facts;
}

function readIqQuestions_() {
  return rows_(SH.iqQ).slice(1)
    .filter(r => str_(r[1]))
    .map((r, i) => ({
      id: str_(r[0]) || String(i + 1),
      q: str_(r[1]),
      opts: ['A', 'B', 'C', 'D'].map((L, k) => [L, str_(r[2 + k])]).filter(o => o[1]),
      ans: str_(r[6]).toUpperCase(),
      pts: parseInt(r[7], 10) || 1,
    }));
}

function readIqResults_() {
  return rows_(SH.iqR).slice(1).filter(r => str_(r[1])).map(r => ({
    time: str_(r[0]), team: str_(r[1]), people: str_(r[2]),
    score: Number(r[3]) || 0, max: Number(r[4]) || 0, id: str_(r[6]),
  }));
}

function readAnswers_() {
  const gameKey = {};
  Object.keys(GAMES).forEach(k => { gameKey[GAMES[k]] = k; });
  return rows_(SH.answers).slice(1).filter(r => str_(r[0])).map((r, i) => ({
    row: i + 2, team: str_(r[0]), game: gameKey[str_(r[1])] || str_(r[1]),
    room: parseInt(r[2], 10) || 0, answer: str_(r[3]), time: str_(r[4]), check: str_(r[5]),
  }));
}

function readCorrect_() {
  const out = { items: {}, words: {} };
  rows_(SH.correct).slice(1).forEach(r => {
    const room = parseInt(r[0], 10);
    if (!room) return;
    out.items[room] = str_(r[1]);
    out.words[room] = str_(r[2]);
  });
  return out;
}

// ===================== Проверка ответов =====================

function parseCheck_(s) {
  const v = norm_(s);
  if (str_(s) === '+' || ['да', '1', 'верно', 'true', 'ок'].indexOf(v) >= 0) return true;
  if (str_(s) === '-' || ['нет', '0', 'неверно', 'false'].indexOf(v) >= 0) return false;
  return null;
}

// Правильных вариантов может быть несколько через «/» или «;».
function autoCheck_(game, answer, correct) {
  const variants = str_(correct).split(/[\/;|]/).map(norm_).filter(Boolean);
  if (!variants.length) return null;
  const a = norm_(answer);
  if (!a) return false;
  return variants.some(v => {
    if (a === v) return true;
    if (game !== 'items') return false;
    return (' ' + a + ' ').indexOf(' ' + v + ' ') >= 0;
  });
}

function computeGame_(game, teams, settings, answers, correct, withCorrect) {
  const n = game === 'items' ? settings.itemsRooms : settings.wordsRooms;
  const rows = teams.filter(t => !t.birthday).map(t => {
    const rooms = [];
    let score = 0;
    for (let room = 1; room <= n; room++) {
      const a = answers.filter(x => x.team === t.name && x.game === game && x.room === room)[0];
      const manual = a ? parseCheck_(a.check) : null;
      const ok = manual !== null ? manual : autoCheck_(game, a ? a.answer : '', correct[game][room]);
      if (ok) score++;
      rooms.push({ room: room, answer: a ? a.answer : '', ok: ok, manual: manual !== null });
    }
    return { team: t.name, score: score, rooms: rooms };
  });
  rows.sort((x, y) => y.score - x.score);
  const out = { rooms: n, teams: rows };
  if (withCorrect) {
    out.correct = [];
    for (let room = 1; room <= n; room++) out.correct.push(correct[game][room] || '');
  }
  return out;
}

function iqRating_() {
  return readIqResults_().sort((x, y) => (y.score - x.score) || (x.time < y.time ? -1 : 1));
}

// ===================== Данные для устройств =====================

function getPublicData_() {
  ensureSheets_();
  const st = getState_();
  const showResults = st.screen === 'results';
  const key = 'data_' + st.dataV + (showResults ? '_r' + (st.showAnswers ? 'a' : '') : '');
  const hit = cache_().get(key);
  if (hit) return JSON.parse(hit);

  const settings = readSettings_();
  const teams = readTeams_(settings);
  const answers = readAnswers_();
  const submitted = {};
  answers.forEach(a => {
    submitted[a.team] = submitted[a.team] || { items: {}, words: {} };
    if (submitted[a.team][a.game]) submitted[a.team][a.game][a.room] = a.answer;
  });
  const data = {
    dataV: st.dataV,
    teams: teams,
    plan: readPlan_(),
    facts: readFacts_().map(f => ({ id: f.id, text: f.text })),
    iq: {
      minutes: settings.iqMinutes,
      questions: readIqQuestions_().map(q => ({ id: q.id, q: q.q, opts: q.opts, pts: q.pts })),
    },
    rooms: { items: settings.itemsRooms, words: settings.wordsRooms },
    submitted: submitted,
  };
  if (showResults) {
    const correct = readCorrect_();
    data.results = {
      iq: iqRating_(),
      items: computeGame_('items', teams, settings, answers, correct, st.showAnswers),
      words: computeGame_('words', teams, settings, answers, correct, st.showAnswers),
    };
  }
  try { cache_().put(key, JSON.stringify(data), 20); } catch (e) {}
  return data;
}

function getAdminData_() {
  ensureSheets_();
  const settings = readSettings_();
  const teams = readTeams_(settings);
  const answers = readAnswers_();
  const correct = readCorrect_();
  const devices = teams.filter(t => !t.birthday).map(t => t.name).concat(['Экран', 'Пульт']);
  const seenRaw = cache_().getAll(devices.map(d => 'seen_' + d));
  const seen = {};
  devices.forEach(d => { seen[d] = Number(seenRaw['seen_' + d]) || 0; });
  return {
    now: Date.now(),
    settings: settings,
    teams: teams,
    plan: readPlan_(),
    facts: readFacts_().map(f => ({ id: f.id, text: f.text, who: f.who })),
    iqQuestions: readIqQuestions_().length,
    iq: iqRating_(),
    items: computeGame_('items', teams, settings, answers, correct, true),
    words: computeGame_('words', teams, settings, answers, correct, true),
    seen: seen,
  };
}

// ===================== Действия команд (планшеты) =====================

const TEAM_ACTIONS = {
  // Гость открывает ячейку с фактом.
  factOpen(b) {
    let fact = null;
    const res = mutate_(st => {
      const f = st.facts;
      const id = Number(b.id);
      if (!f.turn) throw new Error('Сейчас никто не открывает');
      if (f.current) throw new Error('Факт уже открыт');
      if (f.opened[id]) throw new Error('Эта ячейка уже открыта');
      fact = readFacts_().filter(x => x.id === id)[0];
      if (!fact) throw new Error('Нет такого факта');
      f.current = id;
      f.reveal = false;
      f.answer = null;
      f.opened[id] = { by: f.turn };
    });
    ss_().getSheetByName(SH.facts).getRange(fact.row, 4).setValue(res.state.facts.turn);
    return res;
  },

  iqSubmit(b) {
    if (!b.team) throw new Error('Не указана команда');
    return withLock_(() => {
      const results = readIqResults_();
      const dup = results.filter(r => r.id && r.id === b.attemptId)[0];
      if (dup) return { ok: true, score: dup.score, max: dup.max, state: getState_() };

      const qs = readIqQuestions_();
      const answers = b.answers || {};
      let score = 0;
      let max = 0;
      qs.forEach(q => {
        max += q.pts;
        if (q.ans && String(answers[q.id] || '').toUpperCase() === q.ans) score += q.pts;
      });
      const names = (b.names || []).map(str_).filter(Boolean);
      ss_().getSheetByName(SH.iqR).appendRow([
        now_(), b.team, names.join(', '), score, max, JSON.stringify(answers), b.attemptId || '',
      ]);
      writePersonScores_(b.team, names, score);
      const st = getState_();
      st.dataV++;
      saveState_(st);
      return { ok: true, score: score, max: max, state: st };
    });
  },

  // Ответы команды по комнатам: { team, game: 'items'|'words', answers: { 1: '…', 2: '…' } }
  roomSubmit(b) {
    const game = b.game;
    if (!GAMES[game]) throw new Error('Неизвестная игра');
    if (!b.team) throw new Error('Не указана команда');
    return withLock_(() => {
      const st = getState_();
      if (!st[game].open) throw new Error('Приём ответов закрыт');
      const sh = ss_().getSheetByName(SH.answers);
      const existing = readAnswers_();
      const time = now_();
      Object.keys(b.answers || {}).forEach(k => {
        const room = parseInt(k, 10);
        const text = str_(b.answers[k]);
        if (!room) return;
        const row = existing.filter(x => x.team === b.team && x.game === game && x.room === room)[0];
        if (row) {
          if (row.answer === text) return;
          sh.getRange(row.row, 4, 1, 3).setValues([[text, time, '']]);
        } else if (text) {
          sh.appendRow([b.team, GAMES[game], room, text, time, '']);
        }
      });
      st.dataV++;
      saveState_(st);
      return { ok: true, state: st, time: time };
    });
  },
};

// Баллы IQ каждому участнику в лист «4 комнаты», колонка «Айкью тест».
function writePersonScores_(team, names, score) {
  const sh = ss_().getSheetByName(SH.rooms);
  if (!sh || !names.length) return;
  const vals = sh.getDataRange().getDisplayValues();
  const col = vals[0].findIndex(h => norm_(h).indexOf('айкью') >= 0 || norm_(h).indexOf('iq') >= 0);
  if (col < 0) return;
  vals.forEach((r, i) => {
    if (i > 0 && str_(r[0]) === team && names.indexOf(str_(r[2])) >= 0) sh.getRange(i + 1, col + 1).setValue(score);
  });
}

// ===================== Действия пульта (именинники) =====================

const ADMIN_ACTIONS = {
  setScreen(b) {
    if (SCREENS.indexOf(b.screen) < 0) throw new Error('Неизвестный экран');
    return mutate_(st => {
      st.screen = b.screen;
      if (b.results) st.results = b.results;
      if (b.screen === 'iq') st.iq.open = true;
      if (b.screen === 'items') st.items.open = true;
      if (b.screen === 'words') st.words.open = true;
      if (b.screen === 'facts' && !st.facts.order.length) st.facts.order = shuffle_(readFacts_().map(f => f.id));
    });
  },

  alarm(b) {
    return mutate_(st => { st.alarm = { on: !!b.on, msg: str_(b.msg), id: b.on ? Date.now() : st.alarm.id }; });
  },

  planCurrent(b) { return mutate_(st => { st.planCurrent = Number(b.i); }); },

  setOpen(b) {
    if (['iq', 'items', 'words'].indexOf(b.game) < 0) throw new Error('Неизвестная игра');
    return mutate_(st => { st[b.game].open = !!b.open; });
  },

  showAnswers(b) { return mutate_(st => { st.showAnswers = !!b.on; }); },

  setLink(b) { return mutate_(st => { st.sigame = str_(b.url); }); },

  refresh() { return mutate_(st => { st.dataV++; }); },

  // --- Факты ---
  factAdd(b) {
    const text = str_(b.text);
    if (!text) throw new Error('Пустой факт');
    return mutate_(st => {
      const sh = ss_().getSheetByName(SH.facts);
      const max = readFacts_().reduce((m, f) => Math.max(m, f.id), 0);
      sh.appendRow([max + 1, text, str_(b.who), '', '']);
      if (st.facts.order.length) st.facts.order.push(max + 1);
      st.dataV++;
    });
  },

  factDelete(b) {
    return mutate_(st => {
      const f = readFacts_().filter(x => x.id === Number(b.id))[0];
      if (f) ss_().getSheetByName(SH.facts).deleteRow(f.row);
      st.facts.order = st.facts.order.filter(id => id !== Number(b.id));
      delete st.facts.opened[b.id];
      if (st.facts.current === Number(b.id)) st.facts.current = null;
      st.dataV++;
    });
  },

  factsShuffle() {
    return mutate_(st => { st.facts.order = shuffle_(readFacts_().map(f => f.id)); });
  },

  factsReset() {
    return mutate_(st => {
      const facts = readFacts_();
      const sh = ss_().getSheetByName(SH.facts);
      facts.forEach(f => sh.getRange(f.row, 4, 1, 2).setValues([['', '']]));
      st.facts = defaultState_().facts;
      st.facts.order = shuffle_(facts.map(f => f.id));
      st.dataV++;
    });
  },

  // Кто открывает следующую ячейку (null — никто).
  factsTurn(b) {
    return mutate_(st => {
      const f = st.facts;
      f.turn = b.who ? str_(b.who) : null;
      f.current = null;
      f.reveal = false;
      f.answer = null;
      if (f.turn && f.taken.indexOf(f.turn) < 0) f.taken.push(f.turn);
    });
  },

  factsReveal() {
    return mutate_(st => {
      const f = st.facts;
      if (!f.current) throw new Error('Нет открытого факта');
      const fact = readFacts_().filter(x => x.id === f.current)[0];
      f.reveal = true;
      f.answer = fact ? fact.who : '';
      f.opened[f.current].who = f.answer;
    });
  },

  factsMark(b) {
    return mutate_(st => {
      const f = st.facts;
      if (!f.current) throw new Error('Нет открытого факта');
      f.opened[f.current].ok = !!b.ok;
      const fact = readFacts_().filter(x => x.id === f.current)[0];
      if (fact) ss_().getSheetByName(SH.facts).getRange(fact.row, 5).setValue(b.ok ? 'да' : 'нет');
    });
  },

  // --- Проверка ответов команд ---
  setCorrect(b) {
    if (!GAMES[b.game]) throw new Error('Неизвестная игра');
    return mutate_(st => {
      const sh = ss_().getSheetByName(SH.correct);
      const room = parseInt(b.room, 10);
      const col = b.game === 'items' ? 2 : 3;
      const vals = sh.getDataRange().getDisplayValues();
      let row = vals.findIndex((r, i) => i > 0 && parseInt(r[0], 10) === room);
      if (row < 0) { sh.appendRow([room, '', '']); row = sh.getLastRow() - 1; }
      sh.getRange(row + 1, col).setValue(str_(b.value));
      st.dataV++;
    });
  },

  // verdict: true / false / null (авто)
  setVerdict(b) {
    if (!GAMES[b.game]) throw new Error('Неизвестная игра');
    return mutate_(st => {
      const row = readAnswers_().filter(x => x.team === b.team && x.game === b.game && x.room === Number(b.room))[0];
      const mark = b.verdict === true ? '+' : b.verdict === false ? '-' : '';
      if (row) ss_().getSheetByName(SH.answers).getRange(row.row, 6).setValue(mark);
      else if (mark) ss_().getSheetByName(SH.answers).appendRow([b.team, GAMES[b.game], Number(b.room), '', now_(), mark]);
      st.dataV++;
    });
  },
};

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
  scores: 'Баллы',
  challenges: 'Испытания',
  chAnswers: 'Ответы испытаний',
  state: '_state',
};
const BIRTHDAY_TEAM = 'Именинники';
const SCREENS = ['plan', 'facts', 'iq', 'challenge', 'results', 'sigame', 'scores'];
const BUZZER_DISCIPLINE = 'Кнопка «Кто первый»';
// Стартовые дисциплины листа «Баллы» (строки можно менять прямо в таблице).
const CHALLENGE_DISCIPLINE = 'Испытания';
const DISCIPLINES_SEED = ['Знакомство по фактам', 'Мафия / бункер', 'IQ-тест', CHALLENGE_DISCIPLINE, 'Своя игра', 'Ассоциации', BUZZER_DISCIPLINE];

// Испытания для всех групп одновременно (лист «Испытания», правится прямо в таблице).
// Тип: «выбор» (варианты через ;), «текст», «число» (баллы получает самый близкий ответ)
// или «слова» («4 слова»): в «Вариантах» слова групп по порядку (Группа 1;Группа 2;…). Каждая
// группа видит только своё слово, группы по очереди показывают их, а в конце каждая пишет итоговое
// предложение из всех слов. Верное предложение («Правильный ответ», варианты через /) — «Баллы».
const CHALLENGES_SEED = [
  [1, 'Врать или не врать', 'выбор', 'Ведущий рассказывает о предмете. Это правда или ложь?', 'Правда;Ложь', '', 1, 60, CHALLENGE_DISCIPLINE, ''],
  [2, '4 слова', 'слова', 'У каждой группы своё слово. Группы по очереди показывают их, а в конце пишут итоговое предложение из всех слов', 'Жираф;Пылесос;Свадьба;Космос', '', 1, 0, CHALLENGE_DISCIPLINE, ''],
  [3, 'Кейс с деньгами', 'число', 'Сколько денег в кейсе? Баллы получит самый близкий ответ', '', '', 2, 60, CHALLENGE_DISCIPLINE, ''],
];
const CH_TYPES = { 'выбор': 'choice', 'текст': 'text', 'число': 'number', 'слова': 'words' };

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
    return { ok: true, state: getState_(), now: Date.now() };
  }
  if (a === 'data') return { ok: true, data: getPublicData_() };
  if (a === 'word') return { ok: true, word: myWord_(p.team) };
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
  if (!force && cache_().get('ensured3')) return;
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
    ['IQ: минут на тест', String(IQ_MINUTES), '0 — без таймера'],
  ]);
  mk(SH.facts, ['№', 'Факт', 'О ком', 'Открыл', 'Угадал'], []);
  mk(SH.iqQ, ['№', 'Вопрос', 'A', 'B', 'C', 'D', 'Ответ (буква)', 'Баллы'], IQ_SEED);
  mk(SH.iqR, ['Время', 'Команда', 'Участники', 'Баллы', 'Из', 'Ответы', 'ID'], []);
  mk(SH.challenges, ['№', 'Название', 'Тип (выбор / текст / число / слова)', 'Задание', 'Варианты (через ;)', 'Правильный ответ', 'Баллы', 'Секунд (0 — без таймера)', 'Дисциплина', 'Начислено'], CHALLENGES_SEED);
  mk(SH.chAnswers, ['№ испытания', 'Команда', 'Ответ', 'Время', 'Проверка (+ / -)'], []);
  if (!ss.getSheetByName(SH.state)) {
    const sh = ss.insertSheet(SH.state);
    sh.getRange(1, 1).setValue(JSON.stringify(defaultState_()));
    sh.hideSheet();
  }
  if (!ss.getSheetByName(SH.scores)) {
    const teams = readTeams_(readSettings_()).filter(t => !t.birthday).map(t => t.name);
    mk(SH.scores, ['Дисциплина'].concat(teams), DISCIPLINES_SEED.map(d => [d].concat(teams.map(() => ''))));
  }
  cache_().put('ensured3', '1', 21600);
}

// ===================== Состояние (общий «пульт») =====================

function defaultState_() {
  return {
    v: 1,
    dataV: 1,
    screen: 'plan',
    results: 'iq',
    planCurrent: -1,
    alarm: { on: false, msg: '', id: 0 },
    facts: { order: [], opened: {}, turn: null, current: null, reveal: false, answer: null, taken: [] },
    iq: { open: false },
    challenge: { id: 0, phase: 'idle', startedAt: 0, endsAt: 0, presenter: null },
    sigame: '',
    scoresHidden: false,
    buzzer: { id: 0, on: false, discipline: '', points: 1, startAt: 0, presses: {}, firstAt: 0, winner: null, done: false },
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
  return rows_(SH.iqR).slice(1).map((r, i) => ({
    row: i + 2, time: str_(r[0]), team: str_(r[1]), people: str_(r[2]),
    score: Number(r[3]) || 0, max: Number(r[4]) || 0, id: str_(r[6]),
  })).filter(x => x.team);
}

// ===================== Проверка ответов =====================

function parseCheck_(s) {
  const v = norm_(s);
  if (str_(s) === '+' || ['да', '1', 'верно', 'true', 'ок'].indexOf(v) >= 0) return true;
  if (str_(s) === '-' || ['нет', '0', 'неверно', 'false'].indexOf(v) >= 0) return false;
  return null;
}

// ===================== Испытания =====================

function readChallenges_() {
  return rows_(SH.challenges).slice(1).filter(r => str_(r[1])).map((r, i) => {
    let awarded = {};
    try { awarded = JSON.parse(str_(r[9]) || '{}'); } catch (e) {}
    return {
      row: i + 2,
      id: parseInt(r[0], 10) || i + 1,
      name: str_(r[1]),
      type: CH_TYPES[norm_(r[2])] || 'text',
      task: str_(r[3]),
      options: str_(r[4]).split(';').map(str_).filter(Boolean),
      correct: str_(r[5]),
      pts: Number(String(r[6]).replace(',', '.')) || 0,
      seconds: parseInt(r[7], 10) || 0,
      discipline: str_(r[8]) || CHALLENGE_DISCIPLINE,
      awarded: awarded,
    };
  });
}

function readChAnswers_() {
  return rows_(SH.chAnswers).slice(1).filter(r => str_(r[1])).map((r, i) => ({
    row: i + 2, id: parseInt(r[0], 10) || 0, team: str_(r[1]), answer: str_(r[2]), time: str_(r[3]), check: str_(r[4]),
  }));
}

function num_(s) {
  const n = parseFloat(str_(s).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Результат каждой группы в испытании: ручная проверка важнее автоматической.
// Выбор и текст — совпадение с правильным ответом (вариантов может быть несколько через «/»),
// число — баллы у самого близкого ответа (у всех, кто одинаково близко).
function chResults_(ch, answers, teams) {
  const mine = answers.filter(a => a.id === ch.id);
  const variants = ch.correct.split('/').map(norm_).filter(Boolean);
  const target = num_(ch.correct);
  let best = null;
  if (ch.type === 'number' && target !== null) {
    mine.forEach(a => { const n = num_(a.answer); if (n !== null) best = best === null ? Math.abs(n - target) : Math.min(best, Math.abs(n - target)); });
  }
  return teams.filter(t => !t.birthday).map(t => {
    const a = mine.filter(x => x.team === t.name)[0];
    const answer = a ? a.answer : '';
    const manual = a ? parseCheck_(a.check) : null;
    let ok = null;
    if (manual !== null) ok = manual;
    else if (!answer) ok = ch.correct ? false : null;
    else if (ch.type === 'number') {
      const n = num_(answer);
      ok = target === null ? null : n !== null && Math.abs(Math.abs(n - target) - best) < 1e-9;
    } else if (variants.length) ok = variants.indexOf(norm_(answer)) >= 0;
    return { team: t.name, answer: answer, ok: ok, manual: manual !== null, pts: ok ? ch.pts : 0 };
  });
}

// Слово группы в испытании «слова» (по порядку групп в листе «Группы»).
function teamWord_(ch, teams, team) {
  const i = teams.filter(t => !t.birthday).map(t => t.name).indexOf(team);
  return i >= 0 ? ch.options[i] || '' : '';
}

// Текущее испытание для планшетов: без правильного ответа, пока его не показали.
function publicChallenge_(st, teams) {
  const cur = st.challenge;
  if (!cur || !cur.id) return null;
  const ch = readChallenges_().filter(c => c.id === cur.id)[0];
  if (!ch) return null;
  const answers = readChAnswers_();
  const words = ch.type === 'words';
  const out = {
    id: ch.id, name: ch.name, type: ch.type, task: ch.task, options: words ? [] : ch.options, pts: ch.pts,
    phase: cur.phase, endsAt: cur.endsAt, presenter: cur.presenter || null, answers: {},
  };
  answers.filter(a => a.id === ch.id).forEach(a => { out.answers[a.team] = a.answer; });
  if (cur.phase === 'reveal') {
    out.correct = ch.correct;
    out.results = chResults_(ch, answers, teams);
    if (words) out.words = teams.filter(t => !t.birthday).map(t => ({ team: t.name, word: teamWord_(ch, teams, t.name) }));
  }
  return out;
}

function myWord_(team) {
  const cur = getState_().challenge;
  const ch = readChallenges_().filter(c => c.id === cur.id)[0];
  if (!ch || ch.type !== 'words') return '';
  return teamWord_(ch, readTeams_(readSettings_()), team);
}

// Результат IQ-теста каждой группы (одна попытка на группу).
function iqDone_() {
  const out = {};
  readIqResults_().forEach(r => { out[r.team] = { score: r.score, max: r.max }; });
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
  const key = 'data_' + st.dataV + (showResults ? '_r' : '');
  const hit = cache_().get(key);
  if (hit) return JSON.parse(hit);

  const settings = readSettings_();
  const teams = readTeams_(settings);
  const data = {
    dataV: st.dataV,
    teams: teams,
    plan: readPlan_(),
    facts: readFacts_().map(f => ({ id: f.id, text: f.text })),
    iq: {
      minutes: settings.iqMinutes,
      questions: readIqQuestions_().map(q => ({ id: q.id, q: q.q, opts: q.opts, pts: q.pts })),
    },
    challenge: publicChallenge_(st, teams),
    iqDone: iqDone_(),
    scores: st.scoresHidden ? null : readScores_(),
  };
  if (showResults) data.results = { iq: iqRating_() };
  try { cache_().put(key, JSON.stringify(data), 20); } catch (e) {}
  return data;
}

function getAdminData_() {
  ensureSheets_();
  const settings = readSettings_();
  const teams = readTeams_(settings);
  const chAnswers = readChAnswers_();
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
    challenges: readChallenges_().map(ch => Object.assign(ch, { results: chResults_(ch, chAnswers, teams) })),
    seen: seen,
    scores: readScores_(),
  };
}

// ===================== Действия команд (планшеты) =====================

// ===================== Баллы команд =====================

// Лист «Баллы»: строки — дисциплины, колонки — группы.
function readScores_() {
  const teams = readTeams_(readSettings_()).filter(t => !t.birthday).map(t => t.name);
  const vals = rows_(SH.scores);
  const header = (vals[0] || []).map(str_);
  const rows = vals.slice(1).filter(r => str_(r[0])).map(r => ({
    name: str_(r[0]),
    pts: teams.map(t => { const c = header.indexOf(t); return c > 0 ? Number(String(r[c]).replace(',', '.')) || 0 : 0; }),
  }));
  const totals = teams.map((t, i) => rows.reduce((sum, r) => sum + r.pts[i], 0));
  return { teams: teams, rows: rows, totals: totals };
}

// Прибавить баллы группе в дисциплине (строка и колонка создаются, если их нет).
function addScore_(discipline, team, delta) {
  const sh = ss_().getSheetByName(SH.scores);
  const vals = sh.getDataRange().getDisplayValues();
  let col = vals[0].map(str_).indexOf(team);
  if (col < 0) { col = vals[0].length; sh.getRange(1, col + 1).setValue(team); }
  let row = vals.findIndex((r, i) => i > 0 && str_(r[0]) === discipline);
  if (row < 0) { sh.appendRow([discipline]); row = sh.getLastRow() - 1; }
  const cell = sh.getRange(row + 1, col + 1);
  const cur = Number(String(cell.getValue()).replace(',', '.')) || 0;
  cell.setValue(cur + Number(delta));
}

// Победитель кнопки — у кого меньше время реакции; ему баллы.
function buzzerFinalize_(st) {
  const bz = st.buzzer;
  if (!bz.on || bz.done) return;
  const teams = Object.keys(bz.presses).sort((x, y) => bz.presses[x] - bz.presses[y]);
  bz.winner = teams[0] || null;
  bz.done = true;
  if (bz.winner && bz.points) {
    addScore_(bz.discipline || BUZZER_DISCIPLINE, bz.winner, bz.points);
    st.dataV++;
  }
}

const TEAM_ACTIONS = {
  // Ответ группы на текущее испытание (можно менять, пока приём открыт).
  chAnswer(b) {
    if (!b.team) throw new Error('Не указана команда');
    return mutate_(st => {
      const cur = st.challenge;
      if (cur.id !== Number(b.id) || cur.phase !== 'answer') throw new Error('Приём ответов закрыт');
      if (cur.endsAt && Date.now() > cur.endsAt + 5000) throw new Error('Время вышло');
      const sh = ss_().getSheetByName(SH.chAnswers);
      const text = str_(b.answer);
      const row = readChAnswers_().filter(a => a.id === cur.id && a.team === b.team)[0];
      if (row) sh.getRange(row.row, 3, 1, 3).setValues([[text, now_(), '']]);
      else sh.appendRow([cur.id, b.team, text, now_(), '']);
      st.dataV++;
    });
  },

  // Нажатие кнопки «Кто первый»: ms — сколько прошло от общего старта тревоги до нажатия.
  buzzerPress(b) {
    return mutate_(st => {
      const bz = st.buzzer;
      if (!bz.on || bz.done || Number(b.id) !== bz.id) throw new Error('Раунд уже закончился');
      if (bz.presses[b.team] !== undefined) return;
      bz.presses[b.team] = Math.max(0, Math.round(Number(b.ms) || 0));
      if (!bz.firstAt) bz.firstAt = Date.now();
      const teams = readTeams_(readSettings_()).filter(t => !t.birthday);
      if (teams.every(t => bz.presses[t.name] !== undefined)) buzzerFinalize_(st);
    });
  },

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

  // Тест проходит вся группа вместе: одна попытка на группу.
  iqSubmit(b) {
    if (!b.team) throw new Error('Не указана команда');
    return withLock_(() => {
      const results = readIqResults_();
      const dup = results.filter(r => r.id && r.id === b.attemptId)[0];
      if (dup) return { ok: true, score: dup.score, max: dup.max, state: getState_() };
      if (results.some(r => r.team === b.team)) throw new Error('Группа уже прошла тест');

      const qs = readIqQuestions_();
      const answers = b.answers || {};
      let score = 0;
      let max = 0;
      qs.forEach(q => {
        max += q.pts;
        if (q.ans && String(answers[q.id] || '').toUpperCase() === q.ans) score += q.pts;
      });
      const team = readTeams_(readSettings_()).filter(t => t.name === b.team)[0];
      const names = team ? team.members.map(m => m.name) : [];
      ss_().getSheetByName(SH.iqR).appendRow([
        now_(), b.team, names.join(', '), score, max, JSON.stringify(answers), b.attemptId || '',
      ]);
      writeTeamScore_(b.team, score);
      const st = getState_();
      st.dataV++;
      saveState_(st);
      return { ok: true, score: score, max: max, state: st };
    });
  },

};

// Баллы IQ группы каждому её участнику в лист «4 комнаты», колонка «Айкью тест».
function writeTeamScore_(team, score) {
  const sh = ss_().getSheetByName(SH.rooms);
  if (!sh) return;
  const vals = sh.getDataRange().getDisplayValues();
  const col = vals[0].findIndex(h => norm_(h).indexOf('айкью') >= 0 || norm_(h).indexOf('iq') >= 0);
  if (col < 0) return;
  vals.forEach((r, i) => {
    if (i > 0 && str_(r[0]) === team) sh.getRange(i + 1, col + 1).setValue(score);
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
      if (b.screen === 'facts' && !st.facts.order.length) st.facts.order = shuffle_(readFacts_().map(f => f.id));
    });
  },

  alarm(b) {
    return mutate_(st => { st.alarm = { on: !!b.on, msg: str_(b.msg), id: b.on ? Date.now() : st.alarm.id }; });
  },

  planCurrent(b) { return mutate_(st => { st.planCurrent = Number(b.i); }); },

  setOpen(b) {
    if (b.game !== 'iq') throw new Error('Неизвестная игра');
    return mutate_(st => { st[b.game].open = !!b.open; });
  },

  // Дать группе пройти тест заново: удалить её результат.
  iqReset(b) {
    return mutate_(st => {
      const sh = ss_().getSheetByName(SH.iqR);
      readIqResults_().filter(r => r.team === b.team).reverse().forEach(r => sh.deleteRow(r.row));
      writeTeamScore_(b.team, '');
      st.dataV++;
    });
  },

  setLink(b) { return mutate_(st => { st.sigame = str_(b.url); }); },

  refresh() { return mutate_(st => { st.dataV++; }); },

  // --- Баллы ---
  scoreAdd(b) {
    return mutate_(st => { addScore_(str_(b.discipline), str_(b.team), Number(b.delta) || 0); st.dataV++; });
  },

  disciplineAdd(b) {
    const name = str_(b.name);
    if (!name) throw new Error('Пустое название');
    return mutate_(st => {
      if (readScores_().rows.some(r => r.name === name)) throw new Error('Такая дисциплина уже есть');
      ss_().getSheetByName(SH.scores).appendRow([name]);
      st.dataV++;
    });
  },

  scoresVisible(b) { return mutate_(st => { st.scoresHidden = !b.on; st.dataV++; }); },

  // --- Кнопка «Кто первый» ---
  buzzerStart(b) {
    return mutate_(st => {
      const now = Date.now();
      st.buzzer = {
        id: now, on: true, discipline: str_(b.discipline) || BUZZER_DISCIPLINE,
        points: Number(b.points) || 0,
        // Общий момент старта через 3 с: за это время раунд дойдёт до всех планшетов.
        startAt: now + 3000,
        presses: {}, firstAt: 0, winner: null, done: false,
      };
      st.alarm.on = false;
    });
  },

  buzzerFinalize() { return mutate_(st => { buzzerFinalize_(st); }); },

  buzzerClose() { return mutate_(st => { st.buzzer.on = false; }); },

  // --- Испытания ---
  chStart(b) {
    const ch = readChallenges_().filter(c => c.id === Number(b.id))[0];
    if (!ch) throw new Error('Нет такого испытания');
    return mutate_(st => {
      const now = Date.now();
      // +3 с к таймеру: столько испытание идёт до планшетов.
      st.challenge = { id: ch.id, phase: 'answer', startedAt: now, endsAt: ch.seconds ? now + ch.seconds * 1000 + 3000 : 0, presenter: null };
      st.screen = 'challenge';
      st.dataV++;
    });
  },

  // phase: answer — приём открыт, closed — закрыт, reveal — показать правильный ответ и итог.
  chPhase(b) {
    if (['answer', 'closed', 'reveal'].indexOf(b.phase) < 0) throw new Error('Неизвестная фаза');
    return mutate_(st => {
      if (!st.challenge.id) throw new Error('Испытание не запущено');
      if (b.phase === 'answer') st.challenge.endsAt = 0;
      st.challenge.phase = b.phase;
      st.dataV++;
    });
  },

  // «4 слова»: какая группа сейчас выходит показывать своё слово (просто подпись на планшетах).
  chPresenter(b) {
    return mutate_(st => {
      st.challenge.presenter = str_(b.team) || null;
      st.dataV++;
    });
  },

  chSetCorrect(b) {
    const ch = readChallenges_().filter(c => c.id === Number(b.id))[0];
    if (!ch) throw new Error('Нет такого испытания');
    return mutate_(st => {
      ss_().getSheetByName(SH.challenges).getRange(ch.row, 6).setValue(str_(b.value));
      st.dataV++;
    });
  },

  // verdict: true / false / null (авто)
  chVerdict(b) {
    return mutate_(st => {
      const sh = ss_().getSheetByName(SH.chAnswers);
      const row = readChAnswers_().filter(a => a.id === Number(b.id) && a.team === b.team)[0];
      const mark = b.verdict === true ? '+' : b.verdict === false ? '-' : '';
      if (row) sh.getRange(row.row, 5).setValue(mark);
      else if (mark) sh.appendRow([Number(b.id), b.team, '', now_(), mark]);
      st.dataV++;
    });
  },

  // Записать баллы испытания в лист «Баллы». Повторный вызов добавляет только разницу,
  // поэтому после исправления проверки баллы можно пересчитать.
  chAward(b) {
    const ch = readChallenges_().filter(c => c.id === Number(b.id))[0];
    if (!ch) throw new Error('Нет такого испытания');
    return mutate_(st => {
      const results = chResults_(ch, readChAnswers_(), readTeams_(readSettings_()));
      const awarded = ch.awarded;
      results.forEach(r => {
        const delta = r.pts - (awarded[r.team] || 0);
        if (delta) addScore_(ch.discipline, r.team, delta);
        awarded[r.team] = r.pts;
      });
      ss_().getSheetByName(SH.challenges).getRange(ch.row, 10).setValue(JSON.stringify(awarded));
      st.dataV++;
    });
  },

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


};

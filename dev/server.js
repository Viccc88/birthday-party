// Локальная проверка без Google: эмулирует Apps Script (таблица в памяти)
// и раздаёт сайт. Запуск: node dev/server.js → http://localhost:8787
// FIXTURE_DIR=папка с CSV (Группы.csv, План.csv, 4 комнаты.csv) — подставить свои данные.
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;

// ---------- Таблица в памяти ----------
class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      const vals = [];
      for (let j = 0; j < this.nc; j++) vals.push(row[this.c - 1 + j] ?? '');
      out.push(vals);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(v => String(v))); }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) { return this.setValues([[v]]); }
  setValues(vals) {
    vals.forEach((row, i) => row.forEach((v, j) => {
      const ri = this.r - 1 + i;
      while (this.sheet.data.length <= ri) this.sheet.data.push([]);
      this.sheet.data[ri][this.c - 1 + j] = v;
    }));
    return this;
  }
  setFontWeight() { return this; }
  clearContent() { return this.setValues(this.getValues().map(r => r.map(() => ''))); }
  getSheet() { return this.sheet; }
}

class Sheet {
  constructor(name, data) { this.name = name; this.data = data || []; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(row) { this.data.push(row.slice()); return this; }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  setFrozenRows() {}
  hideSheet() {}
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function demoSheets() {
  const names = [['Группа 1', ['Аня', 'Боря', 'Вика']], ['Группа 2', ['Гоша', 'Даша', 'Егор', 'Женя']],
    ['Группа 3', ['Зоя', 'Игорь', 'Катя']], ['Группа 4', ['Лёша', 'Маша', 'Катя']]];
  const groups = [['Группа', '№', 'Имя']];
  const rooms = [['Группа', '№', 'Имя', 'Айкью тест', 'Врать или не врать о предмете в комнате', '4 слова']];
  names.forEach(([g, list]) => list.forEach((n, i) => { groups.push([g, i + 1, n]); rooms.push([g, i + 1, n, '', '', '']); }));
  return {
    'Группы': groups,
    'План': [['Время', 'Ивент'], ['14:00 - 14:30', 'Заезд'], ['14:30 - 15:00', 'Знакомство по фактам'],
      ['15:00 - 15:30', 'Обед'], ['17:30 - 19:00', '4 комнаты'], ['20:00 - 21:30', 'Своя игра']],
    '4 комнаты': rooms,
  };
}

function loadSheets() {
  const dir = process.env.FIXTURE_DIR;
  if (!dir) return demoSheets();
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.csv')) out[f.slice(0, -4)] = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return out;
}

const sheets = Object.entries(loadSheets()).map(([n, d]) => new Sheet(n, d));
const spreadsheet = {
  getSheetByName: n => sheets.find(s => s.name === n) || null,
  insertSheet: n => { const s = new Sheet(n); sheets.push(s); return s; },
};

const cacheStore = new Map();
const cache = {
  get: k => { const e = cacheStore.get(k); return e && e.exp > Date.now() ? e.v : null; },
  put: (k, v, ttl = 600) => cacheStore.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }),
  getAll: keys => Object.fromEntries(keys.map(k => [k, cache.get(k)]).filter(([, v]) => v !== null)),
};

const gas = {
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
  CacheService: { getScriptCache: () => cache },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: s => ({ content: s, setMimeType() { return this; } }),
  },
  Utilities: { formatDate: d => d.toTimeString().slice(0, 8) },
  Session: { getScriptTimeZone: () => 'Europe/Moscow' },
  console,
};
const ctx = vm.createContext(gas);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const e = { parameter: Object.fromEntries(url.searchParams), postData: { contents: body } };
      const out = req.method === 'POST' ? ctx.doPost(e) : ctx.doGet(e);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(out.content);
      }, 150 + Math.random() * 250);
    });
    return;
  }
  if (url.pathname === '/__sheets') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(Object.fromEntries(sheets.map(s => [s.name, s.data])), null, 1));
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

// При запуске напрямую — сервер; при require (dev/test.js) — только эмулятор таблицы.
if (require.main === module) server.listen(PORT, () => console.log(`Сайт: http://localhost:${PORT}  (PIN пульта: 0000)`));

module.exports = { ctx, spreadsheet };

// Полный тест логики бэкенда на эмуляторе таблицы. Запуск: node dev/test.js
const vm = require('vm');
const { ctx, spreadsheet } = require('./server.js');

let passed = 0;
const failed = [];
function check(name, cond, info) {
  if (cond) passed++;
  else failed.push(name + (info !== undefined ? ' → ' + JSON.stringify(info) : ''));
}
function section(name) { console.log('— ' + name); }

const PIN = '0000';
const post = o => JSON.parse(ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify(o) } }).content);
const get = p => JSON.parse(ctx.doGet({ parameter: p }).content);
const admin = o => post(Object.assign({ pin: PIN }, o));
const state = () => get({ a: 'state' }).state;
const data = () => get({ a: 'data' }).data;
const adminData = () => get({ a: 'admin', pin: PIN }).data;
const sheet = name => spreadsheet.getSheetByName(name).data;
const scoreRow = (name) => sheet('Баллы').find(r => r[0] === name) || [];
const num = v => Number(v) || 0;
const teamScore = (discipline, team) => num(scoreRow(discipline)[sheet('Баллы')[0].indexOf(team)]);
// Сдвиг часов внутри эмулятора Apps Script (для таймеров).
vm.runInContext('var __shift = 0; var __realNow = Date.now; Date.now = function () { return __realNow() + __shift; };', ctx);
const shiftClock = ms => vm.runInContext('__shift += ' + ms, ctx);

const T = ['Группа 1', 'Группа 2', 'Группа 3', 'Группа 4'];

// ---------------------------------------------------------------
section('Доступ и синхронизация');
check('данные без PIN читаются', get({ a: 'data' }).ok);
check('неверный PIN на входе', !post({ a: 'login', pin: '1' }).ok);
check('верный PIN на входе', post({ a: 'login', pin: PIN }).ok);
check('действие пульта без PIN запрещено', !post({ a: 'setScreen', screen: 'plan' }).ok);
check('данные пульта без PIN запрещены', !get({ a: 'admin', pin: 'x' }).ok);
check('листы созданы', ['Баллы', 'Испытания', 'Ответы испытаний', 'Факты', 'IQ вопросы', 'IQ результаты', 'Настройки'].every(n => spreadsheet.getSheetByName(n)));
let d0 = data();
check('у данных есть версия', d0.key === String(state().dataV));
let r = get({ a: 'state', dk: d0.key });
check('опрос без изменений — без данных', r.ok && !r.data);
admin({ a: 'refresh' });
r = get({ a: 'state', dk: d0.key });
check('опрос после изменения — сразу с данными', r.data && r.data.key === String(r.state.dataV), r.data && r.data.key);
check('опрос отдаёт время сервера', typeof r.now === 'number');
const v1 = state().v;
admin({ a: 'planCurrent', i: 2 });
check('номер состояния растёт', state().v > v1);
check('пункт плана отмечен', state().planCurrent === 2);
check('неизвестный экран отклонён', !admin({ a: 'setScreen', screen: 'nope' }).ok);
check('неизвестное действие отклонено', !post({ a: 'hack' }).ok);

// ---------------------------------------------------------------
section('Знакомство по фактам');
admin({ a: 'factAdd', who: 'Аня', text: 'Прыгала с парашютом' });
admin({ a: 'factAdd', who: 'Катя (Группа 3)', text: 'Была в Японии' });
admin({ a: 'factAdd', who: 'Илья', text: 'Собрал компьютер' });
check('пустой факт отклонён', !admin({ a: 'factAdd', who: 'Аня', text: '  ' }).ok);
const teamsData = data().teams;
check('тёзки различаются группой', teamsData.find(t => t.name === 'Группа 4').members.find(m => m.name === 'Катя').label === 'Катя (Группа 4)');
check('именинники в списке', teamsData.some(t => t.birthday && t.members.some(m => m.name === 'Илья')));
admin({ a: 'setScreen', screen: 'facts' });
let st = state();
check('ячейки перемешаны и все на месте', st.facts.order.length === 3 && [1, 2, 3].every(id => st.facts.order.includes(id)));
check('открыть без хода нельзя', !post({ a: 'factOpen', id: 1 }).ok);
admin({ a: 'factsTurn', who: 'Боря' });
check('факт открывается', post({ a: 'factOpen', id: 2 }).ok);
check('второй факт сразу нельзя', !post({ a: 'factOpen', id: 1 }).ok);
check('кто открыл — в таблице', sheet('Факты')[2][3] === 'Боря', sheet('Факты')[2]);
check('ответ скрыт до показа', state().facts.answer === null);
admin({ a: 'factsReveal' });
check('ответ показан', state().facts.answer === 'Катя (Группа 3)');
admin({ a: 'factsMark', ok: true });
check('угадал — в таблице', sheet('Факты')[2][4] === 'да');
admin({ a: 'factsTurn', who: 'Даша' });
check('новый ход закрывает факт', state().facts.current === null && state().facts.turn === 'Даша');
check('открытую ячейку повторно не открыть', !post({ a: 'factOpen', id: 2 }).ok);
admin({ a: 'factDelete', id: 3 });
check('факт удалён', data().facts.length === 2 && !state().facts.order.includes(3));
admin({ a: 'factsReset' });
st = state();
check('игра сброшена', Object.keys(st.facts.opened).length === 0 && st.facts.turn === null && sheet('Факты')[2][3] === '');

// ---------------------------------------------------------------
section('IQ-тест (группой, одна попытка)');
const key = { 1: 'C', 2: 'C', 3: 'D', 4: 'A', 5: 'A', 6: 'B', 7: 'D', 8: 'D', 9: 'B', 10: 'B', 11: 'C', 12: 'B', 13: 'C', 14: 'D', 15: 'C' };
admin({ a: 'setScreen', screen: 'iq' });
check('тест открыт при показе', state().iq.open === true);
check('вопросов 15, у планшетов нет ответов', data().iq.questions.length === 15 && data().iq.questions.every(q => q.ans === undefined));
r = post({ a: 'iqSubmit', team: 'Группа 1', answers: key, attemptId: 'a1' });
check('все верно — 29 из 29', r.ok && r.score === 29 && r.max === 29, r);
r = post({ a: 'iqSubmit', team: 'Группа 1', answers: key, attemptId: 'a1' });
check('повтор того же запроса не дублируется', r.ok && sheet('IQ результаты').length === 2);
check('вторая попытка группы запрещена', !post({ a: 'iqSubmit', team: 'Группа 1', answers: {}, attemptId: 'a2' }).ok);
const rooms = sheet('4 комнаты');
check('баллы записаны всем участникам группы', rooms.filter(x => x[0] === 'Группа 1').every(x => x[3] === 29), rooms);
r = post({ a: 'iqSubmit', team: 'Группа 2', answers: { 1: 'C' }, attemptId: 'b1' });
check('частично верно — 1 балл', r.score === 1);
check('результат группы в данных', data().iqDone['Группа 2'].score === 1);
admin({ a: 'setScreen', screen: 'results', results: 'iq' });
const res = data().results;
check('рейтинг по убыванию', res && res.iq[0].team === 'Группа 1' && res.iq[1].team === 'Группа 2');
admin({ a: 'iqReset', team: 'Группа 1' });
check('сброс попытки', !data().iqDone['Группа 1'] && sheet('4 комнаты').filter(x => x[0] === 'Группа 1').every(x => x[3] === ''));
check('после сброса можно пройти заново', post({ a: 'iqSubmit', team: 'Группа 1', answers: {}, attemptId: 'a3' }).ok);
admin({ a: 'setOpen', game: 'iq', open: false });
check('тест можно закрыть', state().iq.open === false);

// ---------------------------------------------------------------
section('Баллы');
admin({ a: 'scoreAdd', discipline: 'Мафия / бункер', team: 'Группа 2', delta: 1 });
admin({ a: 'scoreAdd', discipline: 'Мафия / бункер', team: 'Группа 2', delta: 1 });
admin({ a: 'scoreAdd', discipline: 'Мафия / бункер', team: 'Группа 2', delta: -1 });
check('+ + − = 1', teamScore('Мафия / бункер', 'Группа 2') === 1);
admin({ a: 'disciplineAdd', name: 'Стулья' });
check('дисциплина добавлена', data().scores.rows.some(x => x.name === 'Стулья'));
check('дубликат дисциплины отклонён', !admin({ a: 'disciplineAdd', name: 'Стулья' }).ok);
admin({ a: 'scoreAdd', discipline: 'Новая', team: 'Группа 4', delta: 2 });
check('баллы в несуществующую дисциплину создают строку', teamScore('Новая', 'Группа 4') === 2);
sheet('Баллы').find(x => x[0] === 'Стулья')[1] = '0,5';
check('дробные баллы из таблицы', data().scores !== null && adminData().scores.rows.find(x => x.name === 'Стулья').pts[0] === 0.5);
const totals = adminData().scores.totals;
check('итог по группе считается', totals[1] === 1 && totals[3] === 2, totals);
admin({ a: 'scoresVisible', on: false });
check('баллы скрыты от гостей', data().scores === null && adminData().scores !== null);
admin({ a: 'scoresVisible', on: true });
check('баллы снова видны', data().scores !== null);

// ---------------------------------------------------------------
section('Тревога-кнопка');
const before = teamScore('Кнопка «Кто первый»', 'Группа 3');
admin({ a: 'buzzerStart', discipline: 'Кнопка «Кто первый»', points: 2 });
let bz = state().buzzer;
check('раунд запущен, старт через 3 с', bz.on && !bz.done && bz.startAt - Date.now() > 2000 && bz.startAt - Date.now() <= 3000);
check('нажатие в чужой раунд отклонено', !post({ a: 'buzzerPress', team: 'Группа 1', id: 1, ms: 100 }).ok);
post({ a: 'buzzerPress', team: 'Группа 1', id: bz.id, ms: 900 });
post({ a: 'buzzerPress', team: 'Группа 3', id: bz.id, ms: 400 });
post({ a: 'buzzerPress', team: 'Группа 3', id: bz.id, ms: 50 });
bz = state().buzzer;
check('повторное нажатие не меняет время', bz.presses['Группа 3'] === 400);
check('итог ещё не подведён', !bz.done);
check('первое нажатие отмечено', bz.firstAt > 0);
admin({ a: 'buzzerFinalize' });
bz = state().buzzer;
check('победитель — меньшее время', bz.done && bz.winner === 'Группа 3');
check('победителю начислено', teamScore('Кнопка «Кто первый»', 'Группа 3') === before + 2);
check('после итога нажатия не принимаются', !post({ a: 'buzzerPress', team: 'Группа 2', id: bz.id, ms: 10 }).ok);
admin({ a: 'buzzerFinalize' });
check('повторный итог не начисляет дважды', teamScore('Кнопка «Кто первый»', 'Группа 3') === before + 2);
admin({ a: 'buzzerStart', discipline: 'Кнопка «Кто первый»', points: 1 });
bz = state().buzzer;
T.forEach((t, i) => post({ a: 'buzzerPress', team: t, id: bz.id, ms: 1000 - i * 100 }));
bz = state().buzzer;
check('все нажали — итог сам', bz.done && bz.winner === 'Группа 4');
admin({ a: 'buzzerClose' });
check('раунд закрыт', state().buzzer.on === false);
admin({ a: 'buzzerStart', discipline: 'Кнопка «Кто первый»', points: 1 });
admin({ a: 'buzzerFinalize' });
check('никто не нажал — без победителя', state().buzzer.done && state().buzzer.winner === null);
admin({ a: 'buzzerClose' });

// ---------------------------------------------------------------
section('Испытания: шпионы');
const chs = () => adminData().challenges;
check('3 испытания по умолчанию', chs().map(c => c.type).join() === 'spy,words,case', chs().map(c => c.type));
check('несуществующее испытание', !admin({ a: 'chStart', id: 99 }).ok);
admin({ a: 'chSetCorrect', id: 1, value: 'Группа 3' });
admin({ a: 'chStart', id: 1 });
st = state();
check('испытание на экранах, приём открыт', st.screen === 'challenge' && st.challenge.phase === 'answer' && st.challenge.id === 1);
let pc = data().challenge;
check('варианты — все группы', pc.options.join() === T.join());
check('шпионы скрыты до показа', pc.correct === undefined && pc.results === undefined);
check('за себя голосовать нельзя', !post({ a: 'chAnswer', team: 'Группа 1', id: 1, answer: 'Группа 1' }).ok);
admin({ a: 'chPresenter', team: 'Группа 2' });
check('кто в комнате — на планшетах', data().challenge.presenter === 'Группа 2');
post({ a: 'chAnswer', team: 'Группа 1', id: 1, answer: 'Группа 3' });
post({ a: 'chAnswer', team: 'Группа 2', id: 1, answer: 'Группа 4' });
post({ a: 'chAnswer', team: 'Группа 4', id: 1, answer: 'Группа 2' });
post({ a: 'chAnswer', team: 'Группа 2', id: 1, answer: 'Группа 1' });
check('голос можно поменять', data().challenge.answers['Группа 2'] === 'Группа 1');
check('ответ не в то испытание отклонён', !post({ a: 'chAnswer', team: 'Группа 1', id: 2, answer: 'x' }).ok);
admin({ a: 'chPhase', phase: 'closed' });
check('после закрытия ответы не принимаются', !post({ a: 'chAnswer', team: 'Группа 4', id: 1, answer: 'Группа 3' }).ok);
admin({ a: 'chPhase', phase: 'reveal' });
pc = data().challenge;
let spyRow = pc.results.find(x => x.spy);
check('1 из 3 нашли — шпионам балл', spyRow.team === 'Группа 3' && spyRow.found === 1 && spyRow.pts === 1, spyRow);
check('угадавшие получают балл', pc.results.find(x => x.team === 'Группа 1').pts === 1 && pc.results.find(x => x.team === 'Группа 2').pts === 0);
const spyBefore = T.map(t => teamScore('Испытания', t));
admin({ a: 'chAward', id: 1 });
admin({ a: 'chAward', id: 1 });
check('начисление не дублируется', T.map(t => teamScore('Испытания', t) - spyBefore[T.indexOf(t)]).join() === '1,0,1,0');
admin({ a: 'chVerdict', id: 1, team: 'Группа 2', verdict: true });
pc = adminData().challenges[0];
spyRow = pc.results.find(x => x.spy);
check('ручная проверка: теперь 2 из 3 — шпионам 0', spyRow.found === 2 && spyRow.pts === 0, spyRow);
admin({ a: 'chAward', id: 1 });
check('пересчёт добавляет только разницу', T.map(t => teamScore('Испытания', t) - spyBefore[T.indexOf(t)]).join() === '1,1,0,0');
admin({ a: 'chVerdict', id: 1, team: 'Группа 2', verdict: null });
check('сброс ручной проверки', adminData().challenges[0].results.find(x => x.team === 'Группа 2').manual === false);

// ---------------------------------------------------------------
section('Испытания: 4 слова');
admin({ a: 'chSetOptions', id: 2, value: 'Кот;Ракета;Торт;Луна' });
admin({ a: 'chSetCorrect', id: 2, value: 'Кот на ракете ест торт на луне' });
admin({ a: 'chStart', id: 2 });
pc = data().challenge;
check('слова не уходят на все планшеты', pc.options.length === 0);
check('у каждой группы своё слово', T.map(t => get({ a: 'word', team: t }).word).join() === 'Кот,Ракета,Торт,Луна');
check('у планшетов есть время старта (для смены слов)', pc.startedAt > 0);
post({ a: 'chAnswer', team: 'Группа 1', id: 2, answer: 'кот на ракете ест торт на луне!' });
post({ a: 'chAnswer', team: 'Группа 2', id: 2, answer: '  Кот  на ракете ест торт на Луне ' });
post({ a: 'chAnswer', team: 'Группа 3', id: 2, answer: 'Торт на луне ест кот на ракете' });
admin({ a: 'chPhase', phase: 'reveal' });
pc = data().challenge;
check('регистр/пробелы/знаки не мешают', pc.results.find(x => x.team === 'Группа 1').ok && pc.results.find(x => x.team === 'Группа 2').ok);
check('другой порядок слов — неверно', pc.results.find(x => x.team === 'Группа 3').ok === false);
check('нет ответа — неверно', pc.results.find(x => x.team === 'Группа 4').ok === false);
check('после показа видны все слова', pc.words.map(w => w.word).join() === 'Кот,Ракета,Торт,Луна');
admin({ a: 'chSetCorrect', id: 2, value: 'Кот на ракете ест торт на луне / Торт на луне ест кот на ракете' });
check('несколько вариантов через /', data().challenge.results.find(x => x.team === 'Группа 3').ok === true);
admin({ a: 'chStart', id: 2 });
check('перезапуск открывает приём, ответы остаются', state().challenge.phase === 'answer' && data().challenge.answers['Группа 1']);
check('после перезапуска новое время старта', data().challenge.startedAt >= pc.startedAt);

// ---------------------------------------------------------------
section('Испытания: кейс с деньгами');
admin({ a: 'chStart', id: 3 });
T.forEach(t => post({ a: 'chAnswer', team: t, id: 3, answer: '1000' }));
admin({ a: 'chPhase', phase: 'reveal' });
check('все поровну — балл всем', data().challenge.results.every(x => x.pts === 1));
admin({ a: 'chSetAnswer', id: 3, team: 'Группа 2', answer: '5 000' });
pc = data().challenge;
check('ведущие вписали сумму, взявшему больше — балл', pc.results.find(x => x.team === 'Группа 2').pts === 1 && pc.results.filter(x => x.pts).length === 1);
admin({ a: 'chSetAnswer', id: 3, team: 'Группа 4', answer: '5000,0' });
pc = data().challenge;
check('двое взяли максимум — балл обоим', pc.results.filter(x => x.pts).map(x => x.team).join() === 'Группа 2,Группа 4');

// ---------------------------------------------------------------
section('Испытания: выбор, текст, число, таймер');
const chSheet = spreadsheet.getSheetByName('Испытания');
chSheet.appendRow([4, 'Правда или ложь', 'выбор', 'Это правда?', 'Правда;Ложь', 'Ложь', 1, 0, 'Испытания', '']);
chSheet.appendRow([5, 'Столица', 'текст', 'Столица Франции?', '', 'Париж/Paris', 2, 0, 'Своя игра', '']);
chSheet.appendRow([6, 'Сколько конфет', 'число', '', '', '100', 3, 30, 'Испытания', '']);
admin({ a: 'refresh' });
admin({ a: 'chStart', id: 4 });
check('варианты выбора на планшетах', data().challenge.options.join() === 'Правда,Ложь');
post({ a: 'chAnswer', team: 'Группа 1', id: 4, answer: 'Ложь' });
post({ a: 'chAnswer', team: 'Группа 2', id: 4, answer: 'Правда' });
check('выбор проверяется', adminData().challenges.find(c => c.id === 4).results.map(x => x.ok).join() === 'true,false,false,false');
admin({ a: 'chStart', id: 5 });
post({ a: 'chAnswer', team: 'Группа 1', id: 5, answer: 'париж' });
post({ a: 'chAnswer', team: 'Группа 2', id: 5, answer: 'PARIS' });
post({ a: 'chAnswer', team: 'Группа 3', id: 5, answer: 'Лион' });
admin({ a: 'chAward', id: 5 });
check('текст: варианты через /', teamScore('Своя игра', 'Группа 1') === 2 && teamScore('Своя игра', 'Группа 2') === 2 && teamScore('Своя игра', 'Группа 3') === 0);
admin({ a: 'chStart', id: 6 });
check('таймер выставлен (30 с + 3 с на доставку)', state().challenge.endsAt - Date.now() > 32000);
post({ a: 'chAnswer', team: 'Группа 1', id: 6, answer: '90' });
post({ a: 'chAnswer', team: 'Группа 2', id: 6, answer: '110' });
post({ a: 'chAnswer', team: 'Группа 3', id: 6, answer: 'много' });
shiftClock(40000);
check('после таймера ответ не принимается', !post({ a: 'chAnswer', team: 'Группа 4', id: 6, answer: '100' }).ok);
shiftClock(-40000);
const numRes = adminData().challenges.find(c => c.id === 6).results;
check('число: самые близкие (оба на 10) получают баллы', numRes.map(x => x.pts).join() === '3,3,0,0', numRes);
admin({ a: 'chPhase', phase: 'answer' });
check('повторное открытие снимает таймер', state().challenge.endsAt === 0);
check('ответ после повторного открытия', post({ a: 'chAnswer', team: 'Группа 4', id: 6, answer: '100' }).ok);
check('теперь точный ответ один лучший', adminData().challenges.find(c => c.id === 6).results.map(x => x.pts).join() === '0,0,0,3');

// ---------------------------------------------------------------
section('Своя игра, план, сброс, правки таблицы');
admin({ a: 'setLink', url: 'https://sigame.example/lobby/1' });
check('ссылка сохранена', state().sigame === 'https://sigame.example/lobby/1');
const dv = state().dataV;
ctx.onEdit({ range: { getSheet: () => ({ getName: () => 'План' }) } });
check('ручная правка таблицы обновляет данные', state().dataV === dv + 1);
ctx.onEdit({ range: { getSheet: () => ({ getName: () => '_state' }) } });
check('правка служебного листа не считается', state().dataV === dv + 1);
const vBefore = state().v;
ctx.resetState();
st = state();
check('сброс состояния: счётчики не уменьшаются', st.v > vBefore && st.dataV > dv + 1 && st.screen === 'plan' && !st.buzzer.on);
ctx.loadIqQuestions();
check('загрузка вопросов IQ', data().iq.questions.length === 15 && data().iq.minutes === 10);

// ---------------------------------------------------------------
console.log('');
if (failed.length) {
  console.log(`❌ Провалено ${failed.length} из ${passed + failed.length}:`);
  failed.forEach(x => console.log('  • ' + x));
  process.exit(1);
}
console.log(`✅ Все проверки пройдены: ${passed}`);
process.exit(0);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';

const dir = () => mkdtempSync(join(tmpdir(), 'midas-keeper-'));

test('журнал: append пишет JSONL с ts, readAll читает', () => {
  const d = dir();
  const k = makeKeeper(d, { now: () => '2026-07-03T10:00:00Z' });
  k.append({ type: 'x', a: 1 });
  const lines = readFileSync(join(d, 'journal.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ts: '2026-07-03T10:00:00Z', type: 'x', a: 1 });
  assert.equal(k.readAll().length, 1);
});

test('processed: markProcessed/hasProcessed переживают рестарт (новый инстанс, тот же каталог)', () => {
  const d = dir();
  const k1 = makeKeeper(d, { now: () => 't' });
  assert.equal(k1.hasProcessed('repo#1@planning'), false);
  k1.markProcessed('repo#1@planning');
  assert.equal(k1.hasProcessed('repo#1@planning'), true);
  const k2 = makeKeeper(d, { now: () => 't' });
  assert.equal(k2.hasProcessed('repo#1@planning'), true, 'рестарт не теряет обработанное');
});

test('курсор: атомарная запись, чтение после рестарта, только вперёд', () => {
  const d = dir();
  const k1 = makeKeeper(d, { now: () => 't' });
  assert.equal(k1.getCursor('r'), null);
  k1.setCursor('r', '2026-07-03T10:00:00Z');
  assert.equal(k1.getCursor('r'), '2026-07-03T10:00:00Z');
  k1.setCursor('r', '2026-07-03T09:00:00Z'); // назад — игнор
  assert.equal(k1.getCursor('r'), '2026-07-03T10:00:00Z', 'курсор двигается только вперёд');
  const k2 = makeKeeper(d, { now: () => 't' });
  assert.equal(k2.getCursor('r'), '2026-07-03T10:00:00Z');
  assert.ok(!existsSync(join(d, 'cursor.json.tmp')), 'tmp-файл убран после rename');
});

test('стоимость: агрегация per task и per day', () => {
  const d = dir();
  const k = makeKeeper(d, { now: () => '2026-07-03T10:00:00Z' });
  k.addCost({ task: 'midas#5', usd: 0.5, day: '2026-07-03' });
  k.addCost({ task: 'midas#5', usd: 0.25, day: '2026-07-03' });
  k.addCost({ task: 'midas#6', usd: 1, day: '2026-07-03' });
  k.addCost({ task: 'midas#5', usd: 1, day: '2026-07-02' });
  assert.equal(k.costForTask('midas#5'), 1.75);
  assert.equal(k.costForDay('2026-07-03'), 1.75);
  const k2 = makeKeeper(d, { now: () => 't' });
  assert.equal(k2.costForTask('midas#5'), 1.75, 'агрегаты восстанавливаются из журнала');
});

test('onAppend: подписчик вызывается на каждый append и видит обогащённое событие (с ts)', () => {
  const seen = [];
  const k = makeKeeper(dir(), { now: () => 't', onAppend: (e) => seen.push(e) });
  k.append({ type: 'work-done', pr: 7 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'work-done');
  assert.equal(seen[0].pr, 7);
  assert.equal(seen[0].ts, 't');
});

test('onAppend: бросающий подписчик не ломает журнал и не пробрасывает', () => {
  const d = dir();
  const k = makeKeeper(d, { now: () => 't', onAppend: () => { throw new Error('subscriber boom'); } });
  assert.doesNotThrow(() => k.append({ type: 'x', a: 1 }));
  const lines = readFileSync(join(d, 'journal.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'событие всё равно записано в журнал');
});

test('onAppend: реплей журнала при старте НЕ вызывает подписчика (без спама историей)', () => {
  const d = dir();
  const k1 = makeKeeper(d, { now: () => 't' });
  k1.append({ type: 'work-done', pr: 1 });
  k1.append({ type: 'blocked', question: 'q' });
  let calls = 0;
  makeKeeper(d, { now: () => 't', onAppend: () => { calls++; } }); // конструктор читает 2 исторических события
  assert.equal(calls, 0, 'исторические события не уходят подписчику');
});

// Ротация проверяется ДО append: файл должен уже превышать порог, тогда
// следующий append переименует его. Крупный pad-payload делает срабатывание
// детерминированным (не зависит от точного размера мелких событий).
const BIG = 'x'.repeat(300); // одно событие гарантированно > 200 байт

test('ротация: при достижении порога journal.jsonl → journal.jsonl.1, запись идёт в свежий файл', () => {
  const d = dir();
  const k = makeKeeper(d, { now: () => 't', rotateThreshold: 200 });
  const journal = join(d, 'journal.jsonl');
  const rotated = join(d, 'journal.jsonl.1');
  k.append({ type: 'x', pad: BIG }); // первый append: файла ещё нет → без ротации, размер > порога
  assert.ok(readFileSync(journal, 'utf8').length >= 200, 'журнал перевалил порог');
  assert.ok(!existsSync(rotated), 'ротации ещё не было — проверка размера идёт перед следующим append');
  const before = readFileSync(journal, 'utf8');
  k.append({ type: 'after-rotate', a: 1 });
  assert.ok(existsSync(rotated), 'старый журнал переименован в .1');
  assert.equal(readFileSync(rotated, 'utf8'), before, '.1 = старое содержимое журнала');
  const fresh = readFileSync(journal, 'utf8').trim().split('\n');
  assert.equal(fresh.length, 1, 'новое событие в свежем journal.jsonl');
  assert.deepEqual(JSON.parse(fresh[0]), { ts: 't', type: 'after-rotate', a: 1 });
});

test('ротация: восстановление состояния при старте из journal.jsonl.1 + journal.jsonl в хронологическом порядке', () => {
  const d = dir();
  const k1 = makeKeeper(d, { now: () => 't', rotateThreshold: 200 });
  // события до ротации (уйдут в .1)
  k1.addCost({ task: 'midas#5', usd: 0.5, day: '2026-07-03' });
  k1.markProcessed('repo#1@planning');
  k1.append({ type: 'pad', pad: BIG }); // раздуть журнал выше порога
  // следующий append переименует накопленное в .1, эти пишутся в свежий journal.jsonl
  k1.addCost({ task: 'midas#5', usd: 0.25, day: '2026-07-03' });
  k1.markProcessed('repo#2@review');
  assert.ok(existsSync(join(d, 'journal.jsonl.1')), 'ротация произошла');

  const k2 = makeKeeper(d, { now: () => 't' });
  assert.equal(k2.costForTask('midas#5'), 0.75, 'агрегат стоимости из обоих файлов');
  assert.equal(k2.costForDay('2026-07-03'), 0.75, 'агрегат по дню из обоих файлов');
  assert.equal(k2.hasProcessed('repo#1@planning'), true, 'дедуп из .1');
  assert.equal(k2.hasProcessed('repo#2@review'), true, 'дедуп из основного');
  // readAll восстанавливает события в хронологическом порядке: .1 раньше основного
  const all = k2.readAll();
  assert.equal(all[0].type, 'cost', 'первое событие — из .1 (старейшее)');
  assert.equal(all[all.length - 1].type, 'processed', 'последнее событие — из основного (новейшее)');
});

test('ротация: повторная ротация перезаписывает .1, третьей генерации нет', () => {
  const d = dir();
  const k = makeKeeper(d, { now: () => 't', rotateThreshold: 200 });
  const journal = join(d, 'journal.jsonl');
  const rotated = join(d, 'journal.jsonl.1');

  // первая генерация → ротация
  k.append({ type: 'gen1', pad: BIG });
  k.append({ type: 'trigger', n: 1 });
  assert.ok(existsSync(rotated), 'первая ротация');
  const firstRotated = readFileSync(rotated, 'utf8');
  assert.ok(firstRotated.includes('gen1'), '.1 содержит первую генерацию');

  // вторая генерация → повторная ротация
  k.append({ type: 'gen2', pad: BIG });
  k.append({ type: 'trigger', n: 2 });

  const rotatedNow = readFileSync(rotated, 'utf8');
  assert.notEqual(rotatedNow, firstRotated, '.1 перезаписан новым содержимым');
  assert.ok(rotatedNow.includes('gen2'), '.1 содержит вторую генерацию');
  assert.ok(!rotatedNow.includes('gen1'), 'первая генерация потеряна (by design)');
  assert.ok(!existsSync(join(d, 'journal.jsonl.2')), 'третьей генерации нет');
  assert.ok(existsSync(journal) && existsSync(rotated), 'ровно две генерации на диске');
});

test('ротация: битая строка пропускается с warn в каждом из двух файлов', () => {
  const d = dir();
  writeFileSync(join(d, 'journal.jsonl.1'), '{"ts":"t","type":"cost","task":"a","usd":1,"day":"2026-07-03"}\n{битая\n');
  writeFileSync(join(d, 'journal.jsonl'), '{oops\n{"ts":"t","type":"cost","task":"a","usd":2,"day":"2026-07-03"}\n');
  let k;
  assert.doesNotThrow(() => { k = makeKeeper(d, { now: () => 't' }); }, 'битые строки не роняют старт');
  assert.equal(k.costForTask('a'), 3, 'валидные события из обоих файлов учтены, битые пропущены');
});

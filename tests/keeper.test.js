import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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

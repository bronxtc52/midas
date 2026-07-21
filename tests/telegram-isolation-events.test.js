import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToMessage } from '../src/notify/telegram.js';

const OPTS = { monUrl: 'https://mon.adarasoft.com', repo: 'bronxtc52/midas' };

// События per-issue/per-repo изоляции tick (инцидент 2026-07-21): алёрт по бэкоффу
// на степенях двойки consecutive (как tick-error), recovery — при серии >=2.

test('issue-error: алёрт на степенях двойки, одиночный транзиент и не-степени молчат', () => {
  const mk = (consecutive) => eventToMessage({ type: 'issue-error', repo: 'o/r', issue: 5, error: 'check-runs → 403', consecutive }, OPTS);
  assert.equal(mk(1), null, 'одиночная ошибка — тихо (ретрай следующим тиком)');
  assert.match(mk(2), /o\/r#5/, 'на 2-й подряд — алёрт с адресом задачи');
  assert.match(mk(2), /403/, 'алёрт несёт текст ошибки');
  assert.equal(mk(3), null, '3 — не степень двойки');
  assert.match(mk(4), /4/, 'на 4-й — снова алёрт');
  assert.equal(eventToMessage({ type: 'issue-error', repo: 'o/r', issue: 5, error: 'x' }, OPTS), null,
    'без consecutive — тихо (новый тип, легаси-записей нет)');
});

test('repo-error: тот же бэкофф, алёрт называет репо', () => {
  const mk = (consecutive) => eventToMessage({ type: 'repo-error', repo: 'o/r', error: 'issues → 500', consecutive }, OPTS);
  assert.equal(mk(1), null);
  assert.match(mk(2), /o\/r/);
  assert.match(mk(2), /500/);
  assert.equal(mk(5), null);
});

test('issue-recovered / repo-recovered: парное «починилось» только после серии >=2', () => {
  assert.equal(eventToMessage({ type: 'issue-recovered', repo: 'o/r', issue: 5, consecutive: 1, error: 'x' }, OPTS), null,
    'о чём не алёртили — о том не отчитываемся');
  const ir = eventToMessage({ type: 'issue-recovered', repo: 'o/r', issue: 5, consecutive: 7, error: '403' }, OPTS);
  assert.match(ir, /o\/r#5/);
  assert.match(ir, /7/, 'называет длину серии');
  const rr = eventToMessage({ type: 'repo-recovered', repo: 'o/r', consecutive: 3, error: '500' }, OPTS);
  assert.match(rr, /o\/r/);
  assert.equal(eventToMessage({ type: 'repo-recovered', repo: 'o/r', consecutive: 1 }, OPTS), null);
});

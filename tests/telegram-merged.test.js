import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToMessage } from '../src/notify/telegram.js';

const OPTS = { monUrl: 'https://mon.adarasoft.com', repo: 'bronxtc52/midas' };

test('eventToMessage: merged → «зашипена» + номер PR + ссылка на PR + строка здоровья', () => {
  const m = eventToMessage(
    { type: 'merged', repo: 'bronxtc52/server-watchdog', issue: 20, pr: 21, health: 'up (HTTP 200)' },
    OPTS,
  );
  assert.match(m, /зашипена/, 'есть слово «зашипена»');
  assert.match(m, /#21/, 'номер PR');
  assert.match(m, /server-watchdog\/pull\/21/, 'ссылка на PR (не на issue)');
  assert.doesNotMatch(m, /issues\/20/, 'НЕ ссылка на issue');
  assert.match(m, /Сервис bronxtc52\/server-watchdog: up \(HTTP 200\)/, 'строка здоровья');
});

test('eventToMessage: merged НЕ утверждает «деплой прошёл» (только живость сервиса)', () => {
  const up = eventToMessage({ type: 'merged', repo: 'o/r', issue: 1, pr: 2, health: 'up (HTTP 200)' }, OPTS);
  const down = eventToMessage({ type: 'merged', repo: 'o/r', issue: 1, pr: 2, health: 'down (недоступен)' }, OPTS);
  for (const m of [up, down]) {
    assert.doesNotMatch(m, /деплой/i, 'сообщение не говорит про деплой');
    assert.doesNotMatch(m, /задеплоен|раскатан|развёрнут/i, 'нет намёков на завершённый деплой');
  }
});

test('eventToMessage: merged без health → «не настроен»', () => {
  const m = eventToMessage({ type: 'merged', repo: 'o/r', issue: 1, pr: 2 }, OPTS);
  assert.match(m, /Сервис o\/r: не настроен/);
});

test('eventToMessage: merged без pr → фолбэк на issue, не падает', () => {
  const m = eventToMessage({ type: 'merged', repo: 'o/r', issue: 9, health: 'не настроен' }, OPTS);
  assert.equal(typeof m, 'string');
  assert.match(m, /зашипена/);
  assert.match(m, /issues\/9/, 'без pr ведём на issue');
});

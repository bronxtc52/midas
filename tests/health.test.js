import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthSnapshot } from '../src/health.js';

test('health: нет URL → «не настроен», fetch не вызывается', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { status: 200 }; };
  assert.equal(await healthSnapshot(undefined, { fetchImpl }), 'не настроен');
  assert.equal(await healthSnapshot('', { fetchImpl }), 'не настроен');
  assert.equal(called, false, 'без URL сеть не трогаем');
});

test('health: HTTP 200 → «up (HTTP 200)»', async () => {
  const fetchImpl = async () => ({ status: 200 });
  assert.equal(await healthSnapshot('https://x', { fetchImpl }), 'up (HTTP 200)');
});

test('health: HTTP <N> (не 200) → «down (HTTP N)»', async () => {
  const fetchImpl = async () => ({ status: 503 });
  assert.equal(await healthSnapshot('https://x', { fetchImpl }), 'down (HTTP 503)');
});

test('health: сетевая ошибка → «down (недоступен)», не пробрасывается', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.doesNotReject(() => healthSnapshot('https://x', { fetchImpl }));
  assert.equal(await healthSnapshot('https://x', { fetchImpl }), 'down (недоступен)');
});

test('health: таймаут (abort) → «down (недоступен)», не подвешивает', async () => {
  // fetch, уважающий signal: висит, пока не придёт abort по таймауту.
  const fetchImpl = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  assert.equal(await healthSnapshot('https://x', { fetchImpl, timeoutMs: 20 }), 'down (недоступен)');
});

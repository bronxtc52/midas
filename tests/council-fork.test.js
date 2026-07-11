import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForkFromSession, parseBlockedFromSession } from '../src/blocked.js';
import { directDeepseekExec, askCouncil } from '../src/council.js';

test('parseForkFromSession: валидный FORK-JSON → объект', () => {
  const out = 'рассуждения\nFORK: {"question":"монолит или воркеры?","known":"оба реализуемы","options":["A) монолит","B) воркеры"],"recommendation":"A"}';
  const f = parseForkFromSession(out);
  assert.equal(f.question, 'монолит или воркеры?');
  assert.equal(f.options.length, 2);
});

test('parseForkFromSession: без options или с 1 вариантом → null', () => {
  assert.equal(parseForkFromSession('FORK: {"question":"q","recommendation":"A"}'), null);
  assert.equal(parseForkFromSession('FORK: {"question":"q","options":["A) x"]}'), null);
  assert.equal(parseForkFromSession('FORK: {"options":["A) x","B) y"]}'), null, 'без question → null');
});

test('parseForkFromSession: не-FORK текст / битый JSON → null', () => {
  assert.equal(parseForkFromSession('обычный план без развилки'), null);
  assert.equal(parseForkFromSession('FORK: {"question":"q",'), null);
});

test('FORK и BLOCKED парсятся раздельно', () => {
  const fork = 'FORK: {"question":"q","options":["A) x","B) y"]}';
  const blocked = 'BLOCKED: {"question":"q","options":["A) x","B) y"]}';
  assert.ok(parseForkFromSession(fork));
  assert.equal(parseBlockedFromSession(fork), null, 'FORK не парсится как BLOCKED');
  assert.ok(parseBlockedFromSession(blocked));
  assert.equal(parseForkFromSession(blocked), null, 'BLOCKED не парсится как FORK');
});

test('directDeepseekExec: успех — модель из slug, Bearer-ключ, temperature 0, возвращает content', async () => {
  const orig = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'мнение совета' } }] }) };
  };
  try {
    const exec = directDeepseekExec('secret-key');
    const answer = await exec({ question: 'чистый вопрос', slug: 'deepseek-direct/deepseek-v4-pro' });
    assert.equal(answer, 'мнение совета');
    assert.equal(seen.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(seen.opts.headers.authorization, 'Bearer secret-key');
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.model, 'deepseek-v4-pro', 'модель = часть slug после deepseek-direct/');
    assert.equal(body.temperature, 0);
    assert.ok(body.max_tokens >= 8000, 'max_tokens не занижен для reasoning-модели');
  } finally {
    global.fetch = orig;
  }
});

test('directDeepseekExec: пустой ответ → throw', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
  try {
    const exec = directDeepseekExec('k');
    await assert.rejects(() => exec({ question: 'q', slug: 'deepseek-direct/deepseek-v4-pro' }));
  } finally {
    global.fetch = orig;
  }
});

test('askCouncil: slug deepseek-direct + env-ключ → direct-exec, успех', async () => {
  const orig = global.fetch;
  const origKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'k';
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok-answer' } }] }) });
  try {
    const r = await askCouncil({ question: 'чистый вопрос', slug: 'deepseek-direct/deepseek-v4-pro', capUsd: 1 });
    assert.deepEqual(r, { ok: true, answer: 'ok-answer' });
  } finally {
    global.fetch = orig;
    if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = origKey;
  }
});

test('askCouncil: сетевая ошибка direct-exec → unavailable (не бросает)', async () => {
  const orig = global.fetch;
  const origKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'k';
  global.fetch = async () => { throw new Error('ENETUNREACH'); };
  try {
    const r = await askCouncil({ question: 'чистый вопрос', slug: 'deepseek-direct/deepseek-v4-pro', capUsd: 1 });
    assert.deepEqual(r, { ok: false, reason: 'unavailable' });
  } finally {
    global.fetch = orig;
    if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = origKey;
  }
});

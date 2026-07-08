import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBlocked, parseBlockedFromSession } from '../src/blocked.js';
import { containsSecret, askCouncil } from '../src/council.js';
import { loadConfig } from '../src/config.js';

test('formatBlocked: канонический формат Конституции §3', () => {
  const s = formatBlocked({ question: 'Куда деплоить?', known: 'A и B равнозначны', options: ['A) mh-central', 'B) новая VM'], recommendation: 'A, дешевле' });
  assert.match(s, /^## ⛔ BLOCKED/m);
  assert.match(s, /^Вопрос: Куда деплоить\?/m);
  assert.match(s, /^Известно: /m);
  assert.match(s, /^Варианты: A\) mh-central B\) новая VM \(рекомендация: A, дешевле\)/m);
});

test('parseBlockedFromSession: маркер BLOCKED в выводе сессии → объект, иначе null', () => {
  const out = 'что-то\nBLOCKED: {"question":"q","known":"k","options":["A) x","B) y"],"recommendation":"A"}';
  assert.deepEqual(parseBlockedFromSession(out).question, 'q');
  assert.equal(parseBlockedFromSession('всё сделал'), null);
});

test('containsSecret ловит типовые секреты и не даёт ложняка на обычном тексте', () => {
  for (const bad of ['key sk-ant-api03-abc', 'token ghp_abcdef1234567890abcdef1234567890abcd', 'github_pat_11AAA', 'AKIAIOSFODNN7EXAMPLE', '-----BEGIN OPENSSH PRIVATE KEY-----', 'password=hunter2']) {
    assert.equal(containsSecret(bad), true, bad);
  }
  assert.equal(containsSecret('обычный архитектурный вопрос про state-лейблы и polling'), false);
});

test('askCouncil: секрет в вопросе → отказ без вызова CLI', async () => {
  let called = false;
  const r = await askCouncil({ question: 'вот ключ sk-ant-api03-xyz, что делать?', slug: 's', capUsd: 1, exec: async () => { called = true; } });
  assert.deepEqual(r, { ok: false, reason: 'secret-detected' });
  assert.equal(called, false);
});

test('askCouncil: CLI недоступен → деградация unavailable (не бросает)', async () => {
  const r = await askCouncil({ question: 'чистый вопрос', slug: 's', capUsd: 1, exec: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(r, { ok: false, reason: 'unavailable' });
});

test('askCouncil: успех возвращает ответ', async () => {
  const r = await askCouncil({ question: 'чистый вопрос', slug: 's', capUsd: 1, exec: async () => 'ответ совета' });
  assert.deepEqual(r, { ok: true, answer: 'ответ совета' });
});

test('loadConfig: дефолты из config.json + env-оверрайд интервала', () => {
  const d = mkdtempSync(join(tmpdir(), 'midas-cfg-'));
  writeFileSync(join(d, 'config.json'), JSON.stringify({ repos_allowlist: ['o/r'], poll_interval_sec: 45, labels: { ready: 'midas:state:ready' } }));
  const c1 = loadConfig(d, {});
  assert.equal(c1.poll_interval_sec, 45);
  const c2 = loadConfig(d, { MIDAS_POLL_INTERVAL_SEC: '10' });
  assert.equal(c2.poll_interval_sec, 10);
  assert.deepEqual(c2.repos_allowlist, ['o/r']);
});

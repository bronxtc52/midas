import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { eventToMessage, makeTelegramNotifier } from '../src/notify/telegram.js';

const here = dirname(fileURLToPath(import.meta.url));
const OPTS = { monUrl: 'https://mon.adarasoft.com', repo: 'bronxtc52/midas' };

// --- eventToMessage: чистый маппер журнал-событие → строка|null (крит. 1–4) ---

test('eventToMessage: значимое (work-done) → строка; шум → null', () => {
  assert.equal(typeof eventToMessage({ type: 'work-done', task: 'bronxtc52/midas#5', pr: 7 }, OPTS), 'string');
  for (const t of ['processed', 'cost', 'race-skip', 'daemon-start', 'review-no-pr', 'cost-unknown', 'plan-invalid']) {
    assert.equal(eventToMessage({ type: t }, OPTS), null, `${t} — шум, должен быть null`);
  }
});

test('eventToMessage: action planned/accepted/rejected → строки; awaiting-approval и review → null (без дублей)', () => {
  const mk = (result) => eventToMessage({ type: 'action', action: 'x', repo: 'bronxtc52/midas', issue: 5, result }, OPTS);
  assert.match(mk('planned'), /план/i);
  assert.match(mk('accepted'), /принят/i);
  assert.match(mk('rejected'), /отклон|возврат/i);
  assert.equal(mk('awaiting-approval'), null, 'awaiting-approval репортится спец-событием, не action');
  assert.equal(mk('review'), null, 'про PR уже сообщил work-done');
});

test('eventToMessage: awaiting-approval → ссылка на mon + цель плана + номер issue', () => {
  const m = eventToMessage({ type: 'awaiting-approval', issue: 5, title: 'Моя задача', goal: 'сделать X' }, OPTS);
  assert.match(m, /mon\.adarasoft\.com/, 'есть ссылка на mon');
  assert.match(m, /сделать X/, 'есть цель плана');
  assert.match(m, /\b5\b/, 'есть номер issue');
});

test('eventToMessage: blocked/ci-gate-red/daily-cap-pause/tick-error', () => {
  assert.match(eventToMessage({ type: 'blocked', task: 'bronxtc52/midas#5', question: 'что делать?' }, OPTS), /что делать\?/);
  assert.match(eventToMessage({ type: 'ci-gate-red', repo: 'bronxtc52/midas', issue: 5, sha: 'abc' }, OPTS), /CI/i);
  assert.match(eventToMessage({ type: 'daily-cap-pause', day: '2026-07-08' }, OPTS), /кап/i);
  assert.match(eventToMessage({ type: 'tick-error', error: 'boom-scrubbed' }, OPTS), /boom-scrubbed/);
});

// --- makeTelegramNotifier (крит. 5–7) ---

function mockFetch() {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => 'ok' }; };
  return { fetch, calls };
}

test('notifier: без token → no-op, fetch не вызывается', async () => {
  const { fetch, calls } = mockFetch();
  const n = makeTelegramNotifier({ token: '', chatId: '123', ...OPTS, fetch });
  await n.onEvent({ type: 'work-done', task: 'o/r#5', pr: 7 });
  assert.equal(calls.length, 0);
});

test('notifier: без chatId → no-op, fetch не вызывается', async () => {
  const { fetch, calls } = mockFetch();
  const n = makeTelegramNotifier({ token: 'TOK', chatId: '', ...OPTS, fetch });
  await n.onEvent({ type: 'work-done', task: 'o/r#5', pr: 7 });
  assert.equal(calls.length, 0);
});

test('notifier: значимое событие → ровно один POST sendMessage plain-text (без parse_mode)', async () => {
  const { fetch, calls } = mockFetch();
  const n = makeTelegramNotifier({ token: 'TOK', chatId: '201374791', ...OPTS, fetch });
  await n.onEvent({ type: 'work-done', task: 'bronxtc52/midas#5', pr: 7 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/bot/, 'Bot API URL');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(String(body.chat_id), '201374791');
  assert.ok(body.text && body.text.length > 0);
  assert.equal(body.parse_mode, undefined, 'без parse_mode (plain text — обходим HTML-грабли)');
});

test('notifier: null-событие (шум) → fetch не вызывается', async () => {
  const { fetch, calls } = mockFetch();
  const n = makeTelegramNotifier({ token: 'TOK', chatId: '1', ...OPTS, fetch });
  await n.onEvent({ type: 'processed', key: 'x' });
  assert.equal(calls.length, 0);
});

test('notifier: ошибка fetch проглатывается, не пробрасывается (доставка не роняет tick)', async () => {
  const logs = [];
  const n = makeTelegramNotifier({
    token: 'TOK', chatId: '1', ...OPTS,
    fetch: async () => { throw new Error('network down'); },
    log: (m) => logs.push(m),
  });
  await assert.doesNotReject(() => n.onEvent({ type: 'work-done', task: 'o/r#5', pr: 7 }));
  assert.ok(logs.length >= 1, 'ошибка залогирована');
  assert.ok(!logs.join(' ').includes('TOK'), 'токен не попадает в лог');
});

// --- notify-only граница (крит. 13) + zero-dep (крит. 14) ---

test('notify-only: в src нет ВХОДЯЩИХ Telegram-примитивов (кнопки/апдейты/webhook)', () => {
  const forbidden = /getUpdates|setWebhook|answerCallbackQuery|inline_keyboard|reply_markup|callback_query/;
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(join(here, '..', 'src')).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), forbidden, `${f} — входящий Telegram-примитив запрещён (notify-only тип B)`);
  }
});

test('zero-dep: новых npm-зависимостей для Telegram нет', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), ['@sentry/node'], 'dependencies не расширен под Telegram');
});

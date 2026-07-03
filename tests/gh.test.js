import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGh } from '../src/gh.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if (r.match(String(url), opts.method || 'GET')) {
        const res = typeof r.res === 'function' ? r.res(calls) : r.res;
        return {
          ok: res.status < 400, status: res.status,
          headers: { get: (h) => (res.headers || {})[h.toLowerCase()] ?? null },
          json: async () => res.json ?? {}, text: async () => JSON.stringify(res.json ?? {}),
        };
      }
    }
    throw new Error('unmatched route: ' + url);
  };
  return { impl, calls };
}

test('listIssues: label-фильтр и since уходят в query', async () => {
  const { impl, calls } = fakeFetch([{ match: (u) => u.includes('/issues'), res: { status: 200, json: [{ number: 1 }] } }]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  const out = await gh.listIssues('o/r', { label: 'state:ready', since: '2026-07-03T00:00:00Z' });
  assert.deepEqual(out, [{ number: 1 }]);
  assert.match(calls[0].url, /repos\/o\/r\/issues/);
  assert.match(calls[0].url, /labels=state%3Aready|labels=state:ready/);
  assert.match(calls[0].url, /since=/);
});

test('transitionState: optimistic — state сменился между опросом и PATCH → skipped, PUT labels не зовётся', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u, m) => m === 'GET' && /issues\/7$/.test(u), res: { status: 200, json: { number: 7, labels: [{ name: 'state:coding' }] } } },
    { match: (u, m) => m === 'PUT', res: { status: 200, json: [] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  const r = await gh.transitionState('o/r', 7, 'state:ready', 'state:planning');
  assert.deepEqual(r, { skipped: true, current: 'state:coding' });
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'labels не переписаны при гонке');
});

test('transitionState: совпало → заменяет только state-лейбл, прочие сохраняет', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u, m) => m === 'GET' && /issues\/7$/.test(u), res: { status: 200, json: { number: 7, labels: [{ name: 'bug' }, { name: 'state:ready' }] } } },
    { match: (u, m) => m === 'PUT' && /issues\/7\/labels$/.test(u), res: { status: 200, json: [] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  const r = await gh.transitionState('o/r', 7, 'state:ready', 'state:planning');
  assert.deepEqual(r, { ok: true });
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body.labels.sort(), ['bug', 'state:planning']);
});

test('rate-limit: 403 c remaining=0 → ждёт до reset (не дольше капа) и ретраит один раз', async () => {
  let n = 0;
  const { impl } = fakeFetch([{
    match: (u) => u.includes('/issues'),
    res: () => (++n === 1
      ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1) } }
      : { status: 200, json: [] }),
  }]);
  const waits = [];
  const gh = makeGh({ token: 't', fetchImpl: impl, sleep: async (ms) => { waits.push(ms); } });
  const out = await gh.listIssues('o/r', { label: 'x' });
  assert.deepEqual(out, []);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= 60_000, 'ожидание ограничено капом');
});

test('createPR и getCheckRuns: green/red/pending', async () => {
  const mk = (runs) => fakeFetch([
    { match: (u, m) => m === 'POST' && /pulls$/.test(u), res: { status: 201, json: { number: 9, html_url: 'x' } } },
    { match: (u) => u.includes('/check-runs'), res: { status: 200, json: { check_runs: runs } } },
  ]);
  let f = mk([{ status: 'completed', conclusion: 'success' }]);
  let gh = makeGh({ token: 't', fetchImpl: f.impl });
  assert.equal((await gh.createPR('o/r', { title: 't', head: 'h', base: 'main', body: 'b' })).number, 9);
  assert.equal(await gh.checksStatus('o/r', 'abc'), 'green');
  f = mk([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]);
  gh = makeGh({ token: 't', fetchImpl: f.impl });
  assert.equal(await gh.checksStatus('o/r', 'abc'), 'red');
  f = mk([{ status: 'in_progress', conclusion: null }]);
  gh = makeGh({ token: 't', fetchImpl: f.impl });
  assert.equal(await gh.checksStatus('o/r', 'abc'), 'pending');
  f = mk([]);
  gh = makeGh({ token: 't', fetchImpl: f.impl });
  assert.equal(await gh.checksStatus('o/r', 'abc'), 'none', 'нет чеков = none (решает демон по возрасту PR)');
});

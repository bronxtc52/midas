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
  const out = await gh.listIssues('o/r', { label: 'midas:state:ready', since: '2026-07-03T00:00:00Z' });
  assert.deepEqual(out, [{ number: 1 }]);
  assert.match(calls[0].url, /repos\/o\/r\/issues/);
  assert.match(calls[0].url, /labels=midas%3Astate%3Aready/);
  assert.match(calls[0].url, /since=/);
});

test('transitionState: optimistic — state сменился между опросом и PATCH → skipped, PUT labels не зовётся', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u, m) => m === 'GET' && /issues\/7$/.test(u), res: { status: 200, json: { number: 7, labels: [{ name: 'midas:state:coding' }] } } },
    { match: (u, m) => m === 'PUT', res: { status: 200, json: [] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  const r = await gh.transitionState('o/r', 7, 'midas:state:ready', 'midas:state:planning');
  assert.deepEqual(r, { skipped: true, current: 'midas:state:coding' });
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'labels не переписаны при гонке');
});

test('transitionState: совпало → хирургически DELETE from + POST to, чужие лейблы не переписываются', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u, m) => m === 'GET' && /issues\/7$/.test(u), res: { status: 200, json: { number: 7, labels: [{ name: 'bug' }, { name: 'midas:state:ready' }] } } },
    { match: (u, m) => m === 'DELETE', res: { status: 200, json: {} } },
    { match: (u, m) => m === 'POST' && /issues\/7\/labels$/.test(u), res: { status: 200, json: [] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  const r = await gh.transitionState('o/r', 7, 'midas:state:ready', 'midas:state:planning');
  assert.deepEqual(r, { ok: true });
  assert.ok(calls.some((c) => c.method === 'DELETE' && /labels\/midas%3Astate%3Aready$/.test(c.url)), 'снят только from-лейбл');
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body.labels, ['midas:state:planning']);
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'PUT всего списка не используется');
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

// 403 от Checks API (скрытое право checks:read не распространяется на репо,
// добавленные в fine-grained PAT после выпуска) → фолбэк на Actions API
test('checksStatus: 403 check-runs → фолбэк на /actions/runs по head_sha', async () => {
  const mk = (workflowRuns) => fakeFetch([
    { match: (u) => u.includes('/check-runs'), res: { status: 403, json: { message: 'Resource not accessible by personal access token' } } },
    { match: (u) => u.includes('/actions/runs?') || u.includes('/actions/runs&'), res: { status: 200, json: { workflow_runs: workflowRuns } } },
  ]);
  let f = mk([{ status: 'completed', conclusion: 'success' }]);
  assert.equal(await makeGh({ token: 't', fetchImpl: f.impl }).checksStatus('o/r', 'abc'), 'green');
  assert.match(f.calls.at(-1).url, /head_sha=abc/, 'Actions-фолбэк фильтрует по head_sha');
  f = mk([{ status: 'completed', conclusion: 'failure' }]);
  assert.equal(await makeGh({ token: 't', fetchImpl: f.impl }).checksStatus('o/r', 'abc'), 'red');
  f = mk([{ status: 'in_progress', conclusion: null }]);
  assert.equal(await makeGh({ token: 't', fetchImpl: f.impl }).checksStatus('o/r', 'abc'), 'pending');
  f = mk([]);
  assert.equal(await makeGh({ token: 't', fetchImpl: f.impl }).checksStatus('o/r', 'abc'), 'none');
});

test('checksStatus: не-403 ошибка check-runs НЕ маскируется фолбэком', async () => {
  const { impl } = fakeFetch([
    { match: (u) => u.includes('/check-runs'), res: { status: 500, json: {} } },
  ]);
  await assert.rejects(() => makeGh({ token: 't', fetchImpl: impl }).checksStatus('o/r', 'abc'), /500/);
});

test('failedChecks: 403 → красные Actions-раны разворачиваются в упавшие jobs (id job годен для лога)', async () => {
  const { impl } = fakeFetch([
    { match: (u) => u.includes('/check-runs'), res: { status: 403, json: {} } },
    { match: (u) => u.includes('/actions/runs?') || /actions\/runs\?/.test(u), res: { status: 200, json: { workflow_runs: [
      { id: 11, name: 'tests', status: 'completed', conclusion: 'failure' },
      { id: 12, name: 'deploy', status: 'completed', conclusion: 'success' },
    ] } } },
    { match: (u) => u.includes('/actions/runs/11/jobs'), res: { status: 200, json: { jobs: [
      { id: 111, name: 'pipeline', conclusion: 'failure' },
      { id: 112, name: 'web', conclusion: 'success' },
    ] } } },
  ]);
  const out = await makeGh({ token: 't', fetchImpl: impl }).failedChecks('o/r', 'abc');
  assert.deepEqual(out, [{ name: 'tests / pipeline', summary: '', id: 111 }]);
});

test('getDefaultBranch: возвращает default_branch из GET /repos/{repo}', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u, m) => m === 'GET' && /\/repos\/o\/r$/.test(u), res: { status: 200, json: { default_branch: 'master' } } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  assert.equal(await gh.getDefaultBranch('o/r'), 'master');
  assert.equal(calls.length, 1);
});

test('getDefaultBranch: кэш — второй вызов того же repo без повторного запроса', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u, m) => m === 'GET' && /\/repos\/o\/r$/.test(u), res: { status: 200, json: { default_branch: 'main' } } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  await gh.getDefaultBranch('o/r');
  await gh.getDefaultBranch('o/r');
  assert.equal(calls.length, 1, 'один сетевой запрос на два вызова (кэш)');
});

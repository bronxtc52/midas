import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGh } from '../src/gh.js';

// Тот же fake-fetch, что и в gh.test.js: маршруты по url+method.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    for (const r of routes) {
      if (r.match(String(url), opts.method || 'GET')) {
        const res = typeof r.res === 'function' ? r.res(calls) : r.res;
        return {
          ok: res.status < 400, status: res.status,
          headers: { get: () => null },
          json: async () => res.json ?? {}, text: async () => JSON.stringify(res.json ?? {}),
        };
      }
    }
    throw new Error('unmatched route: ' + url);
  };
  return { impl, calls };
}

test('isPRMerged: PR с merged_at → merged:true и его номер', async () => {
  const { impl, calls } = fakeFetch([
    { match: (u) => /\/pulls\?/.test(u), res: { status: 200, json: [{ number: 42, merged_at: '2026-07-08T10:00:00Z' }] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  assert.deepEqual(await gh.isPRMerged('o/r', 'midas/issue-42'), { merged: true, number: 42 });
  // Запрос по head-ветке и включая закрытые PR (state=all).
  assert.match(calls[0].url, /head=o%3Amidas%2Fissue-42/);
  assert.match(calls[0].url, /state=all/);
});

test('isPRMerged: открытый PR (merged_at=null) → merged:false', async () => {
  const { impl } = fakeFetch([
    { match: (u) => /\/pulls\?/.test(u), res: { status: 200, json: [{ number: 42, merged_at: null }] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  assert.deepEqual(await gh.isPRMerged('o/r', 'midas/issue-42'), { merged: false, number: 42 });
});

test('isPRMerged: PR закрыт БЕЗ мерджа (merged_at отсутствует) → merged:false', async () => {
  const { impl } = fakeFetch([
    { match: (u) => /\/pulls\?/.test(u), res: { status: 200, json: [{ number: 42, state: 'closed' }] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  assert.deepEqual(await gh.isPRMerged('o/r', 'midas/issue-42'), { merged: false, number: 42 });
});

test('isPRMerged: PR по ветке нет → merged:false, number:null', async () => {
  const { impl } = fakeFetch([
    { match: (u) => /\/pulls\?/.test(u), res: { status: 200, json: [] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  assert.deepEqual(await gh.isPRMerged('o/r', 'midas/issue-99'), { merged: false, number: null });
});

test('isPRMerged: несколько PR на ветке → берём смерженный', async () => {
  const { impl } = fakeFetch([
    { match: (u) => /\/pulls\?/.test(u), res: { status: 200, json: [
      { number: 10, merged_at: null, state: 'closed' },
      { number: 11, merged_at: '2026-07-08T10:00:00Z' },
    ] } },
  ]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  assert.deepEqual(await gh.isPRMerged('o/r', 'midas/issue-1'), { merged: true, number: 11 });
});

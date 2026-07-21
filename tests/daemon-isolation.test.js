import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';
import { makeDaemon } from '../src/daemon.js';

// Репро инцидента 2026-07-21: 403 на check-runs businessman ронял ВЕСЬ tick
// (203 tick-error подряд) — ни одно issue ни в одном репо не обрабатывалось.
// Ошибка одной задачи/одного репо должна изолироваться, а не валить конвейер.

const CONFIG = {
  repos_allowlist: ['o/a', 'o/b'], poll_interval_sec: 45,
  cost_cap_usd_per_task: 5, cost_cap_usd_per_day: 20,
  labels: { ready: 'midas:state:ready', planning: 'midas:state:planning', coding: 'midas:state:coding', review: 'midas:state:review', blocked: 'midas:state:blocked', accepted: 'midas:state:accepted', rejected: 'midas:state:rejected', accept: 'midas:accept', reject: 'midas:reject' },
};

const issue = (n, state, updated = '2026-07-21T09:00:00Z') => ({ number: n, title: 't', body: 'b', labels: [{ name: state }], updated_at: updated, pull_request: undefined });

function makeHarness({ issuesByRepo, checksImpl, now }) {
  const calls = [];
  const gh = {
    listUpdatedIssues: async (repo) => {
      const v = issuesByRepo[repo];
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    listIssues: async (repo, { label }) => {
      const v = issuesByRepo[repo];
      if (v instanceof Error) return [];
      return (v ?? []).filter((i) => i.labels.some((l) => l.name === label));
    },
    getIssue: async (repo, n) => { calls.push(['getIssue', repo, n]); return (issuesByRepo[repo] ?? []).find((i) => i.number === n); },
    transitionState: async (repo, n, from, to) => { calls.push(['transition', repo, n, to]); return { ok: true }; },
    addComment: async () => {},
    getPRForBranch: async (repo, branch) => ({ number: 90, head: { sha: 'abc', ref: branch }, created_at: '2026-07-03T00:00:00Z' }),
    checksStatus: checksImpl ?? (async () => 'green'),
  };
  const keeper = makeKeeper(mkdtempSync(join(tmpdir(), 'midas-iso-')), { now: () => '2026-07-21T10:00:00Z' });
  const roles = {
    plan: async (a) => { calls.push(['role:plan', a.repo, a.issue.number]); return { status: 'planned' }; },
    work: async (a) => { calls.push(['role:work', a.repo, a.issue.number]); return { status: 'review' }; },
    review: async (a) => { calls.push(['role:review', a.repo, a.issue.number]); return { status: 'accepted' }; },
  };
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles, log: () => {}, heartbeat: () => {}, ...(now ? { now } : {}) });
  return { calls, daemon, keeper };
}

test('изоляция issue: 403 на checksStatus одного issue не мешает обработке следующего в том же репо', async () => {
  const { calls, daemon, keeper } = makeHarness({
    issuesByRepo: { 'o/a': [issue(1, 'midas:state:review'), issue(2, 'midas:state:ready', '2026-07-21T09:05:00Z')], 'o/b': [] },
    checksImpl: async () => { throw new Error('GitHub GET /repos/o/a/commits/abc/check-runs?per_page=100 → 403'); },
  });
  await daemon.tick();
  assert.ok(calls.some((c) => c[0] === 'role:plan' && c[2] === 2), 'issue#2 обработан несмотря на 403 у issue#1');
  const errs = keeper.readAll().filter((e) => e.type === 'issue-error');
  assert.equal(errs.length, 1, 'ошибка issue#1 зафиксирована в журнале как issue-error');
  assert.match(errs[0].error, /403/);
});

test('изоляция репо: падение выборки одного репо не мешает обработке следующего репо', async () => {
  const { calls, daemon, keeper } = makeHarness({
    issuesByRepo: { 'o/a': new Error('GitHub GET /repos/o/a/issues → 500'), 'o/b': [issue(7, 'midas:state:ready')] },
  });
  await daemon.tick();
  assert.ok(calls.some((c) => c[0] === 'role:plan' && c[1] === 'o/b' && c[2] === 7), 'репо o/b обработан несмотря на 500 у o/a');
  const errs = keeper.readAll().filter((e) => e.type === 'repo-error');
  assert.equal(errs.length, 1, 'ошибка репо o/a зафиксирована в журнале как repo-error');
});

test('изоляция issue: курсор НЕ уезжает за упавший issue — на следующем тике он ретраится', async () => {
  let fail = true;
  const { calls, daemon, keeper } = makeHarness({
    issuesByRepo: { 'o/a': [issue(1, 'midas:state:review', '2026-07-21T09:10:00Z'), issue(2, 'midas:state:ready', '2026-07-21T09:05:00Z')], 'o/b': [] },
    checksImpl: async () => { if (fail) throw new Error('check-runs → 403'); return 'green'; },
  });
  await daemon.tick();
  const cur = keeper.getCursor('o/a');
  assert.ok(!cur || new Date(cur) < new Date('2026-07-21T09:10:00Z'),
    `курсор (${cur}) не должен пройти updated_at упавшего issue#1`);
  fail = false;
  await daemon.tick();
  assert.ok(calls.some((c) => c[0] === 'role:review' && c[2] === 1), 'после восстановления issue#1 дообработан');
});

test('кулдаун ретрая: после 2-й ошибки подряд issue скипается без API-вызовов до истечения бэкоффа', async () => {
  // Бэкофф САМОГО ретрая (must-fix ревью плана): 1-я ошибка → ретрай следующим тиком,
  // 2-я подряд → кулдаун poll_interval*2 (90с при 45с), скип ДО getIssue (ноль API-вызовов).
  let t = 0;
  const { calls, daemon, keeper } = makeHarness({
    issuesByRepo: { 'o/a': [issue(1, 'midas:state:review')], 'o/b': [] },
    checksImpl: async () => { throw new Error('check-runs → 403'); },
    now: () => t,
  });
  const getIssues = () => calls.filter((c) => c[0] === 'getIssue' && c[2] === 1).length;
  await daemon.tick({ today: '2026-07-21' });          // t=0: ошибка №1 → ретрай следующим тиком
  t = 45_000; await daemon.tick({ today: '2026-07-21' }); // ошибка №2 → кулдаун 90с (до t=135с)
  assert.equal(getIssues(), 2, 'первые два тика — реальные попытки');
  t = 90_000; await daemon.tick({ today: '2026-07-21' }); // внутри кулдауна
  assert.equal(getIssues(), 2, 'внутри кулдауна ретрая нет — getIssue не зовётся');
  assert.equal(keeper.readAll().filter((e) => e.type === 'issue-error').length, 2,
    'скип по кулдауну не пишет новых issue-error');
  t = 140_000; await daemon.tick({ today: '2026-07-21' }); // кулдаун истёк
  assert.equal(getIssues(), 3, 'после кулдауна попытка повторяется');
});

test('issue-recovered: после серии >=2 ошибок успех пишет парное событие с consecutive', async () => {
  let t = 0; let fail = true;
  const { daemon, keeper } = makeHarness({
    issuesByRepo: { 'o/a': [issue(1, 'midas:state:review')], 'o/b': [] },
    checksImpl: async () => { if (fail) throw new Error('check-runs → 403'); return 'green'; },
    now: () => t,
  });
  await daemon.tick({ today: '2026-07-21' });
  t = 45_000; await daemon.tick({ today: '2026-07-21' });
  fail = false;
  t = 200_000; await daemon.tick({ today: '2026-07-21' });
  const rec = keeper.readAll().filter((e) => e.type === 'issue-recovered');
  assert.equal(rec.length, 1, 'ровно одно issue-recovered');
  assert.equal(rec[0].consecutive, 2, 'recovery называет длину серии');
});

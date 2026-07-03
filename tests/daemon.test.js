import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';
import { makeDaemon } from '../src/daemon.js';

const CONFIG = {
  repos_allowlist: ['o/r'], poll_interval_sec: 45,
  cost_cap_usd_per_task: 5, cost_cap_usd_per_day: 20,
  labels: { ready: 'state:ready', planning: 'state:planning', coding: 'state:coding', review: 'state:review', blocked: 'state:blocked', accepted: 'state:accepted', rejected: 'state:rejected', accept: 'midas:accept', reject: 'midas:reject' },
};

function harness({ issues = [], checks = 'green', transition = { ok: true } } = {}) {
  const calls = [];
  const gh = {
    listUpdatedIssues: async (repo, since) => { calls.push(['list', repo, since]); return issues; },
    getIssue: async (repo, n) => { calls.push(['getIssue', n]); return issues.find(i => i.number === n); },
    transitionState: async (repo, n, from, to) => { calls.push(['transition', n, from, to]); return transition; },
    addComment: async (repo, n, body) => { calls.push(['comment', n, body]); },
    getPRForBranch: async (repo, branch) => { calls.push(['getPR', branch]); return { number: 90, head: { sha: 'abc', ref: branch }, html_url: 'u' }; },
    checksStatus: async (repo, sha) => { calls.push(['checks', sha]); return checks; },
  };
  const keeper = makeKeeper(mkdtempSync(join(tmpdir(), 'midas-d-')), { now: () => '2026-07-03T10:00:00Z' });
  const roles = {
    plan: async (a) => { calls.push(['role:plan', a.issue.number]); return { status: 'planned' }; },
    work: async (a) => { calls.push(['role:work', a.issue.number]); return { status: 'review' }; },
    review: async (a) => { calls.push(['role:review', a.issue.number]); return { status: 'accepted' }; },
  };
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles, log: () => {}, heartbeat: () => {} });
  return { calls, daemon, keeper };
}

const issue = (n, state, updated = '2026-07-03T09:00:00Z') => ({ number: n, title: 't', body: 'b', labels: [{ name: state }], updated_at: updated, pull_request: undefined });

test('ready: label-first — переход в planning ДО вызова роли', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'state:ready')] });
  await daemon.tick();
  const ti = calls.findIndex(c => c[0] === 'transition' && c[3] === 'state:planning');
  const ri = calls.findIndex(c => c[0] === 'role:plan');
  assert.ok(ti !== -1 && ri !== -1, 'оба вызова были');
  assert.ok(ti < ri, 'сначала лейбл, потом роль');
});

test('гонка: transitionState вернул skipped → роль НЕ вызывается', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'state:ready')], transition: { skipped: true, current: 'state:coding' } });
  await daemon.tick();
  assert.ok(!calls.some(c => c[0] === 'role:plan'), 'роль не тронута при гонке');
});

test('blocked игнорируется автоматикой', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'state:blocked')] });
  await daemon.tick();
  assert.ok(!calls.some(c => String(c[0]).startsWith('role:')));
  assert.ok(!calls.some(c => c[0] === 'transition'));
});

test('дедуп: успешно завершённое действие не перезапускается на следующем tick', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'state:review')] });
  await daemon.tick();
  const n1 = calls.filter(c => c[0] === 'role:review').length;
  assert.equal(n1, 1);
  await daemon.tick();
  const n2 = calls.filter(c => c[0] === 'role:review').length;
  assert.equal(n2, 1, 'повторный tick не дублирует завершённое ревью');
});

test('CI-гейт: красные чеки → возврат в coding с комментарием, ревью не зовётся', async () => {
  const { calls, daemon } = harness({ issues: [issue(2, 'state:review')], checks: 'red' });
  await daemon.tick();
  assert.ok(!calls.some(c => c[0] === 'role:review'));
  assert.ok(calls.some(c => c[0] === 'transition' && c[2] === 'state:review' && c[3] === 'state:coding'));
  assert.ok(calls.some(c => c[0] === 'comment'));
});

test('CI-гейт: pending → ждём следующего tick (ничего не делаем, дедуп не ставится)', async () => {
  const h = harness({ issues: [issue(2, 'state:review')], checks: 'pending' });
  await h.daemon.tick();
  assert.ok(!h.calls.some(c => c[0] === 'role:review'));
  assert.ok(!h.calls.some(c => c[0] === 'transition'));
  // чеки позеленели — ревью запускается
  const h2 = harness({ issues: [issue(2, 'state:review')], checks: 'green' });
  await h2.daemon.tick();
  assert.ok(h2.calls.some(c => c[0] === 'role:review'));
});

test('курсор: выборка с перекрытием (since раньше курсора), после tick курсор = max(updated_at)', async () => {
  const { calls, daemon, keeper } = harness({ issues: [issue(1, 'state:ready', '2026-07-03T09:30:00Z')] });
  keeper.setCursor('o/r', '2026-07-03T09:00:00Z');
  await daemon.tick();
  const list = calls.find(c => c[0] === 'list');
  assert.ok(new Date(list[2]) < new Date('2026-07-03T09:00:00Z'), 'since сдвинут назад на окно перекрытия');
  assert.equal(keeper.getCursor('o/r'), '2026-07-03T09:30:00Z');
});

test('упавший между лейблом и ролью демон: рестарт продолжает без дубля перехода (state=planning → роль зовётся, transition planning→planning не делается)', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'state:planning')] });
  await daemon.tick();
  assert.ok(calls.some(c => c[0] === 'role:plan'), 'резюме планирования');
  assert.ok(!calls.some(c => c[0] === 'transition' && c[2] === 'state:planning' && c[3] === 'state:planning'), 'no-op переход не зовётся');
});

test('дневной кап исчерпан → tick не запускает ролей вовсе', async () => {
  const { calls, daemon, keeper } = harness({ issues: [issue(1, 'state:ready')] });
  keeper.addCost({ task: 'o/r#0', usd: 20, day: '2026-07-03' });
  await daemon.tick({ today: '2026-07-03' });
  assert.ok(!calls.some(c => String(c[0]).startsWith('role:')), 'дневной кап держит демона в паузе');
});

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
  labels: { ready: 'midas:state:ready', planning: 'midas:state:planning', coding: 'midas:state:coding', review: 'midas:state:review', blocked: 'midas:state:blocked', accepted: 'midas:state:accepted', rejected: 'midas:state:rejected', accept: 'midas:accept', reject: 'midas:reject' },
};

function harness({ issues = [], checks = 'green', transition = { ok: true }, prCreatedAt = '2026-07-03T00:00:00Z' } = {}) {
  const calls = [];
  const gh = {
    listUpdatedIssues: async (repo, since) => { calls.push(['list', repo, since]); return issues; },
    listIssues: async (repo, { label }) => issues.filter(i => i.labels.some(l => l.name === label)),
    getIssue: async (repo, n) => { calls.push(['getIssue', n]); return issues.find(i => i.number === n); },
    transitionState: async (repo, n, from, to) => { calls.push(['transition', n, from, to]); return transition; },
    addComment: async (repo, n, body) => { calls.push(['comment', n, body]); },
    getPRForBranch: async (repo, branch) => { calls.push(['getPR', branch]); return { number: 90, head: { sha: 'abc', ref: branch }, html_url: 'u', created_at: prCreatedAt }; },
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
  const { calls, daemon } = harness({ issues: [issue(1, 'midas:state:ready')] });
  await daemon.tick();
  const ti = calls.findIndex(c => c[0] === 'transition' && c[3] === 'midas:state:planning');
  const ri = calls.findIndex(c => c[0] === 'role:plan');
  assert.ok(ti !== -1 && ri !== -1, 'оба вызова были');
  assert.ok(ti < ri, 'сначала лейбл, потом роль');
});

test('гонка: transitionState вернул skipped → роль НЕ вызывается', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'midas:state:ready')], transition: { skipped: true, current: 'midas:state:coding' } });
  await daemon.tick();
  assert.ok(!calls.some(c => c[0] === 'role:plan'), 'роль не тронута при гонке');
});

test('review→accepted: журнал-событие несёт номер PR (для ссылки в Telegram)', async () => {
  const { daemon, keeper } = harness({ issues: [issue(1, 'midas:state:review')] });
  await daemon.tick();
  const ev = keeper.readAll().find(e => e.type === 'action' && e.action === 'review' && e.result === 'accepted');
  assert.ok(ev, 'есть accepted-событие');
  assert.equal(ev.pr, 90, 'событие несёт pr номер из getPRForBranch');
});

test('blocked игнорируется автоматикой', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'midas:state:blocked')] });
  await daemon.tick();
  assert.ok(!calls.some(c => String(c[0]).startsWith('role:')));
  assert.ok(!calls.some(c => c[0] === 'transition'));
});

test('дедуп: успешно завершённое действие не перезапускается на следующем tick', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'midas:state:review')] });
  await daemon.tick();
  const n1 = calls.filter(c => c[0] === 'role:review').length;
  assert.equal(n1, 1);
  await daemon.tick();
  const n2 = calls.filter(c => c[0] === 'role:review').length;
  assert.equal(n2, 1, 'повторный tick не дублирует завершённое ревью');
});

test('review c blocked-исходом НЕ дедупится: после разблокировки тот же sha ревьюится снова', async () => {
  const calls = [];
  const gh = {
    listUpdatedIssues: async () => [issue(5, 'midas:state:review')],
    listIssues: async (r, { label }) => (label === 'midas:state:review' ? [issue(5, 'midas:state:review')] : []),
    getIssue: async (r, n) => issue(5, 'midas:state:review'),
    transitionState: async () => ({ ok: true }),
    addComment: async () => {},
    getPRForBranch: async () => ({ number: 90, head: { sha: 'abc' }, created_at: '2026-07-03T00:00:00Z' }),
    checksStatus: async () => 'green',
  };
  const keeper = makeKeeper(mkdtempSync(join(tmpdir(), 'midas-d-')), { now: () => 't' });
  const roles = { plan: async () => {}, work: async () => {}, review: async () => { calls.push('review'); return { status: 'blocked' }; } };
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles, log: () => {}, heartbeat: () => {} });
  await daemon.tick();
  await daemon.tick();
  assert.equal(calls.length, 2, 'blocked-ревью не помечено processed — повтор возможен');
});

test('CI-гейт: красные чеки → возврат в coding с комментарием, ревью не зовётся', async () => {
  const { calls, daemon } = harness({ issues: [issue(2, 'midas:state:review')], checks: 'red' });
  await daemon.tick();
  assert.ok(!calls.some(c => c[0] === 'role:review'));
  assert.ok(calls.some(c => c[0] === 'transition' && c[2] === 'midas:state:review' && c[3] === 'midas:state:coding'));
  assert.ok(calls.some(c => c[0] === 'comment'));
});

test('CI-гейт: pending → ждём следующего tick (ничего не делаем, дедуп не ставится)', async () => {
  const h = harness({ issues: [issue(2, 'midas:state:review')], checks: 'pending' });
  await h.daemon.tick();
  assert.ok(!h.calls.some(c => c[0] === 'role:review'));
  assert.ok(!h.calls.some(c => c[0] === 'transition'));
  // чеки позеленели — ревью запускается
  const h2 = harness({ issues: [issue(2, 'midas:state:review')], checks: 'green' });
  await h2.daemon.tick();
  assert.ok(h2.calls.some(c => c[0] === 'role:review'));
});

test('холодный старт (курсора нет) → since=null, БЕЗ эпохи-1970 (GitHub отвечает на неё пустотой)', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'midas:state:ready')] });
  await daemon.tick();
  const list = calls.find(c => c[0] === 'list');
  assert.equal(list[2], null, 'без курсора since не передаётся');
  assert.ok(calls.some(c => c[0] === 'role:plan'), 'issue подхвачен на холодном старте');
});

test('CI-гейт: чеков нет — свежий PR ждёт grace-период, старый PR = репо без CI, ревью идёт', async () => {
  const fresh = harness({ issues: [issue(2, 'midas:state:review')], checks: 'none', prCreatedAt: new Date().toISOString() });
  await fresh.daemon.tick();
  assert.ok(!fresh.calls.some(c => c[0] === 'role:review'), 'свежий PR без чеков — ждём');
  const old = harness({ issues: [issue(2, 'midas:state:review')], checks: 'none', prCreatedAt: '2026-07-03T00:00:00Z' });
  await old.daemon.tick();
  assert.ok(old.calls.some(c => c[0] === 'role:review'), 'старый PR без чеков — репо без CI');
});

test('курсор: выборка с перекрытием (since раньше курсора), после tick курсор = max(updated_at)', async () => {
  const { calls, daemon, keeper } = harness({ issues: [issue(1, 'midas:state:ready', '2026-07-03T09:30:00Z')] });
  keeper.setCursor('o/r', '2026-07-03T09:00:00Z');
  await daemon.tick();
  const list = calls.find(c => c[0] === 'list');
  assert.ok(new Date(list[2]) < new Date('2026-07-03T09:00:00Z'), 'since сдвинут назад на окно перекрытия');
  assert.equal(keeper.getCursor('o/r'), '2026-07-03T09:30:00Z');
});

test('упавший между лейблом и ролью демон: рестарт продолжает без дубля перехода (state=planning → роль зовётся, transition planning→planning не делается)', async () => {
  const { calls, daemon } = harness({ issues: [issue(1, 'midas:state:planning')] });
  await daemon.tick();
  assert.ok(calls.some(c => c[0] === 'role:plan'), 'резюме планирования');
  assert.ok(!calls.some(c => c[0] === 'transition' && c[2] === 'midas:state:planning' && c[3] === 'midas:state:planning'), 'no-op переход не зовётся');
});

test('дневной кап исчерпан → tick не запускает ролей вовсе', async () => {
  const { calls, daemon, keeper } = harness({ issues: [issue(1, 'midas:state:ready')] });
  keeper.addCost({ task: 'o/r#0', usd: 20, day: '2026-07-03' });
  await daemon.tick({ today: '2026-07-03' });
  assert.ok(!calls.some(c => String(c[0]).startsWith('role:')), 'дневной кап держит демона в паузе');
});

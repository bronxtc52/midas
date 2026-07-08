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
  health_urls: { 'o/r': 'https://mon.example/' },
  labels: { ready: 'midas:state:ready', planning: 'midas:state:planning', coding: 'midas:state:coding', review: 'midas:state:review', blocked: 'midas:state:blocked', accepted: 'midas:state:accepted', rejected: 'midas:state:rejected', accept: 'midas:accept', reject: 'midas:reject' },
};

// gh, у которого поллинг пуст (issue закрыт после мерджа), но isPRMerged отвечает.
function mkGh({ merged = true, number = 90, onMerge = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    listUpdatedIssues: async () => [],
    listIssues: async () => [],
    getIssue: async () => null,
    transitionState: async () => ({ ok: true }),
    addComment: async () => {},
    isPRMerged: async (repo, branch) => { calls.push(['isPRMerged', repo, branch]); onMerge(); return { merged, number }; },
  };
}

function keeperIn() {
  return makeKeeper(mkdtempSync(join(tmpdir(), 'midas-m-')), { now: () => '2026-07-08T10:00:00Z' });
}

test('merged: accepted-задача смержена → ровно одно событие merged; повторный tick не дублирует', async () => {
  const gh = mkGh({ merged: true, number: 90 });
  const keeper = keeperIn();
  keeper.append({ type: 'action', action: 'review', repo: 'o/r', issue: 7, result: 'accepted', pr: 90 });
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles: {}, health: async () => 'up (HTTP 200)' });

  await daemon.tick();
  await daemon.tick();

  const merges = keeper.readAll().filter((e) => e.type === 'merged');
  assert.equal(merges.length, 1, 'событие merged эмитится ровно один раз');
  assert.equal(merges[0].issue, 7);
  assert.equal(merges[0].pr, 90);
  assert.equal(merges[0].repo, 'o/r');
  assert.equal(merges[0].health, 'up (HTTP 200)', 'снимок здоровья приложен к событию');
});

test('merged: PR ещё не смержен → события merged нет', async () => {
  const gh = mkGh({ merged: false, number: 90 });
  const keeper = keeperIn();
  keeper.append({ type: 'action', action: 'review', repo: 'o/r', issue: 7, result: 'accepted', pr: 90 });
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles: {}, health: async () => 'up (HTTP 200)' });

  await daemon.tick();
  assert.equal(keeper.readAll().filter((e) => e.type === 'merged').length, 0);
});

test('merged: health-снимок для repo без записи в health_urls → «не настроен»', async () => {
  const gh = mkGh({ merged: true, number: 5 });
  const cfg = { ...CONFIG, health_urls: {} }; // нет записи для o/r
  const keeper = keeperIn();
  keeper.append({ type: 'action', action: 'review', repo: 'o/r', issue: 3, result: 'accepted', pr: 5 });
  // health по умолчанию из health.js: пустой URL → «не настроен» (сеть не трогаем).
  const daemon = makeDaemon({ gh, keeper, config: cfg, roles: {} });

  await daemon.tick();
  const ev = keeper.readAll().find((e) => e.type === 'merged');
  assert.ok(ev, 'событие merged есть');
  assert.equal(ev.health, 'не настроен');
});

test('merged: HTTP-ошибка health НЕ роняет tick, merged всё равно эмитится', async () => {
  const gh = mkGh({ merged: true, number: 8 });
  const keeper = keeperIn();
  keeper.append({ type: 'action', action: 'review', repo: 'o/r', issue: 4, result: 'accepted', pr: 8 });
  // health, который бросает — но daemon не должен упасть (health сам глушит; здесь
  // проверяем, что даже брошенное health не валит tick — оборачиваем через реальный модуль).
  const throwingFetch = async () => { throw new Error('network down'); };
  // Пробрасываем реальный healthSnapshot через дефолт, но с падающим fetch недоступен —
  // проще передать health, использующий этот fetch:
  const { healthSnapshot } = await import('../src/health.js');
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles: {}, health: (url) => healthSnapshot(url, { fetchImpl: throwingFetch }) });

  await assert.doesNotReject(() => daemon.tick());
  const ev = keeper.readAll().find((e) => e.type === 'merged');
  assert.ok(ev, 'merged эмитится');
  assert.equal(ev.health, 'down (недоступен)', 'сетевая ошибка health → недоступен, tick цел');
});

test('merged: gh без isPRMerged (старый мок) → шаг пропускается, tick не падает', async () => {
  const keeper = keeperIn();
  keeper.append({ type: 'action', action: 'review', repo: 'o/r', issue: 7, result: 'accepted', pr: 90 });
  const gh = { listUpdatedIssues: async () => [], listIssues: async () => [] };
  const daemon = makeDaemon({ gh, keeper, config: CONFIG, roles: {} });
  await assert.doesNotReject(() => daemon.tick());
  assert.equal(keeper.readAll().filter((e) => e.type === 'merged').length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';
import { runPlanner } from '../src/roles/planner.js';

const CONFIG = {
  cost_cap_usd_per_task: 5, cost_cap_usd_per_day: 20,
  session_max_turns: 30, session_timeout_sec: 1800,
  council_slug: 'deepseek-direct/deepseek-v4-pro', council_cap_usd: 1,
  labels: { ready: 'midas:state:ready', planning: 'midas:state:planning', coding: 'midas:state:coding', review: 'midas:state:review', blocked: 'midas:state:blocked', accepted: 'midas:state:accepted', rejected: 'midas:state:rejected', accept: 'midas:accept', reject: 'midas:reject', awaiting_approval: 'midas:state:awaiting-approval', gate_plan: 'midas:gate:plan' },
};

function ghStub() {
  const calls = [];
  return {
    calls,
    addComment: async (...a) => { calls.push(['addComment', ...a]); },
    transitionState: async (...a) => { calls.push(['transitionState', ...a]); return { ok: true }; },
    addLabels: async (...a) => { calls.push(['addLabels', ...a]); },
  };
}
const keeper = () => makeKeeper(mkdtempSync(join(tmpdir(), 'midas-pc-')), { now: () => '2026-07-11T10:00:00Z' });
const PLAN5 = '## Цель\nx\n## Файлы-объекты\ny\n## Шаги\nz\n## DoD\n- [ ] a\n## Риски\nr';
const FORK = 'FORK: {"question":"монолит или воркеры?","known":"оба ок","options":["A) монолит","B) воркеры"],"recommendation":"A"}';
const ISSUE = { number: 5, title: 't', body: 'b' };

test('planner FORK: Council отвечает → 2-й прогон с рекомендацией, план публикуется, → coding', async () => {
  const gh = ghStub(); const k = keeper();
  const prompts = [];
  const claudeRun = async ({ prompt }) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? { ok: true, result: FORK, costUsd: 0.1, timedOut: false }
      : { ok: true, result: PLAN5, costUsd: 0.1, timedOut: false };
  };
  const askCouncil = async () => ({ ok: true, answer: 'бери вариант A' });
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil });
  assert.equal(r.status, 'planned');
  assert.equal(prompts.length, 2, 'ровно два прогона');
  assert.match(prompts[1], /# Рекомендация Council \(совещательная\)/);
  assert.match(prompts[1], /бери вариант A/);
  assert.ok(gh.calls.some(c => c[0] === 'addComment' && c[3].includes('## Цель')), 'план опубликован');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:coding'));
  assert.ok(k.readAll().some(e => e.type === 'council' && e.ok === true), 'журнал council ok:true');
  assert.ok(Math.abs(k.costForTask('o/r#5') - (1 + 0.2)) < 1e-9, 'учтён council_cap_usd + две сессии');
});

test('planner FORK: gate:plan → 2-й прогон уводит в awaiting-approval', async () => {
  const gh = ghStub(); const k = keeper();
  const issue = { number: 5, title: 't', body: 'b', labels: [{ name: 'midas:state:planning' }, { name: 'midas:gate:plan' }] };
  let n = 0;
  const claudeRun = async () => (++n === 1 ? { ok: true, result: FORK, costUsd: 0.1, timedOut: false } : { ok: true, result: PLAN5, costUsd: 0.1, timedOut: false });
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue, claudeRun, day: '2026-07-11', askCouncil: async () => ({ ok: true, answer: 'A' }) });
  assert.equal(r.status, 'awaiting-approval');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:awaiting-approval'));
});

test('planner FORK: Council unavailable → 2-й прогон «реши сам», план публикуется, журнал council ok:false', async () => {
  const gh = ghStub(); const k = keeper();
  const prompts = [];
  const claudeRun = async ({ prompt }) => {
    prompts.push(prompt);
    return prompts.length === 1 ? { ok: true, result: FORK, costUsd: 0.1, timedOut: false } : { ok: true, result: PLAN5, costUsd: 0.1, timedOut: false };
  };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil: async () => ({ ok: false, reason: 'unavailable' }) });
  assert.equal(r.status, 'planned');
  assert.match(prompts[1], /Council недоступен/);
  assert.match(prompts[1], /Риски/);
  const ev = k.readAll().find(e => e.type === 'council');
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'unavailable');
  assert.equal(k.costForTask('o/r#5'), 0.2, 'council_cap_usd НЕ учтён при недоступности');
});

test('planner FORK: secret-detected → blocked, Council повторно не зовут, второй сессии нет', async () => {
  const gh = ghStub(); const k = keeper();
  let runs = 0;
  const claudeRun = async () => { runs++; return { ok: true, result: FORK, costUsd: 0.1, timedOut: false }; };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil: async () => ({ ok: false, reason: 'secret-detected' }) });
  assert.equal(r.status, 'blocked');
  assert.equal(runs, 1, 'второй сессии нет');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:blocked'));
});

test('planner FORK: 2-й прогон снова FORK → blocked, третьей сессии нет', async () => {
  const gh = ghStub(); const k = keeper();
  let runs = 0;
  const claudeRun = async () => { runs++; return { ok: true, result: FORK, costUsd: 0.1, timedOut: false }; };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil: async () => ({ ok: true, answer: 'A' }) });
  assert.equal(r.status, 'blocked');
  assert.equal(runs, 2, 'ровно два прогона — петля исключена');
});

test('planner FORK: 2-й прогон вернул BLOCKED → blocked', async () => {
  const gh = ghStub(); const k = keeper();
  let runs = 0;
  const claudeRun = async () => {
    runs++;
    return runs === 1
      ? { ok: true, result: FORK, costUsd: 0.1, timedOut: false }
      : { ok: true, result: 'BLOCKED: {"question":"нет доступа","options":["A) x","B) y"]}', costUsd: 0.1, timedOut: false };
  };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil: async () => ({ ok: true, answer: 'A' }) });
  assert.equal(r.status, 'blocked');
  assert.equal(runs, 2);
});

test('planner FORK: дневной кап исчерпан → Council не вызывается, идём «реши сам»', async () => {
  const gh = ghStub(); const k = keeper();
  k.addCost({ task: 'o/r#999', usd: 20, day: '2026-07-11' }); // day cap выбран другой задачей
  let councilCalled = false;
  let n = 0;
  const claudeRun = async () => (++n === 1 ? { ok: true, result: FORK, costUsd: 0.1, timedOut: false } : { ok: true, result: PLAN5, costUsd: 0.1, timedOut: false });
  const askCouncil = async () => { councilCalled = true; return { ok: true, answer: 'A' }; };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil });
  assert.equal(councilCalled, false, 'вне капа Council не зовём');
  assert.equal(r.status, 'planned');
  assert.equal(n, 2, 'второй прогон «реши сам» всё равно идёт');
  assert.ok(k.readAll().some(e => e.type === 'council' && e.ok === false));
});

test('planner FORK: кап задачи исчерпан после 1-го прогона → Council не вызывается', async () => {
  const gh = ghStub(); const k = keeper();
  let councilCalled = false;
  let n = 0;
  const claudeRun = async () => (++n === 1 ? { ok: true, result: FORK, costUsd: 5, timedOut: false } : { ok: true, result: PLAN5, costUsd: 0.1, timedOut: false });
  const askCouncil = async () => { councilCalled = true; return { ok: true, answer: 'A' }; };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun, day: '2026-07-11', askCouncil });
  assert.equal(councilCalled, false, 'task-кап после первой сессии → Council не зовём');
  assert.equal(r.status, 'planned');
});

test('planner: обычный план без FORK → Council не задействован (регресс)', async () => {
  const gh = ghStub(); const k = keeper();
  let councilCalled = false;
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: ISSUE, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-11', askCouncil: async () => { councilCalled = true; return { ok: true, answer: 'A' }; } });
  assert.equal(r.status, 'planned');
  assert.equal(councilCalled, false);
});

test('daemon-main: DEEPSEEK_API_KEY вырезается из env Claude-сессий', () => {
  const src = readFileSync(new URL('../src/daemon-main.js', import.meta.url).pathname, 'utf8');
  // Ключ Council деструктурируется в скрытую переменную ДО ...sessionEnv (не доедет до сессий).
  assert.match(src, /const\s*\{[^}]*DEEPSEEK_API_KEY[^}]*\.\.\.sessionEnv\s*\}\s*=\s*process\.env/,
    'DEEPSEEK_API_KEY должен быть вырезан из sessionEnv');
});

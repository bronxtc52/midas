import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';
import { runPlanner, validatePlan } from '../src/roles/planner.js';
import { runWorker } from '../src/roles/worker.js';
import { parseVerdict } from '../src/roles/reviewer.js';
import { runAcceptor } from '../src/roles/acceptor.js';

const CONFIG = {
  cost_cap_usd_per_task: 5, cost_cap_usd_per_day: 20,
  session_max_turns: 30, session_timeout_sec: 1800,
  labels: { ready: 'state:ready', planning: 'state:planning', coding: 'state:coding', review: 'state:review', blocked: 'state:blocked', accepted: 'state:accepted', rejected: 'state:rejected', accept: 'midas:accept', reject: 'midas:reject' },
};

function ghStub() {
  const calls = [];
  return {
    calls,
    addComment: async (...a) => { calls.push(['addComment', ...a]); },
    transitionState: async (...a) => { calls.push(['transitionState', ...a]); return { ok: true }; },
    addLabels: async (...a) => { calls.push(['addLabels', ...a]); },
    createPR: async (...a) => { calls.push(['createPR', ...a]); return { number: 99, html_url: 'u' }; },
  };
}
const keeper = () => makeKeeper(mkdtempSync(join(tmpdir(), 'midas-k-')), { now: () => '2026-07-03T10:00:00Z' });
const PLAN5 = '## Цель\nx\n## Файлы-объекты\ny\n## Шаги\nz\n## DoD\n- [ ] a\n## Риски\nr';

test('validatePlan: 5 секций обязательны', () => {
  assert.equal(validatePlan(PLAN5), true);
  assert.equal(validatePlan('## Цель\nx\n## Шаги\nz'), false);
});

test('planner: успех → план-комментарий + переход в coding + учёт стоимости', async () => {
  const gh = ghStub(); const k = keeper();
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: 'b' }, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'planned');
  assert.ok(gh.calls.some(c => c[0] === 'addComment' && c[3].includes('## Цель')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'state:planning' && c[4] === 'state:coding'));
  assert.equal(k.costForTask('o/r#5'), 0.1);
});

test('planner: сессия сообщила BLOCKED → blocked-комментарий канонического формата + state:blocked', async () => {
  const gh = ghStub(); const k = keeper();
  const out = 'BLOCKED: {"question":"q?","known":"k","options":["A) x","B) y"],"recommendation":"A"}';
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: '' }, claudeRun: async () => ({ ok: true, result: out, costUsd: 0.05, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'blocked');
  const c = gh.calls.find(c => c[0] === 'addComment');
  assert.match(c[3], /## ⛔ BLOCKED/);
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'state:blocked'));
});

test('planner: план без 5 секций → blocked, не coding', async () => {
  const gh = ghStub();
  const r = await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: 'b' }, claudeRun: async () => ({ ok: true, result: 'полтора раздела', costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'blocked');
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'state:coding'));
});

test('planner: кап задачи исчерпан → blocked ДО запуска сессии', async () => {
  const gh = ghStub(); const k = keeper();
  k.addCost({ task: 'o/r#5', usd: 5, day: '2026-07-03' });
  let sessionCalled = false;
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: 'b' }, claudeRun: async () => { sessionCalled = true; return { ok: true, result: PLAN5, costUsd: 0, timedOut: false }; }, day: '2026-07-03' });
  assert.equal(r.status, 'blocked');
  assert.equal(sessionCalled, false, 'пре-чек капа не пускает сессию');
  const c = gh.calls.find(c => c[0] === 'addComment');
  assert.match(c[3], /\$/, 'в blocked-комментарии есть $-отчёт');
});

test('planner c fromLabel=coding (fallback без плана): blocked уходит из coding, а не из planning', async () => {
  const gh = ghStub();
  const out = 'BLOCKED: {"question":"q?","known":"k","options":["A) x"],"recommendation":"A"}';
  await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue: { number: 8, title: 't', body: '' }, claudeRun: async () => ({ ok: true, result: out, costUsd: 0.01, timedOut: false }), day: '2026-07-03', fromLabel: CONFIG.labels.coding });
  const t = gh.calls.find(c => c[0] === 'transitionState');
  assert.equal(t[3], 'state:coding', 'переход из фактического state, не из planning');
  assert.equal(t[4], 'state:blocked');
});

test('planner c fromLabel=coding: успех НЕ делает no-op переход coding→coding', async () => {
  const gh = ghStub();
  await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue: { number: 8, title: 't', body: 'b' }, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.01, timedOut: false }), day: '2026-07-03', fromLabel: CONFIG.labels.coding });
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState'), 'переходов нет — issue уже в coding');
  assert.ok(gh.calls.some(c => c[0] === 'addComment'), 'план опубликован');
});

test('worker: интеграция с локальным git — ветка, коммит, push, PR, state:review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'midas-w-'));
  const bare = join(root, 'remote.git');
  mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);

  const gh = ghStub(); const k = keeper();
  const r = await runWorker({
    gh, keeper: k, config: CONFIG, repo: 'o/r',
    issue: { number: 3, title: 'сделай файл', body: '' }, plan: PLAN5,
    remoteUrl: bare, workRoot: join(root, 'work'), day: '2026-07-03',
    claudeRun: async ({ cwd }) => {
      execFileSync('bash', ['-c', 'echo сделано > result.txt'], { cwd });
      return { ok: true, result: 'готово', costUsd: 0.2, timedOut: false };
    },
  });
  assert.equal(r.status, 'review');
  const ls = execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' });
  assert.match(ls, /refs\/heads\/midas\/issue-3/, 'ветка запушена');
  const pr = gh.calls.find(c => c[0] === 'createPR');
  assert.equal(pr[2].head, 'midas/issue-3');
  assert.match(pr[2].body, /#3/);
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'state:coding' && c[4] === 'state:review'));
});

test('worker: сессия не изменила файлы → blocked, PR не создаётся', async () => {
  const root = mkdtempSync(join(tmpdir(), 'midas-w2-'));
  const bare = join(root, 'remote.git');
  mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
  const gh = ghStub();
  const r = await runWorker({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue: { number: 4, title: 't', body: '' }, plan: PLAN5, remoteUrl: bare, workRoot: join(root, 'work'), day: '2026-07-03', claudeRun: async () => ({ ok: true, result: 'ничего не сделал', costUsd: 0.1, timedOut: false }) });
  assert.equal(r.status, 'blocked');
  assert.ok(!gh.calls.some(c => c[0] === 'createPR'));
});

test('parseVerdict: valid pass/fail и мусор → fail', () => {
  assert.deepEqual(parseVerdict('...\nVERDICT: {"verdict":"pass","findings":[]}').verdict, 'pass');
  const f = parseVerdict('VERDICT: {"verdict":"fail","findings":[{"severity":"high","note":"x"}]}');
  assert.equal(f.verdict, 'fail');
  assert.equal(f.findings.length, 1);
  assert.equal(parseVerdict('никакого вердикта').verdict, 'fail', 'непарсибельно = fail, не pass');
});

test('acceptor: pass → midas:accept + state:accepted; fail → midas:reject + возврат в coding с причинами', async () => {
  let gh = ghStub();
  await runAcceptor({ gh, config: CONFIG, repo: 'o/r', issue: { number: 3 }, verdict: { verdict: 'pass', findings: [] } });
  assert.ok(gh.calls.some(c => c[0] === 'addLabels' && c[3].includes('midas:accept')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'state:accepted'));

  gh = ghStub();
  await runAcceptor({ gh, config: CONFIG, repo: 'o/r', issue: { number: 3 }, verdict: { verdict: 'fail', findings: [{ severity: 'high', note: 'сломано' }] } });
  assert.ok(gh.calls.some(c => c[0] === 'addLabels' && c[3].includes('midas:reject')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'state:coding'));
  const comment = gh.calls.find(c => c[0] === 'addComment');
  assert.match(comment[3], /сломано/);
});

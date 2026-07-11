import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';
import { runWorker } from '../src/roles/worker.js';
import { makeGh } from '../src/gh.js';

const CONFIG = {
  cost_cap_usd_per_task: 5, cost_cap_usd_per_day: 20,
  session_max_turns: 30, session_timeout_sec: 1800,
  labels: { coding: 'midas:state:coding', review: 'midas:state:review', blocked: 'midas:state:blocked' },
};

function ghStub(defaultBranch = 'main') {
  const calls = [];
  return {
    calls,
    addComment: async (...a) => { calls.push(['addComment', ...a]); },
    transitionState: async (...a) => { calls.push(['transitionState', ...a]); return { ok: true }; },
    createPR: async (...a) => { calls.push(['createPR', ...a]); return { number: 99, html_url: 'u' }; },
    getDefaultBranch: async () => defaultBranch,
  };
}
const keeper = () => makeKeeper(mkdtempSync(join(tmpdir(), 'midas-cik-')), { now: () => '2026-07-11T10:00:00Z' });
const PLAN5 = '## Цель\nx\n## Файлы-объекты\ny\n## Шаги\nz\n## DoD\n- [ ] a\n## Риски\nr';

// Свежий bare-remote + seed-коммит: Worker клонирует, создаёт ветку и работает.
// Возвращает { bare, workRoot }.
function freshRemote(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const bare = join(root, 'remote.git');
  mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
  return { bare, workRoot: join(root, 'work') };
}

// Прогоняет runWorker, перехватывая промпт, переданный в claudeRun. Сессия что-то
// пишет → дифф не пуст → доходит до конца без ложного blocked.
async function runAndCapturePrompt({ ciFailure }) {
  const { bare, workRoot } = freshRemote('midas-ci-');
  let captured = '';
  await runWorker({
    gh: ghStub(), keeper: keeper(), config: CONFIG, repo: 'o/r',
    issue: { number: 8, title: 'фикс', body: '' }, plan: PLAN5, ciFailure,
    remoteUrl: bare, workRoot, day: '2026-07-11',
    claudeRun: async ({ prompt, cwd }) => {
      captured = prompt;
      execFileSync('bash', ['-c', 'echo fix > result.txt'], { cwd });
      return { ok: true, result: 'готово', costUsd: 0.2, timedOut: false };
    },
  });
  return captured;
}

test('worker rework: ciFailure → промпт содержит имя упавшего чека и фрагмент лога', async () => {
  const prompt = await runAndCapturePrompt({
    ciFailure: {
      checks: [{ name: 'test', summary: 'float strictEqual failed', id: 42 }],
      log: 'npm test\nAssertionError [ERR_ASSERTION]: 0.3 !== 0.30000000000000004',
    },
  });
  assert.match(prompt, /CI КРАСНЫЙ/, 'CI-блок присутствует');
  assert.match(prompt, /- test — float strictEqual failed/, 'имя чека + summary');
  assert.match(prompt, /AssertionError \[ERR_ASSERTION\]/, 'фрагмент лога в промпте');
  assert.match(prompt, /выйти без изменений можно только если/, 'инструкция чинить причину');
});

test('worker rework: лог длиннее LOG_CAP → усечён (кап + пометка усечения)', async () => {
  const tailMark = 'ХВОСТ_ЛОГА_МАРКЕР_В_КОНЦЕ';
  const headMark = 'ГОЛОВА_ЛОГА_МАРКЕР_В_НАЧАЛЕ';
  const huge = headMark + '\n' + 'x'.repeat(40_000) + '\n' + tailMark;
  const prompt = await runAndCapturePrompt({
    ciFailure: { checks: [{ name: 'test', summary: '', id: 1 }], log: huge },
  });
  assert.match(prompt, /начало лога усечено/, 'пометка усечения');
  assert.match(prompt, new RegExp(tailMark), 'хвост лога сохранён');
  assert.ok(!prompt.includes(headMark), 'голова лога отброшена (усечён именно хвост)');
  // Прикладываемый лог не длиннее капа (+ небольшая пометка), а не 40 КБ.
  assert.ok(prompt.length < 30_000, `промпт не раздут: ${prompt.length}`);
});

test('worker: первичный coding (нет ciFailure) → промпт без CI-блока (поведение не изменено)', async () => {
  const prompt = await runAndCapturePrompt({ ciFailure: undefined });
  assert.ok(!prompt.includes('CI КРАСНЫЙ'), 'без ciFailure CI-блока нет');
  assert.match(prompt, /# План \(Planner\)/, 'обычный промпт на месте');
});

test('worker: пустой список чеков → CI-блока нет (защита от пустого ciFailure)', async () => {
  const prompt = await runAndCapturePrompt({ ciFailure: { checks: [], log: 'что-то' } });
  assert.ok(!prompt.includes('CI КРАСНЫЙ'), 'без имён чеков блок не врезается');
});

test('worker rework: лог недоступен (деградация) → имена чеков есть, лог-блока нет', async () => {
  const prompt = await runAndCapturePrompt({
    ciFailure: { checks: [{ name: 'build', summary: 'compile error', id: 7 }], log: '' },
  });
  assert.match(prompt, /CI КРАСНЫЙ/);
  assert.match(prompt, /- build — compile error/, 'имя чека при недоступном логе');
  assert.ok(!prompt.includes('Хвост лога'), 'без лога лог-блок не выводится');
});

// ---- gh.failedChecks / gh.failedCheckLog (mock fetch) ----

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    for (const r of routes) {
      if (r.match(String(url), opts.method || 'GET')) {
        return {
          ok: r.status < 400, status: r.status,
          headers: { get: () => null },
          json: async () => r.json ?? {}, text: async () => r.text ?? '',
        };
      }
    }
    throw new Error('unmatched route: ' + url);
  };
  return { impl, calls };
}

test('gh.failedChecks: только completed с плохим conclusion → {name,summary,id}', async () => {
  const { impl } = fakeFetch([{
    match: (u) => u.includes('/check-runs'),
    status: 200,
    json: { check_runs: [
      { name: 'ok', status: 'completed', conclusion: 'success', id: 1, output: {} },
      { name: 'test', status: 'completed', conclusion: 'failure', id: 2, output: { summary: 'float !==' } },
      { name: 'lint', status: 'completed', conclusion: 'failure', id: 3, output: { title: 'style' } },
      { name: 'pending', status: 'in_progress', conclusion: null, id: 4, output: {} },
      { name: 'skip', status: 'completed', conclusion: 'skipped', id: 5, output: {} },
    ] },
  }]);
  const gh = makeGh({ token: 't', fetchImpl: impl });
  const out = await gh.failedChecks('o/r', 'abc');
  assert.deepEqual(out, [
    { name: 'test', summary: 'float !==', id: 2 },
    { name: 'lint', summary: 'style', id: 3 },
  ]);
});

test('gh.failedCheckLog: успех → raw-текст; ошибка → \'\' (деградация, не бросает)', async () => {
  const ok = fakeFetch([{ match: (u) => u.includes('/actions/jobs/'), status: 200, text: 'лог job\nошибка тут' }]);
  const ghOk = makeGh({ token: 't', fetchImpl: ok.impl });
  assert.equal(await ghOk.failedCheckLog('o/r', 42), 'лог job\nошибка тут');

  const fail = fakeFetch([{ match: (u) => u.includes('/actions/jobs/'), status: 404, json: {} }]);
  const ghFail = makeGh({ token: 't', fetchImpl: fail.impl });
  assert.equal(await ghFail.failedCheckLog('o/r', 42), '', '404 лога → пустая строка, без throw');
});

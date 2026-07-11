import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeeper } from '../src/keeper.js';
import { runPlanner, validatePlan, extractGoal } from '../src/roles/planner.js';
import { runWorker } from '../src/roles/worker.js';
import { parseVerdict, runReviewer } from '../src/roles/reviewer.js';
import { runAcceptor, extractDoD, parseDod } from '../src/roles/acceptor.js';

const CONFIG = {
  cost_cap_usd_per_task: 5, cost_cap_usd_per_day: 20,
  session_max_turns: 30, session_timeout_sec: 1800,
  labels: { ready: 'midas:state:ready', planning: 'midas:state:planning', coding: 'midas:state:coding', review: 'midas:state:review', blocked: 'midas:state:blocked', accepted: 'midas:state:accepted', rejected: 'midas:state:rejected', accept: 'midas:accept', reject: 'midas:reject', awaiting_approval: 'midas:state:awaiting-approval', gate_plan: 'midas:gate:plan' },
};

function ghStub(defaultBranch = 'main') {
  const calls = [];
  return {
    calls,
    addComment: async (...a) => { calls.push(['addComment', ...a]); },
    transitionState: async (...a) => { calls.push(['transitionState', ...a]); return { ok: true }; },
    addLabels: async (...a) => { calls.push(['addLabels', ...a]); },
    createPR: async (...a) => { calls.push(['createPR', ...a]); return { number: 99, html_url: 'u' }; },
    getDefaultBranch: async (...a) => { calls.push(['getDefaultBranch', ...a]); return defaultBranch; },
  };
}
const keeper = () => makeKeeper(mkdtempSync(join(tmpdir(), 'midas-k-')), { now: () => '2026-07-03T10:00:00Z' });
const PLAN5 = '## Цель\nx\n## Файлы-объекты\ny\n## Шаги\nz\n## DoD\n- [ ] a\n## Риски\nr';

test('validatePlan: 5 секций обязательны', () => {
  assert.equal(validatePlan(PLAN5), true);
  assert.equal(validatePlan('## Цель\nx\n## Шаги\nz'), false);
});

test('extractGoal: краевые случаи (нет секции / пустая / многострочная / срез ≤200)', () => {
  assert.equal(extractGoal('## Цель\nсделать X\n## Шаги\nz'), 'сделать X');
  assert.equal(extractGoal('нет секции цели вовсе'), '');
  assert.equal(extractGoal(''), '');
  assert.equal(extractGoal('## Цель\n\n## Шаги\nz'), '', 'пустая цель до следующей секции → пусто');
  assert.equal(extractGoal('## Цель\n\nреальная цель\nвторая строка'), 'реальная цель', 'первая непустая строка');
  assert.equal(extractGoal('## Цель\n' + 'a'.repeat(300)), 'a'.repeat(200), 'срез ≤200 символов');
});

test('planner: успех → план-комментарий + переход в coding + учёт стоимости', async () => {
  const gh = ghStub(); const k = keeper();
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: 'b' }, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'planned');
  assert.ok(gh.calls.some(c => c[0] === 'addComment' && c[3].includes('## Цель')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'midas:state:planning' && c[4] === 'midas:state:coding'));
  assert.equal(k.costForTask('o/r#5'), 0.1);
});

test('planner: midas:gate:plan + from=planning → awaiting-approval (гейт), НЕ coding', async () => {
  const gh = ghStub(); const k = keeper();
  const issue = { number: 5, title: 't', body: 'b', labels: [{ name: 'midas:state:planning' }, { name: 'midas:gate:plan' }] };
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'awaiting-approval');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'midas:state:planning' && c[4] === 'midas:state:awaiting-approval'), 'флип в awaiting-approval');
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:coding'), 'НЕ ушёл сразу в coding');
  assert.ok(gh.calls.some(c => c[0] === 'addComment' && c[3].includes('## Цель')), 'план опубликован');
});

test('planner: gated-задача пишет журнал-событие awaiting-approval с title и goal (для Telegram-пинга)', async () => {
  const gh = ghStub(); const k = keeper();
  const issue = { number: 5, title: 'Моя задача', body: 'b', labels: [{ name: 'midas:state:planning' }, { name: 'midas:gate:plan' }] };
  await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  const ev = k.readAll().find((e) => e.type === 'awaiting-approval');
  assert.ok(ev, 'журнал содержит событие awaiting-approval');
  assert.equal(ev.title, 'Моя задача');
  assert.equal(ev.goal, 'x', 'goal извлечён из секции ## Цель плана (PLAN5)');
  assert.equal(ev.issue, 5);
});

test('planner: НЕ gated-задача НЕ пишет журнал-событие awaiting-approval', async () => {
  const gh = ghStub(); const k = keeper();
  const issue = { number: 6, title: 't', body: 'b', labels: [{ name: 'midas:state:planning' }] };
  await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.ok(!k.readAll().some((e) => e.type === 'awaiting-approval'), 'без gate:plan — нет спец-события');
});

test('planner: labels без midas:gate:plan → coding как раньше (регресс автономии)', async () => {
  const gh = ghStub();
  const issue = { number: 6, title: 't', body: 'b', labels: [{ name: 'midas:state:planning' }, { name: 'bug' }] };
  const r = await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'planned');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'midas:state:planning' && c[4] === 'midas:state:coding'));
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:awaiting-approval'));
});

test('planner: midas:gate:plan есть, но fromLabel=coding (fallback-реплан) → гейт НЕ включается', async () => {
  const gh = ghStub();
  const issue = { number: 8, title: 't', body: 'b', labels: [{ name: 'midas:state:coding' }, { name: 'midas:gate:plan' }] };
  const r = await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.01, timedOut: false }), day: '2026-07-03', fromLabel: CONFIG.labels.coding });
  assert.equal(r.status, 'planned');
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState'), 'реплан из coding не гейтить и не гонять no-op переход');
});

test('planner: сессия сообщила BLOCKED → blocked-комментарий канонического формата + midas:state:blocked', async () => {
  const gh = ghStub(); const k = keeper();
  const out = 'BLOCKED: {"question":"q?","known":"k","options":["A) x","B) y"],"recommendation":"A"}';
  const r = await runPlanner({ gh, keeper: k, config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: '' }, claudeRun: async () => ({ ok: true, result: out, costUsd: 0.05, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'blocked');
  const c = gh.calls.find(c => c[0] === 'addComment');
  assert.match(c[3], /## ⛔ BLOCKED/);
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:blocked'));
});

test('planner: план без 5 секций → blocked, не coding', async () => {
  const gh = ghStub();
  const r = await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue: { number: 5, title: 't', body: 'b' }, claudeRun: async () => ({ ok: true, result: 'полтора раздела', costUsd: 0.1, timedOut: false }), day: '2026-07-03' });
  assert.equal(r.status, 'blocked');
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:coding'));
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
  assert.equal(t[3], 'midas:state:coding', 'переход из фактического state, не из planning');
  assert.equal(t[4], 'midas:state:blocked');
});

test('planner c fromLabel=coding: успех НЕ делает no-op переход coding→coding', async () => {
  const gh = ghStub();
  await runPlanner({ gh, keeper: keeper(), config: CONFIG, repo: 'o/r', issue: { number: 8, title: 't', body: 'b' }, claudeRun: async () => ({ ok: true, result: PLAN5, costUsd: 0.01, timedOut: false }), day: '2026-07-03', fromLabel: CONFIG.labels.coding });
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState'), 'переходов нет — issue уже в coding');
  assert.ok(gh.calls.some(c => c[0] === 'addComment'), 'план опубликован');
});

test('worker: интеграция с локальным git — ветка, коммит, push, PR, midas:state:review', async () => {
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
  assert.equal(pr[2].base, 'main', 'PR base = дефолт-ветка репо (main)');
  assert.match(pr[2].body, /#3/);
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'midas:state:coding' && c[4] === 'midas:state:review'));
});

test('worker: репо на master → PR base master, дифф от origin/master (мультирепо, не падает на origin/main)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'midas-wm-'));
  const bare = join(root, 'remote.git');
  mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '-b', 'master', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'master']);

  const gh = ghStub('master'); const k = keeper();
  const r = await runWorker({
    gh, keeper: k, config: CONFIG, repo: 'o/sw',
    issue: { number: 50, title: 'фикс', body: '' }, plan: PLAN5,
    remoteUrl: bare, workRoot: join(root, 'work'), day: '2026-07-03',
    claudeRun: async ({ cwd }) => {
      execFileSync('bash', ['-c', 'echo fix > result.txt'], { cwd });
      return { ok: true, result: 'готово', costUsd: 0.2, timedOut: false };
    },
  });
  assert.equal(r.status, 'review');
  const ls = execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' });
  assert.match(ls, /refs\/heads\/midas\/issue-50/, 'ветка запушена (ahead-count от origin/master не упал)');
  const pr = gh.calls.find(c => c[0] === 'createPR');
  assert.equal(pr[2].base, 'master', 'PR base = дефолт-ветка master');
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

test('parseVerdict: JSON в ```json-fence после VERDICT: → распаршен', () => {
  const t = 'бла-бла\nVERDICT:\n```json\n{"verdict":"pass","findings":[]}\n```';
  assert.equal(parseVerdict(t).verdict, 'pass');
});

test('parseVerdict: JSON в безымянном ```-fence → распаршен', () => {
  const t = 'VERDICT:\n```\n{"verdict":"fail","findings":[{"severity":"high","note":"y"}]}\n```';
  const v = parseVerdict(t);
  assert.equal(v.verdict, 'fail');
  assert.equal(v.findings.length, 1);
});

test('parseVerdict: многострочный JSON после VERDICT: → распаршен', () => {
  const t = 'VERDICT: {\n  "verdict": "pass",\n  "findings": []\n}';
  assert.equal(parseVerdict(t).verdict, 'pass');
});

test('parseVerdict: текст после закрывающей } → распаршен (баланс скобок)', () => {
  const t = 'VERDICT: {"verdict":"fail","findings":[{"severity":"med","note":"a{b}"}]} — конец ответа';
  const v = parseVerdict(t);
  assert.equal(v.verdict, 'fail');
  assert.equal(v.findings[0].note, 'a{b}', 'скобки внутри строкового литерала не ломают баланс');
});

test('parseVerdict: берётся ПОСЛЕДНЕЕ вхождение VERDICT:', () => {
  const t = 'сначала пишу про VERDICT: как формат\nVERDICT: {"verdict":"pass","findings":[]}';
  assert.equal(parseVerdict(t).verdict, 'pass');
});

test('parseVerdict: битый JSON → unparsed-fail', () => {
  assert.equal(parseVerdict('VERDICT: {"verdict":"pass",').verdict, 'fail');
});

test('parseVerdict: verdict не pass|fail → unparsed-fail', () => {
  assert.equal(parseVerdict('VERDICT: {"verdict":"maybe"}').verdict, 'fail');
});

function reviewGh(diff = 'diff') {
  const gh = ghStub();
  gh.getPRDiff = async (...a) => { gh.calls.push(['getPRDiff', ...a]); return diff; };
  return gh;
}
const REV_ARGS = (gh, k, claudeRun) => ({
  gh, keeper: k, config: CONFIG, repo: 'o/r',
  issue: { number: 7, title: 't', body: 'b' }, pr: { number: 77 },
  plan: PLAN5, rubric: '', claudeRun, day: '2026-07-03', workRoot: '/tmp',
});

test('runReviewer: валидный pass с первого раза → коммент, journal, без ретрая и blocked', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runReviewer(REV_ARGS(gh, k, async () => {
    runs++;
    return { ok: true, result: 'VERDICT: {"verdict":"pass","findings":[]}', costUsd: 0.1, timedOut: false };
  }));
  assert.equal(runs, 1, 'ровно один прогон');
  assert.equal(r.verdict, 'pass');
  assert.ok(!r.blocked);
  assert.ok(gh.calls.some(c => c[0] === 'addComment' && c[3].includes('✅ pass')));
  assert.ok(k.readAll().some(e => e.type === 'review' && e.verdict === 'pass'));
});

test('runReviewer: unparsed → ровно один повторный прогон; успех на 2-м → нормальный вердикт', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runReviewer(REV_ARGS(gh, k, async () => {
    runs++;
    return runs === 1
      ? { ok: true, result: 'без вердикта', costUsd: 0.1, timedOut: false }
      : { ok: true, result: 'VERDICT: {"verdict":"pass","findings":[]}', costUsd: 0.1, timedOut: false };
  }));
  assert.equal(runs, 2, 'один повторный прогон после unparsed');
  assert.equal(r.verdict, 'pass');
  assert.ok(!r.blocked);
  assert.equal(k.costForTask('o/r#7'), 0.2, 'addCost на каждый прогон');
});

test('runReviewer: повторный unparsed → blocked (не reject, не coding)', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runReviewer(REV_ARGS(gh, k, async () => {
    runs++;
    return { ok: true, result: 'опять без вердикта', costUsd: 0.1, timedOut: false };
  }));
  assert.equal(runs, 2, 'ровно два прогона (первый + один ретрай)');
  assert.equal(r.blocked, true);
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:blocked'), 'уход в blocked');
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:coding'), 'НЕ в coding');
  assert.ok(k.readAll().some(e => e.type === 'blocked'), 'журнал blocked');
});

test('runReviewer: timedOut не ретраится и уходит fail-вердиктом (поведение не изменено)', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runReviewer(REV_ARGS(gh, k, async () => {
    runs++;
    return { ok: false, result: '', costUsd: 0.1, timedOut: true };
  }));
  assert.equal(runs, 1, 'таймаут не ретраим');
  assert.equal(r.verdict, 'fail');
  assert.ok(!r.blocked);
  assert.ok(gh.calls.some(c => c[0] === 'addComment' && c[3].includes('таймаут')));
  assert.ok(k.readAll().some(e => e.type === 'review' && e.verdict === 'fail'));
});

// ---- Acceptor: DoD-проверка (Конституция §5) ----

const DOD_PLAN = '## Цель\nx\n## DoD\n- [ ] пункт про файл\n- [ ] пункт про тест\n## Риски\nr';

test('extractDoD: вырезает секцию ## DoD, когда она НЕ последняя', () => {
  assert.equal(extractDoD(DOD_PLAN), '- [ ] пункт про файл\n- [ ] пункт про тест');
});
test('extractDoD: DoD — последняя секция', () => {
  assert.equal(extractDoD('## Цель\nx\n## DoD\n- [ ] один пункт'), '- [ ] один пункт');
});
test('extractDoD: нет секции / пустая → пусто', () => {
  assert.equal(extractDoD('## Цель\nx\n## Риски\nr'), '');
  assert.equal(extractDoD('## Цель\nx\n## DoD\n\n## Риски\nr'), '', 'пустая DoD → пусто');
  assert.equal(extractDoD(''), '');
  assert.equal(extractDoD(null), '');
});

test('parseDod: валидный / fence / многострочный → items; мусор → unparsed', () => {
  assert.deepEqual(parseDod('DOD: {"items":[{"item":"a","pass":true}]}').items.length, 1);
  assert.equal(parseDod('DOD:\n```json\n{"items":[{"item":"a","pass":false}]}\n```').items[0].pass, false);
  assert.equal(parseDod('DOD:\n```\n{"items":[]}\n```').unparsed, true, 'пустой items → unparsed (fail-closed)');
  assert.equal(parseDod('DOD: {"items":[]}').unparsed, true, 'голый пустой items → unparsed (fail-closed)');
  assert.equal(parseDod('DOD: {\n  "items": [\n    {"item":"a","pass":true}\n  ]\n}').items.length, 1);
  assert.equal(parseDod('никакого DOD').unparsed, true);
  assert.equal(parseDod('DOD: {"items":').unparsed, true, 'битый JSON → unparsed');
  assert.equal(parseDod('DOD: {"foo":1}').unparsed, true, 'нет массива items → unparsed');
});
test('parseDod: берётся ПОСЛЕДНЕЕ вхождение DOD: и баланс скобок', () => {
  const t = 'сначала про формат DOD:\nDOD: {"items":[{"item":"a{b}","pass":true,"evidence":"x"}]} — конец';
  const d = parseDod(t);
  assert.equal(d.items[0].item, 'a{b}', 'скобки в строке не ломают баланс');
});

const ACC_ARGS = (gh, k, claudeRun, verdict, plan = DOD_PLAN) => ({
  gh, keeper: k, config: CONFIG, repo: 'o/r',
  issue: { number: 3, title: 't', body: 'b' }, pr: { number: 33 },
  verdict, plan, claudeRun, day: '2026-07-03', workRoot: '/tmp',
});

test('acceptor: verdict=pass + все DoD-пункты pass → ACCEPT (session ровно 1 раз)', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runAcceptor(ACC_ARGS(gh, k, async () => {
    runs++;
    return { ok: true, result: 'DOD: {"items":[{"item":"файл","pass":true,"evidence":"ок"},{"item":"тест","pass":true,"evidence":"ок"}]}', costUsd: 0.1, timedOut: false };
  }, { verdict: 'pass', findings: [] }));
  assert.equal(runs, 1, 'DoD-сессия вызвана ровно один раз');
  assert.equal(r.status, 'accepted');
  assert.ok(gh.calls.some(c => c[0] === 'addLabels' && c[3].includes('midas:accept')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'midas:state:review' && c[4] === 'midas:state:accepted'));
});

test('acceptor: verdict=pass + один pass:false → REJECT, коммент несёт пункт, review→coding', async () => {
  const gh = reviewGh(); const k = keeper();
  const r = await runAcceptor(ACC_ARGS(gh, k, async () =>
    ({ ok: true, result: 'DOD: {"items":[{"item":"файл создан","pass":true,"evidence":"ок"},{"item":"нет теста","pass":false,"evidence":"тест отсутствует в диффе"}]}', costUsd: 0.1, timedOut: false }),
    { verdict: 'pass', findings: [] }));
  assert.equal(r.status, 'rejected');
  assert.ok(gh.calls.some(c => c[0] === 'addLabels' && c[3].includes('midas:reject')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[3] === 'midas:state:review' && c[4] === 'midas:state:coding'));
  const comment = gh.calls.find(c => c[0] === 'addComment');
  assert.match(comment[3], /нет теста/, 'коммент ссылается на непройденный пункт');
  assert.match(comment[3], /тест отсутствует в диффе/, 'коммент несёт evidence');
});

test('acceptor: verdict=fail → REJECT без вызова Claude-сессии', async () => {
  const gh = reviewGh(); const k = keeper();
  let sessionCalled = false;
  const r = await runAcceptor(ACC_ARGS(gh, k, async () => { sessionCalled = true; return { ok: true, result: '', costUsd: 0, timedOut: false }; },
    { verdict: 'fail', findings: [{ severity: 'high', note: 'сломано' }] }));
  assert.equal(r.status, 'rejected');
  assert.equal(sessionCalled, false, 'при fail LLM-сессия не запускается');
  assert.ok(gh.calls.some(c => c[0] === 'addLabels' && c[3].includes('midas:reject')));
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:coding'));
  assert.match(gh.calls.find(c => c[0] === 'addComment')[3], /сломано/);
});

test('acceptor: DOD непарсибелен дважды → blocked, ни accept, ни reject не выставлены', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runAcceptor(ACC_ARGS(gh, k, async () => { runs++; return { ok: true, result: 'без формата', costUsd: 0.1, timedOut: false }; },
    { verdict: 'pass', findings: [] }));
  assert.equal(runs, 2, 'первый прогон + один ретрай');
  assert.equal(r.status, 'blocked');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:blocked'));
  assert.ok(!gh.calls.some(c => c[0] === 'addLabels' && (c[3].includes('midas:accept') || c[3].includes('midas:reject'))), 'ни accept, ни reject (fail-closed)');
  assert.ok(!gh.calls.some(c => c[0] === 'transitionState' && (c[4] === 'midas:state:accepted' || c[4] === 'midas:state:coding')));
  assert.equal(k.costForTask('o/r#3'), 0.2, 'addCost на каждый прогон');
});

test('acceptor: таймаут DoD-сессии → сразу blocked (без ретрая)', async () => {
  const gh = reviewGh(); const k = keeper();
  let runs = 0;
  const r = await runAcceptor(ACC_ARGS(gh, k, async () => { runs++; return { ok: false, result: '', costUsd: 0.1, timedOut: true }; },
    { verdict: 'pass', findings: [] }));
  assert.equal(runs, 1, 'таймаут не ретраим');
  assert.equal(r.status, 'blocked');
  assert.ok(gh.calls.some(c => c[0] === 'transitionState' && c[4] === 'midas:state:blocked'));
});

test('acceptor: кап задачи исчерпан → blocked ДО DoD-сессии', async () => {
  const gh = reviewGh(); const k = keeper();
  k.addCost({ task: 'o/r#3', usd: 5, day: '2026-07-03' });
  let sessionCalled = false;
  const r = await runAcceptor(ACC_ARGS(gh, k, async () => { sessionCalled = true; return { ok: true, result: 'DOD: {"items":[]}', costUsd: 0, timedOut: false }; },
    { verdict: 'pass', findings: [] }));
  assert.equal(r.status, 'blocked');
  assert.equal(sessionCalled, false, 'пре-чек капа не пускает DoD-сессию');
});

test('acceptor: план/секция DoD отсутствует → blocked, сессия не запускалась', async () => {
  const gh = reviewGh(); const k = keeper();
  let sessionCalled = false;
  const cr = async () => { sessionCalled = true; return { ok: true, result: 'DOD: {"items":[]}', costUsd: 0, timedOut: false }; };
  const r1 = await runAcceptor(ACC_ARGS(gh, k, cr, { verdict: 'pass', findings: [] }, null));
  assert.equal(r1.status, 'blocked', 'нет плана → blocked');
  const r2 = await runAcceptor(ACC_ARGS(reviewGh(), keeper(), cr, { verdict: 'pass', findings: [] }, '## Цель\nx\n## DoD\n\n## Риски\nr'));
  assert.equal(r2.status, 'blocked', 'пустая секция DoD → blocked');
  assert.equal(sessionCalled, false, 'DoD-сессия не запускалась без пунктов');
});

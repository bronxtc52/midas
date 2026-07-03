import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlockedFromSession } from '../blocked.js';
import { makeBlock, capExceeded } from './common.js';

function workerPrompt(issue, plan, rejectFeedback) {
  return [
    'Ты — Worker фабрики MIDAS. Реализуй план ниже в текущем git-каталоге.',
    'Правила (Конституция): не меняй план; не трогай файлы вне плана; существующие тесты не менять;',
    'никакого force-push/reset/clean; коммитить не нужно — это сделает обвязка.',
    'Если план и реальность репо разошлись — вместо работы выведи одну строку:',
    'BLOCKED: {"question":"...","known":"...","options":["A) ...","B) ..."],"recommendation":"..."}',
    '',
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body || '',
    '',
    '# План (Planner)',
    plan,
    ...(rejectFeedback ? ['', '# Замечания Acceptor/Reviewer с прошлого круга (устрани их)', rejectFeedback] : []),
  ].join('\n');
}

export async function runWorker({ gh, keeper, config, repo, issue, plan, remoteUrl, workRoot, claudeRun, day, rejectFeedback }) {
  const task = `${repo}#${issue.number}`;
  const branch = `midas/issue-${issue.number}`;
  const block = makeBlock({ gh, keeper, config, repo, issue, fromLabel: config.labels.coding });

  const cap = capExceeded({ keeper, config, task });
  if (cap) return block(cap);

  mkdirSync(workRoot, { recursive: true });
  const cwd = join(workRoot, `issue-${issue.number}`);
  if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  execFileSync('git', ['clone', remoteUrl, cwd], { encoding: 'utf8' });
  git(['config', 'user.email', 'midas-bot@adarasoft.com']);
  git(['config', 'user.name', 'midas-bot']);

  // Ветка уже есть (reject-круг или упавший прошлый заход) — продолжаем её.
  const existing = git(['ls-remote', '--heads', 'origin', branch]).trim();
  if (existing) git(['checkout', '-b', branch, `origin/${branch}`]);
  else git(['checkout', '-b', branch]);

  const s = await claudeRun({
    prompt: workerPrompt(issue, plan, rejectFeedback),
    cwd,
    maxTurns: config.session_max_turns,
    timeoutSec: config.session_timeout_sec,
  });
  keeper.addCost({ task, usd: s.costUsd, day });

  if (s.timedOut) {
    return block({
      question: 'Сессия Worker убита по таймауту. Дробить задачу?',
      known: `таймаут ${config.session_timeout_sec}с; потрачено $${s.costUsd.toFixed(2)}; ветка ${branch} не запушена`,
      options: ['A) вернуть в state:coding (ещё попытка)', 'B) разбить issue на меньшие'],
      recommendation: 'B',
    });
  }

  const b = parseBlockedFromSession(s.result);
  if (b) return block(b);

  git(['add', '-A']);
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) git(['commit', '-m', `midas: issue #${issue.number} — ${issue.title}`]);
  const baseRef = existing ? `origin/${branch}` : 'origin/main';
  const ahead = Number(git(['rev-list', '--count', `${baseRef}..HEAD`]).trim());
  if (!dirty && ahead === 0) {
    return block({
      question: 'Сессия Worker завершилась без изменений кода. ТЗ выполнимо в этом репо?',
      known: `план есть, дифф пуст; вывод сессии: ${String(s.result).slice(0, 300)}`,
      options: ['A) уточнить план/issue', 'B) закрыть как неактуальное'],
      recommendation: 'A',
    });
  }

  git(['push', 'origin', branch]);

  const pr = existing
    ? await gh.getPRForBranch(repo, branch)
    : null;
  const ensuredPr = pr ?? await gh.createPR(repo, {
    title: `midas: ${issue.title} (#${issue.number})`,
    head: branch,
    base: 'main',
    body: `Closes #${issue.number}\n\nПлан — в issue (комментарий Planner'а). DoD — по плану, проверяет Acceptor.`,
  });

  await gh.transitionState(repo, issue.number, config.labels.coding, config.labels.review);
  keeper.append({ type: 'work-done', task, pr: ensuredPr?.number });
  return { status: 'review', pr: ensuredPr };
}

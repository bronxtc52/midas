import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { makeKeeper } from './keeper.js';
import { makeGh } from './gh.js';
import { makeDaemon } from './daemon.js';
import { runSession } from './claude.js';
import { runPlanner } from './roles/planner.js';
import { runWorker } from './roles/worker.js';
import { runReviewer } from './roles/reviewer.js';
import { runAcceptor } from './roles/acceptor.js';

const root = process.cwd();
const config = loadConfig(root);
const dataDir = process.env.MIDAS_DATA_DIR || join(root, 'data');
const keeper = makeKeeper(dataDir);

const ghToken = process.env.GH_TOKEN;
if (!ghToken) throw new Error('GH_TOKEN отсутствует — deploy/fetch-env.sh не отработал?');
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY отсутствует');
const gh = makeGh({ token: ghToken });

let sentry = null;
if (process.env.SENTRY_DSN) {
  sentry = await import('@sentry/node');
  sentry.init({ dsn: process.env.SENTRY_DSN, environment: 'production' });
}
const notifyBlocked = (task, question) => {
  // Комментарий в GitHub легко пропустить — дублируем сигналом в Sentry.
  sentry?.captureMessage(`MIDAS blocked: ${task} — ${question}`, 'warning');
};

const rubricPath = join(root, 'docs', 'review-rubric.md');
const rubric = existsSync(rubricPath) ? readFileSync(rubricPath, 'utf8') : '';
const workRoot = join(dataDir, 'scratch');
mkdirSync(workRoot, { recursive: true }); // spawn с несуществующим cwd падает как ENOENT «бинаря»
// Токен НЕ в URL (утекает в error.message git'а и в .git/config) — Worker
// получает его отдельно и отдаёт git-процессам через GIT_ASKPASS.
const remoteUrlOf = (repo) => `https://github.com/${repo}.git`;

async function lastPlanComment(repo, n) {
  const comments = await gh.listComments(repo, n);
  const plans = comments.filter((c) => c.body.includes('## Цель') && c.body.includes('## DoD'));
  return plans.length ? plans[plans.length - 1].body : null;
}
async function lastRejectComment(repo, n) {
  const comments = await gh.listComments(repo, n);
  const rejects = comments.filter((c) => c.body.startsWith('## ❌ REJECT') || c.body.startsWith('## 🔍 Reviewer: ❌'));
  return rejects.length ? rejects[rejects.length - 1].body : null;
}

// Сессии ролей ограничены явным allowlist инструментов: файлы читать/править можно,
// Bash и сеть — нельзя (Конституция §1: минимальные полномочия, git делает обвязка).
// GH_TOKEN сессии не выдаётся вовсе — он нужен только обвязке.
const { GH_TOKEN: _ghTokenHidden, ...sessionEnv } = process.env;
const claudeRun = (args) => runSession({
  ...args,
  env: sessionEnv,
  extraArgs: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write'],
});

const wrapBlocked = (fn) => async (args) => {
  const res = await fn(args);
  if (res?.status === 'blocked') notifyBlocked(`${args.repo}#${args.issue.number}`, res.question ?? '');
  return res;
};

const roles = {
  plan: wrapBlocked(({ repo, issue, day }) =>
    runPlanner({ gh, keeper, config, repo, issue, claudeRun, day, workRoot })),
  work: wrapBlocked(async ({ repo, issue, day }) => {
    const plan = await lastPlanComment(repo, issue.number);
    if (!plan) {
      // issue в coding без плана: fromLabel = coding, иначе blocked-переход
      // скипается и платная сессия перезапускается каждый tick
      return runPlanner({ gh, keeper, config, repo, issue, claudeRun, day, workRoot, fromLabel: config.labels.coding });
    }
    const rejectFeedback = await lastRejectComment(repo, issue.number);
    return runWorker({
      gh, keeper, config, repo, issue, plan, rejectFeedback,
      remoteUrl: remoteUrlOf(repo), gitToken: ghToken, workRoot, claudeRun, day,
    });
  }),
  review: async ({ repo, issue, pr, day }) => {
    const plan = await lastPlanComment(repo, issue.number);
    const verdict = await runReviewer({ gh, keeper, config, repo, issue, pr, plan, rubric, claudeRun, day, workRoot });
    if (verdict.blocked) return { status: 'blocked' };
    return runAcceptor({ gh, config, repo, issue, verdict });
  },
};

// Heartbeat независим от tick'а: длинная Worker-сессия (до 30 мин) не должна
// ронять healthcheck (порог 180 с). Живость процесса ≠ завершённость tick'а.
const beat = () => writeFileSync(join(dataDir, 'heartbeat'), new Date().toISOString());
beat();
setInterval(beat, 30_000).unref();

const daemon = makeDaemon({
  gh, keeper, config, roles,
  log: (m) => console.log(`[midas] ${m}`),
  heartbeat: beat,
  notify: (kind, msg) => sentry?.captureMessage(`MIDAS ${kind}: ${msg}`, kind === 'tick-error' ? 'error' : 'warning'),
});

console.log(`[midas] демон стартует: ${config.repos_allowlist.join(', ')}, tick=${config.poll_interval_sec}с`);
keeper.append({ type: 'daemon-start', repos: config.repos_allowlist });
daemon.start();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[midas] ${sig} — graceful stop`);
    daemon.stop();
    process.exit(0);
  });
}

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
import { makeTelegramNotifier } from './notify/telegram.js';

const root = process.cwd();
const config = loadConfig(root);
const dataDir = process.env.MIDAS_DATA_DIR || join(root, 'data');

// Owner-notify (server-watchdog бот): краткие отчёты о ходе конвейера владельцу.
// No-op без токена/чата. Тип B (только исходящий sendMessage) — см. notify/telegram.js.
const telegram = makeTelegramNotifier({
  token: process.env.MIDAS_TELEGRAM_BOT_TOKEN,
  chatId: process.env.MIDAS_TELEGRAM_CHAT_ID,
  monUrl: process.env.MIDAS_MON_URL || 'https://mon.adarasoft.com',
  repo: config.repos_allowlist[0],
  log: (m) => console.log(`[midas] ${m}`),
});
// Журнал — шина событий: подписываем нотификатор на append (реплей истории при
// старте его не триггерит). fire-and-forget: доставку не ждём, ошибки внутри проглочены.
const keeper = makeKeeper(dataDir, { onAppend: (e) => { telegram.onEvent(e); } });

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

// Rework после ci-gate-red (issue #30): если по ветке есть открытый PR с красными
// чеками — собираем контекст падения (имена упавших чеков + best-effort хвост лога),
// чтобы Worker чинил причину, а не выходил с пустым диффом → ложный blocked.
// Первичный coding: PR ещё нет / чеки не красные → undefined → промпт без CI-блока.
// Сбор best-effort: любая ошибка GH тут не роняет rework (деградация до без-контекста);
// failedCheckLog внутри уже глотает свою ошибку → log='' при живых именах чеков.
async function collectCiFailure(repo, n) {
  try {
    const pr = await gh.getPRForBranch(repo, `midas/issue-${n}`);
    if (!pr) return undefined;
    if ((await gh.checksStatus(repo, pr.head.sha)) !== 'red') return undefined;
    const checks = await gh.failedChecks(repo, pr.head.sha);
    if (!checks.length) return undefined;
    const log = await gh.failedCheckLog(repo, checks[0].id);
    return { checks, log };
  } catch {
    return undefined;
  }
}

// Сессии ролей ограничены явным allowlist инструментов: файлы читать/править можно,
// Bash и сеть — нельзя (Конституция §1: минимальные полномочия, git делает обвязка).
// GH_TOKEN сессии не выдаётся вовсе — он нужен только обвязке. DEEPSEEK_API_KEY
// тоже вырезаем: Council зовёт Node-обвязка Planner'а, не LLM-сессия (спека §3, ADR п.4).
const { GH_TOKEN: _ghTokenHidden, DEEPSEEK_API_KEY: _deepseekKeyHidden, ...sessionEnv } = process.env;
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
    const ciFailure = await collectCiFailure(repo, issue.number);
    return runWorker({
      gh, keeper, config, repo, issue, plan, rejectFeedback, ciFailure,
      remoteUrl: remoteUrlOf(repo), gitToken: ghToken, workRoot, claudeRun, day,
    });
  }),
  // wrapBlocked: blocked-исход (Reviewer ИЛИ Acceptor) даёт status:'blocked' →
  // handleReview не ставит дедуп @review:<sha> (тот же sha ревьюится снова после
  // ручной разблокировки) + уведомление в Sentry, как у остальных ролей.
  review: wrapBlocked(async ({ repo, issue, pr, day }) => {
    const plan = await lastPlanComment(repo, issue.number);
    const verdict = await runReviewer({ gh, keeper, config, repo, issue, pr, plan, rubric, claudeRun, day, workRoot });
    if (verdict.blocked) return { status: 'blocked' };
    return runAcceptor({ gh, keeper, config, repo, issue, pr, verdict, plan, claudeRun, day, workRoot });
  }),
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
  notify: (kind, msg) => sentry?.captureMessage(`MIDAS ${kind}: ${msg}`, ['tick-error', 'issue-error', 'repo-error'].includes(kind) ? 'error' : 'warning'),
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

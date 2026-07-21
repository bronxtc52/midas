import { decide, stateOf } from './statemachine.js';
import { healthSnapshot } from './health.js';

// Orchestrator: только маршрутизация по машине состояний, никакой интерпретации
// содержимого задач (Конституция §2). Одна задача за раз (v1).
const scrub = (s) => String(s).replace(/x-access-token:[^@]+@/g, '***@');

export function makeDaemon({ gh, keeper, config, roles, log = () => {}, heartbeat = () => {}, notify = () => {}, overlapSec = 120, health = healthSnapshot, now = () => Date.now() }) {
  let timer = null;
  let ticking = false;
  // Бэкофф tick-error для Telegram: считаем ОШИБКИ ПОДРЯД. Единичный транзиент
  // (напр. разовый 401 GitHub, демон восстанавливается на следующем тике) не должен
  // слать алёрт; длинный сбой не должен слать его на каждом тике — notifier алёртит
  // на степенях двойки. Журнал пишет КАЖДУЮ ошибку. lastTickError нужен, чтобы
  // событие tick-recovered назвало, что именно чинилось.
  let consecutiveTickErrors = 0;
  let lastTickError = null;
  // Изоляция главного цикла (инцидент 2026-07-21: 403 check-runs ОДНОГО репо валил
  // весь tick — 203 tick-error подряд, фабрика стояла целиком). Ошибка одной задачи /
  // одного репо не должна останавливать остальные. Счётчики — in-memory, как
  // consecutiveTickErrors: рестарт сбрасывает их осознанно (один немедленный ретрай,
  // дальше снова бэкофф) — консистентно с существующим tick-error поведением.
  const issueErrors = new Map(); // `repo#num` → { consecutive, nextRetryAt, error }
  const repoErrors = new Map(); // repo → { consecutive, error }

  // Бэкофф САМОГО ретрая, не только алёрта: персистентная ошибка иначе молотит
  // GitHub (и LLM-роль — деньги) каждые poll_interval_sec. Одиночный транзиент
  // ретраится следующим тиком, серия — экспоненциально до часа.
  function retryCooldownMs(consecutive) {
    if (consecutive < 2) return 0;
    return Math.min(config.poll_interval_sec * 1000 * 2 ** (consecutive - 1), 3_600_000);
  }

  async function handleReview(repo, issue, day) {
    const branch = `midas/issue-${issue.number}`;
    const pr = await gh.getPRForBranch(repo, branch);
    if (!pr) {
      keeper.append({ type: 'review-no-pr', repo, issue: issue.number });
      log(`review без PR: ${repo}#${issue.number} — жду появления ветки ${branch}`);
      return;
    }
    // Ключ дедупа включает sha: новые коммиты (после reject) → новое ревью.
    const key = `${repo}#${issue.number}@review:${pr.head.sha}`;
    if (keeper.hasProcessed(key)) return;

    let checks = await gh.checksStatus(repo, pr.head.sha);
    if (checks === 'none') {
      // Гонка регистрации чеков: свежему PR даём grace-период, старый = репо без CI
      const ageMs = pr.created_at ? Date.now() - new Date(pr.created_at).getTime() : Infinity;
      checks = ageMs < 180_000 ? 'pending' : 'green';
    }
    if (checks === 'pending') return; // ждём следующий tick, дедуп не ставим
    if (checks === 'red') {
      await gh.addComment(repo, issue.number,
        `## ⛔ CI-гейт\nОбязательные чеки PR #${pr.number} красные — Reviewer не запускается, возврат в работу (Конституция §5).`);
      await gh.transitionState(repo, issue.number, config.labels.review, config.labels.coding);
      keeper.append({ type: 'ci-gate-red', repo, issue: issue.number, sha: pr.head.sha });
      return;
    }
    const res = await roles.review({ repo, issue, pr, day });
    // blocked-исход не помечаем: после ручной разблокировки тот же sha должен
    // ревьюиться снова (находка ревью №4)
    if (res?.status !== 'blocked') keeper.markProcessed(key);
    // pr в событии — чтобы Telegram-отчёт accepted вёл на PR (его и мержат), не на issue.
    keeper.append({ type: 'action', action: 'review', repo, issue: issue.number, result: res?.status ?? res?.verdict, pr: pr.number });
  }

  // Снимок живости сервиса после мерджа: URL — только из config.json health_urls[repo]
  // (fleet-реестр server-watchdog НЕ читаем). Нет записи → «не настроен».
  function repoHealth(repo) {
    return health((config.health_urls || {})[repo]);
  }

  // Мерж-детект: после accepted владелец мержит PR → issue закрывается (Closes #N) →
  // задача выпадает из open-поллинга listUpdatedIssues. Поэтому идём по ЖУРНАЛУ
  // accepted-событий (не по open-issue), для каждой ещё-не-помеченной проверяем PR
  // по head-ветке в state:all и ровно один раз эмитим `merged` (дедуп через
  // keeper.markProcessed). MIDAS не мержит/не деплоит — только наблюдает и уведомляет.
  async function checkMerges() {
    // Обратная совместимость: gh без isPRMerged (старые тесты/моки) — шаг пропускаем.
    if (typeof gh.isPRMerged !== 'function') return;
    const accepted = keeper.readAll().filter(
      (e) => e.type === 'action' && e.action === 'review' && e.result === 'accepted' && e.repo && e.issue != null,
    );
    const seen = new Set(); // одна задача может иметь несколько accepted-событий (reject-круги)
    for (const ev of accepted) {
      const key = `${ev.repo}#${ev.issue}@merged`;
      if (seen.has(key) || keeper.hasProcessed(key)) continue;
      seen.add(key);
      try {
        const { merged, number } = await gh.isPRMerged(ev.repo, `midas/issue-${ev.issue}`);
        if (!merged) continue;
        // markProcessed до append: повторный tick не дублирует событие `merged`.
        keeper.markProcessed(key);
        const healthLine = await repoHealth(ev.repo);
        keeper.append({ type: 'merged', repo: ev.repo, issue: ev.issue, pr: number ?? ev.pr ?? null, health: healthLine });
      } catch (e) {
        // Одна сбойная задача (сеть/GH) не должна ронять весь мерж-обход и tick.
        log(`merge-check ${ev.repo}#${ev.issue}: ${scrub(e.message)}`);
      }
    }
  }

  async function tick(opts = {}) {
    heartbeat();
    await checkMerges();
    const day = opts.today ?? new Date().toISOString().slice(0, 10);
    if (keeper.costForDay(day) >= config.cost_cap_usd_per_day) {
      log(`дневной кап $${config.cost_cap_usd_per_day} исчерпан — пауза до следующего дня`);
      keeper.append({ type: 'daily-cap-pause', day });
      notify('daily-cap', `дневной кап $${config.cost_cap_usd_per_day} исчерпан (${day})`);
      return;
    }

    for (const repo of config.repos_allowlist) {
      // Per-repo изоляция: упавшая выборка одного репо не мешает остальным.
      // Кулдаун на уровне репо не нужен: ретрай = 1 list-вызов/тик — обычная
      // цена поллинга, амплификации нет.
      try {
        const cursor = keeper.getCursor(repo);
        // Холодный старт: БЕЗ since — GitHub на since=1970 отвечает пустым списком.
        const since = cursor
          ? new Date(new Date(cursor).getTime() - overlapSec * 1000).toISOString()
          : null;
        const briefs = await gh.listUpdatedIssues(repo, since);
        // Ожидающие CI review-issue не меняют updated_at и выпадают из since-окна
        // (starvation) — выбираем их отдельно по лейблу, без since.
        const reviewing = (await gh.listIssues(repo, { label: config.labels.review })).filter((i) => !i.pull_request);
        const byNumber = new Map([...briefs, ...reviewing].map((i) => [i.number, i]));

        let maxUpdated = cursor;
        for (const brief of byNumber.values()) {
          // Дневной кап перепроверяется на каждой задаче: одна tick-пачка
          // не должна прошивать лимит насквозь
          if (keeper.costForDay(day) >= config.cost_cap_usd_per_day) {
            keeper.append({ type: 'daily-cap-pause', day });
            notify('daily-cap', `дневной кап $${config.cost_cap_usd_per_day} исчерпан посреди tick (${day})`);
            break;
          }
          const ikey = `${repo}#${brief.number}`;
          const prevErr = issueErrors.get(ikey);
          // Кулдаун проверяется ДО getIssue: скип не стоит ни одного API-вызова
          // и не запускает LLM-роли.
          if (prevErr && now() < prevErr.nextRetryAt) continue;
          try {
            await processIssue(repo, brief, day);
            if (prevErr) {
              if (prevErr.consecutive >= 2) {
                keeper.append({ type: 'issue-recovered', repo, issue: brief.number, consecutive: prevErr.consecutive, error: prevErr.error });
              }
              issueErrors.delete(ikey);
            }
            // Курсор продвигается ТОЛЬКО успешно обработанными issue: упавший issue
            // остаётся в since-окне и ретраится после кулдауна даже через рестарт
            // (in-memory счётчик обнулится, но выборка его вернёт).
            if (!maxUpdated || new Date(brief.updated_at) > new Date(maxUpdated)) maxUpdated = brief.updated_at;
          } catch (e) {
            const consecutive = (prevErr?.consecutive ?? 0) + 1;
            issueErrors.set(ikey, { consecutive, nextRetryAt: now() + retryCooldownMs(consecutive), error: scrub(e.message) });
            log(`issue error ${ikey}: ${scrub(e.message)}`);
            keeper.append({ type: 'issue-error', repo, issue: brief.number, error: scrub(e.message), consecutive });
          }
        }
        if (maxUpdated) keeper.setCursor(repo, maxUpdated);
        const prevRepoErr = repoErrors.get(repo);
        if (prevRepoErr) {
          if (prevRepoErr.consecutive >= 2) {
            keeper.append({ type: 'repo-recovered', repo, consecutive: prevRepoErr.consecutive, error: prevRepoErr.error });
          }
          repoErrors.delete(repo);
        }
      } catch (e) {
        const consecutive = (repoErrors.get(repo)?.consecutive ?? 0) + 1;
        repoErrors.set(repo, { consecutive, error: scrub(e.message) });
        log(`repo error ${repo}: ${scrub(e.message)}`);
        keeper.append({ type: 'repo-error', repo, error: scrub(e.message), consecutive });
      }
    }
  }

  // Обработка одной задачи; любой не-throw исход (включая скипы) = успех для
  // курсора и сброса счётчика ошибок.
  async function processIssue(repo, brief, day) {
    // fresh-чтение перед решением: лейблы могли смениться после выборки
    const issue = await gh.getIssue(repo, brief.number);
    const state = stateOf(issue.labels);
    const d = decide(state);
    if (!d) return;

    if (d.action === 'review') {
      await handleReview(repo, issue, day);
      return;
    }

    // label-first: сначала переход, потом роль; optimistic skip при гонке
    if (d.from !== d.to) {
      const t = await gh.transitionState(repo, issue.number, d.from, d.to);
      if (t.skipped) {
        keeper.append({ type: 'race-skip', repo, issue: issue.number, current: t.current });
        return;
      }
    }
    const roleFn = { plan: roles.plan, work: roles.work }[d.action];
    const res = await roleFn({ repo, issue, day });
    keeper.append({ type: 'action', action: d.action, repo, issue: issue.number, result: res?.status });
  }

  return {
    tick,
    start() {
      const loop = async () => {
        if (ticking) return;
        ticking = true;
        try {
          await tick();
          // Успешный tick (без throw) → серия ошибок прервана. Инцидент, о котором алёртили,
          // закрываем парным событием: иначе владелец видит «сломалось» и никогда — «починилось».
          if (consecutiveTickErrors >= 2) {
            keeper.append({ type: 'tick-recovered', error: lastTickError, consecutive: consecutiveTickErrors });
          }
          consecutiveTickErrors = 0;
          lastTickError = null;
        } catch (e) {
          // scrub: сообщения git-ошибок могут содержать credential-URL
          consecutiveTickErrors++;
          lastTickError = scrub(e.message);
          log(`tick error: ${scrub(e.message)}`);
          // consecutive в журнале: notifier шлёт в Telegram по бэкоффу (2,4,8,16,…),
          // но аудит-запись пишется ВСЕГДА (в т.ч. для одиночной ошибки).
          keeper.append({ type: 'tick-error', error: scrub(e.message), consecutive: consecutiveTickErrors });
          notify('tick-error', scrub(e.message));
        } finally {
          ticking = false;
        }
      };
      loop();
      timer = setInterval(loop, config.poll_interval_sec * 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

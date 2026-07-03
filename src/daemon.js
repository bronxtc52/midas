import { decide, stateOf } from './statemachine.js';

// Orchestrator: только маршрутизация по машине состояний, никакой интерпретации
// содержимого задач (Конституция §2). Одна задача за раз (v1).
export function makeDaemon({ gh, keeper, config, roles, log = () => {}, heartbeat = () => {}, overlapSec = 120 }) {
  let timer = null;
  let ticking = false;

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

    const checks = await gh.checksStatus(repo, pr.head.sha);
    if (checks === 'pending') return; // ждём следующий tick, дедуп не ставим
    if (checks === 'red') {
      await gh.addComment(repo, issue.number,
        `## ⛔ CI-гейт\nОбязательные чеки PR #${pr.number} красные — Reviewer не запускается, возврат в работу (Конституция §5).`);
      await gh.transitionState(repo, issue.number, config.labels.review, config.labels.coding);
      keeper.append({ type: 'ci-gate-red', repo, issue: issue.number, sha: pr.head.sha });
      return;
    }
    const res = await roles.review({ repo, issue, pr, day });
    keeper.markProcessed(key);
    keeper.append({ type: 'action', action: 'review', repo, issue: issue.number, result: res?.status ?? res?.verdict });
  }

  async function tick(opts = {}) {
    heartbeat();
    const day = opts.today ?? new Date().toISOString().slice(0, 10);
    if (keeper.costForDay(day) >= config.cost_cap_usd_per_day) {
      log(`дневной кап $${config.cost_cap_usd_per_day} исчерпан — пауза до следующего дня`);
      keeper.append({ type: 'daily-cap-pause', day });
      return;
    }

    for (const repo of config.repos_allowlist) {
      const cursor = keeper.getCursor(repo);
      // Холодный старт: БЕЗ since — GitHub на since=1970 отвечает пустым списком.
      const since = cursor
        ? new Date(new Date(cursor).getTime() - overlapSec * 1000).toISOString()
        : null;
      const briefs = (await gh.listUpdatedIssues(repo, since)).filter((i) => !i.pull_request);

      let maxUpdated = cursor;
      for (const brief of briefs) {
        if (!maxUpdated || new Date(brief.updated_at) > new Date(maxUpdated)) maxUpdated = brief.updated_at;

        // fresh-чтение перед решением: лейблы могли смениться после выборки
        const issue = await gh.getIssue(repo, brief.number);
        const state = stateOf(issue.labels);
        const d = decide(state);
        if (!d) continue;

        if (d.action === 'review') {
          await handleReview(repo, issue, day);
          continue;
        }

        // label-first: сначала переход, потом роль; optimistic skip при гонке
        if (d.from !== d.to) {
          const t = await gh.transitionState(repo, issue.number, d.from, d.to);
          if (t.skipped) {
            keeper.append({ type: 'race-skip', repo, issue: issue.number, current: t.current });
            continue;
          }
        }
        const roleFn = { plan: roles.plan, work: roles.work }[d.action];
        const res = await roleFn({ repo, issue, day });
        keeper.append({ type: 'action', action: d.action, repo, issue: issue.number, result: res?.status });
      }
      if (maxUpdated) keeper.setCursor(repo, maxUpdated);
    }
  }

  return {
    tick,
    start() {
      const loop = async () => {
        if (ticking) return;
        ticking = true;
        try {
          await tick();
        } catch (e) {
          log(`tick error: ${e.message}`);
          keeper.append({ type: 'tick-error', error: String(e.message) });
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

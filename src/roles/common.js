import { formatBlocked } from '../blocked.js';

export const MIN_SESSION_BUDGET_USD = 0.05;

// Общий blocked-выход роли: канонический комментарий + state:blocked + журнал.
export function makeBlock({ gh, keeper, config, repo, issue, fromLabel }) {
  return async (b) => {
    await gh.addComment(repo, issue.number, formatBlocked(b));
    await gh.transitionState(repo, issue.number, fromLabel, config.labels.blocked);
    keeper.append({ type: 'blocked', task: `${repo}#${issue.number}`, question: b.question });
    return { status: 'blocked', question: b.question };
  };
}

// Пре-чек капа задачи ДО старта сессии (BACKLOG 3.3): вернёт blocked-объект или null.
export function capExceeded({ keeper, config, task }) {
  const spent = keeper.costForTask(task);
  const cap = config.cost_cap_usd_per_task;
  if (spent < cap - MIN_SESSION_BUDGET_USD) return null;
  return {
    question: `Кап стоимости задачи исчерпан: потрачено $${spent.toFixed(2)} из $${cap}. Как поступаем?`,
    known: `лимит cost_cap_usd_per_task=$${cap}; расход по журналу Keeper'а`,
    options: ['A) поднять кап задачи в config.json', 'B) закрыть задачу'],
    recommendation: 'решение владельца',
  };
}

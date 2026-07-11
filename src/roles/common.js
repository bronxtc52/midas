import { formatBlocked } from '../blocked.js';

export const MIN_SESSION_BUDGET_USD = 0.05;

// Извлекает первый сбалансированный `{...}`-блок из строки, корректно
// учитывая строковые литералы JSON и экранирование (скобки внутри
// `"note":"a{b}"` не ломают счётчик глубины). null — блок не найден.
// Общий для толерантных парсеров маркер-вывода (parseVerdict/parseDod).
export function extractBalancedObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      if (--depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

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

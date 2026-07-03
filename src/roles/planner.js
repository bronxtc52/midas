import { parseBlockedFromSession } from '../blocked.js';
import { makeBlock, capExceeded } from './common.js';

const SECTIONS = ['## Цель', '## Файлы-объекты', '## Шаги', '## DoD', '## Риски'];

export function validatePlan(text) {
  return SECTIONS.every((s) => (text || '').includes(s));
}

function plannerPrompt(issue) {
  return [
    'Ты — Planner фабрики MIDAS. Составь план реализации по issue ниже.',
    'Правила (Конституция): не пиши код; не выбирай между взаимоисключающими трактовками ТЗ.',
    `Ответ — строго markdown-план из 5 секций: ${SECTIONS.join(', ')}.`,
    'Секция ## DoD — только проверяемые да/нет пункты списком "- [ ] ...".',
    'Если ТЗ неполно или допускает ≥2 взаимоисключающих трактовки — вместо плана выведи одну строку:',
    'BLOCKED: {"question":"...","known":"...","options":["A) ...","B) ..."],"recommendation":"..."}',
    '',
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body || '(пустое тело)',
  ].join('\n');
}

export async function runPlanner({ gh, keeper, config, repo, issue, claudeRun, day, workRoot }) {
  const task = `${repo}#${issue.number}`;
  const block = makeBlock({ gh, keeper, config, repo, issue, fromLabel: config.labels.planning });

  const cap = capExceeded({ keeper, config, task });
  if (cap) return block(cap);

  const s = await claudeRun({
    prompt: plannerPrompt(issue),
    cwd: workRoot,
    maxTurns: config.session_max_turns,
    timeoutSec: config.session_timeout_sec,
  });
  keeper.addCost({ task, usd: s.costUsd, day });

  if (s.timedOut) {
    return block({
      question: 'Сессия Planner убита по таймауту. Перезапустить или уточнить ТЗ?',
      known: `таймаут ${config.session_timeout_sec}с; потрачено $${s.costUsd.toFixed(2)}`,
      options: ['A) вернуть в state:ready (перезапуск)', 'B) уточнить issue'],
      recommendation: 'B',
    });
  }

  const b = parseBlockedFromSession(s.result);
  if (b) return block(b);

  if (!s.ok || !validatePlan(s.result)) {
    return block({
      question: 'План не прошёл валидацию формата (5 обязательных секций). Уточнить ТЗ?',
      known: 'вывод сессии не содержит обязательных секций плана',
      options: ['A) вернуть в state:ready (перезапуск Planner)', 'B) уточнить issue'],
      recommendation: 'B',
    });
  }

  await gh.addComment(repo, issue.number, s.result);
  await gh.transitionState(repo, issue.number, config.labels.planning, config.labels.coding);
  keeper.markProcessed(`${task}@planning`);
  return { status: 'planned' };
}

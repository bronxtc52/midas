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

// fromLabel параметризован: fallback «в coding без плана» должен блокироваться
// из своего фактического state, иначе transitionState тихо скипает и демон
// перезапускает платную сессию каждый tick (находка ревью №3).
export async function runPlanner({ gh, keeper, config, repo, issue, claudeRun, day, workRoot, fromLabel }) {
  const task = `${repo}#${issue.number}`;
  const from = fromLabel ?? config.labels.planning;
  const block = makeBlock({ gh, keeper, config, repo, issue, fromLabel: from });

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
    keeper.append({ type: 'cost-unknown', task, note: 'сессия убита таймаутом, usage не получен' });
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
    keeper.append({ type: 'plan-invalid', task, ok: s.ok, snippet: String(s.result || s.raw).slice(0, 500) });
    return block({
      question: 'План не прошёл валидацию формата (5 обязательных секций). Уточнить ТЗ?',
      known: `ok=${s.ok}; вывод сессии (начало): ${String(s.result || s.raw).slice(0, 300)}`,
      options: ['A) вернуть в state:ready (перезапуск Planner)', 'B) уточнить issue'],
      recommendation: 'B',
    });
  }

  await gh.addComment(repo, issue.number, s.result);
  // Approval-гейт (opt-in по лейблу gate:plan): помеченная задача паузит на
  // state:awaiting-approval между planning и coding — mon даёт человеку approve/reject.
  // Гейт применяем ТОЛЬКО из planning: fallback-реплан (from===coding) не гейтим (иначе
  // no-op переход coding→coding и лишняя пауза уже прошедшей гейт задачи).
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  const gated = from === config.labels.planning && labelNames.includes(config.labels.gate_plan);
  const target = gated ? config.labels.awaiting_approval : config.labels.coding;
  if (from !== target) {
    await gh.transitionState(repo, issue.number, from, target);
  }
  keeper.markProcessed(`${task}@planning`);
  return { status: gated ? 'awaiting-approval' : 'planned' };
}

import { parseBlockedFromSession, parseForkFromSession } from '../blocked.js';
import { askCouncil as askCouncilDefault } from '../council.js';
import { makeBlock, capExceeded } from './common.js';

const SECTIONS = ['## Цель', '## Файлы-объекты', '## Шаги', '## DoD', '## Риски'];

export function validatePlan(text) {
  return SECTIONS.every((s) => (text || '').includes(s));
}

// Первая непустая строка под секцией «## Цель» (для краткого Telegram-пинга approve).
export function extractGoal(plan) {
  const lines = String(plan || '').split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith('## Цель'));
  if (idx === -1) return '';
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('## ')) break; // дошли до следующей секции — цели нет
    if (t) return t.slice(0, 200);
  }
  return '';
}

function plannerPrompt(issue, extra) {
  return [
    'Ты — Planner фабрики MIDAS. Составь план реализации по issue ниже.',
    'Правила (Конституция): не пиши код; не выбирай между взаимоисключающими трактовками ТЗ.',
    `Ответ — строго markdown-план из 5 секций: ${SECTIONS.join(', ')}.`,
    'Секция ## DoD — только проверяемые да/нет пункты списком "- [ ] ...".',
    'Если упираешься в АРХИТЕКТУРНУЮ развилку из 2–3 взаимоисключающих вариантов',
    '(именно выбор ветки реализации, а НЕ нехватка данных) — вместо плана выведи одну строку:',
    'FORK: {"question":"...","known":"...","options":["A) ...","B) ..."],"recommendation":"..."}',
    'Если ТЗ неполно, нет данных/доступа или в нём противоречия — вместо плана выведи одну строку:',
    'BLOCKED: {"question":"...","known":"...","options":["A) ...","B) ..."],"recommendation":"..."}',
    '',
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body || '(пустое тело)',
    extra || '',
  ].join('\n');
}

// fromLabel параметризован: fallback «в coding без плана» должен блокироваться
// из своего фактического state, иначе transitionState тихо скипает и демон
// перезапускает платную сессию каждый tick (находка ревью №3).
export async function runPlanner({ gh, keeper, config, repo, issue, claudeRun, day, workRoot, fromLabel, askCouncil = askCouncilDefault }) {
  const task = `${repo}#${issue.number}`;
  const from = fromLabel ?? config.labels.planning;
  const block = makeBlock({ gh, keeper, config, repo, issue, fromLabel: from });

  const cap = capExceeded({ keeper, config, task });
  if (cap) return block(cap);

  const runSession = async (extra) => {
    const s = await claudeRun({
      prompt: plannerPrompt(issue, extra),
      cwd: workRoot,
      maxTurns: config.session_max_turns,
      timeoutSec: config.session_timeout_sec,
    });
    keeper.addCost({ task, usd: s.costUsd, day });
    return s;
  };
  const timeoutBlock = (s) => {
    keeper.append({ type: 'cost-unknown', task, note: 'сессия убита таймаутом, usage не получен' });
    return block({
      question: 'Сессия Planner убита по таймауту. Перезапустить или уточнить ТЗ?',
      known: `таймаут ${config.session_timeout_sec}с; потрачено $${s.costUsd.toFixed(2)}`,
      options: ['A) вернуть в state:ready (перезапуск)', 'B) уточнить issue'],
      recommendation: 'B',
    });
  };

  let s = await runSession();
  if (s.timedOut) return timeoutBlock(s);

  const b = parseBlockedFromSession(s.result);
  if (b) return block(b);

  // Архитектурная развилка (FORK) — единственное, что имеет право решить Council.
  // Пре-чеки капов ПЕРЕД вызовом: вне капа Council не зовём (Конституция §2),
  // идём тем же путём, что и при его недоступности («Planner решает сам»).
  const fork = parseForkFromSession(s.result);
  if (fork) {
    const overTaskCap = !!capExceeded({ keeper, config, task });
    const overDayCap = keeper.costForDay(day) >= config.cost_cap_usd_per_day;
    let council;
    if (overTaskCap || overDayCap) {
      council = { ok: false, reason: 'cap-exceeded' };
    } else {
      // issue-текст целиком в вопрос НЕ вставляем — только сформулированную развилку.
      const question = [
        fork.question,
        fork.known ? `Известно: ${fork.known}` : '',
        `Варианты:\n${fork.options.join('\n')}`,
        fork.recommendation ? `Рекомендация Planner'а: ${fork.recommendation}` : '',
      ].filter(Boolean).join('\n\n');
      council = await askCouncil({ question, slug: config.council_slug, capUsd: config.council_cap_usd });
    }

    if (council.ok) {
      keeper.append({ type: 'council', task, ok: true });
      // Фактический usd из CLI/direct в v1 недоступен — учитываем консервативно по капу.
      keeper.addCost({ task, usd: config.council_cap_usd, day });
      s = await runSession(`# Рекомендация Council (совещательная)\n${council.answer}`);
    } else if (council.reason === 'secret-detected') {
      // Секрет в исходящем payload'е (Конституция §1.3) — находка, а не развилка → человек.
      return block({
        question: 'В развилке Planner\'а обнаружен секрет — Council не вызван, нужен человек',
        known: `${task}: containsSecret сработал на payload FORK; развилка: ${fork.question}`,
        options: ['A) убрать секрет из формулировки и перезапустить Planner', 'B) решить развилку вручную'],
        recommendation: 'A',
      });
    } else {
      // unavailable / вне капа: Планнер решает сам с пометкой в журнале (Конституция §2).
      keeper.append({ type: 'council', task, ok: false, reason: council.reason });
      s = await runSession('# Council недоступен\nCouncil недоступен — выбери вариант сам по собственной recommendation из FORK и зафиксируй сделанный выбор в секции ## Риски.');
    }

    if (s.timedOut) return timeoutBlock(s);
    // Повторный прогон РОВНО один: снова FORK/BLOCKED → человек (защита от петли и расхода).
    const b2 = parseBlockedFromSession(s.result) || parseForkFromSession(s.result);
    if (b2) {
      return block({
        question: 'После второго мнения Council план всё ещё не сошёлся — нужен человек',
        known: `${task}: повторный прогон Planner снова вернул FORK/BLOCKED; исходная развилка: ${fork.question}`,
        options: ['A) решить развилку вручную и вернуть в state:ready', 'B) уточнить issue'],
        recommendation: 'A',
      });
    }
  }

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
  if (gated) {
    // Спец-событие для owner-notify: несёт title + Цель, чтобы Telegram-пинг
    // «ждёт одобрения» не обращался к GitHub из нотификатора (см. notify/telegram.js).
    keeper.append({ type: 'awaiting-approval', task, issue: issue.number, title: issue.title, goal: extractGoal(s.result) });
  }
  keeper.markProcessed(`${task}@planning`);
  return { status: gated ? 'awaiting-approval' : 'planned' };
}

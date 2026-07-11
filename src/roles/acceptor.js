import { makeBlock, capExceeded, parseLastMarkedJson } from './common.js';

const DIFF_CAP = 200_000; // как у Reviewer'а: огромный дифф в argv → E2BIG

// Промпт Acceptor'а: проверить КАЖДЫЙ пункт DoD по диффу PR, не изобретая
// собственных критериев (Конституция §2). Строгая последняя строка с маркером DOD:.
function acceptorPrompt({ issue, dodSection, diff, reviewerVerdict }) {
  return [
    'Ты — Acceptor фабрики MIDAS. Проверь КАЖДЫЙ пункт DoD по диффу PR.',
    'Новые критерии не изобретай (Конституция §2): проверяешь ровно пункты секции DoD ниже, ничего сверх.',
    'Для каждого пункта укажи pass=true|false и краткое evidence (ссылку на дифф/файл).',
    'Последняя строка ответа — строго:',
    'DOD: {"items":[{"item":"...","pass":true|false,"evidence":"..."}]}',
    '',
    `# Issue #${issue.number}: ${issue.title || ''}`,
    issue.body || '',
    '# DoD (проверяемые пункты)',
    dodSection,
    `# Вердикт Reviewer'а`,
    reviewerVerdict || '(нет)',
    '# Дифф PR',
    diff,
  ].join('\n');
}

// Вырезает содержимое секции `## DoD` из план-комментария: от строки-заголовка
// до следующего `## ` (корректно, когда DoD не последняя секция). Пусто — секции
// нет или она пустая. Экспортируется для юнит-теста.
export function extractDoD(plan) {
  const lines = String(plan || '').split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## DoD');
  if (idx === -1) return '';
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('## ')) break; // дошли до следующей секции
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// Результат DoD-сессии: строка `DOD: {"items":[{"item":...,"pass":...,"evidence":...}]}`.
// По образцу parseVerdict: толерантен к однострочному/fence/многострочному JSON,
// берётся сбалансированный `{...}` от первой `{` после ПОСЛЕДНЕГО `DOD:`.
// Непарсибельно / нет массива items → `{unparsed:true}` (fail-closed: молчание
// Acceptor'а не принимает код).
export function parseDod(text) {
  const d = parseLastMarkedJson(text, 'DOD:', (o) => Array.isArray(o.items));
  return d == null ? { unparsed: true } : d;
}

// Acceptor: только accept/reject, «принять с замечаниями» не существует
// (Конституция §2). ACCEPT = verdict=pass И каждый пункт DoD = да (§5).
// Причины reject — только непройденные пункты DoD или fail-находки Reviewer'а.
export async function runAcceptor({ gh, keeper, config, repo, issue, pr, verdict, plan, claudeRun, day, workRoot }) {
  const task = `${repo}#${issue.number}`;
  const block = makeBlock({ gh, keeper, config, repo, issue, fromLabel: config.labels.review });

  // Пути reject/accept — единые действия над лейблами/состоянием.
  const reject = async (reasons) => {
    await gh.addComment(repo, issue.number, `## ❌ REJECT (Acceptor)\n${reasons}`);
    await gh.addLabels(repo, issue.number, [config.labels.reject]);
    await gh.transitionState(repo, issue.number, config.labels.review, config.labels.coding);
    return { status: 'rejected' };
  };

  // verdict=fail → REJECT сразу, без LLM-сессии: accept всё равно невозможен (§5),
  // не жжём деньги. Причины — fail-находки Reviewer'а (nit не влияет).
  if (verdict.verdict === 'fail') {
    const reasons = (verdict.findings || [])
      .filter((f) => f.severity !== 'nit')
      .map((f) => `- [${f.severity}] ${f.note}`)
      .join('\n');
    return reject(`Причины:\n${reasons || '- вердикт Reviewer: fail'}`);
  }

  // verdict=pass → собственная DoD-проверка Acceptor'а (Конституция §5).
  // Нет плана / пустая секция DoD — гейт Planner→Worker гарантирует DoD ≥1 пункт,
  // пустота = аномалия для человека (не accept и не reject «на пустом месте»).
  const dodSection = extractDoD(plan);
  if (!dodSection) {
    return block({
      question: 'Acceptor не нашёл пунктов DoD в плане — проверять PR не по чему, нужен человек',
      known: `${task}, PR #${pr.number}: ${plan ? 'план есть, но секция ## DoD пуста' : 'план-комментарий не найден'}`,
      options: ['A) восстановить план с секцией DoD и вернуть в review', 'B) проверить PR вручную'],
      recommendation: 'A) восстановить план с секцией DoD',
    });
  }

  // Пре-чек капа задачи ДО платной сессии.
  const cap = capExceeded({ keeper, config, task });
  if (cap) return block(cap);

  let diff = await gh.getPRDiff(repo, pr.number);
  if (diff.length > DIFF_CAP) {
    diff = diff.slice(0, DIFF_CAP) + '\n\n[... дифф усечён обвязкой; часть DoD могла не попасть в проверку ...]';
  }
  const prompt = acceptorPrompt({ issue, dodSection, diff, reviewerVerdict: verdict.verdict });

  // Один прогон DoD-сессии: стоимость учитывается на КАЖДЫЙ прогон.
  const runOnce = async () => {
    const s = await claudeRun({
      prompt,
      cwd: workRoot,
      maxTurns: Math.min(config.session_max_turns, 10),
      timeoutSec: config.session_timeout_sec,
    });
    keeper.addCost({ task, usd: s.costUsd, day });
    if (s.timedOut) return { dod: null, timedOut: true };
    return { dod: parseDod(s.result), timedOut: false };
  };

  const timeoutBlock = () => block({
    question: 'Сессия Acceptor убита по таймауту — DoD не проверен, нужен человек',
    known: `${task}, PR #${pr.number}: таймаут ${config.session_timeout_sec}с`,
    options: ['A) проверить PR вручную и принять/отклонить', 'B) перезапустить review'],
    recommendation: 'A) проверить PR вручную',
  });

  let { dod, timedOut } = await runOnce();
  // Таймаут — сразу blocked (по образцу Reviewer'а): не сбой формата, а зависшая сессия.
  if (timedOut) return timeoutBlock();
  // Непарсибельный DOD (сбой формата) и НЕ таймаут — один повторный прогон;
  // повторный провал уводит здоровый PR в blocked (человек), НЕ в accept/reject.
  if (dod.unparsed) {
    ({ dod, timedOut } = await runOnce());
    if (timedOut) return timeoutBlock();
    if (dod.unparsed) {
      return block({
        question: 'Acceptor дважды не отдал DOD — нужен человек',
        known: `${task}, PR #${pr.number}: DoD-сессия отработала, но вывод не распарсен дважды подряд — вероятно, сбой формата вывода модели`,
        options: ['A) проверить PR вручную и принять/отклонить', 'B) перезапустить review'],
        recommendation: 'A) проверить PR вручную',
      });
    }
  }

  const items = dod.items || [];
  const failed = items.filter((it) => it.pass !== true);
  if (failed.length === 0) {
    await gh.removeLabel?.(repo, issue.number, config.labels.reject); // остаток reject-круга
    await gh.addLabels(repo, issue.number, [config.labels.accept]);
    await gh.transitionState(repo, issue.number, config.labels.review, config.labels.accepted);
    await gh.addComment(repo, issue.number,
      `## ✅ ACCEPT (Acceptor)\nВердикт Reviewer'а pass и каждый пункт DoD пройден. PR готов к приёму — сливает только человек.`);
    keeper.append({ type: 'accept', task, items: items.length });
    return { status: 'accepted' };
  }
  // REJECT: только ссылки на непройденные пункты DoD (Конституция §2).
  const reasons = 'Непройденные пункты DoD:\n' +
    failed.map((it) => `- [DoD] ${it.item}: ${it.evidence || 'пункт не пройден'}`).join('\n');
  keeper.append({ type: 'reject', task, failed: failed.length });
  return reject(reasons);
}

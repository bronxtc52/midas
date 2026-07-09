import { makeBlock, capExceeded } from './common.js';

// Извлекает первый сбалансированный `{...}`-блок из строки, корректно
// учитывая строковые литералы JSON и экранирование (скобки внутри
// `"note":"a{b}"` не ломают счётчик глубины). null — блок не найден.
function extractBalancedObject(s) {
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

// Вердикт сессии: строка `VERDICT: {"verdict":"pass|fail","findings":[...]}`.
// Толерантен к реальным форматам вывода модели: однострочный JSON, JSON в
// ```/```json fence, многострочный JSON — берётся сбалансированный `{...}`
// от первой `{` после ПОСЛЕДНЕГО вхождения `VERDICT:`.
// Непарсибельно = fail с внутренним флагом `unparsed` (осознанно: молчание
// ревьюера не пропускает код). Флаг отличает сбой парсинга от честного fail.
export function parseVerdict(text) {
  const unparsed = { verdict: 'fail', findings: [{ severity: 'high', note: 'вердикт не распарсен' }], unparsed: true };
  const src = text || '';
  const idx = src.lastIndexOf('VERDICT:');
  if (idx < 0) return unparsed;
  const json = extractBalancedObject(src.slice(idx + 'VERDICT:'.length));
  if (json == null) return unparsed;
  try {
    const v = JSON.parse(json);
    if (v.verdict !== 'pass' && v.verdict !== 'fail') return unparsed;
    v.findings ??= [];
    return v;
  } catch {
    return unparsed;
  }
}

function reviewerPrompt({ issue, plan, diff, rubric }) {
  return [
    'Ты — Reviewer фабрики MIDAS. Проревьюй дифф PR против плана и рубрики.',
    'Обязательно: пройди КАЖДЫЙ пункт секции DoD плана — непройденный пункт = находка severity high и verdict fail.',
    'Правила (Конституция): код не правишь; вкусовые замечания помечай severity "nit" — они не влияют на вердикт.',
    'Последняя строка ответа — строго:',
    'VERDICT: {"verdict":"pass|fail","findings":[{"severity":"high|med|low|nit","note":"...","file":"..."}]}',
    '',
    rubric ? `# Рубрика\n${rubric}` : '',
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body || '',
    '# План',
    plan || '(план не найден)',
    '# Дифф PR',
    diff,
  ].join('\n');
}

export async function runReviewer({ gh, keeper, config, repo, issue, pr, plan, rubric, claudeRun, day, workRoot }) {
  const task = `${repo}#${issue.number}`;
  const block = makeBlock({ gh, keeper, config, repo, issue, fromLabel: config.labels.review });

  const cap = capExceeded({ keeper, config, task });
  if (cap) {
    await block(cap);
    return { verdict: 'fail', findings: [{ severity: 'high', note: 'кап стоимости задачи исчерпан до ревью' }], blocked: true };
  }

  let diff = await gh.getPRDiff(repo, pr.number);
  const DIFF_CAP = 200_000; // огромный дифф в argv → E2BIG и невнятный fail
  if (diff.length > DIFF_CAP) {
    diff = diff.slice(0, DIFF_CAP) + '\n\n[... дифф усечён обвязкой; это находка severity high: PR слишком большой ...]';
  }
  const prompt = reviewerPrompt({ issue, plan, diff, rubric });
  // Один прогон ревью-сессии: стоимость учитывается на КАЖДЫЙ прогон.
  const runOnce = async () => {
    const s = await claudeRun({
      prompt,
      cwd: workRoot,
      maxTurns: Math.min(config.session_max_turns, 10),
      timeoutSec: config.session_timeout_sec,
    });
    keeper.addCost({ task, usd: s.costUsd, day });
    if (s.timedOut) {
      // Таймаут — честный fail, не ретраим (не сбой формата, а зависшая сессия).
      return { verdict: { verdict: 'fail', findings: [{ severity: 'high', note: 'ревью-сессия убита по таймауту' }] }, timedOut: true };
    }
    return { verdict: parseVerdict(s.result), timedOut: false };
  };

  let { verdict, timedOut } = await runOnce();
  // Непарсибельный вердикт (сбой формата, а не находки по коду) и НЕ таймаут —
  // один повторный прогон; повторный провал уводит здоровый PR в blocked
  // (человек), а НЕ в reject→coding rework-петлю.
  if (verdict.unparsed && !timedOut) {
    ({ verdict, timedOut } = await runOnce());
    if (verdict.unparsed && !timedOut) {
      await block({
        question: 'Reviewer дважды не отдал вердикт в формате VERDICT — нужен человек',
        known: `${task}, PR #${pr.number}: ревью-сессия отработала, но вердикт не распарсен дважды подряд — вероятно, PR здоров, сбой в формате вывода модели`,
        options: ['A) проверить PR вручную и принять/отклонить', 'B) перезапустить ревью'],
        recommendation: 'A) проверить PR вручную',
      });
      return { verdict: 'fail', findings: verdict.findings, blocked: true };
    }
  }

  const lines = verdict.findings.map((f) => `- [${f.severity}] ${f.file ? `\`${f.file}\`: ` : ''}${f.note}`);
  await gh.addComment(repo, issue.number,
    `## 🔍 Reviewer: ${verdict.verdict === 'pass' ? '✅ pass' : '❌ fail'}\n${lines.join('\n') || '- находок нет'}`);
  keeper.append({ type: 'review', task, verdict: verdict.verdict, findings: verdict.findings.length });
  return verdict;
}

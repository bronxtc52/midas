import { makeBlock, capExceeded } from './common.js';

// Вердикт сессии: строка `VERDICT: {"verdict":"pass|fail","findings":[...]}`.
// Непарсибельно = fail (осознанно: молчание ревьюера не пропускает код).
export function parseVerdict(text) {
  const unparsed = { verdict: 'fail', findings: [{ severity: 'high', note: 'вердикт не распарсен' }] };
  const m = (text || '').match(/^VERDICT:\s*(\{.*\})\s*$/m);
  if (!m) return unparsed;
  try {
    const v = JSON.parse(m[1]);
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

  const diff = await gh.getPRDiff(repo, pr.number);
  const s = await claudeRun({
    prompt: reviewerPrompt({ issue, plan, diff, rubric }),
    cwd: workRoot,
    maxTurns: Math.min(config.session_max_turns, 10),
    timeoutSec: config.session_timeout_sec,
  });
  keeper.addCost({ task, usd: s.costUsd, day });

  const verdict = s.timedOut
    ? { verdict: 'fail', findings: [{ severity: 'high', note: 'ревью-сессия убита по таймауту' }] }
    : parseVerdict(s.result);

  const lines = verdict.findings.map((f) => `- [${f.severity}] ${f.file ? `\`${f.file}\`: ` : ''}${f.note}`);
  await gh.addComment(repo, issue.number,
    `## 🔍 Reviewer: ${verdict.verdict === 'pass' ? '✅ pass' : '❌ fail'}\n${lines.join('\n') || '- находок нет'}`);
  keeper.append({ type: 'review', task, verdict: verdict.verdict, findings: verdict.findings.length });
  return verdict;
}

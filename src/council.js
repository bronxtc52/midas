import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Секрет-фильтр перед отправкой стороннему провайдеру (DeepSeek-челлендж №1.8).
// Находка = отказ от Council по этому вопросу, не «замаскировать и послать».
const SECRET_PATTERNS = [
  /sk-ant-[a-z0-9-]+/i,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /gho_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /password\s*[=:]\s*\S+/i,
  /xox[baprs]-/,
];

export function containsSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text || ''));
}

function defaultExec(binPath) {
  return ({ question, slug, capUsd }) =>
    new Promise((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'midas-council-'));
      const input = join(dir, 'question.md');
      const out = join(dir, 'answer.md');
      writeFileSync(input, question);
      execFile(
        binPath,
        ['--model', slug, '--input', input, '--temperature', '0', '--max-cost-usd', String(capUsd), '--out', out],
        { timeout: 300_000 },
        (err) => {
          if (err) return reject(err);
          try { resolve(readFileSync(out, 'utf8')); } catch (e) { reject(e); }
        },
      );
    });
}

// Council: внешнее мнение для развилок Planner'а. Недоступен → деградация
// в решение Planner'а (ok:false), никогда не бросает.
export async function askCouncil({ question, slug, capUsd, exec, binPath = 'or-fusion' }) {
  if (containsSecret(question)) return { ok: false, reason: 'secret-detected' };
  const run = exec ?? defaultExec(binPath);
  try {
    const answer = await run({ question, slug, capUsd });
    return { ok: true, answer };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

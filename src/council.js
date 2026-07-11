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

// Прямой zero-dep вызов DeepSeek через глобальный fetch (Node 20): or-fusion в
// образе нет и ставить его не нужно. Модель = часть slug после `deepseek-direct/`.
// Reasoning-модель ест бюджет → max_tokens не занижаем; таймаут ~300с через
// AbortController. Пустой/обрезанный ответ или !ok/сетевая ошибка → throw, чтобы
// askCouncil деградировал в `unavailable`. Ключ — только из env, наружу не логируем.
export function directDeepseekExec(apiKey = process.env.DEEPSEEK_API_KEY) {
  return async ({ question, slug }) => {
    const model = String(slug || '').replace(/^deepseek-direct\//, '');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300_000);
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: question }],
          temperature: 0,
          max_tokens: 8000,
        }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`deepseek http ${res.status}`);
      const data = await res.json();
      const answer = data?.choices?.[0]?.message?.content;
      if (!answer) throw new Error('deepseek empty answer');
      return answer;
    } finally {
      clearTimeout(timer);
    }
  };
}

// Выбор exec: slug `deepseek-direct/*` + env DEEPSEEK_API_KEY → прямой HTTPS;
// иначе or-fusion CLI как fallback. Нет ни того ни другого → deps упадут в exec
// и askCouncil вернёт `unavailable`.
function pickExec(slug, binPath) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (String(slug || '').startsWith('deepseek-direct/') && key) return directDeepseekExec(key);
  return defaultExec(binPath);
}

// Council: внешнее мнение для развилок Planner'а. Недоступен → деградация
// в решение Planner'а (ok:false), никогда не бросает.
export async function askCouncil({ question, slug, capUsd, exec, binPath = 'or-fusion' }) {
  if (containsSecret(question)) return { ok: false, reason: 'secret-detected' };
  const run = exec ?? pickExec(slug, binPath);
  try {
    const answer = await run({ question, slug, capUsd });
    return { ok: true, answer };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

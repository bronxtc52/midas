import { spawn } from 'node:child_process';

// Обёртка headless Claude Code. Превентивные границы (BACKLOG 3.3):
// --max-turns + жёсткий таймаут с kill — постфактум-учёта стоимости мало.
export function runSession({
  prompt,
  cwd,
  maxTurns = 30,
  timeoutSec = 1800,
  bin = process.env.CLAUDE_BIN || 'claude',
  env = process.env,
  extraArgs = [],
}) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns), ...extraArgs];
    const child = spawn(bin, args, { cwd, env });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, costUsd: 0, result: '', raw: `spawn error (${e.code}): bin=${bin} cwd=${cwd}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed = null;
      try {
        const lines = out.trim().split('\n');
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch { /* не-JSON вывод */ }
      resolve({
        ok: !timedOut && !!parsed && !parsed.is_error,
        timedOut,
        costUsd: parsed?.total_cost_usd ?? 0,
        result: parsed?.result ?? '',
        raw: out || err,
      });
    });
  });
}

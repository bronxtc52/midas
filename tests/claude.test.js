import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSession } from '../src/claude.js';

function fakeBin(dir, script) {
  const p = join(dir, 'fake-claude');
  writeFileSync(p, '#!/usr/bin/env node\n' + script);
  chmodSync(p, 0o755);
  return p;
}

test('runSession: парсит result и total_cost_usd из JSON-вывода', async () => {
  const d = mkdtempSync(join(tmpdir(), 'midas-claude-'));
  const bin = fakeBin(d, `console.log(JSON.stringify({ result: 'готово', total_cost_usd: 0.12 }));`);
  const r = await runSession({ prompt: 'сделай', cwd: d, maxTurns: 5, timeoutSec: 10, bin });
  assert.equal(r.ok, true);
  assert.equal(r.result, 'готово');
  assert.equal(r.costUsd, 0.12);
  assert.equal(r.timedOut, false);
});

test('runSession: таймаут убивает процесс и возвращает timedOut', async () => {
  const d = mkdtempSync(join(tmpdir(), 'midas-claude-'));
  const bin = fakeBin(d, `setTimeout(() => console.log('{}'), 60000);`);
  const t0 = Date.now();
  const r = await runSession({ prompt: 'висни', cwd: d, maxTurns: 5, timeoutSec: 1, bin });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000, 'убит по таймауту, а не дожил до конца');
});

test('runSession: не-JSON вывод → ok:false, но cost по умолчанию 0 и raw сохранён', async () => {
  const d = mkdtempSync(join(tmpdir(), 'midas-claude-'));
  const bin = fakeBin(d, `console.log('мусор не-json'); process.exit(0);`);
  const r = await runSession({ prompt: 'x', cwd: d, maxTurns: 5, timeoutSec: 10, bin });
  assert.equal(r.ok, false);
  assert.equal(r.costUsd, 0);
  assert.match(r.raw, /мусор/);
});

test('runSession: пробрасывает --max-turns и промпт аргументами', async () => {
  const d = mkdtempSync(join(tmpdir(), 'midas-claude-'));
  const bin = fakeBin(d, `console.log(JSON.stringify({ result: process.argv.join('|'), total_cost_usd: 0 }));`);
  const r = await runSession({ prompt: 'PROMPT-МАРКЕР', cwd: d, maxTurns: 7, timeoutSec: 10, bin });
  assert.match(r.result, /--max-turns\|7/);
  assert.match(r.result, /PROMPT-МАРКЕР/);
});

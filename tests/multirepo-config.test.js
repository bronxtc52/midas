import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('config.json: repos_allowlist содержит и midas, и server-watchdog', () => {
  const cfg = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.repos_allowlist));
  assert.ok(cfg.repos_allowlist.includes('bronxtc52/midas'), 'midas в allowlist');
  assert.ok(cfg.repos_allowlist.includes('bronxtc52/server-watchdog'), 'server-watchdog в allowlist');
});

test('bootstrap-labels.sh: репо параметризован (арг с дефолтом), не хардкод', () => {
  const sh = readFileSync(join(here, '..', 'scripts', 'bootstrap-labels.sh'), 'utf8');
  assert.match(sh, /REPO="\$\{1:-bronxtc52\/midas\}"/, 'REPO берётся из $1 с дефолтом bronxtc52/midas');
});

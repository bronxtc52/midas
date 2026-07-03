import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Критерий приёмки №9: в коде ролей нет вызова merge-API GitHub.
function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('в src/ нет merge-эндпоинтов GitHub API', () => {
  const files = walk(new URL('../src', import.meta.url).pathname);
  assert.ok(files.length > 0, 'src/ не пуст');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/\/merge\b/.test(src), `merge-эндпоинт в ${f}`);
    assert.ok(!/merge_method/.test(src), `merge_method в ${f}`);
    assert.ok(!/mergePullRequest|\bmergePr\b/i.test(src), `merge-хелпер в ${f}`);
  }
});

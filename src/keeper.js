import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Keeper: JSONL-журнал (только вперёд, без правок прошлого), курсор per-repo,
// агрегаты стоимости. Всё восстанавливается из файлов при рестарте.
export function makeKeeper(dataDir, { now = () => new Date().toISOString() } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const journalPath = join(dataDir, 'journal.jsonl');
  const cursorPath = join(dataDir, 'cursor.json');

  const events = [];
  const processed = new Set();
  const costByTask = new Map();
  const costByDay = new Map();

  function absorb(e) {
    events.push(e);
    if (e.type === 'processed') processed.add(e.key);
    if (e.type === 'cost') {
      costByTask.set(e.task, (costByTask.get(e.task) || 0) + e.usd);
      costByDay.set(e.day, (costByDay.get(e.day) || 0) + e.usd);
    }
  }

  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
      if (line.trim()) absorb(JSON.parse(line));
    }
  }

  let cursors = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')) : {};

  return {
    append(event) {
      const e = { ts: now(), ...event };
      appendFileSync(journalPath, JSON.stringify(e) + '\n');
      absorb(e);
    },
    readAll: () => [...events],
    hasProcessed: (key) => processed.has(key),
    markProcessed(key) {
      this.append({ type: 'processed', key });
    },
    addCost({ task, usd, day }) {
      this.append({ type: 'cost', task, usd, day });
    },
    costForTask: (task) => costByTask.get(task) || 0,
    costForDay: (day) => costByDay.get(day) || 0,
    getCursor: (repo) => cursors[repo] ?? null,
    setCursor(repo, iso) {
      const cur = cursors[repo];
      if (cur && new Date(iso) <= new Date(cur)) return; // только вперёд
      cursors = { ...cursors, [repo]: iso };
      const tmp = cursorPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(cursors));
      renameSync(tmp, cursorPath); // атомарно
    },
  };
}

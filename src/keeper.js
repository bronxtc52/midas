import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Порог ротации журнала: при достижении текущий journal.jsonl переименовывается
// в journal.jsonl.1, запись продолжается в свежий файл. Хранятся ровно две
// генерации — данные старше двух генераций теряются by design (десятки тысяч
// событий на генерацию, к этому моменту соответствующие issues давно закрыты).
const ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024;

// Keeper: JSONL-журнал (только вперёд, без правок прошлого), курсор per-repo,
// агрегаты стоимости. Всё восстанавливается из файлов при рестарте.
export function makeKeeper(dataDir, { now = () => new Date().toISOString(), onAppend, rotateThreshold = ROTATE_THRESHOLD_BYTES } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const journalPath = join(dataDir, 'journal.jsonl');
  const journalRotatedPath = join(dataDir, 'journal.jsonl.1');
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

  function replayFile(path) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      // Оборванная строка (kill посреди записи, полный диск) не должна
      // превращать restart:always в вечный crash-loop — скип с warn.
      try {
        absorb(JSON.parse(line));
      } catch {
        console.warn(`[keeper] пропущена битая строка журнала: ${line.slice(0, 120)}`);
      }
    }
  }

  // .1 содержит более старые записи → читаем его первым, чтобы хронологический
  // порядок событий (и, значит, порядок восстановления агрегатов) сохранялся.
  replayFile(journalRotatedPath);
  replayFile(journalPath);

  let cursors = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')) : {};

  return {
    append(event) {
      const e = { ts: now(), ...event };
      // Ротация по размеру: если текущий журнал перевалил порог — переименовать
      // его в .1 (перезаписав старую генерацию, если была), новое событие пишем
      // в свежий journal.jsonl. renameSync атомарен и перезаписывает цель.
      if (existsSync(journalPath) && statSync(journalPath).size >= rotateThreshold) {
        renameSync(journalPath, journalRotatedPath);
      }
      appendFileSync(journalPath, JSON.stringify(e) + '\n');
      absorb(e);
      // Подписчик (напр. Telegram-нотификатор) — best-effort: его сбой не должен
      // ломать журнал/демон. Реплей истории при старте идёт через absorb(), не
      // через append() → onAppend не триггерится на историю (без спама).
      if (onAppend) {
        try { onAppend(e); } catch (err) { console.warn(`[keeper] onAppend упал: ${err.message}`); }
      }
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

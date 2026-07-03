# MIDAS

Автономная «фабрика разработки»: Worker-агент на VPS программно гоняет Claude Code-сессии,
роли исполняют обычные модели, главный ограничитель ошибок — Конституция. События GitHub
(Actions-раны, чеки) демон получает polling'ом, VPS остаётся закрытым (без публичных
endpoint'ов).

**Статус:** спека midas-v1 утверждена 2026-07-03; кода и инфраструктуры ещё нет.
Репо создан 2026-07-03, чтобы вывести MIDAS из knowledge-base в отдельный проект.

## Источники истины (пока живут в knowledge-base)

| Документ | Где |
|---|---|
| ADR: события — polling v1, вебхуки по триггеру | `knowledge-base/adr/midas-events-polling-v1.md` |
| ADR: оплата Worker'а — OAuth владельца v1, API-key по триггерам | `knowledge-base/adr/midas-worker-payment-oauth-vs-api-key.md` |
| Задача спринта: BACKLOG этапов 0–6 (t2-3) | `knowledge-base/sprint/fable-2026-07/t2-3-midas-backlog.md` |
| Задача спринта: Конституция v1.1 (t3-4) | `knowledge-base/sprint/fable-2026-07/t3-4-midas-constitution.md` |
| Eval: план polling-демона | `knowledge-base/evals/tasks/e-plan-midas-polling-daemon.md` |

## Структура репо

- `materials/` — входные материалы, в т.ч. спека `2026-07-03-midas-v1-design.md`
  (⚠️ ещё не положена — файл спеки в workspace mh-central не найден, принести от владельца).
- `plans/` — implementation-планы; первым появится `midas-v1-backlog.md` (задача t2-3).
- `docs/` — проектные документы; сюда же ляжет `constitution.md` v1.1 (задача t3-4,
  копия-ссылка останется в KB).

## Трекер задач

Решение владельца (2026-07-03): **GitHub Issues + Projects** этого репо — канбан и для
человека, и для Worker'а/демона (единый контур с polling'ом Actions по ADR
`midas-events-polling-v1`, тот же лимит 5000/час, задачи связываются с PR/ранами).
Notion/Planka отклонены: стороннее облако / второй сервис в интеграции.
Настроено 2026-07-03: labels `этап-0`…`этап-6` + `blocked`, milestone `v1`,
Project-доска **[MIDAS v1](https://github.com/users/bronxtc52/projects/3)**
(привязана к репо; колонки Todo / In Progress / Done, blocked — label'ом).
Issues раскладываются из BACKLOG (t2-3) по его готовности.

## Открытые вопросы спеки (маппинг из t2-3)

1. Слаги OpenRouter и owner-логин → этап 0.
2. Оплата Worker'а → этап 3 (решено ADR: гибрид OAuth v1 + API-key по триггерам).
3. Конституция часть 2/2 — сверить при появлении.
4. Сверка со спекой midas-v1 частью 2/2 — «при появлении».

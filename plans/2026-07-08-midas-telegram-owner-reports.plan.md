# План — Telegram-отчёты MIDAS владельцу

ТЗ: `docs/specs/2026-07-08-midas-telegram-owner-reports.md`. Размер **M**, риск-доменов нет
(деньги/authz/PII/prod-infra не тронуты; секрет только читаем из env). План/код — Sonnet,
внешнее платное ревью не требуется.

## Файлы
1. **`src/notify/telegram.js`** (new) — `eventToMessage(event,{monUrl,repo})` (чистая, whitelist
   типов → строка|null) + `makeTelegramNotifier({token,chatId,monUrl,repo,fetch,log})` →
   `{onEvent}` (no-op без token/chatId; POST sendMessage plain-text; ошибки проглатываются).
2. **`src/keeper.js`** — `makeKeeper(dataDir,{now,onAppend})`; в `append()` после `absorb` →
   `onAppend?.(e)` в try/catch. Реплей истории `onAppend` не трогает.
3. **`src/roles/planner.js`** — для gated-задачи append `{type:'awaiting-approval',task,issue,title,goal}`
   (goal = 1-я строка под `## Цель`, ≤200) перед return.
4. **`src/daemon-main.js`** — env `MIDAS_TELEGRAM_BOT_TOKEN`/`_CHAT_ID`/`MIDAS_MON_URL`;
   `notifier=makeTelegramNotifier(...)`; `makeKeeper(dataDir,{onAppend:e=>notifier.onEvent(e)})`.
   Sentry-путь сохраняем.
5. **`deploy/fetch-env.sh`** — выгрузка `server-watchdog--production--TELEGRAM-BOT-TOKEN`/`--CHAT-ID`
   в `MIDAS_TELEGRAM_BOT_TOKEN`/`_CHAT_ID` (деплой-шаг, с «ок»).

## Тесты (TDD, отдельный коммит до реализации)
- `tests/telegram-notify.test.js` — маппер (крит. 1–4), notifier no-op/fetch-once/no-parse_mode/
  ошибка-проглочена (5–7), no-op-токен, статический grep notify-only-границы (13), zero-dep (14).
- `tests/keeper.test.js` (extend) — onAppend вызывается на append, try/catch на бросающем
  подписчике (8), реплей не триггерит onAppend (9).
- `tests/roles.test.js` (extend/new) — planner gated → журнал-событие awaiting-approval с title+goal (10).

## Порядок
tests(fail) → commit tests → impl telegram.js → keeper → planner → daemon-main → fetch-env.sh →
npm test green → reviewer+tester → PR.

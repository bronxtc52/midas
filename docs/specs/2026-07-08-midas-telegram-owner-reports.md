# ТЗ — Telegram-отчёты фабрики MIDAS владельцу (+ пинг-запрос approve)

**Дата:** 2026-07-08 · **Репозиторий:** `bronxtc52/midas` (движок) · **Статус:** ⏳ ожидает подтверждения владельцем
**Канал:** бот **server-watchdog** (исходящий owner-notify, правило `~/.claude/rules/telegram-owner-notify.md`).

## 1. Цель

Фабрика MIDAS в реальном времени шлёт владельцу **краткие** сообщения о ходе конвейера
в личный Telegram-чат. Для задач с approval-гейтом (`midas:gate:plan`) сообщение
`awaiting-approval` — это **запрос одобрения**: краткий план + **ссылка на mon**, где кнопки
Approve/Reject уже живут (Фаза 3). Owner-notify — только **исходящий**; approve/reject
физически происходит в mon web UI за сессией.

## 2. Решения владельца (приняты, не пересматривать)

1. **Approve = пинг + ссылка на mon** (не inline-кнопки в Telegram). Telegram остаётся
   **notify-only, тип B** — никаких кнопок/команд/`getUpdates`/входящих триггеров из чата.
2. **Нотификатор в движке MIDAS, real-time** (не watchdog-дайджест) — врезка в поток журнала.

## 3. Контракт (разобран по коду `~/projects/Midas`, 2026-07-08)

- **Журнал = шина событий:** `keeper.append(event)` (`src/keeper.js:41`) — единственная точка,
  через которую проходят все значимые события. Реплей журнала при старте идёт через `absorb()`,
  **не** через `append()` → историю в Telegram НЕ дублируем (нужное поведение).
- **Существующий `notify(kind,msg)`** (`daemon.js`, kinds `daily-cap`/`tick-error`) идёт только в
  Sentry (`daemon-main.js:102`). `notifyBlocked` (`daemon-main.js:28`) — тоже только Sentry.
- **События с контекстом:** `work-done {task, pr}` (worker), `action {action, repo, issue, result}`
  (daemon), `blocked {task, question}` (`roles/common.js` makeBlock), `ci-gate-red {repo, issue, sha}`,
  `daily-cap-pause {day}`, `tick-error {error}` (уже scrub-ается от credential-URL).
- **Approval-гейт:** planner (`roles/planner.js:78`) возвращает `status: 'awaiting-approval'` для
  gated-задачи; сейчас отдельного журнал-события нет (только `action result:awaiting-approval`).
- **Лейблы/URL:** `config.json` labels namespace `midas:*`; repo фиксирован `bronxtc52/midas`;
  mon — `https://mon.adarasoft.com` (вкладка «Агенты»); issue-URL — `github.com/<repo>/issues/<n>`.

## 4. User stories

1. Как владелец, вижу в Telegram короткое сообщение на каждом значимом шаге задачи: план готов →
   кодинг; PR открыт → ревью; принято (ждёт моего мерджа); отклонено ревью; заблокировано (с
   вопросом); CI-красный; дневной кап исчерпан; tick-error фабрики.
2. Как владелец, для gated-задачи получаю **запрос одобрения**: `⏸ #N «title» ждёт одобрения
   плана` + краткая **Цель** плана + **ссылка на mon** (где жму Approve/Reject).
3. Как владелец, если Telegram-токен не сконфигурирован, фабрика работает как раньше —
   нотификатор молча выключен (no-op, как Sentry сейчас), ничего не падает.
4. Как владелец, уверен, что из Telegram НЕЛЬЗЯ ничего запустить: бот только шлёт, не слушает.

## 5. Ограничения — что НЕ делаем

- **Notify-only (тип B, не смягчается):** никаких inline-кнопок, callback-запросов, команд,
  `getUpdates`/webhook-приёма, авто-ремедиации из чата. Только `sendMessage` наружу.
- **Не меняем approve-механику mon** (Фаза 3) — только ссылаемся на неё.
- **Не трогаем** state machine, капы стоимости ($5/задача, $20/день), роли-сессии, gh-контур.
- **Zero-dep:** без новых npm-зависимостей — глобальный `fetch` (Node 22), как весь MIDAS.
- **Не режем** сообщение срезом `[:N]` посреди строки; **без `parse_mode`** (plain text) →
  HTML-escape не требуется, сырой URL Telegram авто-линкует (обходим parse-грабли KB).
- **Секрет** только в env/заголовке `Authorization`-нет (Telegram — токен в URL пути
  `/bot<token>/sendMessage`, как в owner-notify правиле) — **не логируем** тело URL/токен.

## 6. Дизайн решения

### 6.1. Новый модуль `src/notify/telegram.js` (чистый, тестируемый)
- `eventToMessage(event, { monUrl, repo }) → string | null` — **чистая функция**, маппит
  журнал-событие в текст сообщения или `null` (событие не репортим). Whitelist типов:
  - `work-done` → `🔨 #<pr?> код готов, PR открыт → ревью` (+ issue-ссылка);
  - `action` c `result:'planned'` → `📋 #N план готов → кодинг`;
  - `action` c `result:'accepted'` → `✅ #N принято — ждёт мерджа владельцем`;
  - `action` c `result:'rejected'` → `♻️ #N отклонено ревью → возврат в кодинг`;
  - `action` c `result:'awaiting-approval'` → **null** (обрабатывается спец-событием, без дублей);
  - `awaiting-approval` (спец-событие, см. 6.3) → `⏸ #N «title» ждёт одобрения плана.\nЦель: <goal>\nОдобрить в mon: https://mon.adarasoft.com (вкладка «Агенты»)`;
  - `blocked` → `🚧 #N заблокировано: <question>` (+ issue-ссылка);
  - `ci-gate-red` → `⛔ #N CI красный → возврат в кодинг`;
  - `daily-cap-pause` → `💰 Дневной кап $<cap> исчерпан — пауза до завтра`;
  - `tick-error` → `❗ MIDAS tick-error: <error>` (error уже scrub-нут в daemon.js);
  - все прочие (`processed`,`cost`,`race-skip`,`review-no-pr`,`cost-unknown`,`plan-invalid`,`daemon-start`) → **null** (шум не шлём).
- `makeTelegramNotifier({ token, chatId, monUrl, repo, fetch, log }) → { onEvent(event) }`:
  `onEvent` вызывает `eventToMessage`; если `null` — выход; иначе **fire-and-forget** POST
  `https://api.telegram.org/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview:true}`
  без `parse_mode`. **No-op**, если `!token || !chatId`. Ошибка сети/HTTP — `log`+проглотить
  (доставка отчёта НЕ должна ронять tick — как try/catch в owner-notify правиле). Токен в
  сообщения/лог не попадает.

### 6.2. Врезка в поток журнала — `src/keeper.js`
- `makeKeeper(dataDir, { now, onAppend } = {})`: в `append()` после `absorb(e)` вызвать
  `onAppend?.(e)` в **try/catch** (сбой подписчика не ломает журнал/демон). Реплей при старте
  (`absorb` в цикле чтения файла) `onAppend` НЕ трогает → без спама историей.

### 6.3. Enrichment approval-события — `src/roles/planner.js`
- Для gated-задачи (перед `return {status:'awaiting-approval'}`) добавить
  `keeper.append({ type:'awaiting-approval', task, issue: issue.number, title: issue.title, goal })`,
  где `goal` — первая непустая строка под `## Цель` из `s.result` (короткая, ≤200 симв).
  Это даёт Telegram-сообщению title+Цель без обращения к gh из нотификатора.
  (Согласовано ТЗ Фазы 3 §6.1 — «journal-событие awaiting-approval + notify».)

### 6.4. Проводка — `src/daemon-main.js`
- Прочитать env `MIDAS_TELEGRAM_BOT_TOKEN`, `MIDAS_TELEGRAM_CHAT_ID`,
  `MIDAS_MON_URL` (def `https://mon.adarasoft.com`).
- Создать `notifier = makeTelegramNotifier({...})`; передать `onAppend: (e)=>notifier.onEvent(e)`
  в `makeKeeper`. Sentry-путь `notify`/`notifyBlocked` **оставляем** (Telegram — в дополнение,
  не вместо): `daily-cap`/`tick-error`/`blocked` теперь идут и в Sentry (как было), и в Telegram
  (через журнал-тап). Дублирования Telegram нет — тап единственный источник.

## 7. Критерии приёмки (проверяемые да/нет)

1. `eventToMessage({type:'work-done',task:'bronxtc52/midas#5',pr:7},...)` → непустая строка с
   упоминанием PR/ревью; `type:'processed'|'cost'|'race-skip'|'daemon-start'` → `null`.
2. `action` result `planned`/`accepted`/`rejected` → соответствующие непустые строки;
   result `awaiting-approval` → `null` (без дубля со спец-событием).
3. `eventToMessage({type:'awaiting-approval',issue:5,title:'X',goal:'G'},{monUrl})` → строка
   содержит `mon.adarasoft.com` **и** текст цели `G` **и** номер issue.
4. `blocked` → строка содержит текст `question`; `ci-gate-red` → строка про CI; `daily-cap-pause`
   → строка про кап; `tick-error` → строка содержит переданный (scrub-нутый) `error`.
5. `makeTelegramNotifier` без `token` (или без `chatId`): `onEvent(любое)` **не** вызывает `fetch`
   (мок fetch не дёрнут) и не бросает — no-op.
6. С `token`+`chatId`: `onEvent(work-done)` вызывает `fetch` ровно раз, URL начинается с
   `https://api.telegram.org/bot`, метод POST, тело содержит `chat_id` и `text`, **нет**
   `parse_mode`; на `null`-событие (`processed`) `fetch` не вызывается.
7. Ошибка `fetch` (reject/HTTP-500) внутри `onEvent` не пробрасывается наружу (проглочена+залогирована).
8. `keeper.append` с `onAppend`-подписчиком, который **бросает** исключение, всё равно пишет
   событие в журнал и не бросает (try/catch вокруг `onAppend`).
9. Реплей журнала при старте (`makeKeeper` на существующем файле) **не** вызывает `onAppend`
   (тест: подписчик-счётчик = 0 вызовов после конструктора при непустом journal.jsonl).
10. planner для gated-задачи append-ит событие `type:'awaiting-approval'` с `title` и непустым
    `goal` (юнит на извлечение goal из плана с секцией `## Цель`).
11. Токен НЕ появляется в логах/тексте сообщения (grep: `log`-вызовы нотификатора не содержат token).
12. `npm test` зелёный, включая новые тесты; существующие инварианты MIDAS (state machine,
    капы, per-line resilience журнала) не нарушены.
13. Ни в одном файле нет `getUpdates`/`setWebhook`/`callback`/`answerCallbackQuery`/`inline_keyboard`
    /`reply_markup` (grep-проверка notify-only границы — статический тест).
14. Zero-dep: `package.json` без новых зависимостей.

## 8. Human-блокеры (Гейт 0)

- **Новый секрет НЕ нужен** — MIDAS в рантайме читает существующие
  `server-watchdog--production--TELEGRAM-BOT-TOKEN`/`--TELEGRAM-CHAT-ID` из KV.
  **Деплой-шаг (отдельно, с «ок»):** `deploy/fetch-env.sh` в репо MIDAS дописать выгрузку этих
  двух значений в `MIDAS_TELEGRAM_BOT_TOKEN`/`MIDAS_TELEGRAM_CHAT_ID` + рестарт демона.
- **Мердж PR в `bronxtc52/midas` (ветка `main`)** — красная зона, мержит владелец (как Фаза 3).
- **Живой смоук** (после деплоя, с «ок»): дождаться реального перехода задачи → проверить, что
  сообщение пришло в чат владельца; либо контролируемый тест-append.
- Прочих доступов/оплат/внешних действий не требуется. Telegram sendMessage — бесплатно.

## 9. Допущения (решены сами — скажи «иначе»)

- **A. Plain text без `parse_mode`.** Обходит HTML-escape грабли; URL авто-линкуется. Markdown/HTML
  форматирование сообщений не делаем (звёздочки плана останутся литералами в редком плане-эксцерпте).
- **B. Ссылка на mon = корень `https://mon.adarasoft.com`** (SPA, вкладка «Агенты»), без per-issue
  deep-link — дашборд не имеет issue-роутинга. Owner логинится (сессия) и видит задачу.
- **C. Отчёт по `action`-переходам, `work-done`, `blocked`, `ci-gate-red`, капам, tick-error.**
  Рутинный шум (`processed`/`cost`/`race-skip`/`review-no-pr`/`daemon-start`) НЕ шлём. Если хочешь
  `daemon-start` («фабрика запущена») — скажи, добавлю.
- **D. Sentry-путь сохраняем** (Telegram в дополнение, не вместо).

## 10. Definition of Done (форма сдачи)

- **PR в `bronxtc52/midas`** (ветка `feat/telegram-owner-reports`): модуль `src/notify/telegram.js`,
  правки `keeper.js`/`planner.js`/`daemon-main.js`, `deploy/fetch-env.sh` (env-выгрузка), тесты. Ссылка.
- Зелёный `npm test` (вывод в отчёте).
- Обновлены: `Midas/CLAUDE.md` (строка про Telegram-нотификации), README при необходимости.
- Деплой (отдельный шаг, `pushed != deployed`, с «ок»): `git pull` + `fetch-env.sh` + рестарт демона
  + живой смоук в Telegram владельца (глазами — память `verify-visual-features-by-eye`).

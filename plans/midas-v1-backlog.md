# BACKLOG midas-v1 — этапы 0–6

Источник: `docs/specs/midas-v1.md` (утв. владельцем 2026-07-03). Задача ≤0.5 дня,
у каждой: цель, объекты, DoD, зависимости. Стек: Node 20 ESM без сборки, тесты —
встроенный `node:test`, рантайм-зависимости — минимум (Sentry SDK; GitHub API через
глобальный `fetch`, без octokit). Исполнение — сессия `midas` / Sonnet-агенты.

## Этап 0 — Фундамент

- **0.1 Скелет и конфиг.** `package.json` (ESM, node>=20), `config.json`:
  `repos_allowlist`, `poll_interval_sec` (45), `cost_cap_usd_per_task`,
  `cost_cap_usd_per_day`, `council_slug` (`deepseek-direct/deepseek-v4-pro`),
  `labels`-словарь. Загрузчик `src/config.js` (env-оверрайды).
  DoD: `node --check` всех файлов; конфиг читается тестом. Зависит: —.
- **0.2 Секреты.** `deploy/fetch-env.sh` из KV: `ANTHROPIC-API-KEY`, `SENTRY-DSN`,
  `GH-TOKEN`. GH-токен — **fine-grained PAT** `midas--production--GH-TOKEN`
  (выпускает владелец, доступ только к allowlist-репо: contents/issues/PR — RW) —
  наименьшие привилегии по челленджу DeepSeek №1.4; до его появления fallback
  `gh auth token` хоста с пометкой риска в журнале. `.env` gitignored, права 600.
  DoD: скрипт идемпотентен, `.env.example` без значений. Зависит: 0.1.
- **0.3 GitHub-примитивы.** `src/gh.js`: `fetch` к api.github.com (Bearer из env),
  функции: issues по label, комментарий, смена labels, PR list/create, rate-limit
  (заголовки `x-ratelimit-*` → backoff). DoD: юнит-тесты на моках fetch, включая
  429/403-backoff. Зависит: 0.1.
- **0.4 State-лейблы в GitHub.** Скрипт `scripts/bootstrap-labels.sh`: `state:*`
  (ready/planning/coding/review/blocked/accepted/rejected) + `midas:accept|reject`.
  DoD: лейблы существуют в `bronxtc52/midas`. Зависит: —.
- **0.5 CI.** `.github/workflows/ci.yml`: `node --test` + gitleaks-скан + **тест
  «в src/ нет merge-вызовов»** (статический: grep merge-эндпоинтов GitHub API —
  критерий приёмки №9). DoD: зелёный ран на PR. Зависит: 0.1.

## Этап 1 — Демон событий (Orchestrator + Keeper-журнал)

- **1.1 Курсор и журнал.** `src/keeper.js`: JSONL-журнал `data/journal.jsonl`
  (event, ts извне), курсор `data/cursor.json` (атомарная запись через tmp+rename).
  **Механизм курсора (DeepSeek №1.2/3.5):** per-repo watermark по `updated_at` с
  окном перекрытия −120 с при выборке + дедуп обработанного по журналу
  (`repo#issue@state-переход` уже журналирован → пропуск). Идемпотентность, не
  только «последнее виденное». DoD: тесты — рестарт не теряет и не дублирует;
  событие внутри окна перекрытия не обрабатывается дважды. Зависит: 0.3.
- **1.2 Машина состояний.** `src/statemachine.js`: чистая функция
  `(issueState, event) → action`; таблица переходов из спеки §3; `state:blocked`
  терминален для автоматики. **Дисциплина переходов (DeepSeek №1.1/1.7):**
  label-first — сначала перевод лейбла, потом запуск роли; перед PATCH — свежее
  перечитывание лейблов issue, ожидаемый state не совпал → событие пропустить
  (optimistic check), никаких повторных стартов роли. DoD: тест на каждый переход,
  на запрещённые и на гонку «лейбл сменился между опросом и PATCH». Зависит: —.
- **1.3 Цикл демона.** `src/daemon.js`: tick каждые `poll_interval_sec`; выборка
  issues/PR из allowlist-репо; перед диспетчеризацией — fresh-перечитывание issue;
  диспетчеризация ролей; одна задача одновременно (v1, без параллелизма); graceful
  shutdown. DoD: интеграционный тест на моках gh: ready-issue за один tick уходит
  в planning; упавший между label и ролью демон после рестарта продолжает без
  дубля. Зависит: 1.1, 1.2, 0.3.

## Этап 2 — Planner + Worker MVP

- **2.1 Обёртка Claude Code.** `src/claude.js`: spawn `claude -p --output-format json`
  с рабочим каталогом, промптом, таймаутом, `max-turns`; парс usage/cost из ответа.
  DoD: тест на моке бинаря (fake claude), таймаут убивает процесс. Зависит: 0.1.
- **2.2 Planner.** `src/roles/planner.js`: issue → план-комментарий **строго из
  5 секций Конституции §2: Цель / Файлы-объекты / Шаги / DoD / Риски** (DeepSeek
  №2.1) → `state:coding`; при неполном ТЗ — blocked-протокол (формат Конституции
  §3). DoD: тесты обоих исходов на моках; тест валидатора 5 секций. Зависит: 2.1, 1.2.
- **2.3 Worker.** `src/roles/worker.js`: клон/чек-аут allowlist-репо во временный
  каталог → ветка `midas/issue-<n>` → headless-сессия с планом → коммит/пуш → PR
  (`Closes #<n>`) → `state:review`. Запрет merge — в коде нет вызова merge-API.
  DoD: интеграционный тест на локальном bare-репо (без сети). Зависит: 2.1, 2.2.
- **2.4 Blocked-протокол.** `src/blocked.js`: постановка вопроса (формат: вопрос /
  что известно / варианты), проверка «не трогать до ручного возврата лейбла».
  DoD: тест — blocked-issue игнорируется демоном. Зависит: 1.2.

## Этап 3 — Экономика (Keeper-учёт)

- **3.1 Учёт стоимости.** Keeper пишет usage/cost каждой сессии в журнал; сумма
  per task и per day. DoD: тест агрегации. Зависит: 2.1, 1.1.
- **3.2 Капы.** Превышение капа задачи → стоп сессии, `state:blocked` + комментарий
  с $-отчётом; дневной кап → демон в паузу до полуночи UTC + Sentry-событие.
  DoD: тесты обоих капов. Зависит: 3.1.
- **3.3 Превентивные границы сессии (DeepSeek №1.3/3.3).** Постфактум-учёта мало:
  каждой headless-сессии — `--max-turns` из конфига + жёсткий таймаут с kill
  процесса; превышение любого из них = `state:blocked` с отчётом. Кап задачи
  проверяется и ДО старта сессии (осталось < мин. бюджета → не стартуем).
  DoD: тест «таймаут убивает и блокирует», тест «пре-чек капа не пускает».
  Зависит: 2.1, 3.1.

## Этап 4 — Reviewer

- **4.1 Рубрика.** Вендорим рубрику KB t2-2 в `docs/review-rubric.md` (ссылка на
  первоисточник). DoD: файл в репо. Зависит: —.
- **4.2 Reviewer.** `src/roles/reviewer.js`: PR со `state:review` → headless-ревью
  диффа по рубрике → структурированный вердикт-комментарий (verdict: pass/fail +
  находки) → передача Acceptor'у. Кода не правит. DoD: тест на моках. Зависит: 2.1, 4.1.
- **4.3 CI-гейт перед Reviewer (DeepSeek №1.5/2.2/3.2).** Демон перед запуском
  Reviewer'а запрашивает check-runs PR: все обязательные зелёные → ревью; красные →
  комментарий с падениями + возврат `state:coding`; pending → подождать следующего
  tick'а. DoD: тесты трёх исходов на моках. Зависит: 0.3, 4.2.

## Этап 5 — Acceptor + Council

- **5.1 Acceptor.** `src/roles/acceptor.js`: вердикт Reviewer'а + DoD issue →
  `midas:accept` (→`state:accepted`) или `midas:reject` (→`state:coding` + причины).
  DoD: тесты обоих исходов. Зависит: 4.2.
- **5.2 Council.** `src/council.js`: shell-out в `or-fusion` (слаг из конфига, кап
  из конфига) для развилок Planner'а; недоступен → деградация в решение Planner'а
  с пометкой в журнале. **Перед отправкой — секрет-фильтр (DeepSeek №1.8):**
  регекспы ключей/токенов/паролей + `.env`-паттерны; находка → отказ от Council
  по этому вопросу (blocked-путь, не «замаскировать и послать»). DoD: тест
  деградации (без сети) + тест отказа при секрете в тексте. Зависит: 2.2.

## Этап 6 — Деплой, E2E, hardening

- **6.1 Docker.** `deploy/Dockerfile` (node:20-slim + git + gh + claude-code CLI),
  `deploy/docker-compose.yml` (volume `./data`, env-file, restart:always,
  healthcheck). DoD: `docker compose up -d` на mh-central, healthcheck зелёный.
  Зависит: этапы 1–5.
- **6.2 Наблюдаемость.** Sentry-проект `midas` (self-hosted), DSN в KV, init в
  демоне; запись в fleet-реестр server-watchdog (PR). **Каждый `state:blocked` —
  Sentry-событие** (DeepSeek №1.6: комментарий в GitHub легко пропустить). DoD:
  тестовое событие в Sentry; blocked порождает событие; PR открыт. Зависит: 6.1.
- **6.3 E2E.** Тестовый issue docs-уровня в `bronxtc52/midas` со `state:ready` →
  полный цикл до `midas:accept`; критерии приёмки спеки §5 прогнать построчно.
  DoD: критерии 1–12 = да; PR цикла ждёт мержа владельцем. Зависит: 6.1, 6.2.
- **6.4 Runbook.** `docs/runbook.md`: запуск/стоп/логи/ротация ключа/выход из
  blocked/что делать при rate-limit. DoD: файл, сверенный с реальными командами.
  Зависит: 6.1.

## Маппинг открытых вопросов спеки

| Вопрос | Куда |
|---|---|
| №1 слаги/owner-логин | 0.1/0.2 — закрыт (API-key, deepseek-direct) |
| №2 оплата Worker'а | 3.x — закрыт ADR + отступление 2026-07-03 (API-key сразу) |
| №3 Конституция 2/2 | сверка при появлении оригинала |
| №4 спека 2/2 | сверка при появлении оригинала |

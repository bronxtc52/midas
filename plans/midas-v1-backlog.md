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
  `GH-TOKEN` (из `gh auth token` хоста при генерации, в KV не кладём); `.env`
  gitignored, права 600. DoD: скрипт идемпотентен, `.env.example` без значений.
  Зависит: 0.1.
- **0.3 GitHub-примитивы.** `src/gh.js`: `fetch` к api.github.com (Bearer из env),
  функции: issues по label, комментарий, смена labels, PR list/create, rate-limit
  (заголовки `x-ratelimit-*` → backoff). DoD: юнит-тесты на моках fetch, включая
  429/403-backoff. Зависит: 0.1.
- **0.4 State-лейблы в GitHub.** Скрипт `scripts/bootstrap-labels.sh`: `state:*`
  (ready/planning/coding/review/blocked/accepted/rejected) + `midas:accept|reject`.
  DoD: лейблы существуют в `bronxtc52/midas`. Зависит: —.
- **0.5 CI.** `.github/workflows/ci.yml`: `node --test` + gitleaks-скан. DoD: зелёный
  ран на PR. Зависит: 0.1.

## Этап 1 — Демон событий (Orchestrator + Keeper-журнал)

- **1.1 Курсор и журнал.** `src/keeper.js`: JSONL-журнал `data/journal.jsonl`
  (event, ts извне), курсор `data/cursor.json` (атомарная запись через tmp+rename).
  DoD: тесты — рестарт не теряет/не дублирует события. Зависит: 0.3.
- **1.2 Машина состояний.** `src/statemachine.js`: чистая функция
  `(issueState, event) → action`; таблица переходов из спеки §3; `state:blocked`
  терминален для автоматики. DoD: тест на каждый переход + на запрещённые. Зависит: —.
- **1.3 Цикл демона.** `src/daemon.js`: tick каждые `poll_interval_sec`; выборка
  issues/PR из allowlist-репо; диспетчеризация ролей; одна задача одновременно (v1,
  без параллелизма); graceful shutdown. DoD: интеграционный тест на моках gh:
  ready-issue за один tick уходит в planning. Зависит: 1.1, 1.2, 0.3.

## Этап 2 — Planner + Worker MVP

- **2.1 Обёртка Claude Code.** `src/claude.js`: spawn `claude -p --output-format json`
  с рабочим каталогом, промптом, таймаутом, `max-turns`; парс usage/cost из ответа.
  DoD: тест на моке бинаря (fake claude), таймаут убивает процесс. Зависит: 0.1.
- **2.2 Planner.** `src/roles/planner.js`: issue → план-комментарий (шаблон: файлы,
  шаги, DoD) → `state:coding`; при неполном ТЗ — blocked-протокол (формат вопроса
  из Конституции §3). DoD: тесты обоих исходов на моках. Зависит: 2.1, 1.2.
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

## Этап 4 — Reviewer

- **4.1 Рубрика.** Вендорим рубрику KB t2-2 в `docs/review-rubric.md` (ссылка на
  первоисточник). DoD: файл в репо. Зависит: —.
- **4.2 Reviewer.** `src/roles/reviewer.js`: PR со `state:review` → headless-ревью
  диффа по рубрике → структурированный вердикт-комментарий (verdict: pass/fail +
  находки) → передача Acceptor'у. Кода не правит. DoD: тест на моках. Зависит: 2.1, 4.1.

## Этап 5 — Acceptor + Council

- **5.1 Acceptor.** `src/roles/acceptor.js`: вердикт Reviewer'а + DoD issue →
  `midas:accept` (→`state:accepted`) или `midas:reject` (→`state:coding` + причины).
  DoD: тесты обоих исходов. Зависит: 4.2.
- **5.2 Council.** `src/council.js`: shell-out в `or-fusion` (слаг из конфига, кап
  из конфига) для развилок Planner'а; недоступен → деградация в решение Planner'а
  с пометкой в журнале. DoD: тест деградации (без сети). Зависит: 2.2.

## Этап 6 — Деплой, E2E, hardening

- **6.1 Docker.** `deploy/Dockerfile` (node:20-slim + git + gh + claude-code CLI),
  `deploy/docker-compose.yml` (volume `./data`, env-file, restart:always,
  healthcheck). DoD: `docker compose up -d` на mh-central, healthcheck зелёный.
  Зависит: этапы 1–5.
- **6.2 Наблюдаемость.** Sentry-проект `midas` (self-hosted), DSN в KV, init в
  демоне; запись в fleet-реестр server-watchdog (PR). DoD: тестовое событие в
  Sentry; PR открыт. Зависит: 6.1.
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

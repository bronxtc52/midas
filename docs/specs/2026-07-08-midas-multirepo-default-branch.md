# ТЗ — MIDAS мультирепо: определять дефолт-ветку репо (не хардкодить main)

**Дата:** 2026-07-08 · **Репозиторий:** `bronxtc52/midas` · **Статус:** ⏳ ожидает подтверждения владельцем
**Повод:** отдать фабрике баг `server-watchdog#50` (SidePanel под топбаром). server-watchdog живёт на
ветке **`master`**, а MIDAS хардкодит base `main` → PR фабрики упал бы. Нужно снять хардкод.

## 1. Цель

Сделать MIDAS **мультирепо-безопасным по дефолт-ветке**: фабрика определяет дефолт-ветку целевого
репо через GitHub API и использует её как базу PR и точку отсчёта диффа, вместо литерала `main`.
После этого добавить `server-watchdog` в allowlist и завести #50 в работу.

## 2. Решения владельца (приняты)

1. **Отдать баг #50 фабрике MIDAS** (расширить её на второй репо), а не чинить прямым фиксом.
2. Механизм — минимальная правка движка: **определение default_branch**, без per-repo конфиг-карт.

## 3. Контракт (по коду `~/projects/Midas`, 2026-07-08)

- **`worker.js` — два хардкода base**: строка **82** `baseRef = existing ? 'origin/${branch}' : 'origin/main'`
  (ahead-count свежей ветки) и строка **101** `base: 'main'` (в `gh.createPR`).
- `git clone` (worker.js:49) чекаутит **реальную дефолт-ветку** репо; `git checkout -b midas/issue-N`
  (worker.js:56) создаёт ветку от неё → сама ветка уже корректна, чинить надо только эти 2 ссылки.
- **`gh.js`** — тонкий REST-клиент (`request(path)` → JSON); методов чтения репо нет. Добавить
  `getDefaultBranch(repo)` → `GET /repos/{repo}` → `.default_branch`.
- **`config.json`** `repos_allowlist` = `["bronxtc52/midas"]`. Демон поллит только его.
- **`scripts/bootstrap-labels.sh`** хардкодит `REPO="bronxtc52/midas"` → в server-watchdog лейблы
  `midas:state:*`/`gate:*`/вердикты не создаст (без них `transitionState`/поллинг не найдут состояний).
- Токен демона — host `gh auth token` (broad) через GIT_ASKPASS → push+PR в server-watchdog доступны.
- Прочие роли (planner/reviewer/acceptor) и `daemon.js` base-ветку не трогают. Мерж PR — по-прежнему
  только владелец (не менять). CI server-watchdog нет → `handleReview` даёт grace→green (ожидаемо).

## 4. User stories

1. Как фабрика, для issue в репо с дефолт-веткой `master` открываю PR с `base:'master'` (а не `main`)
   и считаю дифф от `origin/master`.
2. Как владелец, добавив репо в allowlist + bootstrap лейблов + `midas:state:ready` на issue, получаю
   фабричный цикл в этом репо (план→код→PR→ревью→accept), мерж — за мной.
3. Регресс: для `bronxtc52/midas` (дефолт `main`) всё работает как раньше.

## 5. Ограничения — что НЕ делаем

- **Не меняем**: merge-политику (мерж только владелец), лейбл-семантику, капы, contract ролей,
  Telegram-notify (тип B), review/CI-логику.
- **Не вводим per-repo конфиг-карту** — только определение default_branch по API (+кэш).
- **Не трогаем** head-ветку `midas/issue-N` и reject-круг (`existing → origin/${branch}` остаётся).
- Кэш default_branch — процессный, простой (репо редко меняет дефолт-ветку); инвалидация не нужна.

## 6. Дизайн

- **`gh.js`**: `getDefaultBranch(repo)` — `GET /repos/{repo}` → `.default_branch`; **кэш `Map`** по repo
  (второй вызов — без сетевого запроса). Ошибка API → пробросить (worker обернёт в blocked, как прочие).
- **`worker.js`**: в начале (после клона или до createPR) `const defaultBranch = await gh.getDefaultBranch(repo)`;
  строка 82 → `existing ? 'origin/${branch}' : 'origin/${defaultBranch}'`; строка 101 → `base: defaultBranch`.
- **`config.json`**: `repos_allowlist` += `"bronxtc52/server-watchdog"`.
- **`scripts/bootstrap-labels.sh`**: `REPO="${1:-bronxtc52/midas}"` (арг опционален, дефолт прежний;
  идемпотентно `--force`). Запуск `bootstrap-labels.sh bronxtc52/server-watchdog` заведёт лейблы там.
- **Тест-харнес** (`tests/roles.test.js`): `ghStub` получает `getDefaultBranch: async () => 'main'`
  (дефолт — не ломает существующие main-тесты); worker-тесты используют реальный bare-git.

## 7. Критерии приёмки (да/нет)

1. `gh.getDefaultBranch(repo)` возвращает `.default_branch` из `GET /repos/{repo}` (мок request);
   второй вызов того же repo **не** делает повторный request (кэш).
2. worker: при `getDefaultBranch→'master'` вызывает `gh.createPR` с `base:'master'` (мок gh + bare-git `-b master`).
3. worker-регресс: при `getDefaultBranch→'main'` (bare `-b main`) `createPR` base = `'main'` — существующий
   happy-path тест зелёный.
4. worker: свежая ветка в репо `master` пушится и PR создаётся **без** обращения к `origin/main`
   (ahead-count от `origin/master`; интеграционно на bare `-b master` — не падает `unknown revision`).
5. reject-круг (существующая ветка) по-прежнему считает дифф от `origin/${branch}` (не от дефолт-ветки).
6. `config.json` `repos_allowlist` содержит и `bronxtc52/midas`, и `bronxtc52/server-watchdog`.
7. `bootstrap-labels.sh bronxtc52/server-watchdog` (dry-check: скрипт использует переданный REPO, не хардкод).
8. `npm test` зелёный, включая новый worker-master-тест; существующие worker/daemon/planner тесты не сломаны.
9. Мерж-запрет цел: `no-merge.test.js` зелёный, merge-вызовов в коде нет.

## 8. Human-блокеры / деплой (Гейт 0, с «ок»)

- **Мерж PR в `bronxtc52/midas` main** — красная зона (владелец).
- **Деплой демона**: `git pull` + `docker compose up -d --build` (config баково в образ).
- **Bootstrap лейблов в server-watchdog**: `scripts/bootstrap-labels.sh bronxtc52/server-watchdog`
  (host gh token — broad, права есть).
- **Завести #50**: навесить `midas:state:ready` на `server-watchdog#50` → демон подхватит ≤45с
  (и пришлёт Telegram-отчёт — обкатка нового канала).
- Токен фабрики (host `gh auth token`) уже даёт push+PR в server-watchdog — новый секрет не нужен.

## 9. Definition of Done

- **PR в `bronxtc52/midas`** (ветка `feat/multirepo-default-branch`): gh.getDefaultBranch + worker +
  config + bootstrap + тесты. Зелёный `npm test`. Ссылка.
- Reviewer-субагент (bug-риск: неверная base-ветка → битый PR) — обязателен.
- После мерджа+деплоя: bootstrap лейблов в server-watchdog + `midas:state:ready` на #50 + подтвердить
  живой подхват (журнал/Telegram). Финальный фикс #50 сделает уже сама фабрика (её PR — на ревью владельцу).

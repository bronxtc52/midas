# Спека MIDAS v1 — реконструкция r1

**Статус:** реконструирована Fable 2026-07-03 по ADR и спринт-задачам; оригинал
`2026-07-03-midas-v1-design.md` недоступен (MacBook Air оффлайн, materials/ спринта
не выгружены). При появлении оригинала — обязательная сверка; расхождения правятся
явным решением владельца, не молчаливым дрейфом.
**Утверждение владельцем:** ⏳ ожидает.

Источники: `knowledge-base/adr/midas-events-polling-v1.md`,
`knowledge-base/adr/midas-worker-payment-oauth-vs-api-key.md`,
спринт-задачи t2-3 / t3-4 / t1-2, eval `e-plan-midas-polling-daemon`.

## 1. Что такое MIDAS

Автономная фабрика разработки на VPS владельца. Цикл «issue → план → код → ревью →
приёмка» исполняют LLM-роли через headless Claude Code-сессии; координация и state —
целиком в GitHub (Issues + Projects-доска, labels, PR); о событиях демон узнаёт
polling'ом (ADR: вариант A, 30–60 с, курсор «последнее виденное»). Человек-владелец:
ставит задачи, отвечает на blocked-вопросы, единолично мержит PR.

## 2. Роли (Конституция §8.1 — детализация в docs/constitution.md)

| Роль | Вход | Выход | Ключевые запреты |
|---|---|---|---|
| **Orchestrator** (демон) | события GitHub (issues/PR/checks) | пробуждение ролей, переводы state-лейблов, журнал | не «думает»: только маршрутизация по машине состояний |
| **Planner** | issue со `state:ready` | план-комментарий в issue (файлы, шаги, DoD) | не пишет код; при неполном ТЗ — обязан `state:blocked` |
| **Worker** | issue с планом | ветка + коммиты + PR, `state:review` | не мержит; не меняет план и тесты; работает только в allowlist-репо |
| **Reviewer** | PR | структурированный вердикт-комментарий по рубрике (KB t2-2) | не правит код |
| **Acceptor** | PR + DoD issue | label `midas:accept` / `midas:reject` (+причины) | не расширяет скоуп; критерии только проверяемые |
| **Council** | развилка от Planner'а | синтез мнений внешних моделей (or-fusion → deepseek-direct) | v1: опционален; без PII/секретов наружу |
| **Keeper** | все события цикла | JSONL-журнал, учёт токенов/стоимости per task, курсор | часть демона в v1; данные не удаляет |

**Blocked-протокол:** роль, которой не хватает данных, ставит `state:blocked` +
комментарий строго формата «вопрос / что уже известно / варианты». Выход из blocked
в v1 — только ручной: владелец отвечает комментарием и возвращает state-лейбл.

## 3. Архитектура v1

- **Хост:** mh-central (решение владельца 2026-07-03) — $0, за NSG, WireGuard-меш,
  под watchdog. Docker Compose `~/projects/Midas/deploy/`; публичных endpoint'ов НЕТ.
- **События:** polling GitHub API каждые 45 с (конфиг), курсор в `./data/cursor.json`
  (volume) — рестарт/downtime не теряет события, демон дочитывает пропущенное.
- **State machine (labels):** `state:ready → state:planning → state:coding →
  state:review → state:accepted|state:rejected`; `state:blocked` — из любого состояния;
  `state:rejected` возвращает в `state:coding` с замечаниями Acceptor'а.
- **Worker-исполнение:** `claude -p` (headless) с `ANTHROPIC_API_KEY` из KV
  `midas--production--ANTHROPIC-API-KEY`. ⚠️ Отступление от ADR оплаты: владелец
  2026-07-03 выдал API-key сразу (вариант B) — триггер перехода исполнен досрочно,
  OAuth-фаза пропущена; ADR дополнить строкой при финализации.
- **Git-доступ:** существующая auth `gh` на mh-central; Worker ограничен allowlist
  в `config.yaml` (v1: только `bronxtc52/midas`). Права на merge у ролей отсутствуют
  в коде; мерж — красная зона человека.
- **Council/Fusion:** `openrouter--production--API-KEY` / `deepseek--production--API-KEY`
  через `or-fusion` (слаг v1: `deepseek-direct/deepseek-v4-pro`); Worker'у эти ключи
  не выдаются (ADR п.4).
- **Наблюдаемость (обязательный минимум):** Sentry-проект `midas` (DSN в KV),
  JSONL-журнал Keeper'а, регистрация в fleet-реестре server-watchdog.
- **Вывод LLM-текста:** GitHub рендерит markdown нативно — санитайзер каналов
  Telegram/HTML на этот контур не распространяется; при появлении иных каналов
  вывода — правило санитайзера обязательно.

## 4. Этапы 0–6 (скелет; детализация — plans/midas-v1-backlog.md)

| Этап | Содержание | Открытые вопросы спеки |
|---|---|---|
| **0. Фундамент** | структура репо, `config.yaml` (allowlist, слаги, интервалы, капы), fetch-env из KV, state-лейблы в GitHub, CI (lint+тесты), Sentry init | №1 закрыт: доступ = API-key владельца; Council-слаг = deepseek-direct |
| **1. Демон событий** | polling + курсор + журнал + машина состояний, устойчивость к рестарту/rate-limit | — |
| **2. Worker MVP** | issue → ветка → headless-сессия → PR → `state:review`; blocked-протокол | — |
| **3. Экономика** | Keeper: токены/стоимость per task, жёсткий кап на задачу (превышение → `state:blocked` + отчёт), дневной кап | №2 закрыт ADR + отступлением на API-key |
| **4. Reviewer** | ревью PR по рубрике t2-2, вердикт-комментарий | — |
| **5. Acceptor + Council** | приёмка ACCEPT/REJECT по DoD issue; Council для развилок | — |
| **6. E2E + hardening** | деплой на mh-central, полный прогон тестовой задачи, runbook, Конституция финал | №3/№4 (часть 2/2) — сверка при появлении оригинала |

## 5. Критерии приёмки v1 (каждый — да/нет)

1. `docker compose up -d` на mh-central: демон работает, healthcheck зелёный.
2. Issue со `state:ready` подхватывается ≤60 с: журнальная запись + перевод лейбла.
3. Worker создаёт ветку и PR, связанный с issue, и ставит `state:review`.
4. Задача с намеренно неполным ТЗ получает `state:blocked` + комментарий-вопрос
   заданного формата; демон её не трогает до ручного возврата лейбла.
5. Reviewer оставляет на PR структурированный вердикт по рубрике.
6. Acceptor ставит `midas:accept`/`midas:reject`; reject возвращает `state:coding`.
7. Kill демона → создать issue → поднять демон → issue подхвачен (курсор работает).
8. Секретов нет ни в репо, ни в образе (gitleaks чисто); всё из KV в рантайме.
9. В коде ролей отсутствует вызов merge; мерж PR выполняет только человек.
10. Задача, превысившая кап стоимости, останавливается со `state:blocked` и отчётом $.
11. Sentry принимает тестовое событие проекта `midas`; сервис виден в watchdog-fleet.
12. `plans/midas-v1-backlog.md` + `docs/constitution.md` v1.1 в репо; issues этапов
    на доске «MIDAS v1».

## 6. Не делаем в v1 (границы)

Webhooks (ADR: только по триггерам); Agent SDK; обслуживание чужих запросов /
коммерциализация; авто-мерж в main; авто-remediation; второй потребитель событий
(шина); OpenRouter как бэкенд Worker'а; мульти-VPS.

## 7. Риски

- Самореференция (MIDAS правит собственный работающий код) — v1: E2E-задачи только
  docs-уровня в собственном репо либо отдельный полигон-репо позже.
- Расход API-key без капов — закрывается этапом 3 до массового использования.
- GitHub rate-limit — интервалы и backoff в конфиге; триггеры ADR отслеживает Keeper.

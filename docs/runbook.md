# Runbook MIDAS (mh-central)

## Запуск / стоп / статус
```bash
cd ~/projects/Midas
bash deploy/fetch-env.sh              # .env из kv-bronxtc-dev (600)
cd deploy && docker compose up -d --build
docker compose ps                     # midas-midas-1, healthy
docker logs midas-midas-1 --tail 50
docker compose down                   # стоп
```

## Наблюдение
- Журнал Keeper'а: `~/projects/Midas/data/journal.jsonl` (append-only; события
  action/blocked/cost/race-skip/ci-gate-red/tick-error).
- Heartbeat: `data/heartbeat` (обновляется каждые 30 с независимо от tick'а;
  healthcheck краснеет при отставании >180 с = процесс мёртв).
- Sentry (когда подключён): события `MIDAS blocked|tick-error|daily-cap`.
- Watchdog: сервис `midas` в fleet-реестре server-watchdog (docker-чек).

## Выход задачи из blocked (только человек, Конституция §3)
1. Прочитать `## ⛔ BLOCKED`-комментарий в issue, ответить комментарием.
2. Вернуть state-лейбл: `gh issue edit <n> -R <repo> --remove-label state:blocked --add-label state:ready` (или `state:coding`, если план уже есть).

## Капы стоимости
- Пер-задача: `cost_cap_usd_per_task` (config.json); превышение → `state:blocked` с $-отчётом.
- Дневной: `cost_cap_usd_per_day`; превышение → демон пропускает tick'и до
  следующего дня UTC + Sentry-warning. Расход: `jq 'select(.type=="cost")' data/journal.jsonl`.
- `cost-unknown` в журнале = сессия убита таймаутом, usage не получен — реальный
  расход смотреть в Anthropic Console (ключ `midas--production--ANTHROPIC-API-KEY`).

## Ротация ключей
```bash
az keyvault secret set --vault-name kv-bronxtc-dev --name midas--production--ANTHROPIC-API-KEY --value <new>
# fine-grained PAT (предпочтительно вместо host-токена gh):
az keyvault secret set --vault-name kv-bronxtc-dev --name midas--production--GH-TOKEN --value <pat>
bash deploy/fetch-env.sh && cd deploy && docker compose up -d   # перечитать .env
```

## Rate-limit GitHub
Демон сам ждёт `x-ratelimit-reset` (кап 60 с) и ретраит один раз; постоянные
403 в `tick-error` журнала = проверить лимиты токена (`gh api rate_limit`).

## Известные ограничения v1 (осознанные)
- Council не подключён к Planner'у (развилки уходят в blocked к владельцу) —
  этап «wire Council» отложен, конфиг-ключи `council_*` зарезервированы.
- DoD-проверку выполняет Reviewer (явный пункт промпта), Acceptor решает по
  вердикту — упрощение против Конституции §5, снять при следующей итерации.
- `state:rejected` в конфиге зарезервирован, фактический reject-путь — сразу
  `review→coding`.
- Мерж PR всегда за человеком; авто-мержа нет и не планируется (Конституция §1.2).

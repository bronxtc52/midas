// Снимок ЖИВОСТИ сервиса в момент после мерджа — НЕ верификация деплоя.
// MIDAS не мержит и не деплоит (Конституция §1.2): сигнала «деплой прошёл» нет,
// поэтому мы лишь фиксируем «отвечает / нет» сейчас, не выдавая это за деплой.
//
// Ошибка сети/таймаут НЕ пробрасывается — health не должен ронять вызывающий tick.
export async function healthSnapshot(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  // Нет URL в config.json health_urls[repo] → health для этого репо не проверяем.
  if (!url) return 'не настроен';

  // AbortController + таймаут: висящий GET не должен подвесить tick (риск плана).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (res && res.status === 200) return 'up (HTTP 200)';
    return `down (HTTP ${res ? res.status : '?'})`;
  } catch {
    // Таймаут (abort) или сетевая ошибка — сервис недоступен, но tick жив.
    return 'down (недоступен)';
  } finally {
    clearTimeout(timer);
  }
}

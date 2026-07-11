// Blocked-протокол: единственный канонический формат — Конституция §3.
export function formatBlocked({ question, known, options = [], recommendation }) {
  const opts = options.join(' ') + (recommendation ? ` (рекомендация: ${recommendation})` : '');
  return `## ⛔ BLOCKED\nВопрос: ${question}\nИзвестно: ${known}\nВарианты: ${opts}`;
}

// Роль-сессия сигналит невозможность продолжать строкой
// `BLOCKED: {"question":...,"known":...,"options":[...],"recommendation":...}`
export function parseBlockedFromSession(text) {
  const m = (text || '').match(/^BLOCKED:\s*(\{.*\})\s*$/m);
  if (!m) return null;
  try {
    const b = JSON.parse(m[1]);
    return b.question ? b : null;
  } catch {
    return null;
  }
}

// Planner отдельно сигналит АРХИТЕКТУРНУЮ развилку (2–3 взаимоисключающих ветки)
// строкой `FORK: {"question":...,"known":...,"options":[...],"recommendation":...}`.
// Развилку имеет право решить Council (Конституция §2), тогда как BLOCKED —
// нехватка данных/доступа — всегда уходит человеку. Требуем question и ≥2
// варианта (иначе это не развилка) — иначе null.
export function parseForkFromSession(text) {
  const m = (text || '').match(/^FORK:\s*(\{.*\})\s*$/m);
  if (!m) return null;
  try {
    const f = JSON.parse(m[1]);
    return f.question && Array.isArray(f.options) && f.options.length >= 2 ? f : null;
  } catch {
    return null;
  }
}

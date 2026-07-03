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

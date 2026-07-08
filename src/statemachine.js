// Префикс состояний-лейблов. Именно `midas:state:` (не голый `state:`): все лейблы
// MIDAS под неймспейсом `midas:` — так их видно среди чужих. Под-префикс `state:`
// отличает лейблы-состояния (двигают конвейер) от лейблов-вердиктов `midas:accept`/
// `midas:reject` (выходы Acceptor'а, не состояния) — они под `midas:`, но НЕ `midas:state:`.
export const STATE_PREFIX = 'midas:state:';

// Таблица переходов спеки §3. label-first: демон переводит лейбл в `to`
// ДО запуска роли (когда from !== to); роль по завершении двигает дальше сама.
const TABLE = {
  'midas:state:ready': { action: 'plan', to: 'midas:state:planning' },
  // planning = резюме после падения демона между лейблом и ролью
  'midas:state:planning': { action: 'plan', to: 'midas:state:planning' },
  'midas:state:coding': { action: 'work', to: 'midas:state:coding' },
  'midas:state:review': { action: 'review', to: 'midas:state:review' },
};

export function decide(state) {
  const t = TABLE[state];
  return t ? { action: t.action, from: state, to: t.to } : null;
}

// Единственный state-лейбл issue; 0 или ≥2 — противоречие, не угадываем.
export function stateOf(labels) {
  const states = (labels || []).map((l) => l.name).filter((n) => n.startsWith(STATE_PREFIX));
  return states.length === 1 ? states[0] : null;
}

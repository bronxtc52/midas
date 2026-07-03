export const STATE_PREFIX = 'state:';

// Таблица переходов спеки §3. label-first: демон переводит лейбл в `to`
// ДО запуска роли (когда from !== to); роль по завершении двигает дальше сама.
const TABLE = {
  'state:ready': { action: 'plan', to: 'state:planning' },
  // planning = резюме после падения демона между лейблом и ролью
  'state:planning': { action: 'plan', to: 'state:planning' },
  'state:coding': { action: 'work', to: 'state:coding' },
  'state:review': { action: 'review', to: 'state:review' },
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

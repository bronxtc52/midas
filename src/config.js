import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NUM_OVERRIDES = {
  MIDAS_POLL_INTERVAL_SEC: 'poll_interval_sec',
  MIDAS_COST_CAP_USD_PER_TASK: 'cost_cap_usd_per_task',
  MIDAS_COST_CAP_USD_PER_DAY: 'cost_cap_usd_per_day',
  MIDAS_SESSION_MAX_TURNS: 'session_max_turns',
  MIDAS_SESSION_TIMEOUT_SEC: 'session_timeout_sec',
};

export function loadConfig(root = process.cwd(), env = process.env) {
  const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  for (const [envKey, cfgKey] of Object.entries(NUM_OVERRIDES)) {
    if (env[envKey] === undefined) continue;
    const n = Number(env[envKey]);
    // NaN в капах молча отключил бы все сравнения лимитов
    if (!Number.isFinite(n)) throw new Error(`${envKey}=${env[envKey]} — не число`);
    cfg[cfgKey] = n;
  }
  return cfg;
}

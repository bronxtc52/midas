import { stateOf } from './statemachine.js';

// GitHub API-клиент на глобальном fetch. Никаких операций слияния PR —
// приём в main выполняет только человек (Конституция §1.2, критерий №9).
export function makeGh({
  token,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  apiBase = 'https://api.github.com',
  maxWaitMs = 60_000,
}) {
  async function request(path, { method = 'GET', body, raw = false, accept = 'application/vnd.github+json' } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(apiBase + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept,
          'content-type': 'application/json',
          'user-agent': 'midas-daemon',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const remaining = res.headers.get('x-ratelimit-remaining');
      if ((res.status === 403 || res.status === 429) && remaining === '0' && attempt === 0) {
        const resetMs = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        await sleep(Math.max(0, Math.min(resetMs - Date.now() + 1000, maxWaitMs)));
        continue;
      }
      if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}`);
      return raw ? res.text() : res.json();
    }
    throw new Error(`GitHub ${method} ${path}: rate-limit не отпустил после ожидания`);
  }

  const q = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined));
    return s.toString() ? `?${s}` : '';
  };

  // Дефолт-ветка репо кэшируется процессно: разные репо флота на master vs main,
  // а сама дефолт-ветка меняется крайне редко → одного запроса на репо достаточно.
  const defaultBranchCache = new Map();

  // Пагинация: одна страница на шумном репо после downtime молча теряет события
  async function paged(path, params, maxPages = 10) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await request(`${path}${q({ ...params, per_page: '100', page: String(page) })}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  return {
    request,

    listIssues: (repo, { label, since } = {}) =>
      paged(`/repos/${repo}/issues`, { labels: label, since, state: 'open' }),

    async listUpdatedIssues(repo, since) {
      const items = await paged(`/repos/${repo}/issues`, { since: since ?? undefined, state: 'open' });
      return items.filter((i) => !i.pull_request);
    },

    removeLabel: (repo, n, label) =>
      request(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' })
        .catch(() => {}), // 404 = лейбла и не было

    getIssue: (repo, n) => request(`/repos/${repo}/issues/${n}`),

    // База PR и точка отсчёта диффа — не хардкодим main: определяем дефолт-ветку
    // целевого репо (server-watchdog на master, midas на main). Кэш — см. выше.
    async getDefaultBranch(repo) {
      if (defaultBranchCache.has(repo)) return defaultBranchCache.get(repo);
      const data = await request(`/repos/${repo}`);
      // Пустой default_branch НЕ кэшируем: иначе `origin/undefined` в rev-list →
      // git-фейл → вечный tick-error-ретрай. Бросаем — ретрай на следующем тике.
      if (!data.default_branch) throw new Error(`GitHub /repos/${repo}: пустой default_branch`);
      defaultBranchCache.set(repo, data.default_branch);
      return data.default_branch;
    },

    listComments: (repo, n) => request(`/repos/${repo}/issues/${n}/comments${q({ per_page: '100' })}`),

    addComment: (repo, n, body) => request(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: { body } }),

    addLabels: (repo, n, labels) => request(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels } }),

    // Optimistic-переход: свежее чтение → ожидаемый state не совпал → skipped
    // (гонка с человеком/другим процессом). Хирургически: DELETE from + POST to,
    // НЕ PUT всего списка — иначе стирается чужой лейбл, добавленный в окно гонки.
    async transitionState(repo, n, from, to) {
      const issue = await request(`/repos/${repo}/issues/${n}`);
      const current = stateOf(issue.labels);
      if (current !== from) return { skipped: true, current };
      await request(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(from)}`, { method: 'DELETE' }).catch(() => {});
      await request(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels: [to] } });
      return { ok: true };
    },

    createPR: (repo, { title, head, base, body }) =>
      request(`/repos/${repo}/pulls`, { method: 'POST', body: { title, head, base, body } }),

    async getPRForBranch(repo, branch) {
      const owner = repo.split('/')[0];
      const prs = await request(`/repos/${repo}/pulls${q({ head: `${owner}:${branch}`, state: 'open' })}`);
      return prs[0] ?? null;
    },

    // Мерж владельцем закрывает issue (Closes #N) → задача выпадает из open-поллинга.
    // Смотрим PR по head-ветке в state:all (включая закрытые). merged определяем по
    // `merged_at` — закрытие PR БЕЗ мерджа его не выставляет (не даём ложный merged).
    async isPRMerged(repo, branch) {
      const owner = repo.split('/')[0];
      const prs = await request(`/repos/${repo}/pulls${q({ head: `${owner}:${branch}`, state: 'all' })}`);
      const pr = prs.find((p) => p.merged_at) ?? prs[0] ?? null;
      return { merged: Boolean(pr && pr.merged_at), number: pr ? pr.number : null };
    },

    getPRDiff: (repo, n) => request(`/repos/${repo}/pulls/${n}`, { raw: true, accept: 'application/vnd.github.v3.diff' }),

    // green | red | pending | none. «none» решает демон: свежий PR — ждать
    // (Actions регистрирует чеки с лагом), старый — репо без CI, пропускаем.
    async checksStatus(repo, ref) {
      const data = await request(`/repos/${repo}/commits/${ref}/check-runs${q({ per_page: '100' })}`);
      const runs = data.check_runs ?? [];
      if (runs.length === 0) return 'none';
      const bad = runs.some((r) => r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion));
      if (bad) return 'red';
      if (runs.some((r) => r.status !== 'completed')) return 'pending';
      return 'green';
    },

    // Упавшие чеки коммита (issue #30): rework после ci-gate-red передаёт Worker'у,
    // ЧТО красное. Тот же check-runs-запрос, что и checksStatus, но фильтр — только
    // завершённые с плохим conclusion (не success/neutral/skipped). summary — из
    // output.summary/output.title. id — для best-effort лога (см. failedCheckLog).
    async failedChecks(repo, ref) {
      const data = await request(`/repos/${repo}/commits/${ref}/check-runs${q({ per_page: '100' })}`);
      const runs = data.check_runs ?? [];
      return runs
        .filter((r) => r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion))
        .map((r) => ({ name: r.name, summary: (r.output && (r.output.summary || r.output.title)) || '', id: r.id }));
    },

    // Best-effort хвост лога упавшего job'а (issue #30). Actions job logs — raw-текст.
    // При ЛЮБОЙ ошибке возвращаем '' (деградация, не блокер): id check-run'а может не
    // совпасть с id Actions-job'а, лог может быть zip/redirect, репо — без Actions.
    // Rework в этом случае идёт с именами чеков, но без лога.
    async failedCheckLog(repo, id) {
      try {
        return await request(`/repos/${repo}/actions/jobs/${id}/logs`, { raw: true });
      } catch {
        return '';
      }
    },
  };
}

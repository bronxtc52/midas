// Telegram owner-notify: исходящие краткие отчёты о ходе конвейера MIDAS в личный
// чат владельца (бот server-watchdog). ТОЛЬКО notify-only (тип B): исключительно
// sendMessage наружу. Приём обновлений, вебхуки, кнопки и команды из чата
// запрещены (статический тест tests/telegram-notify.test.js стережёт границу).
// Правило: ~/.claude/rules/telegram-owner-notify.md.
//
// Plain text без parse_mode → HTML-escape не нужен, сырой URL Telegram авто-линкует
// (обходим parse-грабли, KB lessons/telegram-llm-markdown-html.md).

// Извлечь номер issue из task-строки вида "owner/repo#5".
function issueNoOf(task) {
  const m = /#(\d+)\s*$/.exec(String(task || ''));
  return m ? m[1] : '?';
}

// owner/repo из task-строки "owner/repo#5" (fallback — настроенный дефолт).
function repoOf(task, fallback) {
  const m = /^(.+)#\d+\s*$/.exec(String(task || ''));
  return m ? m[1] : fallback;
}

// Ссылка на issue в GitHub (owner кликает — видит заголовок/тред).
function issueUrl(repo, n) {
  return `https://github.com/${repo}/issues/${n}`;
}

// Ссылка на PR (accepted/work-done ведут сюда — PR мержат, не issue).
function prUrl(repo, n) {
  return `https://github.com/${repo}/pull/${n}`;
}

// Чистая функция: журнал-событие → текст сообщения или null (событие не репортим).
// Whitelist значимых типов; всё остальное (processed/cost/race-skip/daemon-start/…) — null.
export function eventToMessage(event, { monUrl = 'https://mon.adarasoft.com', repo = 'bronxtc52/midas' } = {}) {
  if (!event || typeof event.type !== 'string') return null;

  switch (event.type) {
    case 'work-done': {
      const n = issueNoOf(event.task);
      const r = repoOf(event.task, repo);
      // Сообщение про PR → и ссылка на PR (если известен), иначе на issue.
      const link = event.pr ? prUrl(r, event.pr) : issueUrl(r, n);
      const pr = event.pr ? ` (PR #${event.pr})` : '';
      return `🔨 #${n}: код готов${pr} → ревью\n${link}`;
    }

    case 'awaiting-approval': {
      const n = event.issue ?? '?';
      const title = event.title ? ` «${event.title}»` : '';
      const goal = event.goal ? `\nЦель: ${event.goal}` : '';
      return `⏸ #${n}${title} ждёт одобрения плана.${goal}\nОдобрить в mon (вкладка «Агенты»): ${monUrl}`;
    }

    case 'blocked': {
      const n = issueNoOf(event.task);
      const q = event.question ? `: ${event.question}` : '';
      return `🚧 #${n} заблокировано${q}\n${issueUrl(repoOf(event.task, repo), n)}`;
    }

    case 'ci-gate-red':
      return `⛔ #${event.issue} CI красный → возврат в кодинг\n${issueUrl(event.repo || repo, event.issue)}`;

    case 'daily-cap-pause':
      return `💰 Дневной кап MIDAS исчерпан — пауза до завтра (${event.day})`;

    case 'tick-error':
      return `❗ MIDAS tick-error: ${event.error}`;

    case 'action': {
      // Переходы конвейера. awaiting-approval — через спец-событие (дубля не даём);
      // review-исход (work-done) уже сообщён отдельным событием.
      const n = event.issue ?? '?';
      const r = event.repo || repo;
      const url = issueUrl(r, n);
      switch (event.result) {
        case 'planned': return `📋 #${n}: план готов → кодинг\n${url}`;
        case 'accepted':
          // «ждёт мерджа» → ведём на PR (его и мержат) + готовая инструкция. Мерж — только владелец.
          return event.pr
            ? `✅ #${n} принято — ждёт твоего мерджа (мержишь только ты).\nPR: ${prUrl(r, event.pr)}\nСмержить: открой PR → «Merge pull request», либо в терминале:\ngh pr merge ${event.pr} --repo ${r} --squash --delete-branch`
            : `✅ #${n} принято — ждёт твоего мерджа (мержишь только ты).\n${url}`;
        case 'rejected': return `♻️ #${n} отклонено ревью → возврат в кодинг\n${url}`;
        default: return null; // awaiting-approval, review, blocked и пр. — не здесь
      }
    }

    default:
      return null;
  }
}

// Нотификатор: подписчик журнала. onEvent(event) шлёт sendMessage, если событие
// значимо и канал сконфигурирован. No-op без token/chatId. Ошибки доставки
// проглатываются (отчёт не должен ронять tick). Токен — только в URL пути к Bot API,
// в лог/сообщения не попадает.
export function makeTelegramNotifier({ token, chatId, monUrl, repo, fetch = globalThis.fetch, log = () => {} }) {
  const enabled = Boolean(token && chatId);
  // Токен сидит в пути URL Bot API — гарантируем, что он не утечёт ни в один log.
  const scrub = (s) => (token ? String(s).split(token).join('***') : String(s));

  async function onEvent(event) {
    if (!enabled) return;
    // Весь блок под try: onEvent — async и вызывается fire-and-forget, поэтому любой
    // бросок (в т.ч. будущий из eventToMessage) должен гаситься ЗДЕСЬ, а не всплывать
    // unhandledRejection (try/catch подписчика в keeper ловит только синхронные throw).
    try {
      const text = eventToMessage(event, { monUrl, repo });
      if (!text) return;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      if (res && res.ok === false) {
        // Тело может содержать эхо запроса — не логируем, только код.
        log(`telegram sendMessage → HTTP ${res.status ?? '?'}`);
      }
    } catch (e) {
      // Никогда не пробрасываем: сбой Telegram не должен ломать демон.
      log(`telegram notify error: ${scrub(e.message)}`);
    }
  }

  return { onEvent };
}

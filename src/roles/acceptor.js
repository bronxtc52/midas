// Acceptor: только accept/reject, «принять с замечаниями» не существует
// (Конституция §2). Причины reject — только ссылки на fail-находки.
export async function runAcceptor({ gh, config, repo, issue, verdict }) {
  if (verdict.verdict === 'pass') {
    await gh.addLabels(repo, issue.number, [config.labels.accept]);
    await gh.transitionState(repo, issue.number, config.labels.review, config.labels.accepted);
    await gh.addComment(repo, issue.number,
      '## ✅ ACCEPT (Acceptor)\nDoD и вердикт Reviewer\'а пройдены. PR готов к приёму — сливает только человек.');
    return { status: 'accepted' };
  }
  const reasons = (verdict.findings || [])
    .filter((f) => f.severity !== 'nit')
    .map((f) => `- [${f.severity}] ${f.note}`)
    .join('\n');
  await gh.addComment(repo, issue.number, `## ❌ REJECT (Acceptor)\nПричины:\n${reasons || '- вердикт Reviewer: fail'}`);
  await gh.addLabels(repo, issue.number, [config.labels.reject]);
  await gh.transitionState(repo, issue.number, config.labels.review, config.labels.coding);
  return { status: 'rejected' };
}

const DAY = 86_400_000;
function dateTime(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value ? date.getTime() : NaN;
}

export function priorityScorer(issues) {
  const byId = new Map(issues.map(issue => [issue.id,issue]));
  const reference = Math.max(-Infinity,...issues.map(issue => dateTime(issue.date)).filter(Number.isFinite));
  return topic => {
    const source = topic.issueIds.map(id => byId.get(id));
    const likes = source.reduce((sum,issue) => sum + (issue.likes ?? 0),0);
    const comments = source.reduce((sum,issue) => sum + (issue.comments ?? 0),0);
    const observed = source.filter(issue => issue.likes != null && issue.comments != null).length;
    const recent = Math.max(-Infinity,...source.map(issue => dateTime(issue.date)).filter(Number.isFinite));
    const age = Number.isFinite(recent) ? (reference - recent) / DAY : null;
    const frequency = 50 * Math.min(source.length / 5,1);
    const engagement = 30 * Math.min(Math.log1p(likes + 0.5 * comments) / Math.log1p(20),1);
    const recency = age === null ? 0 : 20 * 2 ** (-age / 14);
    const score = Math.round((frequency + engagement + recency) * 10) / 10;
    return {score,level:score >= 70 ? 'P1' : score >= 40 ? 'P2' : 'P3',
      frequency,engagement,recency,likes,comments,observed,total:source.length,
      date:age === null ? '' : new Date(recent).toISOString().slice(0,10),
      reference:Number.isFinite(reference) ? new Date(reference).toISOString().slice(0,10) : ''};
  };
}

const actions = ['manual_merge','ai_candidate_merge','split','decline_ai_candidate'];

export function correction(action, left, right, modelMatches = []) {
  return {action,left:[...left],right:[...right],modelMatches:[...modelMatches],at:new Date().toISOString()};
}

export function validatedCorrections(input, issues) {
  if (!Array.isArray(input)) return [];
  const known = new Set(issues.map(issue => issue.id));
  const ids = list => {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter(id => known.has(id)))];
  };
  const output = [];
  for (const event of input) {
    if (!event || !actions.includes(event.action) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) continue;
    const left = ids(event.left);
    const right = ids(event.right).filter(id => !left.includes(id));
    if (!left.length || !right.length) continue;
    if ((event.action === 'split' || event.action === 'decline_ai_candidate') && left.length !== 1) continue;
    if (event.action === 'decline_ai_candidate' && right.length !== 1) continue;
    output.push({action:event.action,left,right,modelMatches:ids(event.modelMatches).filter(id => right.includes(id)),at:event.at});
  }
  return output;
}

export function aiMatchesForSplit(topic, issueId) {
  return [...new Set((topic.modelGroups ?? []).filter(group => group.includes(issueId))
    .flatMap(group => group.filter(id => id !== issueId)))];
}

export function correctionPairs(events) {
  const pairs = new Map();
  for (const {action,left,right,modelMatches,at} of events) {
    const label = action === 'split' || action === 'decline_ai_candidate' ? 'split' : 'merge';
    const priorModel = new Set(modelMatches);
    for (const first of left) {
      for (const second of right) {
        const [issue_a,issue_b] = first < second ? [first,second] : [second,first];
        const reason = action === 'decline_ai_candidate' || (action === 'split' && priorModel.has(second)) ? 'false_merge' : 'human_override';
        pairs.set(JSON.stringify([issue_a,issue_b]),{issue_a,issue_b,label,reason,action,reviewed_at:at});
      }
    }
  }
  return [...pairs.values()];
}

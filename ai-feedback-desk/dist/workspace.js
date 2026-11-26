export const PRIORITIES = ['P1', 'P2', 'P3'];
export const STAGES = ['pending', 'confirmed', 'deferred', 'resolved'];

export function stageOf(topic) {
  return STAGES.includes(topic.stage) ? topic.stage : topic.verified === true ? 'confirmed' : 'pending';
}

export function setStage(topic, stage) {
  if (!STAGES.includes(stage)) return false;
  topic.stage = stage;
  topic.verified = stage === 'confirmed';
  return true;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function field(value, max, name, required = true) {
  check(typeof value === 'string' && value.length <= max && (value.trim() || !required), `${name}格式不正确。`);
  return value.trim();
}

export const THEME_FIELDS = {title: 400, summary: 2000, action: 2000};

function normalizeLocalizations(localized) {
  const copy = {};
  for (const locale of ['zh', 'en']) {
    if (!localized?.[locale]) continue;
    const fields = localized[locale];
    const entries = Object.entries(THEME_FIELDS).filter(([name]) => Object.hasOwn(fields, name));
    copy[locale] = Object.fromEntries(entries.map(([name, max]) =>
      [name, field(fields[name], max, name, name === 'title')]));
  }
  return copy;
}

function count(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value) : value;
  check(Number.isSafeInteger(number) && number >= 0, '互动计数须为非负整数。');
  return number;
}

function normalizeModelGroups(groups, issueIds) {
  if (!Array.isArray(groups)) return [];
  const members = new Set(issueIds);
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const ids = [...new Set(group.filter(id => members.has(id)))].sort();
    const key = JSON.stringify(ids);
    if (ids.length < 2 || seen.has(key)) continue;
    seen.add(key);
    result.push(ids);
  }
  return result;
}

export function normalizeWorkspace(input) {
  check(input && Array.isArray(input.issues) && input.issues.length > 0 && input.issues.length <= 500, '反馈数须为 1–500 条。');
  check(Array.isArray(input.topics) && input.topics.length > 0 && input.topics.length <= input.issues.length, '主题列表格式不正确。');
  const issueIds = new Set();
  const topicIds = new Set();
  const assigned = new Set();
  const issues = input.issues.map(issue => {
    const id = field(issue.id, 40, '反馈编号');
    check(!issueIds.has(id), `反馈编号重复。`);
    issueIds.add(id);
    let url = '';
    if (issue.url) {
      const link = new URL(issue.url);
      check(link.protocol === 'https:' && !link.username && !link.password, '反馈链接须使用 HTTPS。');
      url = link.href;
    }
    const date = field(issue.date ?? '', 10, '日期', false);
    check(!date || /^\d{4}-\d{2}-\d{2}$/.test(date), '日期须使用 YYYY-MM-DD。');
    return {id, url, date, title: field(issue.title, 400, '反馈标题'), excerpt: field(issue.excerpt, 3000, '反馈原文'), area: field(issue.area ?? '待分类', 80, '功能模块'),
      likes: count(issue.likes), comments: count(issue.comments)};
  });
  const topics = input.topics.map(topic => {
    const id = field(topic.id, 70, '主题编号');
    check(!topicIds.has(id) && Array.isArray(topic.issueIds) && topic.issueIds.length > 0, '主题须有唯一编号和反馈来源。');
    topicIds.add(id);
    for (const sourceId of topic.issueIds) {
      check(issueIds.has(sourceId) && !assigned.has(sourceId), '每条反馈必须且只能归属一个主题。');
      assigned.add(sourceId);
    }
    check(PRIORITIES.includes(topic.priority), '优先级须为 P1、P2 或 P3。');
    const citations = (Array.isArray(topic.citations) ? topic.citations : []).map(citation => {
      const issue = issues.find(row => row.id === citation.issueId);
      const quote = field(citation.quote, 3000, '原文引句');
      check(issue && topic.issueIds.includes(issue.id) && (issue.excerpt.includes(quote) || issue.title.includes(quote)), '引用必须来自该主题下的反馈原文。');
      return {issueId: issue.id, quote};
    });
    const followUp = field(topic.followUp ?? '', 10, '跟进日期', false);
    check(!followUp || /^\d{4}-\d{2}-\d{2}$/.test(followUp), '跟进日期须使用 YYYY-MM-DD。');
    const stage = stageOf(topic);
    return {
      id, issueIds: topic.issueIds, priority: topic.priority, stage, verified: stage === 'confirmed',
      title: field(topic.title, 400, '主题标题'), summary: field(topic.summary ?? '', 2000, '主题概述', false),
      action: field(topic.action ?? '', 2000, '建议动作', false), area: field(topic.area ?? '待分类', 80, '功能模块'),
      citations, localized: normalizeLocalizations(topic.localized),
      modelGroups: normalizeModelGroups(topic.modelGroups, topic.issueIds),
      owner: field(topic.owner ?? '', 100, '负责人', false),
      followUp, notes: field(topic.notes ?? '', 3000, '审核备注', false),
    };
  });
  check(assigned.size === issues.length, '存在未归入主题的反馈。');
  return {issues, topics, source: field(input.source ?? '导入的反馈', 120, '数据来源')};
}

export function splitIssue(workspace, topicId, issueId, newId) {
  const topic = workspace.topics.find(row => row.id === topicId);
  const issue = workspace.issues.find(row => row.id === issueId);
  if (!topic || !issue || topic.issueIds.length < 2 || !topic.issueIds.includes(issueId)) return false;
  topic.issueIds = topic.issueIds.filter(id => id !== issueId);
  topic.citations = topic.citations.filter(row => row.issueId !== issueId);
  topic.modelGroups = normalizeModelGroups(topic.modelGroups,topic.issueIds);
  setStage(topic, 'pending');
  workspace.topics.push({
    id: newId, issueIds: [issueId], title: issue.title, area: issue.area, priority: 'P3', stage: 'pending', verified: false,
    summary: '', action: '', citations: [],
  });
  return true;
}

export function mergeTopics(workspace, keepId, removeId, modelPair = []) {
  const keep = workspace.topics.find(row => row.id === keepId);
  const remove = workspace.topics.find(row => row.id === removeId);
  if (!keep || !remove || keep === remove) return false;
  keep.issueIds.push(...remove.issueIds);
  keep.citations.push(...remove.citations);
  keep.modelGroups = normalizeModelGroups([...(keep.modelGroups ?? []), ...(remove.modelGroups ?? []), modelPair],keep.issueIds);
  for (const field of ['owner','followUp','notes']) {
    if (!keep[field] && remove[field]) keep[field] = remove[field];
  }
  setStage(keep, 'pending');
  workspace.topics = workspace.topics.filter(row => row !== remove);
  return true;
}

export function rankTopics(topics) {
  return [...topics].sort((first, second) =>
    PRIORITIES.indexOf(first.priority) - PRIORITIES.indexOf(second.priority) ||
    second.issueIds.length - first.issueIds.length);
}

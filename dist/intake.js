import {normalizeWorkspace, setStage} from './workspace.js';

const ISSUE_IDENTITY = ['id', 'title', 'excerpt', 'date', 'url', 'area'];
export const SOURCE_FIELDS = [...ISSUE_IDENTITY,'likes','comments'];
const MAX_ISSUES = 500;
export const RAW_SOURCE = 'Feedback intake';

function fail(key) {
  throw new Error(key);
}

function readCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  let closed = false;
  const field = () => {
    row.push(value);
    value = '';
    closed = false;
  };
  const line = () => {
    field();
    if (row.some(cell => cell.trim())) rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') value += char;
      else if (text[index + 1] === '"') { value += '"'; index++; }
      else { quoted = false; closed = true; }
    } else if (char === ',') field();
    else if (char === '\r' || char === '\n') {
      line();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (char === '"') {
      if (value || closed) fail('importCsvSyntax');
      quoted = true;
    } else {
      if (closed) fail('importCsvSyntax');
      value += char;
    }
  }
  if (quoted) fail('importCsvSyntax');
  if (row.length || value || closed) line();

  const columns = rows.shift()?.map(cell => cell.trim().toLowerCase()) || [];
  if (new Set(columns).size !== columns.length || !columns.includes('id') || !columns.includes('title')) {
    fail('importCsvHeaders');
  }
  return rows.map(row => {
    if (row.length !== columns.length) fail('importCsvSyntax');
    return Object.fromEntries(columns.map((name,index) => [name,row[index]]));
  });
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}

function intakeWorkspace(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ISSUES) fail('importCountError');
  const issues = rows.map(row => {
    if (!row || typeof row !== 'object' || !['string','number'].includes(typeof row.id) ||
      typeof row.title !== 'string') fail('importRequiredFields');
    if (row.date && !validDate(row.date)) fail('importDateError');
    return {
      id: String(row.id), title: row.title, excerpt: row.excerpt || row.title,
      date: row.date || '', url: row.url || '', area: row.area || 'General',
      likes: row.likes, comments: row.comments,
    };
  });
  const topics = issues.map((issue,index) => ({
    id: `intake-${index + 1}`, issueIds:[issue.id.trim()], priority:'P3', title:issue.title, area:issue.area,
  }));
  return normalizeWorkspace({issues,topics,source:RAW_SOURCE});
}

export function decodeIntake(text, filename) {
  const source = text.replace(/^\uFEFF/,'');
  if (/\.csv$/i.test(filename)) return {kind:'raw',workspace:intakeWorkspace(readCsv(source))};
  const data = JSON.parse(source);
  if (data?.kind === 'feedback-desk-backup') return {kind:'backup',workspace:normalizeWorkspace(data.workspace),data};
  if (Array.isArray(data) || (Array.isArray(data?.issues) && data.topics === undefined)) {
    return {kind:'raw',workspace:intakeWorkspace(Array.isArray(data) ? data : data.issues)};
  }
  return {kind:'analysis',workspace:normalizeWorkspace(data)};
}

export const sameIssue = (first,second) => !!first && ISSUE_IDENTITY.every(field => first[field] === second[field]);

function freeTopicId(used, prefix = 'new') {
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index++;
  const id = `${prefix}-${index}`;
  used.add(id);
  return id;
}

export function planAppend(current, incoming) {
  const existingIds = new Map(current.issues.map(issue => [issue.id,issue]));
  const existingLinks = new Set(current.issues.map(issue => issue.url).filter(Boolean));
  const used = new Set(current.topics.map(topic => topic.id));
  const issues = [];
  const topics = [];
  let duplicates = 0;
  let conflicts = 0;
  for (const issue of incoming.issues) {
    const previous = existingIds.get(issue.id);
    if (previous && !sameIssue(previous,issue)) {
      conflicts++;
    } else if (previous || (issue.url && existingLinks.has(issue.url))) {
      duplicates++;
    } else {
      if (issue.url) existingLinks.add(issue.url);
      issues.push(issue);
      topics.push({id:freeTopicId(used), issueIds:[issue.id], priority:'P3', title:issue.title, area:issue.area});
    }
  }
  return {
    issues, topics, duplicates, conflicts,
    fits: current.issues.length + issues.length <= MAX_ISSUES,
  };
}

const groupKey = ids => JSON.stringify([...ids].sort());

export function planAnalysis(current, analyzed) {
  const currentById = new Map(current.issues.map(issue => [issue.id,issue]));
  if (currentById.size !== analyzed.issues.length || analyzed.issues.some(issue => !sameIssue(currentById.get(issue.id),issue))) return null;
  const originalGroups = new Map(current.topics.map(topic => [groupKey(topic.issueIds),topic]));
  const used = new Set(current.topics.map(topic => topic.id));
  let retained = 0;
  const topics = analyzed.topics.map(topic => {
    const original = originalGroups.get(groupKey(topic.issueIds));
    if (original) {
      retained++;
      // Keep the review decision, authored copy, and follow-up. Newly generated
      // text can be useful for a pending theme with no edits or follow-up yet.
      if (original.stage !== 'pending' || Object.keys(original.localized ?? {}).length ||
        original.owner || original.followUp || original.notes || original.summary || original.action || original.priority !== 'P3') return original;
      const updated = {...topic,id:original.id};
      setStage(updated,'pending');
      return updated;
    }
    const revised = {...topic, id:freeTopicId(used,'analysis')};
    setStage(revised,'pending');
    return revised;
  });
  return {
    workspace: normalizeWorkspace({...analyzed, issues:current.issues, topics}),
    retained, changed: topics.length - retained,
  };
}

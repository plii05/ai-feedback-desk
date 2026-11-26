import {readFile, writeFile} from 'node:fs/promises';
import {normalizeWorkspace} from '../dist/workspace.js';

const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const reference = await load('../eval/reference.json');
const issues = await load('../dist/data/issues.json');
const issueById = new Map(issues.map(issue => [issue.id, issue]));
const topics = reference.map(group => ({
  id: group.key,
  area: group.area,
  issueIds: group.ids.map(String),
  title: group.title || issueById.get(String(group.ids[0])).title,
  summary: group.summary || '',
  action: group.action || '',
  priority: group.priority || 'P3',
  verified: ['settings', 'fancy-desktop'].includes(group.key),
}));
const workspace = normalizeWorkspace({source: 'PowerToys 公开 Issue · 演示快照', issues, topics});
await writeFile(new URL('../dist/data/workspace.json', import.meta.url), JSON.stringify({source: workspace.source, topics: workspace.topics}, null, 2) + '\n');

import {readFile} from 'node:fs/promises';
import {normalizeWorkspace} from '../dist/workspace.js';

const load = async path => JSON.parse(await readFile(path, 'utf8'));
const reference = await load(new URL('../eval/reference.json', import.meta.url));
const label = new Map(reference.flatMap(group => group.ids.map(id => [String(id), group])));
const reviewed = new Set([...label.entries()].filter(([, group]) => group.split === 'test').map(([id]) => id));
const pairs = (input) => {
  const result = new Set();
  for (const group of input) {
    const ids = group.filter(id => reviewed.has(id)).sort();
    for (const [index, first] of ids.entries()) {
      for (const second of ids.slice(index + 1)) result.add(JSON.stringify([first, second]));
    }
  }
  return result;
};
const expected = pairs(reference.map(group => group.ids.map(String)));

if (process.argv.length < 3) {
  console.error('Usage: node scripts/compare.mjs baseline.json structured.json');
  process.exit(1);
}

const results = [];
for (const file of process.argv.slice(2)) {
  const workspace = normalizeWorkspace(await load(file));
  const present = new Set(workspace.issues.map(issue => issue.id));
  if ([...reviewed].some(id => !present.has(id))) throw new Error(`${file} 缺少测试集反馈`);
  const actual = pairs(workspace.topics.map(topic => topic.issueIds));
  const correct = [...actual].filter(pair => expected.has(pair)).length;
  const precision = actual.size ? correct / actual.size : 0;
  const recall = expected.size ? correct / expected.size : 0;
  // Moving one issue can alter several pairs. These counts describe pairs, not edit events.
  results.push({
    file, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    falseMergePairs: actual.size - correct, missedMatchPairs: expected.size - correct,
    topicsWithVerbatimEvidence: workspace.topics.filter(topic => topic.citations.length).length,
    topics: workspace.topics.length,
  });
}
console.log(JSON.stringify(results, null, 2));

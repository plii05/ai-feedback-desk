import {PRIORITIES, rankTopics, stageOf} from './workspace.js';
import {button, dateLabel, heading, html, pct, sourceLink, tag} from './ui.js';

export function metrics(workspace, t) {
  const {issues, topics} = workspace;
  const stats = [
    ['▤', issues.length, 'rawIssues'],
    ['⊞', topics.length, 'topics'],
    ['↗', topics.filter(topic => topic.priority === 'P1').length, 'highPriority'],
    ['✓', topics.filter(topic => stageOf(topic) === 'confirmed').length, 'confirmed'],
  ];
  return `<section class="metrics" aria-label="${t('overview')}">${stats.map(([icon, value, label]) =>
    `<div class="metric"><span class="metric-icon" aria-hidden="true">${icon}</span><div><strong>${value}</strong><small>${t(label)}</small></div></div>`).join('')}</section>`;
}

export function progress(workspace, t) {
  const total = workspace.topics.length;
  const done = workspace.topics.filter(topic => stageOf(topic) !== 'pending').length;
  return `<div class="progress-value"><strong>${Math.round(done / total * 100)}%</strong><span>${t('triagedCount',{done,total})}</span></div>
    <progress class="review-progress" value="${done}" max="${total}" aria-label="${t('reviewProgress')}"></progress>`;
}

const ONE_DAY = 86_400_000;
const utc = value => Date.parse(`${value}T00:00:00Z`);
const iso = time => new Date(time).toISOString().slice(0, 10);

function timeline(issues, language, t) {
  const dates = issues.map(issue => utc(issue.date)).filter(Number.isFinite).sort((a,b) => a-b);
  if (!dates.length) return `<p class="empty">${t('noDates')}</p>`;
  const earliest = dates[0];
  const length = 1 + Math.round((dates.at(-1) - earliest) / ONE_DAY);
  const span = Math.ceil(length / 24);
  const bins = Array(Math.ceil(length / span)).fill(0);
  for (const date of dates) bins[Math.floor((date - earliest) / ONE_DAY / span)]++;
  const largest = Math.max(...bins);
  return `<div class="timeline-plot" role="list" aria-label="${t('volumeByDate')}">${bins.map((value, index) => {
    const start = dateLabel(iso(earliest + index * span * ONE_DAY), language, true);
    const end = dateLabel(iso(earliest + Math.min(length - 1, (index + 1) * span - 1) * ONE_DAY), language, true);
    const bucket = start === end ? start : t('dateRange', {start, end});
    const label = html(`${bucket} — ${t('issueCount', {count: value})}`);
    return `<div class="timeline-column" role="listitem" aria-label="${label}" title="${label}" tabindex="0"><span class="timeline-bar" style="--bar:${Math.round(value / largest * 100)}%"><span>${value || ''}</span></span></div>`;
  }).join('')}</div>
    <div class="timeline-axis"><span>${dateLabel(iso(earliest), language, true)}</span><span>${dateLabel(iso(dates.at(-1)), language, true)}</span></div>`;
}

function topAreas(issues, t) {
  const counts = new Map();
  for (const issue of issues) counts.set(issue.area, (counts.get(issue.area) || 0) + 1);
  const top = [...counts].sort((a,b) => b[1] - a[1]).slice(0, 6);
  return `<div class="area-bars">${top.map(([name, count]) => button('open-area',
    `<span>${html(name)}</span><strong>${count}</strong><span class="area-track" aria-hidden="true"><i style="width:${100 * count / top[0][1]}%"></i></span>`,
    'area-button', name)).join('')}</div>`;
}

export function activityList(entries, language, t, limit = 5) {
  if (!entries.length) return `<p class="empty inset-empty">${t('activityEmpty')}</p>`;
  return `<ol class="activity-list">${entries.slice(0, limit).map(entry =>
    `<li><span class="activity-dot" aria-hidden="true"></span><div><strong>${html(entry.title[language])}</strong><span>${html(t(entry.action, {value: entry.value}))}</span></div><time datetime="${html(entry.at)}">${html(dateLabel(entry.at, language, true))}</time></li>`).join('')}</ol>`;
}

function workflow(workspace,t) {
  const count = stage => workspace.topics.filter(topic => stageOf(topic) === stage).length;
  const steps = [
    ['⇧','intakeStep','issueCount',workspace.issues.length,'show-import'],
    ['▤','reviewStep','flowReview',count('pending'),'open-pending'],
    ['▧','reportStep','flowReport',count('confirmed'),'open-report'],
    ['✓','followupStep','flowFollowup',count('resolved'),'open-followups'],
  ];
  return `<section class="workflow" aria-label="${t('flow')}">${steps.map(([icon,title,detail,total,action]) =>
    button(action,`<span class="workflow-icon" aria-hidden="true">${icon}</span><span><strong>${t(title)}</strong><small>${t(detail,{count:total})}</small></span><span class="workflow-arrow" aria-hidden="true">›</span>`,'workflow-step')).join('')}</section>`;
}

function localISO(date) {
  return `00${date.getFullYear()}`.slice(-4) + '-' +
    String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
}

function dueTopics(workspace) {
  const now = new Date();
  const today = localISO(now);
  const end = new Date(now.getFullYear(),now.getMonth(),now.getDate()+7);
  return rankTopics(workspace.topics.filter(topic =>
    ['confirmed','deferred'].includes(stageOf(topic)) && topic.followUp && topic.followUp <= localISO(end)))
    .sort((a,b) => a.followUp.localeCompare(b.followUp))
    .slice(0,5).map(topic => ({topic, deadline:topic.followUp < today ? 'overdue' : topic.followUp === today ? 'dueToday' : 'dueNextWeek'}));
}

function followUpPanel(workspace,titleOf,language,t) {
  const upcoming = dueTopics(workspace);
  return `<section class="panel"><div class="panel-head"><h2>${t('dueSoon')}</h2></div><div class="panel-body compact-body">${upcoming.length
    ? upcoming.map(({topic,deadline}) => button('open-topic',
      `<span class="chip deadline-${deadline}">${t(deadline)}</span><span><strong>${html(titleOf(topic))}</strong><small>${html(dateLabel(topic.followUp,language))} · ${html(topic.owner || t('unassigned'))}</small></span><span class="row-arrow" aria-hidden="true">↗</span>`,
      'next-item',topic.id)).join('')
    : `<p class="empty inset-empty">${t('noFollowups')}</p>`}</div></section>`;
}

export function overview({workspace, demo, language, t, titleOf, dateRange, activity}) {
  const next = rankTopics(workspace.topics.filter(topic => stageOf(topic) === 'pending')).slice(0, 4);
  const priorities = PRIORITIES.map(priority => [priority, workspace.topics.filter(topic => topic.priority === priority).length]);
  return `<section class="overview-hero"><div><span class="hero-source"><i></i>${t(demo ? 'publicSnapshot' : 'importedSnapshot')}</span>
    <h1>${t(demo ? 'overviewTitle' : 'overviewTitleImported')}</h1><p>${t('overviewIntro')}</p><div class="hero-period">${html(dateRange)}</div></div>
    <div class="actions">${button('open-pending', t('focus'), 'primary')}${button('open-all', t('browseAll'), 'secondary hero-secondary')}</div></section>` +
    workflow(workspace,t) + metrics(workspace,t) +
    `<div class="analytics-grid">
    <section class="panel trend-panel"><div class="panel-head"><div><h2>${t('volumeByDate')}</h2><p class="subtle">${t('volumeByDateHint')}</p></div><span class="list-total">${t('issueCount', {count: workspace.issues.length})}</span></div><div class="panel-body">${timeline(workspace.issues, language, t)}</div></section>
    <section class="panel"><div class="panel-head"><h2>${t('topAreas')}</h2></div><div class="panel-body">${topAreas(workspace.issues,t)}</div></section>
    <section class="panel"><div class="panel-head"><h2>${t('nextThemes')}</h2></div><div class="panel-body compact-body">${next.length ? next.map(topic =>
      button('open-topic', `${tag(topic.priority)}<span><strong>${html(titleOf(topic))}</strong><small>${html(topic.area)} · ${t('issueCount', {count:topic.issueIds.length})}</small></span><span class="row-arrow" aria-hidden="true">↗</span>`, 'next-item', topic.id)).join('')
      : `<p class="empty inset-empty">${t('emptyQueue')}</p>`}</div></section>
    <section class="panel"><div class="panel-head"><h2>${t('reviewProgress')}</h2></div><div class="panel-body">${progress(workspace,t)}<h3 class="priority-heading">${t('priorityBreakdown')}</h3><div class="priority-summary">${priorities.map(([priority,count]) => button('open-priority', `${tag(priority)}<strong>${count}</strong>`, 'priority-card', priority)).join('')}</div></div></section>
    ${followUpPanel(workspace,titleOf,language,t)}
    <section class="panel"><div class="panel-head"><h2>${t('activity')}</h2></div><div class="panel-body">${activityList(activity,language,t)}</div></section>
  </div>`;
}

const presets = [0.65,0.75,0.85];

export function thresholdRows(sweep, selected) {
  const included = new Set([...presets,selected]);
  return sweep.filter(row => included.has(row.threshold)).map(row =>
    `<tr${row.threshold === selected ? ' class="threshold-current" aria-current="true"' : ''}><th scope="row">${row.threshold.toFixed(2)}</th>
    <td>${row.clusters}</td><td>${pct(row.precision)}</td><td>${pct(row.recall)}</td><td>${row.falseMerges}</td><td>${row.missedMatches}</td></tr>`
  ).join('');
}

function sensitivity(benchmark, selected, t) {
  const sweep = benchmark.thresholdSweep;
  if (!sweep?.length) return '';
  const min = sweep[0].threshold;
  const max = sweep.at(-1).threshold;
  return `<section class="panel eval-panel"><div class="panel-head"><h2>${t('thresholdSweep')}</h2></div>
    <div class="panel-body"><p>${t('thresholdMethod',{count:benchmark.testIssues})}</p>
    <div class="threshold-controls"><label for="threshold-slider">${t('thresholdPick')}</label>
      <input id="threshold-slider" type="range" min="${min}" max="${max}" step="0.01" value="${selected}">
      <output id="threshold-value" for="threshold-slider">${selected.toFixed(2)}</output></div>
    <div class="segmented" id="threshold-presets" role="group" aria-label="${t('thresholdPresets')}">${presets.map(value =>
      `<button type="button" data-action="set-threshold" data-id="${value}" aria-pressed="${selected === value}">${value.toFixed(2)}</button>`).join('')}</div>
    <div class="table-wrap"><table class="simple-table"><thead><tr>${['threshold','clusterCount','precision','recall','falseMerge','missedMatch'].map(key =>
      `<th scope="col">${t(key)}</th>`).join('')}</tr></thead><tbody id="threshold-table">${thresholdRows(sweep,selected)}</tbody></table></div>
    <p class="subtle">${t('thresholdScope')}</p></div></section>`;
}

function correctionPanel(counts,t) {
  const total = counts.merge + counts.split;
  return `<section class="panel eval-panel"><div class="panel-head"><h2>${t('correctionPanel')}</h2></div><div class="panel-body">
    <div class="correction-stats"><div><strong>${counts.merge}</strong><span>${t('correctionMerge')}</span></div><div><strong>${counts.split}</strong><span>${t('correctionSplit')}</span></div></div>
    <p>${t(total ? 'correctionNote' : 'correctionEmpty')}</p><div class="actions correction-actions">
    ${total ? button('export-corrections',t('correctionExport'),'primary') : `<button type="button" class="button secondary" disabled>${t('correctionExport')}</button>`}
    ${button('source-issues',t('exportSourceIssues'),'secondary')}</div></div></section>`;
}

export function evaluation({benchmark, issues, errorKind, t, archiveAvailable, threshold, correctionCounts}) {
  const fields = [['precision','precision'], ['recall','recall'], ['f1','f1'], ['averagePrecision','averagePrecision']];
  const numbers = benchmark.models.map(model => `<tr><th scope="row">${html(model.name)}</th><td>${model.threshold.toFixed(2)}</td>${fields.map(([key]) => `<td>${pct(model[key])}</td>`).join('')}<td>${model.falsePositives}</td><td>${model.falseNegatives}</td></tr>`).join('');
  const labels = {false_merge:'falseMerge', missed_match:'missedMatch'};
  const filtered = benchmark.examples.filter(example => !errorKind || example.kind === errorKind);
  const note = example => example.kind === 'missed_match' ? 'errorNoteCrossLanguage' : example.first === '52209' ? 'errorNoteRename' : 'errorNoteConnect';
  const issueById = new Map(issues.map(item => [item.id,item]));
  const parameters = {total:benchmark.issues,dev:benchmark.devIssues,test:benchmark.testIssues,positive:benchmark.pairs.test.positive};
  return heading(t('evaluation'), t('evalIntro'), archiveAvailable ? `<a class="button primary" href="./ai-feedback-desk.zip" download>${t('zip')} <span aria-hidden="true">↓</span></a>` : '') +
    `<section class="panel eval-panel"><div class="panel-head"><h2>${t('pairRanking')}</h2><span class="list-total">${t('testPairs',{count:benchmark.pairs.test.total})}</span></div>
    <div class="panel-body"><div class="model-legend">${benchmark.models.map(model => `<span><i class="${model.name === 'MiniLM' ? 'semantic' : 'lexical'}"></i>${html(model.name)}</span>`).join('')}</div>
    <div class="model-grid">${fields.map(([key,label]) => `<section class="model-metric"><h3>${t(label)}</h3>${benchmark.models.map(model =>
      `<div class="model-bar" title="${html(model.name)} ${pct(model[key])}" aria-label="${html(model.name)} ${pct(model[key])}"><span class="model-track"><i class="${model.name === 'MiniLM' ? 'semantic' : 'lexical'}" style="width:${model[key]*100}%"></i></span><strong>${pct(model[key])}</strong></div>`).join('')}</section>`).join('')}</div>
    <p class="method-note">${t('evalMethod',parameters)}</p></div></section>
    <section class="panel eval-panel"><div class="panel-head"><h2>${t('evaluationTable')}</h2></div><div class="panel-body table-wrap">
    <table class="simple-table"><thead><tr><th scope="col">${t('method')}</th><th scope="col">${t('threshold')}</th>${fields.map(([,label]) => `<th scope="col">${t(label)}</th>`).join('')}<th scope="col">${t('falseMerge')}</th><th scope="col">${t('missedMatch')}</th></tr></thead><tbody>${numbers}</tbody></table></div></section>
    ${sensitivity(benchmark,threshold,t)}
    <section class="panel eval-panel"><div class="panel-head"><h2>${t('errorExamples')}</h2></div><div class="panel-body">
    <div class="segmented" role="group" aria-label="${t('errorExamples')}">${[['','allErrors'],...Object.entries(labels)].map(([value,label]) =>
      `<button type="button" data-action="error-type" data-id="${value}" aria-pressed="${errorKind === value}">${t(label)}</button>`).join('')}</div>
    <div class="error-grid">${filtered.map(example => `<article class="error-card"><h3>${t(labels[example.kind])} <span class="chip ai">${t('similarity',{score:example.score.toFixed(2)})}</span></h3>
    <p>${[example.first,example.second].map(id => sourceLink(issueById.get(id),t)).join('　')}</p><p>${t(note(example))}</p></article>`).join('')}</div></div></section>
    ${correctionPanel(correctionCounts,t)}
    <section class="panel eval-panel"><div class="panel-head"><h2>${t('generativeAnalysis')}</h2></div><div class="panel-body"><p>${t('generativeNote')}</p></div></section>`;
}

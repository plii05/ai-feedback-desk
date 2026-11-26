import {normalizeWorkspace, PRIORITIES, STAGES, THEME_FIELDS, stageOf, setStage, splitIssue, mergeTopics, rankTopics} from './workspace.js';
import {translator} from './i18n.js';
import {topicLocales} from './topic-locales.js';
import {button, dateLabel, download, heading, html, route, sourceLink, tag} from './ui.js';
import {activityList, evaluation, metrics, overview, progress, thresholdRows} from './dashboard.js';
import {decodeIntake, planAnalysis, planAppend, sameIssue, SOURCE_FIELDS, RAW_SOURCE} from './intake.js';

import {priorityScorer} from './priority.js';
import {aiMatchesForSplit, correction, correctionPairs, validatedCorrections} from './corrections.js';

const root = document.querySelector('#workspace');
const dialog = document.querySelector('#dialog');
const file = document.querySelector('#file');
const storageKey = 'feedback-desk-v1';
const localeKey = 'feedback-desk-language';
const pages = ['overview', 'review', 'report', 'evaluation'];
const auditActions = ['activityEdit','activityConfirm','activityReopen','activityPriority','activitySplit','activityMerge','activitySeparate','activityDefer','activityResolve'];
const clearFilters = {search: '', status: '', priority: '', area: '', sort: 'priority'};
const state = {
  ...clearFilters, workspace: null, demo: true, selected: 'settings', dismissed: [], activity: [], corrections: [],
  language: 'en', reportLimit: 3, reportSelection: null, errorKind: '', hasDemoIssues: true, threshold: 0.65,
};
let sample;
let demoTopics;
let benchmark;
let suggestions;
let scoreOf;
let toastTimer;
let archiveAvailable = false;
let pendingImport = null;
let readNumber = 0;

try {
  if (localStorage.getItem(localeKey) === 'zh') state.language = 'zh';
} catch { /* Keep the default language when storage is unavailable. */ }

const translations = {zh:translator('zh'), en:translator('en')};
const t = (key, values) => translations[state.language](key, values);
const findTopic = id => state.workspace.topics.find(topic => topic.id === id);
const byId = id => state.workspace.issues.find(issue => issue.id === id);
const topicOfIssue = id => state.workspace.topics.find(topic => topic.issueIds.includes(id));
const issueLink = issue => sourceLink(issue, t);
const formatDate = value => dateLabel(value, state.language);
const currentPage = () => pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

function textOf(topic, field, language = state.language) {
  if (topic.localized?.[language]?.[field] !== undefined) return topic.localized[language][field];
  const original = demoTopics.get(topic.id);
  const defaultCopy = topicLocales[language][topic.id];
  if (state.hasDemoIssues && original?.[field] === topic[field] && defaultCopy) {
    const translation = defaultCopy[Object.keys(THEME_FIELDS).indexOf(field)];
    if (translation !== undefined) return translation;
  }
  return topic[field];
}

const titleOf = topic => textOf(topic, 'title');
function sourceName() {
  if (state.demo) return t('publicSnapshot');
  if (state.hasDemoIssues && state.workspace.issues.length > sample.issues.length) return t('mixedSource');
  return state.workspace.source === RAW_SOURCE ? t('rawSource') : state.workspace.source;
}

function notify(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function validatedActivity(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 80).filter(entry =>
    entry && auditActions.includes(entry.action) && typeof entry.topicId === 'string' && entry.topicId.length <= 70 &&
    typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)) &&
    ['zh', 'en'].every(language => typeof entry.title?.[language] === 'string' && entry.title[language].length <= 400)
  ).map(entry => ({
    action: entry.action, topicId: entry.topicId, at: entry.at, title: {zh:entry.title.zh, en:entry.title.en},
    value: typeof entry.value === 'string' ? entry.value.slice(0, 40) : '',
  }));
}

function persist() {
  try {
    const {workspace, demo, dismissed, activity, corrections, reportLimit, reportSelection} = state;
    localStorage.setItem(storageKey, JSON.stringify({workspace, demo, dismissed, activity, corrections, reportLimit, reportSelection}));
    return true;
  } catch {
    return false;
  }
}

function saveNotice(message, action, topic, value = '') {
  if (action && topic) {
    const title = {zh: textOf(topic, 'title', 'zh'), en: textOf(topic, 'title', 'en')};
    state.activity.unshift({action, topicId:topic.id, title, value, at: new Date().toISOString()});
    state.activity = state.activity.slice(0, 80);
  }
  notify(t(persist() ? message : 'saveError'));
}

function dateWindow() {
  const dates = state.workspace.issues.map(issue => issue.date).filter(Boolean).sort();
  if (!dates.length) return t('dateMissing');
  const start = formatDate(dates[0]);
  const end = formatDate(dates.at(-1));
  return start === end ? start : t('dateRange', {start, end});
}

function candidates() {
  if (!state.hasDemoIssues) return [];
  const threshold = benchmark.models.find(model => model.name === 'MiniLM').threshold;
  const seen = new Set();
  const list = [];
  for (const match of suggestions) {
    if (match.score < threshold) break;
    const first = topicOfIssue(match.first);
    const second = topicOfIssue(match.second);
    if (!first || !second || first.id === second.id) continue;
    if ([first,second].some(topic => ['resolved','deferred'].includes(stageOf(topic)))) continue;
    const id = JSON.stringify([first.id, second.id].sort());
    if (seen.has(id) || state.dismissed.includes(id)) continue;
    seen.add(id);
    list.push({match, first, second, id});
  }
  return list;
}

function sortTopics(topics) {
  const ranked = rankTopics(topics);
  if (state.sort === 'followUp') return ranked.sort((a,b) =>
    (a.followUp || '9999-12-31').localeCompare(b.followUp || '9999-12-31'));
  if (state.sort === 'volume') return ranked.sort((a,b) => b.issueIds.length - a.issueIds.length);
  if (state.sort === 'recent') {
    const recent = topic => topic.issueIds.map(id => byId(id).date).sort().at(-1);
    return ranked.sort((a,b) => recent(b).localeCompare(recent(a)));
  }
  if (state.sort === 'suggested') {
    const scores = new Map(ranked.map(topic => [topic.id,scoreOf(topic).score]));
    return ranked.sort((a,b) => scores.get(b.id) - scores.get(a.id));
  }
  return ranked;
}

function visibleTopics() {
  const query = state.search.toLowerCase().trim();
  return sortTopics(state.workspace.topics.filter(topic => {
    const issues = topic.issueIds.map(byId);
    return (!state.status || stageOf(topic) === state.status) &&
      (!state.priority || state.priority === topic.priority) &&
      (!state.area || state.area === topic.area || issues.some(issue => issue.area === state.area)) &&
      (!query || [textOf(topic, 'title', 'zh'), textOf(topic, 'title', 'en'), textOf(topic, 'summary'),
        topic.area, topic.owner, ...issues.map(issue => `#${issue.id} ${issue.title} ${issue.excerpt}`)]
        .some(value => value?.toLowerCase().includes(query)));
  }));
}

function topicRows(topics) {
  if (!topics.length) return `<p class="empty">${t('emptyQueue')}</p>`;
  return topics.map(topic => `<button class="topic${state.selected === topic.id ? ' selected' : ''}" aria-pressed="${state.selected === topic.id}" data-action="select" data-id="${html(topic.id)}">
    <span><span class="topic-title">${html(titleOf(topic))}</span><span class="topic-meta"><span>${html(topic.area)}</span><span>${t('issueCount',{count:topic.issueIds.length})}</span>
    ${topic.owner ? `<span>${html(topic.owner)}</span>` : ''}
    <span class="chip stage-${stageOf(topic)}">${t(stageOf(topic))}</span></span></span>
    <span class="topic-rank">${tag(topic.priority)}
    <span class="topic-score">${t('scoreBadge',{score:scoreOf(topic).score.toFixed(1)})}</span></span>
  </button>`).join('');
}

function priorityCard(topic) {
  const score = scoreOf(topic);
  const parts = [
    ['scoreFrequency',score.frequency,50,t('scoreCounts',{count:score.total})],
    ['scoreEngagement',score.engagement,30,t('scoreActivity',score)],
    ['scoreRecency',score.recency,20,score.date ? t('scoreDates',{
      date:formatDate(score.date),reference:formatDate(score.reference),
    }) : t('scoreUnknownDate')],
  ];
  return `<section class="detail-section priority-card-detail"><div class="score-heading">
    <h3>${t('scoreTitle')}</h3><strong class="chip ai">${t('scoreLevel',{score:score.score.toFixed(1),level:score.level})}</strong></div>
    <p>${t('scoreMethod')}</p>
    <dl class="score-factors">${parts.map(([key,value,max,hint]) =>
      `<div><dt>${t(key)}</dt><dd><span>${value.toFixed(1)} / ${max}</span><small>${html(hint)}</small></dd></div>`).join('')}</dl>
    ${score.observed < score.total ? `<p class="subtle">${t('scoreMissingCounts',score)}</p>` : ''}
    <div class="score-footer"><details><summary>${t('scoreFormulaLabel')}</summary><p>${t('scoreFormula')}</p></details>
    ${score.level !== topic.priority ? button('adopt-score',t('scoreAdopt',score),'secondary small') : ''}</div></section>`;
}

function reviewPane(topic) {
  if (!topic) return `<p class="empty">${t('chooseTheme')}</p>`;
  const stage = stageOf(topic);
  const primary = {pending:'confirm',confirmed:'resolve',deferred:'unconfirm',resolved:'unconfirm'}[stage];
  const best = state.hasDemoIssues && suggestions.find(match => topic.issueIds.includes(match.first) && topic.issueIds.includes(match.second));
  const rationale = best
    ? `<div class="reason"><strong>✦ ${t('signals')}</strong><p>${html(t('signalHint', {...best,score:best.score.toFixed(2)}))}</p></div>` : '';
  const excerpts = topic.issueIds.map(id => {
    const issue = byId(id);
    const quote = topic.citations.find(item => item.issueId === id)?.quote ?? issue.excerpt;
    return `<article class="evidence"><header>${issueLink(issue)}<time datetime="${issue.date}">${html(formatDate(issue.date))}</time>${topic.issueIds.length > 1 ? button('split', t('split'), 'plain', id) : ''}</header>
      <p class="evidence-title">${html(issue.title)}</p>${quote === issue.title ? '' : `<p>${html(quote)}</p>`}</article>`;
  }).join('');
  const history = state.activity.filter(entry => entry.topicId === topic.id);
  return `<div class="detail-head"><div class="detail-kicker">${tag(topic.priority)}<span>${html(topic.area)}</span><span>·</span><span class="chip stage-${stage}">${t(stage)}</span></div>
    <h2>${html(titleOf(topic))}</h2>
    <div class="detail-controls"><div class="topic-selects"><label>${t('status')} <select id="topic-stage" class="control-select">${STAGES.map(item => `<option value="${item}"${item === stage ? ' selected' : ''}>${t(item)}</option>`).join('')}</select></label>
    <label>${t('humanPriority')} <select id="topic-priority" class="control-select">${PRIORITIES.map(priority => `<option ${priority === topic.priority ? 'selected' : ''}>${priority}</option>`).join('')}</select></label></div>
    <div class="actions">${button('edit',t('edit'))}${state.workspace.topics.length > 1 ? button('manual-merge',t('merge')) : ''}${button('verify',t(primary),'primary small')}</div></div>
    </div>
    <section class="detail-section"><h3>${t('summary')}</h3><p>${html(textOf(topic,'summary') || t('summaryEmpty'))}</p>${rationale}</section>
    ${priorityCard(topic)}
    <section class="detail-section"><h3>${t('evidence')} <span class="list-total">${topic.issueIds.length}</span></h3><div class="evidence-list">${excerpts}</div></section>
    <section class="detail-section"><h3>${t('action')}</h3><p>${html(textOf(topic,'action') || t('actionEmpty'))}</p></section>
    <section class="detail-section followup-section"><h3>${t('followup')}</h3><dl><div><dt>${t('assignee')}</dt><dd>${html(topic.owner || t('unassigned'))}</dd></div><div><dt>${t('followupDate')}</dt><dd>${html(formatDate(topic.followUp) || t('unset'))}</dd></div></dl>
    <p class="note"><strong>${t('reviewNotes')}</strong><span>${html(topic.notes || t('noNotes'))}</span></p>
    ${history.length ? `<details class="theme-history"><summary>${t('activity')}</summary>${activityList(history,state.language,t,3)}</details>` : ''}</section>`;
}

function redrawQueue() {
  const topics = visibleTopics();
  if (!topics.some(topic => topic.id === state.selected)) state.selected = topics[0]?.id;
  document.querySelector('#queue-count').textContent = t('topicCount', {count:topics.length});
  document.querySelector('#topic-list').innerHTML = topicRows(topics);
  document.querySelector('#detail').innerHTML = reviewPane(findTopic(state.selected));
  for (const control of root.querySelectorAll('[data-action="stage-filter"]')) {
    control.setAttribute('aria-pressed',String(control.dataset.id === state.status));
  }
  document.querySelector('#clear-filters').hidden = !Object.keys(clearFilters).some(name => state[name] !== clearFilters[name]);
}

function renderReview() {
  const count = candidates().length;
  const areas = new Set([...state.workspace.topics, ...state.workspace.issues].map(item => item.area));
  const option = (value, label) => `<option value="${html(value)}">${html(label)}</option>`;
  const areaOptions = [...areas].sort((a,b) => a.localeCompare(b)).map(area => option(area,area)).join('');
  const stageTabs = ['' ,...STAGES].map(stage => {
    const count = stage ? state.workspace.topics.filter(topic => stageOf(topic) === stage).length : state.workspace.topics.length;
    return `<button type="button" data-action="stage-filter" data-id="${stage}" aria-pressed="${stage === state.status}">${t(stage || 'tabAll')} <strong>${count}</strong></button>`;
  }).join('');
  root.innerHTML = heading(t('review'), `${html(sourceName())} <span aria-hidden="true">·</span> ${html(dateWindow())}`,
    `${button('next-pending',t('nextPending'),'secondary')}
    ${state.hasDemoIssues ? button('candidates', `<span class="symbol" aria-hidden="true">✧</span> ${t('candidates')} <span class="button-count">${count}</span>`, 'secondary') : ''}
    ${route('report', `${t('report')} <span aria-hidden="true">↗</span>`, 'primary')}`) + metrics(state.workspace,t) +
    `<div class="review-grid"><section class="panel" aria-label="${t('queue')}"><div class="panel-head"><h2>${t('queue')}</h2><span class="list-total" id="queue-count"></span></div>
    <div class="queue-stages" role="group" aria-label="${t('status')}">${stageTabs}</div>
    <div class="filters expanded-filters"><label class="search-field"><span class="search-icon" aria-hidden="true"></span><input id="search" type="search" placeholder="${html(t('search'))}" aria-label="${html(t('search'))}" value="${html(state.search)}"></label>
    <select id="filter-priority" data-filter="priority" aria-label="${t('priority')}">${option('',t('allPriorities'))}${PRIORITIES.map(priority => option(priority,priority)).join('')}</select>
    <select id="filter-area" data-filter="area" aria-label="${t('area')}">${option('',t('allAreas'))}${areaOptions}</select>
    <select id="filter-sort" data-filter="sort" aria-label="${t('sort')}">${option('priority',t('sortPriority'))}${option('suggested',t('sortSuggested'))}${option('volume',t('sortVolume'))}${option('recent',t('sortRecent'))}${option('followUp',t('sortDue'))}</select>
    <button type="button" class="button plain filter-reset" id="clear-filters" data-action="clear-filters">${t('clearFilters')}</button></div>
    <div class="topic-list" id="topic-list"></div></section>
    <section class="panel" id="detail" aria-label="${t('detail')}"></section></div>`;
  for (const select of root.querySelectorAll('[data-filter]')) select.value = state[select.dataset.filter];
  redrawQueue();
}

function confirmedTopics() {
  return rankTopics(state.workspace.topics.filter(topic => stageOf(topic) === 'confirmed'));
}

function reportTopics() {
  const confirmed = confirmedTopics();
  if (state.reportSelection === null) return confirmed.slice(0,state.reportLimit);
  const selected = new Set(state.reportSelection);
  return confirmed.filter(topic => selected.has(topic.id));
}

function renderReport() {
  const topics = reportTopics();
  const confirmed = confirmedTopics();
  const selectedIds = new Set(topics.map(topic => topic.id));
  const automatic = state.reportSelection === null;
  const reportOptions = [3,5,10].map(count => `<option value="${count}"${state.reportLimit === count ? ' selected' : ''}>${t('reportLimit',{count})}</option>`).join('');
  const selectionControls = automatic
    ? `<label>${t('reportCount')} <select class="control-select" id="report-limit">${reportOptions}</select></label>`
    : button('auto-report',t('useAutomatic'),'secondary small');
  const pickList = confirmed.map(topic => `<label class="report-pick"><input type="checkbox" data-report-theme="${html(topic.id)}"${selectedIds.has(topic.id) ? ' checked' : ''}>
    <span><strong>${html(titleOf(topic))}</strong><small>${html(topic.area)} · ${t('issueCount',{count:topic.issueIds.length})}</small></span>${tag(topic.priority)}</label>`).join('');
  root.innerHTML = heading(t('report'),html(t('editReportIntro',{dates:dateWindow()})),
    button('csv',t('csv'),'secondary') + (topics.length ? button('export',t('markdown'),'primary') : '')) +
    `<div class="report-grid">
    <section class="panel">
    <div class="panel-head report-header"><h2>${t('followUpFirst')}</h2><span class="list-total">${t('reportSelectedCount',{count:topics.length})}</span></div>
    <div class="panel-body">${topics.length ? topics.map(topic => `<article class="report-item"><h3>${tag(topic.priority)} <button type="button" class="button plain" data-action="open-topic" data-id="${html(topic.id)}">${html(titleOf(topic))}</button></h3>
    <p>${html(textOf(topic,'summary') || t('summaryEmpty'))}</p><p><strong>${t('action')}</strong>　${html(textOf(topic,'action') || t('actionEmpty'))}</p>
    <p><strong>${t('assignee')}</strong>　${html(topic.owner || t('unassigned'))}　<span class="separator">·</span>　<strong>${t('followupDate')}</strong>　${html(formatDate(topic.followUp) || t('unset'))}</p>
    <p><strong>${t('evidence')}</strong>　${topic.issueIds.map(id => issueLink(byId(id))).join('　')}</p></article>`).join('')
    : `<p>${t(confirmed.length ? 'reportSelectionEmpty' : 'reportEmpty')}</p>`}</div></section>
    <div class="report-side">
    <section class="panel"><div class="panel-head"><h2>${t('reportSelect')}</h2></div><div class="panel-body">
    <div class="report-mode"><span class="chip ai">${t(automatic ? 'reportSelectionAuto' : 'reportSelectionDraft')}</span>${selectionControls}</div>
    <p class="subtle">${t('reportSelectHint')}</p>
    ${pickList ? `<div class="report-pick-list">${pickList}</div>` : `<p>${t('reportEmpty')}</p>`}</div></section>
    <section class="panel"><div class="panel-head"><h2>${t('reviewProgress')}</h2></div><div class="panel-body">${progress(state.workspace,t)}<p>${route('review',t('review'),'secondary small')}</p></div></section>
    </div></div>`;
}

function toggleReportTheme(themeId, checked) {
  const selected = new Set(reportTopics().map(topic => topic.id));
  if (checked) selected.add(themeId);
  else selected.delete(themeId);
  state.reportSelection = [...selected];
  if (!persist()) notify(t('saveError'));
  renderReport();
  [...root.querySelectorAll('[data-report-theme]')].find(input => input.dataset.reportTheme === themeId)?.focus();
}

function loadReportPreferences(data) {
  state.reportLimit = [3,5,10].includes(data?.reportLimit) ? data.reportLimit : 3;
  state.reportSelection = Array.isArray(data?.reportSelection)
    ? data.reportSelection.filter(id => typeof id === 'string').slice(0,500) : null;
}

function render() {
  const page = currentPage();
  document.documentElement.lang = state.language === 'en' ? 'en' : 'zh-CN';
  document.title = `${t(page)} · Feedback Desk`;
  document.querySelector('#breadcrumb').textContent = t(page);
  document.querySelector('#sidebar').setAttribute('aria-label', t('workspaceNav'));
  document.querySelector('#brand').setAttribute('aria-label', t('home'));
  document.querySelector('#language-toggle').setAttribute('aria-label', t('language'));
  for (const element of document.querySelectorAll('[data-copy]')) element.textContent = t(element.dataset.copy);
  for (const control of document.querySelectorAll('[data-language]')) {
    control.setAttribute('aria-pressed', String(control.dataset.language === state.language));
  }
  for (const link of document.querySelectorAll('[data-page]')) {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (!state.workspace) return;
  document.querySelector('#workspace-name').textContent = state.demo ? 'PowerToys' : t('workspace');
  document.querySelector('#workspace-kind').textContent = t(state.demo ? 'publicWorkspace' : 'importedWorkspace');
  document.querySelector('#workspace-icon').textContent = state.demo ? 'P' : 'W';
  document.querySelector('#sidebar-source').hidden = !state.demo;
  if (page === 'overview') root.innerHTML = overview({...state,t,titleOf,dateRange:dateWindow()});
  else if (page === 'report') renderReport();
  else if (page === 'evaluation') {
    const correctionCounts = {merge:0,split:0};
    for (const pair of correctionPairs(state.corrections)) correctionCounts[pair.label]++;
    root.innerHTML = evaluation({benchmark,issues:sample.issues,errorKind:state.errorKind,t,archiveAvailable,
      threshold:state.threshold,correctionCounts});
  }
  else renderReview();
}

function showDialog(title, content) {
  dialog.innerHTML = `<div class="dialog-scroll"><div class="dialog-head"><h2 id="dialog-title">${title}</h2><form method="dialog"><button class="button secondary small" type="submit">${t('close')}</button></form></div>${content}</div>`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  if (!dialog.open) dialog.showModal();
}

function openCandidates() {
  const rows = candidates();
  showDialog(t('candidates'), `<p class="empty dialog-copy">${t('candidatesIntro')}</p>` +
    (rows.length ? rows.slice(0, 10).map(({match, first, id}) =>
      `<section class="candidate"><h3>${t('similarity',{score:match.score.toFixed(2)})}</h3><p>${issueLink(byId(match.first))}　${html(byId(match.first).title)}</p><p>${issueLink(byId(match.second))}　${html(byId(match.second).title)}</p>
      <p>${html(t('mergeHint',{title:titleOf(first)}))}</p><div class="actions">${button('merge',t('mergeTo'),'primary small',id)}${button('dismiss',t('separate'),'secondary small',id)}</div></section>`).join('') : `<p class="empty">${t('noCandidates')}</p>`));
}

function finishMerge(topic, source, modelPair = []) {
  const incoming = findTopic(source);
  if (!incoming || incoming === topic) return;
  const event = correction(modelPair.length ? 'ai_candidate_merge' : 'manual_merge',topic.issueIds,incoming.issueIds);
  if (!mergeTopics(state.workspace,topic.id,source,modelPair)) return;
  state.corrections.push(event);
  state.selected = topic.id;
  dialog.close();
  saveNotice('mergedDone', 'activityMerge', topic);
  renderReview();
}

function manualMerge(topic) {
  const available = state.workspace.topics.filter(item => item.id !== topic.id);
  available.sort((a,b) => Number(b.area === topic.area) - Number(a.area === topic.area));
  showDialog(t('merge'), `<form class="editor" id="merge-form"><p class="empty dialog-copy">${html(t('mergeHint',{title:titleOf(topic)}))}</p>
    <label>${t('mergePick')}<select class="control-select" name="source" required><option value="">${t('selectTopic')}</option>${available.map(item =>
    `<option value="${html(item.id)}">${html(titleOf(item))} · ${html(item.area)}</option>`).join('')}</select></label>
    <button class="button primary" type="submit">${t('confirmMerge')}</button></form>`);
  document.querySelector('#merge-form').addEventListener('submit', event => {
    event.preventDefault();
    finishMerge(topic, new FormData(event.currentTarget).get('source'));
  });
}

function editTopic(topic) {
  const values = Object.fromEntries(Object.keys(THEME_FIELDS).map(field => [field,textOf(topic,field)]));
  showDialog(t('edit'), `<form class="editor" id="edit-topic"><p class="subtle">${t('editLanguageHint')}</p>
    <label>${t('title')}<input name="title" required maxlength="400" value="${html(values.title)}"></label>
    <label>${t('summary')}<textarea name="summary" rows="3" maxlength="2000">${html(values.summary)}</textarea></label>
    <label>${t('action')}<textarea name="action" rows="3" maxlength="2000">${html(values.action)}</textarea></label>
    <div class="editor-row"><label>${t('assignee')}<input name="owner" maxlength="100" value="${html(topic.owner || '')}"></label>
    <label>${t('followupDate')}<input name="followUp" type="date" value="${html(topic.followUp || '')}"></label></div>
    <label>${t('reviewNotes')}<textarea name="notes" rows="3" maxlength="3000">${html(topic.notes || '')}</textarea></label>
    <button class="button primary" type="submit">${t('save')}</button></form>`);
  document.querySelector('#edit-topic').addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!data.get('title').trim()) { notify(t('titleRequired')); return; }
    const edits = Object.entries(values).filter(([name,original]) => data.get(name).trim() !== original);
    const shared = Object.fromEntries(['owner','followUp','notes'].map(name => [name,data.get(name).trim()]));
    if (!edits.length && Object.entries(shared).every(([name,value]) => value === (topic[name] || ''))) {
      notify(t('nothingChanged'));
      return;
    }
    if (edits.length) {
      const localized = (topic.localized ??= {});
      localized[state.language] = {...localized[state.language], ...Object.fromEntries(edits.map(([name]) => [name,data.get(name).trim()]))};
      setStage(topic,'pending');
    }
    Object.assign(topic,shared);
    dialog.close();
    saveNotice(edits.length ? 'needReview' : 'editsSaved', 'activityEdit', topic);
    renderReview();
  });
}

function exportReport() {
  const esc = value => value.replace(/[\\`*_<>\[\]#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  const lines = [`# ${t('reportTitle')}`, '', `${t('snapshotDate')} · ${dateWindow()}`, '', `${t('source')} · ${esc(sourceName())}`, ''];
  for (const topic of reportTopics()) {
    lines.push(`## ${topic.priority} · ${esc(titleOf(topic))}`, '', esc(textOf(topic,'summary') || t('summaryEmpty')), '',
      `**${t('action')}** · ${esc(textOf(topic,'action') || t('actionEmpty'))}`, '',
      `**${t('assignee')}** · ${esc(topic.owner || t('unassigned'))}  `,
      `**${t('followupDate')}** · ${formatDate(topic.followUp) || t('unset')}`, '');
    for (const id of topic.issueIds) {
      const issue = byId(id);
      lines.push(issue.url ? `- [#${esc(id)} ${esc(issue.title)}](<${issue.url}>)` : `- #${esc(id)} ${esc(issue.title)}`);
    }
    lines.push('');
  }
  download(lines.join('\n'), `feedback-briefing-${state.language}.md`, 'text/markdown;charset=utf-8');
  notify(t('exportDone'));
}

function exportCsv() {
  const csvCell = value => {
    const text = String(value ?? '');
    const guarded = /^[=+\-@]/.test(text.trimStart()) ? "'" + text : text;
    return '"' + guarded.replaceAll('"','""') + '"';
  };
  const columns = ['title','area','priority','status','rawIssues','assignee','followupDate','reviewNotes','originalLinks'];
  const rows = [columns.map(key => t(key)), ...rankTopics(state.workspace.topics).map(topic => [
    titleOf(topic), topic.area, topic.priority, t(stageOf(topic)),
    topic.issueIds.length, topic.owner, topic.followUp, topic.notes,
    topic.issueIds.map(id => byId(id).url).filter(Boolean).join(' '),
  ])];
  download('\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), `feedback-review-${state.language}.csv`, 'text/csv;charset=utf-8');
  notify(t('exportDone'));
}

function exportBackup() {
  const {workspace,demo,activity,dismissed,corrections,reportLimit,reportSelection} = state;
  download(JSON.stringify({kind:'feedback-desk-backup',workspace,demo,activity,dismissed,corrections,reportLimit,reportSelection},null,2) + '\n','feedback-workspace.json','application/json');
  notify(t('exportDone'));
}

function exportSourceIssues() {
  download(JSON.stringify(state.workspace.issues,null,2) + '\n','feedback-source-issues.json','application/json');
  notify(t('exportDone'));
}

function exportCorrections() {
  const pairs = correctionPairs(state.corrections);
  if (!pairs.length) { notify(t('correctionEmpty')); return; }
  download(pairs.map(pair => JSON.stringify(pair)).join('\n') + '\n','feedback-correction-pairs.jsonl','application/x-ndjson');
  notify(t('exportCorrectionsDone',{count:pairs.length}));
}

function showImport() {
  pendingImport = null;
  readNumber++;
  showDialog(t('intake'), `<p class="empty dialog-copy">${t('intakeFormat')}</p>
    <div class="actions">${button('choose-file',t('chooseIntake'),'primary')}
    ${button('intake-template',t('intakeTemplate'),'secondary')}</div>
    <div class="data-tools"><div class="actions">${button('source-issues',t('exportSourceIssues'))}${button('backup',t('backup'))}
    ${button('csv',t('csv'))}${state.corrections.length ? button('export-corrections',t('correctionExport')) : ''}
    ${button('reset-demo',t('reset'))}</div>
    <p class="subtle storage-note">${t('storageNote')}</p></div>`);
}

function showImportPreview(incoming) {
  const {filename,kind,workspace} = incoming;
  const kinds = {raw:'importRawKind',analysis:'importAnalysisKind',backup:'importBackupKind'};
  const append = kind === 'raw' && planAppend(state.workspace,workspace);
  const analysis = kind === 'analysis' && planAnalysis(state.workspace,workspace);
  let suggested = '';
  if (append) {
    const notice = !append.fits ? t('importAppendLimit') : append.issues.length ? '' : t('importNoNew');
    suggested = `<div class="import-option"><p>${t('importAppendInfo',append)}</p>${notice ? `<p>${notice}</p>` :
      button('intake-append',t('importAppend',{count:append.issues.length}),'primary')}</div>`;
  } else if (analysis) {
    suggested = `<div class="import-option"><p>${t('importApplyInfo',analysis)}</p>${button('intake-apply',t('importApply'),'primary')}</div>`;
  }
  showDialog(t('importPreview'), `<dl class="import-meta"><div><dt>${t('importFile')}</dt><dd>${html(filename)}</dd></div>
    <div><dt>${t(kinds[kind])}</dt><dd>${t('issueCount',{count:workspace.issues.length})} · ${t('topicCount',{count:workspace.topics.length})}</dd></div></dl>
    <ul class="import-sample">${workspace.issues.slice(0,3).map(issue => `<li><span>#${html(issue.id)}</span> ${html(issue.title)}</li>`).join('')}</ul>
    ${suggested}<div class="import-option"><p>${t('importReplaceInfo')}</p><div class="actions">
    ${button('intake-replace-confirm',t('importReplace'),suggested ? 'secondary' : 'primary')}${button('choose-file',t('chooseIntake'),'secondary')}</div></div>`);
}

function hasOriginalIssues(workspace) {
  const byId = new Map(workspace.issues.map(issue => [issue.id,issue]));
  return sample.issues.every(issue => sameIssue(byId.get(issue.id),issue));
}

function openQueue(filters = {}, topicId = '') {
  Object.assign(state,clearFilters,filters,{selected:topicId});
  if (currentPage() === 'review') renderReview();
  else location.hash = 'review';
}

function hydrateSnapshotCounts(workspace) {
  const originals = new Map(sample.issues.map(issue => [issue.id,issue]));
  for (const issue of workspace.issues) {
    const original = originals.get(issue.id);
    if (!sameIssue(original,issue)) continue;
    issue.likes ??= original.likes;
    issue.comments ??= original.comments;
  }
  return workspace;
}

function replaceWorkspace(workspace, options = {}) {
  const {demo = false, activity = [], dismissed = [], corrections = [], report, filters = {}, topicId} = options;
  hydrateSnapshotCounts(workspace);
  scoreOf = priorityScorer(workspace.issues);
  const hasDemoIssues = hasOriginalIssues(workspace);
  const showDemo = demo && hasDemoIssues && workspace.issues.length === sample.issues.length;
  Object.assign(state,clearFilters,filters,{workspace,demo:showDemo,hasDemoIssues,selected:topicId ?? (showDemo ? 'settings' : ''),
    activity,dismissed:hasDemoIssues ? dismissed : [],corrections:validatedCorrections(corrections,workspace.issues)});
  loadReportPreferences(report);
  const saved = persist();
  pendingImport = null;
  dialog.close();
  if (currentPage() !== 'review') location.hash = 'review';
  render();
  return saved;
}

function commitImport(action) {
  const incoming = pendingImport;
  if (!incoming) { notify(t('importUnavailable')); return; }
  const {workspace,kind,data} = incoming;
  const prior = {activity:state.activity,dismissed:state.dismissed,corrections:state.corrections,report:{reportLimit:state.reportLimit,reportSelection:state.reportSelection}};
  let saved;
  let message = 'importDone';
  if (action === 'intake-append' && kind === 'raw') {
    const plan = planAppend(state.workspace,workspace);
    if (!plan.fits || !plan.issues.length) { showImportPreview(incoming); return; }
    const appended = normalizeWorkspace({source:state.workspace.source,
      issues:[...state.workspace.issues,...plan.issues],topics:[...state.workspace.topics,...plan.topics]});
    saved = replaceWorkspace(appended,{...prior,topicId:plan.topics[0].id,filters:{status:'pending',sort:'recent'}});
    message = 'importAppendDone';
  } else if (action === 'intake-apply' && kind === 'analysis') {
    const plan = planAnalysis(state.workspace,workspace);
    if (!plan) { showImportPreview(incoming); return; }
    saved = replaceWorkspace(plan.workspace,{...prior,demo:state.demo,filters:{status:'pending'}});
    message = 'importApplyDone';
  } else if (action === 'intake-replace') {
    const backup = kind === 'backup' ? data : null;
    const dismissed = Array.isArray(backup?.dismissed) ? backup.dismissed.filter(id => typeof id === 'string').slice(0,1000) : [];
    saved = replaceWorkspace(workspace,{demo:backup?.demo === true,activity:validatedActivity(backup?.activity),dismissed,corrections:backup?.corrections,report:backup});
  } else return;
  notify(t(saved ? message : 'saveError'));
}

document.querySelector('#import').addEventListener('click', () => {
  if (state.workspace) showImport();
});

file.addEventListener('change', async () => {
  const uploaded = file.files[0];
  file.value = '';
  if (!uploaded || !state.workspace) return;
  const token = ++readNumber;
  if (uploaded.size > 8_000_000) { notify(t('importLarge')); return; }
  try {
    const text = await uploaded.text();
    if (token !== readNumber) return;
    const filename = uploaded.name || 'snapshot.json';
    pendingImport = {...decodeIntake(text,filename),filename};
    showImportPreview(pendingImport);
  } catch (error) {
    if (token !== readNumber) return;
    pendingImport = null;
    const message = ['importCsvSyntax','importCsvHeaders','importRequiredFields','importCountError','importDateError'].includes(error.message) ? error.message : 'importInvalid';
    notify(t(message));
  }
});

document.querySelector('#language-toggle').addEventListener('click', event => {
  const control = event.target.closest('[data-language]');
  if (!control || state.language === control.dataset.language) return;
  state.language = control.dataset.language;
  try {
    localStorage.setItem(localeKey,state.language);
  } catch {
    notify(t('preferenceError'));
  }
  render();
});

const stageNotice = {
  pending:['reopenedDone','activityReopen'], confirmed:['confirmedDone','activityConfirm'],
  deferred:['deferredDone','activityDefer'], resolved:['resolvedDone','activityResolve'],
};

function changeStage(topic, stage) {
  if (stageOf(topic) === stage || !setStage(topic,stage)) return;
  if (state.status && state.status !== stage) state.selected = visibleTopics()[0]?.id;
  saveNotice(...stageNotice[stage],topic);
  renderReview();
}

function nextPending() {
  const pending = sortTopics(state.workspace.topics.filter(topic => stageOf(topic) === 'pending'));
  if (!pending.length) { notify(t('noPending')); return; }
  const current = pending.findIndex(topic => topic.id === state.selected);
  const next = pending[(current + 1) % pending.length];
  openQueue({status:'pending',sort:state.sort},next.id);
  root.querySelector('[aria-pressed="true"].topic')?.focus({preventScroll:true});
}

function changePriority(topic, priority) {
  if (!topic || !PRIORITIES.includes(priority) || topic.priority === priority) return;
  topic.priority = priority;
  saveNotice('priorityDone','activityPriority',topic,priority);
  renderReview();
}

function setThreshold(value) {
  if (!benchmark.thresholdSweep?.some(row => row.threshold === value)) return;
  state.threshold = value;
  const slider = root.querySelector('#threshold-slider');
  slider.value = String(value);
  root.querySelector('#threshold-value').value = value.toFixed(2);
  root.querySelector('#threshold-table').innerHTML = thresholdRows(benchmark.thresholdSweep,value);
  for (const preset of root.querySelectorAll('[data-action="set-threshold"]')) {
    preset.setAttribute('aria-pressed',String(Number(preset.dataset.id) === value));
  }
}

document.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control || !state.workspace) return;
  const {action,id} = control.dataset;
  const topic = findTopic(state.selected);
  if (action === 'select') {
    state.selected = id;
    const list = document.querySelector('#topic-list');
    const old = list.scrollTop;
    redrawQueue();
    list.scrollTop = old;
    list.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
  } else if (action === 'stage-filter') {
    state.status = id;
    redrawQueue();
  } else if (action === 'clear-filters') {
    Object.assign(state,clearFilters);
    renderReview();
    document.querySelector('#search').focus();
  } else if (action === 'open-topic') openQueue({},id);
  else if (action === 'open-area') openQueue({area:id});
  else if (action === 'open-priority') openQueue({priority:id});
  else if (action === 'open-pending') openQueue({status:'pending'});
  else if (action === 'open-followups') openQueue({status:'confirmed',sort:'followUp'});
  else if (action === 'open-report') location.hash = 'report';
  else if (action === 'next-pending') nextPending();
  else if (action === 'open-all') openQueue();
  else if (action === 'verify' && topic) {
    const stage = stageOf(topic);
    changeStage(topic,stage === 'pending' ? 'confirmed' : stage === 'confirmed' ? 'resolved' : 'pending');
  } else if (action === 'split' && topic) {
    showDialog(t('split'), `<p class="empty dialog-copy">${html(t('splitHint',{id}))}</p>${button('confirm-split',t('confirmSplit'),'primary',id)}`);
  } else if (action === 'confirm-split' && topic) {
    const event = correction('split',[id],topic.issueIds.filter(item => item !== id),aiMatchesForSplit(topic,id));
    if (splitIssue(state.workspace,topic.id,id,crypto.randomUUID())) {
      state.corrections.push(event);
      dialog.close();
      saveNotice('splitDone','activitySplit',topic,id);
      renderReview();
    }
  } else if (action === 'edit' && topic) editTopic(topic);
  else if (action === 'manual-merge' && topic) manualMerge(topic);
  else if (action === 'export') exportReport();
  else if (action === 'auto-report') {
    state.reportSelection = null;
    if (!persist()) notify(t('saveError'));
    renderReport();
  }
  else if (action === 'csv') exportCsv();
  else if (action === 'export-corrections') exportCorrections();
  else if (action === 'set-threshold') setThreshold(Number(id));
  else if (action === 'adopt-score' && topic) changePriority(topic,scoreOf(topic).level);
  else if (action === 'backup') exportBackup();
  else if (action === 'candidates') openCandidates();
  else if (action === 'dismiss') {
    const match = candidates().find(row => row.id === id);
    if (!match) return;
    state.dismissed.push(id);
    state.corrections.push(correction('decline_ai_candidate',[match.match.first],[match.match.second]));
    saveNotice('separateDone','activitySeparate',match.first);
    renderReview();
    openCandidates();
  } else if (action === 'merge') {
    const match = candidates().find(row => row.id === id);
    if (match) finishMerge(match.first,match.second.id,[match.match.first,match.match.second]);
  } else if (action === 'choose-file') file.click();
  else if (action === 'show-import') showImport();
  else if (action === 'source-issues') exportSourceIssues();
  else if (action === 'intake-template') {
    download(SOURCE_FIELDS.join(',') + '\nissue-001,Settings window does not open,Clicking Settings opens no window.,2026-11-26,https://example.com/issues/1,Settings,0,1\n',
      'feedback-intake-template.csv','text/csv;charset=utf-8');
    notify(t('exportDone'));
  } else if (action === 'intake-replace-confirm' && pendingImport) {
    showDialog(t('importReplace'), `<p class="empty dialog-copy">${t('importReplaceInfo')}</p>
      <div class="actions">${button('intake-replace',t('importContinue'),'primary')}${button('intake-preview',t('importPreview'),'secondary')}</div>`);
  } else if (action === 'intake-preview' && pendingImport) showImportPreview(pendingImport);
  else if (['intake-append','intake-apply','intake-replace'].includes(action)) commitImport(action);
  else if (action === 'reset-demo') {
    showDialog(t('resetTitle'), `<p class="empty dialog-copy">${t('resetHint')}</p>${button('confirm-reset',t('resetConfirm'),'primary')}`);
  } else if (action === 'confirm-reset') {
    notify(t(replaceWorkspace(structuredClone(sample),{demo:true}) ? 'restoreDone' : 'saveError'));
  } else if (action === 'error-type') {
    state.errorKind = id;
    render();
    root.querySelector('[data-action="error-type"][aria-pressed="true"]')?.focus();
  }
});

root.addEventListener('input', event => {
  if (event.target.id === 'search') {
    state.search = event.target.value;
    redrawQueue();
  } else if (event.target.id === 'threshold-slider') {
    setThreshold(Number(event.target.value));
  }
});

root.addEventListener('change', event => {
  const {id,value,dataset} = event.target;
  if (dataset.reportTheme !== undefined) {
    toggleReportTheme(dataset.reportTheme,event.target.checked);
  } else if (dataset.filter) {
    state[dataset.filter] = value;
    redrawQueue();
  } else if (id === 'topic-stage') {
    changeStage(findTopic(state.selected),value);
  } else if (id === 'topic-priority') {
    changePriority(findTopic(state.selected),value);
  } else if (id === 'report-limit') {
    state.reportLimit = Number(value);
    if (!persist()) notify(t('saveError'));
    renderReport();
    document.querySelector('#report-limit').focus();
  }
});

async function load(name) {
  const response = await fetch(`./data/${name}.json`);
  if (!response.ok) throw new Error('Workspace data missing');
  return response.json();
}

render();
try {
  const [issues,fixture,report,matches] = await Promise.all([
    load('issues'),load('workspace'),load('benchmark'),load('suggestions'),
  ]);
  sample = normalizeWorkspace({...fixture,issues});
  demoTopics = new Map(sample.topics.map(topic => [topic.id,topic]));
  benchmark = report;
  suggestions = matches;
  state.workspace = structuredClone(sample);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved) {
      state.workspace = hydrateSnapshotCounts(normalizeWorkspace(saved.workspace));
      state.hasDemoIssues = hasOriginalIssues(state.workspace);
      state.demo = saved.demo === true && state.hasDemoIssues && state.workspace.issues.length === sample.issues.length;
      state.dismissed = Array.isArray(saved.dismissed) ? saved.dismissed : [];
      state.activity = validatedActivity(saved.activity);
      state.corrections = validatedCorrections(saved.corrections,state.workspace.issues);
      loadReportPreferences(saved);
    }
  } catch { /* Fall back to the public snapshot when storage is unavailable. */ }
  scoreOf = priorityScorer(state.workspace.issues);
  window.addEventListener('hashchange',render);
  render();
  fetch('./ai-feedback-desk.zip',{method:'HEAD'}).then(response => {
    archiveAvailable = response.ok && /zip|octet-stream/i.test(response.headers.get('content-type') || '');
    if (archiveAvailable && currentPage() === 'evaluation') render();
  }).catch(() => {});
} catch {
  root.innerHTML = `<p class="empty">${t('loadError')}</p>`;
} finally {
  root.setAttribute('aria-busy','false');
}

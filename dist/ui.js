export const html = (value = '') => String(value).replace(/[&<>"']/g, character => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);
export const pct = value => `${(value * 100).toFixed(1)}%`;
export const tag = text => `<span class="chip ${text.toLowerCase()}">${text}</span>`;

export function button(action, label, classes = 'secondary small', id = '') {
  return `<button type="button" data-action="${action}" data-id="${html(id)}" class="button ${classes}">${label}</button>`;
}

export function route(page, label, classes = 'secondary') {
  return `<a class="button ${classes}" href="#${page}">${label}</a>`;
}

export function heading(title, description, actions = '') {
  return `<header class="heading"><div><h1>${title}</h1><p>${description}</p></div>${actions ? `<div class="actions">${actions}</div>` : ''}</header>`;
}

export function sourceLink(issue, t) {
  return issue.url
    ? `<a href="${html(issue.url)}" target="_blank" rel="noopener noreferrer" aria-label="${html(t('openIssue', {id: issue.id}))}">#${html(issue.id)} <span aria-hidden="true">↗</span></a>`
    : `<strong>#${html(issue.id)}</strong>`;
}

export function dateLabel(value, language, compact = false) {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  const options = {month: 'short', day: 'numeric', timeZone: 'UTC'};
  if (!compact) options.year = 'numeric';
  return Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', options).format(date);
}

export function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

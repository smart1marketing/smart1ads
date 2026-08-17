import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);

// ------------------------------------------------------------------- api
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }

  if (!res.ok || (data && data.success === false)) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.code = data?.code;
    err.googleErrorCode = data?.googleErrorCode;
    err.field = data?.field;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body) => call('POST', url, body),
  put: (url, body) => call('PUT', url, body),
  del: (url) => call('DELETE', url)
};

// --------------------------------------------------------------- format
export const money = (n, digits = 0) =>
  `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const money2 = (n) => money(n, 2);

export const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });

export const pct = (n) => `${(Number(n || 0) * 100).toFixed(2)}%`;

export const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export const titleise = (s) =>
  String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // freeCheap -> free Cheap
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bDiy\b/g, 'DIY')
    .replace(/\bCpa\b/g, 'CPA');

/** "[roof repair]" -> { text, matchType } for display. */
export function splitKeyword(raw) {
  const t = String(raw || '').trim();
  if (t.startsWith('[') && t.endsWith(']')) return { text: t.slice(1, -1).trim(), matchType: 'exact' };
  if (t.startsWith('"') && t.endsWith('"')) return { text: t.slice(1, -1).trim(), matchType: 'phrase' };
  const tagged = t.match(/^(.*?)\s*\((exact|phrase|broad)\)$/i);
  if (tagged) return { text: tagged[1].trim(), matchType: tagged[2].toLowerCase() };
  return { text: t, matchType: 'phrase' };
}

// ------------------------------------------------------------ components
export const Badge = ({ tone = 'mute', children }) =>
  html`<span class="badge ${tone}">${children}</span>`;

const STATUS_TONE = {
  ENABLED: 'good', PAUSED: 'warn', REMOVED: 'bad',
  DRAFT: 'mute', IN_REVIEW: 'info', CHANGES_REQUESTED: 'warn',
  APPROVED: 'good', DEPLOYED: 'info', ARCHIVED: 'mute',
  HEALTHY: 'good', WARN: 'warn', CRITICAL: 'bad'
};

export const StatusBadge = ({ status }) =>
  html`<${Badge} tone=${STATUS_TONE[status] || 'mute'}>${titleise(status)}<//>`;

export const Stat = ({ label, value, foot }) => html`
  <div class="stat">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    ${foot ? html`<div class="foot">${foot}</div>` : null}
  </div>`;

export const Card = ({ title, sub, children, actions }) => html`
  <div class="card">
    ${title
      ? html`<div class="row" style="margin-bottom:.75rem">
          <h3 style="margin:0">${title}${sub ? html`<span class="sub">${sub}</span>` : null}</h3>
          <div class="spacer"></div>
          ${actions}
        </div>`
      : null}
    ${children}
  </div>`;

export const Notice = ({ tone = 'info', title, children }) => html`
  <div class="notice ${tone}">
    ${title ? html`<strong>${title}</strong>` : null}
    ${children}
  </div>`;

export const Empty = ({ title, children }) => html`
  <div class="empty">
    <h4>${title}</h4>
    <div>${children}</div>
  </div>`;

export const Spinner = ({ label }) =>
  html`<span class="row" style="gap:.5rem;color:var(--muted)"><span class="spin"></span>${label || 'Working…'}</span>`;

export const KeywordChips = ({ keywords, hideMatchTypes = false, negative = false }) => html`
  <div class="chips">
    ${(keywords || []).map((k) => {
      const { text, matchType } = splitKeyword(k);
      return html`<span class="chip ${negative ? 'neg' : matchType}">
        ${text}${!hideMatchTypes && !negative ? html`<span class="mt">${matchType}</span>` : null}
      </span>`;
    })}
  </div>`;

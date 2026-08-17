import { render } from 'preact';
import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import {
  html, api, money, money2, num, pct, when, titleise, splitKeyword,
  Badge, StatusBadge, Stat, Card, Notice, Empty, Spinner, KeywordChips
} from '/ui.js';

const USER_KEY = 's1a_user';

// ===========================================================================
// Root
// ===========================================================================

function App() {
  const [session, setSession] = useState(null);
  const [view, setView] = useState('campaigns');
  const [status, setStatus] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [activeProposalId, setActiveProposalId] = useState(null);
  const [user, setUser] = useState(() => localStorage.getItem(USER_KEY) || '');
  const [toast, setToast] = useState(null);

  const notify = useCallback((tone, message) => {
    setToast({ tone, message, id: Date.now() });
    setTimeout(() => setToast((t) => (t && t.message === message ? null : t)), 6000);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/api/status'));
    } catch (err) {
      if (err.status !== 401) notify('bad', err.message);
    }
  }, [notify]);

  const refreshProposals = useCallback(async () => {
    try {
      const data = await api.get('/api/proposals');
      setProposals(data.proposals || []);
    } catch (err) {
      if (err.status !== 401) notify('bad', err.message);
    }
  }, [notify]);

  useEffect(() => {
    api.get('/api/session').then(setSession).catch(() => setSession({ authenticated: false, passwordRequired: true }));
  }, []);

  useEffect(() => {
    if (session?.authenticated) {
      refreshStatus();
      refreshProposals();
    }
  }, [session, refreshStatus, refreshProposals]);

  const openProposal = useCallback((id, mode = 'proposal') => {
    setActiveProposalId(id);
    setView(mode);
  }, []);

  if (!session) return html`<div class="boot">Loading Smart 1 Ads…</div>`;
  if (!session.authenticated) return html`<${Login} onDone=${() => api.get('/api/session').then(setSession)} />`;

  const ctx = {
    user, setUser, status, refreshStatus, proposals, refreshProposals,
    notify, openProposal, setView, activeProposalId
  };

  return html`
    <div class="shell">
      <${Sidebar} view=${view} setView=${setView} proposals=${proposals} status=${status} />
      <main class="main">
        ${toast ? html`<div class="no-print"><${Notice} tone=${toast.tone}>${toast.message}<//></div>` : null}
        ${status && !status.security.passwordProtected
          ? html`<div class="no-print"><${Notice} tone="bad" title="This dashboard is not password protected">
              Anyone with the URL can pause, delete and create campaigns in your live Google Ads accounts.
              Set <span class="mono">APP_PASSWORD</span> in Render and redeploy.
            <//></div>`
          : null}
        ${view === 'campaigns' ? html`<${Campaigns} ...${ctx} />` : null}
        ${view === 'generator' ? html`<${Generator} ...${ctx} />` : null}
        ${view === 'approvals' ? html`<${Approvals} ...${ctx} />` : null}
        ${view === 'proposal' ? html`<${ProposalDetail} ...${ctx} />` : null}
        ${view === 'client-proposal' ? html`<${ClientProposal} ...${ctx} />` : null}
        ${view === 'audit' ? html`<${AuditLog} ...${ctx} />` : null}
        ${view === 'settings' ? html`<${Settings} ...${ctx} />` : null}
      </main>
    </div>`;
}

// ===========================================================================
// Login
// ===========================================================================

function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/login', { password });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class="login-wrap">
      <form class="login-card" onSubmit=${submit}>
        <div class="brand" style="margin-bottom:1.25rem">
          <span class="mark">1</span>
          <span>Smart 1 Ads<small>Campaign operations</small></span>
        </div>
        <div class="field">
          <label>Team password</label>
          <input type="password" value=${password} autofocus
                 onInput=${(e) => setPassword(e.target.value)} />
        </div>
        ${error ? html`<${Notice} tone="bad">${error}<//>` : null}
        <button class="btn-primary" style="width:100%;justify-content:center" disabled=${busy || !password}>
          ${busy ? html`<span class="spin"></span>` : null} Sign in
        </button>
      </form>
    </div>`;
}

// ===========================================================================
// Sidebar
// ===========================================================================

function Sidebar({ view, setView, proposals, status }) {
  const pending = proposals.filter((p) => ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED'].includes(p.status)).length;
  const items = [
    ['campaigns', 'Live campaigns'],
    ['generator', 'Campaign generator'],
    ['approvals', 'Approval hub', pending],
    ['audit', 'Audit log'],
    ['settings', 'Settings']
  ];

  return html`
    <aside class="sidebar no-print">
      <div class="brand"><span class="mark">1</span><span>Smart 1 Ads<small>Google Ads</small></span></div>
      ${items.map(([key, label, count]) => html`
        <button class="navitem ${view === key || (key === 'approvals' && ['proposal', 'client-proposal'].includes(view)) ? 'active' : ''}"
                onClick=${() => setView(key)}>
          <span>${label}</span>
          ${count ? html`<span class="count">${count}</span>` : null}
        </button>`)}
      <div class="sidebar-foot">
        ${status?.google?.connected
          ? html`<${Badge} tone="good">Google connected<//>`
          : html`<${Badge} tone="warn">Google not connected<//>`}
        <div style="margin-top:.5rem">Bing — phase 2</div>
      </div>
    </aside>`;
}

// ===========================================================================
// Live campaigns
// ===========================================================================

const DATE_RANGES = [
  ['LAST_7_DAYS', 'Last 7 days'], ['LAST_14_DAYS', 'Last 14 days'],
  ['LAST_30_DAYS', 'Last 30 days'], ['THIS_MONTH', 'This month'],
  ['LAST_MONTH', 'Last month'], ['LAST_90_DAYS', 'Last 90 days']
];

function Campaigns({ status, notify, setView, user }) {
  const [accounts, setAccounts] = useState([]);
  const [customerId, setCustomerId] = useState(() => localStorage.getItem('s1a_cid') || '');
  const [dateRange, setDateRange] = useState('LAST_30_DAYS');
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState(null);
  const [acting, setActing] = useState('');

  const connected = status?.google?.connected;

  useEffect(() => {
    if (!connected) return;
    api.get('/api/google/accounts')
      .then((d) => {
        const list = (d.accounts || []).filter((a) => !a.isManager);
        setAccounts(d.accounts || []);
        if (!customerId && list.length) {
          setCustomerId(list[0].id);
          localStorage.setItem('s1a_cid', list[0].id);
        }
      })
      .catch((err) => setError(err.message));
  }, [connected]);

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    setError('');
    try {
      const d = await api.get(`/api/google/campaigns?customerId=${customerId}&dateRange=${dateRange}`);
      setCampaigns(d.campaigns || []);
    } catch (err) {
      setError(err.message);
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, [customerId, dateRange]);

  useEffect(() => { load(); }, [load]);

  async function act(campaign, nextStatus) {
    const verb = { ENABLED: 'enable', PAUSED: 'pause', REMOVED: 'delete' }[nextStatus];
    if (nextStatus === 'REMOVED' && !confirm(`Delete "${campaign.name}"? Removed campaigns cannot be restored in Google Ads.`)) return;
    if (nextStatus === 'ENABLED' && !confirm(`Enable "${campaign.name}"? It will start spending against its daily budget of ${money2(campaign.dailyBudget)}.`)) return;

    setActing(campaign.id);
    try {
      await api.post(`/api/google/campaigns/${campaign.id}/status`, { customerId, status: nextStatus, user: user || 'Team' });
      notify('good', `Campaign "${campaign.name}" set to ${titleise(nextStatus)}.`);
      await load();
    } catch (err) {
      notify('bad', `Could not ${verb} campaign: ${err.message}`);
    } finally {
      setActing('');
    }
  }

  async function toggleDetail(campaign) {
    if (expanded === campaign.id) { setExpanded(null); return; }
    setExpanded(campaign.id);
    setDetail(null);
    try {
      const d = await api.get(`/api/google/campaigns/${campaign.id}?customerId=${customerId}`);
      setDetail(d.detail);
    } catch (err) {
      notify('bad', err.message);
    }
  }

  const totals = useMemo(() => campaigns.reduce((acc, c) => ({
    cost: acc.cost + c.cost, clicks: acc.clicks + c.clicks,
    impressions: acc.impressions + c.impressions, conversions: acc.conversions + c.conversions
  }), { cost: 0, clicks: 0, impressions: 0, conversions: 0 }), [campaigns]);

  if (!connected) {
    return html`
      <div class="page-head"><div><h1>Live campaigns</h1><p>Google Ads campaign operations</p></div></div>
      <${Notice} tone="warn" title="Google Ads is not connected yet">
        Head to Settings and click <strong>Connect Google Ads</strong> to authorise the account.
      <//>
      <button class="btn-primary" onClick=${() => setView('settings')}>Open settings</button>`;
  }

  return html`
    <div class="page-head">
      <div><h1>Live campaigns</h1><p>Google Ads · read, pause, enable and delete</p></div>
      <div class="row">
        <select style="width:auto" value=${customerId} onChange=${(e) => { setCustomerId(e.target.value); localStorage.setItem('s1a_cid', e.target.value); }}>
          ${accounts.map((a) => html`<option value=${a.id} disabled=${a.isManager}>
            ${a.isManager ? '— manager — ' : ''}${a.name} (${a.formattedId})
          </option>`)}
        </select>
        <select style="width:auto" value=${dateRange} onChange=${(e) => setDateRange(e.target.value)}>
          ${DATE_RANGES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
        </select>
        <button onClick=${load} disabled=${loading}>${loading ? html`<span class="spin"></span>` : '↻'} Refresh</button>
      </div>
    </div>

    ${error ? html`<${Notice} tone="bad" title="Google Ads returned an error">${error}<//>` : null}

    <div class="grid cols-4" style="margin-bottom:1rem">
      <${Stat} label="Spend" value=${money2(totals.cost)} foot=${titleise(dateRange)} />
      <${Stat} label="Clicks" value=${num(totals.clicks)} foot=${`${num(totals.impressions)} impressions`} />
      <${Stat} label="Conversions" value=${num(totals.conversions)}
               foot=${totals.conversions ? `${money2(totals.cost / totals.conversions)} CPA` : 'no conversions yet'} />
      <${Stat} label="Campaigns" value=${campaigns.length}
               foot=${`${campaigns.filter((c) => c.status === 'ENABLED').length} enabled`} />
    </div>

    <${Card}>
      ${loading && !campaigns.length ? html`<${Spinner} label="Pulling campaigns from Google Ads…" />` : null}
      ${!loading && !campaigns.length && !error
        ? html`<${Empty} title="No campaigns in this account">Generate one in the campaign generator, or pick a different account.<//>`
        : null}
      ${campaigns.length ? html`
        <table>
          <thead><tr>
            <th>Campaign</th><th>Status</th><th class="num">Daily budget</th>
            <th class="num">Spend</th><th class="num">Clicks</th><th class="num">CTR</th>
            <th class="num">Avg CPC</th><th class="num">Conv.</th><th class="num">CPA</th><th></th>
          </tr></thead>
          <tbody>
            ${campaigns.map((c) => html`
              <tr class="clickable" onClick=${() => toggleDetail(c)}>
                <td>
                  <div style="font-weight:600">${c.name}</div>
                  <div style="color:var(--dim);font-size:.76rem">${titleise(c.channel)} · ${titleise(c.biddingStrategy)}</div>
                </td>
                <td><${StatusBadge} status=${c.status} /></td>
                <td class="num">${money2(c.dailyBudget)}</td>
                <td class="num">${money2(c.cost)}</td>
                <td class="num">${num(c.clicks)}</td>
                <td class="num">${pct(c.ctr)}</td>
                <td class="num">${money2(c.avgCpc)}</td>
                <td class="num">${num(c.conversions)}</td>
                <td class="num">${c.conversions ? money2(c.costPerConversion) : '—'}</td>
                <td onClick=${(e) => e.stopPropagation()}>
                  <div class="row" style="gap:.3rem;justify-content:flex-end">
                    ${acting === c.id ? html`<span class="spin"></span>` : html`
                      ${c.status === 'ENABLED'
                        ? html`<button class="btn-sm" title="Pause" onClick=${() => act(c, 'PAUSED')}>Pause</button>`
                        : html`<button class="btn-sm btn-good" title="Enable" onClick=${() => act(c, 'ENABLED')}>Enable</button>`}
                      <button class="btn-sm btn-danger" title="Delete" onClick=${() => act(c, 'REMOVED')}>Delete</button>`}
                  </div>
                </td>
              </tr>
              ${expanded === c.id ? html`
                <tr><td colspan="10" style="background:var(--panel-2)">
                  ${!detail ? html`<${Spinner} label="Loading ad groups…" />` : html`
                    <div class="grid cols-2">
                      ${detail.adGroups.map((g) => html`
                        <div>
                          <div class="row" style="margin-bottom:.4rem">
                            <strong>${g.name}</strong>
                            <${StatusBadge} status=${g.status} />
                            <span style="color:var(--dim);font-size:.78rem">${money2(g.cpcBid)} bid · ${g.keywords.length} keywords</span>
                          </div>
                          <${KeywordChips} keywords=${g.keywords.filter((k) => !k.negative).slice(0, 40).map((k) => `${k.text} (${(k.matchType || '').toLowerCase()})`)} />
                        </div>`)}
                      ${!detail.adGroups.length ? html`<div style="color:var(--dim)">No ad groups.</div>` : null}
                    </div>`}
                </td></tr>` : null}`)}
          </tbody>
        </table>` : null}
    <//>`;
}

// ===========================================================================
// Campaign generator
// ===========================================================================

const OBJECTIVES = ['Lead generation', 'Phone calls', 'Online sales', 'Bookings / appointments', 'Quote requests', 'Brand awareness'];

function Generator({ notify, openProposal, refreshProposals, user }) {
  const [step, setStep] = useState(1);
  const [sectors, setSectors] = useState([]);
  const [form, setForm] = useState({
    businessName: '', websiteUrl: '', objective: OBJECTIVES[0], sector: 'general',
    budget: 3000, targetAudience: '', geography: '', notes: '', customApiKey: ''
  });
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [team, setTeam] = useState([]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.get('/api/sectors').then((d) => setSectors(d.sectors || [])).catch(() => {});
    api.get('/api/smart1-team/records').then((d) => setTeam(d.records || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get(`/api/budget-check?budget=${form.budget}&sector=${form.sector}`)
        .then((d) => setAnalysis(d.analysis))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [form.budget, form.sector]);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const d = await api.post('/api/generate-campaign', { ...form, user: user || 'Team' });
      notify('good', `Proposal built for ${d.proposal.clientName}.`);
      await refreshProposals();
      openProposal(d.proposal.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canContinue = form.businessName.trim() && form.websiteUrl.trim();

  return html`
    <div class="page-head">
      <div><h1>Campaign generator</h1><p>Build a full Google Ads search campaign from a landing page and a budget</p></div>
      <div class="row">${[1, 2, 3].map((n) => html`
        <span class="badge ${step === n ? 'info' : 'mute'}">Step ${n}</span>`)}</div>
    </div>

    ${step === 1 ? html`
      <${Card} title="Client and objective">
        ${team.length ? html`
          <div class="field">
            <label>Pull from Smart 1 Team</label>
            <select onChange=${(e) => {
              const rec = team.find((r) => r.id === e.target.value);
              if (rec) setForm((f) => ({ ...f, businessName: rec.clientName, budget: rec.monthlyBudget || f.budget }));
            }}>
              <option value="">— choose a client —</option>
              ${team.map((r) => html`<option value=${r.id}>${r.clientName}${r.monthlyBudget ? ` · ${money(r.monthlyBudget)}/mo` : ''}</option>`)}
            </select>
            <div class="hint">Pulls the client name and monthly allocated budget from your Knack database.</div>
          </div>` : null}

        <div class="grid cols-2">
          <div class="field"><label>Client / business name</label>
            <input value=${form.businessName} onInput=${set('businessName')} placeholder="Apex Roofing" /></div>
          <div class="field"><label>Landing page URL</label>
            <input value=${form.websiteUrl} onInput=${set('websiteUrl')} placeholder="https://apexroofing.com/roof-repair" /></div>
          <div class="field"><label>Primary objective</label>
            <select value=${form.objective} onChange=${set('objective')}>
              ${OBJECTIVES.map((o) => html`<option>${o}</option>`)}
            </select></div>
          <div class="field"><label>Sector</label>
            <select value=${form.sector} onChange=${set('sector')}>
              ${sectors.map((s) => html`<option value=${s.key}>${s.label} ($${s.low}–$${s.high} CPC)</option>`)}
            </select></div>
          <div class="field"><label>Target audience</label>
            <input value=${form.targetAudience} onInput=${set('targetAudience')} placeholder="Homeowners 35–65, storm damage" /></div>
          <div class="field"><label>Geography</label>
            <input value=${form.geography} onInput=${set('geography')} placeholder="Indianapolis metro, 25 mile radius" /></div>
        </div>
        <div class="field"><label>Anything else the strategist should know</label>
          <textarea value=${form.notes} onInput=${set('notes')} placeholder="Competitors, seasonality, services to exclude…"></textarea></div>

        <div class="row end">
          <button class="btn-primary" disabled=${!canContinue} onClick=${() => setStep(2)}>Continue to budget</button>
        </div>
      <//>` : null}

    ${step === 2 ? html`
      <${Card} title="Budget" sub="drag to see what the money actually buys">
        <div class="field">
          <div class="row" style="justify-content:space-between">
            <label style="margin:0">Monthly budget</label>
            <strong style="font-size:1.35rem">${money(form.budget)}<span style="color:var(--dim);font-size:.85rem;font-weight:400">/mo</span></strong>
          </div>
          <input type="range" min="300" max="30000" step="100" value=${form.budget}
                 onInput=${(e) => setForm((f) => ({ ...f, budget: Number(e.target.value) }))} />
          <div class="row" style="justify-content:space-between;color:var(--dim);font-size:.75rem">
            <span>$300</span><span>$30,000+</span>
          </div>
        </div>

        ${analysis ? html`
          <${Notice} tone=${analysis.status === 'HEALTHY' ? 'good' : analysis.status === 'WARN' ? 'warn' : 'bad'}
                     title=${`${titleise(analysis.status)} · ${analysis.sector}`}>
            ${analysis.advice}
          <//>
          <div class="grid cols-3">
            <${Stat} label="Est. clicks / month" value=${num(analysis.estimatedClicks)}
                     foot=${`${num(analysis.worstCaseClicks)} at the high end of CPC`} />
            <${Stat} label="Sector CPC range" value=${`$${analysis.cpcRange.low}–$${analysis.cpcRange.high}`} foot=${analysis.sector} />
            <${Stat} label="Suggested floor" value=${money(analysis.recommendedMinimum)} foot="~100 clicks/mo to learn from" />
          </div>` : null}

        <div class="row end" style="margin-top:1rem">
          <button class="btn-ghost" onClick=${() => setStep(1)}>Back</button>
          <button class="btn-primary" onClick=${() => setStep(3)}>Continue</button>
        </div>
      <//>` : null}

    ${step === 3 ? html`
      <${Card} title="Generate the campaign">
        <div class="grid cols-2" style="margin-bottom:1rem">
          <${Stat} label="Client" value=${form.businessName} foot=${form.websiteUrl} />
          <${Stat} label="Budget" value=${`${money(form.budget)}/mo`} foot=${analysis ? `${titleise(analysis.status)} · ${analysis.sector}` : ''} />
        </div>
        <div class="field">
          <label>OpenAI key override (optional)</label>
          <input type="password" value=${form.customApiKey} onInput=${set('customApiKey')}
                 placeholder="Leave blank to use the server's OPENAI_API_KEY" />
        </div>
        ${error ? html`<${Notice} tone="bad" title="Generation failed">${error}<//>` : null}
        <div class="row end">
          <button class="btn-ghost" onClick=${() => setStep(2)}>Back</button>
          <button class="btn-primary" disabled=${busy} onClick=${generate}>
            ${busy ? html`<span class="spin"></span>` : null}
            ${busy ? 'Building 2–3 ad groups, 20–50 keywords each…' : 'Generate campaign'}
          </button>
        </div>
        ${busy ? html`<div class="hint" style="margin-top:.6rem">This usually takes 20–45 seconds.</div>` : null}
      <//>` : null}`;
}

// ===========================================================================
// Approval hub
// ===========================================================================

function Approvals({ proposals, openProposal, refreshProposals, notify, setView }) {
  async function remove(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this proposal? This only removes it from Smart 1 Ads.')) return;
    try {
      await api.del(`/api/proposals/${id}`);
      await refreshProposals();
      notify('good', 'Proposal deleted.');
    } catch (err) {
      notify('bad', err.message);
    }
  }

  return html`
    <div class="page-head">
      <div><h1>Approval hub</h1><p>Review, discuss, approve, then deploy to Google Ads</p></div>
      <button class="btn-primary" onClick=${() => setView('generator')}>New campaign</button>
    </div>

    <${Card}>
      ${!proposals.length
        ? html`<${Empty} title="No proposals yet">Build one in the campaign generator.<//>`
        : html`
        <table>
          <thead><tr>
            <th>Client</th><th>Status</th><th class="num">Budget</th><th class="num">Ad groups</th>
            <th class="num">Keywords</th><th>Comments</th><th>Updated</th><th></th>
          </tr></thead>
          <tbody>
            ${proposals.map((p) => {
              const cd = p.campaignData || {};
              const kw = (cd.adGroups || []).reduce((n, g) => n + (g.keywords?.length || 0), 0);
              return html`
                <tr class="clickable" onClick=${() => openProposal(p.id)}>
                  <td>
                    <div style="font-weight:600">${p.clientName}</div>
                    <div style="color:var(--dim);font-size:.76rem">${cd.websiteUrl || ''}</div>
                  </td>
                  <td><${StatusBadge} status=${p.status} /></td>
                  <td class="num">${money(cd.monthlyBudget)}</td>
                  <td class="num">${(cd.adGroups || []).length}</td>
                  <td class="num">${kw}</td>
                  <td>${(p.comments || []).length || '—'}</td>
                  <td style="color:var(--muted)">${when(p.updatedAt)}</td>
                  <td onClick=${(e) => e.stopPropagation()}>
                    <div class="row" style="gap:.3rem;justify-content:flex-end">
                      <button class="btn-sm" onClick=${() => openProposal(p.id, 'client-proposal')}>Client PDF</button>
                      <button class="btn-sm btn-danger" onClick=${(e) => remove(p.id, e)}>Delete</button>
                    </div>
                  </td>
                </tr>`;
            })}
          </tbody>
        </table>`}
    <//>`;
}

// ===========================================================================
// Proposal detail
// ===========================================================================

function ProposalDetail({ activeProposalId, refreshProposals, notify, openProposal, setView, user, status }) {
  const [proposal, setProposal] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState('');
  const [deployResult, setDeployResult] = useState(null);
  const [deployError, setDeployError] = useState(null);

  const load = useCallback(async () => {
    if (!activeProposalId) return;
    const d = await api.get(`/api/proposals/${activeProposalId}`);
    setProposal(d.proposal);
    if (d.proposal.googleCustomerId) setCustomerId(d.proposal.googleCustomerId);
  }, [activeProposalId]);

  useEffect(() => { load().catch((e) => notify('bad', e.message)); }, [load]);

  useEffect(() => {
    if (!status?.google?.connected) return;
    api.get('/api/google/accounts')
      .then((d) => {
        setAccounts(d.accounts || []);
        setCustomerId((cur) => cur || localStorage.getItem('s1a_cid') || '');
      })
      .catch(() => {});
  }, [status]);

  if (!proposal) return html`<${Spinner} label="Loading proposal…" />`;

  const cd = proposal.campaignData || {};
  const est = cd.costEstimation || {};
  const totalKeywords = (cd.adGroups || []).reduce((n, g) => n + (g.keywords?.length || 0), 0);
  const negatives = Object.values(cd.negativeKeywordVault || {}).flat();
  const deployed = proposal.status === 'DEPLOYED';

  async function setStatusTo(next) {
    setBusy(next);
    try {
      await api.post(`/api/proposals/${proposal.id}/status`, { status: next, user: user || 'Team' });
      await load();
      await refreshProposals();
      notify('good', `Proposal marked ${titleise(next)}.`);
    } catch (err) {
      notify('bad', err.message);
    } finally {
      setBusy('');
    }
  }

  async function addComment(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    setBusy('comment');
    try {
      await api.post(`/api/proposals/${proposal.id}/comments`, { text: comment, author: user || 'Team' });
      setComment('');
      await load();
      await refreshProposals();
    } catch (err) {
      notify('bad', err.message);
    } finally {
      setBusy('');
    }
  }

  async function deploy(validateOnly) {
    setBusy(validateOnly ? 'validate' : 'deploy');
    setDeployError(null);
    setDeployResult(null);
    try {
      const d = await api.post('/api/google/deploy', {
        proposalId: proposal.id, customerId, validateOnly, user: user || 'Team'
      });
      setDeployResult(d.result);
      if (!validateOnly) {
        notify('good', 'Campaign created in Google Ads — paused, ready for your review.');
        await load();
        await refreshProposals();
      } else {
        notify('good', `Dry run passed: ${d.result.operationCount} operations validated by Google.`);
      }
    } catch (err) {
      setDeployError(err);
    } finally {
      setBusy('');
    }
  }

  return html`
    <div class="page-head">
      <div>
        <div class="row" style="gap:.5rem"><h1 style="margin:0">${proposal.clientName}</h1><${StatusBadge} status=${proposal.status} /></div>
        <p>${cd.websiteUrl} · ${money(cd.monthlyBudget)}/mo · ${cd.sector || ''}</p>
      </div>
      <div class="row">
        <button onClick=${() => setView('approvals')}>← All proposals</button>
        <button onClick=${() => openProposal(proposal.id, 'client-proposal')}>Client proposal</button>
      </div>
    </div>

    <div class="grid cols-4" style="margin-bottom:1rem">
      <${Stat} label="Ad groups" value=${(cd.adGroups || []).length} />
      <${Stat} label="Keywords" value=${totalKeywords} foot=${`${negatives.length} negatives`} />
      <${Stat} label="Est. clicks / mo" value=${num(est.estimatedMonthlyClicks)} foot=${`${money2(est.avgCPC)} avg CPC`} />
      <${Stat} label="Est. CPA" value=${est.estimatedCPA ? money2(est.estimatedCPA) : '—'}
               foot=${`${num(est.estimatedConversions)} conversions/mo`} />
    </div>

    ${est.budgetViability ? html`
      <${Notice} tone=${est.budgetViability.status === 'HEALTHY' ? 'good' : est.budgetViability.status === 'WARN' ? 'warn' : 'bad'}
                 title=${`Budget viability: ${titleise(est.budgetViability.status)}`}>
        ${est.budgetViability.advice}
      <//>` : null}

    ${cd.strategySummary ? html`<${Card} title="Strategy">${cd.strategySummary}<//>` : null}

    <!-- ------------------------------------------------------- deployment -->
    <${Card} title="Deploy to Google Ads" sub="everything is created paused">
      ${deployed ? html`
        <${Notice} tone="good" title="Deployed">
          Campaign <strong>${proposal.deployment?.campaignName}</strong> was created on ${when(proposal.deployment?.deployedAt)}
          in account ${proposal.deployment?.customerId}. It is <strong>paused</strong> — enable it in Live campaigns or in Google Ads when you are ready.
          ${proposal.deployment?.manageUrl ? html` <a href=${proposal.deployment.manageUrl} target="_blank" rel="noopener">Open in Google Ads →</a>` : null}
        <//>` : html`
        ${!status?.google?.connected
          ? html`<${Notice} tone="warn">Connect Google Ads in Settings before deploying.<//>`
          : html`
          <div class="row" style="align-items:flex-end;margin-bottom:.8rem">
            <div style="flex:1;min-width:260px">
              <label>Destination account</label>
              <select value=${customerId} onChange=${(e) => setCustomerId(e.target.value)}>
                <option value="">— choose an account —</option>
                ${accounts.map((a) => html`<option value=${a.id} disabled=${a.isManager}>
                  ${a.isManager ? '— manager — ' : ''}${a.name} (${a.formattedId})</option>`)}
              </select>
            </div>
            <button disabled=${!customerId || busy} onClick=${() => deploy(true)}>
              ${busy === 'validate' ? html`<span class="spin"></span>` : null} Dry run
            </button>
            <button class="btn-primary" disabled=${!customerId || busy || proposal.status !== 'APPROVED'}
                    onClick=${() => { if (confirm('Create this campaign in Google Ads? It will be created PAUSED and will not spend until you enable it.')) deploy(false); }}>
              ${busy === 'deploy' ? html`<span class="spin"></span>` : null} Deploy
            </button>
          </div>
          ${proposal.status !== 'APPROVED'
            ? html`<div class="hint">Approve the proposal below before it can be deployed. Dry run works at any status.</div>`
            : null}`}

        ${deployResult ? html`
          <${Notice} tone="good" title=${deployResult.validated ? 'Dry run passed' : 'Campaign created'}>
            ${deployResult.validated
              ? `Google validated all ${deployResult.operationCount} operations. Nothing was written.`
              : `Created "${deployResult.campaignName}" — ${deployResult.adGroupCount} ad groups, ${deployResult.keywordCount} keywords, ${deployResult.negativeCount} negatives. Paused.`}
          <//>` : null}

        ${deployError ? html`
          <${Notice} tone="bad" title="Google rejected the deployment">
            ${deployError.message}
            ${deployError.googleErrorCode ? html`<div class="mono" style="margin-top:.4rem">${deployError.googleErrorCode}${deployError.field ? ` · ${deployError.field}` : ''}</div>` : null}
          <//>` : null}`}
    <//>

    <!-- ------------------------------------------------------- ad groups -->
    ${(cd.adGroups || []).map((g) => html`
      <${Card} title=${g.name} sub=${`${g.keywords.length} keywords · ${money2(g.avgCPC)} bid`}>
        ${g.theme ? html`<p style="color:var(--muted);margin-top:0">${g.theme}</p>` : null}
        <${KeywordChips} keywords=${g.keywords} />
        ${g.ads?.headlines?.length ? html`
          <div class="grid cols-2" style="margin-top:1rem">
            <div>
              <label>Headlines (max 30 chars)</label>
              <div class="chips">${g.ads.headlines.map((hl) => html`<span class="chip">${hl}<span class="mt">${hl.length}</span></span>`)}</div>
            </div>
            <div>
              <label>Descriptions (max 90 chars)</label>
              <div class="chips">${(g.ads.descriptions || []).map((d) => html`<span class="chip">${d}<span class="mt">${d.length}</span></span>`)}</div>
            </div>
          </div>` : null}
      <//>`)}

    <!-- ---------------------------------------------------------- assets -->
    <${Card} title="Ad assets">
      <div class="grid cols-2">
        <div>
          <label>Sitelinks</label>
          ${(cd.adAssets?.sitelinks || []).map((s) => html`
            <div style="margin-bottom:.5rem">
              <div style="font-weight:600">${s.title}</div>
              <div style="color:var(--muted);font-size:.82rem">${s.desc1}${s.desc2 ? html`<br />${s.desc2}` : null}</div>
              <div class="mono" style="color:var(--dim)">${s.url}</div>
            </div>`)}
        </div>
        <div>
          <label>Callouts</label>
          <${KeywordChips} keywords=${cd.adAssets?.callouts || []} hideMatchTypes=${true} />
          <label style="margin-top:1rem">Structured snippets — ${cd.adAssets?.structuredSnippets?.header || ''}</label>
          <${KeywordChips} keywords=${cd.adAssets?.structuredSnippets?.values || []} hideMatchTypes=${true} />
        </div>
      </div>
    <//>

    <!-- ------------------------------------------------------- negatives -->
    <${Card} title="Negative keyword vault" sub=${`${negatives.length} terms`}>
      <div class="grid cols-2">
        ${Object.entries(cd.negativeKeywordVault || {}).map(([bucket, list]) => html`
          <div>
            <label>${titleise(bucket)} (${list.length})</label>
            <${KeywordChips} keywords=${list} negative=${true} />
          </div>`)}
      </div>
    <//>

    <!-- -------------------------------------------------- landing page -->
    ${cd.landingPageAnalysis ? html`
      <${Card} title="Landing page review">
        <div class="row" style="margin-bottom:.6rem">
          <${Badge} tone=${cd.landingPageAnalysis.ctaReadiness === 'High' ? 'good' : cd.landingPageAnalysis.ctaReadiness === 'Low' ? 'bad' : 'warn'}>
            CTA readiness: ${cd.landingPageAnalysis.ctaReadiness}<//>
        </div>
        ${cd.landingPageAnalysis.messageMatch ? html`<p style="margin-top:0">${cd.landingPageAnalysis.messageMatch}</p>` : null}
        <ul style="color:var(--muted);margin:0;padding-left:1.1rem">
          ${(cd.landingPageAnalysis.recommendations || []).map((r) => html`<li>${r}</li>`)}
        </ul>
      <//>` : null}

    <!-- ------------------------------------------------------- approvals -->
    <${Card} title="Review and approval">
      <div class="row" style="margin-bottom:1rem">
        ${['IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'ARCHIVED'].map((s) => html`
          <button disabled=${busy || deployed || proposal.status === s}
                  class=${s === 'APPROVED' ? 'btn-good' : ''} onClick=${() => setStatusTo(s)}>
            ${busy === s ? html`<span class="spin"></span>` : null} Mark ${titleise(s)}
          </button>`)}
      </div>

      ${(proposal.comments || []).map((c) => html`
        <div class="comment">
          <div class="meta">${c.author} · ${when(c.createdAt)}</div>
          <div>${c.text}</div>
        </div>`)}
      ${!(proposal.comments || []).length ? html`<div style="color:var(--dim);margin-bottom:.8rem">No discussion yet.</div>` : null}

      <form onSubmit=${addComment}>
        <div class="field">
          <label>Add a comment</label>
          <textarea value=${comment} onInput=${(e) => setComment(e.target.value)}
                    placeholder="Tighten ad group 2 to exact match only…"></textarea>
        </div>
        <div class="row end">
          <button class="btn-primary" disabled=${!comment.trim() || busy === 'comment'}>Post comment</button>
        </div>
      </form>
    <//>`;
}

// ===========================================================================
// Client-facing proposal (print / PDF)
// ===========================================================================

function ClientProposal({ activeProposalId, setView, openProposal }) {
  const [proposal, setProposal] = useState(null);

  useEffect(() => {
    if (activeProposalId) api.get(`/api/proposals/${activeProposalId}`).then((d) => setProposal(d.proposal));
  }, [activeProposalId]);

  if (!proposal) return html`<${Spinner} label="Loading proposal…" />`;

  const cd = proposal.campaignData || {};
  const est = cd.costEstimation || {};
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return html`
    <div class="row no-print" style="margin-bottom:1rem">
      <button onClick=${() => openProposal(proposal.id, 'proposal')}>← Back to internal view</button>
      <div class="spacer"></div>
      <span style="color:var(--dim);font-size:.82rem">Match types are hidden in this view</span>
      <button class="btn-primary" onClick=${() => window.print()}>Print / Save as PDF</button>
    </div>

    <div class="proposal-doc">
      <h1>Paid Search Proposal</h1>
      <p class="lede">Prepared for <strong>${cd.businessName || proposal.clientName}</strong> · ${today}</p>

      <h2>Overview</h2>
      <p>${cd.strategySummary || 'A structured Google Search campaign built around your highest-intent customer searches.'}</p>
      <div class="box">
        <div class="stat-row">
          <div><div class="n">${money(cd.monthlyBudget)}</div><div class="l">Monthly media budget</div></div>
          <div><div class="n">${num(est.estimatedMonthlyClicks)}</div><div class="l">Estimated visits / month</div></div>
          <div><div class="n">${num(est.estimatedConversions)}</div><div class="l">Estimated enquiries / month</div></div>
          <div><div class="n">${est.estimatedCPA ? money2(est.estimatedCPA) : '—'}</div><div class="l">Estimated cost per enquiry</div></div>
        </div>
      </div>
      <p style="font-size:12.5px;color:#64748b">
        Estimates are modelled on ${cd.sector || 'sector'} benchmarks and the auction as it stands today. Actual results depend
        on competition, seasonality and how quickly enquiries are followed up.
      </p>

      <h2>Campaign structure</h2>
      <p>Your budget is split across ${(cd.adGroups || []).length} tightly themed groups, so each advert matches
         exactly what the person searched for.</p>
      ${(cd.adGroups || []).map((g) => html`
        <h3>${g.name}</h3>
        <p style="color:#475569;margin-top:0">${g.theme || ''}</p>
        <div>${g.keywords.map((k) => html`<span class="kw">${splitKeyword(k).text}</span>`)}</div>`)}

      <h2>What your adverts will say</h2>
      ${(cd.adGroups || []).filter((g) => g.ads?.headlines?.length).slice(0, 3).map((g) => html`
        <h3>${g.name}</h3>
        <div class="box">
          ${(g.ads.headlines || []).slice(0, 6).map((hl) => html`<div style="font-weight:600;color:#1d4ed8">${hl}</div>`)}
          ${(g.ads.descriptions || []).map((d) => html`<div style="color:#334155;margin-top:.35rem">${d}</div>`)}
        </div>`)}

      <h2>Extensions</h2>
      <table>
        <tbody>
          ${(cd.adAssets?.sitelinks || []).map((s) => html`
            <tr><td style="font-weight:600;width:30%">${s.title}</td><td>${[s.desc1, s.desc2].filter(Boolean).join(' — ')}</td></tr>`)}
        </tbody>
      </table>
      <p style="margin-top:.75rem"><strong>Highlights:</strong> ${(cd.adAssets?.callouts || []).join(' · ')}</p>
      ${cd.adAssets?.structuredSnippets?.values?.length
        ? html`<p><strong>${cd.adAssets.structuredSnippets.header}:</strong> ${cd.adAssets.structuredSnippets.values.join(' · ')}</p>`
        : null}

      <h2>Protecting your budget</h2>
      <p>We block ${Object.values(cd.negativeKeywordVault || {}).flat().length} irrelevant search terms from day one —
         job seekers, students, bargain hunters and unrelated queries — so your money only goes to people who can actually buy.</p>

      ${cd.landingPageAnalysis?.recommendations?.length ? html`
        <h2>Landing page recommendations</h2>
        <ul>${cd.landingPageAnalysis.recommendations.map((r) => html`<li>${r}</li>`)}</ul>` : null}

      <div class="foot">
        Smart 1 Ads · Proposal reference ${proposal.id} · Prepared ${today}<br />
        Figures are good-faith estimates, not guarantees of performance.
      </div>
    </div>`;
}

// ===========================================================================
// Audit log
// ===========================================================================

function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/api/audit-logs?limit=500')
      .then((d) => setLogs(d.logs || []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const filtered = logs.filter((l) =>
    !filter || `${l.action} ${l.user} ${JSON.stringify(l.details)}`.toLowerCase().includes(filter.toLowerCase()));

  return html`
    <div class="page-head">
      <div><h1>Audit log</h1><p>Every generation, status change, deployment and sync</p></div>
      <div class="row">
        <input style="width:220px" placeholder="Filter…" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        <button onClick=${load}>↻ Refresh</button>
      </div>
    </div>

    <${Notice} tone="info">
      Logs live on the server's local disk. Render wipes that disk on every deploy and restart — attach a Render Disk
      or point this at a database when you need a permanent trail.
    <//>

    <${Card}>
      ${loading ? html`<${Spinner} />` : null}
      ${!loading && !filtered.length ? html`<${Empty} title="Nothing logged yet"><//>` : null}
      ${filtered.length ? html`
        <table>
          <thead><tr><th>When</th><th>Action</th><th>User</th><th>Details</th></tr></thead>
          <tbody>
            ${filtered.map((l) => html`
              <tr>
                <td style="white-space:nowrap;color:var(--muted)">${when(l.timestamp)}</td>
                <td><${Badge} tone=${l.action.includes('ERROR') || l.action.includes('FAILED') ? 'bad'
                    : l.action.includes('DEPLOY') ? 'info' : 'mute'}>${l.action}<//></td>
                <td>${l.user}</td>
                <td class="mono wrap-anywhere" style="color:var(--dim)">${JSON.stringify(l.details)}</td>
              </tr>`)}
          </tbody>
        </table>` : null}
    <//>`;
}

// ===========================================================================
// Settings
// ===========================================================================

function Settings({ status, refreshStatus, notify, user, setUser }) {
  const [team, setTeam] = useState(null);
  const [teamError, setTeamError] = useState('');
  const g = status?.google;

  async function syncTeam() {
    setTeamError('');
    try {
      const d = await api.get('/api/smart1-team/records');
      setTeam(d.records || []);
      if (d.source === 'NOT_CONFIGURED') setTeamError(d.note);
    } catch (err) {
      setTeamError(err.message);
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Google Ads from this app?')) return;
    await api.post('/api/google/disconnect');
    await refreshStatus();
    notify('good', 'Disconnected. Remember to clear GOOGLE_REFRESH_TOKEN in Render too.');
  }

  return html`
    <div class="page-head"><div><h1>Settings</h1><p>Connections and configuration</p></div></div>

    <${Card} title="Your name" sub="stamped on audit entries and comments">
      <div class="row">
        <input style="max-width:280px" value=${user} placeholder="Todd"
               onInput=${(e) => { setUser(e.target.value); localStorage.setItem(USER_KEY, e.target.value); }} />
      </div>
    <//>

    <${Card} title="Google Ads"
      actions=${g?.connected
        ? html`<button class="btn-danger btn-sm" onClick=${disconnect}>Disconnect</button>`
        : html`<a class="btn btn-primary" href="/auth/google">Connect Google Ads</a>`}>
      ${!g ? html`<${Spinner} />` : html`
        <div class="grid cols-3" style="margin-bottom:.8rem">
          <${Stat} label="Credentials" value=${g.configured ? 'Configured' : 'Incomplete'}
                   foot=${g.missing.length ? `Missing: ${g.missing.join(', ')}` : 'All keys present'} />
          <${Stat} label="Authorisation" value=${g.connected ? 'Connected' : 'Not connected'} foot=${g.refreshTokenSource} />
          <${Stat} label="API version" value=${g.apiVersion} foot=${g.loginCustomerId ? `MCC ${g.loginCustomerId}` : 'No login-customer-id set'} />
        </div>
        ${g.missing.length ? html`
          <${Notice} tone="bad" title="Missing environment variables">
            Set these in Render → Environment, then redeploy: <span class="mono">${g.missing.join(', ')}</span>
          <//>` : null}
        ${g.connected && g.refreshTokenSource?.startsWith('local file') ? html`
          <${Notice} tone="warn" title="This connection will not survive a restart">
            The refresh token is only on the server's local disk. Copy it into Render as
            <span class="mono">GOOGLE_REFRESH_TOKEN</span> — reconnect to see the value again.
          <//>` : null}
        <div class="hint">
          Redirect URI in use: <span class="mono">${g.redirectUri || 'not set'}</span> — this must match Google Cloud Console exactly.
        </div>`}
    <//>

    <${Card} title="Smart 1 Team (Knack)" actions=${html`<button class="btn-sm" onClick=${syncTeam}>Sync now</button>`}>
      ${status?.smart1Team?.configured
        ? html`<${Badge} tone="good">Configured<//>`
        : html`<${Badge} tone="warn">Not configured<//>`}
      ${teamError ? html`<div style="margin-top:.6rem"><${Notice} tone="warn">${teamError}<//></div>` : null}
      ${team?.length ? html`
        <table style="margin-top:.8rem">
          <thead><tr><th>Client</th><th class="num">Monthly budget</th><th>Google account</th></tr></thead>
          <tbody>${team.map((r) => html`
            <tr><td>${r.clientName}</td><td class="num">${money(r.monthlyBudget)}</td>
                <td class="mono">${r.googleCustomerId || '—'}</td></tr>`)}
          </tbody>
        </table>` : null}
      <div class="hint" style="margin-top:.6rem">
        Set <span class="mono">SMART1_TEAM_OBJECT</span> to your Knack object id, and optionally
        <span class="mono">SMART1_TEAM_FIELD_NAME</span> / <span class="mono">_BUDGET</span> /
        <span class="mono">_CUSTOMER_ID</span> to pin exact fields.
      </div>
    <//>

    <${Card} title="OpenAI">
      ${status?.openai?.configured
        ? html`<${Badge} tone="good">Configured<//> <span style="color:var(--muted);margin-left:.5rem">${status.openai.model}</span>`
        : html`<${Badge} tone="warn">No server key — paste one per generation in the wizard<//>`}
    <//>

    <${Card} title="Microsoft Advertising (Bing)">
      <${Badge} tone="mute">Phase 2<//>
      <p style="color:var(--muted);margin-bottom:0">
        Google Ads is live end to end. Bing shares the same proposal format, so adding it is a new client module
        plus a deploy path — the generator, approval hub and proposal export need no changes.
      </p>
    <//>`;
}

render(html`<${App} />`, document.getElementById('root'));

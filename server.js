/**
 * Smart 1 Ads - server
 *
 * Google Ads first. Bing routes are stubbed and clearly marked so phase two
 * slots in without touching anything that already works.
 */
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const store = require('./lib/store');
const google = require('./lib/google-ads');
const knack = require('./lib/knack');
const { generateCampaign, analyseBudget, SECTOR_CPC } = require('./lib/campaign-ai');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 's1a_session';

// ---------------------------------------------------------------------------
// Access gate
// ---------------------------------------------------------------------------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function issueToken() {
  const payload = String(Date.now() + 1000 * 60 * 60 * 24 * 14); // 14 days
  return `${payload}.${sign(payload)}`;
}

function tokenValid(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return false;
  return Number(payload) > Date.now();
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true; // open mode
  return tokenValid(req.cookies?.[COOKIE]);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ success: false, error: 'Not signed in.', code: 'UNAUTHORISED' });
}

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ success: true, open: true });

  const supplied = String(req.body?.password || '');
  const a = Buffer.from(supplied.padEnd(64).slice(0, 64));
  const b = Buffer.from(APP_PASSWORD.padEnd(64).slice(0, 64));
  if (!crypto.timingSafeEqual(a, b) || supplied !== APP_PASSWORD) {
    store.logEvent('LOGIN_FAILED', 'Anonymous', { ip: req.ip });
    return res.status(401).json({ success: false, error: 'Incorrect password.' });
  }

  res.cookie(COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14
  });
  store.logEvent('LOGIN_SUCCESS', 'Team', { ip: req.ip });
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  res.json({
    success: true,
    authenticated: isAuthed(req),
    passwordRequired: Boolean(APP_PASSWORD),
    openMode: !APP_PASSWORD
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'HEALTHY', app: 'Smart 1 Ads', version: '2.0.0', timestamp: new Date() });
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    success: true,
    google: google.connectionStatus(),
    bing: { platform: 'bing', configured: false, connected: false, note: 'Phase 2 - not wired yet' },
    openai: { configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || 'gpt-4o-mini' },
    smart1Team: { configured: knack.isConfigured() },
    security: { passwordProtected: Boolean(APP_PASSWORD) },
    storage: { dir: store.DATA_DIR, ephemeral: true }
  });
});

// ---------------------------------------------------------------------------
// Google Ads OAuth
// ---------------------------------------------------------------------------

app.get('/auth/google', requireAuth, (req, res) => {
  const status = google.connectionStatus();
  if (status.missing.length) {
    return res
      .status(400)
      .send(oauthPage('Cannot start Google sign-in', `Missing environment variables: ${status.missing.join(', ')}`, false));
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('s1a_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600_000 });
  res.redirect(google.buildAuthUrl(state));
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    store.logEvent('GOOGLE_OAUTH_DENIED', 'Auth', { error });
    return res.status(400).send(oauthPage('Google sign-in cancelled', String(error), false));
  }
  if (!code) {
    return res.status(400).send(oauthPage('Google sign-in failed', 'No authorisation code came back from Google.', false));
  }
  if (req.cookies?.s1a_oauth_state && state !== req.cookies.s1a_oauth_state) {
    return res.status(400).send(oauthPage('Google sign-in failed', 'State mismatch - start the sign-in again from the dashboard.', false));
  }

  try {
    const tokens = await google.exchangeCodeForTokens(code);
    res.clearCookie('s1a_oauth_state');
    store.logEvent('GOOGLE_OAUTH_SUCCESS', 'Auth', { hasRefreshToken: Boolean(tokens.refresh_token) });

    const refresh = tokens.refresh_token;
    const extra = refresh
      ? `<p style="color:#94a3b8;margin-top:1.5rem">Paste this into Render as <code style="color:#38bdf8">GOOGLE_REFRESH_TOKEN</code> so the connection survives restarts:</p>
         <textarea readonly onclick="this.select()" style="width:100%;height:5rem;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:.5rem;padding:.75rem;font-family:monospace;font-size:.8rem">${escapeHtml(refresh)}</textarea>`
      : `<p style="color:#fbbf24;margin-top:1.5rem">Google did not return a refresh token. That normally means this Google account already granted access. Revoke it at myaccount.google.com/permissions and connect again.</p>`;

    res.send(oauthPage('Google Ads connected', 'You can close this tab and return to the dashboard.', true, extra));
  } catch (err) {
    store.logEvent('GOOGLE_OAUTH_ERROR', 'Auth', { error: err.message });
    res.status(500).send(oauthPage('Google sign-in failed', err.message, false));
  }
});

app.post('/api/google/disconnect', requireAuth, (req, res) => {
  store.setTokens({ google_refresh_token: '', google_access_token: '', google_expires_at: 0 });
  store.logEvent('GOOGLE_DISCONNECTED', 'Team', {});
  res.json({ success: true, note: 'Also clear GOOGLE_REFRESH_TOKEN in your environment if it is set there.' });
});

// ---------------------------------------------------------------------------
// Google Ads reads
// ---------------------------------------------------------------------------

app.get('/api/google/accounts', requireAuth, async (req, res, next) => {
  try {
    res.json({ success: true, accounts: await google.listClientAccounts() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/google/campaigns', requireAuth, async (req, res, next) => {
  try {
    const { customerId, dateRange } = req.query;
    if (!customerId) {
      return res.status(400).json({ success: false, error: 'customerId is required.' });
    }
    const campaigns = await google.listCampaigns(customerId, { dateRange: safeDateRange(dateRange) });
    res.json({ success: true, customerId: google.digits(customerId), campaigns });
  } catch (err) {
    next(err);
  }
});

app.get('/api/google/campaigns/:campaignId', requireAuth, async (req, res, next) => {
  try {
    const { customerId } = req.query;
    if (!customerId) {
      return res.status(400).json({ success: false, error: 'customerId is required.' });
    }
    res.json({
      success: true,
      detail: await google.getCampaignDetail(customerId, req.params.campaignId)
    });
  } catch (err) {
    next(err);
  }
});

const DATE_RANGES = new Set([
  'TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS',
  'THIS_MONTH', 'LAST_MONTH', 'LAST_90_DAYS'
]);
const safeDateRange = (v) => (DATE_RANGES.has(String(v)) ? String(v) : 'LAST_30_DAYS');

// ---------------------------------------------------------------------------
// Google Ads writes
// ---------------------------------------------------------------------------

app.post('/api/google/campaigns/:campaignId/status', requireAuth, async (req, res, next) => {
  try {
    const { customerId, status } = req.body || {};
    if (!customerId || !status) {
      return res.status(400).json({ success: false, error: 'customerId and status are required.' });
    }
    await google.setCampaignStatus(customerId, req.params.campaignId, status);
    store.logEvent('GOOGLE_CAMPAIGN_STATUS_CHANGE', req.body.user || 'Team', {
      customerId: google.digits(customerId),
      campaignId: req.params.campaignId,
      status: String(status).toUpperCase()
    });
    res.json({ success: true, campaignId: req.params.campaignId, status: String(status).toUpperCase() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/google/deploy', requireAuth, async (req, res, next) => {
  try {
    const { proposalId, customerId, campaignName, searchPartners, validateOnly, user } = req.body || {};
    const proposal = store.getProposal(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found.' });
    }
    if (!validateOnly && proposal.status !== 'APPROVED') {
      return res.status(400).json({
        success: false,
        error: 'Only approved proposals can be deployed. Approve it in the Approval Hub first.'
      });
    }
    if (!customerId) {
      return res.status(400).json({ success: false, error: 'Pick a Google Ads account first.' });
    }

    const result = await google.deployProposal(customerId, proposal.campaignData, {
      campaignName,
      searchPartners: Boolean(searchPartners),
      validateOnly: Boolean(validateOnly)
    });

    if (!validateOnly) {
      proposal.status = 'DEPLOYED';
      proposal.deployment = { ...result, deployedAt: new Date().toISOString(), deployedBy: user || 'Team' };
      proposal.updatedAt = new Date().toISOString();
      store.saveProposal(proposal);
      store.logEvent('GOOGLE_CAMPAIGN_DEPLOYED', user || 'Team', {
        proposalId,
        customerId: result.customerId,
        campaignId: result.campaignId,
        campaignName: result.campaignName,
        adGroups: result.adGroupCount,
        keywords: result.keywordCount
      });
    } else {
      store.logEvent('GOOGLE_DEPLOY_DRY_RUN', user || 'Team', { proposalId, operations: result.operationCount });
    }

    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// AI campaign generation + proposals
// ---------------------------------------------------------------------------

app.get('/api/sectors', requireAuth, (req, res) => {
  res.json({
    success: true,
    sectors: Object.entries(SECTOR_CPC).map(([key, v]) => ({ key, ...v }))
  });
});

app.get('/api/budget-check', requireAuth, (req, res) => {
  res.json({ success: true, analysis: analyseBudget(req.query.budget, req.query.sector) });
});

app.post('/api/generate-campaign', requireAuth, async (req, res, next) => {
  const { businessName, websiteUrl, objective, budget } = req.body || {};
  if (!businessName || !websiteUrl || !budget) {
    return res
      .status(400)
      .json({ success: false, error: 'businessName, websiteUrl and budget are required.' });
  }

  try {
    store.logEvent('CAMPAIGN_GENERATION_START', req.body.user || 'Team', { businessName, budget });

    const campaignData = await generateCampaign(
      { businessName, websiteUrl, objective, budget, sector: req.body.sector,
        targetAudience: req.body.targetAudience, geography: req.body.geography, notes: req.body.notes },
      { apiKey: req.body.customApiKey }
    );

    const proposal = {
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: req.body.user || 'Team',
      status: 'DRAFT',
      clientName: businessName,
      googleCustomerId: req.body.googleCustomerId || '',
      comments: [],
      campaignData
    };
    store.saveProposal(proposal);

    store.logEvent('CAMPAIGN_GENERATION_SUCCESS', req.body.user || 'Team', {
      proposalId: proposal.id,
      businessName,
      adGroups: campaignData.adGroups.length,
      keywords: campaignData.adGroups.reduce((n, g) => n + g.keywords.length, 0)
    });

    res.json({ success: true, proposal });
  } catch (err) {
    store.logEvent('CAMPAIGN_GENERATION_ERROR', req.body.user || 'Team', { error: err.message });
    next(err);
  }
});

app.get('/api/proposals', requireAuth, (req, res) => {
  res.json({ success: true, proposals: store.listProposals() });
});

app.get('/api/proposals/:id', requireAuth, (req, res) => {
  const proposal = store.getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });
  res.json({ success: true, proposal });
});

app.put('/api/proposals/:id', requireAuth, (req, res) => {
  const proposal = store.getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });

  if (proposal.status === 'DEPLOYED') {
    return res.status(400).json({ success: false, error: 'A deployed proposal cannot be edited.' });
  }

  const next = {
    ...proposal,
    campaignData: req.body.campaignData || proposal.campaignData,
    clientName: req.body.clientName ?? proposal.clientName,
    googleCustomerId: req.body.googleCustomerId ?? proposal.googleCustomerId,
    updatedAt: new Date().toISOString()
  };
  store.saveProposal(next);
  store.logEvent('PROPOSAL_EDITED', req.body.user || 'Team', { proposalId: next.id });
  res.json({ success: true, proposal: next });
});

const PROPOSAL_STATUSES = new Set(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'DEPLOYED', 'ARCHIVED']);

app.post('/api/proposals/:id/status', requireAuth, (req, res) => {
  const proposal = store.getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });

  const status = String(req.body?.status || '').toUpperCase();
  if (!PROPOSAL_STATUSES.has(status)) {
    return res.status(400).json({ success: false, error: `Invalid status "${status}".` });
  }

  const from = proposal.status;
  proposal.status = status;
  proposal.updatedAt = new Date().toISOString();
  store.saveProposal(proposal);
  store.logEvent('PROPOSAL_STATUS_CHANGE', req.body.user || 'Team', { proposalId: proposal.id, from, to: status });
  res.json({ success: true, proposal });
});

app.post('/api/proposals/:id/comments', requireAuth, (req, res) => {
  const proposal = store.getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });

  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Comment text is required.' });

  const comment = {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    author: req.body.author || 'Team',
    text: text.slice(0, 4000),
    createdAt: new Date().toISOString()
  };
  proposal.comments = [...(proposal.comments || []), comment];
  proposal.updatedAt = comment.createdAt;
  store.saveProposal(proposal);
  store.logEvent('PROPOSAL_COMMENT', comment.author, { proposalId: proposal.id });
  res.json({ success: true, comment, proposal });
});

app.delete('/api/proposals/:id', requireAuth, (req, res) => {
  const removed = store.deleteProposal(req.params.id);
  if (!removed) return res.status(404).json({ success: false, error: 'Proposal not found.' });
  store.logEvent('PROPOSAL_DELETED', 'Team', { proposalId: req.params.id });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Smart 1 Team (Knack)
// ---------------------------------------------------------------------------

app.get('/api/smart1-team/records', requireAuth, async (req, res, next) => {
  try {
    const records = await knack.fetchRecords();
    store.logEvent('SMART1_TEAM_SYNC', 'Team', { count: records.length });
    res.json({ success: true, source: 'SMART1_TEAM_API', records });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return res.json({ success: true, source: 'NOT_CONFIGURED', records: [], note: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

app.get('/api/audit-logs', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 250, 1000);
  res.json({ success: true, logs: store.getAudit(limit) });
});

app.post('/api/audit-logs', requireAuth, (req, res) => {
  const { action, user, details } = req.body || {};
  res.json({ success: true, log: store.logEvent(action || 'GENERAL_ACTION', user, details) });
});

// ---------------------------------------------------------------------------
// Bing / Microsoft Advertising - PHASE 2 STUBS
// ---------------------------------------------------------------------------

app.get('/auth/bing/callback', (req, res) => {
  res.send(
    oauthPage(
      'Bing Ads is not wired up yet',
      'Microsoft Advertising is phase two. Google Ads is live and working.',
      false
    )
  );
});

app.all('/api/bing/*', requireAuth, (req, res) => {
  res.status(501).json({
    success: false,
    error: 'Microsoft Advertising (Bing) is not implemented yet. Google Ads is live.',
    code: 'NOT_IMPLEMENTED'
  });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

// Vendored ESM libs served straight from node_modules - no build step, and no
// dependency on a public CDN staying reachable.
app.use('/vendor/preact', express.static(path.join(__dirname, 'node_modules/preact')));
app.use('/vendor/htm', express.static(path.join(__dirname, 'node_modules/htm')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: `No such endpoint: ${req.path}` });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use((err, req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  res.status(status).json({
    success: false,
    error: err.message || 'Something went wrong.',
    code: err.code,
    googleErrorCode: err.googleErrorCode,
    field: err.googleFieldPath,
    trigger: err.googleTrigger
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function oauthPage(title, message, ok, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem">
  <div style="max-width:44rem;width:100%;background:#1e293b;border:1px solid #334155;border-radius:1rem;padding:2rem">
    <h2 style="margin:0 0 .5rem;color:${ok ? '#38bdf8' : '#f87171'}">${escapeHtml(title)}</h2>
    <p style="color:#94a3b8;margin:0">${escapeHtml(message)}</p>
    ${extra}
    <p style="margin-top:1.5rem"><a href="/" style="color:#38bdf8">Back to the dashboard</a></p>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Smart 1 Ads running on port ${PORT}`);
    if (!APP_PASSWORD) {
      console.warn('WARNING: APP_PASSWORD is not set. The dashboard is open to anyone with the URL.');
    }
    store.logEvent('SERVER_STARTUP', 'System', { port: PORT, env: process.env.NODE_ENV || 'development' });
  });
}

module.exports = app;

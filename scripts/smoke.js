/**
 * Smoke test - boots the server with a temp data dir and exercises every
 * route that does not need live third-party credentials.
 *
 *   npm run smoke
 */
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'smoketest';
process.env.SESSION_SECRET = 'smoke-secret';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `s1a_smoke_${Date.now()}`);
process.env.PORT = process.env.SMOKE_PORT || '4123';

const app = require('../server');

let pass = 0;
let fail = 0;
let cookie = '';

function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function req(method, path, body, useCookie = true) {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(useCookie && cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && setCookie.includes('s1a_session')) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

(async () => {
  const server = app.listen(process.env.PORT);
  await new Promise((r) => server.once('listening', r));
  console.log(`\nSmart 1 Ads smoke test (port ${process.env.PORT})\n`);

  // -- health & auth --------------------------------------------------------
  let r = await req('GET', '/health');
  check('GET /health returns HEALTHY', r.status === 200 && r.json?.status === 'HEALTHY');

  r = await req('GET', '/api/status', null, false);
  check('GET /api/status is gated when signed out', r.status === 401, `got ${r.status}`);

  r = await req('POST', '/api/login', { password: 'wrong-password' });
  check('POST /api/login rejects a bad password', r.status === 401);

  r = await req('POST', '/api/login', { password: process.env.APP_PASSWORD });
  check('POST /api/login accepts the right password', r.status === 200 && Boolean(cookie));

  r = await req('GET', '/api/session');
  check('GET /api/session reports authenticated', r.json?.authenticated === true);

  r = await req('GET', '/api/status');
  check('GET /api/status works when signed in', r.status === 200 && r.json?.google !== undefined);
  check('status reports google not connected', r.json?.google?.connected === false);
  check('status reports password protection on', r.json?.security?.passwordProtected === true);

  // -- budget engine --------------------------------------------------------
  r = await req('GET', '/api/sectors');
  check('GET /api/sectors lists sectors', Array.isArray(r.json?.sectors) && r.json.sectors.length > 5);

  r = await req('GET', '/api/budget-check?budget=500&sector=legal');
  check('$500/mo in legal is CRITICAL', r.json?.analysis?.status === 'CRITICAL', r.json?.analysis?.status);

  r = await req('GET', '/api/budget-check?budget=25000&sector=homeservices');
  check('$25k/mo in home services is HEALTHY', r.json?.analysis?.status === 'HEALTHY', r.json?.analysis?.status);

  r = await req('GET', '/api/budget-check?budget=1500&sector=b2bsaas');
  check('$1.5k/mo in B2B SaaS warns', r.json?.analysis?.status === 'WARN', r.json?.analysis?.status);

  // -- proposals lifecycle (no AI needed - inject one directly) --------------
  const store = require('../lib/store');
  const proposal = {
    id: 'prop_smoke_1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'DRAFT',
    clientName: 'Smoke Test Roofing',
    comments: [],
    campaignData: {
      businessName: 'Smoke Test Roofing',
      websiteUrl: 'https://example.com',
      monthlyBudget: 4000,
      adGroups: [{ name: 'Roof Repair', theme: 'urgent repair', avgCPC: 8,
        keywords: ['[roof repair]', '"emergency roof repair"', 'roofer near me'],
        ads: { headlines: ['Fast Roof Repair', 'Free Roof Estimate', '24/7 Storm Response'],
               descriptions: ['Licensed local roofers. Free estimates, same-day callouts.',
                              'Storm damage specialists with a 10 year workmanship warranty.'] } }],
      adAssets: { sitelinks: [{ title: 'Free Estimate', desc1: 'No obligation', desc2: 'Same day', url: 'https://example.com/quote' }],
                  callouts: ['Licensed & Insured'], structuredSnippets: { header: 'Services', values: ['Repair', 'Replace', 'Inspect'] } },
      negativeKeywordVault: { freeCheap: ['free'], jobsCareers: ['jobs'], educational: ['how to'], irrelevant: ['login'] }
    }
  };
  store.saveProposal(proposal);

  r = await req('GET', '/api/proposals');
  check('GET /api/proposals lists the proposal', r.json?.proposals?.some((p) => p.id === 'prop_smoke_1'));

  r = await req('POST', '/api/proposals/prop_smoke_1/comments', { text: 'Tighten ad group 1.', author: 'Todd' });
  check('POST comment attaches to the proposal', r.json?.proposal?.comments?.length === 1);

  r = await req('POST', '/api/proposals/prop_smoke_1/status', { status: 'NONSENSE' });
  check('POST invalid status is rejected', r.status === 400);

  r = await req('POST', '/api/proposals/prop_smoke_1/status', { status: 'APPROVED' });
  check('POST valid status is applied', r.json?.proposal?.status === 'APPROVED');

  r = await req('POST', '/api/google/deploy', { proposalId: 'prop_smoke_1' });
  check('deploy without a customerId is rejected', r.status === 400, r.json?.error);

  r = await req('POST', '/api/google/deploy', { proposalId: 'nope', customerId: '1234567890' });
  check('deploy of a missing proposal 404s', r.status === 404);

  r = await req('POST', '/api/google/deploy', { proposalId: 'prop_smoke_1', customerId: '1234567890' });
  check('deploy without a Google connection fails cleanly', r.status >= 400 && /not connected|Missing required/i.test(r.json?.error || ''), r.json?.error);

  // -- google routes are guarded, not crashing ------------------------------
  r = await req('GET', '/api/google/campaigns');
  check('campaigns without customerId is a 400', r.status === 400);

  r = await req('GET', '/api/google/accounts');
  check('accounts without a connection fails cleanly', r.status >= 400 && Boolean(r.json?.error));

  // -- keyword parsing ------------------------------------------------------
  const { parseKeyword, normaliseUrl, formatCustomerId } = require('../lib/google-ads');
  check('[bracket] parses as EXACT', parseKeyword('[roof repair]').matchType === 'EXACT');
  check('"quoted" parses as PHRASE', parseKeyword('"roof repair"').matchType === 'PHRASE');
  check('(broad) tag parses as BROAD', parseKeyword('roof repair (broad)').matchType === 'BROAD');
  check('bare term defaults to PHRASE', parseKeyword('roof repair').matchType === 'PHRASE');
  check('normaliseUrl adds https', normaliseUrl('example.com/a') === 'https://example.com/a');
  check('normaliseUrl rejects junk', normaliseUrl('not a url at all') === '');
  check('formatCustomerId dashes the id', formatCustomerId('1234567890') === '123-456-7890');

  // -- audit ----------------------------------------------------------------
  r = await req('GET', '/api/audit-logs');
  check('audit log captured events', (r.json?.logs || []).length > 0);
  check('audit log recorded the failed login', (r.json?.logs || []).some((l) => l.action === 'LOGIN_FAILED'));
  check('audit log recorded the status change', (r.json?.logs || []).some((l) => l.action === 'PROPOSAL_STATUS_CHANGE'));

  // -- bing stubs -----------------------------------------------------------
  r = await req('GET', '/api/bing/campaigns');
  check('bing endpoints return 501 not implemented', r.status === 501);

  // -- static frontend ------------------------------------------------------
  r = await req('GET', '/');
  check('GET / serves the dashboard shell', r.status === 200 && r.text.includes('Smart 1 Ads'));
  check('index.html declares the import map', r.text.includes('importmap'));

  for (const asset of ['/app.js', '/ui.js', '/styles.css',
                       '/vendor/preact/dist/preact.module.js',
                       '/vendor/preact/hooks/dist/hooks.module.js',
                       '/vendor/htm/dist/htm.module.js']) {
    const a = await req('GET', asset);
    check(`serves ${asset}`, a.status === 200 && a.text.length > 50, `status ${a.status}`);
  }

  r = await req('GET', '/api/does-not-exist');
  check('unknown API path 404s as JSON', r.status === 404 && r.json?.success === false);

  r = await req('DELETE', '/api/proposals/prop_smoke_1');
  check('DELETE proposal works', r.json?.success === true);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});

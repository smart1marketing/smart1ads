/**
 * Google Ads integration.
 *
 * Talks to the Google Ads API over REST (no heavyweight SDK), so the API
 * version is a single env var you can bump without a dependency upgrade.
 *
 *   Base URL : https://googleads.googleapis.com/<version>
 *   Headers  : Authorization: Bearer <access token>
 *              developer-token: <your approved dev token>
 *              login-customer-id: <manager/MCC id, digits only>
 *
 * Everything this module writes is created PAUSED. Nothing here can start
 * spending money without someone enabling it in the Google Ads UI or via the
 * explicit enable action in the dashboard.
 */
const axios = require('axios');
const store = require('./store');

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

const cfg = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  developerToken: process.env.GOOGLE_DEVELOPER_TOKEN || '',
  loginCustomerId: digits(process.env.GOOGLE_LOGIN_CUSTOMER_ID || ''),
  redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  version: process.env.GOOGLE_ADS_API_VERSION || 'v25'
});

const base = () => `https://googleads.googleapis.com/${cfg().version}`;

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function formatCustomerId(id) {
  const d = digits(id);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function buildAuthUrl(state) {
  const c = cfg();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: ADS_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    // force consent so Google always returns a refresh_token, even on re-auth
    prompt: 'consent',
    state: state || ''
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const c = cfg();
  const { data } = await axios.post(
    OAUTH_TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: 'authorization_code'
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const patch = {
    google_access_token: data.access_token,
    google_expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 60_000
  };
  if (data.refresh_token) patch.google_refresh_token = data.refresh_token;
  store.setTokens(patch);

  return data;
}

function currentRefreshToken() {
  // Env var wins: it is the one that survives a Render restart.
  return process.env.GOOGLE_REFRESH_TOKEN || store.getTokens().google_refresh_token || '';
}

async function getAccessToken() {
  const t = store.getTokens();
  if (t.google_access_token && t.google_expires_at && Date.now() < t.google_expires_at) {
    return t.google_access_token;
  }

  const refreshToken = currentRefreshToken();
  if (!refreshToken) {
    const err = new Error(
      'Google Ads is not connected. Open Settings and click "Connect Google Ads", ' +
        'or set GOOGLE_REFRESH_TOKEN in your environment.'
    );
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const c = cfg();
  const { data } = await axios.post(
    OAUTH_TOKEN_URL,
    new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  store.setTokens({
    google_access_token: data.access_token,
    google_expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 60_000
  });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Low level request helper
// ---------------------------------------------------------------------------

function assertConfigured() {
  const c = cfg();
  const missing = [];
  if (!c.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!c.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!c.developerToken) missing.push('GOOGLE_DEVELOPER_TOKEN');
  if (missing.length) {
    const err = new Error(`Missing required environment variables: ${missing.join(', ')}`);
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
}

/** Turn a Google Ads API error payload into something a human can act on. */
function normaliseError(err) {
  const payload = err.response?.data;
  const gerr = payload?.error;
  const detail = gerr?.details?.[0]?.errors?.[0];

  const out = new Error(
    detail?.message || gerr?.message || err.message || 'Unknown Google Ads API error'
  );
  out.status = err.response?.status || 500;
  out.googleErrorCode = detail?.errorCode ? Object.values(detail.errorCode)[0] : undefined;
  out.googleTrigger = detail?.trigger?.stringValue;
  out.googleFieldPath = detail?.location?.fieldPathElements
    ?.map((f) => f.fieldName)
    .join('.');
  out.raw = payload;

  if (out.status === 401) {
    out.message = `${out.message} (access token rejected - try reconnecting Google Ads)`;
  }
  if (/DEVELOPER_TOKEN/i.test(out.googleErrorCode || '')) {
    out.message = `${out.message} - check GOOGLE_DEVELOPER_TOKEN and that the token has access to this account.`;
  }
  return out;
}

async function request(method, url, body, { customerId, loginCustomerId } = {}) {
  assertConfigured();
  const c = cfg();
  const token = await getAccessToken();

  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': c.developerToken,
    'Content-Type': 'application/json'
  };

  // login-customer-id is required whenever you operate on a client account
  // through a manager account.
  const login = digits(loginCustomerId || c.loginCustomerId);
  if (login) headers['login-customer-id'] = login;

  try {
    const { data } = await axios({
      method,
      url: `${base()}${url}`,
      data: body,
      headers,
      timeout: 60_000
    });
    return data;
  } catch (err) {
    throw normaliseError(err);
  }
}

/** Run a GAQL query and return the flattened result rows. */
async function search(customerId, query, { loginCustomerId, pageSize = 1000 } = {}) {
  const cid = digits(customerId);
  const rows = [];
  let pageToken;

  do {
    const data = await request(
      'post',
      `/customers/${cid}/googleAds:search`,
      { query, pageSize, ...(pageToken ? { pageToken } : {}) },
      { customerId: cid, loginCustomerId }
    );
    rows.push(...(data.results || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return rows;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function listAccessibleCustomers() {
  const data = await request('get', '/customers:listAccessibleCustomers');
  return (data.resourceNames || []).map((rn) => digits(rn.split('/')[1]));
}

/**
 * Expand the manager account into the full list of client accounts, so the
 * dashboard can show a real account picker instead of a raw id list.
 */
async function listClientAccounts() {
  const c = cfg();
  const roots = c.loginCustomerId ? [c.loginCustomerId] : await listAccessibleCustomers();
  const seen = new Map();

  for (const root of roots) {
    try {
      const rows = await search(
        root,
        `SELECT customer_client.id,
                customer_client.descriptive_name,
                customer_client.currency_code,
                customer_client.time_zone,
                customer_client.manager,
                customer_client.status,
                customer_client.level
         FROM customer_client
         WHERE customer_client.status = 'ENABLED'`,
        { loginCustomerId: root }
      );

      for (const r of rows) {
        const cc = r.customerClient || {};
        const id = digits(cc.id);
        if (!id || seen.has(id)) continue;
        seen.set(id, {
          id,
          formattedId: formatCustomerId(id),
          name: cc.descriptiveName || `Account ${formatCustomerId(id)}`,
          currency: cc.currencyCode || 'USD',
          timeZone: cc.timeZone || '',
          isManager: Boolean(cc.manager),
          level: Number(cc.level || 0),
          managerId: root
        });
      }
    } catch (err) {
      // A root we cannot query should not blank the whole picker.
      console.error(`[google-ads] could not expand ${root}:`, err.message);
      if (!seen.has(root)) {
        seen.set(root, {
          id: root,
          formattedId: formatCustomerId(root),
          name: `Account ${formatCustomerId(root)}`,
          currency: 'USD',
          timeZone: '',
          isManager: true,
          level: 0,
          managerId: root,
          error: err.message
        });
      }
    }
  }

  return [...seen.values()].sort((a, b) => {
    if (a.isManager !== b.isManager) return a.isManager ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

const micros = (v) => (v == null ? 0 : Number(v) / 1_000_000);

async function listCampaigns(customerId, { dateRange = 'LAST_30_DAYS' } = {}) {
  const rows = await search(
    customerId,
    `SELECT campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            campaign.bidding_strategy_type,
            campaign.start_date,
            campaign.end_date,
            campaign_budget.amount_micros,
            campaign_budget.id,
            metrics.cost_micros,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.average_cpc,
            metrics.conversions,
            metrics.cost_per_conversion
     FROM campaign
     WHERE campaign.status != 'REMOVED'
       AND segments.date DURING ${dateRange}
     ORDER BY metrics.cost_micros DESC`
  );

  // A campaign with no traffic in the window still needs to appear.
  const withoutMetrics = await search(
    customerId,
    `SELECT campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            campaign.bidding_strategy_type,
            campaign.start_date,
            campaign.end_date,
            campaign_budget.amount_micros,
            campaign_budget.id
     FROM campaign
     WHERE campaign.status != 'REMOVED'`
  );

  const byId = new Map();
  for (const r of withoutMetrics) {
    const c = r.campaign || {};
    byId.set(String(c.id), {
      platform: 'google',
      customerId: digits(customerId),
      id: String(c.id),
      name: c.name,
      status: c.status,
      channel: c.advertisingChannelType,
      biddingStrategy: c.biddingStrategyType,
      startDate: c.startDate,
      endDate: c.endDate,
      dailyBudget: micros(r.campaignBudget?.amountMicros),
      monthlyBudget: micros(r.campaignBudget?.amountMicros) * 30.4,
      cost: 0,
      impressions: 0,
      clicks: 0,
      ctr: 0,
      avgCpc: 0,
      conversions: 0,
      costPerConversion: 0
    });
  }

  for (const r of rows) {
    const id = String(r.campaign?.id);
    const entry = byId.get(id);
    if (!entry) continue;
    const m = r.metrics || {};
    entry.cost = micros(m.costMicros);
    entry.impressions = Number(m.impressions || 0);
    entry.clicks = Number(m.clicks || 0);
    entry.ctr = Number(m.ctr || 0);
    entry.avgCpc = micros(m.averageCpc);
    entry.conversions = Number(m.conversions || 0);
    entry.costPerConversion = micros(m.costPerConversion);
  }

  return [...byId.values()].sort((a, b) => b.cost - a.cost);
}

async function getCampaignDetail(customerId, campaignId) {
  const cid = digits(customerId);

  const adGroups = await search(
    cid,
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros
     FROM ad_group
     WHERE campaign.id = ${Number(campaignId)} AND ad_group.status != 'REMOVED'`
  );

  const keywords = await search(
    cid,
    `SELECT ad_group.id,
            ad_group_criterion.criterion_id,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group_criterion.status,
            ad_group_criterion.negative
     FROM keyword_view
     WHERE campaign.id = ${Number(campaignId)}
       AND ad_group_criterion.status != 'REMOVED'`
  );

  const groups = adGroups.map((r) => ({
    id: String(r.adGroup.id),
    name: r.adGroup.name,
    status: r.adGroup.status,
    cpcBid: micros(r.adGroup.cpcBidMicros),
    keywords: keywords
      .filter((k) => String(k.adGroup?.id) === String(r.adGroup.id))
      .map((k) => ({
        id: String(k.adGroupCriterion.criterionId),
        text: k.adGroupCriterion.keyword?.text,
        matchType: k.adGroupCriterion.keyword?.matchType,
        status: k.adGroupCriterion.status,
        negative: Boolean(k.adGroupCriterion.negative)
      }))
  }));

  return { campaignId: String(campaignId), customerId: cid, adGroups: groups };
}

// ---------------------------------------------------------------------------
// Status mutations
// ---------------------------------------------------------------------------

const ALLOWED_STATUS = new Set(['ENABLED', 'PAUSED', 'REMOVED']);

async function setCampaignStatus(customerId, campaignId, status) {
  const upper = String(status || '').toUpperCase();
  if (!ALLOWED_STATUS.has(upper)) {
    throw new Error(`Invalid campaign status "${status}". Use ENABLED, PAUSED or REMOVED.`);
  }
  const cid = digits(customerId);

  const operation =
    upper === 'REMOVED'
      ? { remove: `customers/${cid}/campaigns/${campaignId}` }
      : {
          update: { resourceName: `customers/${cid}/campaigns/${campaignId}`, status: upper },
          updateMask: 'status'
        };

  return request('post', `/customers/${cid}/campaigns:mutate`, { operations: [operation] }, {
    customerId: cid
  });
}

// ---------------------------------------------------------------------------
// Full campaign deployment
// ---------------------------------------------------------------------------

const clamp = (s, n) => String(s || '').trim().slice(0, n);
const toMicros = (dollars) => String(Math.round(Number(dollars || 0) * 1_000_000));

const MATCH_TYPES = { EXACT: 'EXACT', PHRASE: 'PHRASE', BROAD: 'BROAD' };

/** "[plumber near me]" -> EXACT, "\"emergency plumber\"" -> PHRASE, else BROAD */
function parseKeyword(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('[') && text.endsWith(']')) {
    return { text: text.slice(1, -1).trim(), matchType: MATCH_TYPES.EXACT };
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return { text: text.slice(1, -1).trim(), matchType: MATCH_TYPES.PHRASE };
  }
  const tagged = text.match(/^(.*?)\s*\((exact|phrase|broad)\)$/i);
  if (tagged) {
    return { text: tagged[1].trim(), matchType: MATCH_TYPES[tagged[2].toUpperCase()] };
  }
  return { text, matchType: MATCH_TYPES.PHRASE };
}

function todayStamp(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

/**
 * Build the RSA headline/description set. Google requires >= 3 headlines
 * (<=30 chars) and >= 2 descriptions (<=90 chars) per responsive search ad.
 */
function buildRsaAssets(proposal, group) {
  const brand = clamp(proposal.businessName, 30);
  const fromAi = (group.ads?.headlines || proposal.adCopy?.headlines || []).map((h) =>
    clamp(typeof h === 'string' ? h : h.text, 30)
  );
  const fromDesc = (group.ads?.descriptions || proposal.adCopy?.descriptions || []).map((d) =>
    clamp(typeof d === 'string' ? d : d.text, 90)
  );

  const headlines = [...new Set([...fromAi, brand, clamp(group.name, 30), 'Get A Free Quote Today'].filter(Boolean))];
  const descriptions = [
    ...new Set(
      [
        ...fromDesc,
        clamp(`${proposal.businessName} - ${group.theme || 'trusted local experts'}.`, 90),
        'Fast response, clear pricing and work you can rely on. Contact us today.'
      ].filter(Boolean)
    )
  ];

  return {
    headlines: headlines.slice(0, 15).map((text) => ({ text })),
    descriptions: descriptions.slice(0, 4).map((text) => ({ text }))
  };
}

/**
 * Push an approved proposal into Google Ads as one atomic mutate.
 *
 * Everything is created PAUSED. If any operation fails the whole request is
 * rolled back by Google, so you never end up with a half-built campaign.
 */
async function deployProposal(customerId, proposal, options = {}) {
  const cid = digits(customerId);
  if (!cid) throw new Error('A Google Ads customer id is required to deploy.');

  const finalUrl = normaliseUrl(proposal.websiteUrl);
  if (!finalUrl) throw new Error('The proposal needs a valid website URL before it can deploy.');

  const monthly = Number(proposal.monthlyBudget || proposal.budget || 0);
  if (!monthly || monthly <= 0) throw new Error('The proposal needs a monthly budget above zero.');
  const dailyBudget = monthly / 30.4;

  const adGroups = (proposal.adGroups || []).filter((g) => (g.keywords || []).length);
  if (!adGroups.length) throw new Error('The proposal has no ad groups with keywords.');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const campaignName = clamp(
    options.campaignName || `${proposal.businessName} | Search | ${stamp}`,
    255
  );

  let tempId = -1;
  const next = () => tempId--;
  const ops = [];

  // 1. Shared-nothing daily budget
  const budgetTemp = next();
  const budgetRn = `customers/${cid}/campaignBudgets/${budgetTemp}`;
  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: budgetRn,
        name: clamp(`${campaignName} Budget`, 255),
        amountMicros: toMicros(dailyBudget.toFixed(2)),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false
      }
    }
  });

  // 2. Paused search campaign
  const campaignTemp = next();
  const campaignRn = `customers/${cid}/campaigns/${campaignTemp}`;
  ops.push({
    campaignOperation: {
      create: {
        resourceName: campaignRn,
        name: campaignName,
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budgetRn,
        manualCpc: { enhancedCpcEnabled: false },
        startDate: todayStamp(1),
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: Boolean(options.searchPartners),
          targetContentNetwork: false
        }
      }
    }
  });

  // 3. Ad groups + keywords + one responsive search ad each
  for (const group of adGroups) {
    const groupTemp = next();
    const groupRn = `customers/${cid}/adGroups/${groupTemp}`;
    const cpcBid = Number(group.avgCPC || group.avgCpc || proposal.costEstimation?.avgCPC || 2);

    ops.push({
      adGroupOperation: {
        create: {
          resourceName: groupRn,
          name: clamp(group.name || 'Ad Group', 255),
          campaign: campaignRn,
          status: 'PAUSED',
          type: 'SEARCH_STANDARD',
          cpcBidMicros: toMicros(Math.max(cpcBid, 0.05).toFixed(2))
        }
      }
    });

    const seen = new Set();
    for (const raw of group.keywords || []) {
      const kw = parseKeyword(raw);
      if (!kw || !kw.text) continue;
      const key = `${kw.matchType}:${kw.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: groupRn,
            status: 'ENABLED',
            keyword: { text: clamp(kw.text, 80), matchType: kw.matchType }
          }
        }
      });
    }

    const { headlines, descriptions } = buildRsaAssets(proposal, group);
    if (headlines.length >= 3 && descriptions.length >= 2) {
      ops.push({
        adGroupAdOperation: {
          create: {
            adGroup: groupRn,
            status: 'PAUSED',
            ad: {
              finalUrls: [finalUrl],
              responsiveSearchAd: { headlines, descriptions }
            }
          }
        }
      });
    }
  }

  // 4. Campaign-level negative keywords from the vault
  const vault = proposal.negativeKeywordVault || {};
  const negatives = [...new Set(Object.values(vault).flat().filter(Boolean))];
  for (const raw of negatives.slice(0, 5000)) {
    const kw = parseKeyword(raw);
    if (!kw || !kw.text) continue;
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign: campaignRn,
          negative: true,
          keyword: { text: clamp(kw.text, 80), matchType: MATCH_TYPES.BROAD }
        }
      }
    });
  }

  // 5. Assets: sitelinks, callouts, structured snippets
  const assets = proposal.adAssets || {};

  for (const sl of (assets.sitelinks || []).slice(0, 20)) {
    const linkText = clamp(sl.title || sl.text, 25);
    if (!linkText) continue;
    const assetTemp = next();
    const assetRn = `customers/${cid}/assets/${assetTemp}`;
    // Google requires sitelink descriptions to be supplied as a pair or not
    // at all - one line on its own is rejected.
    const d1 = clamp(sl.desc1, 35);
    const d2 = clamp(sl.desc2, 35);
    const descriptions = d1 && d2 ? { description1: d1, description2: d2 } : {};
    ops.push({
      assetOperation: {
        create: {
          resourceName: assetRn,
          finalUrls: [normaliseUrl(sl.url) || finalUrl],
          sitelinkAsset: { linkText, ...descriptions }
        }
      }
    });
    ops.push({
      campaignAssetOperation: {
        create: { campaign: campaignRn, asset: assetRn, fieldType: 'SITELINK' }
      }
    });
  }

  for (const co of (assets.callouts || []).slice(0, 20)) {
    const calloutText = clamp(typeof co === 'string' ? co : co.text, 25);
    if (!calloutText) continue;
    const assetTemp = next();
    const assetRn = `customers/${cid}/assets/${assetTemp}`;
    ops.push({
      assetOperation: { create: { resourceName: assetRn, calloutAsset: { calloutText } } }
    });
    ops.push({
      campaignAssetOperation: {
        create: { campaign: campaignRn, asset: assetRn, fieldType: 'CALLOUT' }
      }
    });
  }

  const snip = assets.structuredSnippets;
  const snipValues = (snip?.values || []).map((v) => clamp(v, 25)).filter(Boolean).slice(0, 10);
  if (snip?.header && snipValues.length >= 3) {
    const assetTemp = next();
    const assetRn = `customers/${cid}/assets/${assetTemp}`;
    ops.push({
      assetOperation: {
        create: {
          resourceName: assetRn,
          structuredSnippetAsset: { header: snip.header, values: snipValues }
        }
      }
    });
    ops.push({
      campaignAssetOperation: {
        create: { campaign: campaignRn, asset: assetRn, fieldType: 'STRUCTURED_SNIPPET' }
      }
    });
  }

  if (options.validateOnly) {
    // Google validates the whole thing and writes nothing.
    await request(
      'post',
      `/customers/${cid}/googleAds:mutate`,
      { mutateOperations: ops, validateOnly: true, partialFailure: false },
      { customerId: cid }
    );
    return { validated: true, operationCount: ops.length, campaignName };
  }

  const result = await request(
    'post',
    `/customers/${cid}/googleAds:mutate`,
    { mutateOperations: ops, partialFailure: false, responseContentType: 'RESOURCE_NAME_ONLY' },
    { customerId: cid }
  );

  const campaignResource = (result.mutateOperationResponses || [])
    .map((r) => r.campaignResult?.resourceName)
    .find(Boolean);
  const newCampaignId = campaignResource ? campaignResource.split('/').pop() : null;

  return {
    validated: false,
    operationCount: ops.length,
    campaignName,
    customerId: cid,
    campaignId: newCampaignId,
    campaignResourceName: campaignResource,
    keywordCount: adGroups.reduce((n, g) => n + (g.keywords?.length || 0), 0),
    adGroupCount: adGroups.length,
    negativeCount: negatives.length,
    manageUrl: newCampaignId
      ? `https://ads.google.com/aw/campaigns?campaignId=${newCampaignId}&__e=${cid}`
      : `https://ads.google.com/aw/campaigns?__e=${cid}`
  };
}

function normaliseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return '';
  }
}

function connectionStatus() {
  const c = cfg();
  return {
    platform: 'google',
    configured: Boolean(c.clientId && c.clientSecret && c.developerToken),
    connected: Boolean(currentRefreshToken()),
    refreshTokenSource: process.env.GOOGLE_REFRESH_TOKEN
      ? 'environment'
      : store.getTokens().google_refresh_token
        ? 'local file (set GOOGLE_REFRESH_TOKEN to make it permanent)'
        : 'none',
    apiVersion: c.version,
    loginCustomerId: c.loginCustomerId ? formatCustomerId(c.loginCustomerId) : null,
    redirectUri: c.redirectUri,
    missing: [
      !c.clientId && 'GOOGLE_CLIENT_ID',
      !c.clientSecret && 'GOOGLE_CLIENT_SECRET',
      !c.developerToken && 'GOOGLE_DEVELOPER_TOKEN',
      !c.redirectUri && 'GOOGLE_REDIRECT_URI'
    ].filter(Boolean)
  };
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForTokens,
  getAccessToken,
  connectionStatus,
  listAccessibleCustomers,
  listClientAccounts,
  listCampaigns,
  getCampaignDetail,
  setCampaignStatus,
  deployProposal,
  formatCustomerId,
  parseKeyword,
  normaliseUrl,
  digits
};

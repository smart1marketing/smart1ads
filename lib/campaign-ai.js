/**
 * AI campaign generator + budget viability engine.
 */
const { OpenAI } = require('openai');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Rough sector CPC benchmarks (US search, USD). Used for the budget viability
 * warnings in the wizard so the slider gives honest feedback before a single
 * token is spent on generation.
 */
const SECTOR_CPC = {
  legal: { low: 8, high: 90, label: 'Legal / Attorney' },
  insurance: { low: 12, high: 65, label: 'Insurance' },
  medical: { low: 4, high: 30, label: 'Medical / Dental' },
  homeservices: { low: 6, high: 35, label: 'Home Services / Trades' },
  b2bsaas: { low: 5, high: 45, label: 'B2B SaaS / Software' },
  finance: { low: 7, high: 55, label: 'Finance / Lending' },
  realestate: { low: 3, high: 18, label: 'Real Estate' },
  ecommerce: { low: 0.8, high: 4, label: 'Ecommerce / Retail' },
  education: { low: 3, high: 25, label: 'Education / Training' },
  automotive: { low: 2, high: 12, label: 'Automotive' },
  travel: { low: 1.2, high: 6, label: 'Travel / Hospitality' },
  general: { low: 2, high: 12, label: 'General / Other' }
};

/**
 * Minimum clicks per month before a search campaign can learn anything.
 * Below ~100 clicks/mo you cannot optimise; below ~30 you are just donating.
 */
function analyseBudget(monthlyBudget, sectorKey = 'general') {
  const sector = SECTOR_CPC[sectorKey] || SECTOR_CPC.general;
  const budget = Number(monthlyBudget || 0);
  const midCpc = (sector.low + sector.high) / 2;
  const expectedClicks = budget / midCpc;
  const clicksAtHighCpc = budget / sector.high;

  let status = 'HEALTHY';
  let advice;

  if (expectedClicks < 30) {
    status = 'CRITICAL';
    advice =
      `At roughly $${midCpc.toFixed(2)} average CPC in ${sector.label}, $${budget.toLocaleString()}/mo ` +
      `buys about ${Math.round(expectedClicks)} clicks. That is not enough traffic for Google to ` +
      `optimise or for you to read the data. Either raise the budget, or cut scope hard: one tight ` +
      `exact-match ad group, a small radius, and business-hours-only scheduling.`;
  } else if (expectedClicks < 100) {
    status = 'WARN';
    advice =
      `$${budget.toLocaleString()}/mo lands around ${Math.round(expectedClicks)} clicks at a ` +
      `$${midCpc.toFixed(2)} CPC. Workable, but thin. Keep to 1-2 ad groups, lean on exact and ` +
      `phrase match, and expect 6-8 weeks before conversion data means anything.`;
  } else {
    advice =
      `$${budget.toLocaleString()}/mo supports roughly ${Math.round(expectedClicks)} clicks at a ` +
      `$${midCpc.toFixed(2)} CPC in ${sector.label}. Enough headroom for 2-3 themed ad groups and ` +
      `a real testing cadence.`;
  }

  return {
    status,
    advice,
    sector: sector.label,
    sectorKey,
    cpcRange: { low: sector.low, high: sector.high },
    estimatedClicks: Math.round(expectedClicks),
    worstCaseClicks: Math.round(clicksAtHighCpc),
    recommendedMinimum: Math.round(midCpc * 100)
  };
}

const SYSTEM_PROMPT = `You are an elite paid search strategist building Google Ads search campaigns.

RULES
1. Produce 2 to 3 distinct, tightly themed ad groups. Never mix intents in one group.
2. Every ad group must contain between 20 and 50 keywords.
3. Tag every keyword's match type by wrapping it: [exact match] or "phrase match" or leave bare for broad.
   Lean heavily on phrase and exact. Broad only for genuine discovery terms.
4. Every ad group needs responsive search ad copy: at least 5 headlines (max 30 characters each,
   count them) and at least 3 descriptions (max 90 characters each).
5. Include at least 4 sitelinks. Sitelink titles max 25 characters. Each sitelink must have BOTH
   description lines or NEITHER, each max 35 characters.
6. Include at least 6 callouts, max 25 characters each.
7. Include structured snippets with a valid header and at least 4 values, max 25 characters each.
8. Include a categorised negative keyword vault. Be thorough and specific to this business.
9. Cost estimates must be grounded in real CPC ranges for the sector, not optimistic.

Respond with pure JSON only, matching this structure exactly:
{
  "businessName": "string",
  "websiteUrl": "string",
  "monthlyBudget": 0,
  "sector": "string",
  "strategySummary": "2-3 sentences on the approach and why",
  "costEstimation": {
    "estimatedMonthlyCost": 0,
    "avgCPC": 0,
    "estimatedMonthlyClicks": 0,
    "estimatedConversionRate": 0,
    "estimatedConversions": 0,
    "estimatedCPA": 0,
    "budgetViability": { "status": "HEALTHY", "advice": "string" }
  },
  "landingPageAnalysis": {
    "ctaReadiness": "High | Medium | Low",
    "messageMatch": "string",
    "recommendations": ["string"]
  },
  "adGroups": [
    {
      "name": "string",
      "theme": "string",
      "avgCPC": 0,
      "keywords": ["[exact term]", "\\"phrase term\\"", "broad term"],
      "ads": {
        "headlines": ["max 30 chars"],
        "descriptions": ["max 90 chars"]
      }
    }
  ],
  "adAssets": {
    "sitelinks": [{ "title": "max 25", "desc1": "max 35", "desc2": "max 35", "url": "https://..." }],
    "callouts": ["max 25 chars"],
    "structuredSnippets": { "header": "Services", "values": ["max 25 chars"] }
  },
  "negativeKeywordVault": {
    "freeCheap": ["string"],
    "jobsCareers": ["string"],
    "educational": ["string"],
    "irrelevant": ["string"]
  }
}`;

async function generateCampaign(input, { apiKey, model } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error(
      'No OpenAI API key. Set OPENAI_API_KEY in your environment, or paste a key in Settings.'
    );
    err.code = 'NO_OPENAI_KEY';
    throw err;
  }

  const client = new OpenAI({ apiKey: key });
  const viability = analyseBudget(input.budget, input.sector);

  const userPrompt = `Build a Google Ads search campaign for:

Business name: ${input.businessName}
Website / landing page: ${input.websiteUrl}
Sector: ${viability.sector}
Primary objective: ${input.objective}
Monthly budget: $${input.budget}
Target audience: ${input.targetAudience || 'not specified'}
Geography: ${input.geography || 'not specified'}
${input.notes ? `Additional context: ${input.notes}` : ''}

Independent budget check already run (use it, do not contradict it):
${viability.status} - ${viability.advice}
Typical CPC range for this sector: $${viability.cpcRange.low} to $${viability.cpcRange.high}.

Remember: 20 to 50 keywords in EVERY ad group, with match types tagged.`;

  const response = await client.chat.completions.create({
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_tokens: 8000
  });

  const raw = response.choices?.[0]?.message?.content;
  if (!raw) throw new Error('The model returned an empty response. Try again.');

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The model returned malformed JSON. Try again.');
  }

  return normaliseProposal(data, input, viability);
}

/** Defensive clean-up: the model is good, but never trusted with hard limits. */
function normaliseProposal(data, input, viability) {
  const trunc = (s, n) => String(s || '').trim().slice(0, n);

  const adGroups = (Array.isArray(data.adGroups) ? data.adGroups : []).map((g, i) => ({
    name: trunc(g.name || `Ad Group ${i + 1}`, 120),
    theme: trunc(g.theme, 400),
    avgCPC: Number(g.avgCPC || 0) || Number(data.costEstimation?.avgCPC || 0) || 2,
    keywords: [...new Set((g.keywords || []).map((k) => String(k).trim()).filter(Boolean))].slice(0, 50),
    ads: {
      headlines: [...new Set((g.ads?.headlines || []).map((h) => trunc(h, 30)).filter(Boolean))].slice(0, 15),
      descriptions: [...new Set((g.ads?.descriptions || []).map((d) => trunc(d, 90)).filter(Boolean))].slice(0, 4)
    }
  }));

  const assets = data.adAssets || {};
  const sitelinks = (assets.sitelinks || [])
    .map((s) => ({
      title: trunc(s.title, 25),
      desc1: trunc(s.desc1, 35),
      desc2: trunc(s.desc2, 35),
      url: String(s.url || input.websiteUrl || '').trim()
    }))
    .filter((s) => s.title)
    .slice(0, 20);

  const vault = data.negativeKeywordVault || {};

  return {
    businessName: data.businessName || input.businessName,
    websiteUrl: data.websiteUrl || input.websiteUrl,
    monthlyBudget: Number(data.monthlyBudget || input.budget || 0),
    objective: input.objective,
    targetAudience: input.targetAudience,
    geography: input.geography,
    sector: viability.sector,
    sectorKey: viability.sectorKey,
    strategySummary: trunc(data.strategySummary, 1200),
    costEstimation: {
      estimatedMonthlyCost: Number(data.costEstimation?.estimatedMonthlyCost || input.budget || 0),
      avgCPC: Number(data.costEstimation?.avgCPC || 0),
      estimatedMonthlyClicks: Number(data.costEstimation?.estimatedMonthlyClicks || 0),
      estimatedConversionRate: Number(data.costEstimation?.estimatedConversionRate || 0),
      estimatedConversions: Number(data.costEstimation?.estimatedConversions || 0),
      estimatedCPA: Number(data.costEstimation?.estimatedCPA || 0),
      budgetViability: { status: viability.status, advice: viability.advice }
    },
    landingPageAnalysis: {
      ctaReadiness: data.landingPageAnalysis?.ctaReadiness || 'Unknown',
      messageMatch: data.landingPageAnalysis?.messageMatch || '',
      recommendations: (data.landingPageAnalysis?.recommendations || []).slice(0, 10)
    },
    adGroups,
    adAssets: {
      sitelinks,
      callouts: [...new Set((assets.callouts || []).map((c) => trunc(c, 25)).filter(Boolean))].slice(0, 20),
      structuredSnippets: {
        header: trunc(assets.structuredSnippets?.header || 'Services', 25),
        values: [...new Set((assets.structuredSnippets?.values || []).map((v) => trunc(v, 25)).filter(Boolean))].slice(0, 10)
      }
    },
    negativeKeywordVault: {
      freeCheap: (vault.freeCheap || []).slice(0, 200),
      jobsCareers: (vault.jobsCareers || []).slice(0, 200),
      educational: (vault.educational || []).slice(0, 200),
      irrelevant: (vault.irrelevant || []).slice(0, 200)
    }
  };
}

module.exports = { generateCampaign, analyseBudget, SECTOR_CPC };

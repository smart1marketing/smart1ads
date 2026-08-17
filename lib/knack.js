/**
 * Smart 1 Team (Knack) bridge - pulls client profiles and monthly allocated
 * budgets so proposals can be checked against what the client actually pays.
 */
const axios = require('axios');

const NAME_HINTS = ['client', 'company', 'account', 'customer', 'business', 'name'];
const BUDGET_HINTS = ['budget', 'spend', 'allocation', 'monthly'];
const GOOGLE_ID_HINTS = ['google', 'customer id', 'cid', 'adwords'];

function stripHtml(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    return String(v.identifier || v.full || v.email || v.url || JSON.stringify(v));
  }
  return String(v).replace(/<[^>]*>/g, '').trim();
}

function toNumber(v) {
  const n = Number(String(stripHtml(v)).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Knack returns both raw field ids (field_12) and "_raw" variants. Rather than
 * forcing a schema, guess sensibly and let env vars override.
 */
function pickField(record, explicitId, hints) {
  if (explicitId && record[explicitId] !== undefined) return record[explicitId];
  const keys = Object.keys(record).filter((k) => !k.endsWith('_raw'));
  for (const hint of hints) {
    const match = keys.find((k) => k.toLowerCase().includes(hint));
    if (match) return record[match];
  }
  return undefined;
}

function isConfigured() {
  return Boolean(process.env.SMART1_TEAM_APP_ID && process.env.SMART1_TEAM_API_KEY);
}

async function fetchRecords() {
  if (!isConfigured()) {
    const err = new Error(
      'Smart 1 Team is not connected. Set SMART1_TEAM_APP_ID and SMART1_TEAM_API_KEY.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const object = process.env.SMART1_TEAM_OBJECT || 'object_1';
  const { data } = await axios.get(
    `https://api.knack.com/v1/objects/${object}/records`,
    {
      headers: {
        'X-Knack-Application-Id': process.env.SMART1_TEAM_APP_ID,
        'X-Knack-REST-API-Key': process.env.SMART1_TEAM_API_KEY
      },
      params: { rows_per_page: 500 },
      timeout: 30_000
    }
  );

  const records = data.records || [];
  return records.map((r) => ({
    id: r.id,
    clientName:
      stripHtml(pickField(r, process.env.SMART1_TEAM_FIELD_NAME, NAME_HINTS)) || 'Unnamed client',
    monthlyBudget: toNumber(pickField(r, process.env.SMART1_TEAM_FIELD_BUDGET, BUDGET_HINTS)),
    googleCustomerId: stripHtml(
      pickField(r, process.env.SMART1_TEAM_FIELD_CUSTOMER_ID, GOOGLE_ID_HINTS)
    ).replace(/\D/g, ''),
    raw: r
  }));
}

module.exports = { fetchRecords, isConfigured };

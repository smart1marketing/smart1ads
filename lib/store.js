/**
 * Tiny JSON-file backed store.
 *
 * NOTE ON RENDER: the filesystem on Render's free/starter instances is
 * ephemeral - it is wiped on every deploy and on instance restarts. That is
 * fine for audit logs and draft proposals, but it means the Google refresh
 * token must ALSO be kept in the GOOGLE_REFRESH_TOKEN env var (the app shows
 * you the value to paste after you connect). Attach a Render Disk mounted at
 * ./data, or swap this module for Postgres, when you want real durability.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const DEFAULTS = {
  tokens: {},
  proposals: [],
  audit: [],
  settings: {}
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

const cache = new Map();

function read(name) {
  if (cache.has(name)) return cache.get(name);
  let value = structuredClone(DEFAULTS[name] ?? {});
  try {
    ensureDir();
    const file = fileFor(name);
    if (fs.existsSync(file)) {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`[store] could not read ${name}.json, starting empty:`, err.message);
  }
  cache.set(name, value);
  return value;
}

function write(name, value) {
  cache.set(name, value);
  try {
    ensureDir();
    const file = fileFor(name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    // Read-only FS should degrade to in-memory rather than crash the request.
    console.error(`[store] could not persist ${name}.json (in-memory only):`, err.message);
  }
  return value;
}

function update(name, fn) {
  const next = fn(read(name));
  return write(name, next);
}

// ---------------------------------------------------------------- audit log
const MAX_AUDIT = 1000;

function logEvent(action, user, details) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    action,
    user: user || 'System',
    details: details || {}
  };
  update('audit', (logs) => {
    logs.unshift(entry);
    return logs.slice(0, MAX_AUDIT);
  });
  return entry;
}

function getAudit(limit = 250) {
  return read('audit').slice(0, limit);
}

// ---------------------------------------------------------------- proposals
function listProposals() {
  return read('proposals');
}

function getProposal(id) {
  return read('proposals').find((p) => p.id === id) || null;
}

function saveProposal(proposal) {
  update('proposals', (list) => {
    const idx = list.findIndex((p) => p.id === proposal.id);
    if (idx >= 0) list[idx] = proposal;
    else list.unshift(proposal);
    return list;
  });
  return proposal;
}

function deleteProposal(id) {
  let removed = false;
  update('proposals', (list) => {
    const next = list.filter((p) => p.id !== id);
    removed = next.length !== list.length;
    return next;
  });
  return removed;
}

// ------------------------------------------------------------------- tokens
function getTokens() {
  return read('tokens');
}

function setTokens(patch) {
  return update('tokens', (t) => ({ ...t, ...patch }));
}

module.exports = {
  DATA_DIR,
  read,
  write,
  update,
  logEvent,
  getAudit,
  listProposals,
  getProposal,
  saveProposal,
  deleteProposal,
  getTokens,
  setTokens
};

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const path = require('path');
const { OpenAI } = require('openai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static frontend build if present
app.use(express.static(path.join(__dirname, 'public')));

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || ''
});

// In-Memory Audit Logs Store (or connect to persistent DB/Smart 1 Team)
const auditLogs = [];

/**
 * Utility: Log Audit Event
 */
function logAuditEvent(action, user, details) {
  const logEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    timestamp: new Date().toISOString(),
    action,
    user: user || 'System/Admin',
    details
  };
  auditLogs.unshift(logEntry);
  if (auditLogs.length > 500) auditLogs.pop(); // Keep last 500
  return logEntry;
}

// =========================================================================
// 1. AUDIT LOG ENDPOINTS
// =========================================================================
app.get('/api/audit-logs', (req, res) => {
  res.json({ success: true, count: auditLogs.length, logs: auditLogs });
});

app.post('/api/audit-logs', (req, res) => {
  const { action, user, details } = req.body;
  const entry = logAuditEvent(action || 'GENERAL_ACTION', user, details);
  res.json({ success: true, log: entry });
});

// =========================================================================
// 2. SMART 1 TEAM (KNACK DB) BUDGET SYNC
// =========================================================================
app.get('/api/smart1-team/records', async (req, res) => {
  try {
    const appId = process.env.SMART1_TEAM_APP_ID;
    const apiKey = process.env.SMART1_TEAM_API_KEY;

    if (!appId || !apiKey) {
      logAuditEvent('SMART1_TEAM_SYNC_MOCK', 'System', { note: 'Missing Knack keys, returning mock records' });
      return res.json({
        success: true,
        source: 'MOCK',
        records: [
          { id: 'rec_101', clientName: 'Apex Tech Solutions', monthlyBudget: 4500, targetCPA: 65, active: true },
          { id: 'rec_102', clientName: 'GreenFlora Ecommerce', monthlyBudget: 8200, targetCPA: 22, active: true },
          { id: 'rec_103', clientName: 'Summit Law Group', monthlyBudget: 12000, targetCPA: 140, active: true }
        ]
      });
    }

    const response = await axios.get('https://api.knack.com/v1/objects/object_accounts/records', {
      headers: {
        'X-Knack-Application-Id': appId,
        'X-Knack-REST-API-Key': apiKey
      }
    });

    logAuditEvent('SMART1_TEAM_SYNC_SUCCESS', 'API_Sync', { recordsCount: response.data.records?.length || 0 });
    res.json({ success: true, source: 'SMART1_TEAM_API', records: response.data.records });
  } catch (error) {
    logAuditEvent('SMART1_TEAM_SYNC_ERROR', 'API_Sync', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// 3. OPENAI CAMPAIGN GENERATOR (Ad Groups, 20-50 Keywords, Extensions)
// =========================================================================
app.post('/api/generate-campaign', async (req, res) => {
  const { businessName, websiteUrl, objective, budget, targetAudience, customApiKey } = req.body;

  logAuditEvent('CAMPAIGN_GENERATION_INIT', 'User', { businessName, websiteUrl, budget });

  const clientApiKey = customApiKey || process.env.OPENAI_API_KEY;

  if (!clientApiKey) {
    return res.status(400).json({
      success: false,
      error: 'OpenAI API key missing. Please configure OPENAI_API_KEY on Render or provide it in the app settings.'
    });
  }

  const aiClient = new OpenAI({ apiKey: clientApiKey });

  const systemPrompt = `You are an elite PPC Search Specialist for Google Ads and Microsoft Advertising (Bing Ads).
You generate structured campaign architectures.

IMPORTANT RULES:
1. Provide 2 to 3 distinct themed Ad Groups.
2. EVERY Ad Group MUST contain between 20 to 50 relevant keywords.
3. Include estimated monthly cost, estimated clicks, estimated conversions, and CPC based on industry standards.
4. Include Ad Assets: Sitelinks (min 4), Callout Extensions (min 4), and Structured Snippets.
5. Include a Categorized Negative Keyword Vault (Free/Cheap, Jobs/Careers, DIY/Educational, Irrelevant).

Return pure JSON matching this exact structure:
{
  "businessName": "...",
  "websiteUrl": "...",
  "monthlyBudget": 0,
  "costEstimation": {
    "estimatedMonthlyCost": 0,
    "avgCPC": 0,
    "estimatedMonthlyClicks": 0,
    "estimatedConversions": 0,
    "estimatedCPA": 0,
    "budgetViability": {
      "status": "HEALTHY | WARN | CRITICAL",
      "advice": "..."
    }
  },
  "landingPageAnalysis": {
    "speedScore": 92,
    "ctaReadiness": "High",
    "messageMatch": "Excellent",
    "recommendations": ["..."]
  },
  "adGroups": [
    {
      "name": "Ad Group Name",
      "theme": "Description of theme",
      "avgCPC": 2.50,
      "keywords": [
        "keyword term 1",
        "keyword term 2"
        // MUST BE 20 TO 50 KEYWORDS TOTAL PER AD GROUP
      ]
    }
  ],
  "adAssets": {
    "sitelinks": [
      { "title": "Link Title", "desc1": "Line 1", "desc2": "Line 2", "url": "https://..." }
    ],
    "callouts": ["Free Quote", "24/7 Support", "SOC2 Certified", "No Contract"],
    "structuredSnippets": {
      "header": "Services",
      "values": ["Consulting", "Implementation", "Support", "Auditing"]
    }
  },
  "negativeKeywordVault": {
    "freeCheap": ["free", "cheap", "crack", "torrent", "discount"],
    "jobsCareers": ["jobs", "careers", "hiring", "salary", "resume"],
    "educational": ["pdf", "wiki", "course", "tutorial", "how to"],
    "irrelevant": ["login", "portal", "support number"]
  }
}`;

  const userPrompt = `Generate a PPC campaign strategy for:
Business Name: ${businessName}
Website/Landing Page: ${websiteUrl}
Objective: ${objective}
Monthly Budget: $${budget}
Target Demographic: ${targetAudience}

Ensure each Ad Group has at least 20 keywords and up to 50 keywords!`;

  try {
    const response = await aiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7
    });

    const resultJson = JSON.parse(response.choices[0].message.content);

    logAuditEvent('CAMPAIGN_GENERATION_SUCCESS', 'AI_Engine', {
      businessName,
      adGroupCount: resultJson.adGroups?.length || 0,
      totalKeywords: resultJson.adGroups?.reduce((acc, g) => acc + (g.keywords?.length || 0), 0)
    });

    res.json({ success: true, campaignData: resultJson });
  } catch (error) {
    logAuditEvent('CAMPAIGN_GENERATION_ERROR', 'AI_Engine', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// 4. GOOGLE ADS OAUTH CALLBACK
// =========================================================================
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  logAuditEvent('GOOGLE_OAUTH_CALLBACK', 'Auth', { hasCode: !!code });

  if (!code) {
    return res.status(400).send('OAuth Code Missing from Google redirect.');
  }

  try {
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || 'https://smart1ads-app.onrender.com/auth/google/callback',
      grant_type: 'authorization_code'
    });

    logAuditEvent('GOOGLE_OAUTH_SUCCESS', 'Auth', { tokenType: tokenResponse.data.token_type });

    // Return HTML window closer / message script
    res.send(`
      <html>
        <body style="font-family: sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh;">
          <div style="text-align: center; background: #1e293b; padding: 2rem; border-radius: 1rem; border: 1px solid #334155;">
            <h2 style="color: #38bdf8;">Google Ads API Authenticated!</h2>
            <p style="color: #94a3b8;">You can now close this tab and return to Smart 1 Ads dashboard.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    logAuditEvent('GOOGLE_OAUTH_ERROR', 'Auth', { error: error.response?.data || error.message });
    res.status(500).send(`Google Authentication Failed: ${error.message}`);
  }
});

// =========================================================================
// 5. BING ADS (MICROSOFT) OAUTH CALLBACK
// =========================================================================
app.get('/auth/bing/callback', async (req, res) => {
  const { code } = req.query;
  logAuditEvent('BING_OAUTH_CALLBACK', 'Auth', { hasCode: !!code });

  if (!code) {
    return res.status(400).send('OAuth Code Missing from Microsoft redirect.');
  }

  try {
    const tokenResponse = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', 
      new URLSearchParams({
        client_id: process.env.BING_CLIENT_ID,
        client_secret: process.env.BING_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.BING_REDIRECT_URI || 'https://smart1ads-app.onrender.com/auth/bing/callback',
        scope: 'https://ads.microsoft.com/msads.manage offline_access'
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    logAuditEvent('BING_OAUTH_SUCCESS', 'Auth', { tokenType: tokenResponse.data.token_type });

    res.send(`
      <html>
        <body style="font-family: sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh;">
          <div style="text-align: center; background: #1e293b; padding: 2rem; border-radius: 1rem; border: 1px solid #334155;">
            <h2 style="color: #2dd4bf;">Microsoft Bing Ads API Authenticated!</h2>
            <p style="color: #94a3b8;">You can now close this tab and return to Smart 1 Ads dashboard.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    logAuditEvent('BING_OAUTH_ERROR', 'Auth', { error: error.response?.data || error.message });
    res.status(500).send(`Bing Ads Authentication Failed: ${error.message}`);
  }
});

// =========================================================================
// HEALTH & FALLBACK ROUTE
// =========================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'HEALTHY', app: 'Smart 1 Ads Service', timestamp: new Date() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) {
      res.send('Smart 1 Ads Backend API Engine Operational.');
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Smart 1 Ads Engine running on port ${PORT}`);
  logAuditEvent('SERVER_STARTUP', 'System', { port: PORT, env: process.env.NODE_ENV || 'development' });
});

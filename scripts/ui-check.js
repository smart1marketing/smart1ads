/**
 * Headless UI check - boots the app, signs in, walks every screen and fails
 * on any console error or unhandled page exception.
 *
 *   node scripts/ui-check.js
 */
process.env.NODE_ENV = 'test';
process.env.APP_PASSWORD = 'uitest';
process.env.SESSION_SECRET = 'ui-secret';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `s1a_ui_${Date.now()}`);
const PORT = 4177;

const path = require('path');
const app = require('../server');
const store = require('../lib/store');
const { chromium } = require('playwright');

const SAMPLE = {
  id: 'prop_ui_1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'APPROVED',
  clientName: 'Northside Roofing Co',
  comments: [{ id: 'c1', author: 'Todd', text: 'Cut ad group 3, budget is too thin for three.', createdAt: new Date().toISOString() }],
  campaignData: {
    businessName: 'Northside Roofing Co',
    websiteUrl: 'https://northsideroofing.example.com/roof-repair',
    monthlyBudget: 6500,
    sector: 'Home Services / Trades',
    strategySummary: 'Two tightly themed groups split emergency storm repair from planned replacement, because the two buyers behave nothing alike.',
    costEstimation: {
      estimatedMonthlyCost: 6500, avgCPC: 11.4, estimatedMonthlyClicks: 570,
      estimatedConversionRate: 0.08, estimatedConversions: 46, estimatedCPA: 141,
      budgetViability: { status: 'HEALTHY', advice: '$6,500/mo supports roughly 570 clicks at an $11.40 CPC in Home Services / Trades.' }
    },
    landingPageAnalysis: {
      ctaReadiness: 'Medium', messageMatch: 'The hero speaks to replacement, but most of this traffic wants urgent repair.',
      recommendations: ['Add a click-to-call button above the fold on mobile.', 'Put the 24/7 storm response promise in the hero.']
    },
    adGroups: [
      { name: 'Emergency Roof Repair', theme: 'Storm damage, leaks, urgent callouts', avgCPC: 13.2,
        keywords: ['[emergency roof repair]', '"roof leak repair"', '[24 hour roofer]', 'storm damage roof repair', '"roof repair near me"', 'urgent roofer (broad)'],
        ads: { headlines: ['24/7 Emergency Roofers', 'Roof Leak? We Come Today', 'Free Storm Damage Check', 'Licensed & Insured Crew'],
               descriptions: ['Storm damage or an active leak? Our crew is out the same day, seven days a week.',
                              'Free inspection, clear written pricing and a 10 year workmanship warranty.'] } },
      { name: 'Roof Replacement Quotes', theme: 'Planned full replacement research', avgCPC: 9.8,
        keywords: ['[roof replacement cost]', '"new roof quote"', '[roof replacement near me]', 'cost to replace a roof', '"asphalt shingle replacement"'],
        ads: { headlines: ['Free Roof Replacement Quote', 'Financing From $99/Month', 'Local Since 1998'],
               descriptions: ['Compare shingle, metal and tile options with an honest cost breakdown.',
                              'No pressure quotes from a family run local crew. Book an inspection today.'] } }
    ],
    adAssets: {
      sitelinks: [
        { title: 'Free Roof Inspection', desc1: 'Booked within 24 hours', desc2: 'No obligation quote', url: 'https://northsideroofing.example.com/inspection' },
        { title: 'Storm Damage Help', desc1: 'Insurance claim support', desc2: 'We deal with adjusters', url: 'https://northsideroofing.example.com/storm' },
        { title: 'Financing Options', desc1: 'From $99 per month', desc2: 'Approval in minutes', url: 'https://northsideroofing.example.com/financing' },
        { title: 'Read Our Reviews', desc1: '480+ five star reviews', desc2: 'Google verified', url: 'https://northsideroofing.example.com/reviews' }
      ],
      callouts: ['Licensed & Insured', '10 Year Warranty', 'Same Day Callouts', 'Free Estimates', 'Family Owned', 'Financing Available'],
      structuredSnippets: { header: 'Services', values: ['Roof Repair', 'Roof Replacement', 'Storm Damage', 'Gutters', 'Inspections'] }
    },
    negativeKeywordVault: {
      freeCheap: ['free roof', 'cheap roofer', 'diy roof repair'],
      jobsCareers: ['roofer jobs', 'roofing salary', 'roofing apprenticeship'],
      educational: ['how to repair a roof', 'roofing course', 'roof repair pdf'],
      irrelevant: ['roof rack', 'roof box', 'sunroof']
    }
  }
};

(async () => {
  store.saveProposal(SAMPLE);
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const shots = process.argv[2] || path.join(__dirname, '..', 'shots');
  require('fs').mkdirSync(shots, { recursive: true });

  async function shot(name) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
    console.log(`  captured ${name}`);
  }

  console.log('\nUI check\n');

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.login-card', { timeout: 8000 });
  await shot('01-login');

  await page.fill('input[type=password]', 'uitest');
  await page.click('button.btn-primary');
  await page.waitForSelector('.sidebar', { timeout: 8000 });
  await shot('02-campaigns-not-connected');

  await page.click('text=Campaign generator');
  await page.waitForSelector('text=Client and objective');
  await page.fill('input[placeholder="Apex Roofing"]', 'Northside Roofing Co');
  await page.fill('input[placeholder="https://apexroofing.com/roof-repair"]', 'https://northsideroofing.example.com');
  await shot('03-generator-step1');

  await page.click('text=Continue to budget');
  await page.waitForSelector('input[type=range]');
  await page.waitForTimeout(600);
  await shot('04-generator-budget');

  // drag the slider low to prove the viability engine reacts
  await page.evaluate(() => {
    const el = document.querySelector('input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '600');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  await shot('05-generator-budget-critical');

  await page.click('text=Approval hub');
  await page.waitForSelector('text=Northside Roofing Co');
  await shot('06-approval-hub');

  await page.click('td >> text=Northside Roofing Co');
  await page.waitForSelector('text=Deploy to Google Ads');
  await shot('07-proposal-detail');

  await page.click('button:has-text("Client proposal")');
  await page.waitForSelector('.proposal-doc');
  await shot('08-client-proposal');

  await page.click('text=← Back to internal view');
  await page.waitForSelector('text=Review and approval');
  await page.click('.navitem:has-text("Audit log")');
  await page.waitForSelector('text=Audit log');
  await shot('09-audit-log');

  await page.click('.navitem:has-text("Settings")');
  await page.waitForSelector('text=Connect Google Ads');
  await shot('10-settings');

  await browser.close();
  server.close();

  const ignorable = /favicon|ERR_ABORTED.*favicon/i;
  const real = problems.filter((p) => !ignorable.test(p));
  if (real.length) {
    console.log(`\n${real.length} browser problem(s):`);
    real.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log('\nNo console errors, no page exceptions, no failed requests.\n');
  process.exit(0);
})().catch((err) => {
  console.error('\nUI check crashed:', err);
  process.exit(1);
});

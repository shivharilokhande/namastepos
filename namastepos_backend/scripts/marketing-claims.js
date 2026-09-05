// NamastePOS — MARKETING CLAIM GUARD
//
// ══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ══════════════════════════════════════════════════════════════════════════
// Four separate times on 2026-09-05 the marketing site asserted something the
// live plan feed contradicts:
//
//   1. GST tax invoices promised on Starter/Growth  (tax_invoices starts on Pro)
//   2. Pro advertised "Unlimited staff"             (limits.staff = 10)
//   3. Compare table + llms.txt still showed the pre-089 menu ladder (10/25)
//   4. Advanced claimed TDS/TCS (Enterprise-only); Growth claimed memberships
//      and wallet (a Pro key); Starter's card note said "7-day free trial"
//      on a plan that is free forever
//
// Each was fixed by hand. The fifth would land the next time a plan changed,
// because nothing compared the copy to the data. This module is that
// comparison: it parses the claims out of the landing site and checks every
// one of them against the plan feed.
//
// It is a pure library plus a CLI. The blocking gate is
// tests/integration/marketingClaims.test.js (hermetic, seeded DB); the
// advisory gate is the `marketing-claims-live` CI job, which runs this file
// against production.
//
//   node scripts/marketing-claims.js            # against the pinned snapshot
//   node scripts/marketing-claims.js --live     # against api.namastepos.in
//   node scripts/marketing-claims.js --json     # machine-readable violations
//
// Exit 0 = every claim on the site is supported by the feed. Exit 1 = at
// least one is not, and each line names the plan, the claim, the file and
// what the feed actually says.

const fs = require('fs');
const path = require('path');

const LANDING_DIR = path.join(__dirname, '..', '..', 'namastepos_landing');

/** The commercial pages whose copy is checked, plus the AI-facing summary. */
const PAGES = [
  'index.html',
  'restaurant-billing-software.html',
  'gst-billing-software-restaurant.html',
  'kot-software.html',
  'offline-restaurant-pos.html',
];
const LLMS_TXT = 'llms.txt';

// ══════════════════════════════════════════════════════════════════════════
// 1. WHAT THE FEED SAYS  —  the only definition of truth in this file
// ══════════════════════════════════════════════════════════════════════════

// A capability lives in ONE of two places on a plan:
//   * plan_features rows                  -> surfaced as `featureKeys[]`
//   * the plans.features JSON blob        -> surfaced as `features{}`
// featureKeys is the primary answer. These four are the only capabilities the
// app reads out of the `features` blob instead, so the guard has to know about
// them or it would report false failures for copy that is actually correct.
const FEATURES_BLOB_KEYS = {
  reports_advanced: (f) => f.reports === 'advanced',
  aggregators: (f) => f.aggregators === true,
  exports: (f) => f.exports === true,
  support_priority: (f) => f.support === 'priority',
};

// DELIBERATELY ABSENT: the landing page's own has() helper treats
// `limits.businesses > 1` as proof of multi_outlet. It is not. Outlet creation
// is gated on the multi_outlet FEATURE KEY and nothing in the app reads
// limits.businesses at all (see the `businesses` entry in METRIC_POLICY,
// subscriptionService.js). Advanced has businesses:3 WITHOUT multi_outlet, so
// that shim is exactly how "Advanced does multi-outlet" got onto the site.
function grants(plan, key) {
  if ((plan.featureKeys || []).includes(key)) return true;
  const probe = FEATURES_BLOB_KEYS[key];
  return probe ? probe(plan.features || {}) : false;
}

function limitOf(plan, metric) {
  const v = (plan.limits || {})[metric];
  return v === undefined ? null : v;
}

function describeLimit(v) {
  if (v === null) return 'no cap recorded';
  return v < 0 ? 'unlimited (-1)' : String(v);
}

/** What the feed grants, rendered for a failure message. */
function describeGrant(plan, key) {
  if (grants(plan, key)) return `${plan.name} DOES have ${key}`;
  const holders = [];
  return holders.length ? holders.join(', ') : `${plan.name} does NOT have ${key}`;
}

// ══════════════════════════════════════════════════════════════════════════
// 2. THE VOCABULARY  —  marketing phrase -> feature key / metric
// ══════════════════════════════════════════════════════════════════════════

// Order matters: the first pattern that matches a phrase wins for that phrase,
// and every pattern is tried against every segment (a sentence can claim more
// than one capability). Keep these tight — a loose regex turns the guard into
// noise, and a guard that cries wolf gets switched off.
const FEATURE_PHRASES = [
  [/\be-?invoice\b/i, 'einvoice_gst'],
  [/\bGST tax invoice/i, 'tax_invoices'],
  [/\bTDS\s*\/?\s*TCS\b/i, 'tds_tcs'],
  [/\bbank reconcil/i, 'bank_reconcile'],
  [/\brecurring invoice/i, 'recurring_invoices'],
  [/\bB2B invoic/i, 'b2b_invoice'],
  [/\b(?:accounting|balance sheet|P&(?:amp;)?L)\b/i, 'accounting_pnl_bs'],
  [/\bmulti-?outlet\b/i, 'multi_outlet'],
  [/\bmulti-?currency\b/i, 'multi_currency_fx'],
  [/\bAPI access\b/i, 'api_access'],
  [/\bwhite-?label\b/i, 'white_label'],
  [/\b(?:Zomato|Swiggy|aggregator)/i, 'aggregators'],
  [/\binventory (?:tracking|management)?\b/i, 'inventory_tracking'],
  [/\brecipe costing\b/i, 'recipe_costing'],
  [/\bdead-?stock\b/i, 'dead_stock'],
  [/\bforecast/i, 'forecast'],
  [/\bbulk import\b/i, 'bulk_import'],
  [/\bsurge pricing\b/i, 'surge_pricing'],
  [/\bheat-?map\b/i, 'heat_map'],
  [/\bmembership|prepaid wallet\b/i, 'memberships'],
  [/\bloyalty\b/i, 'loyalty'],
  [/\bWhatsApp marketing\b/i, 'whatsapp_marketing'],
  [/\bcustomer CRM\b/i, 'customers_crm'],
  [/\breservation/i, 'reservations'],
  [/\bsplit (?:bill|payment)/i, 'bill_split'],
  [/\bweb dashboard\b/i, 'dashboard_access'],
  [/\bQR (?:self-?)?ordering\b/i, 'qr_ordering'],
  [/\b(?:kitchen display|KDS)\b/i, 'kds'],
  [/\bcaptain (?:mode|ordering)\b/i, 'captain_mode'],
  [/\btoken (?:generation|billing|numbers?)\b/i, 'token_generation'],
  [/\badvanced reports\b/i, 'reports_advanced'],
  [/\bCSV export|\bexports\b/i, 'exports'],
  [/\bpriority support\b/i, 'support_priority'],
  [/\bwastage\b/i, 'wastage'],
  [/\bvoice billing\b/i, 'voice_pos'],
  [/\bvariants? (?:&(?:amp;)?|and) modifiers\b/i, 'menu_variants_modifiers'],
  [/\bday-?end closing\b/i, 'daily_closing'],
  [/\badd-?on marketplace\b/i, 'marketplace_addons'],
];

/** Metric nouns as marketing writes them. */
const METRIC_PHRASES = [
  [/\bstaff logins?\b|\bstaff\b/i, 'staff'],
  [/\bmenu items?\b/i, 'menu_items'],
  [/\borders?\s*(?:a|per)\s*month\b|\bmonthly orders\b/i, 'monthly_orders'],
  [/\boutlets?\b|\bbranch(?:es)?\b/i, 'businesses'],
  [/\btables?\b/i, 'tables'],
];

function metricFor(text) {
  const hit = METRIC_PHRASES.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

function featuresIn(text) {
  const out = [];
  for (const [re, key] of FEATURE_PHRASES) {
    if (re.test(text) && !out.includes(key)) out.push(key);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 3. HTML / TEXT PLUMBING
// ══════════════════════════════════════════════════════════════════════════

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&mdash;': '-',
  '&ndash;': '-',
  '&middot;': '.',
  '&rsquo;': "'",
};

function decode(s) {
  return String(s).replace(/&[a-z#0-9]+;/gi, (m) => (ENTITIES[m] !== undefined ? ENTITIES[m] : m));
}

function stripTags(s) {
  return decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 1-based line number of a byte offset, so a failure can be opened directly. */
function lineAt(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ══════════════════════════════════════════════════════════════════════════
// 4. CLAIM EXTRACTION
// ══════════════════════════════════════════════════════════════════════════
//
// A CLAIM is { kind, plan, file, line, text, ... }. Four kinds:
//
//   feature   — "<Plan> has <capability>"           (or explicitly does not)
//   ladder    — "<capability> starts on <Plan>"     (has it AND no cheaper
//                                                    plan does)
//   limit     — "<Plan> allows N <metric>"          (or unlimited)
//   price     — "<Plan> costs Rs N a month/year"
//
// Structured surfaces (tables, cards, the llms.txt ladder) are parsed
// positionally, which is exact. Prose is parsed only where a segment names
// EXACTLY ONE plan — a sentence naming two plans is ambiguous, and a guard
// that guesses produces failures nobody trusts.

function parseNumber(s) {
  const m = String(s).replace(/,/g, '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

const UNLIMITED_RE = /^\s*unlimited\s*$/i;

/** The feature_key -> friendly label table the page itself renders with. */
function parseLabelTable(indexHtml) {
  const block = indexHtml.match(/var\s+LBL\s*=\s*\{([\s\S]*?)\};/);
  const out = {};
  if (!block) return out;
  const re = /([a-z0-9_]+)\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let m = re.exec(block[1]);
  while (m) {
    out[decode(m[2])] = m[1]; // label -> key
    m = re.exec(block[1]);
  }
  return out;
}

/** Rows of the STATIC compare table (the no-JS / SEO fallback). */
function claimsFromCompareTable(html, file, labelToKey) {
  const claims = [];
  const head = html.match(/<thead id="compare-head">([\s\S]*?)<\/thead>/);
  const body = html.match(/<tbody id="compare-body">([\s\S]*?)<\/tbody>/);
  if (!head || !body) return claims;

  const cols = (head[1].match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [])
    .map((c) => stripTags(c)).slice(1);
  const bodyStart = html.indexOf(body[1]);

  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let row = rowRe.exec(body[1]);
  while (row) {
    const line = lineAt(html, bodyStart + row.index);
    const cells = row[1].match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
    const label = stripTags(cells[0] || '');
    const values = cells.slice(1);
    const metric = { 'Menu items': 'menu_items', 'Staff logins': 'staff', Outlets: 'businesses', Tables: 'tables', 'Monthly orders': 'monthly_orders' }[label];
    values.forEach((cell, i) => {
      const plan = cols[i];
      if (!plan) return;
      const txt = stripTags(cell);
      if (metric) {
        claims.push({
          kind: 'limit',
          plan,
          metric,
          value: UNLIMITED_RE.test(txt) ? -1 : parseNumber(txt),
          file,
          line,
          text: `compare table row "${label}" = "${txt}"`,
        });
        return;
      }
      const key = labelToKey[label];
      if (!key) return;
      claims.push({
        kind: 'feature',
        plan,
        key,
        // Cells render as <span class="material-symbols-outlined yes"> (tick)
        // or <span class="no">-</span> plus a screen-reader label.
        included: /class="[^"]*\byes\b[^"]*"/.test(cell),
        file,
        line,
        text: `compare table row "${label}"`,
      });
    });
    row = rowRe.exec(body[1]);
  }
  return claims;
}

/** The STATIC plan cards inside #price-grid. */
function claimsFromPlanCards(html, file) {
  const claims = [];
  const grid = html.match(/<div class="price-grid" id="price-grid">([\s\S]*?)\n\s*<\/div>\n\n\s*<div class="compare/);
  if (!grid) return claims;
  const gridStart = html.indexOf(grid[1]);

  const cardRe = /<div class="plan[^"]*">([\s\S]*?)<\/div>\s*(?=<div class="plan|$)/g;
  let card = cardRe.exec(grid[1]);
  while (card) {
    const line = lineAt(html, gridStart + card.index);
    const chunk = card[1];
    const name = stripTags((chunk.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '');
    if (!name) { card = cardRe.exec(grid[1]); continue; }

    const priceTxt = stripTags((chunk.match(/<div class="price">([\s\S]*?)<\/div>/) || [])[1] || '');
    if (/\/mo\b/.test(priceTxt)) {
      claims.push({ kind: 'price', plan: name, period: 'monthly', value: parseNumber(priceTxt), file, line, text: `plan card price "${priceTxt}"` });
    }

    const note = stripTags((chunk.match(/<div class="note">([\s\S]*?)<\/div>/) || [])[1] || '');
    if (note) {
      claims.push({ kind: 'note', plan: name, note, file, line, text: `plan card note "${note}"` });
    }

    for (const li of chunk.match(/<li>([\s\S]*?)<\/li>/g) || []) {
      const t = stripTags(li);
      if (!t || /^Everything in /i.test(t)) continue;
      for (const key of featuresIn(t)) {
        claims.push({ kind: 'feature', plan: name, key, included: true, file, line, text: `plan card bullet "${t}"` });
      }
      claims.push(...limitClaimsIn(t, name, file, line, 'plan card bullet'));
    }
    card = cardRe.exec(grid[1]);
  }
  return claims;
}

/**
 * Numeric and "unlimited" limit claims inside one plan-scoped piece of text.
 * "up to 10 staff logins" / "3,000 orders a month" / "unlimited orders, menu
 * items and tables".
 */
function limitClaimsIn(text, plan, file, line, where) {
  const claims = [];

  const numRe = /(?:up to\s+)?(\d[\d,]*)\s+((?:staff logins?|menu items?|tables?|outlets?|branches|orders?\s*(?:a|per)\s*month|monthly orders))/gi;
  let m = numRe.exec(text);
  while (m) {
    const metric = metricFor(m[2]);
    if (metric) {
      claims.push({ kind: 'limit', plan, metric, value: parseNumber(m[1]), file, line, text: `${where} "${m[0].trim()}"` });
    }
    m = numRe.exec(text);
  }

  // One "unlimited" can govern a list: "unlimited orders, menu items and tables".
  const unlRe = /\bunlimited\s+([a-z][a-z\s,]*?(?:\sand\s[a-z\s]+?)?)(?=[.,;)]|\band\b\s+up\s|$)/gi;
  let u = unlRe.exec(text);
  while (u) {
    for (const frag of u[1].split(/,|\band\b/)) {
      const metric = metricFor(frag.trim());
      if (metric) {
        claims.push({ kind: 'limit', plan, metric, value: -1, file, line, text: `${where} "unlimited ${frag.trim()}"` });
      }
    }
    u = unlRe.exec(text);
  }
  return claims;
}

/** Rows of the per-plan pricing tables on the commercial pages. */
function claimsFromPlanRows(html, file, planNames) {
  const claims = [];
  const rowRe = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>([\s\S]*?)<\/tr>/g;
  let row = rowRe.exec(html);
  while (row) {
    const plan = stripTags(row[1]);
    if (planNames.includes(plan)) {
      const line = lineAt(html, row.index);
      const cells = (row[2].match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => ({ raw: c, txt: stripTags(c) }));
      // Cell 1 = monthly price, cell 2 = yearly price, by the shape every one
      // of these tables uses.
      if (cells[0] && /^₹0?$|^₹[\d,]+$/.test(cells[0].txt)) {
        claims.push({ kind: 'price', plan, period: 'monthly', value: parseNumber(cells[0].txt), file, line, text: `pricing row monthly "${cells[0].txt}"` });
      }
      if (cells[1]) {
        if (/^₹[\d,]+$/.test(cells[1].txt)) {
          claims.push({ kind: 'price', plan, period: 'yearly', value: parseNumber(cells[1].txt), file, line, text: `pricing row yearly "${cells[1].txt}"` });
        } else if (/free forever|not offered/i.test(cells[1].txt)) {
          claims.push({ kind: 'price', plan, period: 'yearly', value: null, file, line, text: `pricing row yearly "${cells[1].txt}"` });
        }
      }
      for (const cell of cells) {
        const t = cell.txt;
        if (!t || /^₹/.test(t)) continue;
        for (const key of featuresIn(t)) {
          claims.push({ kind: 'feature', plan, key, included: true, file, line, text: `pricing row cell "${t.slice(0, 90)}"` });
        }
        claims.push(...limitClaimsIn(t, plan, file, line, 'pricing row cell'));
      }
    }
    row = rowRe.exec(html);
  }
  return claims;
}

/** JSON-LD Offer blocks: name + price per plan. */
function claimsFromJsonLd(html, file, planNames) {
  const claims = [];
  const re = /\{"@type":"Offer","name":"([^"]+)","price":"([^"]+)"/g;
  let m = re.exec(html);
  while (m) {
    if (planNames.includes(m[1])) {
      claims.push({ kind: 'price', plan: m[1], period: 'monthly', value: parseNumber(m[2]), file, line: lineAt(html, m.index), text: `JSON-LD Offer "${m[1]}" price "${m[2]}"` });
    }
    m = re.exec(html);
  }
  return claims;
}

/**
 * Prose. Split into segments, keep only segments naming exactly one plan, and
 * read them as either a LADDER claim ("X starts on Pro") or a plain
 * attribution ("Advanced adds X").
 */
const LADDER_RE = /\b(?:start|starts|starting|begin|begins|included|include|includes|are|is|available)\b[^,;.]{0,30}?\b(?:on|from)\s+(?:the\s+)?$/i;

function claimsFromProse(src, file, planNames) {
  const claims = [];
  const noScript = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const blockRe = /<\/(?:li|p|td|th|h[1-6]|summary|figcaption)>|\n/gi;
  const parts = [];
  let last = 0;
  let b = blockRe.exec(noScript);
  while (b) {
    parts.push({ text: noScript.slice(last, b.index), index: last });
    last = b.index + b[0].length;
    b = blockRe.exec(noScript);
  }
  parts.push({ text: noScript.slice(last), index: last });

  for (const part of parts) {
    const flat = stripTags(part.text);
    if (!flat) continue;
    const line = lineAt(src, part.index);
    for (const seg of flat.split(/(?<=[.!?])\s+|;\s+|\s+—\s+|\s+-\s+/)) {
      const named = planNames.filter((n) => new RegExp(`\\b${n}\\b`).test(seg));
      if (named.length !== 1) continue;
      const plan = named[0];
      const at = seg.search(new RegExp(`\\b${plan}\\b`));
      const isLadder = LADDER_RE.test(seg.slice(0, at));

      for (const key of featuresIn(seg)) {
        claims.push({ kind: isLadder ? 'ladder' : 'feature', plan, key, included: true, file, line, text: `"${seg.trim().slice(0, 120)}"` });
      }
      claims.push(...limitClaimsIn(seg, plan, file, line, 'copy'));

      const mo = seg.match(/₹\s*([\d,]+)\s*(?:a|per|\/)\s*(?:month|mo)\b/i);
      if (mo) claims.push({ kind: 'price', plan, period: 'monthly', value: parseNumber(mo[1]), file, line, text: `"${seg.trim().slice(0, 120)}"` });
      const yr = seg.match(/₹\s*([\d,]+)\s*(?:a|per|\/)\s*(?:year|yr)\b/i);
      if (yr) claims.push({ kind: 'price', plan, period: 'yearly', value: parseNumber(yr[1]), file, line, text: `"${seg.trim().slice(0, 120)}"` });
    }
  }
  return claims;
}

/** The llms.txt plan-ladder markdown table. */
function claimsFromLlmsTable(txt, file, planNames) {
  const claims = [];
  const lines = txt.split('\n');
  let header = null;
  const COLS = {
    'menu items': 'menu_items',
    'staff logins': 'staff',
    tables: 'tables',
    outlets: 'businesses',
    'monthly orders': 'monthly_orders',
  };
  lines.forEach((raw, i) => {
    if (!raw.trim().startsWith('|')) { return; }
    const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
    if (/^-+$/.test(cells[0].replace(/[: ]/g, ''))) return;
    if (!planNames.includes(cells[0])) {
      if (/^plan$/i.test(cells[0])) header = cells.map((c) => c.toLowerCase());
      return;
    }
    if (!header) return;
    const plan = cells[0];
    const line = i + 1;
    cells.forEach((cell, ci) => {
      const col = header[ci];
      if (col === 'monthly' || col === 'yearly') {
        const period = col === 'monthly' ? 'monthly' : 'yearly';
        if (/^₹[\d,]+$/.test(cell)) {
          claims.push({ kind: 'price', plan, period, value: parseNumber(cell), file, line, text: `plan-ladder table ${col} "${cell}"` });
        } else if (/not offered/i.test(cell)) {
          claims.push({ kind: 'price', plan, period, value: null, file, line, text: `plan-ladder table ${col} "${cell}"` });
        }
        return;
      }
      const metric = COLS[col];
      if (!metric) return;
      claims.push({
        kind: 'limit',
        plan,
        metric,
        value: /unlimited/i.test(cell) ? -1 : parseNumber(cell),
        file,
        line,
        text: `plan-ladder table column "${col}" = "${cell}"`,
      });
    });
  });
  return claims;
}

/** Every claim the landing site makes, from every surface. */
function collectClaims(plans, landingDir = LANDING_DIR) {
  const planNames = plans.map((p) => p.name);
  const claims = [];
  const indexHtml = fs.readFileSync(path.join(landingDir, 'index.html'), 'utf8');
  const labelToKey = parseLabelTable(indexHtml);

  for (const file of PAGES) {
    const full = path.join(landingDir, file);
    if (!fs.existsSync(full)) continue;
    const html = fs.readFileSync(full, 'utf8');
    if (file === 'index.html') {
      claims.push(...claimsFromCompareTable(html, file, labelToKey));
      claims.push(...claimsFromPlanCards(html, file));
    }
    claims.push(...claimsFromPlanRows(html, file, planNames));
    claims.push(...claimsFromJsonLd(html, file, planNames));
    claims.push(...claimsFromProse(html, file, planNames));
  }

  const llmsPath = path.join(landingDir, LLMS_TXT);
  if (fs.existsSync(llmsPath)) {
    const txt = fs.readFileSync(llmsPath, 'utf8');
    claims.push(...claimsFromLlmsTable(txt, LLMS_TXT, planNames));
    claims.push(...claimsFromProse(txt, LLMS_TXT, planNames));
  }
  return claims;
}

// ══════════════════════════════════════════════════════════════════════════
// 5. THE CHECK
// ══════════════════════════════════════════════════════════════════════════

function checkClaims(plans, claims) {
  const byName = new Map(plans.map((p) => [p.name, p]));
  const order = plans.map((p) => p.name); // feed is ordered cheapest-first
  const violations = [];

  const fail = (c, problem, feedSays) => violations.push({
    plan: c.plan,
    file: c.file,
    line: c.line,
    claim: c.text,
    problem,
    feedSays,
    message: `${c.file}:${c.line} — ${c.plan}: ${problem}\n`
      + `    copy says : ${c.text}\n`
      + `    feed says : ${feedSays}`,
  });

  for (const c of claims) {
    const plan = byName.get(c.plan);
    if (!plan) continue;

    if (c.kind === 'feature' || c.kind === 'ladder') {
      const has = grants(plan, c.key);
      if (c.included && !has) {
        fail(c, `copy attributes "${c.key}" to ${c.plan}, which the plan does not grant`, `${describeGrant(plan, c.key)}. Plans with it: ${order.filter((n) => grants(byName.get(n), c.key)).join(', ') || 'none'}`);
      } else if (c.included === false && has) {
        fail(c, `copy says ${c.plan} does NOT include "${c.key}", but the plan grants it`, `${c.plan}.featureKeys contains ${c.key} — the copy under-sells a paid capability`);
      } else if (c.kind === 'ladder' && has) {
        // "X starts on <Plan>" also means no cheaper plan has X.
        const cheaper = order.slice(0, order.indexOf(c.plan)).filter((n) => grants(byName.get(n), c.key));
        if (cheaper.length) {
          fail(c, `copy says "${c.key}" starts on ${c.plan}, but cheaper plans already have it`, `${c.key} is also granted on: ${cheaper.join(', ')}`);
        }
      }
      continue;
    }

    if (c.kind === 'limit') {
      const actual = limitOf(plan, c.metric);
      if (c.value === null || actual === null) continue;
      if (c.value === -1 && actual !== -1) {
        fail(c, `copy calls ${c.metric} UNLIMITED on ${c.plan}, but the plan caps it`, `${c.plan}.limits.${c.metric} = ${describeLimit(actual)}`);
      } else if (c.value !== -1 && actual === -1) {
        fail(c, `copy caps ${c.metric} at ${c.value} on ${c.plan}, but the plan is uncapped`, `${c.plan}.limits.${c.metric} = ${describeLimit(actual)}`);
      } else if (c.value !== actual) {
        fail(c, `copy states ${c.metric} = ${c.value} on ${c.plan}`, `${c.plan}.limits.${c.metric} = ${describeLimit(actual)}`);
      }
      continue;
    }

    if (c.kind === 'price') {
      const actual = c.period === 'yearly' ? plan.priceYearlyInr : plan.priceInr;
      const norm = actual === null || actual === undefined ? null : actual;
      if (c.value !== norm) {
        fail(c, `copy states a ${c.period} price of ${c.value === null ? 'none' : `₹${c.value}`} for ${c.plan}`, `${c.plan} ${c.period} price = ${norm === null ? 'not offered (null)' : `₹${norm}`}`);
      }
      continue;
    }

    if (c.kind === 'note') {
      // A free-forever plan must never be described as a trial on its own card:
      // "7-day free trial" on Rs 0 reads as "this expires in a week".
      if ((plan.priceInr || 0) === 0 && /\d+\s*-?\s*day|free trial|trial\b/i.test(c.note)) {
        fail(c, 'card note describes a free-forever plan as a trial', `${c.plan} priceInr = 0 (free forever). The 7-day trial belongs to the PAID cards.`);
      }
      if ((plan.priceInr || 0) > 0 && /free forever/i.test(c.note)) {
        fail(c, 'card note says "free forever" on a paid plan', `${c.plan} priceInr = ₹${plan.priceInr}`);
      }
    }
  }
  return violations;
}

function formatReport(violations, claims, plans) {
  if (!violations.length) {
    return `marketing-claims: OK — ${claims.length} claims across `
      + `${PAGES.length + 1} files check out against ${plans.length} live plans.`;
  }
  const head = `marketing-claims: ${violations.length} claim(s) the plan feed contradicts\n`
    + `${'='.repeat(72)}`;
  return [head, ...violations.map((v, i) => `\n${i + 1}. ${v.message}`)].join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// 6. PLAN SOURCES + CLI
// ══════════════════════════════════════════════════════════════════════════

const SNAPSHOT = path.join(__dirname, '..', 'tests', 'fixtures', 'plan-feed.json');

function plansFromSnapshot(file = SNAPSHOT) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).plans;
}

async function plansFromLive(url = 'https://api.namastepos.in/v1/public/plans') {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const body = await res.json();
  if (!body.plans || !body.plans.length) throw new Error(`${url} returned no plans`);
  return body.plans;
}

async function main() {
  const live = process.argv.includes('--live');
  const asJson = process.argv.includes('--json');
  const plans = live ? await plansFromLive() : plansFromSnapshot();
  const claims = collectClaims(plans);
  const violations = checkClaims(plans, claims);
  const out = asJson
    ? JSON.stringify({ source: live ? 'live' : 'snapshot', claims: claims.length, violations }, null, 2)
    : `[${live ? 'LIVE api.namastepos.in' : 'pinned snapshot'}] ${formatReport(violations, claims, plans)}`;
  process.stdout.write(`${out}\n`);
  process.exit(violations.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`marketing-claims: ${e.message}\n`);
    process.exit(2);
  });
}

module.exports = {
  LANDING_DIR,
  PAGES,
  SNAPSHOT,
  grants,
  collectClaims,
  checkClaims,
  formatReport,
  plansFromSnapshot,
  plansFromLive,
};

// NamastePOS - "paste your menu" text parser (2026-09-05).
//
// THE PROBLEM IT SOLVES: the CSV importer and the /migrate wizard both assume
// the owner HAS an export from a previous system. A first-time owner, or one
// moving off paper, has nothing to export. What they DO have, almost always,
// is the menu as TEXT: a WhatsApp message they send to regulars, a typed list,
// a note on their phone. This turns that text into rows.
//
// WHAT THIS IS NOT: it is not OCR. A photo of a menu card goes nowhere near
// this function - photo import is deliberately out of scope, because a
// half-working OCR on a phone photo of a laminated card produces confident
// wrong prices, and a wrong price on a menu is worse than no menu.
//
// WHAT IT ACTUALLY DOES, honestly: it recognises "some words, then a number at
// the end of the line", plus section headers, plus the list decorations Indian
// menus are usually typed with. That covers the large majority of pasted
// menus. It does NOT understand two-column layouts, half/full price pairs
// (it takes the first price and flags the line), or prose. Everything it
// cannot read comes back in `unparsed` WITH THE ORIGINAL LINE, because the
// owner has to see what was dropped - silently swallowing three dishes is the
// failure mode that makes an owner distrust the whole product.
//
// The output is a PREVIEW. Nothing here writes to the database, and the rows
// the owner confirms are posted back through the ordinary POST /menu/bulk
// path, so the plan-cap pre-check and the all-or-nothing transaction still
// apply exactly as they do for a CSV.

// Anything a menu line can be decorated with before the item name:
//   "1." "1)" "01 -" "-" "*" "•" "▪" "→" "‣" "–"
const LEADER_RE = /^\s*(?:[-*•▪◦‣>→·–—]+\s*|\(?\d{1,3}[.)\]]\s+|\d{1,3}\s*[-–]\s+)/;

// WhatsApp export decoration: "[10:31, 05/09/2026] Shiv: Paneer Tikka 250"
const WA_PREFIX_RE = new RegExp(
  '^\\s*\\[?\\d{1,2}[:.]\\d{2}(?:\\s*[apAP][mM])?'
  + '(?:,\\s*\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})?'
  + '\\]?\\s*[-–]?\\s*(?:[^:]{1,40}:\\s*)?',
);

// A price at the END of the line. Handles:
//   "250"  "₹250"  "Rs 250"  "Rs. 250/-"  "INR 250"  "250/-"  "1,250"  "99.50"
// The separator between name and price may be spaces, dots ("...."), a dash,
// a colon, an equals, an at-sign, or a tab - all of which real menus use.
const TRAILING_PRICE_RE = new RegExp(
  '^(?<name>.*?)'
  + '[\\s.:\\-–—=@|\\t]*'
  + '(?:₹|Rs\\.?|INR|rs\\.?)?\\s*'
  + '(?<price>\\d{1,3}(?:,\\d{2,3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)'
  + '\\s*(?:/-|/\\s*-|\\-/)?\\s*$',
);

// Some menus put the price FIRST: "Rs. 120/- Nimbu Pani". Only accepted with
// an explicit currency marker — without one, "2 Samosa" would become a
// two-rupee samosa, and a wrong price is worse than a skipped line.
const LEADING_PRICE_RE = new RegExp(
  '^(?:₹|Rs\\.?|INR|rs\\.?)\\s*'
  + '(?<price>\\d{1,3}(?:,\\d{2,3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)'
  + '\\s*(?:/-)?[\\s.:\\-–—=|]*'
  + '(?<name>.+)$',
);

// Two prices on one line: "Paneer Butter Masala 180/320", "Dal 120 - 200".
// We take the FIRST and say so.
//
// A COMMA IS NOT A SEPARATOR HERE, deliberately: "Thali ₹1,250" would
// otherwise read as the two prices 1 and 250 and bill a 1,250-rupee thali at
// one rupee. Indian menus write thousands with commas far more often than they
// write two prices separated by one.
const TWO_PRICE_TAIL_RE = /(\d+(?:\.\d{1,2})?)\s*(?:\/|-|–|\|)\s*(\d+(?:\.\d{1,2})?)\s*(?:\/-)?\s*$/;

// Veg / non-veg markers people paste in front of names.
const DIET_MARKERS = [
  { re: /(^|\s)(?:\(v\)|\[v\]|🟢|🟩|●\s*veg\b)/i, isVeg: true },
  { re: /(^|\s)(?:\(nv\)|\[nv\]|🔴|🟥|●\s*non[-\s]?veg\b)/i, isVeg: false },
];

// Unicode property escapes rather than an explicit \u0900-\u097F range: the
// Devanagari block contains combining marks, and a literal range over them is
// both a lint error (no-misleading-character-class) and subtly wrong. \p{L}
// covers Latin, Devanagari, Tamil, Bengali and every other script an Indian
// menu is typed in, which is what we actually mean by "has a name in it".
const HAS_LETTER = /\p{L}/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Pasted menus almost always end with a phone number ("Order on 98765 43210",
// "Call 9876543210"). Without this guard that line parses as a dish called
// "Order on 98765" priced at 43,210 rupees, which is the single most likely
// piece of nonsense to appear in a real paste. Ten digits in a row, optionally
// broken by one space or dash, and an optional +91.
const PHONE_RE = /(?:\+?91[\s-]?)?\b\d{5}[\s-]?\d{5}\b|\b\d{10}\b/;

// A price still stuck INSIDE the item name, with more words after it, almost
// always means a two-column layout: "Paneer Tikka 250   Chicken Tikka 320".
// The negative look-ahead spares portions ("Thali 250 gm", "Biryani 500 ml"),
// which are one dish, not two. A trailing number with nothing after it is just
// a name — Chicken 65 — and is not matched at all.
const TWO_COLUMN_HINT_RE = new RegExp(
  '\\d{2,}\\s+'
  + '(?!(?:gms?|kgs?|ml|ltrs?|litres?|liters?|pcs?|pieces?|nos?|mins?|inch(?:es)?)\\b)'
  + '\\p{L}',
  'iu',
);

const HEADER_PUNCT_RE = /^[\s*_~=#>+.:•\-–—]+|[\s*_~=#>+.:•\-–—]+$/g;

/** Strip zero-width characters and normalise whitespace. */
function tidy(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this look like a SECTION HEADER rather than an item?
 *
 * Deliberately conservative: a header has no price, is short, and carries one
 * of the signals people actually type - a trailing colon, ALL CAPS, wrapping
 * asterisks/dashes, or a known section word. A bare short line with none of
 * those (e.g. a dish whose price the owner forgot) is NOT promoted to a
 * header, because swallowing a dish into a category name loses it silently.
 */
const SECTION_WORDS = new RegExp(
  '^(?:starters?|appetizers?|soups?|salads?|snacks?|chaat|tandoor(?:i)?|kebabs?|'
  + 'main\\s*course|mains?|curr(?:y|ies)|gravy|gravies|veg(?:etarian)?|non[-\\s]?veg(?:etarian)?|'
  + 'rice|biryani|noodles?|chinese|breads?|rotis?|naan|thali|combos?|meals?|'
  + 'desserts?|sweets?|ice\\s*cream|beverages?|drinks?|soft\\s*drinks?|mocktails?|cocktails?|'
  + 'shakes?|juices?|tea|chai|coffee|beer|wine|spirits?|liquor|bar|extras?|sides?|add[-\\s]?ons?|'
  + 'specials?|today.?s\\s*special|menu|breakfast|lunch|dinner|tiffin|dosa|idli|pizza|burgers?|'
  + 'rolls?|wraps?|sandwich(?:es)?|momos?|pastr(?:y|ies)|cakes?|cookies?)\\b',
  'i',
);

function looksLikeHeader(line) {
  const bare = line.replace(HEADER_PUNCT_RE, '').trim();
  if (!bare) return false;
  if (bare.length > 40) return false;
  if (/\d/.test(bare) && !SECTION_WORDS.test(bare)) return false;
  const endedWithColon = /:\s*$/.test(line);
  const wrapped = /^[*_~=#-]{1,3}.+[*_~=#-]{1,3}$/.test(line.trim());
  const allCaps = bare === bare.toUpperCase() && /[A-Z]/.test(bare) && bare.length >= 3;
  const wordy = bare.split(' ').length <= 4;
  return !!(endedWithColon || wrapped || (allCaps && wordy) || (SECTION_WORDS.test(bare) && wordy));
}

/** Title-case a name the owner typed in SHOUTING CAPS; leave mixed case alone. */
function normaliseName(name) {
  const n = name.replace(HEADER_PUNCT_RE, '').trim();
  if (!n) return '';
  const letters = n.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) {
    return n.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }
  return n;
}

function extractDiet(name) {
  let out = name;
  let isVeg;
  for (const m of DIET_MARKERS) {
    if (m.re.test(out)) {
      isVeg = m.isVeg;
      out = out.replace(m.re, ' ');
    }
  }
  return { name: out.replace(/\s+/g, ' ').trim(), isVeg };
}

/**
 * Parse a pasted menu into preview rows.
 *
 * @param {string} text        raw pasted text
 * @param {object} [opts]
 * @param {string} [opts.defaultCategory='Menu'] category for lines that appear
 *   before any section header
 * @param {number} [opts.maxLines=2000] hard stop so a pasted novel cannot
 *   burn CPU; extra lines are reported, not silently dropped
 * @returns {{
 *   items: Array<{ name, price, category, isVeg, line, lineNo, confidence, note }>,
 *   unparsed: Array<{ lineNo, line, reason }>,
 *   categories: string[],
 *   stats: { lines, parsed, headers, skipped, truncated }
 * }}
 *
 * NEVER THROWS. Garbage in gives `{ items: [], unparsed: [...] }`, which is
 * what the preview screen needs in order to say "we could not read any of
 * this" instead of showing a 500.
 */
function parseMenuText(text, opts = {}) {
  const defaultCategory = tidy(opts.defaultCategory) || 'Menu';
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 2000;

  const items = [];
  const unparsed = [];
  const categories = [];
  let headers = 0;
  let truncated = 0;

  const rawLines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
  if (rawLines.length > maxLines) {
    truncated = rawLines.length - maxLines;
    rawLines.length = maxLines;
  }

  let category = defaultCategory;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const original = String(rawLines[i] == null ? '' : rawLines[i]);
    try {
      let line = tidy(original);
      if (!line) continue;

      // Drop WhatsApp export chrome before anything else.
      const waStripped = line.replace(WA_PREFIX_RE, '');
      if (waStripped && waStripped !== line && HAS_LETTER.test(waStripped)) {
        line = tidy(waStripped);
      }
      // A pure separator row ("-----", "=====", "***").
      if (!HAS_LETTER_OR_DIGIT.test(line)) continue;

      line = tidy(line.replace(LEADER_RE, ''));
      if (!line) continue;

      // "Order on 98765 43210" / "Call 9876543210 to order" — the last line of
      // almost every pasted menu. Reported, never parsed.
      if (PHONE_RE.test(line)) {
        unparsed.push({ lineNo, line: original.trim(), reason: 'Looks like a phone number, not an item' });
        continue;
      }

      let m = TRAILING_PRICE_RE.exec(line);
      let priceFirst = false;
      if (!m || !m.groups.name || !tidy(m.groups.name)) {
        const lead = LEADING_PRICE_RE.exec(line);
        if (lead && tidy(lead.groups.name)) { m = lead; priceFirst = true; }
      }
      if (!m || !m.groups.name || !tidy(m.groups.name)) {
        if (looksLikeHeader(line)) {
          const label = normaliseName(line);
          if (label) {
            category = label;
            if (!categories.includes(category)) categories.push(category);
            headers++;
            continue;
          }
        }
        unparsed.push({
          lineNo,
          line: original.trim(),
          reason: /\d/.test(line)
            ? 'Could not find a price at the end of the line'
            : 'No price on this line',
        });
        continue;
      }

      const price = Number(String(m.groups.price).replace(/,/g, ''));
      if (!Number.isFinite(price) || price < 0 || price > 1000000) {
        unparsed.push({ lineNo, line: original.trim(), reason: 'Price is not a usable number' });
        continue;
      }

      // Two prices (half / full). Take the FIRST, and say so on the row so the
      // owner sees the other one is missing rather than discovering it at the
      // counter. `TRAILING_PRICE_RE` grabbed the LAST number and left the
      // first one stuck on the end of the name ("Paneer 180/"), so when the
      // line really has two we re-cut the name at the price pair.
      let confidence = 'high';
      let note = null;
      let finalPrice = price;
      let rawName = m.groups.name;
      // A price-first line has no trailing price at all, so the half/full
      // re-cut below must not run on it.
      const two = priceFirst ? null : TWO_PRICE_TAIL_RE.exec(line);
      if (two) {
        const first = Number(two[1]);
        const second = Number(two[2]);
        // Both have to look like money. `>= 5` throws out the numbering
        // artefact "Item 1 - 250", which is a single dish, not a price pair.
        if (Number.isFinite(first) && first >= 5 && second >= 5 && first !== second) {
          finalPrice = first;
          confidence = 'low';
          note = `Two prices found (${first} and ${second}). Kept ${first} - add the other as a variant.`;
          rawName = line.slice(0, two.index);
        }
      }

      const diet = extractDiet(rawName);
      const name = normaliseName(diet.name);
      if (!name || !HAS_LETTER.test(name)) {
        unparsed.push({ lineNo, line: original.trim(), reason: 'No item name before the price' });
        continue;
      }
      if (!two && name.length <= 2) confidence = 'low';
      // A price still stuck inside the NAME almost always means a two-column
      // layout ("Paneer Tikka 250   Chicken Tikka 320") — we kept the last
      // price and quietly lost the first item. We cannot split it reliably, so
      // we flag it loudly instead of pretending the row is clean.
      // Must be a number with MORE WORDS AFTER IT: "Paneer Tikka 250 Chicken
      // Tikka". A trailing number is part of the dish's name far more often
      // than not — Chicken 65, Thali 250 gm, Maggi 2 Min — and flagging those
      // would make the warning noise the owner learns to ignore.
      // ...and the word after the number must not be a UNIT: "Thali 250 gm",
      // "Biryani 500 ml" and "Cake 500 gms" are one dish with its portion in
      // the name, not two columns.
      if (TWO_COLUMN_HINT_RE.test(name)) {
        confidence = 'low';
        note = note
          || 'This line may hold two items side by side. Check the name and price, and add the second item yourself.';
      }

      items.push({
        name: name.slice(0, 255),
        price: Math.round(finalPrice * 100) / 100,
        category: category.slice(0, 50),
        isVeg: diet.isVeg,
        line: original.trim(),
        lineNo,
        confidence,
        note,
      });
      if (!categories.includes(category)) categories.push(category);
    } catch (err) {
      // One weird line must never take the whole paste down.
      unparsed.push({ lineNo, line: original.trim().slice(0, 200), reason: 'Could not read this line' });
    }
  }

  return {
    items,
    unparsed,
    categories,
    stats: {
      lines: rawLines.length,
      parsed: items.length,
      headers,
      skipped: unparsed.length,
      truncated,
    },
  };
}

module.exports = { parseMenuText };

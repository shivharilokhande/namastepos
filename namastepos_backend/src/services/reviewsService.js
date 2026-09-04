// Reviews aggregation (FF-1001).
// Pulls from Google + Zomato + Swiggy public review pages OR API where
// available. Schema-stable; fetchers stub when keys missing.

const https = require('https');
const { query } = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

async function listReviews(businessId, { source, limit = 50 } = {}) {
  const where = ['business_id = $1'];
  const values = [businessId]; let idx = 2;
  if (source) { where.push(`source = $${idx++}`); values.push(source); }
  values.push(limit);
  const r = await query(
    `SELECT * FROM reviews WHERE ${where.join(' AND ')}
      ORDER BY posted_at DESC NULLS LAST LIMIT $${idx}`,
    values,
  );
  return r.rows;
}

async function reviewStats(businessId) {
  const r = await query(
    `SELECT source, COUNT(*)::int AS n, AVG(rating)::float AS avg_rating
       FROM reviews WHERE business_id = $1
       GROUP BY source`,
    [businessId],
  );
  const overall = await query(
    'SELECT AVG(rating)::float AS avg, COUNT(*)::int AS n FROM reviews WHERE business_id = $1',
    [businessId],
  );
  return { sources: r.rows, overall: overall.rows[0] };
}

async function postReply(businessId, reviewId, replyText) {
  const r = await query(
    `UPDATE reviews SET reply = $1, reply_at = NOW()
      WHERE business_id = $2 AND id = $3 RETURNING *`,
    [replyText, businessId, reviewId],
  );
  return r.rows[0];
}

async function ingestReview(businessId, body) {
  // Used by cron worker or admin webhook
  await query(
    `INSERT INTO reviews (business_id, source, external_id, rating,
                          reviewer_name, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id, source, external_id) DO NOTHING`,
    [businessId, body.source, body.externalId, body.rating,
      body.reviewerName, body.body, body.postedAt || new Date()],
  );
}

// 2026-08-25 (founder: "add google map link in settings") — pull the
// place_id out of a pasted Google Maps URL. Two URL shapes actually carry
// one: an explicit place_id=/place_id: param (Maps API-style links) and the
// ChIJ… token embedded in long share-link data blobs. Short links
// (maps.app.goo.gl) and pin/coordinate links carry NO place id — we
// deliberately do NOT follow redirects or fall back to a Places Text Search
// guess: a name-based match can silently pick a different restaurant and
// ingest a stranger's reviews, which is worse than asking the owner for the
// real Place ID. The route surfaces our `message` for exactly that case.
function extractPlaceIdFromUrl(url) {
  if (!url) return null;
  const explicit = url.match(/place_id[=:]([A-Za-z0-9_-]{10,})/);
  if (explicit) return explicit[1];
  const chij = url.match(/(ChIJ[A-Za-z0-9_-]{10,})/);
  if (chij) return chij[1];
  return null;
}

// 2026-08-30: follow a shortened maps.app.goo.gl / goo.gl/maps link to its real
// target and pull the Place ID out of the EXPANDED url or landing HTML. This is
// safe (it resolves the OWNER's own link to its exact place — no fuzzy name
// search that could grab a stranger's reviews, which the block above warns
// against). Best-effort: any network hiccup returns null and the caller falls
// back to the "paste the full link / enter Place ID" message.
function _resolveShortLink(shortUrl) {
  return new Promise((resolve) => {
    let hops = 0;
    const visit = (u) => {
      if (hops++ > 5) return resolve(null);
      let parsed;
      try { parsed = new URL(u); } catch (_) { return resolve(null); }
      const req = https.request({
        hostname: parsed.hostname,
        path: (parsed.pathname || '/') + (parsed.search || ''),
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NamastePOS/1.0)' },
      }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          return visit(loc.startsWith('http') ? loc : `https://${parsed.hostname}${loc}`);
        }
        let body = '';
        res.on('data', (c) => { if (body.length < 300000) body += c; });
        res.on('end', () => resolve({ finalUrl: u, body }));
      });
      req.setTimeout(6000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    };
    visit(shortUrl);
  });
}

// Resolve a Place ID from a maps URL that carries only a name + coordinates
// (the common case for a "Share" short link, which expands to
// /maps/place/<Name>/@<lat>,<lng>/...!3d<lat>!4d<lng>). We ask Places
// "Find Place From Text" for the name, BIASED to the exact coordinates from
// the owner's own link — so it returns that specific place, not a same-named
// one elsewhere. Returns the ChIJ… place_id or null.
function _placeIdFromNameAndCoords(expandedUrl, apiKey) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve(null);
    const nameM = expandedUrl.match(/\/maps\/place\/([^/@]+)/);
    if (!nameM) return resolve(null);
    const name = decodeURIComponent(nameM[1]).replace(/\+/g, ' ').trim();
    if (!name) return resolve(null);
    // Prefer the precise place pin (!3d<lat>!4d<lng>); fall back to the @lat,lng
    // viewport centre.
    const pin = expandedUrl.match(/!3d(-?[0-9.]+)!4d(-?[0-9.]+)/)
      || expandedUrl.match(/@(-?[0-9.]+),(-?[0-9.]+)/);
    const params = new URLSearchParams({
      input: name, inputtype: 'textquery', fields: 'place_id', key: apiKey,
    });
    if (pin) params.set('locationbias', `point:${pin[1]},${pin[2]}`);
    const req = https.request({
      hostname: 'maps.googleapis.com',
      path: `/maps/api/place/findplacefromtext/json?${params.toString()}`,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.candidates && j.candidates[0] ? j.candidates[0].place_id : null);
        } catch (_) { resolve(null); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Real fetcher: Google Places API "place details" endpoint with reviews.
// Config lives on the businesses row (migration 061: google_place_id +
// google_maps_url), saved from the dashboard Settings "Google reviews" card
// via PATCH /auth/me. (2026-08-25 fix: this used to query platform_settings
// scoped by business_id — but that table is platform-global KV with no
// business_id column, so the lookup could never match.) Zomato and Swiggy
// don't expose review APIs publicly, so for those sources we still rely on
// operator manual entry / forwarded emails.
//
// LIMITATION: the Places Details API returns at most the 5 "most relevant"
// reviews per call — there is no paging. Repeated fetches accumulate
// history over time via the (business_id, source, external_id) unique
// constraint, but this will never mirror the full Google review list.
async function fetchAllProviders(businessId) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    // Graceful: self-hosted / staging installs without a Places key get a
    // clear reason instead of an error toast.
    logger.info(`Reviews fetch ${businessId}: no GOOGLE_PLACES_API_KEY — skipping live fetch`);
    return {
      fetched: 0,
      reason: 'not_configured',
      message: 'Google reviews are not configured on this server (missing GOOGLE_PLACES_API_KEY).',
    };
  }

  const bizRow = await query(
    'SELECT google_place_id, google_maps_url FROM businesses WHERE id = $1 LIMIT 1',
    [businessId],
  );
  const biz = bizRow.rows[0] || {};
  let placeId = biz.google_place_id || null;

  // No stored Place ID yet — try to derive one from the pasted Maps link.
  if (!placeId && biz.google_maps_url) {
    placeId = extractPlaceIdFromUrl(biz.google_maps_url);
    // Shortened links (maps.app.goo.gl / goo.gl) carry no id inline — follow
    // the redirect to the real target and extract from the expanded URL/HTML.
    if (!placeId && /(?:maps\.app\.goo\.gl|goo\.gl)/.test(biz.google_maps_url)) {
      const resolved = await _resolveShortLink(biz.google_maps_url);
      if (resolved) {
        // 1) Exact id in the expanded URL / HTML, if present.
        placeId = extractPlaceIdFromUrl(resolved.finalUrl)
          || extractPlaceIdFromUrl(resolved.body || '');
        // 2) Share links usually only carry name + coords → resolve via a
        //    coordinate-biased Places lookup on the owner's own link.
        if (!placeId) {
          placeId = await _placeIdFromNameAndCoords(resolved.finalUrl, apiKey);
        }
      }
    }
    if (placeId) {
      // Persist the resolved ID so future fetches (and npsService's
      // write-a-review link) skip re-parsing the URL.
      await query(
        'UPDATE businesses SET google_place_id = $1 WHERE id = $2',
        [placeId, businessId],
      );
    } else {
      logger.info(`Reviews fetch ${businessId}: maps URL has no extractable place_id`);
      return {
        fetched: 0,
        reason: 'no_place_id',
        message: 'Could not find a Place ID in that Google Maps link. Please paste the full '
          + 'share link from Google Maps (not a shortened maps.app.goo.gl link), or enter '
          + 'your Place ID directly in Settings → Google reviews.',
      };
    }
  }

  if (!placeId) {
    logger.info(`Reviews fetch ${businessId}: no google_place_id configured`);
    return {
      fetched: 0,
      reason: 'no_place_id',
      message: 'Add your Google Maps link or Place ID in Settings → Google reviews first.',
    };
  }

  let data;
  try {
    const r = await require('axios').get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      {
        params: { place_id: placeId, fields: 'reviews,rating,user_ratings_total', key: apiKey },
        timeout: 8000,
      },
    );
    data = r.data;
  } catch (err) {
    logger.warn(`Reviews fetch ${businessId} failed: ${err.message}`);
    return { fetched: 0, error: err.message };
  }

  // Places returns HTTP 200 with an in-body status for API-level failures
  // (INVALID_REQUEST, NOT_FOUND on a bad place_id, REQUEST_DENIED on key
  // problems…) — surface those instead of silently reporting 0 fetched.
  if (data?.status && data.status !== 'OK') {
    logger.warn(`Reviews fetch ${businessId}: Places status ${data.status}`);
    return {
      fetched: 0,
      reason: 'places_error',
      message: `Google Places error: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`,
    };
  }

  const reviews = data?.result?.reviews || [];
  let inserted = 0;
  for (const rv of reviews) {
    try {
      await ingestReview(businessId, {
        source: 'google',
        // Places has no stable review id in this API shape; time+author is
        // stable per review, and uq_review (business_id, source,
        // external_id) dedupes re-fetches via ON CONFLICT DO NOTHING.
        externalId: `g_${rv.time}_${rv.author_name}`,
        rating: rv.rating,
        reviewerName: rv.author_name,
        body: rv.text,
        postedAt: new Date(rv.time * 1000),
      });
      inserted += 1;
    } catch (e) { /* duplicates land here — already deduped via ON CONFLICT */ }
  }
  logger.info(`Reviews fetch ${businessId}: ingested ${inserted} from Google`);
  return {
    fetched: inserted,
    source: 'google',
    rating: data?.result?.rating ?? null,
    totalRatings: data?.result?.user_ratings_total ?? null,
  };
}

module.exports = { listReviews, reviewStats, postReply, ingestReview, fetchAllProviders };

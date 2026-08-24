// Reviews aggregation (FF-1001).
// Pulls from Google + Zomato + Swiggy public review pages OR API where
// available. Schema-stable; fetchers stub when keys missing.

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
    values
  );
  return r.rows;
}

async function reviewStats(businessId) {
  const r = await query(
    `SELECT source, COUNT(*)::int AS n, AVG(rating)::float AS avg_rating
       FROM reviews WHERE business_id = $1
       GROUP BY source`,
    [businessId]
  );
  const overall = await query(
    `SELECT AVG(rating)::float AS avg, COUNT(*)::int AS n FROM reviews WHERE business_id = $1`,
    [businessId]
  );
  return { sources: r.rows, overall: overall.rows[0] };
}

async function postReply(businessId, reviewId, replyText) {
  const r = await query(
    `UPDATE reviews SET reply = $1, reply_at = NOW()
      WHERE business_id = $2 AND id = $3 RETURNING *`,
    [replyText, businessId, reviewId]
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
     body.reviewerName, body.body, body.postedAt || new Date()]
  );
}

// Real fetcher: Google Places API "place details" endpoint with reviews.
// To use: set GOOGLE_PLACES_API_KEY in env, and store the place_id per
// business in platform_settings.kv (key: "google_place_id"). Zomato and
// Swiggy don't expose review APIs publicly, so for those sources we still
// rely on operator manual entry / forwarded emails.
async function fetchAllProviders(businessId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.info(`Reviews fetch ${businessId}: no GOOGLE_PLACES_API_KEY — skipping live fetch`);
    return { fetched: 0, reason: 'no_api_key' };
  }

  // Resolve place_id from platform_settings KV
  const placeIdRow = await query(
    `SELECT value FROM platform_settings
      WHERE business_id = $1 AND key = 'google_place_id' LIMIT 1`,
    [businessId]
  );
  if (placeIdRow.rowCount === 0) {
    logger.info(`Reviews fetch ${businessId}: no google_place_id configured`);
    return { fetched: 0, reason: 'no_place_id' };
  }
  const placeId = placeIdRow.rows[0].value;

  let data;
  try {
    const r = await require('axios').get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      {
        params: { place_id: placeId, fields: 'reviews,rating,user_ratings_total', key: apiKey },
        timeout: 8000,
      }
    );
    data = r.data;
  } catch (err) {
    logger.warn(`Reviews fetch ${businessId} failed: ${err.message}`);
    return { fetched: 0, error: err.message };
  }

  const reviews = data?.result?.reviews || [];
  let inserted = 0;
  for (const rv of reviews) {
    try {
      await ingestReview(businessId, {
        source: 'google',
        externalId: `g_${rv.time}_${rv.author_name}`,   // Google reuses this hash
        rating: rv.rating,
        reviewerName: rv.author_name,
        body: rv.text,
        postedAt: new Date(rv.time * 1000),
      });
      inserted += 1;
    } catch (e) { /* duplicates land here — already deduped via ON CONFLICT */ }
  }
  logger.info(`Reviews fetch ${businessId}: ingested ${inserted} from Google`);
  return { fetched: inserted, source: 'google' };
}

module.exports = { listReviews, reviewStats, postReply, ingestReview, fetchAllProviders };

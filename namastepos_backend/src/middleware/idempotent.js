// NamastePOS backend — generic request-level idempotency (NP-401, 2026-09-04)
//
// WHY THIS EXISTS
// The Flutter offline outbox (lib/services/offline_outbox.dart) replays every
// queued write until it gets a 2xx. That is correct behaviour for a POS on
// Indian restaurant wifi — but it is only SAFE if the write is idempotent.
// Until now exactly three mutations were: order-create (orders.client_id
// unique), expenses (expenses.client_key, migration 073) and membership
// subscribe (membership_subscriptions.client_key, migration 070). Every other
// queued mutation could double-apply whenever the server COMMITTED and only
// the response was lost — timeout, app killed, tunnel dropped. The retry then
// ran the handler a second time: stock decremented twice, a refund paid twice,
// loyalty points granted twice, a duplicate wastage/tip/reservation row.
//
// Rather than add a client-key column to a dozen more tables, this is ONE
// server-side dedup table (migration 085: idempotency_keys) behind ONE
// middleware, applied per route.
//
// THE CONTRACT
//   1. Key source: the `Idempotency-Key` request HEADER (preferred), else
//      `body.clientKey` for the two endpoints whose Joi schema already
//      accepts it. A header means NO request body changes — `validate()` runs
//      with allowUnknown:false, so an extra body field would be a hard 400.
//   2. NO key  → pass straight through, untouched. Every existing client
//      (dashboard, admin, older app builds, curl) keeps its exact behaviour.
//   3. Key present → claim (business_id, key, endpoint) with a single
//      INSERT ... ON CONFLICT DO NOTHING RETURNING. The INSERT *is* the lock,
//      so two concurrent retries cannot both pass a SELECT-then-INSERT gate.
//   4. Claim won  → run the handler. On a 2xx we store the response body +
//      status before the bytes are flushed, so the very next retry replays
//      instead of racing. On ANY non-2xx (validation error, 409, a 500 from a
//      rolled-back transaction) we RELEASE the claim — a genuine retry must be
//      able to actually retry. This mirrors razorpayService.handleWebhook,
//      which deletes its webhook_events row on failure for the same reason.
//   5. Claim lost + a stored response exists → replay it VERBATIM (same status
//      code, same body, plus `Idempotency-Replayed: true`) and never run the
//      handler.
//   6. Claim lost + NO stored response → the first attempt is still in flight.
//      Respond 409 + `Retry-After` so the client comes back later. Deliberately
//      NOT a 2xx: acking here would tell the client "saved" while the winner
//      may still fail and roll back, and the write would be lost forever. Same
//      reasoning as the webhook path returning { pending: true } → HTTP 409.
//
// TENANT SCOPING: business_id is part of the primary key, so the same client
// uuid seen for two businesses is two independent requests and BOTH run. The
// businessId comes from req.params (already validated by
// requireBusinessOwnership upstream), never from client-supplied body data.

const { query } = require('../config/db');
const logger = require('../config/logger');
const { BadRequest } = require('../utils/errors');

const HEADER = 'idempotency-key';

// Matches the VARCHAR(64) column. A uuid v4 is 36 chars; the floor of 8 keeps
// a client from sending something like "1" and believing it is protected.
const KEY_RE = /^[A-Za-z0-9._:-]{8,64}$/;

// How long an unfinished claim is honoured before another attempt may take it
// over. Guards the one failure this table cannot otherwise recover from: the
// node dies (OOM, SIGKILL, Render redeploy) between claiming and responding,
// leaving a row with status_code NULL that would 409 every retry until the
// nightly sweep 7 days later.
//
// Deliberately GENEROUS (10 min): taking a claim over while the first attempt
// is genuinely still running would re-run the side effect, which is the exact
// bug this file exists to prevent. The outbox retries every 30s, so a wedged
// key self-heals on its own within a minute of the window opening.
const TAKEOVER_MS = Math.max(
  60_000,
  parseInt(process.env.IDEMPOTENCY_TAKEOVER_MS || '600000', 10) || 600_000,
);

const RETRY_AFTER_SECONDS = 2;

/**
 * Pulls the idempotency key off the request. Returns null when the caller sent
 * none (→ the gate is skipped entirely). Throws BadRequest for a key that is
 * present but unusable, because silently ignoring it would leave the client
 * believing it has a guarantee it does not have.
 */
function readKey(req) {
  const header = req.get ? req.get(HEADER) : null;
  const fromBody = req.body && typeof req.body.clientKey === 'string'
    ? req.body.clientKey
    : null;
  const raw = (typeof header === 'string' && header.trim())
    ? header.trim()
    : (fromBody ? fromBody.trim() : '');
  if (!raw) return null;
  if (!KEY_RE.test(raw)) {
    throw new BadRequest(
      'Idempotency-Key must be 8-64 chars of [A-Za-z0-9._:-] (a uuid is ideal)',
    );
  }
  return raw;
}

async function storeResponse(businessId, key, endpoint, body, statusCode) {
  await query(
    `UPDATE idempotency_keys
        SET response = $1, status_code = $2
      WHERE business_id = $3 AND key = $4 AND endpoint = $5`,
    [body === undefined ? null : body, statusCode, businessId, key, endpoint],
  );
}

async function releaseClaim(businessId, key, endpoint) {
  await query(
    `DELETE FROM idempotency_keys
      WHERE business_id = $1 AND key = $2 AND endpoint = $3
        AND status_code IS NULL`,
    [businessId, key, endpoint],
  );
}

/**
 * Wraps res.end so the dedup row is settled BEFORE the response bytes leave
 * the process. Doing it here rather than on the 'finish' event is what makes
 * the guarantee real: with a post-flush hook, a client that retries the
 * instant it sees the response could arrive before the row was written and
 * slip past the gate.
 *
 * res.end is the single funnel for BOTH outcomes — res.json() on the happy
 * path and errorHandler's res.status().json() on the failure path — so one
 * patch covers success (store) and error (release).
 */
function armCapture(res, { businessId, key, endpoint }) {
  const originalEnd = res.end.bind(res);
  let settled = false;

  res.end = function patchedEnd(chunk, encoding, cb) {
    if (settled) return originalEnd(chunk, encoding, cb);
    settled = true;
    const statusCode = res.statusCode;
    const ok = statusCode >= 200 && statusCode < 300;
    const flush = () => originalEnd(chunk, encoding, cb);

    let body = null;
    if (ok && chunk) {
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        body = JSON.parse(text);
      } catch (_) {
        // Not JSON (a CSV/attachment route). We still record the status so a
        // retry is a no-op rather than a re-run; the replay just carries no
        // body. These routes are reads, so this branch is defensive only.
        body = null;
      }
    }

    const settle = ok
      ? storeResponse(businessId, key, endpoint, body, statusCode)
      : releaseClaim(businessId, key, endpoint);

    settle.then(flush, (err) => {
      // Never fail the request over bookkeeping — the caller's write already
      // committed (or already failed). Log loudly: an unstored 2xx means the
      // next retry re-runs the handler, which is the bug this file prevents.
      logger.error(
        `[idempotency] ${ok ? 'store' : 'release'} failed for ${endpoint} `
        + `key=${key}: ${err.message}`,
      );
      flush();
    });
    return res;
  };
}

/**
 * Route middleware factory.
 *
 * @param {string} endpoint Stable route label, e.g. 'PUT /menu/:itemId/stock'.
 *   Part of the primary key, so it must NOT contain per-request values —
 *   otherwise every attempt claims a different row and nothing dedupes. Kept
 *   explicit rather than derived from req.route because req.baseUrl carries the
 *   businessId and Express's mergeParams mounts make the derived value differ
 *   between the same handler reached via two mounts.
 *
 * Mount it AFTER the auth / role / feature gates (so an unauthorised call never
 * touches the table) and BEFORE the handler. Either side of validate() is
 * correct: placed after, a Joi 400 never claims a key at all; placed before —
 * which is what the routes whose controller exports `[validate, handler]` have
 * to do — the claim is simply RELEASED when the 400 goes out, so a corrected
 * retry with the same key still runs. The only position that would be wrong is
 * after the handler.
 */
function idempotent(endpoint) {
  if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 120) {
    throw new Error('idempotent(endpoint) needs a stable label of <= 120 chars');
  }
  return function idempotencyGate(req, res, next) {
    let key;
    try {
      key = readKey(req);
    } catch (err) {
      return next(err);
    }
    if (!key) return next(); // back-compat: no key, no gate

    const businessId = req.params && req.params.businessId;
    // Every route this is mounted on is business-scoped. No businessId means
    // the mount is wrong; fail open rather than 500 a working endpoint.
    if (!businessId) {
      logger.warn(`[idempotency] no businessId on ${endpoint} — gate skipped`);
      return next();
    }

    return (async () => {
      // The claim. ON CONFLICT DO NOTHING makes the INSERT itself the lock, so
      // two simultaneous retries cannot both proceed.
      const claim = await query(
        `INSERT INTO idempotency_keys (business_id, key, endpoint)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING created_at`,
        [businessId, key, endpoint],
      );
      if (claim.rowCount === 1) {
        armCapture(res, { businessId, key, endpoint });
        return next();
      }

      const prior = await query(
        `SELECT response, status_code, created_at
           FROM idempotency_keys
          WHERE business_id = $1 AND key = $2 AND endpoint = $3`,
        [businessId, key, endpoint],
      );
      const row = prior.rows[0];

      if (!row) {
        // The winner failed and released between our INSERT and this SELECT.
        // The write genuinely has not happened, so re-claim and run it.
        const reclaim = await query(
          `INSERT INTO idempotency_keys (business_id, key, endpoint)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING created_at`,
          [businessId, key, endpoint],
        );
        if (reclaim.rowCount === 1) {
          armCapture(res, { businessId, key, endpoint });
          return next();
        }
        return inFlight(res, endpoint, key);
      }

      if (row.status_code != null) {
        // Replay the first successful response verbatim.
        res.set('Idempotency-Replayed', 'true');
        return res.status(row.status_code).json(
          row.response === null || row.response === undefined ? {} : row.response,
        );
      }

      // Still in flight. Take the claim over only once the window has passed
      // (see TAKEOVER_MS) — that only happens when the first attempt's process
      // died without ever settling the row.
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (ageMs > TAKEOVER_MS) {
        const taken = await query(
          `UPDATE idempotency_keys
              SET created_at = NOW()
            WHERE business_id = $1 AND key = $2 AND endpoint = $3
              AND status_code IS NULL
              AND created_at < NOW() - ($4::int * INTERVAL '1 millisecond')
            RETURNING created_at`,
          [businessId, key, endpoint, TAKEOVER_MS],
        );
        if (taken.rowCount === 1) {
          logger.warn(
            `[idempotency] abandoned claim on ${endpoint} key=${key} `
            + `(${Math.round(ageMs / 1000)}s old) taken over`,
          );
          armCapture(res, { businessId, key, endpoint });
          return next();
        }
      }
      return inFlight(res, endpoint, key);
    })().catch(next);
  };
}

function inFlight(res, endpoint, key) {
  logger.info(`[idempotency] ${endpoint} key=${key} still in flight → 409`);
  res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  return res.status(409).json({
    error: 'IDEMPOTENT_IN_FLIGHT',
    message: 'An identical request is still being processed — retry shortly.',
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });
}

/**
 * Retention sweep (called from cronWorker's 02:02 IST heavy block). Keys are
 * only useful for as long as a client might still retry; 7 days is far beyond
 * the outbox's ~25 min retry budget and leaves a comfortable audit window.
 */
async function sweep(retentionDays) {
  const days = Math.max(
    1,
    parseInt(retentionDays || process.env.IDEMPOTENCY_RETENTION_DAYS || '7', 10) || 7,
  );
  const r = await query(
    `DELETE FROM idempotency_keys
      WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [days],
  );
  return { deleted: r.rowCount, retentionDays: days };
}

module.exports = idempotent;
module.exports.idempotent = idempotent;
module.exports.sweep = sweep;
module.exports.HEADER = HEADER;

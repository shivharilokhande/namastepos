// NamastePOS backend — ONE Redis pub/sub bus for every process-local cache.
//
// Why this exists (security review 2026-09-04, item 1)
// ----------------------------------------------------
// Several hot paths keep a small in-process Map with a short TTL: the auth
// membership cache (role + permissions), the admin `is_active` cache, the
// admin RBAC role cache, and the plan-feature cache. That is the right call
// for latency — but it means a revocation performed on instance A is invisible
// to instance B until B's own TTL lapses. On a single instance the TTL is the
// only staleness; on a multi-instance deploy an invalidation is simply lost.
//
// featureService solved this first with its own ioredis pub/sub pair. Rather
// than grow a second, third and fourth pair (four caches × 2 connections is a
// lot of sockets for one process, and a lot of places to get the fallback
// wrong), this module is that same mechanism generalised: ONE publisher, ONE
// subscriber, many topics. featureService now rides on it too.
//
// Contract
//   subscribe(topic, fn)     fn(payload) runs whenever anybody publishes topic
//   publish(topic, payload)  runs LOCAL handlers immediately, then fans out to
//                            the other instances over Redis
//
// Behaviour with NO Redis configured (local dev, and prod until REDIS_URL is
// set) is exactly today's: local handlers still fire the instant a write
// happens, so a single instance is always correct; there is no fan-out, and
// remote instances fall back to their TTL. Nothing throws, and ioredis is
// lazy-required so it is never loaded unless REDIS_URL is present.
//
// Invalidation is best-effort by design: a Redis hiccup must never fail the
// business write that triggered it. Every publish path swallows its errors.

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');

// One channel, many topics — keeps us to a single subscription.
const CHANNEL = 'namastepos:cache:invalidate';

// Identifies this process so we ignore the echo of our own publish (Redis
// delivers a published message to every subscriber, including the publisher).
// The handlers are all idempotent deletes, so a double-run would be harmless;
// skipping it just avoids pointless work.
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

/**
 * Topic names. Keep them here so a typo is a missing export, not a silently
 * dead invalidation.
 *   MEMBERSHIP  payload { businessId, userId }  — userId '*' = whole business
 *   ADMIN_USER  payload adminId (string)        — role / is_active changed
 *   FEATURE     payload businessId (string)     — '*' = every business
 */
const TOPIC = {
  MEMBERSHIP: 'membership',
  ADMIN_USER: 'adminUser',
  FEATURE: 'feature',
};

const _handlers = new Map(); // topic → Set<fn>
let _pub = null;
let _subReady = false;

function _dispatch(topic, payload) {
  const set = _handlers.get(topic);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (e) {
      logger.warn(`[cacheBus] handler for '${topic}' threw: ${e.message}`);
    }
  }
}

(function initRedis() {
  if (!env.REDIS_URL) return; // single-instance mode — TTL only, as before
  try {
    // eslint-disable-next-line global-require
    const Redis = require('ioredis');
    _pub = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    _pub.on('error', (e) => logger.warn(`[cacheBus] redis pub error: ${e.message}`));

    const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
    sub.on('error', (e) => logger.warn(`[cacheBus] redis sub error: ${e.message}`));
    sub.subscribe(CHANNEL)
      .then(() => {
        _subReady = true;
        logger.info(`[cacheBus] subscribed to ${CHANNEL} (instance ${INSTANCE_ID})`);
      })
      .catch((e) => logger.warn(`[cacheBus] subscribe failed: ${e.message}`));
    sub.on('message', (_ch, raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return; // not ours / corrupt — ignore
      }
      if (!msg || typeof msg.topic !== 'string') return;
      if (msg.from === INSTANCE_ID) return; // our own publish already ran locally
      _dispatch(msg.topic, msg.payload);
    });
  } catch (e) {
    _pub = null;
    logger.warn(`[cacheBus] redis disabled (ioredis missing or bad REDIS_URL): ${e.message}`);
  }
}());

/** Register a local invalidation handler. Returns an unsubscribe function. */
function subscribe(topic, fn) {
  if (!_handlers.has(topic)) _handlers.set(topic, new Set());
  _handlers.get(topic).add(fn);
  return () => { _handlers.get(topic)?.delete(fn); };
}

/**
 * Invalidate everywhere. Local handlers run synchronously (so the instance
 * that performed the write is correct immediately, Redis or not); the fan-out
 * to other instances is fire-and-forget.
 *
 * NOTE we publish whenever a publisher connection exists — we do NOT wait for
 * our own subscription to be ready. ioredis queues commands while connecting
 * and flushes on connect, so an invalidation during startup still lands.
 */
function publish(topic, payload) {
  _dispatch(topic, payload);
  if (!_pub) return;
  try {
    _pub.publish(CHANNEL, JSON.stringify({ topic, payload, from: INSTANCE_ID }))
      .catch(() => { /* best effort — never fail the caller's write */ });
  } catch (_) { /* ditto */ }
}

/** For /admin/health/platform — is cross-instance invalidation actually live? */
function status() {
  return {
    configured: !!env.REDIS_URL,
    ready: _subReady,
    instanceId: INSTANCE_ID,
    topics: [..._handlers.keys()],
  };
}

module.exports = {
  subscribe, publish, status, TOPIC, CHANNEL,
};

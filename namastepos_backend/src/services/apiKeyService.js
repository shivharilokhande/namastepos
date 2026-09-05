// NamastePOS backend — tenant API keys (round-2 fix batch 2026-09-06, CONTRACTS §3)
//
// WHY THIS EXISTS
// `api_access` was sold on Enterprise and enforced nowhere (entitlements review
// 2026-09-05: "no key issuance, no key auth path, nothing that reads this key").
// This service is the issuance half; middleware/auth.js `requireAuth` is the
// auth half (accepts `X-API-Key: <secret>` on business routes as a READ-ONLY
// principal). The feature gate is `requireFeature('api_access')` on the routes
// AND a re-check in the auth path, so a plan that loses the key stops every
// existing key at once (403 API_ACCESS_NOT_IN_PLAN) without the owner having to
// revoke anything.
//
// SECRETS
// The secret is `npk_live_<32 base62 chars>` — shown exactly once in the POST
// response. Only sha256(secret) is stored (`key_hash`), plus a short `prefix`
// so the owner can tell keys apart in the list. A leaked database dump
// therefore yields nothing usable; sha256 (not bcrypt) is deliberate: the
// secret has 32 chars of base62 = ~190 bits of entropy, so a slow hash buys
// nothing and the auth path needs a cheap indexed lookup on every request.

const crypto = require('crypto');
const { query } = require('../config/db');
const {
  NotFound, Conflict, Unauthorized, Forbidden,
} = require('../utils/errors');

const SECRET_PREFIX = 'npk_live_';
const SECRET_RANDOM_LEN = 32;
const MAX_ACTIVE_KEYS = 10;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 32 unbiased base62 characters (rejection sampling, no modulo bias). */
function _randomBase62(len) {
  let out = '';
  while (out.length < len) {
    // 248 is the largest multiple of 62 below 256: reject bytes ≥ 248 so every
    // character is equally likely.
    const bytes = crypto.randomBytes(len);
    for (const b of bytes) {
      if (b < 248 && out.length < len) out += BASE62[b % 62];
    }
  }
  return out;
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

/** The display prefix stored alongside the hash: scheme + first 6 random chars. */
function prefixOf(secret) {
  return String(secret).slice(0, SECRET_PREFIX.length + 6);
}

function _serialize(row) {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
  };
}

/** Every key the business has ever issued, newest first (revoked ones included). */
async function list(businessId) {
  const r = await query(
    `SELECT id, label, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE business_id = $1
      ORDER BY created_at DESC`,
    [businessId],
  );
  return r.rows.map(_serialize);
}

/**
 * Issue a key. Returns { key, secret } — `secret` is the ONLY time the clear
 * value exists outside the caller's memory.
 */
async function issue(businessId, { label, createdBy = null } = {}) {
  const live = await query(
    'SELECT COUNT(*)::int AS c FROM api_keys WHERE business_id = $1 AND revoked_at IS NULL',
    [businessId],
  );
  if (live.rows[0].c >= MAX_ACTIVE_KEYS) {
    const err = new Conflict(
      `At most ${MAX_ACTIVE_KEYS} active API keys per business. Revoke one before issuing another.`,
    );
    err.code = 'API_KEY_LIMIT';
    throw err;
  }
  const secret = `${SECRET_PREFIX}${_randomBase62(SECRET_RANDOM_LEN)}`;
  const r = await query(
    `INSERT INTO api_keys (business_id, label, prefix, key_hash, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, label, prefix, created_at, last_used_at, revoked_at`,
    [businessId, String(label).trim(), prefixOf(secret), hashSecret(secret), createdBy],
  );
  return { key: _serialize(r.rows[0]), secret };
}

/** Soft-delete. 404 when the key is not this business's (tenant-scoped lookup). */
async function revoke(businessId, keyId) {
  const r = await query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1 AND business_id = $2
      RETURNING id`,
    [keyId, businessId],
  );
  if (r.rowCount === 0) throw new NotFound('API key not found');
  return true;
}

// ── Auth-path resolution ──────────────────────────────────────────────────

// `last_used_at` is informational; writing it on EVERY request would turn a
// read-only API into a write per call. One touch per key per minute is enough
// for "is this key still in use?" — best-effort, never awaited by the caller.
const LAST_USED_THROTTLE_MS = 60_000;
const _lastTouched = new Map(); // keyId → epoch ms

function _touchLastUsed(keyId) {
  const now = Date.now();
  const prev = _lastTouched.get(keyId) || 0;
  if (now - prev < LAST_USED_THROTTLE_MS) return;
  _lastTouched.set(keyId, now);
  query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyId])
    .catch(() => { /* best-effort */ });
}

/**
 * Resolve a presented secret to its key row. Throws 401 for unknown or
 * revoked secrets (indistinguishable on purpose — a revoked key must look
 * exactly like a wrong one to whoever is holding it).
 */
async function resolve(secret) {
  if (typeof secret !== 'string' || !secret.startsWith(SECRET_PREFIX)) {
    throw new Unauthorized('Invalid API key');
  }
  const r = await query(
    'SELECT id, business_id, revoked_at FROM api_keys WHERE key_hash = $1 LIMIT 1',
    [hashSecret(secret.trim())],
  );
  const row = r.rows[0];
  if (!row || row.revoked_at) throw new Unauthorized('Invalid or revoked API key');
  return { id: row.id, businessId: row.business_id };
}

/**
 * Plan check for a key principal — the entitlement half of the gate. Called
 * by the auth path on every key request so a downgrade cuts the key off at
 * once. Throws 403 API_ACCESS_NOT_IN_PLAN.
 */
async function assertPlanAllows(businessId) {
  const features = require('./featureService');
  const ok = await features.hasFeature(businessId, 'api_access');
  if (ok) return;
  const err = new Forbidden(
    'API access is not included in this plan. Upgrade to a plan with API access to use API keys.',
  );
  err.code = 'API_ACCESS_NOT_IN_PLAN';
  throw err;
}

// ── Per-key rate limit (600/min) ──────────────────────────────────────────
//
// Best-effort, in-process fixed window: one counter per key per minute. On a
// multi-instance deploy each node counts separately (so the effective cap is
// 600 × instances); prod is single-instance today and the global limiter in
// app.js still applies underneath. Documented rather than hidden: a Redis
// bucket is the upgrade path if that ever matters.
const RATE_LIMIT_PER_MIN = 600;
const _buckets = new Map(); // keyId → { windowStart, count }

function checkRateLimit(keyId, now = Date.now()) {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  let b = _buckets.get(keyId);
  if (!b || b.windowStart !== windowStart) {
    b = { windowStart, count: 0 };
    _buckets.set(keyId, b);
    // Opportunistic sweep so the Map cannot grow without bound.
    if (_buckets.size > 5000) {
      for (const [k, v] of _buckets) if (v.windowStart !== windowStart) _buckets.delete(k);
    }
  }
  b.count += 1;
  return {
    allowed: b.count <= RATE_LIMIT_PER_MIN,
    remaining: Math.max(0, RATE_LIMIT_PER_MIN - b.count),
    resetAt: windowStart + 60_000,
  };
}

/** TEST-INFRA: drop the throttle + rate-limit state between suites. */
function _resetStateForTests() {
  _lastTouched.clear();
  _buckets.clear();
}

module.exports = {
  SECRET_PREFIX,
  MAX_ACTIVE_KEYS,
  RATE_LIMIT_PER_MIN,
  hashSecret,
  list,
  issue,
  revoke,
  resolve,
  assertPlanAllows,
  checkRateLimit,
  touchLastUsed: _touchLastUsed,
  _resetStateForTests,
};

// NamastePOS — object storage service (2026-08-25).
//
// WHY: Render's free-tier disk is EPHEMERAL — every deploy/restart wipes
// the local ./uploads folder, so menu-item photos silently vanished.
// This service stores uploads in Cloudflare R2 (S3-compatible, zero
// egress fees) and serves them from the public bucket domain
// (images.namastepos.in).
//
// Zero new dependencies: R2 speaks the S3 API, and a single PUT object
// only needs AWS Signature V4, which is ~60 lines of node:crypto. If the
// R2_* env vars are absent (local dev), callers fall back to disk.
//
// Env contract (all required to enable R2):
//   R2_ACCOUNT_ID        — Cloudflare account id
//   R2_ACCESS_KEY_ID     — R2 API token access key
//   R2_SECRET_ACCESS_KEY — R2 API token secret
//   R2_BUCKET            — bucket name (namastepos-uploads)
//   R2_PUBLIC_URL        — public base, e.g. https://images.namastepos.in

const crypto = require('crypto');
const https = require('https');
const env = require('../config/env');
const logger = require('../config/logger');

function isR2Enabled() {
  return !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID
    && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL);
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * PUT an object into R2 via SigV4. `key` must already be URL-safe
 * (we only ever pass "<uuid-businessId>/<uuid>.<ext>").
 * Returns the public URL.
 */
function putObject(key, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const path = `/${env.R2_BUCKET}/${key}`;
    const region = 'auto';
    const service = 's3';
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(buffer);

    const canonicalHeaders = `content-type:${contentType}\n`
      + `host:${host}\n`
      + `x-amz-content-sha256:${payloadHash}\n`
      + `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT', path, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
    ].join('\n');

    let k = hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, dateStamp);
    k = hmac(k, region);
    k = hmac(k, service);
    k = hmac(k, 'aws4_request');
    const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');

    const req = https.request({
      host,
      path,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, `
          + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(`${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`);
        } else {
          logger.error('R2 putObject failed', { status: res.statusCode, body: body.slice(0, 300) });
          reject(new Error(`R2 upload failed (${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

module.exports = { isR2Enabled, putObject };

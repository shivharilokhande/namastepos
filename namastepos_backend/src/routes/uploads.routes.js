// Image upload route — backs the menu-item / business-logo picker on
// both dashboard and mobile (Push 6).
//
// Local-filesystem storage under <repo>/uploads/<businessId>/<uuid>.<ext>.
// In production this should be swapped for S3/Cloudinary; the route's
// response shape (`{ url }`) stays the same so the clients don't change.
//
// Endpoint:
//   POST /v1/businesses/:businessId/uploads   (multipart/form-data, file= ...)
//   → 201 { url, filename, size, mime }
//
// The static mount in app.js exposes /uploads/* publicly so clients can
// fetch the image back via the returned URL.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireBusinessOwnership } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

// AUDIT-S001 (P0): Authenticate every upload + verify the caller belongs to
// the business the upload is being attributed to. Before this guard, any
// unauthenticated caller could POST /v1/businesses/ANY_ID/uploads.
router.use(requireAuth, requireBusinessOwnership);

// AUDIT-S002 (P0): Reject any :businessId that isn't a real UUID, otherwise
// `..%2F..%2Fetc` in the URL would resolve outside UPLOAD_ROOT via
// path.join (classic path traversal).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AUDIT-S003 (P2): Map MIME → canonical extension so the filename can't be
// tricked by a malicious originalname like "evil.exe.jpg" — the saved file
// always lands with a known-good extension.
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
};

// Storage backend (2026-08-25): Cloudflare R2 when configured (production —
// Render's disk is ephemeral so local files vanish on every deploy),
// local disk otherwise (dev). R2 mode buffers in memory (5 MB cap) and
// PUTs via storageService; the response keeps the same `{ url }` shape,
// except the URL is absolute (https://images.namastepos.in/...).
const storageSvc = require('../services/storageService');

const diskStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const bid = req.params.businessId;
    if (!bid || !UUID_RE.test(bid)) {
      return cb(new Error('Invalid businessId'));
    }
    const dir = path.join(UPLOAD_ROOT, bid);
    // Defence in depth: confirm the resolved path is still inside UPLOAD_ROOT.
    const rootResolved = path.resolve(UPLOAD_ROOT);
    const dirResolved  = path.resolve(dir);
    if (!dirResolved.startsWith(rootResolved + path.sep)) {
      return cb(new Error('Path traversal blocked'));
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = MIME_EXT[file.mimetype] || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage: storageSvc.isR2Enabled() ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB cap
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG / PNG / WebP / GIF images are allowed'));
  },
});

router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'No file provided' });
  }
  const bid = req.params.businessId;

  if (storageSvc.isR2Enabled()) {
    // AUDIT-S002/S003 still hold: bid is a validated UUID and the key
    // extension is derived from the (allow-listed) MIME type.
    if (!UUID_RE.test(bid)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid businessId' });
    }
    const ext = MIME_EXT[req.file.mimetype] || '.jpg';
    const key = `${bid}/${uuidv4()}${ext}`;
    const url = await storageSvc.putObject(key, req.file.buffer, req.file.mimetype);
    return res.status(201).json({
      url,                            // absolute public URL (R2 custom domain)
      filename: key.split('/').pop(),
      size: req.file.size,
      mime: req.file.mimetype,
    });
  }

  // Dev fallback — local disk, relative URL served by the static mount.
  const url = `/uploads/${bid}/${req.file.filename}`;
  res.status(201).json({
    url,                              // relative; client prefixes with API origin
    filename: req.file.filename,
    size: req.file.size,
    mime: req.file.mimetype,
  });
}));

module.exports = router;

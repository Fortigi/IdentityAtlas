// Generic crawler file-upload + upload-schema endpoints.
//
// Files are stored under /data/uploads/{crawlerType}-{configId}/, which is a
// Docker volume (job_data) shared between the web container and the worker
// container. The worker reads the same path when running a job, so no file
// shipping is needed. Only crawler types that declare "supportsFileUploads"
// in their crawler.json may use these routes — see assertUploadableConfig.
//
// All endpoints require an authenticated user — the auth middleware is applied by
// the parent router mount in index.js.

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import multer from 'multer';
import { mkdir, readdir, stat, unlink, rm } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import * as db from '../db/connection.js';
import { CRAWLER_MANIFESTS_DIR, _crawlerManifests, VALID_JOB_TYPES } from '../crawlerManifests.js';
import { checkUploadCapacity, resolveUploadLimits, describeBytes } from '../lib/uploadCapacity.js';

const router = Router();
const gate = requirePermission('admin.csv-import');

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || '/data/uploads';

// The per-file cap (UPLOAD_MAX_FILE_BYTES, default 8 GiB). Resolved once: multer
// enforces it and GET /admin/crawler-uploads/limits reports it, so the two can
// never disagree.
const MAX_FILE_BYTES = resolveUploadLimits().maxFileBytes;

function configFolder(crawlerType, configId) {
  return join(UPLOAD_ROOT, `${crawlerType}-${configId}`);
}

// Validate that the configId is a positive integer to prevent path traversal.
function parseConfigId(req, res) {
  const id = parseInt(req.params.configId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid configId' });
    return null;
  }
  return id;
}

// Reject an upload WITHOUT the browser reporting it as a network failure.
//
// Every guard on the upload route runs before the request body is read.
// Answering a request whose body is still arriving makes Node destroy the
// socket, and the browser then reports "TypeError: Failed to fetch" — the JSON
// explanation never reaches the user. That is how an upload refused for a
// perfectly clear reason ("Crawler config not found", "not enough free space")
// surfaces in the wizard as an unexplained network error.
//
// Draining the body first costs the upload's bandwidth, but only on the
// rejection path, and buys an error the user can act on. The reason is logged
// too: the launcher console is where an operator looks when the UI says nothing.
function rejectUpload(req, res, status, error) {
  console.warn(`Upload rejected (${status}): ${error}`);
  const send = () => { if (!res.headersSent) res.status(status).json({ error }); };
  if (req.readableEnded) { send(); return null; }
  req.resume();            // discard the body so the client can finish sending
  req.on('end', send);
  req.on('error', send);   // client gave up mid-body — nothing left to answer to
  return null;
}

// Ensure the config exists and its crawler type declares file-upload support
// before letting anyone touch its files. Returns the crawler type on success
// (callers need it to resolve the config's folder), or null after sending an
// error response. `req` is passed on the upload path so a refusal can drain the
// body first; the GET/DELETE callers have no body and omit it.
async function assertUploadableConfig(configId, res, req = null) {
  try {
    const pool = await db.getPool();
    const r = await pool.query(`SELECT "crawlerType" FROM "CrawlerConfigs" WHERE id = $1`, [configId]);
    if (r.rows.length === 0) {
      if (req) return rejectUpload(req, res, 404, 'Crawler config not found');
      res.status(404).json({ error: 'Crawler config not found' });
      return null;
    }
    const crawlerType = r.rows[0].crawlerType;
    if (!_crawlerManifests[crawlerType]?.supportsFileUploads) {
      if (req) return rejectUpload(req, res, 400, 'This crawler type does not support file uploads');
      res.status(400).json({ error: 'This crawler type does not support file uploads' });
      return null;
    }
    return crawlerType;
  } catch (err) {
    console.error('assertUploadableConfig failed:', err.message);
    if (req) return rejectUpload(req, res, 500, 'Database error');
    res.status(500).json({ error: 'Database error' });
    return null;
  }
}

// Sanitize incoming filename — strip any path components, keep only the basename.
function sanitizeFilename(name) {
  const base = basename(name).replace(/[\x00-\x1f]/g, '').trim();
  if (!base || base.startsWith('.') || base.includes('..')) return null;
  return base;
}

// Multer storage: write files into the per-config folder. The folder is created
// lazily inside the destination callback so we don't need to pre-create it before
// the request arrives. req._crawlerType is stashed by the route-level guard below
// (already did the DB lookup for assertUploadableConfig — no need to query twice).
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const configId = parseInt(req.params.configId, 10);
      if (!Number.isInteger(configId) || configId <= 0) return cb(new Error('Invalid configId'));
      const dir = configFolder(req._crawlerType, configId);
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safe = sanitizeFilename(file.originalname);
    if (!safe) return cb(new Error(`Unsafe filename: ${file.originalname}`));
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: {
    // Per-file bound, configurable via UPLOAD_MAX_FILE_BYTES (default 8 GiB). A
    // fixed 1 GB here rejected a 1.8 GB / 40-million-row entitlement extract, and
    // the real protection against filling the volume is the free-space reserve in
    // refuseWithoutCapacity(), which runs before the body is accepted.
    fileSize: MAX_FILE_BYTES,
    files: 50,
  },
  fileFilter: (req, file, cb) => {
    // Allowed extensions come from the crawler's own manifest. Block anything
    // else to avoid the upload folder turning into a generic file dump.
    const extensions = _crawlerManifests[req._crawlerType]?.uploadFileExtensions || ['.csv'];
    const lowerName = file.originalname.toLowerCase();
    if (extensions.some(ext => lowerName.endsWith(ext.toLowerCase()))) return cb(null, true);
    cb(new Error(`File type not allowed (rejected: ${file.originalname}). Allowed: ${extensions.join(', ')}`));
  },
});

// ─── The upload limit, for the wizards ──────────────────────────────────────
// The server owns the per-file cap; a wizard asks for it rather than carrying its
// own copy. A copy drifted once already: the CSV wizard kept a 1 GB constant
// after the server's default rose to 8 GiB, so a 1.8 GB export was refused in the
// browser and never sent.
router.get('/admin/crawler-uploads/limits', gate, (req, res) => {
  res.json({ maxFileBytes: MAX_FILE_BYTES });
});

// ─── List uploaded files for a config ───────────────────────────────────────
router.get('/admin/crawler-configs/:configId/files', gate, async (req, res) => {
  const configId = parseConfigId(req, res);
  if (configId === null) return;
  const crawlerType = await assertUploadableConfig(configId, res);
  if (!crawlerType) return;

  // `folder` is where a job reads this config's files from. A file copied straight
  // into it is picked up exactly like an uploaded one — for a multi-GB export on
  // the machine that runs Identity Atlas, a local copy beats a browser upload. It
  // is always the config's own folder under UPLOAD_ROOT: no path is taken from
  // the caller, so reporting it widens nothing.
  const dir = configFolder(crawlerType, configId);
  if (!existsSync(dir)) return res.json({ files: [], folder: dir });

  try {
    const entries = await readdir(dir);
    const files = await Promise.all(entries.map(async (name) => {
      const s = await stat(join(dir, name));
      return { name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
    }));
    res.json({ files: files.sort((a, b) => a.name.localeCompare(b.name)), folder: dir });
  } catch (err) {
    console.error('File list failed:', err.message);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Refuse an upload the volume can't hold (free-space reserve / optional quota —
// see lib/uploadCapacity.js). Sends the response and returns true when refused.
async function refuseWithoutCapacity(req, res, crawlerType, configId) {
  try {
    const refusal = await checkUploadCapacity({
      root: UPLOAD_ROOT,
      folder: configFolder(crawlerType, configId),
      incomingBytes: parseInt(req.get('content-length'), 10),
      limits: resolveUploadLimits(),
    });
    if (!refusal) return false;
    // Drain before answering: this runs while the body is still arriving, and a
    // bare response there reaches the browser as "Failed to fetch".
    rejectUpload(req, res, refusal.status, refusal.error);
  } catch (err) {
    console.error('Upload capacity check failed:', err.message);
    rejectUpload(req, res, 500, 'Failed to check upload capacity');
  }
  return true;
}

// ─── Upload one or more files ────────────────────────────────────────────────
// Field name: "files" (multiple). Existing files with the same name are overwritten
// by multer's diskStorage (it just opens the destination for write).
router.post(
  '/admin/crawler-configs/:configId/files',
  gate,
  async (req, res, next) => {
    const configId = parseConfigId(req, res);
    if (configId === null) return;
    const crawlerType = await assertUploadableConfig(configId, res, req);
    if (!crawlerType) return;
    if (await refuseWithoutCapacity(req, res, crawlerType, configId)) return;
    req._crawlerType = crawlerType;
    next();
  },
  (req, res) => {
    upload.array('files', 50)(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') {
        // multer's own text is "File too large" — name the limit, and where it is set.
        return res.status(413).json({
          error: `A file is larger than the ${describeBytes(MAX_FILE_BYTES)} per-file upload limit. An administrator can raise it with UPLOAD_MAX_FILE_BYTES.`,
          maxFileBytes: MAX_FILE_BYTES,
        });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      const uploaded = (req.files || []).map(f => ({ name: f.filename, sizeBytes: f.size }));
      res.json({ uploaded, count: uploaded.length });
    });
  }
);

// ─── Delete a single uploaded file ───────────────────────────────────────────
router.delete('/admin/crawler-configs/:configId/files/:filename', gate, async (req, res) => {
  const configId = parseConfigId(req, res);
  if (configId === null) return;
  const crawlerType = await assertUploadableConfig(configId, res);
  if (!crawlerType) return;

  const safe = sanitizeFilename(req.params.filename);
  if (!safe) return res.status(400).json({ error: 'Invalid filename' });

  const path = join(configFolder(crawlerType, configId), safe);
  try {
    if (existsSync(path)) await unlink(path);
    res.json({ deleted: safe });
  } catch (err) {
    console.error('File delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ─── Delete all files for a config (called when the config itself is removed) ─
export async function deleteConfigFolder(crawlerType, configId) {
  const dir = configFolder(crawlerType, configId);
  if (!existsSync(dir)) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove ${dir}:`, err.message);
  }
}

// Resolve the absolute upload folder path for a config (used by the job runner).
export function getUploadFolderPath(crawlerType, configId) {
  return configFolder(crawlerType, configId);
}

// ─── Upload schema templates ─────────────────────────────────────────────────
// GET /api/admin/crawlers/:type/upload-schema — serves a crawler's empty
// template files (tools/crawlers/<type>/schema/*) as a single concatenated
// response. The UI's "Download templates" button uses this. Mirrors the
// discover.js loading pattern: no core file lists which crawlers have
// templates, a missing/empty schema/ dir just 404s.
//
// Optional tools/crawlers/<type>/<type>-slots.json (e.g. csv-slots.json)
// supplies label/required annotations in the comment above each file's
// header, if present — purely cosmetic, the templates work without it.
function readSlotsManifest(type) {
  try {
    return JSON.parse(readFileSync(join(CRAWLER_MANIFESTS_DIR, type, `${type}-slots.json`), 'utf8'));
  } catch {
    return null;
  }
}

function isValidType(type) {
  return /^[a-z][a-z0-9-]*$/.test(type) && VALID_JOB_TYPES.includes(type);
}

// Which extensions a crawler's schema/ folder may contain — same manifest
// field the upload multer filter uses, so a crawler only has to declare its
// format once. Falls back to ['.csv'] for crawlers that don't declare it
// (today, that's just csv itself).
function schemaExtensionsFor(type) {
  return _crawlerManifests[type]?.uploadFileExtensions || ['.csv'];
}

// Generic extension -> MIME type lookup for serving a single template file
// as itself, not assuming every crawler's templates are CSV. Unknown
// extensions fall back to a generic binary type rather than guessing.
const MIME_BY_EXTENSION = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
};
export function mimeTypeFor(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

router.get('/admin/crawlers/:type/upload-schema', gate, (req, res) => {
  const { type } = req.params;
  if (!isValidType(type)) return res.status(404).json({ error: `Unknown crawler type: ${type}` });

  const schemaDir = join(CRAWLER_MANIFESTS_DIR, type, 'schema');
  const extensions = schemaExtensionsFor(type);
  let files;
  try {
    files = readdirSync(schemaDir)
      .filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext.toLowerCase())))
      .sort();
  } catch {
    return res.status(404).json({ error: `Crawler '${type}' has no upload schema` });
  }
  if (files.length === 0) return res.status(404).json({ error: `Crawler '${type}' has no upload schema` });

  // A human-readable digest of all templates concatenated as text — only
  // meaningful for text-based template formats (true of every crawler with
  // schema files today). Each template is expected to be header-only (no
  // data rows), so including the whole trimmed file rather than "just the
  // first line" is both more correct for a hypothetical multi-line template
  // and produces identical output for today's single-line CSV templates.
  const slots = readSlotsManifest(type) || [];
  const lines = [];
  for (const file of files) {
    const slot = slots.find(s => s.file.toLowerCase() === file.toLowerCase());
    const label = slot ? ` — ${slot.label}${slot.required ? ' (REQUIRED)' : ' (optional)'}` : '';
    const content = readFileSync(join(schemaDir, file), 'utf8').trim();
    lines.push(`# ${file}${label}`);
    lines.push(content);
    lines.push('');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="identity-atlas-${type}-schema.txt"`);
  res.send(lines.join('\n'));
});

router.get('/admin/crawlers/:type/upload-schema/:filename', gate, (req, res) => {
  const { type } = req.params;
  if (!isValidType(type)) return res.status(404).json({ error: `Unknown crawler type: ${type}` });

  const filename = basename(req.params.filename);
  const filePath = join(CRAWLER_MANIFESTS_DIR, type, 'schema', filename);
  let content;
  try {
    // Raw bytes, no text decoding — correct for any template format, not
    // just line-delimited text ones.
    content = readFileSync(filePath);
  } catch {
    return res.status(404).json({ error: 'Unknown template file' });
  }
  res.setHeader('Content-Type', mimeTypeFor(filename));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

export default router;

// CSV crawler file upload endpoints.
//
// Files are stored under /data/uploads/csv-{configId}/, which is a Docker volume
// (job_data) shared between the web container and the worker container. The worker
// reads the same path when running a CSV crawler job, so no file shipping is needed.
//
// All endpoints require an authenticated user — the auth middleware is applied by
// the parent router mount in index.js.

import { Router } from 'express';
import multer from 'multer';
import { mkdir, readdir, stat, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import * as db from '../db/connection.js';

const router = Router();

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || '/data/uploads';

// File names recognised by the CSV crawler. The wizard auto-maps uploaded files to
// these slots based on filename match (case-insensitive). Users can manually fix
// mismatches in the wizard before saving.
// Identity Atlas canonical CSV schema. Each slot matches a file defined in
// tools/csv-templates/schema/. The filenames and column names are fixed —
// source-specific mapping happens via a pre-import transform script.
export const CSV_FILE_SLOTS = [
  { key: 'systems',              file: 'Systems.csv',              label: 'Systems',                required: false },
  { key: 'contexts',             file: 'Contexts.csv',             label: 'Contexts (Org Units)',   required: false },
  { key: 'resources',            file: 'Resources.csv',            label: 'Resources',              required: true  },
  { key: 'resourceRelationships',file: 'ResourceRelationships.csv',label: 'Resource Relationships', required: false },
  { key: 'users',                file: 'Users.csv',                label: 'Users',                  required: true  },
  { key: 'assignments',          file: 'Assignments.csv',          label: 'Assignments',            required: true  },
  { key: 'identities',           file: 'Identities.csv',           label: 'Identities',             required: false },
  { key: 'identityMembers',      file: 'IdentityMembers.csv',      label: 'Identity Members',       required: false },
  { key: 'certifications',       file: 'Certifications.csv',       label: 'Certifications',         required: false },
];

function configFolder(configId) {
  return join(UPLOAD_ROOT, `csv-${configId}`);
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

// Ensure the config exists and is a CSV crawler before letting anyone touch its files.
async function assertCsvConfig(configId, res) {
  try {
    const pool = await db.getPool();
    const r = await pool.request().input('id', configId)
      .query(`SELECT "crawlerType" FROM "CrawlerConfigs" WHERE id = @id`);
    if (r.recordset.length === 0) {
      res.status(404).json({ error: 'Crawler config not found' });
      return false;
    }
    if (r.recordset[0].crawlerType !== 'csv') {
      res.status(400).json({ error: 'Config is not a CSV crawler' });
      return false;
    }
    return true;
  } catch (err) {
    console.error('assertCsvConfig failed:', err.message);
    res.status(500).json({ error: 'Database error' });
    return false;
  }
}

// Sanitize incoming filename — strip any path components, keep only the basename.
// We then normalise the case so that "users.csv" matches "Users.csv" in the slot map.
function sanitizeFilename(name) {
  const base = basename(name).replace(/[\x00-\x1f]/g, '').trim();
  if (!base || base.startsWith('.') || base.includes('..')) return null;
  return base;
}

// Multer storage: write files into the per-config folder. The folder is created
// lazily inside the destination callback so we don't need to pre-create it before
// the request arrives.
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const configId = parseInt(req.params.configId, 10);
      if (!Number.isInteger(configId) || configId <= 0) return cb(new Error('Invalid configId'));
      const dir = configFolder(configId);
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
    fileSize: 200 * 1024 * 1024, // 200 MB per file
    files: 50,
  },
  fileFilter: (req, file, cb) => {
    // Accept only .csv (case-insensitive). Block anything else to avoid the upload
    // folder turning into a generic file dump.
    if (/\.csv$/i.test(file.originalname)) return cb(null, true);
    cb(new Error(`Only .csv files allowed (rejected: ${file.originalname})`));
  },
});

// ─── List uploaded files for a CSV config ───────────────────────────────────
router.get('/admin/crawler-configs/:configId/csv-files', async (req, res) => {
  const configId = parseConfigId(req, res);
  if (configId === null) return;
  if (!(await assertCsvConfig(configId, res))) return;

  const dir = configFolder(configId);
  if (!existsSync(dir)) return res.json({ files: [] });

  try {
    const entries = await readdir(dir);
    const files = await Promise.all(entries.map(async (name) => {
      const s = await stat(join(dir, name));
      return { name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
    }));
    res.json({ files: files.sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (err) {
    console.error('CSV list failed:', err.message);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// ─── Upload one or more CSV files ────────────────────────────────────────────
// Field name: "files" (multiple). Existing files with the same name are overwritten
// by multer's diskStorage (it just opens the destination for write).
router.post(
  '/admin/crawler-configs/:configId/csv-files',
  async (req, res, next) => {
    const configId = parseConfigId(req, res);
    if (configId === null) return;
    if (!(await assertCsvConfig(configId, res))) return;
    next();
  },
  (req, res) => {
    upload.array('files', 50)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      const uploaded = (req.files || []).map(f => ({ name: f.filename, sizeBytes: f.size }));
      res.json({ uploaded, count: uploaded.length });
    });
  }
);

// ─── Delete a single uploaded file ───────────────────────────────────────────
router.delete('/admin/crawler-configs/:configId/csv-files/:filename', async (req, res) => {
  const configId = parseConfigId(req, res);
  if (configId === null) return;
  if (!(await assertCsvConfig(configId, res))) return;

  const safe = sanitizeFilename(req.params.filename);
  if (!safe) return res.status(400).json({ error: 'Invalid filename' });

  const path = join(configFolder(configId), safe);
  try {
    if (existsSync(path)) await unlink(path);
    res.json({ deleted: safe });
  } catch (err) {
    console.error('CSV delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ─── Delete all files for a config (called when the config itself is removed) ─
export async function deleteConfigFolder(configId) {
  const dir = configFolder(configId);
  if (!existsSync(dir)) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove ${dir}:`, err.message);
  }
}

// Resolve the absolute folder path for a CSV config (used by the job runner).
export function getCsvFolderPath(configId) {
  return configFolder(configId);
}

// GET /api/admin/csv-schema — serves the schema template CSV files as a
// single concatenated response. The UI uses this for the "Download templates"
// button. Each file is separated by a header line so the user can split them
// or just read the column names as documentation.
// Schema headers embedded directly so they're available in the Docker image
// without needing to COPY the tools/ folder into the backend container.
const SCHEMA_HEADERS = {
  'Systems.csv':              'ExternalId;DisplayName;SystemType;Description',
  'Contexts.csv':             'ExternalId;DisplayName;ContextType;Description;ParentExternalId;SystemName',
  'Resources.csv':            'ExternalId;DisplayName;ResourceType;Description;SystemName;Enabled',
  'ResourceRelationships.csv':'ParentExternalId;ChildExternalId;RelationshipType;SystemName',
  'Users.csv':                'ExternalId;DisplayName;Email;PrincipalType;JobTitle;Department;ManagerExternalId;SystemName;Enabled',
  'Assignments.csv':          'ResourceExternalId;UserExternalId;AssignmentType;SystemName',
  'Identities.csv':           'ExternalId;DisplayName;Email;EmployeeId;Department;JobTitle',
  'IdentityMembers.csv':      'IdentityExternalId;UserExternalId;AccountType',
  'Certifications.csv':       'ExternalId;ResourceExternalId;UserDisplayName;Decision;ReviewerDisplayName;ReviewedDateTime',
};

router.get('/admin/csv-schema', (_req, res) => {
  const lines = [];
  for (const slot of CSV_FILE_SLOTS) {
    const header = SCHEMA_HEADERS[slot.file] || '(unknown)';
    lines.push(`# ${slot.file} — ${slot.label}${slot.required ? ' (REQUIRED)' : ' (optional)'}`);
    lines.push(header);
    lines.push('');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="identity-atlas-csv-schema.txt"');
  res.send(lines.join('\n'));
});

router.get('/admin/csv-schema/:filename', (req, res) => {
  const filename = basename(req.params.filename);
  const slot = CSV_FILE_SLOTS.find(s => s.file.toLowerCase() === filename.toLowerCase());
  if (!slot) return res.status(404).json({ error: 'Unknown template file' });
  const header = SCHEMA_HEADERS[slot.file];
  if (!header) return res.status(404).json({ error: 'Schema not available' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slot.file}"`);
  res.send(header + '\n');
});

export default router;

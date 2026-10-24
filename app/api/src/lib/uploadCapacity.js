// Disk-capacity guard for crawler file uploads (SEC-2026-09 L-13).
//
// Uploads land on the shared job_data volume, which also holds the vault master
// key, the built-in worker key and job logs. The per-file cap lives here too
// (UPLOAD_MAX_FILE_BYTES) because a real export can be far larger than any round
// number guessed up front: an IdentityIQ entitlement-assignment extract of 40
// million rows is ~1.8 GB, and a 1 GB cap rejected it outright. The cap is a
// sanity bound, not the safety mechanism — the free-space reserve below is what
// actually stops an upload filling the disk. Before accepting a request we check
// that:
//   1. the volume keeps at least UPLOAD_MIN_FREE_BYTES free after this upload
//      (default 1 GiB) — so uploads can never fill the disk; and
//   2. optionally, a config's folder stays under UPLOAD_CONFIG_QUOTA_BYTES
//      (default 0 = no per-config quota).
// The incoming size is the request's Content-Length (multipart overhead
// included), which browsers always send for file uploads.

import { statfs as fsStatfs, readdir, stat } from 'fs/promises';
import { join } from 'path';

export const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;
// 8 GiB. High enough that a genuine full-table export lands, low enough to stay a
// bound. Raise with UPLOAD_MAX_FILE_BYTES; the free-space reserve still applies.
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

// A byte count as an operator reads it in a refusal: "8.0 GiB". Binary units,
// matching how the limits are configured.
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
export function describeBytes(n) {
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${BYTE_UNITS[i]}`;
}

function nonNegativeInt(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function resolveUploadLimits(env = process.env) {
  return {
    minFreeBytes: nonNegativeInt(env.UPLOAD_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES),
    configQuotaBytes: nonNegativeInt(env.UPLOAD_CONFIG_QUOTA_BYTES, 0),
    maxFileBytes: nonNegativeInt(env.UPLOAD_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
  };
}

// Total size of the files directly inside `dir` (upload folders are flat).
// A folder that does not exist yet holds 0 bytes.
export async function folderSizeBytes(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const sizes = await Promise.all(names.map(async (n) => (await stat(join(dir, n))).size));
  return sizes.reduce((a, b) => a + b, 0);
}

// Returns null when the upload may proceed, or { status, error } to refuse it.
export async function checkUploadCapacity({ root, folder, incomingBytes, limits, statfs = fsStatfs, logger = console }) {
  const incoming = Number.isSafeInteger(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;

  let freeBytes = null;
  try {
    const s = await statfs(root);
    freeBytes = s.bavail * s.bsize;
  } catch (err) {
    // Unsupported filesystem or missing root: don't block uploads on a probe failure.
    logger.warn(`Upload free-space check skipped (${err.code || err.message})`);
  }
  if (freeBytes !== null && freeBytes - incoming < limits.minFreeBytes) {
    return { status: 507, error: 'Not enough free disk space on the upload volume for this upload' };
  }

  if (limits.configQuotaBytes > 0) {
    const used = await folderSizeBytes(folder);
    if (used + incoming > limits.configQuotaBytes) {
      return { status: 413, error: 'This upload would exceed the storage quota for this crawler configuration. Delete old files first.' };
    }
  }
  return null;
}

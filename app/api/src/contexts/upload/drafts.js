// Context upload — the uploaded file between the wizard's steps.
//
// Analyze stores the file as a DRAFT; preview and apply name it by its
// uploadDraftId and re-read it. A draft is two files in one folder under the
// uploads volume:
//   <UPLOAD_ROOT>/context-uploads/<uuid>.data  the file, as uploaded
//   <UPLOAD_ROOT>/context-uploads/<uuid>.json  { fileName, uploadedBy, createdAt }
// Nothing is kept in memory between requests. A draft is deleted after its
// apply, and every draft older than DRAFT_TTL_MS is swept on the next analyze.
//
// The id is a server-made uuid and is checked against UUID_RE before it is
// turned into a path, so a caller can never name a file outside the folder.

import { mkdir, readFile, writeFile, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

export const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function draftDir(root = process.env.UPLOAD_ROOT || '/data/uploads') {
  return join(root, 'context-uploads');
}

const paths = (dir, id) => ({ data: join(dir, `${id}.data`), meta: join(dir, `${id}.json`) });

/** Store a file as a new draft. Returns its id. */
export async function saveDraft(buffer, { fileName, uploadedBy }, dir = draftDir()) {
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const p = paths(dir, id);
  await writeFile(p.data, buffer);
  await writeFile(p.meta, JSON.stringify({ fileName, uploadedBy, createdAt: new Date().toISOString() }));
  return id;
}

/** The draft's file and metadata, or null when the id is malformed, unknown or expired. */
export async function loadDraft(id, dir = draftDir(), now = Date.now()) {
  if (!UUID_RE.test(String(id ?? ''))) return null;
  const p = paths(dir, id);
  try {
    const meta = JSON.parse(await readFile(p.meta, 'utf8'));
    if (now - Date.parse(meta.createdAt) > DRAFT_TTL_MS) return null;
    return { buffer: await readFile(p.data), ...meta };
  } catch {
    return null;
  }
}

export async function deleteDraft(id, dir = draftDir()) {
  if (!UUID_RE.test(String(id ?? ''))) return;
  const p = paths(dir, id);
  await Promise.all([rm(p.data, { force: true }), rm(p.meta, { force: true })]);
}

/** Remove every draft file older than the TTL. Never throws; returns how many files went. */
export async function sweepDrafts(dir = draftDir(), now = Date.now()) {
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const s = await stat(full);
      if (now - s.mtimeMs > DRAFT_TTL_MS) { await rm(full, { force: true }); removed++; }
    }
  } catch { /* no folder yet, or a file vanished meanwhile: nothing to sweep */ }
  return removed;
}

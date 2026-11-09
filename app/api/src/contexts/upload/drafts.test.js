import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve, sep, basename } from 'path';
import { saveDraft, loadDraft, deleteDraft, sweepDrafts, draftDir, draftPaths, isInside, DRAFT_TTL_MS } from './drafts.js';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ctx-upload-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('drafts', () => {
  it('stores a file and reads it back with its name and uploader', async () => {
    const id = await saveDraft(Buffer.from('Naam\nAcme'), { fileName: 'klanten.csv', uploadedBy: 'analyst@x.nl' }, dir);
    const draft = await loadDraft(id, dir);
    expect(draft.buffer.toString()).toBe('Naam\nAcme');
    expect(draft).toMatchObject({ fileName: 'klanten.csv', uploadedBy: 'analyst@x.nl' });
    expect((await readdir(dir)).sort()).toEqual([`${id}.data`, `${id}.json`]);
  });

  it('a malformed id never becomes a path; an unknown one is null', async () => {
    expect(await loadDraft('../../etc/passwd', dir)).toBeNull();
    expect(await loadDraft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', dir)).toBeNull();
  });

  it('draftPaths builds both files from the checked id, lower-cased, inside the folder', () => {
    const p = draftPaths('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', dir);
    expect(p).toEqual({
      data: resolve(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.data'),
      meta: resolve(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'),
    });
  });

  it.each([
    ['a traversal', '../../etc/passwd'],
    ['a uuid with a path in front', '../aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    ['a uuid with a suffix', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/../x'],
    ['a padded uuid', ' aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    ['nothing', undefined],
    ['an array', ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'x']],
  ])('draftPaths refuses %s', (_label, id) => {
    expect(draftPaths(id, dir)).toBeNull();
  });

  it('isInside: a file in the folder is inside; the folder itself, a sibling and a parent are not', () => {
    expect(isInside(dir, join(dir, 'a.data'))).toBe(true);
    expect(isInside(dir, dir)).toBe(false);
    expect(isInside(dir, `${dir}-other${sep}a.data`)).toBe(false);
    expect(isInside(dir, join(dir, '..', 'a.data'))).toBe(false);
  });

  it('deleteDraft of a traversal id removes nothing outside the folder', async () => {
    const outside = join(dir, '..', `${basename(dir)}-victim.json`);
    await writeFile(outside, 'keep');
    try {
      await deleteDraft(`../${basename(dir)}-victim`, dir);
      expect((await readdir(join(dir, '..'))).includes(basename(outside))).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('is readable just inside its time-to-live and expired just past it', async () => {
    const id = await saveDraft(Buffer.from('x'), { fileName: 'a.csv' }, dir);
    const created = Date.now();
    expect(await loadDraft(id, dir, created + DRAFT_TTL_MS - 1000)).not.toBeNull();
    expect(await loadDraft(id, dir, created + DRAFT_TTL_MS + 5000)).toBeNull();
  });

  it('deleteDraft removes both files', async () => {
    const id = await saveDraft(Buffer.from('x'), { fileName: 'a.csv' }, dir);
    await deleteDraft(id, dir);
    expect(await readdir(dir)).toEqual([]);
    await expect(deleteDraft('not-a-uuid', dir)).resolves.toBeUndefined();
  });

  it('the sweep removes only files older than the time-to-live', async () => {
    const id = await saveDraft(Buffer.from('x'), { fileName: 'a.csv' }, dir);
    const old = join(dir, 'old.data');
    await writeFile(old, 'x');
    const past = (Date.now() - DRAFT_TTL_MS - 60_000) / 1000;
    await utimes(old, past, past);
    expect(await sweepDrafts(dir)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([`${id}.data`, `${id}.json`]);
  });

  it('the sweep of a missing folder removes nothing and does not throw', async () => {
    expect(await sweepDrafts(join(dir, 'nope'))).toBe(0);
  });

  it('lives under the uploads volume', () => {
    expect(draftDir('/data/uploads').replace(/\\/g, '/')).toBe('/data/uploads/context-uploads');
  });
});

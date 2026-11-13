// get_photos: who may see whose photo, and the two shapes a photo goes out in.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
const { query } = await import('../db/connection.js');
const { getPhotos, allowedPhotoIds, MAX_PHOTOS } = await import('./tools/photos.js');

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const ME = 'c0000000-0000-4000-8000-00000000000c';
const PNG = Buffer.from([1, 2, 3]);

const analyst = () => ({ user: { permissions: new Set(['*']) }, caller: async () => null });
const owner = (openable = [A]) => ({
  user: { contextOwner: { contexts: [], access: { accessibleIds: vi.fn(async (_k, ids) => new Set(ids.filter(i => openable.includes(i)))) } } },
  caller: async () => ({ principalId: ME.toUpperCase() }),
});

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (_sql, [ids]) => ({
    rows: [
      { id: A, displayName: 'Ann', photo: PNG, photoContentType: 'image/png' },
      { id: B, displayName: 'Bob', photo: null, photoContentType: null },
      { id: ME, displayName: 'Carla', photo: PNG, photoContentType: null },
    ].filter(r => ids.includes(r.id)),
  }));
});

describe('allowedPhotoIds', () => {
  it('lets an analyst see every photo', async () => {
    expect([...(await allowedPhotoIds([A, B], analyst()))]).toEqual([A, B]);
  });

  it('lets an owner see the people they may open, and always themselves — no one else', async () => {
    const ctx = owner([A]);
    expect([...(await allowedPhotoIds([A, B, ME], ctx))].sort()).toEqual([A, ME].sort());
    expect(ctx.user.contextOwner.access.accessibleIds).toHaveBeenCalledWith('principal', [A, B, ME]);
  });
});

describe('get_photos', () => {
  it('returns each photo as an image block and a data URI, and names who has none', async () => {
    const r = await getPhotos.run({ ids: [A, B] }, analyst());
    expect(r.structuredContent.photos).toEqual([{ id: A, name: 'Ann', mimeType: 'image/png', dataUri: 'data:image/png;base64,AQID' }]);
    expect(r.structuredContent.withoutPhoto).toEqual([{ id: B, name: 'Bob' }]);
    expect(r.content).toContainEqual({ type: 'image', data: 'AQID', mimeType: 'image/png' });
    // The text block stays small: no image bytes in it.
    expect(r.content[0].text).not.toContain('AQID');
    expect(r.rowCount).toBe(1);
  });

  it('gives an owner nothing about someone they may not open — not even the name', async () => {
    const r = await getPhotos.run({ ids: [A, B, ME] }, owner([A]));
    expect(query.mock.calls[0][1][0].sort()).toEqual([A, ME].sort());
    expect(r.structuredContent.photos.map(p => p.name).sort()).toEqual(['Ann', 'Carla']);
    expect(r.structuredContent.notAvailable).toEqual([B]);
    expect(JSON.stringify(r)).not.toContain('Bob');
    expect(r.structuredContent.scope.restricted).toBe(true);
  });

  it('answers an unknown id the same way as a refused one, and skips the database when nothing is allowed', async () => {
    const r = await getPhotos.run({ ids: ['not-a-uuid', B] }, owner([]));
    expect(query).not.toHaveBeenCalled();
    expect(r.structuredContent.notAvailable).toEqual(['not-a-uuid', B]);
  });

  it(`refuses an empty list and more than ${MAX_PHOTOS} ids`, async () => {
    expect((await getPhotos.run({ ids: [] }, analyst())).isError).toBe(true);
    expect((await getPhotos.run({ ids: Array(MAX_PHOTOS + 1).fill(A) }, analyst())).isError).toBe(true);
    expect((await getPhotos.run({}, analyst())).isError).toBe(true);
  });
});

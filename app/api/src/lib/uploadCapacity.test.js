import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveUploadLimits, folderSizeBytes, checkUploadCapacity, DEFAULT_MIN_FREE_BYTES } from './uploadCapacity.js';

const GiB = 1024 * 1024 * 1024;
// A fake volume with `free` bytes available.
const volume = (free) => async () => ({ bavail: free / 4096, bsize: 4096 });
const quiet = { warn: vi.fn() };

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'iatest-capacity-'));
  writeFileSync(join(dir, 'a.csv'), 'x'.repeat(300));
  writeFileSync(join(dir, 'b.csv'), 'x'.repeat(200));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveUploadLimits', () => {
  it('reserves 1 GiB and has no per-config quota by default', () => {
    expect(resolveUploadLimits({})).toEqual({ minFreeBytes: DEFAULT_MIN_FREE_BYTES, configQuotaBytes: 0 });
    expect(DEFAULT_MIN_FREE_BYTES).toBe(GiB);
  });
  it('accepts explicit byte values, including 0, and ignores invalid ones', () => {
    expect(resolveUploadLimits({ UPLOAD_MIN_FREE_BYTES: '0', UPLOAD_CONFIG_QUOTA_BYTES: '5000' }))
      .toEqual({ minFreeBytes: 0, configQuotaBytes: 5000 });
    expect(resolveUploadLimits({ UPLOAD_MIN_FREE_BYTES: '-1', UPLOAD_CONFIG_QUOTA_BYTES: '1.5' }))
      .toEqual({ minFreeBytes: DEFAULT_MIN_FREE_BYTES, configQuotaBytes: 0 });
  });
});

describe('folderSizeBytes', () => {
  it('sums the files in the folder', async () => {
    expect(await folderSizeBytes(dir)).toBe(500);
  });
  it('treats a folder that does not exist yet as empty', async () => {
    expect(await folderSizeBytes(join(dir, 'missing'))).toBe(0);
  });
  it('propagates other errors', async () => {
    await expect(folderSizeBytes(join(dir, 'a.csv'))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('checkUploadCapacity', () => {
  const limits = { minFreeBytes: GiB, configQuotaBytes: 0 };

  it('allows an upload that leaves exactly the reserve free, refuses one byte more', async () => {
    const free = 3 * GiB;
    expect(await checkUploadCapacity({ root: dir, folder: dir, incomingBytes: 2 * GiB, limits, statfs: volume(free) })).toBeNull();
    const refused = await checkUploadCapacity({ root: dir, folder: dir, incomingBytes: 2 * GiB + 4096, limits, statfs: volume(free) });
    expect(refused.status).toBe(507);
  });

  it('still enforces the reserve when the size is unknown', async () => {
    const refused = await checkUploadCapacity({ root: dir, folder: dir, incomingBytes: NaN, limits, statfs: volume(GiB - 4096) });
    expect(refused.status).toBe(507);
  });

  it('does not block uploads when the free-space probe itself fails', async () => {
    const failing = async () => { throw Object.assign(new Error('nope'), { code: 'ENOSYS' }); };
    const logger = { warn: vi.fn() };
    expect(await checkUploadCapacity({ root: dir, folder: dir, incomingBytes: 10, limits, statfs: failing, logger })).toBeNull();
    expect(logger.warn.mock.calls[0][0]).toMatch(/ENOSYS/);
  });

  it('applies the per-config quota to stored plus incoming bytes', async () => {
    const quota = { minFreeBytes: 0, configQuotaBytes: 600 };
    const ok = await checkUploadCapacity({ root: dir, folder: dir, incomingBytes: 100, limits: quota, statfs: volume(GiB), logger: quiet });
    const over = await checkUploadCapacity({ root: dir, folder: dir, incomingBytes: 101, limits: quota, statfs: volume(GiB), logger: quiet });
    expect(ok).toBeNull();
    expect(over.status).toBe(413);
  });
});

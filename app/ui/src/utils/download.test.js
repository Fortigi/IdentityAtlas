// @vitest-environment jsdom
//
// The download helpers decide what a saved file is called and whether it is
// saved at all — both fail silently (a file named after the wrong thing, or no
// file), so the assertions here are on the anchor that actually gets clicked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filenameFromDisposition, triggerDownload } from './download';

describe('triggerDownload', () => {
  let clicked;
  let created;
  let revoked;

  beforeEach(() => {
    clicked = [];
    created = [];
    revoked = [];
    globalThis.URL.createObjectURL = vi.fn((blob) => { created.push(blob); return 'blob:fake-url'; });
    globalThis.URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
    // Capture the synthetic anchor at the moment of the click — it is removed
    // straight afterwards, so asserting after the fact would find nothing.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture() {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('saves the blob under the given filename and cleans up after itself', () => {
    const blob = new Blob(['a,b\r\n1,2'], { type: 'text/csv' });

    triggerDownload('report.csv', blob);

    expect(created).toEqual([blob]);
    expect(clicked).toEqual([{ href: 'blob:fake-url', download: 'report.csv', attached: true }]);
    expect(revoked).toEqual(['blob:fake-url']);
    // The anchor is a means, not a leftover.
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('filenameFromDisposition', () => {
  it('reads the quoted filename a server asked for', () => {
    expect(filenameFromDisposition('attachment; filename="identity-atlas-sample-2026-09-12.csv"'))
      .toBe('identity-atlas-sample-2026-09-12.csv');
  });

  it('reads an unquoted filename', () => {
    expect(filenameFromDisposition('attachment; filename=sample.csv')).toBe('sample.csv');
  });

  it('decodes the RFC-5987 extended form, in preference to the plain one', () => {
    expect(filenameFromDisposition("attachment; filename=\"fallback.csv\"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv"))
      .toBe('résumé.csv');
  });

  it('keeps the raw value when the extended form is not decodable', () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''broken%E0%A4%A.csv"))
      .toBe('broken%E0%A4%A.csv');
  });

  it('strips any directory part — a download is written by name', () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(filenameFromDisposition('attachment; filename="C:\\temp\\evil.csv"')).toBe('evil.csv');
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['a header with no filename', 'attachment'],
    ['an empty filename', 'attachment; filename=""'],
  ])('returns null for %s, so the caller can fall back', (_label, header) => {
    expect(filenameFromDisposition(header)).toBeNull();
  });
});

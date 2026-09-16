// Unit tests for the Rename / Duplicate requests and wording (#1202). The hook's
// lifecycle — the inline 409, the toast, the reload — is driven through the
// strip in MatrixNameBar.mount.test.jsx.
import { describe, it, expect } from 'vitest';
import { namingRequest, namingCopy } from './useSavedMatrixNaming';

const ROW = { id: 'sf-1', name: 'HR users', filter: { rowType: 'principal', managed: 'gaps' }, shared: true, recipientCount: 2 };

describe('namingRequest', () => {
  it('renames with a PUT that carries ONLY the new name', () => {
    const { url, init } = namingRequest('rename', ROW, 'People team');
    expect(url).toBe('/api/matrix/saved-filters/sf-1');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ name: 'People team' });
  });

  it('duplicates with a POST of the stored filter, governed toggle included', () => {
    const { url, init } = namingRequest('duplicate', ROW, 'Copy of HR users');
    expect(url).toBe('/api/matrix/saved-filters');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ name: 'Copy of HR users', filter: { rowType: 'principal', managed: 'gaps' } });
  });

  it('duplicates a row with no stored filter as an empty one rather than dropping the field', () => {
    expect(JSON.parse(namingRequest('duplicate', { id: 'x', name: 'X' }, 'Y').init.body)).toEqual({ name: 'Y', filter: {} });
  });
});

describe('namingCopy', () => {
  it('words a rename, warning recipients of a shared matrix', () => {
    expect(namingCopy('rename', ROW)).toEqual({
      title: 'Rename matrix', saveLabel: 'Rename',
      notice: 'Shared with 2 people — they will see the new name.', success: 'Matrix renamed',
    });
    expect(namingCopy('rename', { ...ROW, shared: false }).notice).toBe('');
  });

  it('words a duplicate, with no share warning — the copy is not shared', () => {
    expect(namingCopy('duplicate', ROW)).toEqual({ title: 'Duplicate matrix', saveLabel: 'Duplicate', notice: '', success: 'Matrix duplicated' });
  });
});

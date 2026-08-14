import { describe, it, expect } from 'vitest';
import { isContextDirty, normalizeContextFields } from './ManualContextEditor.helpers';

describe('normalizeContextFields', () => {
  it('maps loaded attrs onto the editor string fields', () => {
    const attrs = {
      displayName: 'Engineering',
      description: 'A team',
      ownerUserId: 'user-1',
      parentContextId: 'ctx-parent',
      parentDisplayName: 'Company',
    };
    expect(normalizeContextFields(attrs)).toEqual({
      displayName: 'Engineering',
      description: 'A team',
      ownerUserId: 'user-1',
      parentId: 'ctx-parent',
      parentLabel: 'Company',
    });
  });

  it('defaults every absent field to an empty string', () => {
    expect(normalizeContextFields({})).toEqual({
      displayName: '',
      description: '',
      ownerUserId: '',
      parentId: '',
      parentLabel: '',
    });
  });
});

describe('isContextDirty', () => {
  const attrs = {
    displayName: 'Engineering',
    description: 'A team',
    ownerUserId: 'user-1',
    parentContextId: 'ctx-parent',
  };
  const pristine = {
    displayName: 'Engineering',
    description: 'A team',
    ownerUserId: 'user-1',
    parentId: 'ctx-parent',
  };

  it('is false when every field matches the loaded attrs', () => {
    expect(isContextDirty(attrs, pristine)).toBe(false);
  });

  it('detects a changed display name', () => {
    expect(isContextDirty(attrs, { ...pristine, displayName: 'Eng' })).toBe(true);
  });

  it('detects a changed description', () => {
    expect(isContextDirty(attrs, { ...pristine, description: 'New' })).toBe(true);
  });

  it('detects a changed owner', () => {
    expect(isContextDirty(attrs, { ...pristine, ownerUserId: 'user-2' })).toBe(true);
  });

  it('detects a changed parent', () => {
    expect(isContextDirty(attrs, { ...pristine, parentId: 'ctx-other' })).toBe(true);
  });

  it('treats empty-string parent and null parent as equivalent (not dirty)', () => {
    expect(isContextDirty({ ...attrs, parentContextId: null }, { ...pristine, parentId: '' })).toBe(false);
  });

  it('treats a cleared parent as dirty when the context had one', () => {
    expect(isContextDirty(attrs, { ...pristine, parentId: '' })).toBe(true);
  });
});

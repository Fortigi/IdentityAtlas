import { describe, it, expect } from 'vitest';
import { isContextDirty, normalizeContextFields, defaultChildCategory } from './ManualContextEditor.helpers';

describe('normalizeContextFields', () => {
  it('maps loaded attrs onto the editor string fields', () => {
    const attrs = {
      displayName: 'Engineering',
      description: 'A team',
      ownerUserId: 'user-1',
      contextCategory: 'OrganizationalUnit',
      parentContextId: 'ctx-parent',
      parentDisplayName: 'Company',
    };
    expect(normalizeContextFields(attrs)).toEqual({
      displayName: 'Engineering',
      description: 'A team',
      ownerUserId: 'user-1',
      contextCategory: 'OrganizationalUnit',
      parentId: 'ctx-parent',
      parentLabel: 'Company',
    });
  });

  it('defaults every absent field to an empty string', () => {
    expect(normalizeContextFields({})).toEqual({
      displayName: '',
      description: '',
      ownerUserId: '',
      contextCategory: '',
      parentId: '',
      parentLabel: '',
    });
  });
});

describe('defaultChildCategory', () => {
  it('is the parent template when the parent has one', () => {
    expect(defaultChildCategory({ contextCategory: 'LogicalApplication' })).toBe('LogicalApplication');
  });

  it('is Segment when the parent has none (null, or no parent at all)', () => {
    expect(defaultChildCategory({ contextCategory: null })).toBe('Segment');
    expect(defaultChildCategory(undefined)).toBe('Segment');
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

  it('detects a changed template, and treats "" and null as the same no-template', () => {
    expect(isContextDirty(attrs, { ...pristine, contextCategory: 'Tag' })).toBe(true);
    expect(isContextDirty({ ...attrs, contextCategory: null }, { ...pristine, contextCategory: '' })).toBe(false);
    expect(isContextDirty({ ...attrs, contextCategory: 'Tag' }, { ...pristine, contextCategory: '' })).toBe(true);
  });

  it('treats empty-string parent and null parent as equivalent (not dirty)', () => {
    expect(isContextDirty({ ...attrs, parentContextId: null }, { ...pristine, parentId: '' })).toBe(false);
  });

  it('treats a cleared parent as dirty when the context had one', () => {
    expect(isContextDirty(attrs, { ...pristine, parentId: '' })).toBe(true);
  });
});

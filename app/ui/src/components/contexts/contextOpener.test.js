import { describe, it, expect, vi } from 'vitest';
import { contextOpener } from './contextOpener';

const MINE = { id: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'Finance' };
const OTHER = { id: 'aaaaaaaa-0000-4000-8000-000000000002', displayName: 'Sales' };
const scope = new Set([MINE.id]);

describe('contextOpener', () => {
  it('links every context in the ordinary app, opening it by id and name', () => {
    const onOpenDetail = vi.fn();
    const open = contextOpener({ onOpenDetail })(OTHER);
    open();
    expect(onOpenDetail).toHaveBeenCalledWith('context', OTHER.id, 'Sales');
  });

  it('links nothing without a detail handler', () => {
    expect(contextOpener({})(MINE)).toBeUndefined();
    expect(contextOpener()(MINE)).toBeUndefined();
  });

  it('links nothing in a read-only view that is not an owner\'s page (a shared matrix)', () => {
    expect(contextOpener({ sharedView: true, onOpenDetail: vi.fn() })(MINE)).toBeUndefined();
  });

  it('on an owner\'s page links a context in scope — matched case-insensitively — and nothing else', () => {
    const onOpenDetail = vi.fn();
    const opener = contextOpener({ sharedView: true, ownerScope: scope, onOpenDetail });
    expect(opener(OTHER)).toBeUndefined();
    opener({ ...MINE, id: MINE.id.toUpperCase() })();
    expect(onOpenDetail).toHaveBeenCalledWith('context', MINE.id.toUpperCase(), 'Finance');
  });

  it('ignores an owner scope outside a read-only view (it is only ever set inside one)', () => {
    expect(contextOpener({ ownerScope: scope, onOpenDetail: vi.fn() })(OTHER)).toBeTypeOf('function');
  });
});

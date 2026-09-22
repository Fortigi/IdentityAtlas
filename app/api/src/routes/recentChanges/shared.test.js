// The shared helpers behind every recent-changes timeline.

import { describe, it, expect } from 'vitest';
import { changeAction } from './shared.js';

describe('changeAction', () => {
  // What a history row DID, across the two ways a row can leave: a hard
  // DELETE, and a soft delete recorded as an UPDATE that stamps deletedAt.
  const at = (prevDeleted, nowDeleted) => ({
    operation: 'U',
    prevData: { deletedAt: prevDeleted },
    rowData: { deletedAt: nowDeleted },
  });

  it('reads an insert as an addition and a hard delete as a removal', () => {
    expect(changeAction({ operation: 'I' })).toBe('added');
    expect(changeAction({ operation: 'D' })).toBe('removed');
  });

  it('reads a stamped deletedAt as a removal', () => {
    expect(changeAction(at(null, '2026-09-21T10:00:00Z'))).toBe('removed');
  });

  it('reads a cleared deletedAt as an addition', () => {
    // Re-ingesting a membership that came back clears the stamp.
    expect(changeAction(at('2026-09-01T10:00:00Z', null))).toBe('added');
  });

  it('reads an update that left deletedAt alone as neither', () => {
    expect(changeAction(at(null, null))).toBe(null);
    expect(changeAction(at('2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'))).toBe(null);
  });

  it('survives a row with no payload at all', () => {
    expect(changeAction({ operation: 'U' })).toBe(null);
    expect(changeAction({ operation: 'U', rowData: {}, prevData: {} })).toBe(null);
  });
});

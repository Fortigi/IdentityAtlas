import { describe, it, expect } from 'vitest';
import { isSourceLinkedMember } from './linkedMembers.js';

describe('isSourceLinkedMember', () => {
  it('treats a link with no confidence score as source-linked (no Confirm/Remove)', () => {
    expect(isSourceLinkedMember({ linkConfidence: null })).toBe(true);
    expect(isSourceLinkedMember({ linkConfidence: undefined })).toBe(true);
    expect(isSourceLinkedMember({})).toBe(true);
  });

  it('treats a scored link as account-linking-owned (gets Confirm/Remove)', () => {
    expect(isSourceLinkedMember({ linkConfidence: 100 })).toBe(false);
    expect(isSourceLinkedMember({ linkConfidence: 60 })).toBe(false);
    // A genuine 0 score is still a scored link, not source-linked.
    expect(isSourceLinkedMember({ linkConfidence: 0 })).toBe(false);
  });

  it('is null-safe', () => {
    expect(isSourceLinkedMember(null)).toBe(true);
    expect(isSourceLinkedMember(undefined)).toBe(true);
  });
});

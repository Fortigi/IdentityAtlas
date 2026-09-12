import { describe, it, expect } from 'vitest';
import { isSourceLinkedMember, memberAccountEnabled } from './linkedMembers.js';

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

describe('memberAccountEnabled', () => {
  it('prefers the live Principal value over the link-time snapshot', () => {
    // The snapshot is deliberately the opposite value in both directions, so a
    // reversed precedence fails rather than coincidentally agreeing.
    expect(memberAccountEnabled({ userAccountEnabled: false, accountEnabled: true })).toBe(false);
    expect(memberAccountEnabled({ userAccountEnabled: true, accountEnabled: false })).toBe(true);
  });

  it('falls back to the snapshot when there is no live value', () => {
    expect(memberAccountEnabled({ userAccountEnabled: null, accountEnabled: true })).toBe(true);
    expect(memberAccountEnabled({ accountEnabled: false })).toBe(false);
  });

  it('returns null when neither value is known', () => {
    expect(memberAccountEnabled({ userAccountEnabled: null, accountEnabled: null })).toBeNull();
    expect(memberAccountEnabled({})).toBeNull();
    expect(memberAccountEnabled(null)).toBeNull();
    expect(memberAccountEnabled(undefined)).toBeNull();
  });
});

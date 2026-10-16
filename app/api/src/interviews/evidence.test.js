import { describe, it, expect } from 'vitest';
import { excerptHash, excerptToStore } from './evidence.js';

const EXCERPT = 'William beheert de productieomgeving';

describe('excerptHash', () => {
  it('is the lowercase hex SHA-256 of the UTF-8 excerpt — a fixed vector the iOS client tests against', () => {
    // Computed independently of Node (PowerShell, [Security.Cryptography.SHA256]::HashData
    // over the UTF-8 bytes). The Swift package pins the same vector.
    expect(excerptHash(EXCERPT)).toBe('a77fccf295976f0170d89e4526fae5491eb0b4e7a6eaeeeee0b5e0526bb37e44');
  });

  it('treats composed and decomposed accents as the same words (NFC)', () => {
    const composed = 'René is eigenaar';
    const decomposed = 'René is eigenaar';
    expect(composed).not.toBe(decomposed);
    expect(excerptHash(composed)).toBe(excerptHash(decomposed));
  });

  it('changes when one character changes', () => {
    expect(excerptHash(EXCERPT)).not.toBe(excerptHash(`${EXCERPT}.`));
  });
});

describe('excerptToStore', () => {
  const hash = excerptHash(EXCERPT);

  it('stores nothing when no excerpt was sent, whatever the policy', () => {
    expect(excerptToStore({ excerptHash: hash, excerpt: null }, 'local-only')).toEqual({ excerptText: null });
    expect(excerptToStore({ excerptHash: hash, excerpt: null }, 'evidence-excerpt')).toEqual({ excerptText: null });
  });

  it('refuses excerpt text on a local-only interview instead of dropping it', () => {
    expect(excerptToStore({ excerptHash: hash, excerpt: EXCERPT }, 'local-only').error).toMatch(/local-only/);
  });

  it('keeps the excerpt on an evidence-excerpt interview once the hash matches', () => {
    expect(excerptToStore({ excerptHash: hash, excerpt: EXCERPT }, 'evidence-excerpt')).toEqual({ excerptText: EXCERPT });
  });

  it('refuses an excerpt whose hash does not match', () => {
    expect(excerptToStore({ excerptHash: hash, excerpt: `${EXCERPT}!` }, 'evidence-excerpt').error).toBe('excerptHash does not match the excerpt');
  });
});

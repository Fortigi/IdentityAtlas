import { describe, it, expect } from 'vitest';
import {
  MAX_BATCH, MAX_RETENTION_DAYS, checkSpan, checkTimeRange, isHash, text, validateBatch, validateClaimRef,
  validateEvidence, validateMention, validateNewInterview, validateProposal, validateResolution, validateReview, validateStatement,
} from './contracts.js';

const HASH = 'a'.repeat(64);
const UUID = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const interview = (over = {}) => ({ interviewType: 'role-mining', noticeConfirmed: true, noticeVersion: 'nl-2026-10', ...over });
const mention = (over = {}) => ({ segmentId: 's1', literalText: 'Peter', startMs: 1000, endMs: 1400, spanStart: 30, spanEnd: 35, ...over });
const evidence = (over = {}) => ({ segmentId: 's1', startMs: 1000, endMs: 4000, spanStart: 0, spanEnd: 60, excerptHash: HASH, ...over });

describe('validateNewInterview', () => {
  it('refuses an interview whose recording notice was not confirmed — strictly true, not truthy', () => {
    expect(validateNewInterview(interview({ noticeConfirmed: 'true' })).ok).toBe(false);
    expect(validateNewInterview(interview({ noticeConfirmed: undefined })).error).toMatch(/notice must be confirmed/);
  });

  it('needs the notice version the participant was shown', () => {
    expect(validateNewInterview(interview({ noticeVersion: '  ' })).error).toMatch(/noticeVersion/);
  });

  it('defaults to local-only storage and 90 days, and keeps what was given otherwise', () => {
    const d = validateNewInterview(interview());
    expect(d.value).toMatchObject({ storagePolicy: 'local-only', retentionDays: 90, subjectIdentityId: null, scopeContextId: null, title: null });
    const e = validateNewInterview(interview({ storagePolicy: 'evidence-excerpt', retentionDays: 30, scopeContextId: UUID, title: ' Team A ' }));
    expect(e.value).toMatchObject({ storagePolicy: 'evidence-excerpt', retentionDays: 30, scopeContextId: UUID, title: 'Team A' });
  });

  it('never accepts a storage policy that would keep a transcript or audio', () => {
    for (const p of ['full-transcript', 'recording', 'summary']) expect(validateNewInterview(interview({ storagePolicy: p })).ok).toBe(false);
  });

  it('accepts retention at both ends of the range and refuses one past either end', () => {
    expect(validateNewInterview(interview({ retentionDays: 1 })).ok).toBe(true);
    expect(validateNewInterview(interview({ retentionDays: MAX_RETENTION_DAYS })).ok).toBe(true);
    expect(validateNewInterview(interview({ retentionDays: 0 })).ok).toBe(false);
    expect(validateNewInterview(interview({ retentionDays: MAX_RETENTION_DAYS + 1 })).ok).toBe(false);
    expect(validateNewInterview(interview({ retentionDays: 1.5 })).ok).toBe(false);
  });

  it('refuses an unknown type and a malformed scope id', () => {
    expect(validateNewInterview(interview({ interviewType: 'exit' })).error).toMatch(/interviewType/);
    expect(validateNewInterview(interview({ scopeContextId: 'team-a' })).error).toBe('scopeContextId must be a UUID');
    expect(validateNewInterview(null).ok).toBe(false);
  });

  it('refuses a title over 200 characters', () => {
    expect(validateNewInterview(interview({ title: 'x'.repeat(201) })).error).toMatch(/^title/);
  });
});

describe('time ranges and spans', () => {
  it('allows a zero-length moment but not a zero-length span', () => {
    expect(checkTimeRange(500, 500)).toBeNull();
    expect(checkTimeRange(500, 499)).toMatch(/before/);
    expect(checkSpan(3, 4)).toBeNull();
    expect(checkSpan(3, 3)).toMatch(/after/);
  });

  it('refuses negative and fractional positions', () => {
    expect(checkTimeRange(-1, 5)).toMatch(/whole milliseconds/);
    expect(checkSpan(0.5, 4)).toMatch(/whole numbers/);
  });
});

describe('validateMention', () => {
  it('keeps the literal, the position and the detector version', () => {
    const r = validateMention(mention({ entityKindHint: 'identity', detector: 'lexicon@1' }));
    expect(r.value).toEqual({ segmentId: 's1', literalText: 'Peter', startMs: 1000, endMs: 1400, spanStart: 30, spanEnd: 35, entityKindHint: 'identity', detector: 'lexicon@1' });
  });

  it('records an unnamed detector as unspecified rather than inventing one', () => {
    expect(validateMention(mention()).value.detector).toBe('unspecified');
  });

  it('refuses an unknown kind hint and a detector name with spaces', () => {
    expect(validateMention(mention({ entityKindHint: 'person' })).ok).toBe(false);
    expect(validateMention(mention({ detector: 'my detector' })).ok).toBe(false);
  });

  it('refuses a mention without a segment id or literal', () => {
    expect(validateMention(mention({ segmentId: '' })).error).toMatch(/segmentId/);
    expect(validateMention(mention({ literalText: undefined })).error).toMatch(/literalText/);
  });
});

describe('validateBatch', () => {
  it('takes exactly MAX_BATCH items and refuses one more', () => {
    const items = Array.from({ length: MAX_BATCH }, () => mention());
    expect(validateBatch(items, validateMention, 'mentions').value).toHaveLength(MAX_BATCH);
    expect(validateBatch([...items, mention()], validateMention, 'mentions').error).toMatch(/at most 100/);
  });

  it('names the index of the first bad item', () => {
    expect(validateBatch([mention(), mention({ spanEnd: 30 })], validateMention, 'mentions').error).toMatch(/^mentions\[1\]:/);
  });

  it('refuses an empty array and a non-array', () => {
    expect(validateBatch([], validateMention, 'mentions').ok).toBe(false);
    expect(validateBatch('x', validateMention, 'mentions').ok).toBe(false);
  });
});

describe('validateEvidence', () => {
  it('needs a lowercase hex SHA-256', () => {
    expect(isHash(HASH)).toBe(true);
    expect(validateEvidence(evidence({ excerptHash: HASH.toUpperCase() })).ok).toBe(false);
    expect(validateEvidence(evidence({ excerptHash: 'a'.repeat(63) })).ok).toBe(false);
  });

  it('treats the excerpt as optional and names an unknown speech engine', () => {
    expect(validateEvidence(evidence()).value).toMatchObject({ excerpt: null, sttEngine: 'unspecified' });
    expect(validateEvidence(evidence({ excerpt: 'William beheert', sttEngine: 'apple-speech@ios26' })).value)
      .toMatchObject({ excerpt: 'William beheert', sttEngine: 'apple-speech@ios26' });
  });
});

describe('claims', () => {
  const statement = (over = {}) => ({ subject: { mentionId: UUID }, predicate: 'manages', object: { literal: 'productieomgeving' }, evidence: [evidence()], ...over });

  it('accepts a resolved subject and an unresolved literal object', () => {
    expect(validateStatement(statement()).value).toMatchObject({ subject: { mentionId: UUID }, object: { literal: 'productieomgeving' }, extractor: 'analyst', claimConfidence: null });
  });

  it('refuses a side that is neither a mention nor a literal — never a bare canonical id', () => {
    expect(validateClaimRef({ entityId: UUID }).error).toBe('give a mentionId or a literal');
    expect(validateStatement(statement({ subject: { mentionId: 'p1' } })).error).toMatch(/^subject mentionId/);
  });

  it('keeps claim confidence within 0..1, both ends included', () => {
    expect(validateStatement(statement({ claimConfidence: 0 })).ok).toBe(true);
    expect(validateStatement(statement({ claimConfidence: 1 })).ok).toBe(true);
    expect(validateStatement(statement({ claimConfidence: 1.01 })).ok).toBe(false);
  });

  it('needs at least one piece of evidence', () => {
    expect(validateStatement(statement({ evidence: [] })).error).toMatch(/evidence must be a non-empty array/);
  });

  it('proposals name a kind, a statement and a summary', () => {
    expect(validateProposal({ proposalKind: 'role', statementId: UUID, summary: 'Beheerder productie' }).ok).toBe(true);
    expect(validateProposal({ proposalKind: 'fact', statementId: UUID, summary: 'x' }).ok).toBe(false);
    expect(validateProposal({ proposalKind: 'role', statementId: UUID, summary: '' }).ok).toBe(false);
  });
});

describe('validateResolution', () => {
  it('defaults the origin to analyst and nulls what was not sent', () => {
    expect(validateResolution({ state: 'deferred' }).value).toEqual({ state: 'deferred', origin: 'analyst', entityKind: null, entityId: null, matchScore: null, candidateCount: null, rationale: null });
  });

  it('accepts a match score at 0 and at 1, and a candidate count of 0', () => {
    expect(validateResolution({ state: 'not_found', matchScore: 0, candidateCount: 0 }).ok).toBe(true);
    expect(validateResolution({ state: 'suggested', entityKind: 'identity', entityId: UUID, matchScore: 1 }).value.matchScore).toBe(1);
    expect(validateResolution({ state: 'suggested', entityKind: 'identity', entityId: UUID, matchScore: '1' }).error).toBe('matchScore must be between 0 and 1');
    expect(validateResolution({ state: 'not_found', candidateCount: 1.5 }).ok).toBe(false);
  });

  it('needs an entity id and kind together', () => {
    expect(validateResolution({ state: 'confirmed', entityId: UUID }).error).toBe('entityId and entityKind go together');
    expect(validateResolution({ state: 'confirmed', entityKind: 'identity' }).error).toBe('entityId and entityKind go together');
    expect(validateResolution({ state: 'confirmed', entityKind: 'identity', entityId: 'p1' }).error).toBe('entityId must be a UUID');
  });
});

describe('validateReview', () => {
  it('needs the reviewed version and refuses version 0', () => {
    expect(validateReview({ action: 'approve', targetVersion: 1 }).value).toEqual({ action: 'approve', targetVersion: 1, rationale: null });
    expect(validateReview({ action: 'approve', targetVersion: 0 }).ok).toBe(false);
    expect(validateReview({ action: 'approve' }).ok).toBe(false);
  });

  it('asks a rejection for its reason but not an approval or a deferral', () => {
    expect(validateReview({ action: 'reject', targetVersion: 1 }).error).toBe('A rejection needs a rationale');
    expect(validateReview({ action: 'reject', targetVersion: 1, rationale: 'Peter beheert alleen test' }).ok).toBe(true);
    expect(validateReview({ action: 'defer', targetVersion: 1 }).ok).toBe(true);
  });

  it('refuses an unknown action', () => {
    expect(validateReview({ action: 'promote', targetVersion: 1 }).ok).toBe(false);
  });
});

describe('text', () => {
  it('trims, and refuses empty or over-long text', () => {
    expect(text('  a  ', 3)).toBe('a');
    expect(text('abcd', 3)).toBeNull();
    expect(text('abc', 3)).toBe('abc');
    expect(text('   ', 3)).toBeNull();
    expect(text(5, 3)).toBeNull();
  });
});

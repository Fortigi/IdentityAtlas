import { describe, it, expect, vi, beforeEach } from 'vitest';

let authOn = true;
vi.mock('../../config/authConfig.js', () => ({ isAuthEnabled: () => authOn }));
vi.mock('../../middleware/auth.js', () => ({ requirePermission: (p) => Object.assign(() => {}, { perm: p }) }));
import { canSee, KNOWLEDGE_READ, KNOWLEDGE_WRITE } from './access.js';

beforeEach(() => { authOn = true; });

const restricted = { uploadedBy: 'gregor', metadata: { classification: 'restricted' } };
const req = (user, extra = {}) => ({ user, ...extra });

describe('canSee', () => {
  it('internal and confidential transcripts are visible to every reader', () => {
    expect(canSee(req(null), { metadata: { classification: 'internal' } })).toBe(true);
    expect(canSee(req(null), { metadata: { classification: 'confidential' } })).toBe(true);
    expect(canSee(req(null), { metadata: {} })).toBe(true);
  });

  it('a restricted one only to its uploader and administrators, never to a read token', () => {
    expect(canSee(req({ preferred_username: 'gregor' }), restricted)).toBe(true);
    expect(canSee(req({ preferred_username: 'wim', permissions: new Set(['data.read']) }), restricted)).toBe(false);
    expect(canSee(req({ preferred_username: 'wim', permissions: new Set(['*']) }), restricted)).toBe(true);
    expect(canSee(req({ preferred_username: 'gregor' }, { readToken: { id: 't' } }), restricted)).toBe(false);
    expect(canSee(req({ preferred_username: 'gregor' }), { ...restricted, uploadedBy: null })).toBe(false);
  });

  it('with auth off there is no one to hide it from; a missing source is never visible', () => {
    authOn = false;
    expect(canSee(req(null), restricted)).toBe(true);
    expect(canSee(req(null), null)).toBe(false);
  });
});

it('reading needs data.read, writing data.write.contexts, both behind two flags', () => {
  expect(KNOWLEDGE_READ).toHaveLength(3);
  expect(KNOWLEDGE_READ[0].perm).toBe('data.read');
  expect(KNOWLEDGE_WRITE[0].perm).toBe('data.write.contexts');
});

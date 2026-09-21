import { describe, it, expect, beforeEach } from 'vitest';
import { setPending, takePending, clearPending, __ttlMs } from './state.js';

beforeEach(clearPending);

describe('pending clarifications', () => {
  it('hands back what the conversation was waiting for', () => {
    setPending('c1', { kind: 'clarify', history: [{ role: 'user', content: 'x' }] });
    expect(takePending('c1')).toEqual({ kind: 'clarify', history: [{ role: 'user', content: 'x' }] });
  });

  it('forgets it on read, so one clarification is answered exactly once', () => {
    // Leaving it in place is how an unrelated question an hour later gets
    // silently attached to a half-finished one.
    setPending('c1', { kind: 'confirm' });
    expect(takePending('c1')).toEqual({ kind: 'confirm' });
    expect(takePending('c1')).toBeNull();
  });

  it('keeps conversations apart', () => {
    setPending('c1', { kind: 'clarify', history: ['one'] });
    setPending('c2', { kind: 'clarify', history: ['two'] });
    expect(takePending('c2').history).toEqual(['two']);
    expect(takePending('c1').history).toEqual(['one']);
  });

  it('returns null for a conversation that was never waiting', () => {
    expect(takePending('never-seen')).toBeNull();
  });

  it('is still valid AT the TTL and expired one millisecond later', () => {
    // The boundary in both directions — the only pair that separates `>` from
    // `>=`, and an expiry policy is exactly the kind of undocumented decision
    // that deserves pinning.
    setPending('at', { kind: 'clarify' }, 1_000);
    expect(takePending('at', 1_000 + __ttlMs)).toEqual({ kind: 'clarify' });

    setPending('past', { kind: 'clarify' }, 1_000);
    expect(takePending('past', 1_000 + __ttlMs + 1)).toBeNull();
  });

  it('drops an expired entry rather than leaving it to be read again', () => {
    setPending('c1', { kind: 'clarify' }, 0);
    expect(takePending('c1', __ttlMs + 1)).toBeNull();
    expect(takePending('c1', 0)).toBeNull();
  });

  it('ignores a message with no conversation id instead of keying on undefined', () => {
    // Every such message would otherwise share one slot and answer each other's
    // clarifications.
    setPending(undefined, { kind: 'clarify' });
    setPending('', { kind: 'clarify' });
    expect(takePending(undefined)).toBeNull();
    expect(takePending('')).toBeNull();
  });

  it('evicts the oldest entry once it is full, and keeps the newest', () => {
    // 501 entries over a 500 cap: the first must be gone, the last must be
    // there, and the one just inside the window must have survived.
    for (let i = 0; i < 501; i += 1) setPending(`c${i}`, { kind: 'clarify', n: i });

    expect(takePending('c0')).toBeNull();
    expect(takePending('c1')).toEqual({ kind: 'clarify', n: 1 });
    expect(takePending('c500')).toEqual({ kind: 'clarify', n: 500 });
  });

  it('re-setting a conversation refreshes its place in the queue, not just its value', () => {
    // c0 is re-set, so it is no longer the oldest; c1 is. An implementation
    // that overwrote in place without re-inserting would evict c0 here.
    setPending('c0', { kind: 'clarify', n: 0 });
    setPending('c1', { kind: 'clarify', n: 1 });
    setPending('c0', { kind: 'clarify', n: 2 });
    for (let i = 2; i < 501; i += 1) setPending(`c${i}`, { kind: 'clarify', n: i });

    expect(takePending('c1')).toBeNull();
    expect(takePending('c0')).toEqual({ kind: 'clarify', n: 2 });
  });
});

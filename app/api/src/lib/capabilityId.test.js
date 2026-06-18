import { describe, it, expect } from 'vitest';
import { capabilityResourceId, CAPABILITY_ID_SEPARATOR } from './capabilityId.js';

// GOLDEN VECTORS — these MUST stay identical to test/unit/CapabilityId.Tests.ps1 (the
// PowerShell crawler side). Pinning both runtimes to one table is what guarantees that
// engine-synthesized ids and crawler-written ids are byte-identical, so an inherited row and
// a directly-declared row for the same (capability, node) collapse into one matrix row.
// If you change the algorithm, regenerate the goldens in BOTH files together.
const GOLDENS = [
  { target: 'node-a', capability: 'cap-x', expected: '70cf03d4-00b5-d607-b0fa-c28f37cc363f' },
  {
    target: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg1',
    capability: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
    expected: 'fb4cd3b4-6fdd-8dbc-4cba-46376ef8bc65',
  },
  { target: 'C:\\Finance', capability: 'Write', expected: 'ded9f1e4-b426-7bf9-a4e9-68cb2e9758bd' },
  { target: 'a', capability: 'b', expected: '0eab8a0a-3380-abf4-c7d1-fb0b43b66aaf' },
  { target: 'café', capability: 'rôle', expected: '50c1f141-9d52-c66f-1ca8-04ebef754098' }, // UTF-8 multibyte
];

describe('capabilityResourceId', () => {
  it.each(GOLDENS)('computes the golden id for "$target" | "$capability"', ({ target, capability, expected }) => {
    expect(capabilityResourceId(target, capability)).toBe(expected);
  });

  it('is deterministic', () => {
    expect(capabilityResourceId('x', 'y')).toBe(capabilityResourceId('x', 'y'));
  });

  it('produces UUID-shaped output', () => {
    expect(capabilityResourceId('x', 'y')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('does not collide across the separator boundary', () => {
    expect(capabilityResourceId('ab', 'c')).not.toBe(capabilityResourceId('a', 'bc'));
  });

  it('throws when either argument contains the reserved separator', () => {
    expect(() => capabilityResourceId('a|b', 'c')).toThrow();
    expect(() => capabilityResourceId('a', 'b|c')).toThrow();
  });

  it('throws on non-string input', () => {
    expect(() => capabilityResourceId(123, 'c')).toThrow(TypeError);
  });

  it('exports the reserved separator', () => {
    expect(CAPABILITY_ID_SEPARATOR).toBe('|');
  });
});

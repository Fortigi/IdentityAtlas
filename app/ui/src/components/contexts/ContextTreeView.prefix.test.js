import { describe, it, expect } from 'vitest';
import { stripSiblingPrefix, dedupeSegments } from './ContextTreeView.jsx';

const node = (id, displayName) => ({ id, displayName });

describe('dedupeSegments', () => {
  it('collapses consecutive repeated segments, keeping the manager suffix', () => {
    expect(dedupeSegments('Commercie · Commercie (Doorn, Matthijs van)')).toBe('Commercie (Doorn, Matthijs van)');
    expect(dedupeSegments('CEO · ADIR · ADIR (Siemons, Boudewijn)')).toBe('CEO · ADIR (Siemons, Boudewijn)');
  });
  it('leaves non-repeating names untouched', () => {
    expect(dedupeSegments('CEO · ADIR · COO (X)')).toBe('CEO · ADIR · COO (X)');
  });
  it('only collapses consecutive runs, not distant repeats', () => {
    expect(dedupeSegments('A · B · A')).toBe('A · B · A');
  });
});

describe('stripSiblingPrefix', () => {
  it('strips the common "·"-path prefix shared by all siblings', () => {
    const map = stripSiblingPrefix([
      node('a', 'CEO · ADIR · COO (Simons, Berte)'),
      node('b', 'CEO · ADIR · CFO (Leeuw, Vivienne)'),
      node('c', 'CEO · ADIR · CEO (Siemons, Boudewijn)'),
    ]);
    expect(map.get('a')).toBe('COO (Simons, Berte)');
    expect(map.get('b')).toBe('CFO (Leeuw, Vivienne)');
    expect(map.get('c')).toBe('CEO (Siemons, Boudewijn)');
  });

  it('always keeps at least the last segment when names are otherwise identical paths', () => {
    const map = stripSiblingPrefix([
      node('a', 'Finance · North'),
      node('b', 'Finance · North'),
    ]);
    // Common prefix would consume everything; the last segment is preserved.
    expect(map.get('a')).toBe('North');
    expect(map.get('b')).toBe('North');
  });

  it('leaves names untouched when there is no shared prefix', () => {
    const map = stripSiblingPrefix([
      node('a', 'Finance · North'),
      node('b', 'Sales · West'),
    ]);
    expect(map.get('a')).toBe('Finance · North');
    expect(map.get('b')).toBe('Sales · West');
  });

  it('returns the original name for a single node (nothing to compare)', () => {
    const map = stripSiblingPrefix([node('a', 'CEO · ADIR · COO (X)')]);
    expect(map.get('a')).toBe('CEO · ADIR · COO (X)');
  });

  it('only strips the segments common to every sibling', () => {
    const map = stripSiblingPrefix([
      node('a', 'A · B · C'),
      node('b', 'A · B · D'),
      node('c', 'A · X · E'),
    ]);
    // Only "A" is common to all three; "B" differs in the third.
    expect(map.get('a')).toBe('B · C');
    expect(map.get('b')).toBe('B · D');
    expect(map.get('c')).toBe('X · E');
  });
});

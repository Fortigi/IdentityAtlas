import { describe, it, expect, vi } from 'vitest';
import {
  LAST_SIGN_IN_BUCKETS, LAST_SIGN_IN_BUCKET_NAMES, LAST_SIGN_IN_FILTER_KEY,
  addLastSignInColumn, extractLastSignInFilter, lastSignInFilterWhere,
} from './lastSignInFilter.js';

// A `bind` that records what it was given and returns the placeholder, the same
// contract as db/sqlParams.js's — so a test can assert on the BOUND VALUE rather
// than only on the SQL text around it.
function recordingBind() {
  const values = [];
  const bind = (v) => { values.push(v); return `$${values.length}`; };
  return { bind, values };
}

describe('addLastSignInColumn', () => {
  it('offers the four age buckets, stalest last', () => {
    const grouped = {};
    addLastSignInColumn(grouped);
    expect(grouped[LAST_SIGN_IN_FILTER_KEY]).toEqual(
      ['Never', 'Over 30 days ago', 'Over 90 days ago', 'Over 180 days ago']);
  });

  it('emits the column with no values on the schema-only fast path', () => {
    const grouped = {};
    addLastSignInColumn(grouped, { schemaOnly: true });
    expect(grouped[LAST_SIGN_IN_FILTER_KEY]).toEqual([]);
  });

  it('hands back a copy, so a caller mutating the list cannot edit the buckets', () => {
    const grouped = {};
    addLastSignInColumn(grouped);
    grouped[LAST_SIGN_IN_FILTER_KEY].push('Over 1000 days ago');
    expect(LAST_SIGN_IN_BUCKET_NAMES).toHaveLength(4);
  });
});

describe('extractLastSignInFilter', () => {
  it('removes the virtual key so it is never validated as a real column', () => {
    const filters = { department: 'Sales', [LAST_SIGN_IN_FILTER_KEY]: 'Never' };
    expect(extractLastSignInFilter(filters)).toBe('Never');
    expect(filters).toEqual({ department: 'Sales' });
  });

  it('trims surrounding whitespace before matching a bucket', () => {
    expect(extractLastSignInFilter({ [LAST_SIGN_IN_FILTER_KEY]: '  Never  ' })).toBe('Never');
  });

  it('returns null when the key is absent or null', () => {
    expect(extractLastSignInFilter({})).toBeNull();
    expect(extractLastSignInFilter(null)).toBeNull();
    expect(extractLastSignInFilter({ [LAST_SIGN_IN_FILTER_KEY]: null })).toBeNull();
  });

  it('drops an unknown bucket instead of filtering on it', () => {
    // A hand-edited URL must not become a SQL predicate; an unrecognised value
    // filters nothing, matching how __system treats a blank.
    const filters = { [LAST_SIGN_IN_FILTER_KEY]: 'Over 7 days ago' };
    expect(extractLastSignInFilter(filters)).toBeNull();
    expect(filters).toEqual({});
  });

  it('ignores an inherited Object.prototype member', () => {
    expect(extractLastSignInFilter({ [LAST_SIGN_IN_FILTER_KEY]: 'constructor' })).toBeNull();
  });
});

describe('lastSignInFilterWhere', () => {
  it('renders nothing when no bucket is selected', () => {
    const { bind, values } = recordingBind();
    expect(lastSignInFilterWhere(null, 'act', bind)).toBe('');
    expect(values).toEqual([]);
  });

  it('matches Never as "no timestamp at all", binding nothing', () => {
    // A principal with no activity row and one whose row is all-null are the
    // same fact to a reader, and the lateral collapses both to NULL.
    const { bind, values } = recordingBind();
    expect(lastSignInFilterWhere('Never', 'act', bind)).toBe(' AND act."lastSignIn" IS NULL');
    expect(values).toEqual([]);
  });

  it.each([
    ['Over 30 days ago', 30],
    ['Over 90 days ago', 90],
    ['Over 180 days ago', 180],
  ])('binds %s as %i days rather than interpolating it', (bucket, days) => {
    const { bind, values } = recordingBind();
    const sql = lastSignInFilterWhere(bucket, 'act', bind);
    expect(values).toEqual([days]);
    expect(sql).toBe(` AND act."lastSignIn" < now() - make_interval(days => $1)`);
  });

  it('excludes never-signed-in accounts from an age bucket', () => {
    // `NULL < anything` is NULL, so they fall out of the age buckets — they are
    // the Never bucket's answer, not the 180-day bucket's.
    const { bind } = recordingBind();
    expect(lastSignInFilterWhere('Over 180 days ago', 'act', bind)).not.toContain('IS NULL');
  });

  it('uses the alias it is given', () => {
    const { bind } = recordingBind();
    expect(lastSignInFilterWhere('Never', 'other', bind)).toContain('other."lastSignIn"');
  });

  it('keeps the bucket map and the offered names in step', () => {
    expect(Object.keys(LAST_SIGN_IN_BUCKETS)).toEqual(LAST_SIGN_IN_BUCKET_NAMES);
    const bind = vi.fn(() => '$1');
    for (const name of LAST_SIGN_IN_BUCKET_NAMES) {
      expect(lastSignInFilterWhere(name, 'act', bind)).not.toBe('');
    }
  });
});

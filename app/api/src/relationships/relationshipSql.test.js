import { describe, it, expect, vi } from 'vitest';
import {
  parseRelFilters,
  validateRelFilters,
  relFiltersToSql,
  relFilterGuard,
  computeAvailability,
} from './relationshipSql.js';
import {
  EDGES,
  OPS,
  edgesForEntity,
  findUncoveredRelationshipTypes,
} from './edgeCatalog.js';

// A stand-in for createParams().bind — records bound values, returns $N.
function fakeBinder() {
  const params = [];
  const bind = (v) => `$${params.push(v)}`;
  return { params, bind };
}

describe('parseRelFilters', () => {
  it('returns [] for empty/absent input', () => {
    expect(parseRelFilters(undefined)).toEqual({ relFilters: [], error: null });
    expect(parseRelFilters('')).toEqual({ relFilters: [], error: null });
  });

  it('parses a JSON string', () => {
    const { relFilters, error } = parseRelFilters('[{"edge":"resource.owners","op":"absent"}]');
    expect(error).toBeNull();
    expect(relFilters).toEqual([{ edge: 'resource.owners', op: 'absent' }]);
  });

  it('passes an already-parsed array through', () => {
    const arr = [{ edge: 'principal.owner', op: 'exists' }];
    expect(parseRelFilters(arr)).toEqual({ relFilters: arr, error: null });
  });

  it('errors on invalid JSON', () => {
    expect(parseRelFilters('{not json').error).toMatch(/not valid JSON/);
  });

  it('errors on a non-array', () => {
    expect(parseRelFilters('{"edge":"x"}').error).toMatch(/must be an array/);
  });

  it('errors when over the condition cap', () => {
    const many = JSON.stringify(Array.from({ length: 21 }, () => ({ edge: 'resource.members', op: 'exists' })));
    expect(parseRelFilters(many).error).toMatch(/too many/);
  });
});

describe('relFiltersToSql — existence operators', () => {
  it('emits EXISTS for exists', () => {
    const { bind } = fakeBinder();
    const sql = relFiltersToSql([{ edge: 'resource.members', op: 'exists' }], { alias: 'r', bind });
    expect(sql).toContain('AND EXISTS (SELECT 1 FROM "ResourceAssignments" ra');
    expect(sql).toContain('ra."resourceId" = r."id"');
    expect(sql).toContain('ra."deletedAt" IS NULL');
  });

  it('emits NOT EXISTS for absent', () => {
    const { bind } = fakeBinder();
    const sql = relFiltersToSql([{ edge: 'resource.owners', op: 'absent' }], { alias: 'r', bind });
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM "ResourceRelationships" rr');
    expect(sql).toContain(`rr."relationshipType" IN ('HasOwnership','HasAppOwnership')`);
    expect(sql).toContain('rr."parentResourceId" = r."id"');
  });

  it('anchors principal edges on the given alias', () => {
    const { bind } = fakeBinder();
    const sql = relFiltersToSql([{ edge: 'principal.sponsor', op: 'exists' }], { alias: 'u', bind });
    expect(sql).toContain(`prx."principalId" = u."id" AND prx."relationshipType" = 'Sponsor'`);
  });
});

describe('relFiltersToSql — count operators', () => {
  it('emits a scalar count subquery with a bound n and the right symbol', () => {
    const { params, bind } = fakeBinder();
    const sql = relFiltersToSql([{ edge: 'resource.owners', op: 'lt', n: 2 }], { alias: 'r', bind });
    expect(sql).toContain('AND (SELECT count(DISTINCT ra."principalId")');
    expect(sql).toMatch(/\) < \$1$/);
    expect(params).toEqual([2]);
  });

  it('maps eq/gt to = and >', () => {
    const eq = relFiltersToSql([{ edge: 'principal.owner', op: 'eq', n: 0 }], { alias: 'u', bind: fakeBinder().bind });
    expect(eq).toContain('count(*)');
    expect(eq).toMatch(/= \$1$/);
    const gt = relFiltersToSql([{ edge: 'principal.owner', op: 'gt', n: 1 }], { alias: 'u', bind: fakeBinder().bind });
    expect(gt).toMatch(/> \$1$/);
  });

  it('AND-s multiple conditions together', () => {
    const { bind } = fakeBinder();
    const sql = relFiltersToSql(
      [{ edge: 'resource.members', op: 'absent' }, { edge: 'resource.owners', op: 'lt', n: 2 }],
      { alias: 'r', bind },
    );
    expect(sql.match(/ AND /g).length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty sql for no conditions', () => {
    expect(relFiltersToSql([], { alias: 'r', bind: fakeBinder().bind })).toBe('');
  });
});

describe('validateRelFilters — fail loud', () => {
  const v = (conds, entity = 'Resource') => validateRelFilters(conds, entity);

  it('accepts valid conditions', () => {
    expect(v([{ edge: 'resource.owners', op: 'absent' }])).toBeNull();
    expect(v([{ edge: 'principal.owner', op: 'lt', n: 2 }], 'Principal')).toBeNull();
  });

  it('rejects an unknown edge', () => {
    expect(v([{ edge: 'bogus', op: 'absent' }])).toMatch(/unknown relationship edge/);
  });

  it('rejects an edge not valid for the entity', () => {
    expect(v([{ edge: 'principal.owner', op: 'absent' }], 'Resource')).toMatch(/not valid for Resource/);
  });

  it('rejects an unknown operator', () => {
    expect(v([{ edge: 'resource.owners', op: 'between' }])).toMatch(/unknown operator/);
  });

  it('rejects a count op with a missing/negative/non-integer n', () => {
    expect(v([{ edge: 'resource.owners', op: 'lt' }])).toMatch(/integer n >= 0/);
    expect(v([{ edge: 'resource.owners', op: 'lt', n: -1 }])).toMatch(/integer n >= 0/);
    expect(v([{ edge: 'resource.owners', op: 'lt', n: 1.5 }])).toMatch(/integer n >= 0/);
  });

  it('rejects a non-object condition', () => {
    expect(v([null])).toMatch(/must be an object/);
  });
});

describe('relFilterGuard middleware', () => {
  const mkRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };

  it('sets req.relFilters and calls next for valid input', () => {
    const req = { query: { relFilters: JSON.stringify([{ edge: 'resource.owners', op: 'absent' }]) } };
    const res = mkRes();
    const next = vi.fn();
    relFilterGuard('Resource')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.relFilters).toEqual([{ edge: 'resource.owners', op: 'absent' }]);
  });

  it('400s on a parse error without calling next', () => {
    const req = { query: { relFilters: '{bad' } };
    const res = mkRes();
    const next = vi.fn();
    relFilterGuard('Resource')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('400s on a validation error and resolves entity from a function', () => {
    const req = { body: { entityType: 'user', relFilters: [{ edge: 'resource.owners', op: 'absent' }] } };
    const res = mkRes();
    const next = vi.fn();
    // resource.owners is not valid for Principal (user → Principal)
    relFilterGuard((r) => (r.body.entityType === 'user' ? 'Principal' : 'Resource'))(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not valid for Principal/);
  });
});

describe('computeAvailability', () => {
  it('maps each edge to its EXISTS probe result', async () => {
    const seen = [];
    const runQuery = async (sql) => {
      seen.push(sql);
      // Two resource edges → a0 (members) true, a1 (owners) false.
      return { rows: [{ a0: true, a1: false }] };
    };
    const edges = await computeAvailability('Resource', runQuery);
    expect(edges.map((e) => e.id)).toEqual(['resource.members', 'resource.owners']);
    expect(edges[0].available).toBe(true);
    expect(edges[1].available).toBe(false);
    expect(seen[0]).toContain('EXISTS (');
  });

  it('returns [] for an entity with no edges without querying', async () => {
    let called = false;
    const edges = await computeAvailability('Identity', async () => { called = true; return { rows: [] }; });
    expect(edges).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('edgeCatalog', () => {
  it('offers exactly the resource edges on Resource and the principal edges on Principal', () => {
    expect(edgesForEntity('Resource').map((e) => e.id).sort()).toEqual(['resource.members', 'resource.owners']);
    expect(edgesForEntity('Principal').map((e) => e.id)).toContain('principal.sponsor');
    expect(edgesForEntity('Identity')).toEqual([]);
  });

  it('every edge exposes the full operator set', () => {
    for (const e of Object.values(EDGES)) expect(e.ops ?? OPS).toEqual(OPS);
    expect(edgesForEntity('Resource')[0].ops).toEqual(OPS);
  });

  it('coverage guard: passes for known types, flags an unknown one', () => {
    expect(findUncoveredRelationshipTypes({
      resourceRelTypes: ['HasOwnership', 'Contains', 'HasAppRole'],
      principalRelTypes: ['Owner', 'Sponsor'],
    })).toEqual([]);

    const drift = findUncoveredRelationshipTypes({
      resourceRelTypes: ['HasFutureThing'],
      principalRelTypes: ['Delegate'],
    });
    expect(drift).toEqual([
      { table: 'ResourceRelationships', relationshipType: 'HasFutureThing' },
      { table: 'PrincipalRelationships', relationshipType: 'Delegate' },
    ]);
  });
});

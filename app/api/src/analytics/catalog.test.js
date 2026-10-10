// fields.js, metrics.js and ontologyTerms.js — the whitelist and its IRIs.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/columnCache.js', () => ({ discoverExtendedAttrKeys: vi.fn() }));
vi.mock('../lib/attributeLabels.js', () => ({ getAttributeLabels: vi.fn() }));

import { discoverExtendedAttrKeys } from '../db/columnCache.js';
import { getAttributeLabels } from '../lib/attributeLabels.js';
import {
  CORE_FIELDS, resolveField, parseExtFieldId, fieldSql, fieldStateSql, listFields, discoveredKeys, describeField,
} from './fields.js';
import { METRICS, getMetric, entityRejection, describeMetrics } from './metrics.js';
import { ONTOLOGY_NAMESPACE, PROPERTY_TERMS, iriFor, classIriFor } from './ontologyTerms.js';

function binder() {
  const params = [];
  return { params, bind: v => `$${params.push(v)}` };
}

describe('ontology terms', () => {
  it('maps every core field - and only core fields - to an IRI in the ontology namespace', () => {
    expect(Object.keys(PROPERTY_TERMS).sort()).toEqual(Object.keys(CORE_FIELDS).sort());
    expect(iriFor('Principal.accountEnabled')).toBe('https://identityatlas.io/ontology#accountEnabled');
    expect(iriFor('Principal.ext.employeeCategory')).toBeNull();
    expect(iriFor('constructor')).toBeNull();
    expect(classIriFor('Identity')).toBe(`${ONTOLOGY_NAMESPACE}Identity`);
    expect(classIriFor('Context')).toBeNull();
  });
});

describe('fields', () => {
  it('parses discovered field ids strictly', () => {
    expect(parseExtFieldId('Principal.ext.employee_Category2')).toEqual({ entity: 'Principal', key: 'employee_Category2' });
    for (const bad of ['Principal.ext.', 'Context.ext.x', "Principal.ext.x'--", 'Principal.ext.a.b', 42, null]) {
      expect(parseExtFieldId(bad)).toBeNull();
    }
  });

  it('resolves core and discovered ids, nothing else', () => {
    expect(resolveField('Identity.department')).toBe(CORE_FIELDS['Identity.department']);
    expect(resolveField('Resource.ext.costCenter')).toMatchObject({ entity: 'Resource', extKey: 'costCenter', discovered: true });
    expect(resolveField('Principal.salary')).toBeNull();
    expect(resolveField('hasOwnProperty')).toBeNull();
  });

  it('binds a discovered key instead of writing it into the SQL', () => {
    const b = binder();
    const sql = fieldSql(resolveField('Principal.ext.employeeCategory'), b.bind);
    expect(sql).toBe('(p."extendedAttributes" ->> $1::text)');
    expect(b.params).toEqual(['employeeCategory']);
    const s = binder();
    expect(fieldStateSql(resolveField('Principal.ext.employeeCategory'), 'sp.state', s.bind))
      .toBe("(sp.state -> 'extendedAttributes' ->> $1::text)");
  });

  it('reads core columns as text on each entity alias, and system names through Systems', () => {
    const b = binder();
    expect(fieldSql(CORE_FIELDS['Principal.accountEnabled'], b.bind)).toBe('(p."accountEnabled")::text');
    expect(fieldSql(CORE_FIELDS['Identity.country'], b.bind)).toBe('(i."country")::text');
    expect(fieldSql(CORE_FIELDS['Resource.system'], b.bind)).toContain('s."id" = r."systemId"');
    expect(fieldStateSql(CORE_FIELDS['Principal.department'], 'sp.state', b.bind)).toBe("(sp.state ->> 'department')");
    expect(fieldStateSql(CORE_FIELDS['Principal.system'], 'sp.state', b.bind)).toContain("s.\"id\"::text = sp.state ->> 'systemId'");
    expect(fieldStateSql(CORE_FIELDS['Identity.department'], 'sp.state', b.bind)).toBeNull();
    expect(b.params).toEqual([]);
  });

  it('describes history support per entity and explains non-reportable fields', () => {
    expect(describeField(CORE_FIELDS['Principal.department'])).toMatchObject({ history: 'reconstructable', reportable: true, cardinality: 'measured on save', origin: 'core' });
    expect(describeField(CORE_FIELDS['Identity.department']).history).toBe('current only');
    expect(describeField(CORE_FIELDS['Principal.accountEnabled']).cardinality).toBe('bounded');
    expect(describeField(CORE_FIELDS['Principal.email'])).toMatchObject({ reportable: false, reason: expect.stringMatching(/identifier/i) });
  });
});

describe('listFields / discoveredKeys', () => {
  beforeEach(() => {
    discoverExtendedAttrKeys.mockReset();
    getAttributeLabels.mockReset();
  });

  it('adds each entity\'s discovered keys with the admin label where one is set', async () => {
    discoverExtendedAttrKeys.mockImplementation(async table => (table === 'Principals' ? ['tier', 'userType'] : []));
    getAttributeLabels.mockImplementation(async target => (target === 'principal' ? { tier: 'Account tier' } : {}));
    const fields = await listFields();
    const ext = fields.filter(f => f.origin === 'discovered');
    expect(ext.map(f => [f.id, f.label, f.iri])).toEqual([
      ['Principal.ext.tier', 'Account tier', null],
      ['Principal.ext.userType', 'userType', null],
    ]);
    expect(fields.filter(f => f.origin === 'core')).toHaveLength(Object.keys(CORE_FIELDS).length);
  });

  it('keeps the field when the label lookup fails', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['tier']);
    getAttributeLabels.mockRejectedValue(new Error('down'));
    const ext = (await listFields()).filter(f => f.origin === 'discovered');
    expect(ext.map(f => f.label)).toEqual(['tier', 'tier', 'tier']);
  });

  it('returns one entity\'s discovered keys as a set, from that entity\'s table', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['a', 'b']);
    expect(await discoveredKeys('Identity')).toEqual(new Set(['a', 'b']));
    expect(discoverExtendedAttrKeys).toHaveBeenCalledWith('Identities');
  });
});

describe('metrics', () => {
  it('lets each metric be sliced only by the entities its grain supports', () => {
    expect(entityRejection(METRICS['principals.count'], 'Identity')).toBeNull();
    expect(entityRejection(METRICS['identities.count'], 'Principal')).toMatch(/several cells/);
    expect(entityRejection(METRICS['principals.countAsOf'], 'Identity')).toMatch(/not audited/);
    expect(entityRejection(METRICS['principals.count'], 'Resource')).toBe('principals.count cannot be broken down by Resource fields.');
    expect(entityRejection(METRICS['assignments.governedShare'], 'Resource')).toBeNull();
  });

  it('names a suppression population that is one of the metric\'s own measures', () => {
    for (const m of Object.values(METRICS)) expect(m.measures.map(x => x.name)).toContain(m.population);
  });

  it('describes every metric, with the time grain only on the historical one', () => {
    const d = describeMetrics();
    expect(d.map(m => m.id)).toEqual(Object.keys(METRICS));
    expect(d.filter(m => m.timeGrain).map(m => [m.id, m.historyMethod, m.maxPeriods])).toEqual([['principals.countAsOf', 'reconstructed', 12]]);
    expect(getMetric('nope')).toBeNull();
    expect(getMetric('toString')).toBeNull();
  });
});

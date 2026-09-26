// Tests for the IdentityIQ-shaped fixture. Run by the API Vitest suite (see
// app/api/vitest.config.js). The central claim — that this fixture and the
// scale-dataset fixture are ONE dataset — is checked against that generator's
// actual output files, not against a re-statement of its logic.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateFixture } from './lib/generate.mjs';
import { generateDataset } from '../scale-dataset/lib/generate.mjs';
import { TABLES, LOAD_ORDER, bcpRecord, FIELD_TERMINATOR, ROW_TERMINATOR } from './lib/tables.mjs';
import { resolveIiqParams, IIQ_DEFAULTS } from './lib/params.mjs';
import { idSpace, iiqId, timestamps, attributesXml, catalogXml, xmlEscape } from './lib/iiq.mjs';
import { orgOf } from './lib/rows.mjs';
import { parseArgs } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `iiq-fixture-${name}-`));

// Small but not degenerate: several connectors, applications and roles, and
// shares far enough from 0 and 1 that a flag which is ignored shows up.
const SMALL = { shape: { scale: 0.002, seed: 4242 }, iiq: { workgroups: 7, roleGrantedShare: 0.3, requestedShare: 0.25, appNameDriftShare: 0.05 } };

function readTable(dir, table) {
  const text = fs.readFileSync(path.join(dir, `${table}.bcp`), 'utf8');
  const recs = text.split(ROW_TERMINATOR);
  expect(recs.pop()).toBe(''); // every record is terminated, including the last
  return recs.map(r => {
    const f = r.split(FIELD_TERMINATOR);
    expect(f).toHaveLength(TABLES[table].length);
    return Object.fromEntries(TABLES[table].map((c, i) => [c, f[i]]));
  });
}

function readCsv(dir, file) {
  const [header, ...lines] = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '').trimEnd().split('\n');
  const cols = header.split('\t');
  return lines.map(l => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
}

let dir, manifest, csvDir, csvManifest;
beforeAll(async () => {
  dir = tmp('small');
  manifest = await generateFixture(SMALL, dir);
  csvDir = tmp('csv');
  ({ manifest: csvManifest } = await generateDataset(SMALL.shape, csvDir));
});

describe('schema and generator agree', () => {
  it('every table column list matches sql/01-schema.sql, in order', () => {
    const sql = fs.readFileSync(path.join(here, 'sql', '01-schema.sql'), 'utf8');
    const parsed = {};
    for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      parsed[m[1]] = m[2].split('\n').map(l => l.replace(/--.*$/, '').trim()).filter(Boolean).map(l => l.split(/\s+/)[0]);
    }
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(TABLES).sort());
    for (const [t, cols] of Object.entries(TABLES)) expect(parsed[t], t).toEqual(cols);
  });

  it('02-keys.sql only references tables the schema creates', () => {
    const sql = fs.readFileSync(path.join(here, 'sql', '02-keys.sql'), 'utf8');
    const refs = new Set([...sql.matchAll(/(?:ALTER TABLE|ON) (spt_\w+)/g)].map(m => m[1]));
    for (const t of refs) expect(TABLES, t).toHaveProperty(t);
    expect(LOAD_ORDER.slice().sort()).toEqual(Object.keys(TABLES).sort());
  });

  it('the manifest lists every table with the row count actually written', () => {
    expect(manifest.tables.map(t => t.table)).toEqual(LOAD_ORDER);
    for (const t of manifest.tables) expect(readTable(dir, t.table), t.table).toHaveLength(t.rows);
  });
});

describe('one dataset in two formats', () => {
  it('reports the same shape statistics as the scale-dataset manifest', () => {
    expect(manifest.shape).toEqual(csvManifest.shape);
  });

  it('holds exactly the same (resource, holder) pairs as Assignments.csv', () => {
    // Translate both sides to plan indices: CSV ids and IIQ ids are different
    // spellings of the same entitlement / role / principal.
    const csvUsers = readCsv(csvDir, 'Users.csv').map(u => u.ExternalId);
    const iiqIdentities = readTable(dir, 'spt_identity').filter(r => r.workgroup === '0').map(r => r.id);
    const byCsvUser = new Map(csvUsers.map((id, i) => [id, i]));
    const byIiqIdentity = new Map(iiqIdentities.map((id, i) => [id, i]));
    const csvRes = readCsv(csvDir, 'Resources.csv');
    const csvResIdx = new Map(csvRes.map((r, i) => [r.ExternalId, i]));
    const ents = readTable(dir, 'spt_managed_attribute');
    const entKey = new Map(ents.map((m, i) => [`${m.application}|${m.attribute}|${m.value}`, i]));
    const roles = readTable(dir, 'spt_bundle');
    const roleIdx = new Map(roles.map((b, i) => [b.id, ents.length + i]));

    const csvPairs = readCsv(csvDir, 'Assignments.csv').map(a => `${csvResIdx.get(a.ResourceExternalId)}:${byCsvUser.get(a.UserExternalId)}`);
    const iiqPairs = [
      ...readTable(dir, 'spt_identity_entitlement').map(g => `${entKey.get(`${g.application}|${g.name}|${g.value}`)}:${byIiqIdentity.get(g.identity_id)}`),
      ...readTable(dir, 'spt_identity_assigned_roles').map(a => `${roleIdx.get(a.bundle)}:${byIiqIdentity.get(a.identity_id)}`),
    ];
    expect(iiqPairs.some(p => p.includes('undefined'))).toBe(false);
    expect(iiqPairs.slice().sort()).toEqual(csvPairs.slice().sort());
  });

  it('names people, entitlements and applications the same way', () => {
    const csvUsers = readCsv(csvDir, 'Users.csv');
    const people = readTable(dir, 'spt_identity').filter(r => r.workgroup === '0');
    expect(people.map(p => p.display_name)).toEqual(csvUsers.map(u => u.DisplayName));
    expect(people.map(p => p.inactive === '0')).toEqual(csvUsers.map(u => u.Enabled === 'true'));
    expect(people.map(p => p.subdivtext)).toEqual(csvUsers.map(u => u.Department));
    const csvEnts = readCsv(csvDir, 'Resources.csv').filter(r => r.ResourceType !== 'BusinessRole');
    const ents = readTable(dir, 'spt_managed_attribute');
    expect(ents.map(e => e.displayable_name)).toEqual(csvEnts.map(r => r.DisplayName));
    expect(ents.map(e => e.value)).toEqual(csvEnts.map(r => r.EntitlementValue));
  });
});

describe('IdentityIQ storage', () => {
  it('ids are 32 lowercase hex, unique across every table, and share long prefixes like real ones', () => {
    const all = [];
    for (const t of ['spt_application', 'spt_identity', 'spt_managed_attribute', 'spt_identity_entitlement', 'spt_bundle', 'spt_bundle_profile_relation', 'spt_custom']) {
      for (const r of readTable(dir, t)) all.push(r.id);
    }
    for (const id of all) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(all).size).toBe(all.length);
    const prefixes = new Set(all.map(id => id.slice(0, 16)));
    expect(prefixes.size).toBe(2); // two application servers
  });

  it('idSpace rejects an unknown kind, and the same index in two kinds gives two ids', () => {
    expect(() => idSpace(1, 'nope')).toThrow(/Unknown id kind/);
    expect(iiqId(idSpace(1, 'identity'), 5)).not.toBe(iiqId(idSpace(1, 'bundle'), 5));
  });

  it('timestamps are epoch milliseconds with created <= modified <= asOf, inside the history window', () => {
    const asOf = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 2000; i++) {
      const { created, modified } = timestamps(9, 'grant', i, asOf, 30);
      expect(created).toBeGreaterThanOrEqual(asOf - 30 * 86400000);
      expect(modified).toBeGreaterThanOrEqual(created);
      expect(modified).toBeLessThanOrEqual(asOf);
    }
  });

  it('marks the disabled majority inactive and adds workgroups on top of the shared principals', () => {
    const rows = readTable(dir, 'spt_identity');
    const p = manifest.params.shape;
    expect(rows).toHaveLength(p.principals + 7);
    expect(rows.filter(r => r.workgroup === '1')).toHaveLength(7);
    expect(rows.filter(r => r.workgroup === '0' && r.inactive === '0')).toHaveLength(p.enabledPrincipals);
    expect(rows.filter(r => r.inactive === '1').every(r => r.employeestatus === 'Withdrawn' && r.termination_date)).toBe(true);
    expect(new Set(rows.map(r => r.name)).size).toBe(rows.length);
  });

  it('grants carry role and request provenance at the configured shares', () => {
    const grants = readTable(dir, 'spt_identity_entitlement');
    const share = (f) => grants.filter(f).length / grants.length;
    expect(share(g => g.granted_by_role === '1')).toBeCloseTo(0.3, 1);
    expect(share(g => g.assigned === '1')).toBeCloseTo(0.7 * 0.25, 1);
    expect(grants.some(g => g.granted_by_role === '1' && g.assigned === '1')).toBe(false);
    expect(grants.filter(g => g.granted_by_role === '1').every(g => g.source === 'Role')).toBe(true);
  });

  it('directory accounts and values are distinguished names full of commas', () => {
    const grants = readTable(dir, 'spt_identity_entitlement');
    const dn = grants.filter(g => g.native_identity.startsWith('CN='));
    expect(dn.length).toBeGreaterThan(0);
    expect(dn.every(g => g.native_identity.split(',').length >= 4 && g.value.startsWith('CN='))).toBe(true);
  });

  it('assigned-role positions are unique per identity (the table key)', () => {
    const keys = readTable(dir, 'spt_identity_assigned_roles').map(r => `${r.identity_id}|${r.idx}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the managed-attribute hash is unique, and so is (application, attribute, value)', () => {
    const ents = readTable(dir, 'spt_managed_attribute');
    expect(new Set(ents.map(e => e.hash)).size).toBe(ents.length);
    expect(new Set(ents.map(e => `${e.application}|${e.attribute}|${e.value}`)).size).toBe(ents.length);
  });

  it('role composition points at real entitlements by application + attribute + value', () => {
    const keys = new Set(readTable(dir, 'spt_managed_attribute').map(e => `${e.application}|${e.attribute}|${e.value}`));
    const rel = readTable(dir, 'spt_bundle_profile_relation');
    expect(rel.length).toBeGreaterThanOrEqual(manifest.params.shape.roles);
    for (const r of rel) expect(keys.has(`${r.application_id}|${r.attribute}|${r.value}`)).toBe(true);
  });
});

describe('the logical application in XML', () => {
  it('the catalogue holds one entry per application under the configured record name and keys', () => {
    const [rec] = readTable(dir, 'spt_custom');
    expect(rec.name).toBe(IIQ_DEFAULTS.catalogName);
    const entries = rec.attributes.match(/^ {4}<entry key="/gm);
    expect(entries).toHaveLength(manifest.params.shape.logicalApplications);
    for (const k of IIQ_DEFAULTS.catalogKeys) expect(rec.attributes).toContain(`<entry key="${k}" value="`);
  });

  it('every entitlement names a catalogue application, with the configured share of case/space drift', () => {
    const [rec] = readTable(dir, 'spt_custom');
    const catalogue = new Set([...rec.attributes.matchAll(/^ {4}<entry key="([^"]*)">/gm)].map(m => m[1]));
    const names = readTable(dir, 'spt_managed_attribute').map(e => e.attributes.match(/key="LogicalApplication" value="([^"]*)"/)[1]);
    const exact = names.filter(n => catalogue.has(n)).length;
    const folded = new Set([...catalogue].map(n => n.trim().toLowerCase()));
    expect(names.every(n => folded.has(n.trim().toLowerCase()))).toBe(true);
    expect(1 - exact / names.length).toBeGreaterThan(0.02);
    expect(1 - exact / names.length).toBeLessThan(0.1);
  });

  it('the XML key and catalogue record name are parameters, and an unassigned share drops the entry', async () => {
    const d = tmp('params');
    await generateFixture({ shape: { scale: 0.001, seed: 3 }, iiq: { catalogName: 'Other_Record', appNameKey: 'AppRef', unassignedAppShare: 1 } }, d);
    const [rec] = readTable(d, 'spt_custom');
    expect(rec.name).toBe('Other_Record');
    const ents = readTable(d, 'spt_managed_attribute');
    expect(ents.some(e => e.attributes.includes('AppRef') || e.attributes.includes('LogicalApplication'))).toBe(false);
  });

  it('escapes XML metacharacters and leaves out null entries', () => {
    expect(xmlEscape('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
    const xml = attributesXml([['k', 'R&D <x>'], ['gone', null]]);
    expect(xml).toContain('value="R&amp;D &lt;x&gt;"');
    expect(xml).not.toContain('gone');
    expect(catalogXml([{ name: 'A"1', fields: [['owner', '1'], ['none', undefined]] }])).toContain('<entry key="A&quot;1">');
  });
});

describe('determinism, records, parameters, CLI', () => {
  it('the same seed reproduces every file byte for byte, and another seed does not', async () => {
    const digest = (d) => LOAD_ORDER.map(t => crypto.createHash('sha256').update(fs.readFileSync(path.join(d, `${t}.bcp`))).digest('hex'));
    const again = tmp('again');
    await generateFixture(SMALL, again);
    expect(digest(again)).toEqual(digest(dir));
    const other = tmp('other');
    await generateFixture({ ...SMALL, shape: { ...SMALL.shape, seed: 4243 } }, other);
    expect(digest(other)).not.toEqual(digest(dir));
  });

  it('bcpRecord writes nulls as empty fields and refuses a terminator inside a value', () => {
    expect(bcpRecord(['a', null, undefined, 0, 'multi\nline'])).toBe(`a${FIELD_TERMINATOR}${FIELD_TERMINATOR}${FIELD_TERMINATOR}0${FIELD_TERMINATOR}multi\nline${ROW_TERMINATOR}`);
    expect(() => bcpRecord([`x${FIELD_TERMINATOR}y`])).toThrow(/terminator/);
    expect(() => bcpRecord([`x${ROW_TERMINATOR}`])).toThrow(/terminator/);
  });

  it('validates IdentityIQ parameters and passes shape overrides to the shared resolver', () => {
    expect(resolveIiqParams({ shape: { scale: 0.5 } }).shape.principals).toBe(90000);
    expect(() => resolveIiqParams({ iiq: { roleGrantedShare: 1.5 } })).toThrow(/roleGrantedShare/);
    expect(() => resolveIiqParams({ iiq: { workgroups: -1 } })).toThrow(/workgroups/);
    expect(() => resolveIiqParams({ iiq: { roleSizeMin: 5, roleSizeMax: 2 } })).toThrow(/roleSize/);
    expect(() => resolveIiqParams({ iiq: { appNameKey: ' ' } })).toThrow(/appNameKey/);
    expect(() => resolveIiqParams({ shape: { scale: 0 } })).toThrow(/scale/);
  });

  it('orgOf gives everyone in a department the same sector and division', () => {
    expect(orgOf('Finance')).toEqual(orgOf('Finance'));
    expect(orgOf('Finance').subdivtext).toBe('Finance');
    expect(orgOf('Finance').divtext).toMatch(/^Division [1-5]$/);
  });

  it('parses the command line into shape and IdentityIQ overrides', () => {
    const o = parseArgs(['--out', 'x', '--scale', '0.1', '--seed', '7', '--set', 'enabledShare=0.5', '--iiq', 'catalogName=Cat', '--iiq', 'workgroups=3']);
    expect(o).toMatchObject({ out: 'x', overrides: { shape: { scale: 0.1, seed: 7, enabledShare: 0.5 }, iiq: { catalogName: 'Cat', workgroups: 3 } } });
    expect(() => parseArgs(['--out', 'x', '--iiq', 'nope=1'])).toThrow(/known parameter/);
    expect(() => parseArgs(['--scale', '1'])).toThrow(/--out is required/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option '--bogus'/);
    expect(() => parseArgs(['--out'])).toThrow(/argument missing/);
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

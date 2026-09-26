// End-to-end tests of the scale fixture: generate a small run into a temp folder
// and check the SHAPE of what landed on disk — referential integrity between the
// files, the enabled ratio, the skew, cross-system applications, name collisions,
// and byte-identical reproducibility. Run by the API Vitest suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateDataset, generateCommaFixture } from './lib/generate.mjs';
import { CsvWriter, formatField, resolveDelimiter } from './lib/csvWriter.mjs';
import { parseArgs, main } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['Systems.csv', 'Contexts.csv', 'Resources.csv', 'ContextMembers.csv', 'Users.csv', 'Assignments.csv'];
const SMALL = { scale: 0.005, seed: 11 }; // 900 principals, 4000 entitlements, 8 applications

// RFC 4180 reader for the tests (quoted fields, doubled quotes). Strips the BOM.
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  return rows;
}

function readTable(dir, file, delimiter = '\t') {
  const [header, ...rows] = parseDelimited(fs.readFileSync(path.join(dir, file), 'utf8'), delimiter);
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `scale-${name}-`));

let dir, manifest, t;
beforeAll(async () => {
  dir = tmp('small');
  ({ manifest } = await generateDataset(SMALL, dir));
  t = Object.fromEntries(FILES.map(f => [f, readTable(dir, f)]));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('volumes', () => {
  it('each file has the row count the parameters ask for, and the manifest agrees', () => {
    const p = manifest.params;
    expect(t['Users.csv'].length).toBe(p.principals);
    expect(t['Resources.csv'].length).toBe(p.entitlements + p.roles);
    expect(t['ContextMembers.csv'].length).toBe(p.entitlements);
    expect(t['Contexts.csv'].length).toBe(p.logicalApplications);
    expect(t['Systems.csv'].length).toBe(p.connectors + 1);
    expect(t['Assignments.csv'].length).toBe(p.entitlementAssignments + p.roleAssignments);
    for (const f of manifest.files) expect(t[f.file].length).toBe(f.rows);
  });
});

describe('referential integrity', () => {
  it('every assignment points at a known resource, principal and system', () => {
    const res = new Set(t['Resources.csv'].map(r => r.ExternalId));
    const users = new Set(t['Users.csv'].map(r => r.ExternalId));
    const systems = new Set(t['Systems.csv'].map(r => r.DisplayName));
    for (const a of t['Assignments.csv']) {
      if (!res.has(a.ResourceExternalId) || !users.has(a.UserExternalId) || !systems.has(a.SystemName)) {
        throw new Error(`dangling assignment ${JSON.stringify(a)}`);
      }
    }
  });

  it('an assignment is routed to the system its resource lives in', () => {
    const sysOf = new Map(t['Resources.csv'].map(r => [r.ExternalId, r.SystemName]));
    expect(t['Assignments.csv'].every(a => sysOf.get(a.ResourceExternalId) === a.SystemName)).toBe(true);
  });

  it('no principal holds the same resource twice', () => {
    const pairs = new Set(t['Assignments.csv'].map(a => `${a.ResourceExternalId}|${a.UserExternalId}`));
    expect(pairs.size).toBe(t['Assignments.csv'].length);
  });

  it('every entitlement belongs to exactly one logical application; roles to none', () => {
    const apps = new Set(t['Contexts.csv'].map(c => c.ExternalId));
    const members = t['ContextMembers.csv'];
    expect(members.every(m => apps.has(m.ContextExternalId) && m.MemberType === 'Resource')).toBe(true);
    const entitlements = t['Resources.csv'].filter(r => r.ResourceType !== 'BusinessRole').map(r => r.ExternalId);
    expect(new Set(members.map(m => m.MemberExternalId))).toEqual(new Set(entitlements));
    expect(members.length).toBe(entitlements.length);
  });

  it('every SystemName, manager and application owner resolves', () => {
    const systems = new Set(t['Systems.csv'].map(r => r.DisplayName));
    const users = new Map(t['Users.csv'].map(u => [u.ExternalId, u]));
    for (const f of ['Resources.csv', 'Users.csv', 'Contexts.csv']) expect(t[f].every(r => systems.has(r.SystemName))).toBe(true);
    expect(t['Users.csv'].filter(u => u.ManagerExternalId).every(u => users.has(u.ManagerExternalId))).toBe(true);
    expect(t['Contexts.csv'].every(c => users.get(c.OwnerUserId)?.Enabled === 'true')).toBe(true);
  });

  it('external ids are unique across every file and every system', () => {
    const ids = ['Systems.csv', 'Contexts.csv', 'Resources.csv', 'Users.csv'].flatMap(f => t[f].map(r => r.ExternalId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('shape', () => {
  it('exactly a quarter of the principals are enabled — the disabled majority', () => {
    const enabled = t['Users.csv'].filter(u => u.Enabled === 'true').length;
    expect(enabled).toBe(manifest.params.enabledPrincipals);
    expect(t['Users.csv'].filter(u => u.Enabled === 'false').length).toBe(manifest.params.principals - enabled);
    expect(manifest.shape.enabledPrincipals).toBe(enabled);
  });

  it('entitlement membership is skewed: a heavy head over a long, thin tail', () => {
    const per = new Map();
    for (const a of t['Assignments.csv']) per.set(a.ResourceExternalId, (per.get(a.ResourceExternalId) ?? 0) + 1);
    const ent = t['Resources.csv'].filter(r => r.ResourceType !== 'BusinessRole').map(r => per.get(r.ExternalId) ?? 0);
    const sorted = ent.sort((a, b) => b - a);
    const med = sorted[sorted.length >> 1];
    expect(sorted.at(-1)).toBeLessThanOrEqual(med);
    expect(sorted[0]).toBeGreaterThanOrEqual(20 * med);
    // The top 5% of entitlements hold over 40% of all assignments (uniform: 5%).
    const head = sorted.slice(0, Math.ceil(sorted.length / 20)).reduce((s, v) => s + v, 0);
    expect(head / sorted.reduce((s, v) => s + v, 0)).toBeGreaterThan(0.4);
    expect(sorted[0]).toBe(manifest.shape.entitlementHolders.max);
  });

  it('entitlements spread unevenly: a couple of large connectors, many small', () => {
    const per = new Map();
    for (const r of t['Resources.csv']) if (r.ResourceType !== 'BusinessRole') per.set(r.SystemName, (per.get(r.SystemName) ?? 0) + 1);
    const shares = [...per.values()].sort((a, b) => b - a).map(v => v / manifest.params.entitlements);
    expect(shares[0]).toBeGreaterThan(0.25);
    expect(shares[0] + shares[1]).toBeGreaterThan(0.4);
    expect(shares.filter(s => s < 0.03).length).toBeGreaterThan(per.size / 2);
  });

  it('logical applications span technical connectors', () => {
    const sysOf = new Map(t['Resources.csv'].map(r => [r.ExternalId, r.SystemName]));
    const span = new Map();
    for (const m of t['ContextMembers.csv']) {
      if (!span.has(m.ContextExternalId)) span.set(m.ContextExternalId, new Set());
      span.get(m.ContextExternalId).add(sysOf.get(m.MemberExternalId));
    }
    const multi = [...span.values()].filter(s => s.size > 1).length;
    expect(multi).toBeGreaterThanOrEqual(span.size / 2);
    expect(multi).toBe(manifest.shape.applicationsSpanningSystems);
  });

  it('directory entitlements carry distinguished names full of commas', () => {
    const dns = t['Resources.csv'].filter(r => r.ResourceType === 'Group');
    expect(dns.length).toBeGreaterThan(manifest.params.entitlements / 4);
    expect(dns.every(r => (r.EntitlementValue.match(/,/g) ?? []).length >= 5)).toBe(true);
    expect(t['Resources.csv'].every(r => r.Description.includes(','))).toBe(true);
  });

  it('some display names collide only by case or trailing whitespace', () => {
    for (const [file, filter] of [['Resources.csv', r => r.ResourceType !== 'BusinessRole'], ['Users.csv', () => true]]) {
      const byNorm = new Map();
      for (const r of t[file].filter(filter)) {
        const k = r.DisplayName.trimEnd().toLowerCase();
        if (!byNorm.has(k)) byNorm.set(k, new Set());
        byNorm.get(k).add(r.DisplayName);
      }
      const near = [...byNorm.values()].filter(s => s.size > 1).length;
      expect(near, file).toBeGreaterThanOrEqual(2);
    }
  });

  it('roles are BusinessRole resources in the identity store with ordinary assignment rows', () => {
    const roles = new Set(t['Resources.csv'].filter(r => r.ResourceType === 'BusinessRole').map(r => r.ExternalId));
    expect(roles.size).toBe(manifest.params.roles);
    const roleRows = t['Assignments.csv'].filter(a => roles.has(a.ResourceExternalId));
    expect(roleRows.length).toBe(manifest.params.roleAssignments);
    expect(roleRows.every(a => a.AssignmentType === 'Direct' && a.SystemName === 'Identity Store')).toBe(true);
  });

  it('tab output never needs quoting', () => {
    for (const f of FILES) expect(fs.readFileSync(path.join(dir, f), 'utf8').includes('"'), f).toBe(false);
  });
});

describe('reproducibility and delimiters', () => {
  it('the same seed reproduces byte-identical files; another seed does not', async () => {
    const again = tmp('again');
    const other = tmp('other');
    try {
      await generateDataset(SMALL, again);
      await generateDataset({ ...SMALL, seed: 12 }, other);
      for (const f of [...FILES, 'manifest.json']) expect(sha(path.join(again, f)), f).toBe(sha(path.join(dir, f)));
      expect(sha(path.join(other, 'Assignments.csv'))).not.toBe(sha(path.join(dir, 'Assignments.csv')));
    } finally {
      fs.rmSync(again, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('a comma-delimited run holds the same data, correctly quoted', async () => {
    const comma = tmp('comma');
    try {
      await generateDataset(SMALL, comma, { delimiter: ',', bom: false });
      expect(fs.readFileSync(path.join(comma, 'Users.csv'))[0]).not.toBe(0xef);
      for (const f of ['Resources.csv', 'Users.csv', 'Contexts.csv']) expect(readTable(comma, f, ',')).toEqual(t[f]);
    } finally { fs.rmSync(comma, { recursive: true, force: true }); }
  });
});

describe('comma-shift fixture', () => {
  it('the committed fixture is exactly what the generator emits', async () => {
    const out = tmp('fixture');
    try {
      await generateCommaFixture(out);
      for (const f of FILES) expect(fs.readFileSync(path.join(out, f), 'utf8'), f).toBe(fs.readFileSync(path.join(here, 'fixtures', 'comma-shift', f), 'utf8'));
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  it('splitting on the delimiter without quote handling shifts the columns', () => {
    const text = fs.readFileSync(path.join(here, 'fixtures', 'comma-shift', 'Resources.csv'), 'utf8');
    const [headerLine, firstRow] = text.replace(/^﻿/, '').split('\n');
    const header = headerLine.split(',');
    const naive = firstRow.split(',');
    const proper = parseDelimited(`${firstRow}\n`, ',')[0];
    expect(proper.length).toBe(header.length);
    expect(naive.length).toBeGreaterThan(header.length);
    const sys = header.indexOf('SystemName');
    expect(naive[sys]).not.toBe(proper[sys]);
  });
});

describe('writer', () => {
  it('quotes a field only when it must', () => {
    expect(formatField('a,b', ',')).toBe('"a,b"');
    expect(formatField('a,b', '\t')).toBe('a,b');
    expect(formatField('say "hi"', '\t')).toBe('"say ""hi"""');
    expect(formatField('two\nlines', ';')).toBe('"two\nlines"');
    expect(formatField(null, ',')).toBe('');
  });

  it('resolves delimiter names and refuses unusable ones', () => {
    expect(['tab', 'comma', 'semicolon', 'pipe', '\\t', '~', undefined].map(resolveDelimiter)).toEqual(['\t', ',', ';', '|', '\t', '~', '\t']);
    expect(() => resolveDelimiter('"')).toThrow(/Unsupported/);
    expect(() => resolveDelimiter('ab')).toThrow(/Unsupported/);
  });

  it('streams past its chunk size and reports rows and bytes that match the file', async () => {
    const out = tmp('writer');
    const file = path.join(out, 'big.csv');
    try {
      const w = new CsvWriter(file, ['A', 'B'], { delimiter: ';', bom: true });
      const long = 'x'.repeat(500);
      for (let i = 0; i < 6000; i++) await w.writeRow([i, long]);   // ~3 MB → several flushes
      const res = await w.close();
      const text = fs.readFileSync(file, 'utf8');
      expect(res.rows).toBe(6000);
      expect(res.bytes).toBe(fs.statSync(file).size);
      expect(text.startsWith('﻿A;B\n0;x')).toBe(true);
      expect(text.trimEnd().split('\n').length).toBe(6001);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });
});

describe('command line', () => {
  it('parses flags and --set overrides', () => {
    const o = parseArgs(['--out', 'x', '--scale', '0.1', '--seed', '3', '--delimiter', 'semicolon', '--no-bom', '--set', 'crossSystemShare=0.5', '--no-comma-fixture']);
    expect(o).toMatchObject({ out: 'x', delimiter: ';', bom: false, commaFixture: false, overrides: { scale: 0.1, seed: 3, crossSystemShare: 0.5 } });
  });

  it('rejects unknown flags, unknown parameters, a missing value and a missing --out', () => {
    expect(() => parseArgs(['--out', 'x', '--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--out', 'x', '--set', 'nope=1'])).toThrow(/known parameter/);
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/);
    expect(() => parseArgs([])).toThrow(/--out is required/);
  });

  it('--help prints usage without generating', async () => {
    const lines = [];
    expect(await main(['--help'], (m) => lines.push(m))).toBeNull();
    expect(lines.join('\n')).toMatch(/Usage/);
  });

  it('writes the dataset and, unless told not to, the comma-shift fixture', async () => {
    const out = tmp('cli');
    const quiet = () => {};
    try {
      const m = await main(['--out', out, '--scale', '0.001', '--set', 'connectors=5'], quiet);
      expect(m.params.connectors).toBe(5);
      expect(fs.existsSync(path.join(out, 'comma-shift-fixture', 'Resources.csv'))).toBe(true);
      const bare = path.join(out, 'bare');
      await main(['--out', bare, '--scale', '0.001', '--no-comma-fixture'], quiet);
      expect(fs.existsSync(path.join(bare, 'comma-shift-fixture'))).toBe(false);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });
});

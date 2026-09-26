// One writer per table: streams bcp records from the plan and returns
// { table, rows, bytes }. Only the grant table is large; it derives its rows
// on the fly and holds nothing per row.

import path from 'node:path';
import { CsvWriter } from '../../scale-dataset/lib/csvWriter.mjs';
import { stream } from '../../scale-dataset/lib/random.mjs';
import { coprimeStride } from '../../scale-dataset/lib/plan.mjs';
import { iiqId, catalogXml, timestamps } from './iiq.mjs';
import { bcpRecord, FIELD_TERMINATOR } from './tables.mjs';
import {
  applicationRow, identityRow, workgroupRow, managedAttributeRow, entitlementFacts, grantRow,
  bundleRow, profileRelationRows, catalogEntries,
} from './rows.mjs';

export const SCHEMA_VERSION = Object.freeze(['main', '8.x-fixture', '8.x-fixture']);

function open(dir, table) {
  return new CsvWriter(path.join(dir, `${table}.bcp`), null, { delimiter: FIELD_TERMINATOR, bom: false });
}

async function finish(w, table) {
  const { rows, bytes } = await w.close();
  return { table, rows, bytes };
}

async function writeRows(dir, table, rows) {
  const w = open(dir, table);
  for (const r of rows) await w.writeLine(bcpRecord(r));
  return finish(w, table);
}

// The holder walk of the scale-dataset fixture, step for step: one stream named
// 'assignments', entitlements first then roles, and per resource a coprime
// stride from a random start. Consuming the stream identically is what makes
// these grants the same pairs as that fixture's Assignments.csv — which
// generate.test.js checks against the file itself.
export function* holderWalk(plan) {
  const rng = stream(plan.params.seed, 'assignments');
  const n = plan.params.principals;
  const walk = function* (kind, index, count) {
    const stride = coprimeStride(n, rng);
    let p = rng.int(n);
    for (let j = 0; j < count; j++) {
      yield [kind, index, p];
      p += stride;
      if (p >= n) p -= n;
    }
  };
  for (let e = 0; e < plan.params.entitlements; e++) yield* walk('entitlement', e, plan.entHolders[e]);
  for (let r = 0; r < plan.params.roles; r++) yield* walk('role', r, plan.roleHolders[r]);
}

export const writeDatabaseVersion = (ctx, dir) => writeRows(dir, 'spt_database_version', [SCHEMA_VERSION]);

export const writeApplications = (ctx, dir) => writeRows(dir, 'spt_application', ctx.plan.connectors.map(c => applicationRow(ctx, c)));

export async function writeIdentities(ctx, dir) {
  const w = open(dir, 'spt_identity');
  for (let i = 0; i < ctx.plan.params.principals; i++) await w.writeLine(bcpRecord(identityRow(ctx, i)));
  for (let g = 0; g < ctx.iiq.workgroups; g++) await w.writeLine(bcpRecord(workgroupRow(ctx, g)));
  return finish(w, 'spt_identity');
}

export function writeCustom(ctx, dir) {
  const t = timestamps(ctx.seed, 'custom', 0, ctx.iiq.asOf, ctx.iiq.historyDays);
  return writeRows(dir, 'spt_custom', [[iiqId(ctx.spaces.custom, 0), t.created, t.modified, null, ctx.iiq.catalogName,
    'Logical application catalogue', catalogXml(catalogEntries(ctx))]]);
}

export async function writeManagedAttributes(ctx, dir) {
  const w = open(dir, 'spt_managed_attribute');
  for (let e = 0; e < ctx.plan.params.entitlements; e++) await w.writeLine(bcpRecord(managedAttributeRow(ctx, e)));
  return finish(w, 'spt_managed_attribute');
}

export async function writeBundles(ctx, dir) {
  const w = open(dir, 'spt_bundle');
  for (let r = 0; r < ctx.plan.params.roles; r++) await w.writeLine(bcpRecord(bundleRow(ctx, r)));
  return finish(w, 'spt_bundle');
}

export async function writeProfileRelations(ctx, dir) {
  const w = open(dir, 'spt_bundle_profile_relation');
  let seq = 0;
  for (let r = 0; r < ctx.plan.params.roles; r++) {
    for (const row of profileRelationRows(ctx, r, seq)) { await w.writeLine(bcpRecord(row)); seq++; }
  }
  return finish(w, 'spt_bundle_profile_relation');
}

// Both assignment tables in one pass over the holder walk, since the walk is a
// single random stream shared by entitlements and roles.
export async function writeAssignments(ctx, dir) {
  const grants = open(dir, 'spt_identity_entitlement');
  const roles = open(dir, 'spt_identity_assigned_roles');
  const idx = new Uint16Array(ctx.plan.params.principals);
  let facts = null;
  let seq = 0;
  for (const [kind, index, p] of holderWalk(ctx.plan)) {
    if (kind === 'entitlement') {
      if (!facts || facts.index !== index) facts = { index, ...entitlementFacts(ctx, index) };
      if (grants.append(bcpRecord(grantRow(ctx, facts, p, seq++)))) await grants.flush();
    } else if (roles.append(bcpRecord([ctx.identityIds[p], iiqId(ctx.spaces.bundle, index), idx[p]++]))) {
      await roles.flush();
    }
  }
  return [await finish(grants, 'spt_identity_entitlement'), await finish(roles, 'spt_identity_assigned_roles')];
}

export const WRITERS = Object.freeze([
  writeDatabaseVersion, writeApplications, writeIdentities, writeCustom, writeManagedAttributes,
  writeBundles, writeProfileRelations, writeAssignments,
]);

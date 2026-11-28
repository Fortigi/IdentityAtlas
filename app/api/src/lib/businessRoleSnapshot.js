// A point-in-time picture of a business role: what a composition review looked
// at, stored with the review (migration 116) so a later reader sees the role as
// it was when it was reviewed, not as it is now.
//
//   {
//     version: 2,
//     takenAt,
//     role:      { displayName, description, catalogName, holderCount },
//     type:      { control, waysIn, waysOut, reviewGap },
//     resources: [{ id, displayName, resourceType, systemName, roleName }],
//     policies:  [{ id, displayName, waysIn, waysOut, targetRule, requiresApproval, expiration }],
//     owners:    [{ role, displayName, derivedFrom, principalId, identityId }],
//     participants: [{ policyId, participation, subjectType, displayName, principalId, groupId, managerLevel, isFallback, stage }],
//   }
//
// Version 2 (migration 120) added who the owners are (their ids, so a review can
// propose other people against them) and the people the policies name: who
// approves a request and who reviews the holders.
//
// The parts reuse the definitions the role's own pages use (the access model,
// the holder count, who answers for the role), so the picture and the page agree.

import * as db from '../db/connection.js';
import { ROLE_CONTROL_SQL, roleAccessModels, holderCountSql } from './businessRoleAccessModel.js';
import { loadBusinessRoleOwners } from './businessRoleOwners.js';
import { loadParticipants, withPolicyResponsible } from './businessRolePeople.js';
import { catalogJoinSql } from './businessRoleCatalog.js';

export const SNAPSHOT_VERSION = 2;

// The role's catalog (role portfolio) is the Catalog context that holds it
// (migration 117), read through the same join as every other screen.
export const ROLE_SQL = `
    SELECT r."displayName", r.description, c."displayName" AS "catalogName",
           ${holderCountSql('r.id')} AS "holderCount"
      FROM "Resources" r
      ${catalogJoinSql('r.id')}
     WHERE r.id = $1`;

// The live resources the role contains, as its Resources tab shows them: a
// resource deleted in the source is history, one with no Resources row still
// counts by the name the relationship gives it.
export const RESOURCES_SQL = `
    SELECT DISTINCT rrs."childResourceId" AS id,
           COALESCE(r."displayName", rrs."roleName") AS "displayName",
           r."resourceType", s."displayName" AS "systemName", rrs."roleName"
      FROM "ResourceRelationships" rrs
      LEFT JOIN "Resources" r ON r.id = rrs."childResourceId"
      LEFT JOIN "Systems" s ON s.id = r."systemId"
     WHERE rrs."parentResourceId" = $1 AND rrs."relationshipType" = 'Contains'
       AND r."deletedAt" IS NULL
     ORDER BY "displayName", id`;

export const POLICIES_SQL = `
    SELECT p.id, p."displayName",
           p."hasAutoAddRule", p."allowsRequest", p."allowsDirectAssignment",
           p."hasAutoRemoveRule", p."hasAccessReview", p."hasExpiration", p."allowsRemovalRequest",
           p."requiresApproval", p.expiration,
           COALESCE(p."targetRule", p."automaticRequestSettings" #>> '{filter,rule}') AS "targetRule"
      FROM "AssignmentPolicies" p
     WHERE p."resourceId" = $1
     ORDER BY p."displayName", p.id`;

const IN_FLAGS = [['Rule', 'hasAutoAddRule'], ['Request', 'allowsRequest'], ['Assigned', 'allowsDirectAssignment']];
const OUT_FLAGS = [['Rule', 'hasAutoRemoveRule'], ['Review', 'hasAccessReview'], ['Expiry', 'hasExpiration'], ['Manual', 'allowsRemovalRequest']];
const waysOf = (flags, p) => flags.filter(([, col]) => p[col] === true).map(([way]) => way);

/** One policy as the picture keeps it. Pure. */
export function snapshotPolicy(p) {
  return {
    id: p.id,
    displayName: p.displayName,
    waysIn: waysOf(IN_FLAGS, p),
    waysOut: waysOf(OUT_FLAGS, p),
    targetRule: p.targetRule ?? null,
    requiresApproval: p.requiresApproval ?? null,
    expiration: p.expiration ?? null,
  };
}

/** One approver, reviewer or requestor as the picture keeps it. Pure. */
export function snapshotParticipant(p) {
  return {
    policyId: p.policyId ?? null,
    participation: p.participation,
    subjectType: p.subjectType ?? null,
    displayName: p.displayName ?? null,
    principalId: p.principalId ?? null,
    groupId: p.groupId ?? null,
    managerLevel: p.managerLevel ?? null,
    isFallback: p.isFallback === true,
    stage: p.stage ?? 0,
  };
}

const UNKNOWN_TYPE = { control: 'Unknown', waysIn: ['Unknown'], waysOut: ['Unknown'], reviewGap: false };

/** The picture from its parts. Pure. */
export function buildSnapshot({ role, model, resources, policies, owners, participants = [], takenAt }) {
  const type = model ? { control: model.control, waysIn: model.waysIn, waysOut: model.waysOut, reviewGap: model.reviewGap } : UNKNOWN_TYPE;
  return {
    version: SNAPSHOT_VERSION,
    takenAt,
    role: {
      displayName: role?.displayName ?? null,
      description: role?.description ?? null,
      catalogName: role?.catalogName ?? null,
      holderCount: role?.holderCount ?? 0,
    },
    type,
    resources: resources.map(r => ({
      id: r.id, displayName: r.displayName, resourceType: r.resourceType ?? null, systemName: r.systemName ?? null, roleName: r.roleName ?? null,
    })),
    policies: policies.map(snapshotPolicy),
    owners: owners.map(o => ({
      role: o.role, displayName: o.displayName ?? null, derivedFrom: o.derivedFrom ?? null,
      principalId: o.principalId ?? null, identityId: o.identityId ?? null,
    })),
    participants: participants.map(snapshotParticipant),
  };
}

/** The role as it is right now. */
export async function takeSnapshot(roleId, { pool = db, now = () => new Date().toISOString() } = {}) {
  const [role, models, resources, policies, stored, participants] = await Promise.all([
    pool.query(ROLE_SQL, [roleId]),
    pool.query(ROLE_CONTROL_SQL, [[roleId]]),
    pool.query(RESOURCES_SQL, [roleId]),
    pool.query(POLICIES_SQL, [roleId]),
    loadBusinessRoleOwners(roleId),
    loadParticipants(roleId),
  ]);
  return buildSnapshot({
    role: role.rows[0],
    model: roleAccessModels(models.rows).get(roleId),
    resources: resources.rows,
    policies: policies.rows,
    owners: withPolicyResponsible(stored, participants),
    participants,
    takenAt: now(),
  });
}

const resourcesOf = (snapshot) => snapshot?.resources || [];
const controlOf = (snapshot) => snapshot?.type?.control ?? 'Unknown';
const ownerKey = (owners = []) => owners.map(o => `${o.role}|${o.principalId ?? o.identityId ?? o.displayName ?? ''}`).sort().join(';');
const ruleKey = (policies = []) => policies.map(p => `${p.id}|${p.targetRule ?? ''}|${(p.waysIn || []).join(',')}|${(p.waysOut || []).join(',')}`).sort().join(';');

/**
 * What changed between two pictures: resources added and removed (by name),
 * the type when it moved, whether any policy or its rule changed, and whether
 * other people answer for it. Pure.
 */
export function compareSnapshots(before, now) {
  const was = resourcesOf(before);
  const is = resourcesOf(now);
  const wasIds = new Set(was.map(r => r.id));
  const isIds = new Set(is.map(r => r.id));
  const fromType = controlOf(before);
  const toType = controlOf(now);
  return {
    added: is.filter(r => !wasIds.has(r.id)).map(r => r.displayName),
    removed: was.filter(r => !isIds.has(r.id)).map(r => r.displayName),
    type: fromType === toType ? null : { from: fromType, to: toType },
    policiesChanged: ruleKey(before?.policies) !== ruleKey(now?.policies),
    ownersChanged: ownerKey(before?.owners) !== ownerKey(now?.owners),
  };
}

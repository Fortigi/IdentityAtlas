// Seed for the clean-database contract test: at least one row in every table
// the migrations create, each with what a clean must do to it.
//
// seedEverything(q) inserts the rows (q = (sql, params) => { rows }) and returns
// the expectations: [{ table, where, params, expect: 'kept' | 'removed' }].
// `where` finds exactly the seeded row. A table missing here fails the contract
// test — seed a row for every new table and say whether a clean keeps it.
//
// The rows are chosen to tell a right clean from a wrong one: a synced context
// WITHOUT a scope system (a NULL-unsafe predicate keeps it), a manual context
// under a generated parent (a plain cascade deletes it), a member of a manual
// context added by a plugin (a context-only rule keeps it), a claim kept on a
// kept context next to one on a removed context, and so on.

const id = (n) => `c1ea0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  P1: id(1), P2: id(2), R1: id(3), R2: id(4), I1: id(5),
  C_GEN: id(10), C_SYNC: id(11), C_SYNC_NULL: id(12), C_UPLOAD: id(13), C_MANUAL: id(14), C_MANUAL_CHILD: id(15), C_TAG: id(16),
  ALG: id(20), ALG_RUN: id(21),
  IV_KEEP: id(30), IV_GONE: id(31), CL_KEEP: id(32), CL_GONE: id(33), MO_KEEP: id(34), MO_GONE: id(35), CR: id(36),
  TA_KEEP: id(40), TA_GONE: id(41), TA_UPLOAD: id(42),
  WI_KEEP: id(50), WI_GONE: id(51), RP_KEEP: id(52), RP_GONE: id(53),
  SMF: id(60), MS: id(61), SR: id(62), RV: id(63), BOT: id(64), MEMBER: id(65), OWNER: id(66),
  RS_KEEP: id(70), RS_GONE: id(71), U1: id(72), REVIEW: id(73), CAMPAIGN: id(74), ROUND: id(75),
};

const MARK = 'clean-db-contract';

export async function seedEverything(q) {
  const one = async (sql, params = []) => (await q(sql, params)).rows[0];
  const X = IDS;
  const expectations = [];
  const exp = (table, where, params, expect) => expectations.push({ table, where, params, expect });

  // ── Systems: an uploaded list is kept, a crawled system goes ────────────────
  const sUpload = (await one(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('Upload', $1) RETURNING id`, [`${MARK} list`])).id;
  const sCrawl = (await one(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('EntraID', $1) RETURNING id`, [`${MARK} tenant`])).id;
  exp('Systems', 'id = $1', [sUpload], 'kept');
  exp('Systems', 'id = $1', [sCrawl], 'removed');

  // ── Crawler data ────────────────────────────────────────────────────────────
  await q(`INSERT INTO "Principals" (id,"systemId","displayName","principalType") VALUES ($1,$3,'P1','User'),($2,$3,'P2','User')`, [X.P1, X.P2, sCrawl]);
  exp('Principals', 'id = $1', [X.P1], 'removed');
  await q(`INSERT INTO "Resources" (id,"systemId","displayName","resourceType") VALUES ($1,$3,'R1','BusinessRole'),($2,$3,'R2','Group')`, [X.R1, X.R2, sCrawl]);
  exp('Resources', 'id = $1', [X.R1], 'removed');
  await q(`INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId") VALUES ($1,$2,'Direct',$3)`, [X.R2, X.P1, sCrawl]);
  exp('ResourceAssignments', '"resourceId" = $1', [X.R2], 'removed');
  await q(`INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId") VALUES ($1,$2,'Contains',$3)`, [X.R1, X.R2, sCrawl]);
  exp('ResourceRelationships', '"parentResourceId" = $1', [X.R1], 'removed');
  await q(`INSERT INTO "PrincipalRelationships" ("principalId","relatedPrincipalId","relationshipType","systemId") VALUES ($1,$2,'Owner',$3)`, [X.P1, X.P2, sCrawl]);
  exp('PrincipalRelationships', '"principalId" = $1', [X.P1], 'removed');
  await q(`INSERT INTO "PrincipalActivity" ("principalId","activityType") VALUES ($1,'SignIn')`, [X.P1]);
  exp('PrincipalActivity', '"principalId" = $1', [X.P1], 'removed');
  await q(`INSERT INTO "Identities" (id,"displayName","analystVerified","analystNotes") VALUES ($1,'Ida',true,'checked')`, [X.I1]);
  exp('Identities', 'id = $1', [X.I1], 'removed');
  await q(`INSERT INTO "IdentityMembers" ("identityId","principalId","analystOverride") VALUES ($1,$2,'confirmed')`, [X.I1, X.P1]);
  exp('IdentityMembers', '"identityId" = $1', [X.I1], 'removed');
  for (const t of ['AssignmentPolicies', 'AssignmentRequests', 'CertificationDecisions']) {
    await q(`INSERT INTO "${t}" (id,"systemId") VALUES (gen_random_uuid(),$1)`, [sCrawl]);
    exp(t, '"systemId" = $1', [sCrawl], 'removed');
  }
  await q(`INSERT INTO "DeltaTokens" ("systemId",endpoint,token) VALUES ($1,'/users/delta','tok')`, [sCrawl]);
  exp('DeltaTokens', '"systemId" = $1', [sCrawl], 'removed');
  await q(`INSERT INTO "GraphSyncLog" ("SyncType","Status","systemId") VALUES ('Full','Completed',$1)`, [sCrawl]);
  exp('GraphSyncLog', '"systemId" = $1', [sCrawl], 'removed');
  const job = await one(`INSERT INTO "CrawlerJobs" ("jobType") VALUES ($1) RETURNING id`, [MARK]);
  exp('CrawlerJobs', 'id = $1', [job.id], 'removed');

  // ── Settings that must survive ──────────────────────────────────────────────
  const cfg = await one(`INSERT INTO "CrawlerConfigs" ("crawlerType","displayName",config,"lastRunAt","lastRunStatus") VALUES ('entra-id',$1,'{}'::jsonb,now(),'completed') RETURNING id`, [MARK]);
  exp('CrawlerConfigs', 'id = $1 AND "lastRunAt" IS NULL AND "lastRunStatus" IS NULL', [cfg.id], 'kept');
  const crawler = await one(`INSERT INTO "Crawlers" ("displayName","apiKeyHash","apiKeySalt","apiKeyPrefix") VALUES ($1,'\\x01','\\x02','fgc_test') RETURNING id`, [MARK]);
  exp('Crawlers', 'id = $1', [crawler.id], 'kept');
  await q(`INSERT INTO "CrawlerAuditLog" ("crawlerId",action) VALUES ($1,$2)`, [crawler.id, MARK]);
  exp('CrawlerAuditLog', 'action = $1', [MARK], 'kept');
  for (const [key, value, expect] of [
    ['AUTH_ROLE_PERMISSIONS', '{"Admin":["*"]}', 'kept'],
    ['FEATURE_CLEAN_DB_CONTRACT', 'true', 'kept'],
    ['LLM_CONFIG', '{"provider":"none"}', 'kept'],
    ['matrixViews.lastProbeRebuildAt', '2026-01-01T00:00:00Z', 'removed'],
  ]) {
    await q(`INSERT INTO "WorkerConfig" ("configKey","configValue") VALUES ($1,$2) ON CONFLICT ("configKey") DO UPDATE SET "configValue" = EXCLUDED."configValue"`, [key, value]);
    exp('WorkerConfig', '"configKey" = $1', [key], expect);
  }
  await q(`INSERT INTO "WorkerConfig" ("configKey","configValue") VALUES ('syncVersion','41') ON CONFLICT ("configKey") DO UPDATE SET "configValue" = '41'`);
  exp('WorkerConfig', `"configKey" = 'syncVersion' AND "configValue" = '42'`, [], 'kept');
  await q(`INSERT INTO "GraphUserPreferences" ("userId") VALUES ($1) ON CONFLICT DO NOTHING`, [MARK]);
  exp('GraphUserPreferences', '"userId" = $1', [MARK], 'kept');
  const prof = await one(`INSERT INTO "RiskProfiles" ("displayName",profile,"isActive") VALUES ($1,'{}'::jsonb,false) RETURNING id`, [MARK]);
  exp('RiskProfiles', 'id = $1', [prof.id], 'kept');
  const cls = await one(`INSERT INTO "RiskClassifiers" ("displayName",classifiers,"profileId","isActive") VALUES ($1,'[]'::jsonb,$2,false) RETURNING id`, [MARK, prof.id]);
  exp('RiskClassifiers', 'id = $1', [cls.id], 'kept');
  const gp = await one(`INSERT INTO "GraphRiskProfiles" ("profileJson") VALUES ('{}'::jsonb) RETURNING id`);
  exp('GraphRiskProfiles', 'id = $1', [gp.id], 'kept');
  const gc = await one(`INSERT INTO "GraphRiskClassifiers" ("classifiersJson") VALUES ('[]'::jsonb) RETURNING id`);
  exp('GraphRiskClassifiers', 'id = $1', [gc.id], 'kept');
  const alc = await one(`INSERT INTO "AccountLinkingConfig" (rules) VALUES ('{}'::jsonb) RETURNING id`);
  exp('AccountLinkingConfig', 'id = $1', [alc.id], 'kept');
  await q(`INSERT INTO "Secrets" (id,scope,ciphertext,iv,"authTag","encryptedKey","keyIv","keyAuthTag") VALUES ($1,'test','\\x01','\\x01','\\x01','\\x01','\\x01','\\x01')`, [MARK]);
  exp('Secrets', 'id = $1', [MARK], 'kept');
  await q(`INSERT INTO "ReadApiKeys" (name,"tokenHash","tokenPrefix") VALUES ($1,'hash-clean-db','fgr_cdb')`, [MARK]);
  exp('ReadApiKeys', 'name = $1', [MARK], 'kept');
  await q(`INSERT INTO "ContextAlgorithms" (id,name,"displayName","targetType") VALUES ($1,$2,'Clean test','Principal')`, [X.ALG, MARK]);
  exp('ContextAlgorithms', 'id = $1', [X.ALG], 'kept');

  // ── Derived ─────────────────────────────────────────────────────────────────
  await q(`INSERT INTO "ContextAlgorithmRuns" (id,"algorithmId",status,"scopeSystemId") VALUES ($1,$2,'succeeded',$3)`, [X.ALG_RUN, X.ALG, sCrawl]);
  exp('ContextAlgorithmRuns', 'id = $1', [X.ALG_RUN], 'removed');
  const sr = await one(`INSERT INTO "ScoringRuns" ("profileId","classifierId",status) VALUES ($1,$2,'completed') RETURNING id`, [prof.id, cls.id]);
  exp('ScoringRuns', 'id = $1', [sr.id], 'removed');
  const lr = await one(`INSERT INTO "AccountLinkingRuns" ("configId") VALUES ($1) RETURNING id`, [alc.id]);
  exp('AccountLinkingRuns', 'id = $1', [lr.id], 'removed');
  await q(`INSERT INTO "DashboardSnapshots" ("snapshotDate") VALUES (DATE '2001-02-03') ON CONFLICT DO NOTHING`);
  exp('DashboardSnapshots', `"snapshotDate" = DATE '2001-02-03'`, [], 'removed');
  await q(`INSERT INTO "RiskScores" ("entityId","entityType","riskScore","riskTier","riskOverride") VALUES ($1,'Principal',80,'High',10),($2,'Principal',70,'High',NULL)`, [X.RS_KEEP, X.RS_GONE]);
  exp('RiskScores', '"entityId" = $1', [X.RS_KEEP], 'kept');
  exp('RiskScores', '"entityId" = $1', [X.RS_GONE], 'removed');

  // ── Contexts, by variant ────────────────────────────────────────────────────
  const ctx = (cid, variant, scope, parent, name) => q(
    `INSERT INTO "Contexts" (id,variant,"targetType","contextType","displayName","scopeSystemId","parentContextId","sourceAlgorithmId","sourceRunId")
     VALUES ($1,$2,'Principal','Department',$3,$4,$5,$6,$7)`,
    [cid, variant, name, scope, parent, variant === 'generated' ? X.ALG : null, variant === 'generated' ? X.ALG_RUN : null]);
  await ctx(X.C_GEN, 'generated', sCrawl, null, 'gen');
  await ctx(X.C_SYNC, 'synced', sCrawl, null, 'sync');
  await ctx(X.C_SYNC_NULL, 'synced', null, null, 'sync-no-scope');
  await ctx(X.C_UPLOAD, 'synced', sUpload, null, 'uploaded');
  await ctx(X.C_MANUAL, 'manual', sCrawl, null, 'manual');
  await ctx(X.C_MANUAL_CHILD, 'manual', null, X.C_GEN, 'manual under generated');
  await ctx(X.C_TAG, 'manual', null, X.C_MANUAL, 'manual under manual');
  exp('Contexts', 'id = $1', [X.C_GEN], 'removed');
  exp('Contexts', 'id = $1', [X.C_SYNC], 'removed');
  exp('Contexts', 'id = $1', [X.C_SYNC_NULL], 'removed');
  exp('Contexts', 'id = $1', [X.C_UPLOAD], 'kept');
  exp('Contexts', 'id = $1 AND "scopeSystemId" IS NULL', [X.C_MANUAL], 'kept');
  exp('Contexts', 'id = $1 AND "parentContextId" IS NULL', [X.C_MANUAL_CHILD], 'kept');
  exp('Contexts', 'id = $1 AND "parentContextId" = $2', [X.C_TAG, X.C_MANUAL], 'kept');

  const member = (c, m, by) => q(`INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,'Principal',$2,$3)`, [c, m, by]);
  await member(X.C_MANUAL, X.P1, 'analyst');
  await member(X.C_MANUAL, X.P2, 'algorithm');
  await member(X.C_UPLOAD, X.P1, 'sync');
  await member(X.C_SYNC, X.P1, 'analyst');
  exp('ContextMembers', '"contextId" = $1 AND "memberId" = $2', [X.C_MANUAL, X.P1], 'kept');
  exp('ContextMembers', '"contextId" = $1 AND "memberId" = $2', [X.C_MANUAL, X.P2], 'removed');
  exp('ContextMembers', '"contextId" = $1 AND "memberId" = $2', [X.C_UPLOAD, X.P1], 'kept');
  exp('ContextMembers', '"contextId" = $1 AND "memberId" = $2', [X.C_SYNC, X.P1], 'removed');

  const rel = (a, b, by) => q(`INSERT INTO "ContextRelationships" ("contextId","relatedContextId","relationshipType","addedBy") VALUES ($1,$2,'SameUnitAs',$3)`, [a, b, by]);
  await rel(X.C_MANUAL, X.C_UPLOAD, 'analyst');
  await rel(X.C_MANUAL, X.C_GEN, 'analyst');
  await rel(X.C_MANUAL_CHILD, X.C_TAG, 'algorithm');
  exp('ContextRelationships', '"contextId" = $1 AND "relatedContextId" = $2', [X.C_MANUAL, X.C_UPLOAD], 'kept');
  exp('ContextRelationships', '"contextId" = $1 AND "relatedContextId" = $2', [X.C_MANUAL, X.C_GEN], 'removed');
  exp('ContextRelationships', '"contextId" = $1 AND "relatedContextId" = $2', [X.C_MANUAL_CHILD, X.C_TAG], 'removed');

  await q(`INSERT INTO "ContextRoles" ("contextId","principalId",role,"addedBy") VALUES ($1,$2,'Accountable','analyst')`, [X.C_MANUAL, X.P1]);
  await q(`INSERT INTO "ContextRoles" ("contextId","identityId",role,"addedBy") VALUES ($1,$2,'Responsible','sync')`, [X.C_UPLOAD, X.I1]);
  exp('ContextRoles', '"contextId" = $1', [X.C_MANUAL], 'removed');
  exp('ContextRoles', '"contextId" = $1', [X.C_UPLOAD], 'removed');
  await q(`INSERT INTO "ContextRoleSuggestionRejections" ("contextId","principalId",role) VALUES ($1,$2,'Accountable')`, [X.C_MANUAL, X.P1]);
  exp('ContextRoleSuggestionRejections', '"contextId" = $1', [X.C_MANUAL], 'removed');
  await q(`INSERT INTO "BusinessRoleOwners" ("resourceId","principalId",role,"addedBy") VALUES ($1,$2,'Accountable','analyst'),($1,$3,'Responsible','sync')`, [X.R1, X.P1, X.P2]);
  exp('BusinessRoleOwners', '"resourceId" = $1 AND role = \'Accountable\'', [X.R1], 'removed');
  exp('BusinessRoleOwners', '"resourceId" = $1 AND role = \'Responsible\'', [X.R1], 'removed');
  await q(`INSERT INTO "BusinessRoleOwnerRejections" ("resourceId","principalId",role) VALUES ($1,$2,'Accountable')`, [X.R1, X.P2]);
  exp('BusinessRoleOwnerRejections', '"resourceId" = $1', [X.R1], 'removed');
  await q(`INSERT INTO "BusinessRoleCompositionReviews" (id,"resourceId",notes,"reviewedBy",snapshot) VALUES ($3,$1,'looks right',$2,'{"version":2}'::jsonb)`, [X.R1, MARK, X.REVIEW]);
  exp('BusinessRoleCompositionReviews', '"resourceId" = $1', [X.R1], 'removed');
  await q(`INSERT INTO "BusinessRoleCompositionReviewSteps" ("reviewId",step,verdict,remark) VALUES ($1,'contents','needsChange','SG-HR does not belong here')`, [X.REVIEW]);
  exp('BusinessRoleCompositionReviewSteps', '"reviewId" = $1', [X.REVIEW], 'removed');
  // A campaign and its round stay; what they asked about the removed role goes.
  await q(`INSERT INTO "ReviewCampaigns" (id,name,steps,"startsOn","dueDays","createdBy") VALUES ($1,'Yearly review','["contents"]'::jsonb,'2026-01-01',30,$2)`, [X.CAMPAIGN, MARK]);
  exp('ReviewCampaigns', 'id = $1', [X.CAMPAIGN], 'kept');
  await q(`INSERT INTO "ReviewCampaignRounds" (id,"campaignId",number,"startsAt","dueAt") VALUES ($1,$2,1,'2026-01-01','2026-01-31')`, [X.ROUND, X.CAMPAIGN]);
  exp('ReviewCampaignRounds', 'id = $1', [X.ROUND], 'kept');
  await q(`INSERT INTO "ReviewCampaignScopes" ("campaignId","resourceId") VALUES ($1,$2)`, [X.CAMPAIGN, X.R1]);
  exp('ReviewCampaignScopes', '"campaignId" = $1', [X.CAMPAIGN], 'removed');
  await q(`INSERT INTO "ReviewCampaignRequests" ("roundId","resourceId","reviewId") VALUES ($1,$2,$3)`, [X.ROUND, X.R1, X.REVIEW]);
  exp('ReviewCampaignRequests', '"roundId" = $1', [X.ROUND], 'removed');
  await q(`INSERT INTO "ManagerHierarchyOverrides" ("principalId","managerPrincipalId","setBy") VALUES ($1,$2,$3)`, [X.P1, X.P2, MARK]);
  exp('ManagerHierarchyOverrides', '"principalId" = $1', [X.P1], 'removed');

  // ── Owners and uploads ──────────────────────────────────────────────────────
  await q(`INSERT INTO "SystemOwners" ("systemId","userId") VALUES ($1,$3),($2,$3)`, [sUpload, sCrawl, X.OWNER]);
  exp('SystemOwners', '"systemId" = $1', [sUpload], 'kept');
  exp('SystemOwners', '"systemId" = $1', [sCrawl], 'removed');
  await q(`INSERT INTO "ContextUploads" ("systemId","rootContextId","fileName",template,"keyColumn",mapping) VALUES ($1,$2,'list.csv','OrganizationalUnit','key','{}'::jsonb)`, [sUpload, X.C_UPLOAD]);
  exp('ContextUploads', '"systemId" = $1 AND "rootContextId" = $2', [sUpload, X.C_UPLOAD], 'kept');

  // ── Interviews, claims, decisions, change requests ──────────────────────────
  const iv = (iid, c) => q(`INSERT INTO "ContextInterviews" (id,"contextId","principalId","intervieweeName","interviewedAt","fileName",transcript) VALUES ($1,$2,$3,'Ann',DATE '2026-01-01','t.txt','text')`, [iid, c, X.P1]);
  await iv(X.IV_KEEP, X.C_MANUAL);
  await iv(X.IV_GONE, X.C_SYNC);
  exp('ContextInterviews', 'id = $1 AND "principalId" IS NULL AND "intervieweeName" = $2', [X.IV_KEEP, 'Ann'], 'kept');
  exp('ContextInterviews', 'id = $1', [X.IV_GONE], 'removed');
  const claim = (cid, i, c) => q(`INSERT INTO "ContextClaims" (id,"interviewId","contextId","claimKind","subjectKind","principalId",value,"proposedBy","objectContextId") VALUES ($1,$2,$3,'description','Person',$4,'v','analyst',$5)`, [cid, i, c, X.P1, X.C_GEN]);
  await claim(X.CL_KEEP, X.IV_KEEP, X.C_MANUAL);
  await claim(X.CL_GONE, X.IV_GONE, X.C_SYNC);
  exp('ContextClaims', 'id = $1 AND "principalId" IS NULL AND "objectContextId" IS NULL', [X.CL_KEEP], 'kept');
  exp('ContextClaims', 'id = $1', [X.CL_GONE], 'removed');
  await q(`INSERT INTO "ContextMemberOverrides" (id,"contextId","memberId","claimId",overrides) VALUES ($1,$2,$3,$4,'sync'),($5,$6,$3,$7,'sync')`, [X.MO_KEEP, X.C_MANUAL, X.MEMBER, X.CL_KEEP, X.MO_GONE, X.C_SYNC, X.CL_GONE]);
  exp('ContextMemberOverrides', 'id = $1', [X.MO_KEEP], 'kept');
  exp('ContextMemberOverrides', 'id = $1', [X.MO_GONE], 'removed');
  await q(`INSERT INTO "ChangeRequests" (id,"changeKind","targetSystemId","targetName","contextId","summary","basisClaimId","overrideId") VALUES ($1,'EntityDelete',$2,'tenant',$3,'s',$4,$5)`, [X.CR, sCrawl, X.C_SYNC, X.CL_GONE, X.MO_GONE]);
  exp('ChangeRequests', 'id = $1 AND "targetSystemId" IS NULL AND "contextId" IS NULL AND "basisClaimId" IS NULL AND "overrideId" IS NULL', [X.CR], 'kept');

  // ── Tree adjustments ────────────────────────────────────────────────────────
  const adj = (aid, scope, key) => q(`INSERT INTO "ContextTreeAdjustments" (id,"treeKey","scopeSystemId",op,"createdBy") VALUES ($1,$2,$3,'renameUnit',$4)`, [aid, key, scope, MARK]);
  await adj(X.TA_KEEP, null, `gen~${X.ALG}~x`);
  await adj(X.TA_GONE, sCrawl, `sync~${sCrawl}~OrganizationalUnit`);
  await adj(X.TA_UPLOAD, sUpload, `sync~${sUpload}~OrganizationalUnit`);
  exp('ContextTreeAdjustments', 'id = $1', [X.TA_KEEP], 'kept');
  exp('ContextTreeAdjustments', 'id = $1', [X.TA_GONE], 'removed');
  exp('ContextTreeAdjustments', 'id = $1', [X.TA_UPLOAD], 'kept');

  // ── Workbench ───────────────────────────────────────────────────────────────
  for (const [wi, c, rp, claimId, base] of [[X.WI_KEEP, X.C_MANUAL, X.RP_KEEP, X.CL_KEEP, X.R1], [X.WI_GONE, X.C_GEN, X.RP_GONE, X.CL_KEEP, null]]) {
    await q(`INSERT INTO "WorkbenchInvestigations" (id,"contextId",name,"createdBy","updatedBy") VALUES ($1,$2,'inv',$3,$3)`, [wi, c, MARK]);
    await q(`INSERT INTO "WorkbenchAccessSnapshots" ("investigationId") VALUES ($1)`, [wi]);
    await q(`INSERT INTO "WorkbenchMarks" ("investigationId","personKind","personId","resourceId",mark,"markedBy") VALUES ($1,'principal',$2,$3,'other',$4)`, [wi, X.P1, X.R2, MARK]);
    await q(`INSERT INTO "RoleProposals" (id,"investigationId","createdBy","updatedBy","baseBusinessRoleId") VALUES ($1,$2,$3,$3,$4)`, [rp, wi, MARK, base]);
    await q(`INSERT INTO "RoleProposalMembers" ("proposalId","personKind","personId") VALUES ($1,'principal',$2)`, [rp, X.P1]);
    await q(`INSERT INTO "RoleProposalEntitlements" ("proposalId","resourceId") VALUES ($1,$2)`, [rp, X.R2]);
    await q(`INSERT INTO "RoleProposalEvidence" ("proposalId","claimId") VALUES ($1,$2)`, [rp, claimId]);
  }
  await q(`INSERT INTO "RoleProposalEvidence" ("proposalId","claimId") VALUES ($1,$2)`, [X.RP_KEEP, X.CL_GONE]);
  for (const [wi, rp, expect] of [[X.WI_KEEP, X.RP_KEEP, 'kept'], [X.WI_GONE, X.RP_GONE, 'removed']]) {
    exp('WorkbenchInvestigations', 'id = $1', [wi], expect);
    exp('WorkbenchAccessSnapshots', '"investigationId" = $1', [wi], expect);
    exp('WorkbenchMarks', '"investigationId" = $1', [wi], expect);
    exp('RoleProposalMembers', '"proposalId" = $1', [rp], expect);
    exp('RoleProposalEntitlements', '"proposalId" = $1', [rp], expect);
  }
  exp('RoleProposals', 'id = $1 AND "baseBusinessRoleId" IS NULL', [X.RP_KEEP], 'kept');
  exp('RoleProposals', 'id = $1', [X.RP_GONE], 'removed');
  exp('RoleProposalEvidence', '"proposalId" = $1 AND "claimId" = $2', [X.RP_KEEP, X.CL_KEEP], 'kept');
  exp('RoleProposalEvidence', '"proposalId" = $1 AND "claimId" = $2', [X.RP_KEEP, X.CL_GONE], 'removed');
  exp('RoleProposalEvidence', '"proposalId" = $1', [X.RP_GONE], 'removed');

  // ── Saved work ──────────────────────────────────────────────────────────────
  await q(`INSERT INTO "SavedMatrixFilters" (id,name,filter) VALUES ($1,$2,'{}'::jsonb)`, [X.SMF, MARK]);
  exp('SavedMatrixFilters', 'id = $1', [X.SMF], 'kept');
  await q(`INSERT INTO "MatrixShares" (id,name,filter,"savedFilterId") VALUES ($1,$2,'{}'::jsonb,$3)`, [X.MS, MARK, X.SMF]);
  exp('MatrixShares', 'id = $1 AND "savedFilterId" = $2', [X.MS, X.SMF], 'kept');
  await q(`INSERT INTO "MatrixShareRecipients" ("shareId","userKey") VALUES ($1,'someone')`, [X.MS]);
  exp('MatrixShareRecipients', '"shareId" = $1', [X.MS], 'kept');
  await q(`INSERT INTO "MatrixShareAccesses" ("shareId","userKey") VALUES ($1,'someone')`, [X.MS]);
  exp('MatrixShareAccesses', '"shareId" = $1', [X.MS], 'kept');
  await q(`INSERT INTO "SavedReports" (id,name,definition) VALUES ($1,$2,'{}'::jsonb)`, [X.SR, MARK]);
  exp('SavedReports', 'id = $1', [X.SR], 'kept');
  await q(`INSERT INTO "ReportViews" (id,"reportName",name) VALUES ($1,'ledger',$2)`, [X.RV, MARK]);
  exp('ReportViews', 'id = $1', [X.RV], 'kept');
  const cat = await one(`INSERT INTO "GovernanceCategories" (name,color) VALUES ($1,'#fff') RETURNING id`, [MARK]);
  await q(`INSERT INTO "GovernanceCategoryAssignments" ("categoryId","resourceId") VALUES ($1,$2)`, [cat.id, X.R1]);
  exp('GovernanceCategories', 'id = $1', [cat.id], 'kept');
  exp('GovernanceCategoryAssignments', '"categoryId" = $1', [cat.id], 'kept');

  // ── Audit ───────────────────────────────────────────────────────────────────
  await q(`INSERT INTO "AuthRoleChangeLog" (action) VALUES ($1)`, [MARK]);
  exp('AuthRoleChangeLog', 'action = $1', [MARK], 'kept');
  await q(`INSERT INTO "McpToolCalls" (tool,outcome) VALUES ($1,'ok')`, [MARK]);
  exp('McpToolCalls', 'tool = $1', [MARK], 'kept');
  await q(`INSERT INTO "UpdateLog" (channel,status) VALUES ($1,'checked')`, [MARK]);
  exp('UpdateLog', 'channel = $1', [MARK], 'kept');
  await q(`INSERT INTO "ComponentVersions" (component) VALUES ($1) ON CONFLICT DO NOTHING`, [MARK]);
  exp('ComponentVersions', 'component = $1', [MARK], 'kept');
  await q(`INSERT INTO "BotConversations" (id,question,outcome) VALUES ($1,'q','answered')`, [X.BOT]);
  exp('BotConversations', 'id = $1', [X.BOT], 'kept');

  // ── _history: what the triggers wrote above, plus an old row ─────────────────
  await q(`INSERT INTO "_history" ("tableName","rowId",operation,"rowData") VALUES ('Principals',$1,'D','{}'::jsonb)`, [X.U1]);
  exp('_history', `"tableName" = 'Principals' AND "rowId" = $1`, [X.U1], 'removed');
  exp('_history', `"tableName" = 'Principals' AND "rowId" = $1`, [X.P1], 'removed');
  exp('_history', `"tableName" = 'Contexts' AND "rowId" = $1`, [X.C_GEN], 'removed');
  exp('_history', `"tableName" = 'ContextClaims' AND "rowId" = $1`, [X.CL_GONE], 'removed');
  exp('_history', `"tableName" = 'Contexts' AND "rowId" = $1`, [X.C_MANUAL], 'kept');
  exp('_history', `"tableName" = 'ContextClaims' AND "rowId" = $1`, [X.CL_KEEP], 'kept');
  exp('_history', `"tableName" = 'SavedMatrixFilters' AND "rowId" = $1`, [X.SMF], 'kept');
  exp('_history', `"tableName" = 'Systems' AND "rowId" = $1`, [String(sUpload)], 'kept');

  return { expectations, systems: { sUpload, sCrawl } };
}

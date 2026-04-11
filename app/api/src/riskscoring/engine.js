// Identity Atlas v5 — Risk scoring engine (postgres-native).
//
// Port of the v4 PowerShell scoring logic. The full v4 engine had four layers
// (direct match, membership analysis, structural hygiene, cross-entity
// propagation). v1 of the postgres port focuses on the highest-impact two:
//
//   Layer 1 — Direct classifier match
//     For each Principal and Resource, run every classifier pattern against
//     the displayName / email / jobTitle / description. The best matching
//     classifier's score becomes the directScore (0-100). Multiple matches are
//     all recorded in classifierMatches for the UI to show.
//
//   Layer 2 — Lightweight membership signal
//     For groups (Resources where resourceType in 'EntraGroup','BusinessRole'),
//     count the number of distinct active assignees. Small groups (<=5 members)
//     score +5 (concentrated risk). Owner-heavy groups score +5.
//
// Final score = round(0.6*direct + 0.25*membership + 0.15*structural), capped at 100.
// Membership and structural are placeholders for now (set to 0 unless layer 2
// fires) so the formula stays the same shape as v4 — easier to extend later.
//
// Tier thresholds match v4: Critical 90+, High 70+, Medium 40+, Low 20+, Minimal 1+.
//
// The runner is invoked via POST /api/risk-scoring/runs (see riskScoring routes).
// It writes a row into ScoringRuns first, then runs in the background while the
// HTTP response returns 202 + the run id. The wizard UI polls for progress.

import * as db from '../db/connection.js';

const W_DIRECT = 0.60;
const W_MEMBERSHIP = 0.25;
const W_STRUCTURAL = 0.15;
const W_PROPAGATED = 0.00; // not yet implemented

function tierFor(score) {
  if (score >= 90) return 'Critical';
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  if (score >= 20) return 'Low';
  if (score >= 1)  return 'Minimal';
  return 'None';
}

// Compile a single classifier's patterns to RegExp objects, lowercasing the
// regex source string is wrong (case-insensitive should be a flag). We use the
// 'i' flag and rely on the LLM to produce sane regex.
function compileClassifier(c) {
  const compiled = [];
  for (const p of (c.patterns || [])) {
    try { compiled.push(new RegExp(p, 'i')); }
    catch { /* malformed regex from the LLM — skip it */ }
  }
  return { ...c, _compiled: compiled };
}

// Test text against a classifier's compiled patterns. Returns true on first match.
function classifierMatches(classifier, ...textFields) {
  for (const re of classifier._compiled) {
    for (const t of textFields) {
      if (t && re.test(t)) return true;
    }
  }
  return false;
}

// Score a single entity against a list of compiled classifiers.
// Returns { directScore, matches: [...] }
function scoreOne(textFields, classifiers) {
  const matches = [];
  let best = 0;
  for (const c of classifiers) {
    if (classifierMatches(c, ...textFields)) {
      matches.push({ id: c.id, label: c.label, score: c.score, tier: c.tier, domain: c.domain });
      if (c.score > best) best = c.score;
    }
  }
  return { directScore: best, matches };
}

// ─── Main entry point ─────────────────────────────────────────────────
// Marks a ScoringRuns row as running, scores everything, writes RiskScores in
// batches, and updates progress as it goes. Returns when complete.
//
// classifierId: id of the RiskClassifiers row to use. If null, the active set is loaded.
export async function runScoring(runId, classifierId = null) {
  const updateRun = async (fields) => {
    const setClauses = Object.keys(fields).map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    await db.query(
      `UPDATE "ScoringRuns" SET ${setClauses} WHERE id = $1`,
      [runId, ...Object.values(fields)]
    );
  };

  try {
    await updateRun({ status: 'running', step: 'Loading classifiers', pct: 1 });

    // Load classifier set
    const cls = await db.queryOne(
      classifierId
        ? `SELECT * FROM "RiskClassifiers" WHERE id = $1`
        : `SELECT * FROM "RiskClassifiers" WHERE "isActive" = true ORDER BY "createdAt" DESC LIMIT 1`,
      classifierId ? [classifierId] : []
    );
    if (!cls) throw new Error('No classifier set found. Generate one first.');

    const data = cls.classifiers || {};
    const groupClassifiers = (data.groupClassifiers || []).map(compileClassifier);
    const userClassifiers  = (data.userClassifiers  || []).map(compileClassifier);
    const agentClassifiers = (data.agentClassifiers || []).map(compileClassifier);

    // ── Load principals ──
    await updateRun({ step: 'Loading principals', pct: 5 });
    const principals = await db.query(
      `SELECT id, "displayName", email, "jobTitle", department, "principalType"
         FROM "Principals"`
    );
    // ── Load resources (groups + business roles + roles + apps) ──
    await updateRun({ step: 'Loading resources', pct: 8 });
    const resources = await db.query(
      `SELECT id, "displayName", description, "resourceType"
         FROM "Resources"`
    );

    const totalEntities = principals.rows.length + resources.rows.length;
    await updateRun({ totalEntities, scoredEntities: 0, step: 'Scoring principals', pct: 10 });

    // ── Score principals ──
    const principalScores = [];
    let counter = 0;
    for (const p of principals.rows) {
      const isAgent = ['ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent'].includes(p.principalType);
      const activeCls = isAgent && agentClassifiers.length > 0 ? agentClassifiers : userClassifiers;
      const { directScore, matches } = scoreOne(
        [p.displayName, p.email, p.jobTitle, p.department],
        activeCls
      );
      const final = Math.min(100, Math.round(W_DIRECT * directScore + W_MEMBERSHIP * 0 + W_STRUCTURAL * 0 + W_PROPAGATED * 0));
      principalScores.push({
        entityId: p.id,
        entityType: 'Principal',
        riskScore: final,
        riskTier: tierFor(final),
        riskDirectScore: directScore,
        riskMembershipScore: 0,
        riskStructuralScore: 0,
        riskPropagatedScore: 0,
        riskClassifierMatches: matches,
        riskExplanation: { direct: { score: directScore, matchCount: matches.length } },
      });
      counter++;
      if (counter % 500 === 0) {
        await updateRun({ scoredEntities: counter, pct: 10 + Math.floor((counter / totalEntities) * 50) });
      }
    }

    // ── Score resources (groups + business roles + ...) ──
    await updateRun({ step: 'Scoring resources', pct: 60 });

    // Pre-compute member counts for the small-group bonus.
    // One query: assignment counts per resourceId, only Direct/Owner.
    const memberCounts = await db.query(
      `SELECT "resourceId"::text AS rid, COUNT(*)::int AS cnt
         FROM "ResourceAssignments"
        WHERE "assignmentType" IN ('Direct','Owner','Governed')
        GROUP BY "resourceId"`
    );
    const memberMap = new Map(memberCounts.rows.map(r => [r.rid, r.cnt]));

    const resourceScores = [];
    counter = 0;
    for (const r of resources.rows) {
      const { directScore, matches } = scoreOne(
        [r.displayName, r.description],
        groupClassifiers
      );

      // Layer 2 (lightweight): small group bonus
      let membershipScore = 0;
      const memCount = memberMap.get(String(r.id)) || 0;
      if (memCount > 0 && memCount <= 5) membershipScore += 5;

      const final = Math.min(
        100,
        Math.round(
          W_DIRECT * directScore +
          W_MEMBERSHIP * membershipScore +
          W_STRUCTURAL * 0 +
          W_PROPAGATED * 0
        )
      );
      resourceScores.push({
        entityId: r.id,
        entityType: 'Resource',
        riskScore: final,
        riskTier: tierFor(final),
        riskDirectScore: directScore,
        riskMembershipScore: membershipScore,
        riskStructuralScore: 0,
        riskPropagatedScore: 0,
        riskClassifierMatches: matches,
        riskExplanation: {
          direct: { score: directScore, matchCount: matches.length },
          membership: { score: membershipScore, memberCount: memCount },
        },
      });
      counter++;
      if (counter % 500 === 0) {
        await updateRun({ scoredEntities: principals.rows.length + counter, pct: 60 + Math.floor((counter / resources.rows.length) * 30) });
      }
    }

    // ── Persist into RiskScores ──
    await updateRun({ step: 'Writing RiskScores', pct: 92, scoredEntities: totalEntities });
    const allScores = principalScores.concat(resourceScores);

    // Wipe and bulk-insert. Postgres ON CONFLICT keeps it idempotent across reruns.
    await db.tx(async (client) => {
      await client.query(`DELETE FROM "RiskScores"`);
      // Batch insert in chunks of 1000
      const CHUNK = 1000;
      for (let i = 0; i < allScores.length; i += CHUNK) {
        const chunk = allScores.slice(i, i + CHUNK);
        const values = [];
        const params = [];
        let pi = 1;
        for (const s of chunk) {
          values.push(`($${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, now())`);
          params.push(
            s.entityId,
            s.entityType,
            s.riskScore,
            s.riskTier,
            s.riskDirectScore,
            s.riskMembershipScore,
            s.riskStructuralScore,
            s.riskPropagatedScore,
            JSON.stringify(s.riskExplanation),
            JSON.stringify(s.riskClassifierMatches),
          );
        }
        await client.query(
          `INSERT INTO "RiskScores"
             ("entityId","entityType","riskScore","riskTier","riskDirectScore","riskMembershipScore",
              "riskStructuralScore","riskPropagatedScore","riskExplanation","riskClassifierMatches","riskScoredAt")
           VALUES ${values.join(',')}
           ON CONFLICT ("entityId","entityType") DO UPDATE SET
             "riskScore" = EXCLUDED."riskScore",
             "riskTier" = EXCLUDED."riskTier",
             "riskDirectScore" = EXCLUDED."riskDirectScore",
             "riskMembershipScore" = EXCLUDED."riskMembershipScore",
             "riskStructuralScore" = EXCLUDED."riskStructuralScore",
             "riskPropagatedScore" = EXCLUDED."riskPropagatedScore",
             "riskExplanation" = EXCLUDED."riskExplanation",
             "riskClassifierMatches" = EXCLUDED."riskClassifierMatches",
             "riskScoredAt" = now()`,
          params
        );
      }
    });

    await updateRun({
      status: 'completed',
      step: 'Complete',
      pct: 100,
      scoredEntities: totalEntities,
      completedAt: new Date(),
    });
    return { ok: true, scored: totalEntities };
  } catch (err) {
    console.error('Scoring run failed:', err.message);
    await updateRun({ status: 'failed', errorMessage: err.message, completedAt: new Date() });
    return { ok: false, error: err.message };
  }
}

// Identity Atlas v5 — Risk scoring engine (postgres-native).
//
// Direct port of the v4 PowerShell scoring engine (Functions/RiskScoring/
// Invoke-FGRiskScoring.ps1 on the `dev` branch). The v4 engine produced much
// better results than the first lightweight v5 port because it layered four
// independent signal sources; this file restores that design on top of
// postgres.
//
//   Layer 1 — Direct classifier match
//     For each Principal and Resource, run every classifier pattern against
//     the displayName / email / jobTitle / department / description / mail /
//     externalId / flattened extendedAttributes. The best matching classifier's
//     score becomes the directScore (0-100). All matches are recorded in
//     classifierMatches for the UI to show.
//
//     Non-production environment discount: if the group's name matches one of
//     the OTAP / acc / tst / dev patterns, the direct score is multiplied by
//     0.25 (75% reduction, floor of 5). Mirrors v4's handling of dev/test
//     groups so they don't dominate the "risky" list.
//
//   Layer 2 — Membership / relationship analysis
//     For GROUPS: small-group bonus (+5 when 1-5 members, concentrated risk),
//     no-owner penalty (+5 when group has members but no owner, ungoverned).
//     For USERS: high membership count (+3-15 when user is in >15 groups),
//     member-of-high-risk-group (+15 when the user is a member of a group whose
//     *direct* score is ≥70), many-ownerships (+5 when user owns >3 groups).
//     Both sides cap at 40.
//
//   Layer 3 — Structural / hygiene
//     For GROUPS: no description (+3), mail-enabled security group (+3),
//     role-assignable group (+15), dynamic membership rule on (+3). Cap 25.
//     For USERS: account disabled but still has memberships (+5), guest user
//     (+5). We do NOT score stale sign-in because v5's Entra sync doesn't
//     pull signInActivity yet (gracefully degrades to 0). Cap 25.
//
//   Layer 4 — Cross-entity propagation (one pass)
//     Compute each entity's pre-propagation score from layers 1-3. Then:
//       - each USER inherits 30% of the max pre-propagation score among the
//         groups they're a member of
//       - each GROUP inherits 25% of the max pre-propagation score among its
//         members
//     One pass only — no recursion — which matches v4 and avoids runaway
//     amplification.
//
// Weights match v4 exactly: 0.50 direct, 0.20 membership, 0.10 structural,
// 0.20 propagated. Final score is capped at 100. Tier thresholds: Critical 90+,
// High 70+, Medium 40+, Low 20+, Minimal 1+, None 0.
//
// The runner is invoked via POST /api/risk-scoring/runs (see riskScoring
// routes). It writes a row into ScoringRuns first, then runs in the background
// while the HTTP response returns 202 + the run id. The wizard UI polls for
// progress.

import * as db from '../db/connection.js';

// v4 weights (Invoke-FGRiskScoring.ps1 lines 885-888)
const W_DIRECT      = 0.50;
const W_MEMBERSHIP  = 0.20;
const W_STRUCTURAL  = 0.10;
const W_PROPAGATED  = 0.20;

// v4 layer caps (Invoke-FGRiskScoring.ps1 lines 631, 713, 756, 786)
const CAP_MEMBERSHIP = 40;
const CAP_STRUCTURAL = 25;

// v4 propagation dampening factors (Invoke-FGRiskScoring.ps1 lines 827, 851)
const PROP_GROUP_TO_USER = 0.30;
const PROP_USER_TO_GROUP = 0.25;

// Exported for unit tests.
export function tierFor(score) {
  if (score >= 90) return 'Critical';
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  if (score >= 20) return 'Low';
  if (score >= 1)  return 'Minimal';
  return 'None';
}

// ─── Non-production detection ─────────────────────────────────────────
// Direct port of v4's $nonProdPatterns (Invoke-FGRiskScoring.ps1 lines 463-467).
// A group whose name matches any of these is considered dev/test/acc and its
// layer-1 direct score gets multiplied by 0.25 (75% reduction, floor 5).
const NON_PROD_PATTERNS = [
  /[-_](ACC|TST|DEV|ONT|STG|SBX|UAT|QA)(?:[-_\s]|$)/i,
  /[-_][ATDO][-_]/,
  /[-_][ATDO]$/,
  /\b(acceptat|develop|ontwikkel|staging|sandbox|non.?prod|pre.?prod)/i,
];

export function isNonProduction(name) {
  if (!name) return false;
  for (const re of NON_PROD_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

// ─── Match exclusions ─────────────────────────────────────────────────
// The LLM prompt asks the generator to avoid patterns that match news
// bulletins, meeting rooms, calendars, distribution lists etc. — but the
// LLM doesn't always obey, and those classifiers fire on group DESCRIPTIONS
// that legitimately mention "harbour master" (e.g. a room booking group
// named "17.128 Harbour Master room (leslokaal)"). This guard runs AFTER
// the pattern matches and drops matches whose matched-text contains any of
// these hard-exclusion keywords, regardless of which pattern fired.
//
// Add keywords here when you discover new systematic false positives. The
// cost of a false exclusion is tiny compared to the cost of a privileged
// role being buried under dozens of meeting-room false positives.
const MATCH_EXCLUSION_KEYWORDS = [
  // Communications / news
  /\b(nieuws|news|newsletter|nieuwsbrief|bulletin|announcement|mededeling)\b/i,
  // Rooms / meeting spaces
  /\b(room[\s_-]?mailbox|vergader(ruimte|zaal)|meeting[\s_-]?room|leslokaal|lokaal|classroom|klaslokaal)\b/i,
  // Calendar / booking
  /\b(calendar[\s_-]?(editor|viewer|reader)|kalender|agenda[\s_-]?beheer|room[\s_-]?reservation|zaalreservering)\b/i,
  // Mailbox admin
  /\b(shared[\s_-]?mailbox|postbus[\s_-]?(beheer|delen)|mailbox[\s_-]?delegat)/i,
  // Distribution lists (not privileged access)
  /\b(distribution[\s_-]?list|distributielijst|mail[\s_-]?group|email[\s_-]?only)\b/i,
];

export function isExcludedMatch(matchedText) {
  if (!matchedText) return false;
  for (const re of MATCH_EXCLUSION_KEYWORDS) {
    if (re.test(matchedText)) return true;
  }
  return false;
}

// Compile a single classifier's patterns to RegExp objects.
//
// Two gotchas from LLM-generated patterns:
//   1. `(?i)` inline flag — Perl/Python syntax, NOT supported by JavaScript.
//      We strip it before compile since we pass the `i` flag explicitly anyway.
//   2. Other Perl-isms like `(?s)` (dot-matches-newline) — we strip them too
//      and let the default JS behaviour apply.
//
// Compilation failures are logged so we don't silently skip patterns.
// Exported for unit tests.
export function compileClassifier(c) {
  const compiled = [];
  for (const p of (c.patterns || [])) {
    if (typeof p !== 'string' || !p.trim()) continue;
    // Strip unsupported inline flag groups (Perl/Python syntax)
    const cleaned = p.replace(/^\(\?[imsx]+\)/, '').replace(/\(\?[imsx]+\)/g, '');
    try {
      compiled.push(new RegExp(cleaned, 'i'));
    } catch (err) {
      console.warn(`Classifier '${c.id || '(unknown)'}': skipping invalid regex '${p}' — ${err.message}`);
    }
  }
  return { ...c, _compiled: compiled };
}

// Flatten an `extendedAttributes` jsonb value (if any) to a small set of plain
// strings the regex engine can match against. We deliberately skip very large
// values (>200 chars) — they're almost always JSON blobs, base64 blobs, or
// arbitrary descriptions whose presence in a regex match is meaningless and
// creates false positives.
function flattenExtended(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (v.length > 0 && v.length <= 200) out.push(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(obj);
  return out;
}

// Test text against a classifier's compiled patterns. Returns the matching
// pattern string and the field that matched (for UI "why" display).
function classifierMatches(classifier, textFields) {
  for (const re of classifier._compiled) {
    for (const [field, value] of textFields) {
      if (value && re.test(value)) {
        return { pattern: re.source, field, value };
      }
    }
  }
  return null;
}

// Score a single entity against a list of compiled classifiers.
// textFields is an array of [fieldName, stringValue] tuples — the field name
// is persisted alongside the match so the UI can show *where* a pattern hit.
// Returns { directScore, matches: [...] }
//
// Post-filter: any match whose matchedText hits MATCH_EXCLUSION_KEYWORDS is
// dropped (meeting rooms, news bulletins, calendar editors, distribution
// lists, etc.). This is a defensive guard — the LLM's classifier generator
// is *asked* to avoid these but doesn't always obey.
// Exported for unit tests.
export function scoreOne(textFields, classifiers) {
  // Normalise legacy call style: scoreOne([str1, str2], cls) → treat as 'text' field
  const normalised = Array.isArray(textFields) && textFields.length > 0 && !Array.isArray(textFields[0])
    ? textFields.map((v, i) => [`field${i}`, v])
    : textFields;

  const matches = [];
  const excludedMatches = [];
  let best = 0;
  for (const c of classifiers) {
    const hit = classifierMatches(c, normalised);
    if (hit) {
      const matchedText = hit.value.length > 120 ? hit.value.slice(0, 117) + '...' : hit.value;
      const record = {
        id: c.id,
        label: c.label,
        score: c.score,
        tier: c.tier,
        domain: c.domain,
        matchedField: hit.field,
        matchedText,
        matchedPattern: hit.pattern,
      };
      if (isExcludedMatch(hit.value)) {
        // Record for debugging but don't count toward score
        record.excludedByGuardrail = true;
        excludedMatches.push(record);
        continue;
      }
      matches.push(record);
      if (c.score > best) best = c.score;
    }
  }
  return { directScore: best, matches, excludedMatches };
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
      `SELECT id, "displayName", email, "jobTitle", department, "principalType",
              "companyName", "givenName", "surname", "employeeId", "externalId",
              "accountEnabled", "managerId", "extendedAttributes"
         FROM "Principals"`
    );

    // ── Load per-principal activity aggregates ──
    // PrincipalActivity supersedes the old extendedAttributes.signInActivity.
    // We only need the aggregate rows (resourceId = AGG_RESOURCE_ID) and
    // only the latest-sign-in timestamp for stale-account detection. The
    // engine keeps a backwards-compat fallback for ext-attr data until
    // the first full re-crawl lands. Missing table (migration not yet
    // applied) is tolerated — the query catches and returns an empty map.
    const principalActivity = new Map();
    try {
      const act = await db.query(
        `SELECT "principalId",
                "lastSignInDateTime",
                "lastNonInteractiveSignInDateTime",
                "lastSuccessfulSignInDateTime"
           FROM "PrincipalActivity"
          WHERE "resourceId" = '00000000-0000-0000-0000-000000000000'
            AND "activityType" IN ('SignIn', 'ServicePrincipalSignIn')`
      );
      for (const row of act.rows) {
        principalActivity.set(String(row.principalId), row);
      }
    } catch (err) {
      console.warn('PrincipalActivity not available (pre-017 DB?):', err.message);
    }

    // Build manager → direct reports index for hierarchy analysis. Only used
    // when the Entra crawler has populated managerId — if the column is empty
    // across the board, hierarchy signals gracefully degrade to 0.
    const directReports = new Map(); // managerId -> Set<reportPid>
    for (const p of principals.rows) {
      if (p.managerId) {
        const mid = String(p.managerId);
        if (!directReports.has(mid)) directReports.set(mid, new Set());
        directReports.get(mid).add(String(p.id));
      }
    }
    const hierarchyAvailable = directReports.size > 0;
    // ── Load resources ──
    await updateRun({ step: 'Loading resources', pct: 8 });
    const resources = await db.query(
      `SELECT id, "displayName", description, "resourceType", mail, "externalId",
              "extendedAttributes"
         FROM "Resources"`
    );

    // ── Load assignment-derived structural data ──
    // One round-trip per signal; the data is small compared to the scoring loop.
    await updateRun({ step: 'Loading memberships', pct: 12 });

    // Member counts per resource (Direct + Governed for total headcount)
    const memberCountRows = await db.query(
      `SELECT "resourceId"::text AS rid, COUNT(*)::int AS cnt
         FROM "ResourceAssignments"
        WHERE "assignmentType" IN ('Direct','Governed')
        GROUP BY "resourceId"`
    );
    const memberCountMap = new Map(memberCountRows.rows.map(r => [r.rid, r.cnt]));

    // Owner counts per resource
    const ownerCountRows = await db.query(
      `SELECT "resourceId"::text AS rid, COUNT(*)::int AS cnt
         FROM "ResourceAssignments"
        WHERE "assignmentType" = 'Owner'
        GROUP BY "resourceId"`
    );
    const ownerCountMap = new Map(ownerCountRows.rows.map(r => [r.rid, r.cnt]));

    // Build bidirectional index: principal → list of resource ids (memberships)
    //                           resource  → list of principal ids (members)
    // We only follow Direct and Governed for membership propagation — Owner is
    // a different relationship (admin control, not "has access to") and
    // propagating through it double-counts privileged users.
    const assignmentRows = await db.query(
      `SELECT "principalId"::text AS pid, "resourceId"::text AS rid
         FROM "ResourceAssignments"
        WHERE "assignmentType" IN ('Direct','Governed')`
    );
    const principalMemberships = new Map(); // pid -> Set<rid>
    const resourceMembers      = new Map(); // rid -> Set<pid>
    for (const a of assignmentRows.rows) {
      if (!principalMemberships.has(a.pid)) principalMemberships.set(a.pid, new Set());
      principalMemberships.get(a.pid).add(a.rid);
      if (!resourceMembers.has(a.rid)) resourceMembers.set(a.rid, new Set());
      resourceMembers.get(a.rid).add(a.pid);
    }

    // Ownerships: principal → list of resource ids they own
    const ownerRows = await db.query(
      `SELECT "principalId"::text AS pid, "resourceId"::text AS rid
         FROM "ResourceAssignments"
        WHERE "assignmentType" = 'Owner'`
    );
    const principalOwnerships = new Map();
    for (const a of ownerRows.rows) {
      if (!principalOwnerships.has(a.pid)) principalOwnerships.set(a.pid, new Set());
      principalOwnerships.get(a.pid).add(a.rid);
    }

    const totalEntities = principals.rows.length + resources.rows.length;
    await updateRun({ totalEntities, scoredEntities: 0, step: 'Scoring resources (direct)', pct: 15 });

    // ── Pass 1: Score resources (groups, business roles, etc.) ──
    // Done first because user membership analysis below needs group directScores.
    const resourceState = new Map(); // rid -> { directScore, membershipScore, structuralScore, propagatedScore, matches, reasons, isNonProd }
    let counter = 0;
    for (const r of resources.rows) {
      const extFields = flattenExtended(r.extendedAttributes).map((v, i) => [`ext[${i}]`, v]);

      // ── Layer 1: direct classifier match ──
      let { directScore, matches } = scoreOne(
        [
          ['displayName', r.displayName],
          ['description', r.description],
          ['mail',        r.mail],
          ['externalId',  r.externalId],
          ...extFields,
        ],
        groupClassifiers
      );

      // Non-production discount (v4 lines 495-500). Applied to directScore only.
      const nonProd = isNonProduction(r.displayName);
      const directReasons = [];
      if (matches.length > 0) {
        const top = matches.reduce((a, b) => (b.score > a.score ? b : a));
        directReasons.push(`Matched '${top.label || top.id}' on ${top.matchedField} [+${top.score}]`);
      }
      if (nonProd && directScore > 0) {
        const before = directScore;
        directScore = Math.max(5, Math.round(directScore * 0.25));
        directReasons.push(`Non-production environment detected — direct score ${before} → ${directScore} (×0.25)`);
      }

      // ── Layer 2: membership analysis (groups) ──
      // v4 lines 609-630
      let membershipScore = 0;
      const membershipReasons = [];
      const memCount = memberCountMap.get(String(r.id)) || 0;
      const ownCount = ownerCountMap.get(String(r.id)) || 0;

      if (memCount > 0 && memCount <= 5) {
        membershipScore += 5;
        membershipReasons.push(`Small group with ${memCount} member(s) — concentrated access risk [+5]`);
      }
      if (memCount > 0 && ownCount === 0) {
        membershipScore += 5;
        membershipReasons.push(`No owner assigned while having ${memCount} member(s) — ungoverned group [+5]`);
      }
      membershipScore = Math.min(CAP_MEMBERSHIP, membershipScore);

      // ── Layer 3: structural hygiene (groups) ──
      // v4 lines 730-756
      let structuralScore = 0;
      const structuralReasons = [];
      const ext = r.extendedAttributes || {};

      if (!r.description || String(r.description).trim() === '') {
        structuralScore += 3;
        structuralReasons.push('No description set — poor documentation hygiene [+3]');
      }
      const mailEnabled = ext.mailEnabled === true || ext.mailEnabled === 'true';
      const securityEnabled = ext.securityEnabled === true || ext.securityEnabled === 'true';
      if (mailEnabled && securityEnabled) {
        structuralScore += 3;
        structuralReasons.push('Mail-enabled security group — dual-purpose increases attack surface [+3]');
      }
      const roleAssignable = ext.isAssignableToRole === true || ext.isAssignableToRole === 'true';
      if (roleAssignable) {
        structuralScore += 15;
        structuralReasons.push('Role-assignable group — can be assigned Entra ID directory roles [+15]');
      }
      if (ext.membershipRuleProcessingState === 'On') {
        structuralScore += 3;
        structuralReasons.push('Dynamic membership rule active — membership changes automatically [+3]');
      }
      structuralScore = Math.min(CAP_STRUCTURAL, structuralScore);

      resourceState.set(String(r.id), {
        row: r,
        directScore,
        membershipScore,
        structuralScore,
        propagatedScore: 0, // filled in by pass 3
        matches,
        isNonProd: nonProd,
        directReasons,
        membershipReasons,
        structuralReasons,
        propagatedReasons: [],
        memCount,
        ownCount,
      });

      counter++;
      if (counter % 500 === 0) {
        await updateRun({ scoredEntities: counter, pct: 15 + Math.floor((counter / totalEntities) * 25) });
      }
    }

    // ── Pass 2: Score principals ──
    await updateRun({ step: 'Scoring principals (direct + structural)', pct: 45 });
    const principalState = new Map(); // pid -> { ... same shape ... }
    counter = 0;
    for (const p of principals.rows) {
      const isAgent = ['ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent'].includes(p.principalType);
      const activeCls = isAgent && agentClassifiers.length > 0 ? agentClassifiers : userClassifiers;
      const extFields = flattenExtended(p.extendedAttributes).map((v, i) => [`ext[${i}]`, v]);

      // ── Layer 1: direct classifier match ──
      const { directScore, matches } = scoreOne(
        [
          ['displayName', p.displayName],
          ['email',       p.email],
          ['jobTitle',    p.jobTitle],
          ['department',  p.department],
          ['companyName', p.companyName],
          ['givenName',   p.givenName],
          ['surname',     p.surname],
          ['employeeId',  p.employeeId],
          ['externalId',  p.externalId],
          ...extFields,
        ],
        activeCls
      );
      const directReasons = [];
      if (matches.length > 0) {
        const top = matches.reduce((a, b) => (b.score > a.score ? b : a));
        directReasons.push(`Matched '${top.label || top.id}' on ${top.matchedField} [+${top.score}]`);
      }

      // ── Layer 2 (partial): ownerships + hierarchy. High-risk-group-
      // membership signals need group scores, so we finish user membership
      // in pass 3. Hierarchy signals are only meaningful when Entra sync has
      // populated Principals.managerId; they gracefully degrade to 0 when it
      // hasn't (see hierarchyAvailable flag above). v4 lines 684-710.
      let membershipScore = 0;
      const membershipReasons = [];
      const ownCount = (principalOwnerships.get(String(p.id)) || new Set()).size;
      if (ownCount > 3) {
        membershipScore += 5;
        membershipReasons.push(`Owner of ${ownCount} groups — high administrative responsibility [+5]`);
      }

      // Span of control — number of direct reports
      if (hierarchyAvailable) {
        const directCount = (directReports.get(String(p.id)) || new Set()).size;
        if (directCount >= 5) {
          // v4 formula: min(15, 3 + floor((directCount - 5) / 3) * 3)
          const points = Math.min(15, 3 + Math.floor((directCount - 5) / 3) * 3);
          membershipScore += points;
          membershipReasons.push(`${directCount} direct reports — wide span of control [+${points}]`);
        }
      }

      // ── Layer 3: structural hygiene (users) ──
      // v4 lines 764-786
      let structuralScore = 0;
      const structuralReasons = [];
      const pext = p.extendedAttributes || {};
      const memSet = principalMemberships.get(String(p.id)) || new Set();
      const memCount = memSet.size;

      if (p.accountEnabled === false && memCount > 0) {
        structuralScore += 5;
        structuralReasons.push(`Account is disabled but still has ${memCount} group membership(s) [+5]`);
      }
      const userType = pext.userType || pext.UserType;
      if (userType === 'Guest') {
        structuralScore += 5;
        structuralReasons.push('External guest account — higher risk for data exfiltration [+5]');
      }
      // Stale sign-in. Primary source is PrincipalActivity (populated by
      // the Entra crawler from /users.signInActivity and
      // /reports/servicePrincipalSignInActivities). Falls back to the old
      // extendedAttributes.signInActivity path for tenants that haven't
      // re-crawled since the switch to the new table landed.
      const actRow = principalActivity.get(String(p.id));
      const lastSignIn =
        (actRow && (actRow.lastSignInDateTime || actRow.lastSuccessfulSignInDateTime)) ||
        pext.lastSignInDateTime ||
        (pext.signInActivity && pext.signInActivity.lastSignInDateTime);
      if (lastSignIn) {
        const days = Math.floor((Date.now() - new Date(lastSignIn).getTime()) / 86400000);
        if (days > 90) {
          structuralScore += 10;
          structuralReasons.push(`Last sign-in ${days} days ago — stale account with active permissions [+10]`);
        }
      }
      structuralScore = Math.min(CAP_STRUCTURAL, structuralScore);

      principalState.set(String(p.id), {
        row: p,
        isAgent,
        directScore,
        membershipScore,
        structuralScore,
        propagatedScore: 0,
        matches,
        directReasons,
        membershipReasons,
        structuralReasons,
        propagatedReasons: [],
        memCount,
        ownCount,
      });

      counter++;
      if (counter % 500 === 0) {
        await updateRun({ scoredEntities: resources.rows.length + counter, pct: 45 + Math.floor((counter / totalEntities) * 15) });
      }
    }

    // ── Pass 3: User membership analysis (needs resource direct scores) ──
    // v4 lines 650-710. Includes: broad access footprint, member-of-high-risk
    // group, org subtree size (hierarchy), and manager-of-high-risk-reports.
    await updateRun({ step: 'Scoring principals (membership)', pct: 62 });

    // Build subtree size map once if hierarchy is available. Walks the
    // directReports graph iteratively (BFS) to avoid PowerShell v4's recursion.
    const subtreeCount = new Map();
    if (hierarchyAvailable) {
      for (const [pid, state] of principalState) {
        if (!directReports.has(pid)) { subtreeCount.set(pid, 0); continue; }
        const seen = new Set();
        const queue = [...directReports.get(pid)];
        while (queue.length > 0) {
          const next = queue.shift();
          if (seen.has(next)) continue;
          seen.add(next);
          const reports = directReports.get(next);
          if (reports) for (const r of reports) queue.push(r);
        }
        subtreeCount.set(pid, seen.size);
      }
    }

    for (const [pid, state] of principalState) {
      const memSet = principalMemberships.get(pid) || new Set();
      const totalGroups = memSet.size + state.ownCount;

      // Broad access footprint: in >15 groups → +3 per 3 above, capped at 15
      if (totalGroups > 15) {
        const points = Math.min(15, Math.floor((totalGroups - 15) / 3) * 3);
        if (points > 0) {
          state.membershipScore += points;
          state.membershipReasons.push(`Member of ${totalGroups} groups (above threshold of 15) — broad access footprint [+${points}]`);
        }
      }

      // Member of any high-risk group (direct score ≥ 70): +15, once only
      let highRiskMembership = null;
      let highRiskGroupScore = 0;
      for (const rid of memSet) {
        const rs = resourceState.get(rid);
        if (rs && rs.directScore >= 70 && rs.directScore > highRiskGroupScore) {
          highRiskGroupScore = rs.directScore;
          highRiskMembership = rs;
        }
      }
      if (highRiskMembership) {
        state.membershipScore += 15;
        state.membershipReasons.push(
          `Member of high-risk group '${highRiskMembership.row.displayName}' ` +
          `(direct score ${highRiskMembership.directScore}) — elevated privilege exposure [+15]`
        );
      }

      // Hierarchy signals (only if managerId is populated in the tenant)
      if (hierarchyAvailable) {
        // Large org subtree: v4 ≥100→+15, ≥50→+12, ≥25→+10, ≥10→+5
        const subtree = subtreeCount.get(pid) || 0;
        if (subtree >= 10) {
          const subtreePoints = subtree >= 100 ? 15 : subtree >= 50 ? 12 : subtree >= 25 ? 10 : 5;
          state.membershipScore += subtreePoints;
          state.membershipReasons.push(`${subtree} total reports in org subtree — large blast radius [+${subtreePoints}]`);
        }

        // Manager of high-risk direct reports: +5 per high-risk report, cap 15
        const reports = directReports.get(pid) || new Set();
        let highRiskReports = 0;
        for (const reportPid of reports) {
          const rs = principalState.get(reportPid);
          if (rs && rs.directScore >= 70) highRiskReports++;
        }
        if (highRiskReports > 0) {
          const mgrPoints = Math.min(15, highRiskReports * 5);
          state.membershipScore += mgrPoints;
          state.membershipReasons.push(`Manager of ${highRiskReports} high-risk direct report(s) — inherited responsibility [+${mgrPoints}]`);
        }
      }

      state.membershipScore = Math.min(CAP_MEMBERSHIP, state.membershipScore);
    }

    // ── Pass 4: Cross-entity propagation (one pass) ──
    // v4 lines 814-872. Compute pre-propagation scores, then propagate max
    // group score to users (*0.30) and max user score to groups (*0.25).
    await updateRun({ step: 'Propagating risk across memberships', pct: 75 });

    const preProp = (s) => Math.round(
      W_DIRECT * s.directScore + W_MEMBERSHIP * s.membershipScore + W_STRUCTURAL * s.structuralScore
    );
    const resourcePre = new Map();
    for (const [rid, rs] of resourceState) resourcePre.set(rid, preProp(rs));
    const principalPre = new Map();
    for (const [pid, ps] of principalState) principalPre.set(pid, preProp(ps));

    // Group → User: user inherits 30% of their riskiest group's pre-prop score
    for (const [pid, state] of principalState) {
      const memSet = principalMemberships.get(pid) || new Set();
      let maxGroup = 0;
      let maxGroupName = null;
      for (const rid of memSet) {
        const pre = resourcePre.get(rid) || 0;
        if (pre > maxGroup) {
          maxGroup = pre;
          maxGroupName = resourceState.get(rid)?.row?.displayName;
        }
      }
      if (maxGroup > 0) {
        const prop = Math.round(maxGroup * PROP_GROUP_TO_USER);
        state.propagatedScore = prop;
        if (prop > 0) {
          state.propagatedReasons.push(
            `Inherits ${Math.round(PROP_GROUP_TO_USER * 100)}% of riskiest group ` +
            `'${maxGroupName}' (score ${maxGroup}) = ${prop} [+${prop}]`
          );
        }
      }
    }

    // User → Group: group inherits 25% of its riskiest member's pre-prop score
    for (const [rid, state] of resourceState) {
      const memberSet = resourceMembers.get(rid) || new Set();
      let maxUser = 0;
      let maxUserName = null;
      for (const pid of memberSet) {
        const pre = principalPre.get(pid) || 0;
        if (pre > maxUser) {
          maxUser = pre;
          maxUserName = principalState.get(pid)?.row?.displayName;
        }
      }
      if (maxUser > 0) {
        const prop = Math.round(maxUser * PROP_USER_TO_GROUP);
        state.propagatedScore = prop;
        if (prop > 0) {
          state.propagatedReasons.push(
            `Inherits ${Math.round(PROP_USER_TO_GROUP * 100)}% of riskiest member ` +
            `'${maxUserName}' (score ${maxUser}) = ${prop} [+${prop}]`
          );
        }
      }
    }

    // ── Pass 5: Final score assembly ──
    await updateRun({ step: 'Finalising scores', pct: 88 });

    const finalScore = (s) => Math.min(
      100,
      Math.round(
        W_DIRECT * s.directScore +
        W_MEMBERSHIP * s.membershipScore +
        W_STRUCTURAL * s.structuralScore +
        W_PROPAGATED * s.propagatedScore
      )
    );

    const makeRow = (entityType, id, s) => {
      const final = finalScore(s);
      return {
        entityId: id,
        entityType,
        riskScore: final,
        riskTier: tierFor(final),
        riskDirectScore: s.directScore,
        riskMembershipScore: s.membershipScore,
        riskStructuralScore: s.structuralScore,
        riskPropagatedScore: s.propagatedScore,
        riskClassifierMatches: s.matches,
        riskExplanation: {
          direct:     { score: s.directScore,     reasons: s.directReasons },
          membership: { score: s.membershipScore, reasons: s.membershipReasons },
          structural: { score: s.structuralScore, reasons: s.structuralReasons },
          propagated: { score: s.propagatedScore, reasons: s.propagatedReasons },
        },
      };
    };

    const allScores = [];
    for (const [rid, s] of resourceState)  allScores.push(makeRow('Resource',  rid, s));
    for (const [pid, s] of principalState) allScores.push(makeRow('Principal', pid, s));

    // ── Persist into RiskScores ──
    await updateRun({ step: 'Writing RiskScores', pct: 92, scoredEntities: totalEntities });

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

    // ── Clustering moved out (Phase 7 of context redesign) ──────────────
    // The legacy GraphResourceClusters tables have been dropped. Name-stem
    // clustering now lives in the "resource-cluster" context-algorithm
    // plugin — run it from the UI (Contexts → + New → Run plugin) to
    // produce the same groupings as a generated context tree.

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

// Resource clustering lives in the "resource-cluster" context-algorithm
// plugin (app/api/src/contexts/plugins/resource-cluster/). Its name-stem
// helper is exported from that module for reuse.

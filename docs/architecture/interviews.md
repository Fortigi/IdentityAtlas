# Identity Atlas Interviews — design

> **Status:** experimental backend slice on `feature/interviews` (October 2026), behind the
> feature flag `interviews` (default **off**). No iOS app exists yet. This page reconciles the
> product handover ("Identity Atlas Interviews — Claude Code Handover", 2026-10-10) with the
> application as it is, and records what was built, what was decided and what is still open.

**Product statement:** *turning conversations into governed knowledge.* A consultant interviews a
line manager. Names come up ("William beheert de productieomgeving, maar Peter is verantwoordelijk
voor de databases"). The app records locally, spots mentions, asks Atlas who they might be, and
afterwards turns what was said into **claims with evidence** that an analyst reviews. The
differentiator is the line between *"someone said this"* and *"Atlas knows this"* — this design
keeps them in different tables and never crosses the line automatically.

## 1. Reconciliation with the real application

| Handover assumption | What Identity Atlas actually has | Decision |
|---|---|---|
| "Existing identity flows" for native sign-in | Entra ID access tokens for `api://<clientId>/access`, validated by `middleware/auth.js` (aud, issuer, tenant, RS256). Read keys (`fgr_`) are GET-only BI tokens; `fgc_` keys are crawler-only. No other token type. | The iOS app signs in with **MSAL for iOS as a public client of the same app registration** (add an iOS redirect URI `msauth.<bundle-id>://auth`) and requests the same `access` scope. No new token type, no server change. `fgr_` keys are **refused** on every interview route, GETs included. |
| Multi-tenant, `tenantId` on every row | Single tenant per deployment: one Entra tenant (`tid` checked on every token). No data table has a tenant column. | No tenant column. Isolation is **per owner**: an interview belongs to the caller's Entra object id (`ownerKey = 'oid:<oid>'`); anyone else gets 404. Tenant switching = a different deployment URL in the app. |
| "Existing search endpoints" | No global search. The closest is the custom-report reference lookup (`nlreports/references.js`: pg_trgm `similarity` + `word_similarity`, not-deleted filters from `nlreports/catalog.js`). | **Reused**: the interview search imports the same thresholds and the same per-entity `where` filters, so "a name matches" means one thing in both. Added: scope ranking, distinguishing labels, a `truncated` flag. |
| Persons, teams, applications, assets | `Identities` (persons), `Principals` (accounts), `Resources` (groups, roles, apps…), `Contexts` (departments, teams, tags, applications) with `ContextMembers`. | A mention resolves to one of `identity`, `account`, `resource`, `context`. A "team" scope is a Context whose `targetType` is `Identity` or `Principal`, including its child contexts. |
| Ontology / RDF store / proposal workflow | Postgres only. The RDF/OWL note (2026-10-10) proposes an *export*, not a store. Org truth (`feature/org-truth-mvp`, unmerged) adds a claims layer with `proposed/accepted` status and provenance. | A separate, append-only **interview proposal store** (§4), shaped to map onto org-truth claims later (§7). No ontology writes. |
| Audit | No generic audit table; per-domain logs (`AuthRoleChangeLog`, `CrawlerAuditLog`, `BotConversations`). | Per-domain, like the others: `InterviewEvents`, append-only, no spoken content, survives deletion. |
| Feature flags, rate limits, OpenAPI | `featureFlags.js` (WorkerConfig override → env default, 404 when off); `express-rate-limit` keyed on the verified caller; `openapi.yaml` + drift test + Spectral. | All three followed as-is. Routes are **versioned** (`/api/v1/interviews/…`) — the first in the API — because a native client cannot be redeployed with the server. |
| Permissions | Fixed catalog (`auth/permissions.js`). | Reads: `data.read`. Writes: `data.write.contexts`, **reused for the MVP exactly as org truth does**. A dedicated `data.write.interviews` (plus manifest + docs) is the productisation step. |

## 2. Phase 0 — iOS feasibility spike

The spike answers one question per row with a device in hand. Nothing on this page claims a
capability that has not been run.

### Proven by Apple documentation vs. to be verified on device

Checked against Apple's developer documentation on 2026-10-10 (doc JSON for the pages named).

| Topic | Proven by Apple docs | To be verified on a target device |
|---|---|---|
| **SFSpeechRecognizer on-device** | `supportsOnDeviceRecognition` (iOS 13+): "whether the speech recognizer can operate without network access"; a request can only honour `requiresOnDeviceRecognition` when it is true, otherwise the recognizer "requires a network". The class docs state the framework "stops speech recognition tasks that last longer than one minute", that devices/apps may be throttled per day, and advise against recognising sensitive speech. | Whether `nl-NL` reports `supportsOnDeviceRecognition == true` on the pilot devices; whether the one-minute stop applies to on-device requests (plan: segment into < 60 s requests regardless); accuracy on Dutch names. **Treat SFSpeechRecognizer as a fallback only** — the one-minute limit and the network default make it a poor primary for a 45-minute interview. |
| **SpeechAnalyzer / SpeechTranscriber** | iOS/iPadOS **26.0+**. `SpeechTranscriber`: "appropriate for normal conversation". `isAvailable`: "available given the device's hardware and capabilities". `supportedLocales` includes "locales that may not be installed but are downloadable"; `installedLocales` only installed ones. Assets via `AssetInventory.assetInstallationRequest(supporting:)` → `downloadAndInstall()`. Results have a `volatileRange` (can still change) vs. finalised; `finalize(through:)`, `cancelAnalysis(before:)`. `DictationTranscriber` is the module "compatible with older devices". | **Not stated in the docs read:** that processing is on-device, or anything about long-form limits. Verify: `nl_NL` ∈ `supportedLocales` on the pilot device; asset download size/time; airplane-mode transcription after download; `isAvailable` on the oldest pilot device; behaviour over 45+ minutes (memory, thermal, battery); timestamp quality per segment. Code-switching Dutch/English: verify. |
| **Dutch support (speech)** | Nothing in the docs read lists Dutch for any speech module — lists are runtime properties. | Must be read from `supportedLocales` / `supportsOnDeviceRecognition` on the device. Do not describe Dutch on-device STT as delivered until then. |
| **Foundation Models** | `SystemLanguageModel`: "an on-device Apple Foundation Model", iOS 26.0+. `availability` is `.available` or `.unavailable(.deviceNotEligible / .appleIntelligenceNotEnabled / .modelNotReady)`; `supportedLanguages`; `contextSize`. Eligibility "depends on whether the device and region support Apple Intelligence". | Dutch: press reports (9to5Mac, 2025-11-11) say iOS 26.1 added Dutch to Apple Intelligence; developer forum reports say the framework is unavailable when the *device system language* is unsupported — verify on a Dutch-configured device. Pilot phones without Apple Intelligence (anything below iPhone 15 Pro) get the rules-based detector. **No design dependency on it**: it may only propose mention candidates (decision-principles B3), never resolve or approve. |
| **AVAudioEngine / interruptions** | `AVAudioSession.interruptionNotification`: on `began` the session "is no longer active"; on `ended` the options say whether to resume; since iOS 10 a suspended app's session is deactivated and the notification arrives late with `AVAudioSessionInterruptionWasSuspendedKey`. Posted on the main thread. | A phone call during recording: does capture stop cleanly and resume on `ended` + `shouldResume`? Background recording with the `audio` background mode while the screen locks; file protection class that still allows writing while locked; route changes (AirPods connect/disconnect); `mediaServicesWereReset`. Each is a scripted test in the spike. |
| **Neural Engine** | Not a general app API (Core ML may use it; no guarantee). | Irrelevant to the decision; measure end-to-end CPU/thermal/battery instead. |

### Spike plan (throwaway SwiftUI app, 1–2 weeks with devices)

1. **Recorder first.** `AVAudioEngine` tap → `AVAudioFile` (AAC/m4a) in the app container with
   file protection; segment files every 5 minutes so a crash loses at most one segment. Interruption,
   route-change and media-reset handlers. Pass criterion: 60-minute recording with two phone calls and
   a lock/unlock survives with no gap other than the call.
2. **Transcriber behind a protocol** (`TranscriptionService`): `SpeechTranscriber` (iOS 26+) →
   `DictationTranscriber` → `SFSpeechRecognizer` (segmented, on-device only) → "transcribe later".
   Feed it from a *copy* of the audio stream so a transcriber failure can never stop capture.
3. **Measure** per device × language (nl-NL, en-US, mixed): availability flags, WER on a scripted
   10-minute Dutch dialogue with 20 names, timestamp drift, CPU, thermal state, battery %/hour,
   airplane mode.
4. **Detector**: deterministic lexicon (team roster from `/v1/interviews/context` + capitalised
   tokens + an app vocabulary list); Foundation Models only as an optional extra proposer where
   `availability == .available`.
5. **Deliverable**: a go/no-go table per device class and the privacy data-flow diagram below,
   updated with what was measured.

## 3. Privacy data flow

```
 ┌──────────────────────── iPhone / iPad ────────────────────────┐
 │ audio (file-protected, never uploaded)                        │
 │   └─► on-device STT ─► transcript segments (local only)       │
 │                           └─► mention detector (rules / FM)   │
 │ evidence = segmentId + ms + char span + SHA-256(excerpt)      │
 └──────────┬───────────────────────────────┬────────────────────┘
            │ 1. mention words + kind +     │ 3. mentions, resolutions,
            │    team scope (GET search)    │    claims, evidence fingerprints,
            ▼                               ▼    proposals, review decisions
 ┌──────────────────── Identity Atlas API (/api/v1/interviews) ──┐
 │ 2. ≤5 candidates: name + label (no email/ids beyond the id)   │
 │ Interview* tables (append-only) ── InterviewEvents (audit)    │
 │ ✗ no writes to Resources / Assignments / Identities / Contexts │
 └────────────────────────────────────────────────────────────────┘
```

Never sent: audio, the transcript. Sent per lookup: the mentioned words. Stored per interview: the
mention literals ("Peter"), positions, the decisions, the claim text (subject/predicate/object),
excerpt **hashes**; excerpt **text** only with `storagePolicy: 'evidence-excerpt'` (and the server
refuses excerpt text on a `local-only` interview rather than silently dropping it). The query text of
a search is never logged.

## 4. What was built (backend slice)

### Endpoints (all `/api/v1/interviews`, feature `interviews`, owner-scoped where an id is involved)

| Route | Gate | Purpose |
|---|---|---|
| `GET /entities/search?q&kind&scopeContextId` | data.read, 120/min/caller | ≤5 ranked candidates + the search's own outcome (`suggested` / `unresolved` / `not_found`) |
| `GET /context?subjectIdentityId&scopeContextId` | data.read | subject + team members with Direct/Indirect/Eligible counts + the team's widest-held resources (capped 200/50, `truncated` + `total`) |
| `POST /` · `GET /` · `GET /:id` · `DELETE /:id` | write / read | create (notice must be confirmed), list mine, full record, delete with tombstone |
| `POST /:id/mentions` | write | batch ≤100 |
| `POST /:id/mentions/:mentionId/resolutions` | write | append a resolution (state machine) |
| `POST /:id/statements` · `POST /:id/statements/:sid/revisions` | write | claim + evidence; revision = next version, new evidence rows |
| `POST /:id/proposals` · `POST /:id/proposals/:pid/reviews` | write | propose one statement version; approve / reject / defer |

Documented in `app/api/src/openapi.yaml` (tag **Interviews**), with the three mock responses below as
examples.

### Data structures (migration `084_interviews.sql`)

`Interviews` · `InterviewMentions` · `InterviewResolutions` · `InterviewStatements` ·
`InterviewEvidence` · `InterviewProposals` · `InterviewReviewDecisions` · `InterviewEvents`.

- **Append-only:** every table but `Interviews` refuses `UPDATE` (trigger); `InterviewEvents` also
  refuses `DELETE`. Rows disappear only by deleting the interview (cascade).
- **No foreign keys to canonical tables:** `entityId`, `subjectIdentityId`, `scopeContextId` are
  references that survive a crawl deleting the row.
- **Three separate numbers:** `InterviewResolutions.matchScore` (match confidence),
  `InterviewStatements.claimConfidence` (was the claim made), and the human decision (`state` /
  `action`). None is derived from another.

### Rules enforced (and where they are tested)

| Rule | Code | Test |
|---|---|---|
| A homonym stays ambiguous; only "exactly one strong candidate in the team scope" may become a *suggestion* | `interviews/resolution.js` `classifyCandidates` | `resolution.test.js`, `routes/interviews.lookup.test.js` (fixtures) |
| Automation never confirms/rejects/defers | `checkTransition` + a DB `CHECK` | `resolution.test.js`, `routes/interviews.sessions.test.js`, `084_interviews.test.js` |
| A linked entity must exist | `store.entityExists` | sessions test |
| Review names the version read; approving a revised claim is refused; approve/reject are final | `interviews/review.js` | `review.test.js`, `routes/interviews.claims.test.js`, contract test |
| Approval never touches canonical data (`promoted: false`) | — | claims test (every SQL statement inspected), `canonicalWrites.guard.test.js` (static scan), contract test (row counts) |
| Evidence is never overwritten | append-only triggers; revisions insert | claims test, contract test (`UPDATE` raises) |
| Excerpt text only under `evidence-excerpt`, and only with a matching hash | `interviews/evidence.js` | `evidence.test.js` (fixed SHA-256 vector), claims test |
| Owner isolation, expiry, permission before feature, read keys refused | `interviews/http/gates.js` | lookup + sessions tests |
| Rate limit | `searchLimiter` (real default, 120) | lookup test (121st call → 429, other caller unaffected) |

### Mock Atlas API for the iOS prototype

`app/api/src/interviews/fixtures/`: `search-william.json` (one match → `suggested`),
`search-peter.json` (two matches → `unresolved`, reason `ambiguous`),
`search-productieomgeving.json` (`not_found`). The route test asserts the real handler produces
**exactly** these bodies from equivalent rows, so the mock cannot drift from the server.

## 5. Privacy decisions needed (owner: Wim / customer DPO)

1. **Lawful basis and notice text.** The server only records that a notice (`noticeVersion`) was
   confirmed. Who writes the notice, per customer, and whether each participant is recorded
   individually (the handover's `Participant` entity is not built) — decide before a pilot. DPIA:
   likely required (employee data, possible special categories).
2. **Server-side evidence.** Default `local-only` (hashes). Is `evidence-excerpt` acceptable at all,
   and who may choose it — the consultant per interview, or a tenant policy? Full transcript and
   audio are deliberately not offered.
3. **Mention literals are stored** even on `local-only` interviews (a name is the minimum needed to
   review a resolution). Acceptable?
4. **Retention.** Default 90 days, 1–3650 allowed; expired interviews are invisible immediately, but
   there is **no purge job yet** (rows stay until deleted). Also: keep the audit tombstone forever?
5. **Who may review.** Today only the interview's owner sees and reviews it. A four-eyes rule
   (reviewer ≠ interviewer) and admin access are not built — decide which governance requires.
6. **Team visibility.** The context read shows any `data.read` user a team's access counts — the
   same exposure as the matrix. Is a narrower boundary (e.g. only the interviewed manager's own
   team) required for interviews?

## 6. Not built (next slices)

- The iOS app (Phase 0 spike first), a dedicated `data.write.interviews` permission, a retention
  purge job, `Participant` rows, an admin card for the flag, and **promotion** of approved proposals
  into canonical data — which, when built, goes through org truth (§7), not through this store.

## 7. Mapping to org truth (`feature/org-truth-mvp`, not a dependency)

Org truth has `OrgSources` → `OrgEntities`/`OrgRelations` (claims: `origin`, `confidence`,
`status` proposed/accepted/rejected, `observedAt`) → `OrgLinks` (entity ↔ system object, with
`analystOverride`). An interview maps onto it one-to-one when both have merged:

| Interviews | Org truth |
|---|---|
| `Interviews` row | `OrgSources` with kind `transcript`, `observedAt = createdAt`, **no bytes** (the source stays on the device; evidence hashes stand in) |
| `InterviewStatements` (subject, predicate, object) | `OrgRelations` with `origin = 'model'` (extractor) or `'analyst'`, `confidence = claimConfidence`, locator = evidence ids |
| a `{ literal }` side, or a `not_found` mention | an `OrgEntities` row (free-form `entityType`) with `status = 'proposed'` |
| `InterviewResolutions` `confirmed` | `OrgLinks` with `analystOverride` set (an analyst decision every re-run respects) |
| `suggested` resolution | `OrgLinks` `proposed` |
| `InterviewReviewDecisions` `approve` / `reject` | the relation's `status` → `accepted` / `rejected` |

Two rules carry over unchanged: model output is never authoritative, and analyst overrides win.
The version/lineage of a statement has no org-truth equivalent yet; it would map to a closed
relation (`validTo`) plus a new one. **Migration numbering:** this branch uses `084`, which collides
with org truth's `084–088`; whichever merges second renumbers.

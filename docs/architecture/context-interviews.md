# Context interviews — what people say, as claims

**Status:** built (first slice), on organisational units and logical applications.

An analyst talks to people about a customer, a team or an application. What they say
is often the only source for facts no crawler has: what the unit does, since when it is
a customer, who really does the work. *Upload interview* on a context's page takes the
transcript of such a conversation, with who was interviewed and when, and turns what it
says into **claims** — each a statement with the verbatim words it rests on — for an
analyst to review. Nothing is written to the context until someone confirms it.

Example: *"Yes, I'm the owner of this app, but it's mostly Piet who does the
day-to-day"* suggests the interviewee as the application's Accountable (its Owner) and
Piet as Responsible, in the People block next to the existing best guess.

## The one decision: a claim is not a fact

The interview is a **source**; a claim is what that source **said** about a subject.
The two live in their own tables (`ContextInterviews`, `ContextClaims`), apart from the
graph, and nothing crosses into the graph without a person's decision. In the ontology
(2.2.0) they are the knowledge layer: `ia:Interview` (a subclass of `ia:Source`) and
`ia:Claim`, both under `ia:Knowledge` — not nodes, not edges, and never a way of holding
access (the holding rule is untouched).

| A confirmed claim of kind | Changes |
|---|---|
| `description` | appended to the context's description under *From interview with NAME, DATE:* (a second description from the same interview goes under the same heading) |
| `property` | `extendedAttributes[attribute] = value` |
| `role` with a `roleSuggestion` | the `ContextRole` — `addedBy = 'analyst'` (a person decided), `sourceClaimId` = the claim |
| `role` without one, `roleHistory` | nothing beyond the claim: confirmed knowledge, shown under *What we know* and on the role timeline |

**Accountable.** Set only when the context has none, or the same person already holds
it. Otherwise the API answers 409 with the current holder and the page asks *"X is the
Accountable now. Replace them with Y?"*; confirming again with `replace: true` replaces
them. A Responsible is added next to the others.

**Provenance on roles.** A role confirmed from an interview keeps `addedBy = 'analyst'`
— so the plugin runner and the synced-owner reconcile leave it alone, exactly as every
analyst role — and records its claim in the new nullable `ContextRoles.sourceClaimId`.
The roles API returns the interviewee, the date and the quote with it, and the People
block says *"from the interview with …"*. No new `addedBy` value was added: who decided
is the analyst; *where it came from* is the claim.

## Data (migration 097)

`ContextInterviews` — `contextId` (cascade), the interviewee as `principalId` or
`identityId` (at most one; set NULL when that row goes) and `intervieweeName` (kept),
`interviewedAt` (date), `fileName`, `transcript` (plain text, at most 5,000,000
characters), `language`, `extractionStatus` (`pending`, `running`, `done`, `failed`,
`notConfigured`), `extractionMessage`, `extractionStartedAt`, `model`, `createdBy`,
`createdAt`.

`ContextClaims` — `interviewId` (cascade), `contextId`, `claimKind` (`description`,
`property`, `role`, `roleHistory`), `subjectKind` (`Context` | `Person`), the person as
`principalId` | `identityId` | neither, plus `subjectName` as spoken and `subjectMatch`
(`interviewee`, `key`, `name`, `fuzzy`, `firstName`), `attribute` (a property's key, or a
role claim's relation: `owner`, `notOwner`, `dayToDay`, `delegate`, `member`, `other`),
`value`, `periodFrom` / `periodTo` (dates) and `periodText` (as said), `quote`,
`confidence` (0–1, not a decision), `roleSuggestion`, `claimStatus` (`proposed`,
`confirmed`, `edited`, `rejected`), `proposedBy` (`model` | `analyst`), `decidedBy`,
`decidedAt`. Every change is recorded in `_history`.

(`claimStatus` and `proposedBy` are not called `status` and `origin` because the
ontology names a column property after its column, and `ia:status` / `ia:origin` already
mean something else. The API still says `status`.)

## Reading a transcript

`.txt` (UTF-8, or UTF-16 with a BOM), `.docx` (the paragraphs of `word/document.xml`),
`.vtt` and `.srt` (cue ids, timings and notes dropped; a speaker's consecutive cues
joined into one turn, *"Name: words"*). At most 25 MB per file.

## Extraction — with the local model

When the report generator's model server is configured (`NL_REPORTS_LLM_URL`, the one
the list upload's refinement uses), the upload starts extraction in the background:

1. The transcript is read in parts of 10,000 characters, at most 40 (a longer one says
   how much was read — never silently less). Each part is asked for claims with a
   template-aware prompt (a unit: what it is, sector, customer since, who leads it, role
   history; an application: purpose, users, data, vendor, owner, day-to-day people) and
   a strict JSON schema, within 180 seconds; an unreadable reply gets one repair round.
2. Every claim is checked: closed kinds, a value, a person for a role claim, an
   attribute for a property — and **the quote must be a verbatim part of the
   transcript** (compared after folding whitespace and typographic quotes, nothing more),
   or the claim is dropped. The run's message counts what was dropped and why.
3. Repeats are dropped, and so is anything already decided in an earlier run.
4. Names are matched: the interviewee (*"I"*, their name, their first name); then the
   upload's account matching (`upload/members.js`: e-mail, employee id, external id, the
   normalised name, a near miss — `fuzzy`); then a first name alone that is the first
   name of exactly one person the context already knows (a member or a role holder —
   `firstName`). `fuzzy` and `firstName` are flagged *check the person*. An unmatched
   name keeps its raw text.
5. Fixed rules (`contexts/interviews/roles.js`, no model) set the role suggestions:
   `owner` → Accountable, `dayToDay` / `delegate` → Responsible, `notOwner` → none. A
   subject who says both that they own it and that they do not gets no Accountable
   suggestion. *"I'm not the owner, Y is"* is two claims: notOwner for the interviewee,
   owner for Y — and when the interviewee is the current Accountable, the People block
   shows *In doubt:* with the quote.
6. The interview's undecided model claims are replaced in one transaction; status
   `done`. Any failure: status `failed` with the reason, and *Read again*.

The model only proposes (decision principle B3): the confirmed claim is the record.

## Without a model — never a dead end

The transcript is stored with status `notConfigured`, and the interview list offers
*Add claim*: the transcript read-only beside a small form; select words and *Use the
selection as quote* (checked as verbatim by the API). The claim passes the same check as
a model's, its person is matched the same way, and a role claim's suggestion is deduced
from its relation unless the analyst picks one.

## API

All writes need `data.write.contexts`; OpenAPI documents each.

```
POST   /api/contexts/:id/interviews                       multipart file + principalId|identityId + interviewedAt
GET    /api/contexts/:id/interviews                       the interviews, with claim counts (writers)
GET    /api/contexts/:id/interviews/:interviewId          one, with its transcript (writers)
POST   /api/contexts/:id/interviews/:interviewId/extract  read again (409 while a run of < 15 min is going; 503 without a model)
POST   /api/contexts/:id/interviews/:interviewId/claims   an analyst's own claim
DELETE /api/contexts/:id/interviews/:interviewId          the interview and its claims
GET    /api/contexts/:id/claims?status=…                  the claims + accountableDoubt
PATCH  /api/contexts/claims/:claimId                      { status: confirmed|edited|rejected, value?, period?, principalId|identityId?, replace? }
GET    /api/contexts/claims/mentions?principalId=|identityId=   the contexts whose interviews mention a person
```

**Deleting an interview** removes its claims. What its confirmed claims already changed
— a description section, an attribute, a role — **stays**; a role only loses its link
(`sourceClaimId` → NULL).

## Who sees what

- **Analyst** (`data.write.contexts`): everything — the card, the review list, the
  interviews, the suggestions.
- **Business reader** (no `data.write.contexts`) and **context owner** (the read-only
  shared page; `…/claims` is on the owner allow-list): **confirmed claims only**, under
  *What we know* — the API narrows the list, the page does not filter it. No card, no
  review, no transcripts.

## On the page

- **What we know** (below the template's facts): Description, Properties, People &
  roles — each with its source, the quote on expand — and per person a **role timeline**
  (*"junior (early years) → left → architect CCoE (now)"*, with bars where the interviews
  gave dates). For an analyst also *To review* and *Interviews*.
- **People block**: interview suggestions under Accountable and Responsible, next to the
  best guess, with Confirm / Not this person / Choose someone else.
- **Account and person pages**: *Mentioned in interviews*, linking each context.

## Known limits

- A **synced** context's re-sync rewrites what its source sends: an upload replaces
  `extendedAttributes`, so a property confirmed from an interview is overwritten by the
  next re-import of that list. The confirmed claim stays under *What we know*.
- Extraction runs inside the API process; a restart during a run leaves it `running`,
  and *Read again* is allowed once it is 15 minutes old.
- A decided claim cannot be undecided; reverse its effect by hand (edit the description,
  remove the role).
- Not in this slice: audio, speaker diarisation, merging claims across interviews,
  contradictions between interviews, claims about resources.

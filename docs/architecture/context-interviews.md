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
| `alias` | added to `extendedAttributes.aliases` (an array; a spelling already there — case, accents, dots aside — is not added twice), shown as *Also known as* |
| `role` without one, `roleHistory`, `membership` | nothing beyond the claim: confirmed knowledge, shown under *What we know*, on the role timeline and in the members lists. A membership claim **never changes `ContextMembers`** — members come from their source |

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

## Data (migrations 099, 100, 101)

`ContextInterviews` — `contextId` (cascade), the interviewee as `principalId` or
`identityId` (at most one; set NULL when that row goes) and `intervieweeName` (kept),
`interviewedAt` (date), `fileName`, `transcript` (plain text, at most 5,000,000
characters), `language`, `extractionStatus` (`pending`, `running`, `done`, `failed`,
`notConfigured`), `extractionMessage`, `extractionStartedAt`, `model`, `createdBy`,
`createdAt`.

`ContextClaims` — `interviewId` (cascade), `contextId`, `claimKind` (`description`,
`property`, `role`, `roleHistory`, `membership`, `alias`), `subjectKind` (`Context` | `Person`), the person as
`principalId` | `identityId` | neither, plus `subjectName` as spoken and `subjectMatch`
(`interviewee`, `key`, `name`, `fuzzy`, `firstName`), `attribute` (a property's key, a
role claim's relation: `owner`, `notOwner`, `dayToDay`, `delegate`, `member`, `other` — or a
membership claim's status: `current`, `former`, `joined`, `left`, `rejoined` — a closed list in
code (`claims.js` `MEMBERSHIP_STATUSES`) and the ontology, not a CHECK, so `rejoined` needed no migration),
`value`, `periodFrom` / `periodTo` (dates) and `periodText` (as said), `quote`,
`confidence` (0–1, not a decision), `relevance` (`high` | `low`; NULL, from before 100, reads
as high), `quoteStart` / `quoteEnd` (the quote's span in the stored transcript, string offsets,
end exclusive), `roleSuggestion`, `claimStatus` (`proposed`,
`confirmed`, `edited`, `rejected`), `proposedBy` (`model` | `analyst`), `decidedBy`,
`decidedAt`. Every change is recorded in `_history`.

Migration 100 widened the kinds and added `relevance`, `quoteStart` and `quoteEnd`. It is a
separate migration rather than an edit of 099 because the demo database had already run 099
(and a changed migration fails the hash ratchet).

`ContextMemberOverrides` (101) — a member marked former by a decision, on top of
`ContextMembers`: `contextId` (cascade), `memberId`, `claimId` (cascade), `overrides` (the
source's name when decided), `decidedBy`, `decidedAt`; one per (context, member). See
*Marked former by a decision* under Contradictions.

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
   prompt that names what identity and access governance runs on — people and their
   roles and membership over time (who joined, who **left**, who worked on it before), who
   owns it or answers for it, other names it goes by, the systems used, facts that change
   who may have access (sector, contract, regulation, sensitive data) — and says to
   **skip** small talk and generic facts; then what differs per template (a unit: what it
   is, customer since, who leads it; an application: purpose, users, data, vendor, owner,
   day-to-day people). A strict JSON schema, with a relevance tier per claim; an unreadable reply gets one repair round. Each answer may take
   the report model's time budget — `INTERVIEW_LLM_TIMEOUT_MS`, else
   `NL_REPORTS_LLM_TIMEOUT_MS` (the nl-reports overlay sets 900000), else 15 minutes.
   Extraction runs in the background, and on a 2-CPU box with a 4B model one part takes
   minutes — longer when the model server's single slot is still busy with another
   request (a report, a prompt-cache warm-up): the request simply waits. The model's own
   HTTP client (`nlreports/llamacpp.js`, `ollama.js`) stops at `NL_REPORTS_LLM_TIMEOUT_MS`,
   so a larger interview budget does not outlast it.
2. Every claim is checked: closed kinds, a value, a person for a role claim, an
   attribute for a property — and **the quote must be a verbatim part of the
   transcript** (compared after folding whitespace and typographic quotes), or the claim
   is dropped. A *near*-verbatim quote — only case, punctuation or spacing differ — is
   kept, with the transcript's own words as its quote; different words never match.
   What a small model leaves out is filled where that needs no guess: a property
   without an attribute name becomes a description claim, a claim without a value takes
   its quote as the value, a roleHistory without a period is kept with the period empty.
   A role without its person, an unknown kind and a quote that is not there are still
   dropped. Every drop is logged with the field it failed on, and the run's message says
   it — *"2 incomplete claims were left out (1 without the person, 1 of an unknown
   kind). 1 claim had a field filled in from the quote — check it."* There is no second
   model round asking for the missing fields: on a small box it costs as much as the
   part itself.
3. A person claim whose subject joins two or more names (*"Ruud en Kees"*, *"Ruud and
   Kees"*, *"A, B & C"*) becomes one claim per name (`roles.js` `splitJointSubjects`; *en* /
   *and* are no name particles, so the quote's-full-name fallback never glues them either).
   **A claim that says someone left is read against its whole sentence**
   (`interviews/sentences.js`): a small model quotes a fragment and decides from it —
   *"Gerrit is sinds iets meer dan een jaar betrokken en doet data mining"* came back as
   `former`. The quote's span is widened to the sentence(s) it stands in (cut at `.` `!`
   `?` and line breaks; a turn is one line and its *Speaker:* label is not part of it).
   For a membership `former` / `left`, and a role / roleHistory whose words say left:
   - the sentence says gone (a *Who left* word, or past-only phrasing: *een periode*,
     *destijds*, *vroeger*, *used to*, *for a while*) → kept — *"Stijn en Noor hebben
     een periode meegewerkt, maar zijn inmiddels uitgestroomd"* stays `former` even when
     the model quoted only the first half;
   - else it says current (*sinds*, *is betrokken*, *doet*, *nu*, *currently*, *now*,
     *works*) → a membership becomes `current`, and its value says so: *"… (corrected:
     the sentence says current; the model said former)"* — the review shows it, and the
     analyst can edit or reject it; a role claim keeps its relation but loses the left
     reading (no `former` membership is derived from it; `leftSignal.js` reads the same
     mark);
   - neither → kept, its confidence lowered to at most 0.3; the review flags a claim
     below 0.4 *unsure — read the quote*.

   Before all three: **the sentence says the person came back** (`leftSignal.js`
   `saysReturned`: *rejoined, came back, back as, returned, joined again*; *weer terug,
   teruggekomen, kwam terug, is terug, terug als / bij, opnieuw, weer bij*, and *"is sinds …
   terug"*) → a membership becomes `rejoined`, a role claim loses its left reading; the
   value says so (*"corrected: the sentence says they came back"*). A bare *terug* or *weer*
   is not enough — *"een jaar terug"* is *"a year ago"*.

   The stored quote stays the transcript's own words; when the sentence is at most 300
   characters it becomes the whole sentence, so the highlight shows the reason.
   Repeats are dropped, and so is anything already kept on this interview, and an
   "alias" that is the context's own name or an alias it already has.
4. Names are matched: the interviewee (*"I"*, their name, their first name); then the
   upload's account matching (`upload/members.js`: e-mail, employee id, external id, the
   normalised name, a near miss — `fuzzy`); then a first name alone, `firstName`
   (`interviews/firstNames.js`), searched in widening circles — one statement per circle
   for all the names at once, and the first circle that decides wins:
   (a) the context's current members and role holders; (b) the people its interviews
   already name — the holders of its claims (any interview) and its interviewees, which is
   where a former member is found; (c) the members and role holders of the contexts next to
   it — its `SameUnitAs` variants, its parent and its siblings; (d) the whole organisation:
   a live user account, only when exactly **one** has that first name (20 or more candidate
   rows is no match — at a large organisation this rarely resolves, by design). Two people
   with the first name in a circle is no match, and the wider circles are not asked: they
   cannot make it unique. Two fallbacks for a name still unmatched, both `fuzzy`:
   - **the quote's full name** — a small model cuts names short (*"Vries"* for *"Piet de
     Vries does most of the day-to-day work"*). The quote is verbatim, so a longer run
     of 2–4 capitalised words in it (particles such as van / de / der / den / von / el
     between them) that contains the subject's words is tried, longest first; the first
     that resolves wins and the claim carries that name (`interviews/nameSpan.js`);
   - **a unique surname** — a surname alone (*"Vries"*, *"de Vries"*) that ends the name
     of exactly one live user account; two such accounts, or 200 or more candidate rows,
     is no match.

   `fuzzy` and `firstName` are flagged *check the person*. An unmatched name keeps its
   raw text.

   **Decided claims do not come back.** A claim equal to one already confirmed, edited
   or **rejected** on the context — in any of its interviews — is dropped: same kind,
   same person (the matched holder when both have one, else the normalised name) and
   the same value (case, punctuation and spacing aside). A re-extraction, or a second
   interview, no longer re-proposes *"chief architect"* for an interviewee whose role
   claim was confirmed last week, nor a rejected claim.

   **Another name the speaker uses** (`interviews/aliasHints.js`). The prompt names the
   context's display name and its known aliases and asks for an alias claim when the
   speaker uses another name. A small model often still leaves it out, so a rule
   proposes one — an `alias` claim with confidence 0.5, waiting for review like any other:
   a name after *het / de / the* (up to four capitalised words; *"Jan de Vries"* is a
   surname — an article after a capitalised word is skipped), or the name a description
   claim starts with (*"Het Havenkantoor is …"*), said **at least twice**, or in the quote
   of the first description claim. Never the context's own name or an alias it has
   (spacing ignored: *Harbour Office* is *HarbourOffice*), an alias the model gave, a
   pronoun, a word of a person's name (any person claim, the interviewee), a name a
   property claim gives (*"the Azure platform"*), or another context's display name or
   alias (`store.otherContextNames`, normalised as `lib/nameMatch.js` does). At most three
   per run; the quote is the sentence of the first occurrence.
5. **Relevance** (`contexts/interviews/relevance.js`, fixed rules first): role, roleHistory,
   membership and alias are always `high`; a property is `high` when its attribute or value
   names something access depends on (sector, contract, customer, regulation, systems,
   applications, data, vendor, hosting, …), else the model's tier, else `low`; a description
   takes the model's tier, else `high` only when it names such a term. Each claim also gets
   the span of its quote in the transcript (`quoteOffsets.js`).
6. Fixed rules (`contexts/interviews/roles.js`, no model) set the role suggestions:
   `owner` → Accountable, `dayToDay` / `delegate` → Responsible, `notOwner` → none. A
   subject who says both that they own it and that they do not gets no Accountable
   suggestion. *"I'm not the owner, Y is"* is two claims: notOwner for the interviewee,
   owner for Y — and when the interviewee is the current Accountable, the People block
   shows *In doubt:* with the quote. A role / roleHistory claim that says the person left
   (see *Who left* below — *"recently left"*, *"inmiddels uitgestroomd"*) adds a
   `membership` claim with status `former` for the same person, quote and period, unless
   the model already gave a membership claim for that person (one per person; a re-run
   does not propose one already decided).
7. The interview's undecided model claims are replaced in one transaction; status
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
GET    /api/contexts/:id/interviews/:interviewId          one, with its transcript and highlights [{ claimId, start, end }] (writers)
POST   /api/contexts/:id/interviews/:interviewId/extract  read again (409 while a run of < 30 min is going; 503 without a model)
POST   /api/contexts/:id/interviews/:interviewId/claims   an analyst's own claim
DELETE /api/contexts/:id/interviews/:interviewId          the interview and its claims
GET    /api/contexts/:id/claims?status=…                  the claims + accountableDoubt
POST   /api/contexts/:id/claims/reject                    { kind?, relevance? }: reject the proposed claims of a kind / tier, one statement
GET    /api/contexts/:id/previous-members                 who the interviews say left, with live entitlements (every reader)
GET    /api/contexts/:id/members                          (existing) each account / person also carries interview: { role, left }
PATCH  /api/contexts/claims/:claimId                      { status: confirmed|edited|rejected, value?, period?, principalId|identityId?, replace? }
GET    /api/contexts/claims/mentions?principalId=|identityId=   the contexts whose interviews mention a person
```

**Deleting an interview** removes its claims. What its confirmed claims already changed
— a description section, an attribute, a role — **stays**; a role only loses its link
(`sourceClaimId` → NULL).

## Membership over time — the members lists

A membership claim is knowledge about a person and the context; members still come from
their source. Two places show it, both set-based (`contexts/interviews/memberFacts.js`):

- **The members list.** `GET /contexts/:id/members` adds, on a unit or an application whose
  members are accounts or persons, `interview: { role, left }` to every row: one more
  statement for the whole page (the claims about the page's ids — for persons also those
  about their accounts, via `IdentityMembers`), never a query per row. `role` is the latest
  role there — a `role` claim (said in the present) or a roleHistory whose period is open or
  "now" first, then the latest period, then the newest interview — with the whole
  `history`; the table shows it in a **Role** column, the history on hover. `left` is the
  person's latest word on being in it (newest interview first) — a membership claim, or a
  role / roleHistory claim that says they left — when it says so (`former` / `left`; a
  role claim reads `former`); the row
  then carries *"Interview: left (last month)"*, the quote as tooltip, which opens the
  transcript at the claim for an analyst.
- **Who left** (`contexts/interviews/leftSignal.js`, one shared rule): a membership claim with
  status `former` or `left`, or a role / roleHistory claim (not `notOwner`) whose value or
  period says it — *left, no longer, former(ly), quit, departed, moved on*; *uitgestroomd,
  vertrokken, weg, niet meer, gestopt, voormalig(e), oud-…* — whole words only. So claims
  stored before the membership kind existed, or a model that answers *roleHistory "left"*,
  still count.
- **Who came back** (`memberFacts.js` `rejoinOf`): a person whose latest word does not say
  they left, and for whom a claim says they returned — a membership `rejoined`; the return
  words above in a role claim's value or period, or in the clause of its quote about them
  (*"Joris begon als junior en is sinds een half jaar terug, nu als architect"*: the model
  put the return in neither value nor period); or a present membership (current, joined,
  rejoined) said in a later interview than one that said they left. Their **earlier stint** is
  every role before the latest one. A promotion without a word for coming back is no second
  stint. The members list adds `interview.rejoined` (the claim that says it, with
  `earlier`): the row's Role cell carries *"rejoined · earlier: Junior developer"*, the
  quote and the earlier periods as tooltip.
- **Previous members**, below the members: everyone whose latest such claim says they
  left and who is not a direct member now (`stint: 'left'`) — and everyone who came back,
  for the EARLIER stint (`stint: 'earlier'`, `role` = the roles they had then,
  `nowMember`): *"Joris Jansen — Junior developer (earlier period)"*, with *now a member
  again* scrolling to their current row. A person is one row at most. Matched to an account or a person, they come with
  their **live entitlements** (ResourceAssignments not deleted — a person's own and their
  accounts') and how many of those are on **this context's resources**: its own resource
  members, or those of a `SameUnitAs` variant that holds resources (*"3 on this
  application"*, highlighted). A name nobody matched is listed as said, with *no account found* and no counts.
  Three statements in all: the claims, the counts for every matched person at once, and the
  size of the linked resource set. The question it answers: *does this person still have
  access?*

Proposed claims read **dashed and italic**, confirmed ones plain. The reader rule is the
claims list's: a reader gets confirmed claims only.

## Aliases

A confirmed alias claim adds to `extendedAttributes.aliases` (`lib/contextNameMatch.js`,
`mergeAliases`). On a unit or an application the profile's facts show **Also known as**
(`interviews/AlsoKnownAs.jsx`, `claims.helpers.js` `aliasFacts`): the stored aliases and the
confirmed alias claims plain, then — for an analyst — the proposed ones dashed, each with
Confirm / Reject inline. (More details no longer repeats the attribute there.) Before this, a
proposed alias was only in the review list, folded inside *What we know* among all the other
claims — which is why it looked missing. After any claim decision the page re-reads the
context quietly (`useContextDetail` `refreshDetail`: no loading state, open panels stay), so
a confirmed alias, property or description shows at once. Anything that places a
**name** onto a context should try aliases too: `buildContextNameMatcher` (same file) tries a
context's display name, then an alias (exact, normalised), then a near miss of the display
name — never a near miss of an alias, which is short. No caller in this branch matches
context names: the list upload matches contexts by key, the report-script lookup is
client-side. The activity upload (`feature/context-activity`) places rows by context name
and is meant to adopt this matcher.

## Contradictions

A claim that only adds knowledge keeps the ordinary review. A claim that **disagrees** with
something we hold — or with another claim — is shown as a pair and asks for a decision
(`contexts/interviews/contradictions.js`, fixed rules, set-based: the claims already read,
one statement for the context and its source system, one for which of the people named are
direct members). `GET …/claims` returns them as `contradictions`:

| Rule | The claim | Against |
|---|---|---|
| `leftButMember` | membership former / left, or a role claim that says left | the member list still lists them (*"Interview: Lotte left · HR export (upload) still lists Lotte"*) — not when they came back |
| `memberNotListed` | membership current / joined / rejoined | the member list does not list them |
| `accountable` | a role claim suggesting X as Accountable | Y is the Accountable (synced owner, a rule, an analyst) |
| `notOwner` | the Accountable says they are not the owner | they are the Accountable — this is the old *In doubt* (`accountableDoubt` stays in the response for the People block) |
| `property` | a property claim | the context's attribute holds another value (case, accents, spacing aside) |
| `claims` | two claims | one person current in one interview and gone in another; two values for one property; two people named as owner while there is no Accountable |

Aliases never contradict: a context may have any number of names, and a name that is another
context's is dropped at extraction. Each side carries its source: the claim its interviewee, date
and quote; a fact *"<system>, last synced <date>"* (`Systems.lastSyncDateTime`, else *"listed
since"* the member's `addedAt`; *"The member list"* for a context kept by hand).

**Deciding one is deciding its claim(s) — no table of its own.** The claim's status,
`decidedBy` and `decidedAt` are the record (and `_history` keeps the change):
*The interview is right* confirms it (a member who left is **marked former by the decision** —
see below; for another owner it confirms with `replace`); *The list is right* / *Keep …* rejects it; *Both true, at
different times* saves it with the period asked for (`edited`); of a pair, keeping one confirms
it and rejects the other, *both* confirms both. A decided contradiction says how
(`resolution`: interview, source, both, first, second, neither), leaves the panel, and the
Timeline shows *"Decided: <claim> · <the other> — the interview is right"* in place of the plain
decision (a pair once, on its last decision). A rule that no longer holds after the decision (an
Accountable replaced, an attribute set) stops matching; its decision reads as an ordinary one.

Two interviews that disagree about a person are a contradiction while either claim is proposed;
confirmed both (an earlier *left*, a later *current*), they are a return — `rejoinOf` counts them,
so *"Both true, at different times"* on that pair makes the person *rejoined*.

### Marked former by a decision (migration 101)

*"Interview: Led is a former member"* against *"Klanten (upload) still lists Led as a member"*,
decided *the interview is right*: Led is no longer a current member, but a former one. The
decision is an **override on top of `ContextMembers`**, never a change to it — the source would
add the row back on its next sync or re-import. `ContextMemberOverrides` holds one row per
(context, member): the claim it was decided on (`claimId`, cascade: deleting the interview
deletes the mark), the source it overrides by name (`overrides`), `decidedBy`, `decidedAt`;
`_history` records it. `contexts/interviews/memberOverrides.js` is the only writer:
`applyMemberOverride` (inside the decision's transaction) and `clearClaimOverride` (undo).

| Decision | Claim | Mark |
|---|---|---|
| The interview is right | confirmed (or edited without a period) | set — when the source lists the person, by the context's own kind (an account of a unit of accounts, a person of a unit of people) |
| The list is right | rejected | none: the member stays current |
| Both true, at different times | edited with the period | none: the member stays current; the period is the earlier stint in the claim (members list, role timeline) |
| a claim that they are in it (current, joined, rejoined) confirmed | confirmed | cleared |
| **Undo decision** (`POST /contexts/claims/:id/undo`) | back to proposed | removed; the contradiction is open again |

Undo is for a decision that changed nothing but the claim: any rejection, and a confirmed
membership, roleHistory or role without a suggestion (409 otherwise — a description, property,
alias or role is changed back where it was changed).

What reads the mark:

- **Members list** (`GET …/members`): a marked member is left out of the current members and of
  `total`; `overriddenCount` says how many were left out; `?includeOverridden=true` lists them
  too, each with `overridden: { by, at, overrides, claimId }`. The page says *"1 marked as former
  by a decision — show"* and shows them struck through with the decision. The facts block says
  *"12 in this unit (1 marked former)"* (`GET /contexts/:id` → `overriddenMemberCount`; the
  counts stay the source's).
- **Previous members** (`GET …/previous-members`): lists them with `decision` and `stillListed`,
  and the live entitlements they still hold — *"Decided by <who>, <date>: the interview is right —
  Klanten (upload) still lists them"*, the hint *"Still listed in the source — remove it there or
  re-import without them"*, and *Undo decision* for an analyst.
- **Timeline**: *"Decided: Led Ledeboer is a former member (overrides Klanten (upload))"*.
- **Unit report**: keeps the row and adds a **Status** column — *current* or *marked former
  (decision)* — so the report shows both what the source lists and what was decided.
- **Context owner (read-only view)**: the same members list (current members, the note, the
  toggle); Previous members stays an analyst read, as before.
- **Matrix and access**: unchanged, deliberately. The matrix shows access, and the access is
  still there — that is the point of Previous members' *still has access*. The decision never
  removes an assignment or a membership.

On the page: a **Contradictions (n)** panel at the top of *What we know*, never folded — each
item the two statements side by side (*View in transcript* on a claim, for an analyst) with the
choices; a *"n contradictions to decide"* badge under the page header and beside *To review*,
jumping to the panel. A reader sees the open ones without choices.

## The review list and What we know

- **What we know** is folded by default to one line — *"7 facts · 3 people · 2 proposed to
  review"* (facts: the confirmed claims; people: the distinct persons they name; the review
  count only for an analyst) — and opens on click. Open or folded is remembered per context
  for the browser session (`sessionStorage`, inside try/catch: a browser that refuses it
  starts folded).
- **To review** lists the `high` tier first; the `low` tier waits folded under *Less
  relevant (n)*. *Reject all less relevant* and *Reject all descriptions* each send one
  request.

## The transcript view

*View transcript* (in the What we know header, and per interview in the list) opens a side
panel: the transcript as a dialogue — a speaker column (*"Name:"* at the start of a line; a
.vtt / .srt transcript arrives as such lines) beside their words — with every claim's quote
highlighted. A colour per kind (role, role history, membership, alias, property,
description); the fill for the status: a light fill with a dashed underline while proposed,
a solid fill once confirmed, grey and struck through when rejected; a legend says which is
which. A highlight is a keyboard-focusable button with an aria label naming its claims; it
opens the claim card (kind, person, value, period, status, Confirm / Reject while
proposed). *In transcript* next to a claim in the review list — and the *left* flag in the
members list — opens the panel scrolled to the quote, which pulses. Escape closes it.

The spans come from the API: stored at extraction (and for an analyst's claim), found from
the verbatim quote when the transcript is opened for a claim from before 100. A quote may
run over a line break into the next turn (highlighted in both, never in the speaker column)
and quotes may overlap (the piece lists every claim, takes the shorter quote's style and an
outline). The view cuts each turn only at highlight boundaries, in one pass over the turns,
and renders 2,000 turns at a time (*Show more*), always as far as the focused quote — a
transcript at the 5,000,000-character cap is not rendered in one go.

## On the Timeline

The context's Timeline (`GET /contexts/:id/timeline`, `routes/recentChanges/timeline.js`)
merges the context row's own `_history` with what its interviews did
(`contexts/interviews/timelineEvents.js`, two statements in `store.js`, `eventKind:
'interview'`, a violet dot): *"Interview with X uploaded (file)"*, *"n claims extracted from
the interview with X"*, each decision — *"Confirmed: Membership — Jan Smit (former member)"*,
*"Rejected: …"* — and a confirmed claim that changed something reads as that change: *"Piet
set as Responsible — from the interview with X, date"* (linked to the holder), *"Also known
as: Havenkantoor added — …"*, *"sector set to logistics — …"*, *"Description extended — …"*.
Decisions are read from `decidedAt` and the role a claim set from `ContextRoles.sourceClaimId`.
A reader gets confirmed decisions only — no uploads, no extraction counts, nothing rejected.

The context's `_history` part now leaves out updates that only moved bookkeeping
(`lastCalculatedAt`, `updatedAt`, the member counts) **in SQL, before the LIMIT**: the
plugin runner re-stamps `lastCalculatedAt` every few minutes, which had filled the whole page
of 50 rows; the page hid those, and the Timeline came up empty.

## Who sees what

- **Analyst** (`data.write.contexts`): everything — the card, the review list, the
  interviews, the suggestions.
- **Business reader** (no `data.write.contexts`) and **context owner** (the read-only
  shared page; `…/claims` is on the owner allow-list): **confirmed claims only**, under
  *What we know* — the API narrows the list, the page does not filter it. No card, no
  review, no transcripts. In the members lists the role, the *left* flag and Previous
  members are read from confirmed claims only, and are plain text. `…/previous-members` is
  not on the context owner's allow-list, so the owner's shared page shows no Previous
  members (it would name people outside the owner's members, with their entitlements).
- **The transcript stays analyst-only.** Showing it to a reader would show the words behind
  proposed and rejected claims too, and deciding which parts a reader may read is not cheap;
  the view is offered only with `data.write.contexts` (the transcript GET already required
  it).

## On the page

- **What we know** (below the template's facts, folded to one line): Description,
  Properties, Also known as, People & roles — each with its source, the quote on expand —
  and per person a **role timeline**
  (*"junior (early years) → left → architect CCoE (now)"*, with bars where the interviews
  gave dates). For an analyst also *To review* and *Interviews*.
- **People block**: interview suggestions under Accountable and Responsible, next to the
  best guess, with Confirm / Not this person / Choose someone else.
- **Account and person pages**: *Mentioned in interviews*, linking each context.

## Known limits

- A **synced** context's re-sync rewrites what its source sends: an upload replaces
  `extendedAttributes`, so a property or an alias confirmed from an interview is
  overwritten by the next re-import of that list. The confirmed claim stays under *What we
  know*.
- A person in a membership claim is matched once, at extraction; an account of that person
  created later is not linked to the old claim.
- Extraction runs inside the API process; a restart during a run leaves it `running`,
  and *Read again* is allowed once it is 30 minutes old. The status says *Waiting for
  the model…* before a run starts and *Reading…* while it goes; from two minutes on it
  says how long, and that the model may be busy with another request — the API cannot
  tell waiting from reading, so it does not pretend to.
- A decided claim cannot be undecided; reverse its effect by hand (edit the description,
  remove the role).
- Not in this slice: audio, speaker diarisation, merging claims across interviews,
  contradictions between interviews, claims about resources.

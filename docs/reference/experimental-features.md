# Experimental features

Some capabilities ship before they have been through much real-world use. Identity
Atlas marks those **experimental** and keeps them behind a switch, so an upgrade
never quietly changes what a production install offers.

An experimental feature is **not** a prototype, a stub, or a half-built screen. It is
finished and covered by the same automated tests as everything else. What it is
missing is mileage:

> **Experimental = built and tested, but it has had only limited opportunity to prove
> itself against real-world systems.**

Most connectors are written against a specification and a mock. Real endpoints are
where the surprises live — a vendor that paginates differently, an attribute that is
optional in the spec but always absent in practice, a quirk that only shows up at
50 000 accounts. Until a feature has met a few of those, it carries the label.

---

## Turning them on

**Admin → Experimental** lists every experimental feature in the running build, with
a switch for each one and the exact contents of each group.

You need the **Feature flags** permission (`admin.feature-flags`) to change a switch.

Every switch is **off by default**, including after an upgrade, and your choice is
stored in the database, so it survives container restarts and redeployments.

!!! tip "Setting it from the environment instead"
    Each flag also reads an environment variable, useful for a test deployment that
    should start with it on: `FEATURE_EXPERIMENTAL_CRAWLERS=true`. A switch flipped
    in the Admin UI overrides the environment variable from then on.

---

## Experimental crawlers

It controls whether crawler types marked
experimental are offered in **Admin → Crawlers → Add Crawler**.

This build ships **no experimental crawlers**, so the switch currently has no
effect. The [SCIM 2.0](../sync/scim.md) crawler started out here and has since
graduated to a regular crawler: it is always offered in Add Crawler.

New connectors may arrive this way in future. They all sit under this one switch
rather than getting a switch each.

### What the switch does, precisely

**On** — experimental crawler types appear in the Add Crawler picker, each marked
with an `Experimental` badge. You configure, schedule and run them like any other
crawler.

**Off** — they are not offered in the picker, and the API refuses to create a new
configuration for one.

### What the switch does *not* do

Turning it off **does not disable an experimental crawler you already configured.**
It keeps its schedule, keeps syncing, keeps its data, and can still be edited,
run on demand, and deleted. The badge stays on its card so you can see what it is.

The switch governs *adding a new one* — nothing else. That is deliberate: an
operator who turns the flag off after connecting a system should not silently lose
that system's data.

---

## Matrix sharing

Lets analysts share a configured matrix with named colleagues who have no Identity
Atlas role — a manager, an application owner. See
[Share a matrix with someone in your organisation](../ui/sharing-a-matrix.md) for the
feature itself. It is experimental because it is the first thing in Identity Atlas
that shows data to people outside the analyst team.

Environment variable: `FEATURE_MATRIX_SHARING=true`.

### What the switch does, precisely

**On** — users with the **Create matrix share links** (`data.share`) permission get
the wizard's **Share** step, the share control on the matrix's Load / Save / Share
bar and the **Admin → Shared Matrices** tab, and share links open for their
recipients. The rest of that bar — loading and saving a matrix — is not
experimental and is always available.

**Off** — all of the share affordances are hidden, and the API answers `404` on every
share endpoint: creating, listing, adjusting recipients and revoking shares, **and
opening a link**. A recipient who opens
a link that was sent while sharing was on sees the same "This link doesn’t open a
shared view" page as for an unknown link — never an error.

### What the switch does *not* do

Turning it off **does not delete anything.** Existing shares, their recipients and
their usage history stay in the database; switching the flag back on makes every
link that was not revoked open again. To end a single share for good, revoke it
under **Admin → Shared Matrices** while the feature is on.

The permission still decides *who* may share: the flag decides whether sharing
exists on this install at all.

---

## Custom reports

Lets analysts build, save and run their own reports on the **Reports** tab — by hand,
or by describing them in plain language to a small model running inside the
deployment. See [Custom Reports](../ui/custom-reports.md) for the feature and
[Report Generator](report-generator.md) for the model, its measurements and its
hosting. It is experimental because the reports themselves are new, and because the
plain-language half needs an extra container that a deployment has to choose to run.

Environment variable: `FEATURE_CUSTOM_REPORTS=true`.

### What the switch does, precisely

**On** — users with the **Build custom reports** (`data.write.reports`) permission get
**New report**, **Edit** and **Delete** on the Reports tab and the report builder tab.
Saved reports are listed for everyone who can read data, and run, refresh and download
like a built-in report. The **Describe it** box appears only when the report-generator
container is actually answering; without it the definition editor is the whole feature.

**Off** — the builder is hidden, saved reports are not listed and cannot be run, and the
API answers `404` on every `/api/nl-reports/*` endpoint. The permission is checked
first, so a caller without it always gets `403` — whether or not this install has the
feature.

### What the switch does *not* do

Turning it off **does not delete anything.** Saved reports stay in the database and
reappear, unchanged, when the flag goes back on. It also does not stop or remove the
model container: that is a deployment choice (a compose profile, or an Azure
parameter), and an operator who wants the CPU and memory back stops it there.

---

## Context assistant

Lets analysts build a context tree by describing what it is about: the local model
proposes search terms, the analyst keeps the ones that find the right groups, and the
saved terms are re-applied after every crawl. See
[Building a context by describing it](../ui/context-assistant.md) for the feature,
[Context Assistant Internals](../architecture/context-assistant.md) for how it works, and
[Report Generator](report-generator.md) for the model it shares with custom reports. It is
experimental because it is new, because the plain-language half needs the extra model
container, and because how well a small model proposes terms depends on how groups are
named in a given deployment.

Environment variable: `FEATURE_CONTEXT_ASSISTANT=true`.

### What the switch does, precisely

**On** — users with the **Build contexts** (`data.write.contexts`) permission get a fourth
option, **Describe it**, in **Contexts → New context tree**, the context builder tab, and
**Edit search terms** on a context built with it. The describe box appears only when the
report-generator container is actually answering; without it the analyst types the terms
and the rest of the builder works unchanged.

**Off** — the fourth option and the builder are hidden, and the API answers `404` on every
`/api/context-assistant/*` endpoint. The permission is checked first, so a caller without
it always gets `403` — whether or not this install has the feature.

### What the switch does *not* do

Turning it off **does not delete or freeze any context.** A tree built with the assistant is
an ordinary generated context: it stays visible, stays filterable, and keeps refreshing
after every crawl from the terms it was saved with — that refresh is the `context-recipe`
plugin and needs no model. What stops is building and editing.

It also does not stop or remove the model container: that is a deployment choice (a compose
profile, or an Azure parameter), and it is shared with custom reports.

---

## MCP server

Lets people connect an AI assistant — Claude, ChatGPT or Copilot — to Identity Atlas and
ask it questions. The assistant signs in as that person through Entra ID and reads only
what their role allows. See [MCP server](mcp-server.md) for the tools, the setup and the
Entra app registration it needs. It is experimental because it is new, because the
assistants' own sign-in support for Entra ID is still moving, and because what it reads
leaves the deployment for the assistant's vendor.

Environment variable: `FEATURE_MCP_SERVER=true`.

### What the switch does, precisely

**On** — `POST /mcp` and its discovery document
(`/.well-known/oauth-protected-resource/mcp`) answer, for users whose role has **Use the
MCP server** (`mcp.use`). The card shows the URL and scope to configure an assistant with,
and the latest calls from the audit log.

**Off** — both answer `404`. The switch refuses to turn on while sign-in is off: with no
signed-in user there is no one for the assistant to act for.

### What the switch does *not* do

Turning it off does not revoke tokens the assistants already hold — they simply stop
working, because the endpoint is gone. It does not delete the audit log either.

---

## Organisation knowledge

What people say about an organisational unit or a logical application — who belongs, who
left, who answers for it — read from an interview transcript or another source into
**claims**, each with the quote it rests on, that an analyst confirms or rejects; and the
**contradictions** between those claims and what the source systems say. See
[Context interviews](../architecture/context-interviews.md). It is experimental because it is
new, because the reading is done by a model, and because what a decision changes (a member
marked former, a role set from a claim) is a new kind of fact on a unit.

Environment variable: `FEATURE_ORG_KNOWLEDGE=true`.

### What the switch does, precisely

**On** — a unit's or an application's page shows **Upload interview** and **What we know**
(claims to review, contradictions, previous members), the People block shows roles the
interviews suggest, the members list marks who the interviews say left, a person's page
shows **Mentioned in interviews**, and the context timeline carries the interview events.
When a model is configured (`NL_REPORTS_LLM_URL`), **the text of what is uploaded is sent
to it**.

**Off** — all of that is hidden, and the API answers `404` on `/api/contexts/{id}/interviews…`,
`/api/contexts/{id}/claims…`, `/api/contexts/{id}/previous-members` and
`/api/contexts/claims/…`. Member lists show plain membership: a member a decision marked
former is listed like any other, and no claim facts are attached.

### What the switch does *not* do

Turning it off **deletes nothing**: the sources, the claims and every decision are kept, and
turning it back on restores them. A role an analyst confirmed from a claim stays the role it
became — it is an ordinary Accountable or Responsible.

---

## Risk scoring

Scores every account, group, business role, context and person from 0 to 100, against
classifiers that an AI provider drafts from a profile of your organisation. See
[How Scoring Works](../risk-scoring/overview.md) for the feature and
[LLM & Risk Scoring Internals](../architecture/llm-and-risk-scoring.md) for how it works.

Risk scoring is kept, but **frozen as experimental** until it is folded into the Org Info
building blocks. Unlike the other features on this page it is **not certified per
release**: a release is not held back for it, and its behaviour may change when it is
merged. Switch it on only if you accept that.

Environment variable: `FEATURE_RISK_SCORING=true`. An install that had risk scoring
switched on before it moved to this tab keeps it on — the stored choice is the same.

### What the switch does, precisely

**On** — the **Risk Scores** tab can be shown in the main navigation, detail pages get a
**Risk** tab, the Dashboard shows a Risk Scoring card and the Logs page lists scoring runs.
**Admin → Risk Scoring** (profile, classifiers, **Run now**) and **Admin → Risk Scoring
LLM** (the AI provider and its key) appear, and a scoring run starts after every crawl.

**Off** — all of that is hidden, and nothing is scored: the run after a crawl does not
start. The API answers `404` on every risk endpoint — `/api/risk-scores…`,
`/api/risk-profiles…`, `/api/risk-classifiers…`, `/api/risk-scoring/runs…`,
`/api/admin/risk-profile`, `/api/admin/classifiers` and `/api/admin/llm/…` — so the AI
provider is never called. User and resource details carry no risk fields, and the
Dashboard statistics carry no risk counts. A link to `#admin?sub=risk-scoring` or
`#admin?sub=llm` lands on this tab.

### What the switch does *not* do

Turning it off **deletes nothing**: scores, overrides, profiles, classifiers, run history
and the AI provider settings stay in the database, and turning it back on restores them.

The provider on **Risk Scoring LLM** is used by risk scoring only. Custom reports, the
context assistant and organisation knowledge use the model that runs inside the deployment
(see [Report Generator](report-generator.md)); its status is shown on this tab under
**Custom reports** while that switch is on.

---

## Composition review

Somebody reviews a business role in a wizard — who answers for it, its lifecycle, the
permissions it contains — gives each step a verdict and signs; each review is kept with who
signed it, when, and a snapshot of the role at that moment, so a later reader sees what was
reviewed, what was found and what changed since. See
[Reviewing what a business role contains](../concepts/governance-model.md#reviewing-what-a-business-role-contains).
It is experimental because it is new.

Environment variable: `FEATURE_COMPOSITION_REVIEW=true`.

### What the switch does, precisely

**On** — a business role's **Requests & reviews** tab starts with a **Composition review** section, and a top-level **Reviews** tab appears for whoever holds the Review campaigns permission (see [Review campaigns](../concepts/governance-model.md#review-campaigns)). Saving a review takes the
Certification decisions permission, or answering for the role where the relative-permission
grid ticks **Composition review** for that role (Accountable or Responsible).

**Off** — the tab is hidden and `GET` / `POST /api/access-package/{id}/composition-reviews`
and `GET …/composition-reviews/people` answer `404`, as do `/api/review-campaigns` and `/api/review-requests/mine`. Campaigns already set up are kept and ask nobody while it is off.

### What the switch does *not* do

Turning it off **deletes nothing**: every review and its snapshot is kept, and turning it back
on shows them again.

---

## Accountables from source owners (a setting, not experimental)

Shown on the same tab, under **Contexts — what a sync sets on its own**, because it is
switched the same way. When a source names the owner of a synced unit or application
(`ownerUserId`: an account key, an employee number or an e-mail address), that account becomes the context's
**Accountable** on every sync and follows the source when the owner changes. An Accountable
an analyst chose, or one a crawler states directly, is never overwritten.

Environment variable: `FEATURE_SOURCE_OWNER_ACCOUNTABLES=false` turns it off by default.
It is **on** unless switched off.

**Off** — a sync sets, replaces and removes no Accountable at all; the ones already there
stay as they are.

**…also match owners by name** (`FEATURE_SOURCE_OWNER_NAME_MATCH=true`, **off** by default):
an owner the source names only by display name is matched to the one account with that
name (accents, case and "Last, First" ignored). A name is a guess, so it is opt-in. While it
is off, an Accountable an earlier sync set by name is removed at the next sync of that
context. An uploaded list (Contexts → New context → Upload a list) matches its own owners by
name either way, and shows each match in its preview before anything is written.

---

## Leaving experimental behind

The label is temporary by design. Once a feature has run against enough real
environments, one of two things happens:

- **It graduates.** The experimental flag is removed and it becomes an ordinary
  feature, always available. Existing configurations are untouched — the crawler
  simply stops being badged and stops needing the switch.
- **It is withdrawn.** If real-world use shows the approach does not hold up, the
  feature is removed rather than carried indefinitely. Anything being withdrawn is
  announced in the changelog first.

Either way, feedback from running one in anger is what moves it. If you are using an
experimental feature, [tell us how it went](../contributing/report-an-issue.md) —
that is exactly the mileage it is waiting for.

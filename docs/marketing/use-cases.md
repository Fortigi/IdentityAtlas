# Use Cases

Concrete scenarios to anchor stories, demos, and slides. Each is a "before → with
Identity Atlas → outcome" arc you can dramatize.

## 1. The cross-system access review

**Before:** An auditor asks "who can approve payments in SAP *and* has admin in
Entra ID?" The answer takes a week of exports and VLOOKUPs.

**With Identity Atlas:** Both systems are synced into one model. The question is a
filter on the matrix.

**Outcome:** Reviews go from spreadsheet archaeology to a query — and the answer is
defensible, with history behind it.

## 2. Finding the access nobody reviewed

**Before:** Over-privileged and stale access accumulates silently. Nobody knows
which identities were never part of a certification.

**With Identity Atlas:** Risk scoring flags over-privileged and unreviewed
identities; IST-vs-SOLL surfaces access that exists but was never governed.

**Outcome:** You walk into the audit with the risky 2% already identified instead
of being surprised by it.

## 3. Onboarding a non-Microsoft system in an afternoon

**Before:** Every new source system means a new bespoke integration project.

**With Identity Atlas:** Export to the canonical CSV schema (or build a small
crawler against the Ingest API), import, done — it lands in the same model as
everything else.

**Outcome:** SAP, SailPoint, Omada, or a homegrown app joins the picture without a
months-long integration.

## 4. "What could this person access last quarter?"

**Before:** Point-in-time access is unknowable once memberships change.

**With Identity Atlas:** Row-level audit history reconstructs exactly what an
identity could access on any past date.

**Outcome:** Incident response and forensic reviews get a real timeline, not a
guess.

## 5. Putting a risk score on identity sprawl

**Before:** Leadership asks "how risky is our identity estate?" and the honest
answer is a shrug.

**With Identity Atlas:** A four-layer engine scores every identity, tuned to your
industry, with analyst overrides and reasoning — and no sensitive data leaves your
environment.

**Outcome:** A defensible, explainable risk picture you can show a board, and a
prioritized list to actually work down.

## 6. Catching the non-human identities

**Before:** Service principals, managed identities, and AI agents pile up
unmanaged and unmonitored.

**With Identity Atlas:** Non-human identities are detected and classified
automatically, scored alongside everything else.

**Outcome:** The fastest-growing, least-watched part of the estate finally shows up
on the map.

---

*Demo tip:* the fastest "wow" is **Load Demo Data → open the matrix → filter
IST/SOLL → open a high-risk identity's detail page**. No tenant required.

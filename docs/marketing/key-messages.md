# Key Messages

Reusable, on-message statements. Pull these verbatim into slides, posts, and copy.
They're ordered by how often you'll reach for them.

## The core value props

1. **See who can actually do what — across every system.** Identity Atlas unifies
   authorization data from Entra ID, SAP, SharePoint, Azure, DevOps, and any
   CSV-exporting system into one model, so "what can this person access?" finally
   has an answer.

2. **One data model, full history.** Every permission — direct, inherited,
   eligible, governed — lands in the same PostgreSQL schema, with row-level audit
   history capturing every change over time.

3. **Risk scoring that respects your data.** LLM-assisted identity risk scoring
   tailors itself to your industry and organization using *public* context only —
   no identity data ever leaves your environment.

4. **Built for analysts, not just databases.** A visual role-mining matrix with
   IST-vs-SOLL comparison (actual vs. governed access), entity detail pages, and
   version-history diffs — review access the way humans actually think about it.

5. **Governance from any IGA platform, unified.** Business roles, certifications,
   and assignment policies from Omada, SailPoint, or Entra access packages share
   the same tables as raw permissions — one place, one model.

6. **Open source and local-first.** MIT-licensed, self-hosted, deployable in
   minutes via Docker or one click into your own Azure subscription.

## "What you can do with it" (the demo list)

Concrete, second-person capabilities — great for slide bullets and feature copy:

- **Answer "what can this person do?"** in seconds, spanning every connected system.
- **Spot over-privileged identities** and access nobody has reviewed.
- **Compare actual access to governed access** (IST vs. SOLL) to find drift.
- **Score every identity's risk** with reasoning, and override scores with an
  audit trail when an analyst knows better.
- **Onboard any system** — connect Entra ID with a wizard, or import a CSV for
  everything else.
- **Trace how access was granted** — direct, via a group, via a business role,
  eligible-but-not-active (PIM).
- **Detect non-human identities** — service principals, managed identities, agents.
- **Export to Excel** for the stakeholders who still live in spreadsheets.
- **Replay history** — see exactly what an identity could access on any past date.

## Tone notes

- Speak to outcomes ("see," "spot," "answer"), not internals ("matview,"
  "trigger-based `_history` table").
- "Universal" and "any system" are the recurring drumbeat — that's the wedge.
- Keep the privacy claim crisp and accurate: *public org context to the LLM, never
  identity data.*

*Sources: [features](features.md), [docs home](../index.md), [README](https://github.com/Fortigi/IdentityAtlas).*

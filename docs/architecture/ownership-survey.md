# Ownership survey (spec, not built)

**Status:** specification only. The context page's Actions area shows disabled cards marked *Coming
soon*: *Start ownership survey* on logical applications, *Start manager survey* and *Review team
members* on organisational units. Nothing behind them exists yet. All three are analyst actions and are
left out of a context owner's read-only page.

## Why

Who answers for a context — its Accountable and its Responsibles (`ContextRoles`, see
[Template UI](template-ui.md)) — comes from a source sync, a rule, a suggestion an analyst confirmed,
or an analyst's guess. None of those is the person themselves saying "yes, this is mine". A review
that goes to the wrong owner is a review nobody does, so before an access review runs, the people it
goes to should have confirmed they are the right ones.

## Flow

1. **An analyst starts the survey** on a context (the *Start ownership survey* action). The context
   must have an Accountable; with none, the analyst first confirms the suggested one or picks someone.
2. **An e-mail goes to the Accountable** with a link to that context's standalone page — the reading
   view without app navigation (the *Open as page* business view, the page a context owner reaches
   through context-owner access).
3. **The owner answers the first question**: *Is this yours?*
   - **Yes** — they are confirmed as Accountable.
   - **No, it is X's** — they name the right person (a people picker over the directory); the survey
     moves on to X with a fresh e-mail, and X is asked the same question.
   - **No, and I don't know whose** — see open questions.
4. **Once the owner is right, they check the people around them**: confirm or correct the
   Responsibles and name delegates who may act for them.
5. **Every answer is recorded as a role change with provenance**: who answered, when, and that it came
   through the survey (`addedBy` gains a value such as `survey`, next to `sync` / `algorithm` /
   `analyst`). Later these become claims in the knowledge graph, so a confirmed owner outranks a synced
   or suggested one rather than being overwritten by the next sync.

The analyst sees per context: not started, waiting on whom since when, confirmed, redirected, stuck.

## On an organisational unit: the manager survey

The same flow, in a team's words. The Accountable of a unit is its manager, so the e-mail asks *Do you
lead this team?*; *No* names who does. Once the manager is right, they name **delegates** who may
manage the team with them (a deputy, a team lead) — the unit's Responsibles. Answers are recorded the
same way, with the same provenance.

## Reviewing a team's members

*Review team members* asks the unit's Accountable or a Responsible whether its members are right:

1. The e-mail links to the unit's reading view, listing its members.
2. The person marks members who should not be there, and names people who are missing.
3. The answers are **proposals**, recorded with who made them and when — not member changes. Most units
   are imported or derived, so removing a member there would not last (the reason *Edit members* is only
   offered on units created in Identity Atlas). An analyst sees the proposals and takes them to the
   source: the HR system, the rule, or — for a unit created here — the member list itself.

Best run after the manager survey, so the review goes to the right person.

## Open questions

- **Mail transport.** There is no outbound mail today. SMTP (or Graph `sendMail`) configuration, a
  sender address, and templates per language.
- **Link authentication.** The link only works when context-owner access is on: the recipient signs in
  and is allowed to see *that* context's page. A bearer-token link without sign-in is not acceptable for
  access data.
- **Reminders and expiry.** How often to remind, when a survey expires, and what the analyst is told.
- **"Not me", with no successor named.** Does the context fall back to the suggestion (minus the person
  who declined, recorded as a rejection), go back to the analyst, or escalate to the decliner's manager?
- **Delegates.** Whether a delegate is a third role next to Accountable and Responsible, or a
  Responsible with a flag.

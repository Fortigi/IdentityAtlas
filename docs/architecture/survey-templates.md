# Survey templates — asking the same questions the same way

**Status:** built (first slices), on organisational units and logical applications.

[Context interviews](context-interviews.md) turn a conversation into claims. A survey
does the same with structure: an analyst decides **which questions** are asked about a
kind of context, **in which words and languages**, and **what each answer means**. The
analyst sends the survey to a person from a context's page; that person — or the analyst
on their behalf, during the meeting — answers it, and the answers become claims to review
next to every interview's.

Examples, as the built-in templates ship them:

| Template | About | Asks |
|---|---|---|
| Customer check | an organisational unit (a customer) | active? are you the owner — if not, who? who does the day-to-day? per member: does this person work on it? what do we do for them? |
| Application intake | a logical application | owner / who else / responsible; criticality A–D; NIS2 relevant; what it is used for |
| Application entitlement review | a logical application | per entitlement: is the owner right? is the certification frequency right? |
| Unit roster | an organisational unit | per member: works for you? role? responsible for? |

They carry neutral names. A customer's own wording is a template in that customer's
environment, never in the repository.

## The one decision: an answer is a claim

A submitted survey is a **source**, exactly like an interview: one `ContextInterviews`
row whose transcript is the survey as answered — one line per answer — and one
`ContextClaims` row per answer that means something, quoting its own line. So:

- answers go through the same review (*What we know*): **everything is reviewed**, a
  respondent's statement about themselves included;
- a survey answer and a transcript that disagree are two claims from two sources about
  one subject — the existing contradiction rules show them side by side;
- confirming a claim does what it does for an interview (description, attribute, alias,
  ContextRole); nothing is written before that.

There is no separate answer store to keep in sync. `SurveyRequests.answers` holds what
was filled in, for the form; the knowledge is in the claims.

## A definition

A template's questions are a JSON definition (`contexts/surveys/definition.js` checks
it; `POST /api/surveys/templates/validate` returns every problem with its path):

```json
{
  "schemaVersion": 1,
  "languages": ["en", "nl"],
  "title": { "en": "Application intake: {context}", "nl": "Intake applicatie: {context}" },
  "sections": [{
    "id": "ownership",
    "questions": [
      { "id": "isOwner", "text": { "en": "Are you the owner of {context}?" }, "required": true,
        "answer": { "type": "yesNo" },
        "becomes": { "kind": "role", "about": "respondent", "relation": { "yes": "owner", "no": "notOwner" } } },
      { "id": "realOwner", "text": "Who is the owner, then?", "showWhen": { "question": "isOwner", "equals": "no" },
        "answer": { "type": "person" }, "becomes": { "kind": "role", "about": "answer", "relation": "owner" } },
      { "id": "worksHere", "text": "Works for you?", "rows": { "source": "members", "columns": ["displayName", "jobTitle"] },
        "answer": { "type": "yesNo" }, "becomes": { "kind": "membership", "about": "row", "status": { "yes": "current", "no": "former" } } }
    ]
  }]
}
```

- **Texts** are a string, or one per language; the first language is required, others fall
  back to it. `{context}`, `{respondent}` and `{row}` are filled in.
- **Answer types:** `yesNo`, `choice`, `multiChoice`, `text`, `date`, `person`, `people`,
  `confirm` (shows a current value — a row column or a context attribute — and is answered
  *yes, correct* or *no, it should be …*).
- **showWhen** opens a question when an earlier yes/no or choice question has a value.
- **rows** asks the question once per `members` (the unit's people or accounts — its
  variant of that kind when the unit itself holds resources), `resources` (with their
  owner — who holds the ownership resource, else the source's `owner` attribute — and
  certification frequency) or `children`.
- **becomes** is the meaning: `description`, `property` (`attribute`), `alias` — about the
  context; `role` (`relation`) and `membership` (`status`) — about the `respondent`, the
  person(s) `answer`ed, or the member `row`; a `property` may also be about a resource
  `row`. A relation or status is one value or a map from answers to values; an unmapped
  answer claims nothing. Without `becomes`, an answer is only in the transcript.

Role suggestions follow the interview rules (`roles.js`): `owner` → Accountable,
`dayToDay`/`delegate` → Responsible; "not me" (`notOwner`) suggests nothing and puts the
current Accountable in doubt.

## Versions

A template's questions are versioned (`SurveyTemplateVersions`): a request is answered
against exactly the version it was sent with. Saving changed questions adds a version;
renaming or archiving does not. Archived templates leave the picker; requests already sent
keep working. The built-in templates are added once at startup, by key, and are the
analyst's to change from then on.

A template applies to one category (`OrganizationalUnit` | `LogicalApplication`) and
optionally only under one context (`scopeRootContextId` — "the customers").

## Sending and answering

*Send survey* (an analyst's action card) picks a template that applies, and either a
person or the unit's Accountable; on a tree node it can go to **every unit below** of the
same category, each to its own Accountable (units without one are listed as skipped). An
optional due date and message go with it.

The recipient sees it under **My surveys** once signed in (matched as for context
ownership: their account, their person, or another account of their person). A person
with no Identity Atlas role is let in for this — the survey routes and the app shell
only — when *Context-owner access* is on (`middleware/contextOwnerMode.js`,
`auth/contextOwnerScope.js`). Only people who can sign in can receive a survey; the
crawler must have brought in their account.

The form saves a draft as it goes. Submitting checks completeness (every required question
that is shown; for a per-row question, every row) and writes the interview, its claims
(`proposedBy = 'respondent'`, `surveyQuestionId`, confidence 1) and the request's status
in one transaction. An analyst answering on someone's behalf is recorded (`onBehalf`).

A claim about a resource (`subjectKind = 'Resource'`, `resourceId`) is **knowledge only**:
confirming it never changes the crawled resource; the source system is where that fix
belongs.

## Data (migration 102)

`SurveyTemplates` (key, name, description, contextCategory, scopeRootContextId,
currentVersion, builtIn, archivedAt), `SurveyTemplateVersions` (templateId, version,
definition), `SurveyRequests` (template + version, context, recipient as principalId |
identityId + recipientName, language, message, dueAt, status `sent` | `submitted` |
`cancelled`, answers, sentBy/At, openedAt, submittedAt/By, onBehalf, interviewId).
`ContextInterviews.surveyRequestId`, `ContextClaims.surveyQuestionId`,
`ContextClaims.resourceId`; `proposedBy` gains `respondent`, `subjectKind` gains
`Resource`. Status and due-date changes of a request are in `_history`.

## API

| | |
|---|---|
| `GET/POST /api/surveys/templates`, `GET/PUT /api/surveys/templates/:id`, `POST …/validate` | templates (data.write.contexts) |
| `POST/GET /api/contexts/:id/surveys`, `DELETE /api/surveys/requests/:id` | send, list, withdraw (data.write.contexts) |
| `GET /api/surveys/mine`, `GET /api/surveys/requests/:id`, `PUT …/answers`, `POST …/submit` | the recipient, or an analyst on their behalf |

# Knowledge extraction from interviews (experimental)

An interview with a manager or a colleague holds what no directory has: who is in which
informal team, who is responsible for what, which customers people work for. This feature
reads an interview **transcript** with the deployment's **own local model** and turns it into
*proposed* knowledge in [Org Info](org-truth.md): people, teams, customers and applications that
are mentioned, statements about them with the exact quote that supports each one, the existing
objects each mention may be, and the questions a reviewer should ask next.

Nothing it produces is a fact until an analyst accepts it, and nothing it does changes access.

## Design decisions

| Decision | Why |
|---|---|
| **No second claim store.** A transcript is an `OrgSources` row (kind `transcript`); a mention is an `OrgEntities` row (`origin 'model'`, `status 'proposed'`, type `Mentioned person` …); a statement is an `OrgRelations` row; a possible match is an `OrgLinks` row (`via 'mention'`). | Org Info already has claims with origin, status, provenance and `_history`. The interview API of #1368 maps onto the same tables. |
| **Four additions only** (migration 089): `OrgSources.metadata`, `OrgSourcePassages`, `OrgClaimEvidence`, `OrgKnowledgeFindings`; an extraction run is an `OrgImportRuns` row with mode `extract`. | What a list import never needed: passages with offsets, verbatim evidence, review questions, a resumable run. |
| **The local model only, never a fallback.** Extraction uses the report generator (`NL_REPORTS_LLM_URL`); without one it refuses to start. | Interview content is personal data. Tests point it at a deterministic stand-in with `ORG_KNOWLEDGE_LLM_URL`. |
| **Many small questions instead of one big one.** Per passage: topic → mentions → statements → a verifier per statement; once per transcript: findings. | A 4B model is more reliable on a narrow task with a JSON schema than on "extract everything". Measured against a single-prompt baseline (below). |
| **Deterministic checks first.** A quote must be in the passage (found exactly, or after folding case/spacing/punctuation — the stored quote is always the *source's* text); subject and object must occur in it; "A, B en C" is split into three statements. | A model that paraphrases or invents a quote cannot get a statement stored. |
| **The verifier only flags; it never rejects.** Its verdict is stored per quote (`support`) and is one input to the statement's confidence; every statement stays `proposed`. | Measured on a real interview (11 Oct 2026): the 4B verifier called about half of the *correct* statements unsupported. A second opinion from the same small model is a hint for the reviewer, not a filter; invented statements are stopped by the deterministic checks. |
| **Matching is the Org Info linking engine** with rules for spoken names: a full name scores above a first name alone; two candidates of one type at the same top score are *ambiguous*; nothing is ever accepted automatically. | "Rob" must not silently become one particular Rob. |
| **Match and statement are reviewed separately.** Confirming who "Rob" is does not accept what was said about him, and the other way round. Confirming a mention never applies to other mentions with the same text. | The next interview's "Rob" may be another Rob. |
| **Findings are questions, never verdicts.** "The interview says Maria is in SG-Finance; she is not a member" is a review question. | An interview is a claim, not authority over the directory. |
| **Idempotent.** The same bytes are the same source; a re-run updates mentions, statements, evidence, links and findings by key and never changes a status an analyst set. A run caches every model answer, so a cancelled, failed or interrupted run resumes. | Re-importing must not duplicate facts; a restart must not cost an hour of model time. |
| **Confidence is a score, not a decision.** 0–100 from the quote check (verifier), the modality (hedged, a question), how sure the match of each side is (reviewer-confirmed, one clear candidate, ambiguous) and the existing data (`confidence.js`). Statements are grouped high (≥ 80) / medium (≥ 50) / low; a reviewer accepts or rejects a whole group in one click. Nothing is accepted automatically. | Scanning a group and approving it is fast; an auto-approve would turn a small model's guess into a fact unseen. |
| **Corroboration by the data we already have** (`corroboration.js`). When both sides point at a real object, a statement is checked against it: a person in a group (assignments), in a context (members), linked to an entry of an imported list or with hours on a customer, or a role named like a list ("maat" ↔ "Maten"). Confirmed raises the score by 30; a membership the directory lacks is *contradicted* and caps it at 25. Rescored after every run and every match decision. | "Can we find this statement confirmed in our data?" is the strongest signal a small model cannot give. |
| **A reviewer can rename a mention.** The new name and type replace the transcript's spelling everywhere (it is one mention per source), the transcript's spelling is kept as `originalLabel`, matching runs again, and a re-run keeps the reviewer's name. | Transcription misspells names ("FortiG" for "Fortigi"); the model copies the transcript literally on purpose, so the fix belongs to the reviewer. |
| **Transcript text is untrusted data.** It sits between `<<<SOURCE` markers; the system prompt says it is never an instruction. | Prompt injection in a transcript ("ignore all instructions…") must produce nothing. |

## The pipeline

```
upload/paste ─► stage 0  canonical text, SHA-256 of the bytes, passages with offsets (+ SRT/VTT times, speaker)
               ─► per passage (shared prompt prefix, one model slot):
                    1 topic        governance / membership / customers / applications / practices / other
                    2 mentions     literal only — a mention not in the passage is dropped
                    3 statements   subject · predicate · object (+ qualifier, modality, quote)
                    4 verify       a) deterministic quote + grounding check   b) model: supported / unsupported / unclear
               ─► 6 findings      model: contradictions, misheard names, follow-up questions (cited passages)
               ─► 5 resolve       linking engine → candidate OrgLinks (proposed)
               ─► rules           unknown / ambiguous names, self-corrections, uncertain statements,
                                  memberOf vs the directory (membership and member count)
               ─► write           one transaction
```

Predicates: `memberOf`, `formerMemberOf`, `partOf`, `leads`, `responsibleFor`,
`worksForCustomer`, `usesApplication`, `hasProperty`, `other`. Modalities: `stated`, `implied`,
`uncertain`, `correction`, `question`. Code: `app/api/src/orgtruth/knowledge/`.

## API

All under `/api/org-truth/knowledge`, behind `orgTruth` **and** `knowledgeExtraction`; reading
needs `data.read`, everything else `data.write.contexts`. A transcript classified `restricted`
is visible only to its uploader and administrators.

| Route | |
|---|---|
| `GET /status` | model configured / reachable, active run |
| `POST /sources` | multipart `file` (.txt .md .srt .vtt) or `text`; `displayName`, `observedAt`, `speaker`, `language`, `sourceType`, `classification`, `note` → 201, or 200 `duplicate` |
| `GET /sources`, `GET /sources/:id` | list; one with canonical text, passages, runs |
| `POST /sources/:id/extract` | `{ mode: 'pipeline' \| 'single' }` → 202 run (409 without a model or while another runs) |
| `GET /runs/:id`, `GET /runs/:id/diagnostics`, `POST /runs/:id/cancel` | progress; the whole stage cache; stop after the current call |
| `GET /sources/:id/mentions` · `/claims` · `/findings` · `/export` | review data; the full JSON package |
| `GET /search?type=&q=` | find an object by hand |
| `PUT /matches/:linkId` | `confirm` · `reject` · `choose` · `reset` |
| `PUT /mentions/:id/choose` | link a mention that has no candidate |
| `PUT /mentions/:id` | `{ label?, type? }` — rename / retype a mention (original spelling kept) |
| `PUT /sources/:id/claims/bulk` | `{ status, ids }` — accept or reject many at once; only `proposed` ones change |
| `POST /sources/:id/rescore` | recompute confidence and corroboration |
| `GET /sources/:id/original` | the uploaded file as it was |
| `PUT /claims/:id` | `{ status, expectedStatus, predicate?, qualifier? }` (409 when someone else decided first) |
| `PUT /findings/:id` | `open` · `dismissed` · `resolved` |
| `GET /statements?targetType=&targetId=` | accepted statements about an object (the detail-page panel) |

## Testing and evaluation

- **Unit tests** per module, with a scripted model (`knowledge/*.test.js`).
- **Contract test on real PostgreSQL**: `contract-tests/knowledgeExtraction.integration.test.js` —
  the whole flow through the real app with the deterministic fake model
  (`tools/knowledge-extraction/fake-model.mjs`) and a synthetic interview made of demo-dataset
  names (`tools/knowledge-extraction/fixtures/demo-interview.nl.txt`): two people called Bakker,
  an unknown customer, a self-correction, a prompt injection.
- **Integration test on the demo dataset**: `pr-integration.yml` → `tools/knowledge-extraction/ci-demo-check.mjs`
  runs the same flow against the full demo data in the CI stack.
- **Quality** is measured separately, against a real model, with `tools/knowledge-extraction/dry-run.mjs`
  (pipeline without a database) and `eval.mjs` (precision, recall, trap hits, exact evidence,
  resolution top-k against a human-written gold file). Gold files are written before tuning and
  never used to tune. Interviews with real names stay out of this repository.

## Known limits

- One extraction at a time per deployment (the model server has one slot); on a 2-vCPU host a
  five-minute interview takes tens of minutes.
- The model reads Dutch imperfectly; recall depends on how plainly things are said. The
  verifier is a second opinion from the same model, not proof.
- Cross-interview clustering ("Rob is in the Omada team" said by two people) is not built: each
  transcript keeps its own statements; the keys are compatible with it.

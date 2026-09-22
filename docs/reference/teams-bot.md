# Teams bot (POC)

!!! warning "Proof of concept, not a release"
    This is a demo to play with. It is switched off by default, it has **no per-caller
    scope filter** (anyone in the pilot group can ask about the whole directory — see
    [What it deliberately does not do](#what-it-deliberately-does-not-do)), and answers take
    tens of seconds. Do not hand it to a pilot group without reading that section.

A Microsoft Teams bot that answers questions about access in a chat. It is a **second front
end on [Custom Reports](../ui/custom-reports.md)** — the same local model, the same report
definition, the same validated read-only SQL. It adds no query logic of its own, which is
why there is no new SQL path to review.

No Microsoft Copilot licence is involved anywhere.

```
manager in Teams ─► Bot Framework ─► /api/messages ─► who is asking? (Entra oid → Principals.id)
                                                   └► custom-reports pipeline ─► local model
                                                                              └► read-only SQL
                                                   ◄── Adaptive Card ◄── rows
```

## What it can answer

The question shapes the report generator handles best — list questions per person, per group
and per resource. These are the three examples the bot offers on install:

- *Which groups is Jan de Vries a member of?*
- *Who are the members of the Finance group?*
- *Which of my direct reports have access to the Finance SharePoint site?*

The third one is the interesting one: **"my" resolves to whoever is asking**, without them
naming themselves. Dutch works too — ask in Dutch and the bot's own replies come back in
Dutch (the line stating what it understood stays English; see [Language](#language)).

Comparisons ("groups with the same members as …") are the generator's weakest kind of
question — 3 of 6 correct — so the bot does not advertise them. Build those in the report
builder instead, where a comparison is exact once built.

### "My" means direct reports

There is no "delegate" concept in the Identity Atlas data model. "My delegates", "my people"
and "my team" all resolve to the caller's **direct reports** (the `managerId` the Entra
crawler stores), and the interpretation line on the card says so, so the substitution is
visible rather than assumed. "My resources" resolves to what the caller owns.

If a question says "my" but the generated report is **not** limited to the caller, the card
says so out loud. That is the one place a manager can catch a directory-wide answer dressed
up as their own team.

### Following one answer up with another question

> *"Van welke groepen ben ik owner?"* … *"en zijn die onderdeel van een access package?"*

The second question is not answerable on its own — "die" refers to groups that exist only in
the answer above it. The bot carries the **records of the last answer** in a chat forward, so
a follow-up can narrow to them.

How it works, because the mechanism decides what it can and cannot do:

- The ids of what the caller was just shown are remembered per chat, replaced by the next
  answer, and forgotten after 30 minutes.
- The model is **offered** those records and told the token `@previous` to write if the
  question refers back to them. It is not told to assume a follow-up — an unrelated question
  silently narrowed to the last answer's 27 groups is the expensive failure here, not a
  missed follow-up, because the caller would have no way to see it happened.
- When a follow-up *is* picked up, the card says so: *"Dit antwoord gaat over de 27 records
  uit je vorige vraag."* Same principle as the interpretation line — both readings produce a
  tidy card, and only one of them answers the question that was asked.

Two consequences worth knowing:

- A follow-up can only **narrow** to records the caller has already been shown, so it cannot
  widen what they can see. That matters while there is no per-caller scope filter.
- An answer with more than 200 records carries **nothing** forward. A set that large is one
  the caller has not read, so "these groups" would not mean anything definite to them either.

This is not conversation memory: exactly one answer is remembered, and only its records.

## Setting it up

Five things, in this order. Steps 1–3 are in Azure, step 4 is in Identity Atlas, step 5 is
in the Teams admin center.

### 1. Register the bot in Entra ID

The bot needs **its own app registration**. It cannot reuse the one Identity Atlas already
uses for sign-in: a bot authenticates with a client secret or certificate, and the existing
registration is configured as a single-page application.

1. **Entra ID → App registrations → New registration**. Name it e.g. `Identity Atlas Teams Bot`.
   Single tenant.
2. **Certificates & secrets → New client secret**. Copy the value now; it is shown once.
3. **API permissions → Add a permission → APIs my organization uses** → search for the
   Identity Atlas API registration **by its client ID** → **Delegated permissions** → its
   `access` scope. **Grant admin consent.**
    - Use that tab, not **My APIs**: `My APIs` lists only registrations you are an *owner*
      of, so it is usually empty here and the API looks missing when it is not. Either use
      this tab, or add yourself as an owner of the API registration.
4. **Expose an API → Application ID URI → Edit.** Replace the default with:

    ```
    api://botid-<bot-client-id>
    ```

    !!! danger "The `botid-` prefix is not optional"
        This is a **standalone bot**, and Microsoft's format for one is
        `api://botid-{app-id}` — *not* the `api://<domain>/{app-id}` form used for tabs.
        Get it wrong and everything still looks correct: the bot runs, the card is sent and
        accepted, Test Connection succeeds — and Teams silently answers every sign-in with
        `signin/failure` / `resourcematchfailed`, which is visible only in the bot's log.
        An app that also ships a tab uses `api://<domain>/botid-{app-id}` instead. See
        [Microsoft's bot SSO registration guide](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-register-aad).

5. **Expose an API → Add a scope** named `access_as_user`, consentable by admins and users.
6. **Add two authorized client applications** to that scope — Microsoft's own Teams clients.
   Without them Teams will not issue a token silently.

    ```
    1fec8e78-bce4-4aaf-ab1b-5451cc387264   Teams desktop & mobile
    5e3ce6c0-2b1f-4285-8d4b-75ee78787346   Teams web
    ```

7. **Manage → Manifest** → set `"requestedAccessTokenVersion": 2`. It is unset by default,
   and SSO does not work without it.
8. **Authentication → Add a platform → Web**, redirect URI
   `https://token.botframework.com/.auth/web/redirect` — the Bot Framework token service's
   callback. Without it the OAuth connection cannot complete.
9. Note the bot's **Application (client) ID** and your **Directory (tenant) ID**.

### 2. Create the Azure Bot resource

1. **Azure portal → Create a resource → Azure Bot**. Type: **Single Tenant**. Use the app
   registration from step 1 rather than letting Azure create a new one.
2. **Configuration → Messaging endpoint**: `https://<your-identity-atlas-host>/api/messages`
3. **Channels → Microsoft Teams** → enable.
4. **Configuration → Add OAuth Connection Settings**:
    - **Name**: `identityatlas` — this must match `TEAMS_BOT_CONNECTION_NAME` (below).
    - **Service Provider**: *Azure Active Directory v2*.
    - **Client id / secret / Tenant ID**: the bot's, from step 1.
    - **Token Exchange URL**: `api://botid-<bot-client-id>` — the SAME string as the
      Application ID URI in step 1 and as the manifest's `webApplicationInfo.resource`.
      All three must match exactly, or Teams answers `resourcematchfailed`.
    - **Scopes**: `api://<identity-atlas-client-id>/access`
5. Click **Test Connection** and complete the consent prompt. If this does not work here, it
   will not work in Teams either — fix it before going on.

### 3. Give pilot managers the permission to ask

Asking needs the `data.read.reports` permission ("Ask questions in plain language"). It is
deliberately **not** implied by "Build custom reports", so a pilot manager does not get the
ability to create and delete saved reports that every analyst sees.

In **Admin → Authentication → Roles & Permissions**, map an Entra app role to it — either an
existing role or a new `PilotManager` role — then assign the pilot managers to that role in
Entra. See [Permissions](permissions.md).

### 4. Configure and switch on Identity Atlas

Environment variables on the web container:

| Variable | Required | What it is |
|---|---|---|
| `TEAMS_BOT_APP_ID` | yes | The bot's Entra application (client) ID, from step 1 |
| `TEAMS_BOT_APP_PASSWORD` | yes | The client secret from step 1. Put it in the same secret store as the other Identity Atlas credentials — never in a compose file in the repo |
| `TEAMS_BOT_APP_TENANT_ID` | yes | Your directory (tenant) ID |
| `TEAMS_BOT_APP_TYPE` | no | `SingleTenant` (the default) |
| `TEAMS_BOT_CONNECTION_NAME` | no | The OAuth connection name from step 2.4. Default `identityatlas` |
| `PUBLIC_BASE_URL` | no | e.g. `https://fortigi.identityatlas.io`. Without it, cards that cannot show the whole answer have no "Open the full report" link |
| `TEAMS_BOT_DEADLINE_MS` | no | How long a caller waits before being told it failed. Default `420000` — see [Latency](#latency) |
| `TEAMS_BOT_LOG_RETENTION_DAYS` | no | How long conversations — and therefore deep links — survive. Default `90` |

Then switch the feature on: **Admin → Experimental → Teams bot**, or ship
`FEATURE_TEAMS_BOT=true`. The flag is called **`teamsBot`** and it is **off by default**.
While it is off, `POST /api/messages` answers **404** — not 401 — so a disabled bot is
indistinguishable from an install that never had one.

The bot also needs the report generator itself, which is a separate opt-in container. See
[Report Generator](report-generator.md) — and note its standing warning that the generator
**has not been deployed on Azure yet**.

### 5. Upload the Teams app and restrict it to the pilot group

The app package is in [`setup/teams-bot/`](https://github.com/Fortigi/IdentityAtlas/tree/main/setup/teams-bot):
`manifest.json`, `color.png`, `outline.png`.

1. Replace every `REPLACE-WITH-…` placeholder in `manifest.json`:
   `REPLACE-WITH-BOT-ENTRA-APP-ID` (three places) and
   `REPLACE-WITH-YOUR-IDENTITY-ATLAS-HOST` (two places). Leave
   `token.botframework.com` in `validDomains` — without it Teams renders the
   sign-in card and then fails it with *"Something went wrong. Please try
   again."*, because it may not open the sign-in the card points at.
2. Zip the three files **at the root of the zip**, not inside a folder.
3. **Bump `version` for every re-upload.** Teams refuses an update that carries a
   version it has already seen — *"This update needs a new app version number"* —
   so changing an icon or a line of copy means incrementing `version` as well.
   It is unrelated to the Identity Atlas release version; it only has to increase.
4. **Teams admin center → Teams apps → Manage apps → Upload new app.**
5. **Teams apps → Setup policies** → your policy → **Upload custom apps: On**. Off by default
   in many tenants, and the symptom is simply that the app never appears.
6. **Teams apps → Permission policies**: create a policy that allows this app, and assign it
   to the pilot managers only. Everyone else will not see the app.
7. **Teams → Apps → Built for your org → install.** Policy changes can take a while to
   propagate.

!!! note "About the icons"
    `color.png` (192×192) is the Identity Atlas mark. `outline.png` (32×32) is a white
    *shield* silhouette rather than the full mark: Teams renders the outline icon
    monochrome in the app bar, where the brain-network detail turns to mush.

## What it deliberately does not do

**It knows who is asking; it does not restrict what they may see.** Every caller who gets
past caller resolution can ask about the whole directory, not just their own people. The
mitigations for the POC are the **pilot group** (who can install the app at all) and the
**conversation log** (every answer is recorded against the person who asked). The place the
filter would slot in is marked in the code — `callerScopeFilter` in
`app/api/src/teamsbot/caller.js` — and it is a function rather than a TODO comment so that
adding it lands in the compiled SQL rather than in card rendering.

**It cannot tell you what changed.** "Zijn er recent users toegevoegd of verwijderd?" is not
answerable: Identity Atlas records changes (the `_history` table behind the recent-changes
timeline), but the report catalog has no concept of a change, so the generator cannot express
the question. Adding one is catalog work, not bot work.

Also out of scope for v1: proactive messages (the bot never starts a conversation), any
write operation (no approvals, revocations or certifications), channel and group chats
(personal chat only), and memory beyond the records of the previous answer.

## Latency

Answers are slow, and the POC's job is to measure *how* slow rather than to be fast. Measured
for this model on 2 vCPU ([Report Generator](report-generator.md)):

| | |
|---|---|
| Question once warm | median **49 s**, p90 **107 s**, slowest **156 s** |
| First question after the model unloaded | **76 s** |
| First question with no restored prompt cache | **266 s** |

!!! warning "Those figures are for ONE model call"
    A question whose first definition fails validation costs a **repair round** — a second
    call of the same size. Observed on fortigi.identityatlas.io: 18.9 s prompt eval + 80.1 s
    generation ≈ **99 s per call**, so a question that repairs once takes **~200 s and still
    answers correctly**. An earlier 180 s budget was set from the single-call p90 and cut
    exactly those off, reporting a slow success as a failure.

So the bot greets the caller by name the moment the question arrives — the name comes from
their own signed token, so it cannot disagree with the account the answer is about — then
sends a typing indicator and keeps refreshing it until the answer lands. It gives up at
**420 seconds** with a reply that says how long it waited. It never leaves a question
unanswered, which is what makes a wait that long tolerable rather than alarming.

There is deliberately **one** message before the answer, not two. An earlier version added a
"still going" nudge on a 45 s timer; in a chat that reads as the bot repeating itself, and
the typing indicator already says the same thing without costing a message.

!!! warning "One question at a time, for everyone"
    The model server has a **single slot**. Two managers asking at once are served one after
    the other, so the second waits roughly twice the median. With the report builder and the
    context assistant on the same generator, that is three things competing for one slot.
    This is the first thing to watch in a pilot.

Every answer records model time, query time and total time in the conversation log, so the
decision about more vCPUs or a GPU can be made on measurements rather than impressions.

## Language

Dutch and English input; the bot's own replies come back in the language of the question.
Two things stay English whatever was asked: the **interpretation line** (it is generated from
the validated definition, not written by the model) and clarifying questions (they come back
in whatever language the model wrote them). Every answer logs the language it detected, so
mismatches can be counted rather than argued about. Parity is a thing to measure here, not a
guarantee.

## Privacy and audit

The [privacy properties of the report generator](report-generator.md#privacy) apply
unchanged: the model runs in a container next to Identity Atlas, it never sees rows, values
or counts, and nothing leaves the deployment. The bot adds exactly one thing to what the
model is told — **the caller's own name and account id**, so that "my" means something.

Every question writes one row to `BotConversations`:

- who asked (Entra object id), which conversation, when;
- the question **as typed**, and the language detected;
- the **validated** report definition (never the model's raw reply);
- the outcome, and the clarifying question if one was asked;
- the row count and the **column names** — never the rows themselves;
- model time, query time, total time.

The answer's rows are deliberately not stored: they are re-derivable by running the
definition again, and copying them would duplicate customer data into a log kept far longer
than any query result needs to be.

**The question text is personal data.** A question routinely names a colleague ("which
groups is Jan de Vries in"), which is the point of an audit trail and also why the table has
a retention window — `TEAMS_BOT_LOG_RETENTION_DAYS`, 90 days by default. Deleting a
conversation also kills its deep link, deliberately: the link should not outlive the record
that explains where it came from.

## Troubleshooting

| What you see | What it usually is |
|---|---|
| `POST /api/messages` returns 404 | The `teamsBot` feature is off, or `FEATURE_TEAMS_BOT` is not exactly `true` |
| The bot asks you to sign in every time, and the log shows `signin/failure` / `resourcematchfailed` | The Application ID URI, the connection's Token Exchange URL and the manifest's `webApplicationInfo.resource` are not the identical string. All three must be `api://botid-<bot-client-id>`. Also check `requestedAccessTokenVersion` is 2 |
| "Your account is signed in, but it has no permission" | The caller's Entra app role does not map to `data.read.reports` (step 3) |
| "I cannot find your account in Identity Atlas" | The caller's account was created after the last Entra crawl, or the crawler has never run. Their `oid` must exist as a `Principals.id` |
| Answers always time out | The report generator container is not running, or is cold. Check **Admin → LLM**, and see [Report Generator](report-generator.md) |
| The app does not appear in Teams for someone | They are not in the group the permission policy is assigned to (step 5.4) |

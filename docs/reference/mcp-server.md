# MCP server — connect an AI assistant

Identity Atlas can act as an [MCP](https://modelcontextprotocol.io) server: people connect
Claude, ChatGPT or Copilot to it and ask questions in plain language — *"which guests
have not signed in for 90 days?"*, *"who can read mail tenant-wide?"*, *"what does Jan
have that his team does not?"* The assistant signs in **as that person** through Entra ID,
reads only what their Identity Atlas role allows, and draws its own tables and charts
from the answers.

It is an [experimental feature](experimental-features.md#mcp-server), off by default.

## What the assistant can do

Everything is read-only.

| Tool | What it does | Permission needed (besides **Use the MCP server**) |
|---|---|---|
| `whoami` | Who the assistant acts for, and their account in the directory | — |
| `list_reports` | The ready-made reports (built-in and saved), with their parameters | Read all data |
| `run_report` | Run one of them | Read all data |
| `search` | Find people, accounts, groups, roles, applications or contexts by name | Read all data |
| `describe_data_model` | The vocabulary for free-form questions: entities (contexts included), fields, relations, rules, examples, and the values that exist in this deployment. The deployment's own extra attributes are listed on request, per entity | Ask questions in plain language |
| `run_query` | Answer a free-form question with a report definition | Ask questions in plain language |
| `get_photos` | Profile photos of up to 10 accounts, as images and as data URIs (for an org chart or a card) | Read all data |

`run_query` uses the same engine as **Reports → Ask**: the assistant writes a JSON report
definition, never SQL; the server validates it against the catalog, compiles it to
parameterised SQL and runs it in a read-only transaction with a 15-second timeout. "My" /
"I" work: the server substitutes the signed-in user's own account.

Answers are capped at 100 rows by default (the assistant may ask for up to 500). A capped
answer says `"truncated": true` and gives the full count as `total` (or `totalAtLeast`
past 5,000), so the assistant can say "119 groups" rather than "100". Every record
carries its id, which the assistant uses to chain one query into the next, and a link
back to its page in Identity Atlas.

Every answer also carries `scope`, which says whether authorization limited it:

```json
"scope": { "restricted": true, "basis": "context-owner",
           "description": "Only what you may see as the Accountable or Responsible person for …",
           "contexts": [{ "id": "…", "name": "CTO (Carla Cash)", "role": "Accountable" }] }
```

`restricted` and `truncated` are different things: `restricted` means the person may only
see part of the organisation, so `total` counts that part and never the whole; `truncated`
means the row cap cut the list off. The server instructions tell the assistant to say so,
and never to present a restricted count as the organisation's total. For somebody with a
role the block reads `{ "restricted": false, "basis": "role", … }`.

A group that is "empty" or "without members" is read as fully empty: no accounts,
devices, nested groups or eligible members. When groups exist that hold no accounts but
do hold devices or nested groups, the assistant says how many and offers to list them.

## Who may use it

Three things must all be true (or, instead of the third, the person is a
[context owner](#context-owners) and the switch for them is on):

1. **Sign-in is on.** With authentication off there is no user to act for: the endpoint
   answers `404` and the switch refuses to turn on.
2. **The feature is on** — **Admin → Experimental → MCP server**.
3. **The person's role has *Use the MCP server*** (`mcp.use`) — **Admin → Authentication &
   roles**. The seed `Admin` role has it (`*`); no other seed role does. It is a gate, not a
   grant: each tool still needs the permission the same data needs in the UI, so an
   assistant never sees more than its user could.

API keys (`fgr_` / `fgc_`) are refused — they act for no one.

### Context owners

A person who is **Accountable or Responsible for a context** but holds no Identity Atlas
role (a department manager, an application owner —
[context-owner access](../architecture/context-owner-access.md)) may also use the MCP
server, when the admin turns on **Admin → Roles & Permissions → Relative permissions →
Context owners may also use the MCP server** (next to the context-owner switch, which must
be on too). They then see exactly what they see in the app, enforced by the same code:

- every `run_query` lists only the records they may open — their contexts' members,
  what those members hold (or, for an application, who holds it), their sub-units. For
  those records, member lists and counts are complete by name, as in the app; anything
  more about a related record outside their part (its other fields, filtering on it) is not
  available;
- `search` and every name lookup find those records. Somebody outside their part, named
  by their exact full name, is reported as **existing but out of reach** — name and type
  only — so the assistant can say "she exists, but I can't show details" instead of "not
  found". A name that exists nowhere is "not found";
- `list_reports` / `run_report` offer only the two reports the app lets them download on
  their own contexts (by id), and refuse anything else as if it did not exist;
- `get_photos` returns photos of the people they may open and their own, as their
  pages in the app show them; for anyone else it answers as for an unknown id;
- comparing with a reference record is not available to them.

Somebody who holds any Identity Atlas permission is not treated as a context owner here,
as in the app: without **Use the MCP server** they are refused. How this is enforced and
tested: [MCP and relative permissions](../architecture/mcp-authorization.md).

!!! warning "Data leaves the deployment"
    What the assistant reads is sent to that assistant's vendor (Anthropic, OpenAI,
    Microsoft) to produce its answer. Only switch the feature on where that is acceptable,
    and only give **Use the MCP server** to roles that may share that data.

## Audit log

Every tool call is recorded in the `McpToolCalls` table: when, who, which client, which
tool with which arguments, whether it succeeded, and how many rows went out — never the
rows themselves. The latest calls are listed on the **MCP server** card under **Admin →
Experimental**.

## Before you start

| You need | Why |
|---|---|
| **An address the assistant can reach** | Claude (web, desktop, mobile), ChatGPT and Microsoft Copilot call the MCP server **from their vendor's cloud**, not from the user's PC. Identity Atlas must answer on a public HTTPS address (`https://<your host>/mcp`). An installation that is only reachable on the internal network or on one laptop works with local clients only (Claude Code, VS Code). |
| **`PUBLIC_BASE_URL`** set to that address | The server tells the assistant where to sign in and which resource to ask for, built from this address. Behind a reverse proxy, set it (or `TRUST_PROXY`) so the address is the public one. |
| **Sign-in on, the feature on, the permission on a role** | See [Who may use it](#who-may-use-it). |
| **A Microsoft Entra admin** (Application Administrator or higher) | For the two app-registration changes below. |
| **The assistant's own plan or licence** | Per assistant — see [Connect an assistant](#3-connect-an-assistant). |

## Setting it up

### 1. The Entra app registration

MCP clients sign in through the same Entra app registration Identity Atlas already uses
(the one in **Admin → Authentication**). Two additions, under **Expose an API**:

1. **Add a scope** `Mcp.Read` — *Who can consent: Admins and users*, display name e.g.
   *Read Identity Atlas through an AI assistant*.
2. **Add an Application ID URI** equal to your MCP URL: `https://<your host>/mcp` (keep the
   existing `api://<client id>`). AI clients send this URL as the sign-in *resource*; without
   it Entra refuses the token request with `AADSTS9010010`. Entra only accepts it when the
   host is on a domain verified in your tenant.

Both are additions: the existing sign-in of the web app keeps working.

Your MCP URL and the exact scope to use are shown on the MCP server card once the feature
is on. The scope is `https://<your host>/mcp/Mcp.Read`.

### 2. A client app registration for the assistants

Entra does not let an assistant register itself (no dynamic client registration), so an
admin registers one app the assistants sign in **as** — e.g. *Identity Atlas MCP clients*.
It identifies the assistant, not the user: every user still signs in with their own
account, and the secret on its own gets no data.

- **Supported account types**: *this organisational directory only*.
- **Redirect URIs** — only those of the assistants you allow:

    | Assistant | Platform | Redirect URI |
    |---|---|---|
    | Claude (web, desktop, mobile) | Web | `https://claude.ai/api/mcp/auth_callback` |
    | Claude Code, VS Code and other local clients | Mobile and desktop applications | `http://localhost` and `http://127.0.0.1` (Entra accepts any port) |
    | ChatGPT | Web | the callback URL ChatGPT shows when you add the app (per app; older apps used `https://chatgpt.com/connector_platform_oauth_redirect`) |
    | Microsoft 365 Copilot (federated connector) | Web | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` |
    | Copilot Studio agent | Web | the redirect URL Copilot Studio shows after you save the MCP tool |

- **API permissions** → *Add a permission* → *My APIs* → your Identity Atlas app →
  delegated `Mcp.Read`, then **Grant admin consent**, so users get no consent prompt.
- **Certificates & secrets** → a client secret. Note when it expires: the assistants stop
  signing in on that date until you give them a new one.

With the Azure CLI, as an Application Administrator (replace the two ids and the host):

```bash
API_APP_ID=<client id of the Identity Atlas app>
SCOPE_ID=<id of the Mcp.Read scope, from step 1>
CLIENT_APP_ID=$(az ad app create --display-name "Identity Atlas MCP clients" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://claude.ai/api/mcp/auth_callback" \
  --public-client-redirect-uris "http://localhost" "http://127.0.0.1" \
  --query appId -o tsv)
az ad app update --id "$CLIENT_APP_ID" --required-resource-accesses \
  "[{\"resourceAppId\":\"$API_APP_ID\",\"resourceAccess\":[{\"id\":\"$SCOPE_ID\",\"type\":\"Scope\"}]}]"
az ad sp create --id "$CLIENT_APP_ID"
az ad app permission admin-consent --id "$CLIENT_APP_ID"
az ad app credential reset --id "$CLIENT_APP_ID" --append --display-name assistants --years 1 \
  --query password -o tsv > client-secret.txt   # keep this file safe
```

### 3. Connect an assistant

Every assistant needs the same three values:

- **URL**: `https://<your host>/mcp`
- **Client ID** and **client secret** of the client app from step 2
- if it asks for a **scope**: `https://<your host>/mcp/Mcp.Read`

It discovers the rest — the tenant and where to sign in — from
`https://<your host>/.well-known/oauth-protected-resource/mcp`.

#### Claude

| | |
|---|---|
| **Plan** | Any. Free accounts can add one custom connector. |
| **Who adds it** | Pro / Max: each user. Team / Enterprise: an **Owner** adds it once for the organisation; members then only click **Connect**. |

1. Pro / Max: **Customize → Connectors** (`https://claude.ai/customize/connectors`) →
   **+ Add** → **Add custom connector**.
   Team / Enterprise: **Organization settings → Connectors**
   (`https://claude.ai/admin-settings/connectors`) → **Add** → **Custom** → **Web**.
2. Name *Identity Atlas*, URL `https://<your host>/mcp` → **Continue**.
3. **OAuth client**: choose **Use your own OAuth client** and enter the client ID and secret.
4. **Add**, then **Connect**, and sign in with the work account.

The connector belongs to the Claude account: once connected it works in the browser, the
desktop app and on mobile. Charts and tables are drawn by Claude itself from the rows.

**Claude Code** (runs on the user's machine, so it also works for an installation that is
only reachable internally):

```bash
claude mcp add --transport http identity-atlas https://<your host>/mcp --client-id <client id> --callback-port 33418
```

then run `/mcp` in Claude Code to sign in.

#### ChatGPT

| | |
|---|---|
| **Plan** | Business, Enterprise or Edu — custom MCP apps with full tool use. OpenAI's plan list for Plus and Pro has changed over time; check its help article *Developer mode and MCP apps in ChatGPT*. |
| **Who adds it** | A workspace admin or owner turns on **developer mode** (Workspace settings → Permissions & roles), creates the app and publishes it to the workspace. |

1. In ChatGPT, with developer mode on: **Settings → Apps & Connectors → Create**.
2. URL `https://<your host>/mcp`, authentication **OAuth**.
3. Under the advanced OAuth settings, leave the registration URL empty, choose the
   **user-defined OAuth client**, and enter the client ID and secret.
4. Copy the **callback URL** ChatGPT shows and add it to the client app (step 2) as a
   *Web* redirect URI.
5. Save, sign in, and publish the app to the workspace.

#### Microsoft 365 Copilot

There are two ways in, and which one fits depends on the licences the organisation has.
The free **Microsoft 365 Copilot Chat** that comes with Office 365 is *not* the same as the
paid **Microsoft 365 Copilot** add-on.

| | Federated connector | Copilot Studio agent |
|---|---|---|
| **Users need** | A **Microsoft 365 Copilot** licence (the add-on, or E7). Microsoft's prerequisites rule out the free Copilot Chat and pay-as-you-go. | Nothing extra: also works for users with only the free Copilot Chat. |
| **The organisation needs** | — | Copilot Studio capacity; use is billed in **Copilot Credits**. The person who builds the agent needs a Copilot Studio or Microsoft 365 Copilot licence. |
| **Who sets it up** | A **Global Administrator** or **AI Administrator**. | An agent maker in Copilot Studio. |
| **Users find it** | Copilot Chat → **Settings → Sources**. | As an agent in Copilot Chat and Teams. |
| **Redirect URI** on the client app | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` | the URL Copilot Studio generates |

You can see which licences users have in the Microsoft 365 admin center under
**Billing → Licenses**.

**Federated connector**

1. **Teams Developer Portal** (`https://dev.teams.microsoft.com`) → **Tools → OAuth client
   registration** → new registration:
    - client ID and secret of the client app (step 2)
    - authorization endpoint `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/authorize`
    - token endpoint `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/token`
    - scope `https://<your host>/mcp/Mcp.Read`
    - do not restrict it to a Teams app ID

    Save, and copy the **OAuth registration ID**.
2. Add `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` to the client app as a
   *Web* redirect URI.
3. **Microsoft 365 admin center → Copilot → Connectors → Connect to MCP server**: URL
   `https://<your host>/mcp`, authentication **OAuth 2.0**, and the OAuth registration ID.
   Choose which users see it.

**Copilot Studio agent**

1. In Copilot Studio, open or create an agent with **generative orchestration** on.
2. **Tools → Add a tool → Model Context Protocol**: server URL `https://<your host>/mcp`,
   authentication **OAuth 2.0 → Manual**:
    - client ID and secret of the client app (step 2)
    - authorization URL `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/authorize`
    - token URL `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/token`
    - refresh URL: the same as the token URL
    - scope `https://<your host>/mcp/Mcp.Read`
3. Save, copy the **redirect URL** Copilot Studio shows, and add it to the client app as a
   *Web* redirect URI.
4. Test the agent, then publish it to Microsoft 365 Copilot and Teams.

!!! note
    The Claude connection is tested against a live deployment. The ChatGPT and Copilot steps
    follow the vendors' documentation; their menus change often, so if a label differs,
    the three values above (URL, client ID and secret, scope) are still all you need.

## How sign-in works

```text
assistant ──POST /mcp (no token)──────────────▶ Identity Atlas   401 + WWW-Authenticate: resource_metadata=…
assistant ──GET /.well-known/oauth-protected-resource/mcp──────▶ { authorization_servers: [Entra tenant], scopes_supported: [<host>/mcp/Mcp.Read] }
assistant ──sign the user in (OAuth + PKCE)───▶ Entra ID         access token for the user, scp = Mcp.Read
assistant ──POST /mcp (Bearer token)──────────▶ Identity Atlas   token checked: signature, tenant, issuer, audience,
                                                                  scope Mcp.Read, role → mcp.use; then the tool runs
```

This is delegated access: the token belongs to the signed-in user, and every query runs
with that user's rights and is logged under their name. It is not Entra's
*on-behalf-of* token exchange — the MCP server reads its own database and calls no other
API as the user.

The token's audience must be the MCP URL, `api://<client id>` or the client id; the web
app's own tokens (scope `access`) and app-only tokens are refused, because they do not carry
`Mcp.Read`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `404` on `/mcp` | Sign-in is off, or the feature is off. |
| The assistant cannot reach the server | Identity Atlas is not reachable from the internet; cloud assistants call it from their vendor's cloud. See [Before you start](#before-you-start). |
| Sign-in fails with `AADSTS9010010` / `invalid_target` | The MCP URL is not an Application ID URI of the Identity Atlas app (step 1.2). |
| Sign-in fails with `AADSTS50011` (redirect URI mismatch) | The assistant's redirect URI is not on the client app (step 2), or differs in one character. |
| Sign-in fails with `AADSTS700003` ("your organisation has deleted this device") | Not Identity Atlas: Windows single sign-on sent a device registration that no longer exists in Entra. Sign in from a browser without the work profile, or remove and re-add the work account under Windows *Settings → Accounts → Access work or school*. |
| Claude on the web never finishes signing in, Claude Code does | A known claude.ai issue with Entra as the sign-in server ([anthropics/claude-ai-mcp#506](https://github.com/anthropics/claude-ai-mcp/issues/506)). Try again later, or use Claude Code. |
| `403` with `insufficient_scope` | The client asked for a different scope; use `https://<your host>/mcp/Mcp.Read`. |
| `403` naming `mcp.use` | The user's role lacks **Use the MCP server**. |
| The assistant has no `run_query` | The user's role lacks **Ask questions in plain language**. |
| `401 invalid_token` | Expired token, or one from another tenant; check that `PUBLIC_BASE_URL` is the address the assistant uses. |
| Everyone stops signing in on the same day | The client app's secret expired; create a new one and update each assistant. |

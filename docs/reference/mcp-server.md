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
| `describe_data_model` | The vocabulary for free-form questions: entities, fields, relations, rules, examples, and the values that exist in this deployment | Ask questions in plain language |
| `run_query` | Answer a free-form question with a report definition | Ask questions in plain language |

`run_query` uses the same engine as **Reports → Ask**: the assistant writes a JSON report
definition, never SQL; the server validates it against the catalog, compiles it to
parameterised SQL and runs it in a read-only transaction with a 15-second timeout. "My" /
"I" work: the server substitutes the signed-in user's own account.

Answers are capped at 100 rows by default (the assistant may ask for up to 500). A capped
answer says `"truncated": true`, and every record carries a link back to its page in
Identity Atlas.

## Who may use it

Three things must all be true:

1. **Sign-in is on.** With authentication off there is no user to act for: the endpoint
   answers `404` and the switch refuses to turn on.
2. **The feature is on** — **Admin → Experimental → MCP server**.
3. **The person's role has *Use the MCP server*** (`mcp.use`) — **Admin → Authentication &
   roles**. The seed `Admin` role has it (`*`); no other seed role does. It is a gate, not a
   grant: each tool still needs the permission the same data needs in the UI, so an
   assistant never sees more than its user could.

API keys (`fgr_` / `fgc_`) are refused — they act for no one.

!!! warning "Data leaves the deployment"
    What the assistant reads is sent to that assistant's vendor (Anthropic, OpenAI,
    Microsoft) to produce its answer. Only switch the feature on where that is acceptable,
    and only give **Use the MCP server** to roles that may share that data.

## Audit log

Every tool call is recorded in the `McpToolCalls` table: when, who, which client, which
tool with which arguments, whether it succeeded, and how many rows went out — never the
rows themselves. The latest calls are listed on the **MCP server** card under **Admin →
Experimental**.

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

Your MCP URL and the exact scope to use are shown on the MCP server card once the feature
is on. The scope is `https://<your host>/mcp/Mcp.Read`.

### 2. A client app registration for the assistants

Create one more app registration — e.g. *Identity Atlas MCP clients* — that the assistants
sign in with:

- **Redirect URIs**
    - *Web*: `https://claude.ai/api/mcp/auth_callback` (Claude on the web, desktop and mobile)
    - *Mobile and desktop applications*: `http://localhost` (Claude Code and other local clients; Entra accepts any port)
    - add the redirect URI of each other assistant you allow (ChatGPT, Copilot Studio) as its own documentation gives it
- **API permissions** → *My APIs* → your Identity Atlas app → delegated `Mcp.Read`, then
  **Grant admin consent**.
- **Certificates & secrets** → a client secret, for the web clients.

### 3. Connect an assistant

**Claude (claude.ai, desktop, mobile)** — *Settings → Connectors → Add custom connector*:
URL `https://<your host>/mcp`; under *Advanced settings*, the client app's **client ID** and
**client secret**. Click **Connect** and sign in.

**Claude Code**:

```bash
claude mcp add --transport http identity-atlas https://<your host>/mcp --client-id <client id> --callback-port 33418
```

then run `/mcp` in Claude Code to sign in.

**Other assistants** (ChatGPT, Copilot Studio, VS Code): add a remote MCP server with the
same URL and the client app's ID (and secret where asked). They discover the rest — the
tenant and the scope — from `https://<your host>/.well-known/oauth-protected-resource/mcp`.

## How sign-in works

```text
assistant ──POST /mcp (no token)──────────────▶ Identity Atlas   401 + WWW-Authenticate: resource_metadata=…
assistant ──GET /.well-known/oauth-protected-resource/mcp──────▶ { authorization_servers: [Entra tenant], scopes_supported: [<host>/mcp/Mcp.Read] }
assistant ──sign the user in (OAuth + PKCE)───▶ Entra ID         access token for the user, scp = Mcp.Read
assistant ──POST /mcp (Bearer token)──────────▶ Identity Atlas   token checked: signature, tenant, issuer, audience,
                                                                  scope Mcp.Read, role → mcp.use; then the tool runs
```

The token's audience must be the MCP URL, `api://<client id>` or the client id; the web
app's own tokens (scope `access`) and app-only tokens are refused, because they do not carry
`Mcp.Read`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `404` on `/mcp` | Sign-in is off, or the feature is off. |
| Sign-in fails with `AADSTS9010010` / `invalid_target` | The MCP URL is not an Application ID URI of the Identity Atlas app (step 1.2). |
| `403` with `insufficient_scope` | The client asked for a different scope; use `https://<your host>/mcp/Mcp.Read`. |
| `403` naming `mcp.use` | The user's role lacks **Use the MCP server**. |
| The assistant has no `run_query` | The user's role lacks **Ask questions in plain language**. |
| `401 invalid_token` | Expired token, or one from another tenant; check that `PUBLIC_BASE_URL` is the address the assistant uses. |

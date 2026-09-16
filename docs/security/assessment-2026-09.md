---
type: reference
---

# Security Assessment — September 2026

Identity Atlas was re-assessed in **September 2026** with a white-box security review of `main` (version `5.671`, commit `b9313bb5b`). This was the first full re-test after the [June 2026 assessment](assessment.md) and the [June maintenance audit](maintenance-audit-2026-06.md), with more than 1,100 commits merged between the two.

This page is the **public, sanitised record** of that review: scope, method, every finding with its severity and remediation pull request, the regression check against June, and the controls that were confirmed sound. Step-by-step exploit detail is deliberately left out. The code changes in the linked pull requests are the technical reference.

!!! info "Why we publish this"
    A governance product should be transparent about its own security. Every finding that calls for a code change has a remediation pull request open against `main`. The remaining four are accepted or tracked separately. The status column is reconciled on `main` after those pull requests merge.

---

## Scope

| Layer | What was reviewed |
|---|---|
| **Node.js API** | Express app, authentication and authorization on every route, the ingest engine, the secrets vault, the LLM and risk-scoring subsystem, auto-update, exports, the database layer and migrations |
| **React UI** | Injection sinks, token handling, cross-site request handling for installs with authentication off, spreadsheet exporters |
| **PowerShell worker** | Job dispatcher and all crawlers (Entra ID, Azure RM, Omada, SCIM, midPoint, OData, CSV, custom connector) |
| **Deployment** | Docker Compose files, Dockerfiles, Azure Bicep templates, the portable Windows build |
| **CI and automation** | GitHub Actions workflows, including the automated "Definition of Ready" build agents that run on self-hosted runners |
| **Dependencies** | npm lockfiles for API and UI, PowerShell module sourcing, static analysis with PSScriptAnalyzer |

## Method

Six parallel review streams read the source end to end, following each untrusted value from where it enters to where it is used:

1. Authentication and authorization coverage of every HTTP route
2. SQL construction and ingest data integrity
3. Secrets, cryptography, configuration, containers, Azure templates and CI supply chain
4. File handling, server-side request forgery, the LLM subsystem, auto-update and exports
5. The PowerShell worker and crawlers
6. Client-side security in the React UI

Every Critical and High finding was independently re-verified against the source before it was recorded. Where behaviour depended on the runtime, it was reproduced with a minimal harness against the installed dependencies: request routing, the SSRF guard module, and key-hashing cost. The review was read-only. No repository or deployment was changed during the assessment itself.

---

## Result at a glance

| Severity | Found |
|---|---:|
| Critical | 1 |
| High | 7 |
| Medium | 14 |
| Low | 19 |
| Informational | 12 |
| **Total** | **53** |

**What held up.** Every Critical and High finding from June 2026 is still fixed. Authorization fails closed. SQL is uniformly parameterised: all of roughly 45 dynamic-SQL sites were traced and none is injectable. The UI has no HTML injection sinks. The vault's envelope encryption is sound. There is no unauthenticated remote code execution or data read on a deployment with authentication enabled.

**What this review found** is a different class of problem: trust boundaries that existed in the permission model and the documentation but were not enforced in code.

- **The crawler ingest path had no per-system boundary.** A crawler credential scoped to one connected system could change or remove data belonging to other systems.
- **The credential vault could be read indirectly.** Two admin sub-roles, the LLM administrator and the crawler administrator, could cause stored connected-system credentials to be sent to a host of their choosing. Neither role is meant to be able to read those credentials.
- **The SSRF guard could be bypassed** with an alternative address notation, and the worker validated no outbound URLs of its own.
- **Automation and infrastructure.** The automated build agents processed untrusted issue comments while holding repository credentials. The Azure template derived the database administrator password from values that are not secret.
- **Installs with authentication off** could be driven by a malicious web page the operator visited.

---

## Findings & remediation

> **Maintenance note — do not edit the status cells on a feature or bugfix branch.** As with the [June assessment](assessment.md), statuses are reconciled in a single pass on `main` after pull requests merge, so branches do not conflict on the same rows.

Status legend: ✅ **Fixed** (merged) · 🔍 **Fix in review** (pull request open) · 🟦 **By design / accepted** · 🟨 **Partially addressed** · 🔧 **Planned**.

### Critical

| ID | Area | Finding | Status | PR |
|---|---|---|---|---|
| C-01 | Ingest | A crawler credential could remove every connected system, and all data beneath it, through the system-registration endpoint. One shipped crawler exercised the same code path during normal runs. | 🔍 Fix in review | [#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200) |

### High

| ID | Area | Finding | Status | PR |
|---|---|---|---|---|
| H-01 | Vault | The LLM administrator role could resolve any stored secret, not only scraper credentials, and delete any secret. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| H-02 | Vault / worker | The crawler administrator role could bind another crawler configuration's stored client secret to a job pointing at an arbitrary endpoint. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| H-03 | SSRF | The outbound URL guard did not recognise IPv4 addresses written in IPv6 notation, allowing requests to internal and metadata addresses. | 🔍 Fix in review | [#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198) |
| H-04 | Ingest | A crawler scoped to one system could overwrite, soft-delete or forge records belonging to other systems, and could set fields reserved for the server and analysts. | 🔍 Fix in review | [#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200) |
| H-05 | CI automation | Automated build agents ran with shell access on self-hosted runners, held repository credentials, and received every comment on a public issue as input. | 🔍 Fix in review · runner isolation and branch-ruleset changes are manual follow-ups | [#1194](https://github.com/Fortigi/IdentityAtlas/pull/1194) |
| H-06 | Azure | The Azure template derived the database administrator password from non-secret deployment identifiers, and the database accepted connections from all Azure address space. | 🔍 Fix in review · Entra ID database sign-in deferred | [#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197) |
| H-07 | Web (auth off) | With authentication off, a web page visited by the operator could trigger destructive administrative actions, and DNS rebinding could read data. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |

### Medium

| ID | Area | Finding | Status | PR |
|---|---|---|---|---|
| M-01 | Authorization | The read-token restriction on administrative paths was bypassable through path casing, and several administrative read endpoints had no permission gate. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| M-02 | Vault / SSRF | Connector credentials followed an endpoint change without re-entry, and connection tests followed redirects and posted credentials to an unvalidated token endpoint. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196), [#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198) |
| M-03 | Worker | Crawler base and token URLs were not validated on the worker side. | 🔍 Fix in review | [#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198) |
| M-04 | Availability | Unauthenticated requests could force large body parsing and repeated key hashing before crawler authentication completed. | 🔍 Fix in review · longer key prefix deferred | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| M-05 | Ingest | Several crawler endpoints were unscoped: tenant-wide re-classification and view refresh, the default matrix filter, the sync log, a presence lookup, and job progress. | 🔍 Fix in review | [#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200) |
| M-06 | Authorization | The crawler administrator role could create a crawler credential with worker-level permissions, and the built-in worker was identified only by its display name. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| M-07 | Availability | Crawler ingest sessions could exhaust the database connection pool. | 🔍 Fix in review | [#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200) |
| M-08 | Deployment | The vault master key was stored on a volume shared with the worker, which ran as root. | 🔍 Fix in review | [#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197) |
| M-09 | Availability | Rate limits were keyed on the client address without proxy awareness, so all users behind a reverse proxy shared one limit. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| M-10 | Vault | Some connector credential types were stored in plaintext at configuration level. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| M-11 | Worker | A failed upstream fetch in one crawler could be reported as an empty result, removing that system's group memberships. | 🔍 Fix in review | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| M-12 | SSRF | A context-plugin feed URL was fetched without the SSRF guard or a size limit. | 🔍 Fix in review | [#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198) |
| M-13 | UI | Spreadsheet formula neutralisation was missing in one newer CSV exporter. This is a regression of June finding M-05. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| M-14 | Deployment | Containers lacked privilege and resource restrictions, images were not digest-pinned, and builds carried no provenance. | 🔍 Fix in review · read-only root filesystems deferred | [#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197) |

### Low

| ID | Area | Finding | Status | PR |
|---|---|---|---|---|
| L-01 | Authorization | The role-mapping self-lockout guard was skipped for full administrators. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| L-02 | Information disclosure | Performance metrics exposed other users' request URLs. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| L-03 | Availability | Signing-key lookups had no request rate limit. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| L-04 | Vault | Encrypted secrets were not cryptographically bound to their record. | 🔍 Fix in review · ciphertext from before the upgrade remains transplantable | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| L-05 | Vault | There was no master-key rotation tool, and the documented workaround printed secrets. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| L-06 | Portable build | Job credentials were passed on the worker process command line. | 🔍 Fix in review | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| L-07 | Worker | A client secret temp file was not removed when a crawler run failed. | 🔍 Fix in review | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| L-08 | Worker | Credential state persisted between jobs in the worker process. | 🔍 Fix in review | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| L-09 | Worker | A dormant scheduler path evaluated command strings. This is a carry-over from June. | 🔍 Fix in review | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| L-10 | Worker | No test guarded against secrets being written to job transcripts. | 🔍 Fix in review | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| L-11 | Availability | Concurrent risk-scoring runs and LLM generation were not throttled. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| L-12 | Integrity | The update-intent record accepted an unvalidated version string. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| L-13 | Availability | File uploads had no per-configuration quota on a shared volume. The 1 GB per-file limit is intentional. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| L-14 | Query hygiene | Search inputs did not escape `LIKE` wildcards. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| L-15 | Robustness | Prototype property names in sort and lookup parameters caused server errors. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| L-16 | Availability | Unbounded extended-attribute key counts made column discovery expensive. | 🔍 Fix in review | [#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200) |
| L-17 | Web | The Content-Security-Policy allowed a Microsoft Graph origin that the browser never uses. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| L-18 | UI | Imported link attributes were labelled as Entra ID links regardless of host. | 🔍 Fix in review | [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) |
| L-19 | Azure / CI | Key Vault, Storage and App Service defaulted to public network access. One unused workflow was not SHA-pinned, and two workflows declared no token permissions. | 🟨 Partially addressed (in review) · Key Vault and Storage stay publicly reachable outside private-network mode | [#1194](https://github.com/Fortigi/IdentityAtlas/pull/1194), [#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197) |

### Informational

| ID | Note | Status | PR |
|---|---|---|---|
| I-01 | Dependency hygiene: a moderate advisory in a transitive dependency that is not reachable, a vestigial install hook, and an unused package. | 🔍 Fix in review | [#1194](https://github.com/Fortigi/IdentityAtlas/pull/1194) |
| I-02 | Build tooling leftovers, covered together with I-01. | 🔍 Fix in review | [#1194](https://github.com/Fortigi/IdentityAtlas/pull/1194) |
| I-03 | Crawler keys were held unhashed as in-memory cache keys. | 🔍 Fix in review | [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) |
| I-04 | Secrets were passed to containers as plain environment variables. | 🔍 Fix in review | [#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197) |
| I-05 | One connection-test handler returned internal error text. | 🔍 Fix in review | [#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198) |
| I-06 | API documentation is public. | 🟦 Accepted: API-surface disclosure only | — |
| I-07 | Some heavy analyst queries run to completion before their row cap applies. | 🔧 Planned: tracked with the performance backlog | [#788](https://github.com/Fortigi/IdentityAtlas/issues/788) |
| I-08 | Three recursive queries relied on a write-time cycle check alone. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| I-09 | The application connects to the database as the schema owner. | 🔧 Planned: least-privilege role split | — |
| I-10 | Usage text contained real-looking GUIDs. | 🔍 Fix in review | [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) |
| I-11 | Minor worker configuration inconsistencies. | 🔍 Fix in review · one sub-item did not reproduce | [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) |
| I-12 | The development Compose file runs with authentication off. | 🟦 By design: local development only | — |

---

## Remediation pull requests

| PR | Scope | Findings |
|---|---|---|
| [#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200) | Enforce the per-system boundary on crawler ingest | C-01, H-04, M-05, M-07, L-16 |
| [#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196) | Close vault read paths and harden crawler credential custody | H-01, H-02, M-02, M-06, M-10, L-04, L-05, I-03 |
| [#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198) | Close SSRF guard bypasses and validate worker-side URLs | H-03, M-02, M-03, M-12, I-05 |
| [#1193](https://github.com/Fortigi/IdentityAtlas/pull/1193) | Structural read-token guard, gate administrative reads, query hygiene | M-01, L-01, L-02, L-03, L-12, L-14, L-15, I-08, I-10 |
| [#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199) | Request-layer hardening, exporter and CSP fixes | H-07, M-04, M-09, M-13, L-11, L-13, L-17, L-18 |
| [#1194](https://github.com/Fortigi/IdentityAtlas/pull/1194) | Sandbox automated build agents, CI permissions, dependency tidy-up | H-05, L-19, I-01, I-02 |
| [#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197) | Azure credentials and networking, master key isolation, container hardening | H-06, M-08, M-14, L-19, I-04 |
| [#1195](https://github.com/Fortigi/IdentityAtlas/pull/1195) | Worker and crawler fail-safes and credential hygiene | M-11, L-06, L-07, L-08, L-09, L-10, I-11 |

### Upgrade notes for operators

Several fixes tighten defaults that existing installs may rely on. Check these when upgrading to the release that contains them.

- **On-premises or plain-HTTP connectors** (Omada, OData, midPoint, SCIM on a private address or `http://`) are refused until an administrator enables **Allow private network** and/or **Allow insecure HTTP** on that crawler. Affected jobs fail with an error that names the option. ([#1198](https://github.com/Fortigi/IdentityAtlas/pull/1198))
- **Installs with authentication off** that are reached by a dotted DNS name must add that name to `ALLOWED_HOSTS` or `PUBLIC_BASE_URL`. Access by `localhost`, an IP address, or a single-label host name is unaffected. ([#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199))
- **Behind a reverse proxy**, set `TRUST_PROXY_HOPS` to the number of proxies in front of the app. `BEHIND_TLS=true` now implies one hop. ([#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199))
- **Scripts that call "clean database"** must send the new confirmation body. ([#1199](https://github.com/Fortigi/IdentityAtlas/pull/1199))
- **Changing a connector's endpoint host** now requires re-entering its credential. ([#1196](https://github.com/Fortigi/IdentityAtlas/pull/1196))
- **Crawler keys restricted to specific systems** can only write inside those systems. Unrestricted keys and the built-in worker behave as before. ([#1200](https://github.com/Fortigi/IdentityAtlas/pull/1200))
- **Existing Azure deployments** keep their database password on upgrade. Redeploy once with `rotatePostgresPassword=true` to replace it with a random one. The database firewall is narrowed to the web app's outbound addresses; `postgresAllowAllAzureServices=true` restores the old rule. ([#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197))
- **Docker Compose installs** that download the new compose file move the vault master key to a web-only volume. Roll back with the matching compose file for that release. ([#1197](https://github.com/Fortigi/IdentityAtlas/pull/1197))

---

## Regression check against June 2026

| June item | September result |
|---|---|
| C-01 authorization fail-closed · H-01 token audience | Holds |
| H-02 vaulted credentials | Partially holds: some credential types were vaulted per job only (M-10), and indirect read paths were found (H-01, H-02, M-02) |
| H-03 / H-04 database exposure and default password (Compose) | Holds |
| H-05 Docker socket removed | Holds |
| H-06 SSRF in the scraper | Guard present but bypassable (H-03). Not applied on the worker side (M-03), to connection-test redirects (M-02), or to a plugin feed (M-12) |
| H-07 regular-expression denial of service | Holds: all user-supplied patterns use a linear-time engine |
| H-08 read-token administrative path guard | Bypassable through path casing (M-01) |
| H-09 CI hardening | Holds for pull-request workflows. A new exposure was found in the automated build agents (H-05) |
| M-05 spreadsheet formula injection | Regressed in one exporter (M-13) |
| M-04 role-mapping lockout guard | Ineffective for full administrators (L-01) |
| LLM hardening (timeouts, error bodies, redirects, untrusted-content fencing) | Holds |
| Workbook export base URL | Holds |
| Crawler protocol authorization (job claim, delta tokens) | Holds. Job progress was unscoped (M-05) |
| Transport to the database | `sslmode=require` with node-postgres already verifies the certificate and hostname |

---

## Strengths (confirmed)

- **No SQL injection.** Every dynamic-SQL site binds values. Identifiers come from fixed maps, the live schema, or strict allowlists.
- **Fail-closed authorization.** Pinned RS256 tokens with audience, issuer and tenant checks. Unknown roles resolve to no permissions.
- **Sound vault cryptography.** AES-256-GCM envelope encryption with a fresh nonce per encryption, verified authentication tags, and no plaintext fallback. Secrets are never returned by any endpoint.
- **Strong key handling.** Crawler keys are hashed with scrypt, salted, and compared in constant time. Read tokens are high-entropy, GET-only, and revoked automatically when idle.
- **No XSS sinks** in the UI, a restrictive Content-Security-Policy, and tokens held only in session storage and the Authorization header.
- **Hardened file uploads.** Sanitised names, extension allowlists, and no path traversal or download route for uploaded files.
- **No command execution from the API.** The worker builds no scripts from job data.
- **Disciplined CI.** Actions are SHA-pinned, no `pull_request_target`, untrusted event data reaches shells only through environment variables, and fork PRs receive no secrets.

---

*The full technical report, including reproduction detail, is classified **Confidential** and is available to customers and auditors on request.*

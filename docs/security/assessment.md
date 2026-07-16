# Security Assessment & Remediation

Identity Atlas underwent an independent **white-box security assessment and penetration test** by Fortigi in June 2026, commissioned for a regulated financial-services deployment. The review combined a full source-code audit with authenticated and black-box testing of a live deployment.

This page is a **public, sanitized summary**: it records what was assessed, the findings by severity and status, and the pull requests that remediated them. Step-by-step exploit detail, proof-of-concept payloads, attack chains, and live-environment specifics are deliberately omitted. The full technical report is **confidential** and available to customers and auditors on request.

!!! info "Why we publish this"
    We believe a governance product should be transparent about its own security. Every Critical and High finding has been remediated and merged; the remaining items are tracked openly below. Technical exploit detail for any finding that is not yet fully remediated is withheld.

---

## Scope

- **Node.js API** — authentication, authorization, all route handlers, the database access layer, secrets vault, ingest pipeline, and the LLM / risk-scoring subsystem.
- **React UI** — client-side injection sinks and data-export routines.
- **PowerShell worker & crawlers.**
- **Container & deployment artefacts** — Compose files, Dockerfiles, setup scripts, Azure IaC, and CI/CD workflows.
- **A live deployment** — unauthenticated network surface, transport security, and data-at-rest exposure.

**Methodology:** manual white-box code review across six specialist work-streams (authentication/authorization, SQL/data, secrets/crypto, the PowerShell worker, container/infrastructure, and web/SSRF/upload), cross-checked against live testing. Risk ratings reflect a regulated financial-services context (DORA, SOX ITGC, ISO 27001, NIST 800-53).

---

## Result at a glance

| Severity | Found | Remediated / accepted | Open |
|---|---|---|---|
| Critical | 2 | 2 | 0 |
| High | 9 | 9 | 0 |
| Medium | 12 | 6 | 6 |
| Low / Informational | 7 | — | 7 |

**All Critical and High findings are fixed and merged to `main`.** Remediation of the remaining Medium and Low items is in progress and tracked below.

The assessment also recorded a number of **existing strengths** that were explicitly preserved during remediation — see [Strengths](#strengths-confirmed).

---

## Findings & remediation

Status legend: ✅ **Fixed** (merged) · 🟦 **By design** (supported configuration, documented) · 🟨 **Partially addressed** · 🔧 **Remediation planned**.

### Critical

| ID | Finding | Status | PR / tracking |
|---|---|---|---|
| C-01 | Authorization fail-open: a token resolving to no permissions was granted full admin | ✅ Fixed | [#197](https://github.com/Fortigi/IdentityAtlas/pull/197) |
| C-02 | Self-hosted deployment can run with authentication disabled | 🟦 By design — no-auth is a supported option for trusted/local installs; behaviour and guidance documented | — |

### High

| ID | Finding | Status | PR / tracking |
|---|---|---|---|
| H-01 | Token-audience boundary: `id_token`s were accepted alongside access tokens | ✅ Fixed | [#198](https://github.com/Fortigi/IdentityAtlas/pull/198) |
| H-02 | Privileged credentials stored in plaintext instead of the encrypted vault | ✅ Fixed | [#201](https://github.com/Fortigi/IdentityAtlas/pull/201), [#202](https://github.com/Fortigi/IdentityAtlas/pull/202) |
| H-03 | Database reachable on the network by default | ✅ Fixed | [#199](https://github.com/Fortigi/IdentityAtlas/pull/199) |
| H-04 | Default database password in the shipped production Compose file | ✅ Fixed | [#199](https://github.com/Fortigi/IdentityAtlas/pull/199) |
| H-05 | Docker socket bind-mounted into the web container | ✅ Fixed | [#213](https://github.com/Fortigi/IdentityAtlas/pull/213) |
| H-06 | Server-Side Request Forgery (SSRF) in the URL scraper | ✅ Fixed | [#205](https://github.com/Fortigi/IdentityAtlas/pull/205) |
| H-07 | Regular-expression denial-of-service via generated patterns | ✅ Fixed | [#209](https://github.com/Fortigi/IdentityAtlas/pull/209) |
| H-08 | Read-token admin-path guard was ineffective | ✅ Fixed | [#204](https://github.com/Fortigi/IdentityAtlas/pull/204) |
| H-09 | CI/CD secret-exposure and untrusted-input hardening | ✅ Fixed | [#214](https://github.com/Fortigi/IdentityAtlas/pull/214) |

### Medium

| ID | Category | Status | PR / tracking |
|---|---|---|---|
| M-01 | Transport security — wire TLS / `BEHIND_TLS` end to end | 🟨 Partially addressed (env documented) | [#782](https://github.com/Fortigi/IdentityAtlas/issues/782) |
| M-02 | Authorization coverage on mutating endpoints | ✅ Fixed | [#424](https://github.com/Fortigi/IdentityAtlas/pull/424) |
| M-03 | Crawler ingest authorization scoping | ✅ Fixed | [#424](https://github.com/Fortigi/IdentityAtlas/pull/424) |
| M-04 | Role-permission editor: lockout guard, audit trail | 🟨 Partially addressed | [#194](https://github.com/Fortigi/IdentityAtlas/pull/194) · [#786](https://github.com/Fortigi/IdentityAtlas/issues/786) |
| M-05 | Spreadsheet formula injection in UI exporters | ✅ Fixed | [#215](https://github.com/Fortigi/IdentityAtlas/pull/215) |
| M-06 | Internal error detail returned to clients | ✅ Fixed | [#484](https://github.com/Fortigi/IdentityAtlas/pull/484), [#582](https://github.com/Fortigi/IdentityAtlas/pull/582) |
| M-07 | Vault master-key handling policy | 🔧 Planned | [#783](https://github.com/Fortigi/IdentityAtlas/issues/783) |
| M-08 | PowerShell worker hardening | 🔧 Planned | [#779](https://github.com/Fortigi/IdentityAtlas/issues/779) |
| M-09 | Workbook export base URL trust (token-handling) | ✅ Fixed | [#216](https://github.com/Fortigi/IdentityAtlas/pull/216) |
| M-10 | Rate limiting on expensive surfaces (auth-off installs) | 🔧 Planned | [#784](https://github.com/Fortigi/IdentityAtlas/issues/784) |
| M-11 | Container hardening & resource limits | 🔧 Planned | [#785](https://github.com/Fortigi/IdentityAtlas/issues/785) |
| M-12 | Azure IaC network/secret hardening | 🟨 Partially addressed — storage/LA keys no longer emitted as Bicep outputs (consumers call `listKeys()`); network hardening pending | [#475](https://github.com/Fortigi/IdentityAtlas/pull/475) · [#780](https://github.com/Fortigi/IdentityAtlas/issues/780) |

### Low / Informational

Seven Low/Informational items were recorded (information disclosure on public metadata endpoints, dependency hygiene, and minor non-security functional bugs). These are tracked in [#787](https://github.com/Fortigi/IdentityAtlas/issues/787) and scheduled alongside the remaining Medium items. Technical detail is withheld here pending remediation.

---

### Portable Windows launcher (post-assessment additions)

The portable launcher was not in scope for the original assessment (it was added afterwards). A follow-on review identified two issues mirroring findings from the Docker scope:

| ID | Finding | Status | PR / tracking |
|---|---|---|---|
| P-01 | API bound to `0.0.0.0` in portable mode — reachable from other machines on the network with no auth (portable variant of H-03 + C-02) | ✅ Fixed — portable now binds to `127.0.0.1` only | [#222](https://github.com/Fortigi/IdentityAtlas/pull/222) |
| P-02 | `node.exe` downloaded during build with no integrity check | ✅ Fixed — SHA-256 pinned in source and verified at build time | [#220](https://github.com/Fortigi/IdentityAtlas/pull/220) |

---

## Supporting work

Beyond the per-finding fixes, the remediation programme added preventative guardrails:

- **Permission model** — a documented, tested role/permission catalog with the granular-permission bug fixed and per-route gating, plus a CI gate that blocks merges lacking tests or documentation ([#194](https://github.com/Fortigi/IdentityAtlas/pull/194)).
- **Supply chain** — all GitHub Actions pinned to commit SHAs with Dependabot keeping them current ([#214](https://github.com/Fortigi/IdentityAtlas/pull/214)). CI installs every Node dependency through [**Socket Firewall**](https://github.com/SocketDev/sfw-free), which blocks known-malicious packages (typosquats, install-script malware, hijacked maintainer releases) before they reach the build — covering the supply-chain class that advisory-based scanning misses until a CVE is published. A machine-readable [SBOM](../reference/sbom.md) is regenerated on every dependency change.

---

## Strengths (confirmed)

The assessment confirmed a number of design strengths, which were preserved throughout remediation:

- **No SQL injection** — every dynamic-SQL site is parameterised, with identifiers gated by fixed lookup maps or strict allowlists.
- **Sound vault cryptography** — AES-256-GCM envelope encryption with per-row data keys and verified authentication tags.
- **Strong crawler-key handling** — scrypt with OWASP parameters, salted, constant-time comparison.
- **Disciplined JWT validation** — pinned RS256, with issuer and tenant checks.
- **CORS done correctly** — static allowlist, no origin reflection, closed-by-default in production.
- **No XSS sinks** in the UI, with a restrictive Content-Security-Policy.
- **Hardened CSV upload** — path-traversal blocked, type/size caps, sanitised filenames.
- **Well-hardened Azure deployment path** — HTTPS-only, TLS 1.2, Key Vault via managed identity, authentication on by default.

---

## Remediation roadmap

| Priority | Focus | Status |
|---|---|---|
| **P0** | Authorization fail-closed, token audience, database exposure, vaulted credentials | ✅ Complete |
| **P1** | Auth-on guidance, mandatory DB password, Docker socket removal, read-token fix, transport | ✅ Complete (transport guidance documented) |
| **P2** | SSRF & ReDoS, CI hardening, authorization gates, crawler scoping, key-management policy | 🟨 In progress |
| **P3** | Remaining Medium & Low items | 🔧 Scheduled |

A follow-up re-test is recommended once the remaining Medium items are remediated.

---

*The full technical report is classified **Confidential** and is available to customers and auditors on request. No changes were made to any repository or deployment during the assessment itself — it was a read-only inspection.*

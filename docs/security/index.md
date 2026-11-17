---
type: reference
---

# Security testing programme

This page describes how Identity Atlas is tested for security: the standards we test against, the automated scans that run on every change, the security reviews and penetration tests we have done, what they found, and how the findings were fixed. It is written so that a customer, auditor or procurement team can point to one place for all of it.

Each review has its own page with every finding, its severity and the pull request that fixed it. Those pages are linked under [Assessment history](#assessment-history).

---

## Standards we test against

| Standard | How we use it |
|---|---|
| **NCSC ICT-beveiligingsrichtlijnen voor webapplicaties** (Dutch National Cyber Security Centre guidelines for web applications) | Design and review baseline for the web application, its API and its deployment: input handling, authentication and session handling, access control, configuration, logging and the hosting platform. |
| **OWASP Top 10 (2025)** | Every security review covers all ten categories. See [OWASP Top 10 coverage](#owasp-top-10-coverage). |
| **OWASP API Security Top 10 (2023)** | Applied to the HTTP API, which is how the UI, crawlers, the MCP server and integrations reach the data. |
| **OWASP ASVS 5.0** (Application Security Verification Standard) | The checklist that structures our code reviews, in particular the chapters on access control, authentication, validation, cryptography, data protection and configuration. |
| **OWASP Top 10 for LLM Applications (2025)** | Applied to the optional AI features: the LLM subsystem, risk scoring and the MCP server. |
| **CWE Top 25** | Used by the automated static analysis (CodeQL) and when rating findings. |
| **CIS Docker Benchmark** | Baseline for the container images and the Compose files: non-root users, dropped capabilities, no privilege escalation, resource limits. |

Severity ratings follow the usual Critical / High / Medium / Low / Informational scale. A finding is rated for a deployment with authentication enabled, holding the authorization data of a regulated organisation.

---

## How we test

Security testing happens at three levels: automated checks on every change, recurring scans of what we have published, and full security reviews.

### On every pull request

No change reaches `main` without passing these checks.

| Check | What it finds | Blocks the change when |
|---|---|---|
| **CodeQL** static analysis (JavaScript) | Injection, path traversal, unsafe deserialisation, server-side request forgery and the other CWE classes CodeQL models | A new alert of High severity or above is raised (enforced by the `main` branch rules) |
| **npm audit** (API and UI) | Dependencies with a published vulnerability | A dependency has a High or Critical advisory |
| **Socket Firewall** | Malicious packages: typosquats, install-script malware, hijacked releases that have no advisory yet | A malicious package would be installed |
| **ESLint with security rules** (API) | Unsafe patterns such as non-literal regular expressions, child processes and filesystem paths built from input | A rule fails |
| **PSScriptAnalyzer** | Unsafe PowerShell in the worker and crawlers | A finding that is not in the recorded baseline appears. The baseline can only shrink |
| **Authorization regression suite** | Callers reaching data outside their scope, through the REST API or the MCP server | Any scope leak |
| **Unit, contract and integration tests** | Regressions in the security controls themselves: fail-closed authorization, token validation, the SSRF guard, export escaping and others | Any test fails |

### Recurring scans

| Scan | Frequency | What it covers |
|---|---|---|
| **Container image CVE scan** (Grype) | When an image is published, and weekly on the `latest` and `edge` images | The operating system packages and libraries in all three images. A Critical with a fix available blocks publishing. Every finding is recorded in the repository's code-scanning alerts. |
| **CodeQL** | Weekly on `main` | The whole code base, so a newly added CodeQL rule finds issues in code that has not changed |
| **Authorization regression suite** | On every merge to `main`, and weekly | The merged result, not only each change on its own |
| **Dependabot** | Weekly on `main`, daily on the current release line | Dependency updates, including security updates |
| **Software bill of materials** | On every dependency change | The published [SBOM](../reference/sbom.md), so you can check our components against your own vulnerability feeds |

Taken together, the code and the published images are scanned for known vulnerabilities at least weekly and on every change, which is more often than the quarterly scan most security requirements ask for.

### Security reviews and penetration tests

A security review is a white-box review of the whole product combined with testing of a running deployment. It covers the Node.js API, the React UI, the PowerShell worker and crawlers, the container images and Compose files, the Azure templates, and the CI/CD pipeline that builds and publishes the product.

- **Method.** Each review splits the product into parallel review streams, typically authentication and authorization, data handling and SQL, secrets and cryptography, file handling and server-side request forgery, the worker and crawlers, client-side security, and infrastructure and supply chain. Each stream follows every untrusted value from where it enters to where it is used. Critical and High findings are verified a second time against the source, and where behaviour depends on the runtime, reproduced against a running deployment.
- **Who.** The reviews to date were carried out by Fortigi, the supplier of Identity Atlas, using AI review agents directed and checked by a Fortigi engineer. They are not independent third-party penetration tests. See [Independent penetration tests](#independent-penetration-tests).
- **Frequency.** At least once a year, and again when significant new functionality is introduced. Three reviews were completed in 2026.

### Monthly automated review

On top of the full reviews, an automated security review and penetration test runs every month, and on demand before a release. An AI reviewer reads the whole code base at the current `main` and tests a freshly built stack with demo data. The checklist it works through is published with the code ([`.github/security-review/prompt.md`](https://github.com/Fortigi/IdentityAtlas/blob/main/.github/security-review/prompt.md)): the OWASP Top 10, OWASP API Security Top 10, OWASP ASVS 5.0, the NCSC web application guidelines, the OWASP Top 10 for LLM Applications, the CWE Top 25, the CIS Docker Benchmark and the OWASP Top 10 CI/CD Security Risks. An OWASP ZAP scan of every documented API endpoint and a dependency audit feed into it.

- **What happens to the findings.** Medium and higher findings are filed as private security advisories, with a public issue that only says a finding of that severity exists. Low and Informational findings are filed as public bug reports and, once a maintainer accepts one, fixed through the same automated bug pipeline as any other bug. Medium and higher findings are fixed privately, because that pipeline discusses a bug in public. All of them follow the rules under [How findings are handled](#how-findings-are-handled).
- **What is published.** Each review gets a public summary page, listed under [Monthly reviews](#monthly-reviews). A maintainer checks it before it is published.
- **How it is isolated.** The reviewer runs in a job that has read-only access to the repository and no credentials that can change anything. It tests only the stack started inside that job. Its findings are encrypted before they leave the job, and a separate job without the AI reviewer files them.

The monthly review is a recurring check, not a replacement for the full reviews or for an independent penetration test.

---

## How findings are handled

- **Critical and High** findings are fixed before the next release. When a finding cannot be fixed in code, for example because it depends on how a customer deploys the product, it gets a documented mitigation and the deployment guidance is changed.
- **Medium and higher** findings are either fixed or explained before a release that contains them goes out. An explanation states why the finding is accepted or by design and what limits the risk. The explanation is recorded in the status column of the review page.
- **Low and Informational** findings are tracked as GitHub issues and fixed as part of normal maintenance.
- Every fix is made on `main` first and goes out in the next patch release of the current release line. See [Supported versions](https://github.com/Fortigi/IdentityAtlas/blob/main/SECURITY.md#supported-versions).
- Fixes for findings that were exploitable come with a regression test, so a later change cannot quietly undo them.
- Exploit detail is not published. The public pages list each finding, its severity, its status and the pull request that fixed it. The full technical report of each review is confidential and available to customers and auditors on request.

---

## Assessment history

| Date | Type | Version reviewed | Findings | Result | Public summary |
|---|---|---|---|---|---|
| June 2026 | White-box review and test of a live deployment | 5.x, June 2026 | 2 Critical, 9 High, 12 Medium, 7 Low / Informational | All Critical and High fixed, or by design and documented | [Security assessment, June 2026](assessment.md) |
| June 2026 | Maintenance audit (security, quality, CI) | `main` @ `5e88565` | Security tier findings, see page | Security tier closed | [Maintenance audit, June 2026](maintenance-audit-2026-06.md) |
| September 2026 | Full white-box re-test | 5.671, `b9313bb5b` | 1 Critical, 7 High, 14 Medium, 19 Low, 12 Informational | All Critical, High and Medium fixed | [Security assessment, September 2026](assessment-2026-09.md) |
| November 2026 | Full white-box review, a live deployment and its Entra ID tenant, and the CI/CD pipeline | `main`, November 2026 | 108 findings | Critical and High fixes merged to `main` | Published once the fixes are in a release |

### Monthly reviews

The [monthly automated review](#monthly-automated-review) adds a row here each month, newest first.

<!-- security-review-rows -->
| Month | Type | Version reviewed | Findings | Result | Public summary |
|---|---|---|---|---|---|

---

## OWASP Top 10 coverage

What each category covers in Identity Atlas, how it is tested and what the reviews found.

| OWASP Top 10 (2025) | Where it applies in Identity Atlas | How it is tested | Review results |
|---|---|---|---|
| **A01 Broken Access Control** | Permission checks on every API route, context-owner scoping, crawler credentials scoped to one connected system, MCP scoping | Authorization regression suite on every pull request; every review | Fail-open authorization fixed in June (C-01). A missing per-system boundary on crawler ingest fixed in September |
| **A02 Security Misconfiguration** | Compose and Azure defaults, security headers, published ports, authentication off by default for local installs | Image scans; Compose and Azure template review | Database exposed on the network and a default password fixed in June (H-03, H-04) |
| **A03 Software Supply Chain Failures** | npm and PowerShell dependencies, container base images, GitHub Actions, release automation | npm audit, Socket Firewall, Dependabot, Grype, actions pinned to commit hashes, SBOM | CI/CD hardening in June (H-09) and September; release keys restricted to a protected environment in November |
| **A04 Cryptographic Failures** | The credential vault, crawler keys, TLS to the database and in front of the application | Code review of the vault and key handling | Vault envelope encryption confirmed sound in every review |
| **A05 Injection** | Dynamic SQL, spreadsheet exports, PowerShell, HTML rendering | CodeQL, PSScriptAnalyzer, export-escaping tests, review of every dynamic-SQL site | No SQL injection found in any review. Spreadsheet formula injection fixed in June (M-05) |
| **A06 Insecure Design** | Trust boundaries between roles, between crawlers, and between the application and the systems it reads | Design review in every assessment | Several boundary findings fixed in September |
| **A07 Authentication Failures** | Entra ID sign-in, token validation, crawler keys, MCP tokens | Token validation tests; review | Token audience fixed in June (H-01) |
| **A08 Software or Data Integrity Failures** | Auto-update, plugin feeds, portable build downloads, ingest data integrity | Review; integrity checks on downloads | Unverified portable download fixed (P-02) |
| **A09 Security Logging and Alerting Failures** | Audit trail of permission changes and crawler activity | Review | Permission-change audit trail added (M-04) |
| **A10 Mishandling of Exceptional Conditions** | Error responses, fail-closed behaviour, resource exhaustion | Tests for error paths and limits; review | Internal error detail removed from responses (M-06). Pattern-based denial of service fixed (H-07) |

Server-side request forgery, a separate category in the 2021 edition, is covered under A01 and A05 and has its own guard and tests. It was fixed in June (H-06) and the guard was strengthened in September.

---

## Independent penetration tests

The reviews above are done by Fortigi, the supplier. Some organisations need a penetration test by an independent party, for example one holding the CCV Pentesten keurmerk.

- **Commission one through us.** Fortigi can arrange an independent penetration test of Identity Atlas in your environment. Scope, timing and cost are agreed per engagement. For customers with a support agreement this can be part of that agreement.
- **Or test it yourself.** Identity Atlas is open source and you are welcome to test it, or have it tested, on your own installation. Please do not test `identityatlas.io` or a hosted demo without asking us first.
- **Please share what you find.** Report findings through [private vulnerability reporting](https://github.com/Fortigi/IdentityAtlas/security/advisories/new), as described in [SECURITY.md](https://github.com/Fortigi/IdentityAtlas/blob/main/SECURITY.md). We fix them on `main`, credit you in the advisory unless you prefer otherwise, and add the test to this page. Every report makes the product safer for everyone who runs it.

---

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's [private vulnerability reporting](https://github.com/Fortigi/IdentityAtlas/security/advisories/new) or write to [support@identityatlas.io](mailto:support@identityatlas.io) with "Security" in the subject. The full policy, including the supported versions and what to expect, is in [SECURITY.md](https://github.com/Fortigi/IdentityAtlas/blob/main/SECURITY.md).

For how to deploy Identity Atlas securely, see [Setting up authentication](../admin/authentication.md) and [Secrets and the master key](../architecture/secrets-and-master-key.md).

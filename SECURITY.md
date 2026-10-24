# Security Policy

Identity Atlas stores authorization data and the credentials it uses to read your
identity systems, so we want to hear about security problems before anyone else does.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security
vulnerability.** Public issues are visible to everyone and are processed by an
automated triage pipeline.

1. **Preferred:** use GitHub's private vulnerability reporting. Open the repository's
   **Security** tab and choose **Report a vulnerability**, or go straight to
   <https://github.com/Fortigi/IdentityAtlas/security/advisories/new>.
   The report is visible only to you and the maintainers.
2. **Fallback:** if you cannot use GitHub, or the **Report a vulnerability** button is
   not offered, write to
   [support@identityatlas.io](mailto:support@identityatlas.io) with "Security" in the
   subject. This is a general support mailbox, so say only that you have a security
   report to make; we will agree with you how to send the details.

A useful report contains:

- the version (shown on the dashboard's *Version* card) and the image channel
  (`latest`, `edge` or a pinned version);
- how it is deployed (Docker Compose, Azure, or the portable Windows launcher) and
  whether authentication is enabled;
- the steps to reproduce, or a proof of concept, and what an attacker gains;
- any fix or mitigation you already have in mind.

## What to expect

Identity Atlas is maintained by a small team, and security reports are handled on a
best-effort basis with no contractual response time. We aim to acknowledge a report
within a few business days, to tell you whether we can reproduce it, and to keep you
informed until a fix is released. We ask that you give us reasonable time to release
that fix before you publish details. We credit reporters in the advisory unless you
prefer otherwise. There is no paid bug bounty.

## Supported versions

| Version | Docker tag | Security fixes |
|---|---|---|
| Current release line (5.9.x today, branch `release/5.9`) | `:latest`, `:5.9.x.0` | Yes. Shipped as a new release from that line. |
| `main` development builds | `:edge` | Fixes are merged here first. This is a development build and may be unstable. |
| Pre-releases | `:beta` | No |
| Older release lines | pinned older tags | No. Upgrade to the current release. |

A security fix is made on `main` first and then applied to the current release line,
which ships it as a patch release, so a fix can be in `:edge` before it is in `:latest`. Updates to production dependencies are
checked for daily on the release branch and ship with its next patch release
(see [Maintaining a release line](docs/process/maintaining-a-release-line.md)).
To check whether the version you run contains a given fix, compare it with the
[release notes](https://github.com/Fortigi/IdentityAtlas/releases).

## Published security assessments

We publish sanitised summaries of our security reviews, with every finding, its
status and the pull request that fixed it:

- [Security assessment, June 2026](https://fortigi.github.io/IdentityAtlas/edge/security/assessment/)
  ([source](docs/security/assessment.md))
- [Security assessment, September 2026](https://fortigi.github.io/IdentityAtlas/edge/security/assessment-2026-09/)
  ([source](docs/security/assessment-2026-09.md))
- [Maintenance audit, June 2026](https://fortigi.github.io/IdentityAtlas/edge/security/maintenance-audit-2026-06/)
  ([source](docs/security/maintenance-audit-2026-06.md))

## Deployment notes for security teams

- **Authentication is off by default in the Docker Compose files.** `AUTH_ENABLED`
  defaults to `false`, and the web port (3001) is published on the host. That suits a
  laptop or an isolated evaluation only. For any shared or networked deployment, enable
  Entra ID sign-in first: [Setting up authentication](docs/admin/authentication.md).
  The Azure deployment starts with authentication on.
- **Set `POSTGRES_PASSWORD`.** `docker-compose.prod.yml` refuses to start without it.
  PostgreSQL is bound to `127.0.0.1` unless you change `POSTGRES_BIND_HOST`.
- **Look after the vault master key.** Stored credentials are encrypted with a master
  key that is generated on first start into the `web_keys` volume. Back that volume up,
  or set `IDENTITY_ATLAS_MASTER_KEY` yourself and keep it with your other root secrets.
- **Terminate TLS in front of the application.** The container serves plain HTTP. Put a
  reverse proxy or load balancer in front and set `BEHIND_TLS=true`
  (see the [environment variables](docs/api/index.md)).

# Proof Points

The credibility list — facts that back up the claims. Use these as slide footers,
"why trust this" sections, and reassurance for technical buyers.

## Open and transparent

- **MIT-licensed open source.** Inspect it, fork it, run it — no black box.
- Public source, issue tracker, and releases on
  [GitHub](https://github.com/Fortigi/IdentityAtlas).
- A published **Software Bill of Materials (SBOM)** — full component inventory.
- Build pipeline guarded against supply-chain attacks (malicious-package blocking).

## Private by design

- **Self-hosted.** Your data stays in your environment.
- The risk-scoring LLM sees **public organizational context only** — never your
  identity data.
- Secrets (LLM keys, crawler credentials) stored with **AES-256-GCM
  envelope encryption** and a master key you control.
- **Auth is on from the first Azure deploy** — there is no usable open,
  unauthenticated state to leak into.

## Easy to run

- **Docker stack** — `docker compose up` and open `http://localhost:3001`.
- **One-click Deploy to Azure** into your own subscription, PaaS-only, from ~€45/mo
  for a proof-of-concept.
- **Portable Windows launcher** for locked-down corporate laptops — no install, no
  admin rights, no Docker required.
- **One-click demo data** — explore the full UI with zero setup or tenant.

## Broad and proven coverage

- Deep native sync for **Entra ID**: users, groups, PIM eligibility, app roles,
  directory roles, access packages, access reviews.
- CSV / Ingest-API path for **Omada, SailPoint, SAP/Pathlock, SharePoint, Azure
  RBAC, DevOps** — and anything else that exports data.
- Built on **PostgreSQL 16** with a clean, documented, versioned schema.

## Pedigree

- Built by **Fortigi**, a Dutch identity & access management consultancy that does
  this work for enterprise customers across Europe.
- Grew out of a real internal tool used on real engagements — not a greenfield
  guess at what practitioners need. (See [History](../history.md) and
  [Founder Story](founder-story.md).)

*Sources: [README](https://github.com/Fortigi/IdentityAtlas), [docs home](../index.md),
[History](../history.md), [About](../about.md).*

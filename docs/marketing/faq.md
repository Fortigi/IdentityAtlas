# FAQ

Public-safe answers to the questions that come up most. Reuse verbatim.

### What is Identity Atlas?

Universal authorization intelligence: it syncs permission data from any identity
system into one PostgreSQL model with full audit history, then surfaces it through
a role-mining UI and LLM-assisted identity risk scoring. Open source, self-hosted.

### Is it Microsoft-only?

No. Entra ID is the deepest, native integration, but any system that can export a
CSV — Omada, SailPoint, SAP/Pathlock, SharePoint, Azure RBAC, DevOps, or a
homegrown app — lands in the same unified model. There's also an Ingest API for
building custom crawlers in any language.

### Does my identity data go to an LLM or any external service?

No. Identity Atlas is self-hosted and your identity data stays in your environment.
The risk-scoring LLM only ever sees *public* organizational context (e.g. industry
information from your public domain) to tune the scoring — never your users,
groups, or assignments.

### Which LLM providers are supported?

Anthropic Claude, OpenAI, and Azure OpenAI. Keys are stored encrypted
(AES-256-GCM) with a master key you control.

### How do I try it?

Run the Docker stack (`docker compose -f docker-compose.prod.yml up -d`), open
`http://localhost:3001`, and click **Load Demo Data** — no tenant needed. Or use the
one-click **Deploy to Azure** button to put it in your own subscription. There's
also a portable Windows launcher for locked-down laptops (no install, no admin).

### What does it cost?

The software is open source under the MIT license — free. If you host it in Azure,
you pay only for the Azure resources; the deploy template starts around €45/month
for a proof-of-concept and scales from there.

### Is it production-ready?

It runs as a Docker stack with PostgreSQL 16, authenticated from the first Azure
deploy, with encrypted secrets and a documented schema. Some risk-scoring layers
(structural hygiene, cross-entity propagation) are still being completed — see
[History](../history.md) for exactly what ships today versus what's planned.

### Who builds it?

[Fortigi](https://www.fortigi.nl), a Dutch identity & access management
consultancy. Identity Atlas started as an internal tool used on real engagements
and grew into a product. See [About](../about.md) and [History](../history.md).

### Where's the source / how do I contribute?

[github.com/Fortigi/IdentityAtlas](https://github.com/Fortigi/IdentityAtlas) —
issues and pull requests welcome.

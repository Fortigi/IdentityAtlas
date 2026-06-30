# Product Brief

> **One-liner:** Identity Atlas is universal authorization intelligence — sync,
> analyze, and govern permissions from any identity system, in one place.

## The problem

In most organizations, "who can actually do what?" is a question nobody can
answer quickly. Authorization data is scattered across Active Directory, Entra ID,
SAP, SharePoint, Azure, DevOps, and a dozen SaaS platforms — each with its own
data model, its own history (or none), and no shared view. Access reviews become
spreadsheet archaeology. Risky, over-privileged, and never-reviewed identities
hide in the gaps between systems.

## What it is

Identity Atlas pulls authorization data from every connected system into a single
PostgreSQL data model with full, row-level audit history. On top of that model it
gives you:

- A **role-mining web UI** for analysts to review access visually
- **LLM-assisted identity risk scoring** that tailors itself to your organization
- **Multi-system governance** — business roles, certifications, and policies from
  any IGA platform in the same tables as raw permissions

It runs as a Docker stack (or one-click into Azure), and everything — connecting
systems, scoring, reviewing — is configurable from the browser. No identity data
is ever sent to an external service.

## Who it's for

- **IAM / IGA architects and engineers** consolidating authorization data across
  Microsoft and non-Microsoft systems.
- **Security and GRC teams** who need to find over-privileged and unreviewed
  access and put a defensible risk score on it.
- **Access-review owners** running certifications who are tired of stitching
  exports together by hand.

## Why it's different

- **Universal, not Microsoft-only.** Entra ID is the deepest integration, but any
  system that can export a CSV — Omada, SailPoint, SAP/Pathlock, SharePoint,
  Azure RBAC, DevOps — lands in the same unified model.
- **Local-first and private.** Self-hosted; the risk-scoring LLM only ever sees
  *public* organizational context, never your identity data.
- **Open source (MIT)** and deployable in minutes — demo data is one click away.

## The 30-second version

> Permissions are scattered across every system you own, and no one can see who
> really has access to what. Identity Atlas syncs them all into one model with
> full history, shows analysts a visual access matrix, and scores identity risk
> with an LLM — without your sensitive data ever leaving your environment. Open
> source, runs in Docker, one-click into Azure.

*Sources: [README](https://github.com/Fortigi/IdentityAtlas), [docs home](../index.md),
[supported systems](../index.md#supported-source-systems).*

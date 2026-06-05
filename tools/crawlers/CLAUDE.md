# Crawler Development — Quick Reference

Full authoring guide: [`docs/sync/custom-crawlers.md`](../../docs/sync/custom-crawlers.md)
Architecture internals: [`docs/architecture/crawler-architecture.md`](../../docs/architecture/crawler-architecture.md)

## Adding a Crawler

Drop a folder into `tools/crawlers/<type>/` with `crawler.json` + entry point. No changes to `Invoke-CrawlerJob.ps1`, `IdentityAtlas.psm1`, or `pr.yml` needed. Restart the worker to pick it up.

## Rules

- Every `.ps1` file must have `[CmdletBinding()]` — the Pester quality gate enforces this.
- Entry point filenames must be `Start-<Something>.ps1` — the dependency loader excludes `Start-*` when dot-sourcing library files.
- Never run the `odata` type as a job — its entry point throws by design. Use it only as a `dependsOn` dependency.
- `_syncMode` is the only reserved config key injected by the dispatcher. Don't use keys starting with `_` for your own config.

## Key Files

| File | Role |
|---|---|
| `setup/IdentityAtlas.psm1` | Defines `Get-CrawlerRegistry` — the auto-discovery function |
| `setup/docker/Invoke-CrawlerJob.ps1` | Manifest-driven dispatcher; reads registry, resolves deps via DFS, runs entry point |
| `app/api/src/routes/jobs.js` | Node.js side; reads same manifests for `VALID_JOB_TYPES` and `configSchema` validation |

## Tests

- `test/unit/Dispatcher.Tests.ps1` — registry building, DFS ordering, cycle detection, live manifest validation
- `test/unit/Omada.Tests.ps1` — OData auth, `Get-OmadaRef*` helpers, file structure assertions

# Portable build — SQL Database crawler

`IdentityAtlas-portable.zip` in this folder is a prebuilt Windows portable
launcher, produced from the `feature/sql-crawler` branch (latest `main` plus the
SQL Database crawler). It exists so the build can be downloaded directly onto a
machine that cannot build it — nothing else on this branch differs from
`feature/sql-crawler`.

**This branch is for distribution only. Do not merge it.** The zip is a build
artefact; the source it was built from is on `feature/sql-crawler`.

## Verify the download

```powershell
(Get-FileHash .\IdentityAtlas-portable.zip -Algorithm SHA256).Hash.ToLower()
# compare with IdentityAtlas-portable.zip.sha256
```

## Run it

> **Unblock the files first.** Windows marks everything extracted from a downloaded
> zip as coming from the internet, and PowerShell refuses to run those scripts in the
> background. The app would start but every crawler run would fail with
> `AuthorizationManager check failed` / `pwsh.exe exited with code 1`. Setting the
> execution policy to Unrestricted does **not** fix it — that setting only prompts, and a
> background crawler cannot answer a prompt. Run `Unblock-File` once after extracting
> (shown below). Builds from 2026-09-25 onward also pass `-ExecutionPolicy Bypass` when
> starting a crawler, so this is belt and braces.

Requires **Windows x64** and **PowerShell 7** (`pwsh.exe`). No Docker, no WSL,
no administrator rights.

```powershell
Expand-Archive .\IdentityAtlas-portable.zip -DestinationPath .\IdentityAtlas
cd .\IdentityAtlas
Get-ChildItem -Recurse . | Unblock-File      # clears the internet mark
pwsh -ExecutionPolicy Bypass -File .\Start-IdentityAtlas.ps1
```

The app opens on <http://localhost:3001>. Data lives in
`%APPDATA%\IdentityAtlas\`; delete that folder to reset, copy it to back up.

## Using the SQL crawler

**Admin → Crawlers → Add Crawler → SQL Database.** Four steps: connection,
credentials (SQL Server authentication), queries, schedule. On the Queries step,
**Load example → SailPoint IdentityIQ** fills in a working set of statements you
can adapt.

If your own statements return column names that differ from the ones Identity
Atlas expects, use each query's **Column mapping** rather than rewriting the SQL.

Full reference: `docs/sync/sql.md` on `feature/sql-crawler`.

## What is in this build

- Latest `main` (`6dc795c49`) plus the SQL Database crawler
- Migration 072, which records when each row was last synced so a full sync can
  clean up rows that vanished from the source
- The crawler needs `pwsh.exe` on `PATH` to run, like every other crawler here

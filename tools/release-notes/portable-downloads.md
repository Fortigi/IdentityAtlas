
## Portable Windows downloads

Two portable ZIPs for running Identity Atlas on Windows without Docker. Unzip and run `Start-IdentityAtlas.ps1` with PowerShell 7.

| File | Pick it when |
|---|---|
| `IdentityAtlas-portable.zip` | **The default.** Runs on PGlite, a database inside the app. `node.exe`, the only executable in the zip, is code-signed, so it runs on locked-down laptops whose application control trusts signed publishers. |
| `IdentityAtlas-portable-postgres.zip` | **Large data sets** that outgrow PGlite. Embeds a real PostgreSQL 16 server; start it with `.\Start-IdentityAtlas.ps1 -Database Postgres`. The PostgreSQL binaries are **not code-signed** (application control needs hash or path rules for them) and need the Microsoft Visual C++ runtime (`VCRUNTIME140.dll`). |

See [Portable Windows Launcher](https://github.com/Fortigi/IdentityAtlas/blob/main/docs/architecture/desktop-portable.md) for details.

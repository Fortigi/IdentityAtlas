@echo off
REM Wrapper script for the Windows Task Scheduler.
REM Calls PowerShell 7 to run the nightly test suite.
REM
REM We skip the npm-based phases (backend unit, frontend unit, Playwright E2E)
REM because the host machine doesn't have node/npm installed — only Docker.
REM Those tests need to run inside containers if we ever want them on the host.
"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -NonInteractive -File "C:\source\FortigiGraph\test\nightly\Run-NightlyLocal.ps1" -SkipE2E -SkipBackendUnit -SkipFrontendUnit
exit /b %ERRORLEVEL%

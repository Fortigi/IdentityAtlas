# TODOS

## Crawler Integration Test Framework

- **Token refresh test** (LOW): Omada OAuth2 tokens expire during long crawls. The mock
  doesn't test the refresh path. Requires a stateful mock that returns 401 after token TTL.

## CI Test Execution

- **Parallel execution**: Currently tests at same dependency level run in parallel via
  `Start-Job`. If tests interfere via database state (same system names), add test isolation
  (unique config names per test run, or database namespace per test).

## Completed

- **DB assertion isolation** (MEDIUM): `Test-OmadaCrawler.ps1` now scopes system/principal/resource
  assertions to the system created by the current run (identified by mock server port in displayName).
  **Completed:** feature/crawler-test-db-isolation

- **DRY: `Report-Result` helper** (LOW): Extracted to `tools/crawlers/shared/Test-Helpers.ps1`
  and dot-sourced from both test files.
  **Completed:** feature/crawler-test-quality

- **Crawler config cleanup** (LOW): `Test-OmadaCrawler.ps1` now deletes both crawler configs
  in the outer `finally` block.
  **Completed:** feature/crawler-test-quality

- **Shallow clone warning** (LOW): Already resolved — partial failure test uses a fresh
  `$pfConfig` literal, not a clone of `$config`.
  **Completed:** N/A (pre-existing)

- **Magic numbers in mock server** (LOW): `Start-MockODataServer.ps1` startup poll constants
  replaced with named variables (`$startupPollMs`, `$startupMaxPolls`).
  **Completed:** feature/crawler-test-quality

- **Missing edge cases** (LOW): Added empty entity-set test to `Test-ODataCrawler.ps1`
  (`{"value":[]}` → empty array, not null or throw).
  **Completed:** feature/crawler-test-quality

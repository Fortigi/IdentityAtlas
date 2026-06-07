# TODOS

## Crawler Integration Test Framework

- **Live-vs-mock drift detection** (HIGH): The OData and Omada mock servers are validated
  against specific API versions. Add a nightly job that calls the live API (when secrets
  are available) and compares entity shapes against the mock's expected structure.
  Track: which Omada OData API version was used when mocks were created (v14/cloud 2026-06-06).

- **Token refresh test** (LOW): Omada OAuth2 tokens expire during long crawls. The mock
  doesn't test the refresh path. Requires a stateful mock that returns 401 after token TTL.

## CI Test Execution

- **Parallel execution**: Currently tests at same dependency level run in parallel via
  `Start-Job`. If tests interfere via database state (same system names), add test isolation
  (unique config names per test run, or database namespace per test).

- **DB assertion isolation** (MEDIUM): `Test-OmadaCrawler.ps1` asserts `userCount >= 1`,
  `resourceCount >= 1`, etc. against the full database. If prior CI steps loaded data, these
  pass even if the Omada crawler ingested nothing. Filter by the system created during
  this test run (capture `$systemId` from the registration response and pass it as a query
  filter to each assertion).

## Test Code Quality

- **Crawler config cleanup** (LOW): `Test-OmadaCrawler.ps1` registers crawler configs but
  never deletes them. Add a `finally` block that calls `DELETE /admin/crawler-configs/$configId`
  and `DELETE /admin/crawler-configs/$($cfgResult2.id)`, wrapped in `try/catch` so cleanup
  failures are non-fatal.

- **DRY: `Report-Result` helper** (LOW): The `Report-Result` function is copied verbatim into
  both `Test-ODataCrawler.ps1` and `Test-OmadaCrawler.ps1`. Extract to
  `tools/crawlers/shared/Test-Helpers.ps1` and dot-source from both, same pattern as the
  mock server import.

- **Magic numbers in mock server** (LOW): `Start-MockODataServer.ps1` has bare literals
  `WaitOne(2000)` and `Start-Sleep -Milliseconds 200` (×20 = 4s startup timeout). Replace
  with named variables so the intent is self-documenting.

- **Missing edge cases** (LOW): No test for an empty entity-set response (`{"value":[]}`)
  in `Test-ODataCrawler.ps1`. Add a test case with `-EntitySets @{ Empty = @() }` and assert
  `Invoke-ODataGetRequest` returns an empty array rather than null or throwing.

- **Shallow clone warning** (LOW): `$config.Clone()` in `Test-OmadaCrawler.ps1` (partial
  failure test) is a shallow copy. Currently safe because only `baseUrl` is mutated, but
  any future mutation of nested keys would silently corrupt the original config. Switch to
  a deep copy: `$config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable`.

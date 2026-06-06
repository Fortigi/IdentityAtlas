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

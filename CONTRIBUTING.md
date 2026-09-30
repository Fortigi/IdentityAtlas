# Contributing to Identity Atlas

Identity Atlas is open source under the [MIT License](LICENSE), and contributions from
outside the core team are welcome. This page covers what you need to make a change and
get it merged. It links to the detailed guides instead of repeating them.

**Found a security vulnerability?** Do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Ways to contribute

- **Report a bug or propose a feature.** Use the
  [issue forms](https://github.com/Fortigi/IdentityAtlas/issues/new/choose). The guide
  [Report a bug or request a feature](docs/contributing/report-an-issue.md) explains
  what helps us most.
- **Fix something.** Open a pull request. For a small fix you do not need an issue first.
- **Improve the documentation.** Every page on the
  [documentation site](https://fortigi.github.io/IdentityAtlas) has an edit button that
  opens a pull request from your browser. See
  [Contribute a change](docs/contributing/contribute.md).
- **Build a crawler** for a system we do not read yet. Start with
  [Building a crawler](docs/sync/building-a-crawler.md).

## What happens to an issue

Issues go through an automated "Definition of Ready" pipeline, in which an AI agent
reads the issue, checks it against the code and asks follow-up questions. That pipeline
only acts on issues from members of the Fortigi organisation. An issue from anyone else
is labelled `needs-vouch` and waits until a maintainer accepts it; from then on the
maintainer answers the agent's questions and you stay subscribed to the issue.
Nothing is built without a maintainer's decision, and nothing is merged without a
human review. The process is described in
[Definition of Ready](docs/process/definition-of-ready.md).

**You do not have to go through that pipeline.** A pull request is reviewed directly.

## Local setup

The repository has three parts: a Node.js API (`app/api`), a React UI (`app/ui`) and
PowerShell crawlers (`tools/crawlers`, `tools/powershell-sdk`). Install what you need
for the part you change.

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 24 (see `.nvmrc`) | API and UI unit tests, lint, UI build |
| PowerShell | 7 | Crawler code, Pester unit tests, PSScriptAnalyzer |
| Pester | 5.0.0 or later | PowerShell unit tests |
| Docker with Compose v2 | current | Running the stack, API contract tests, integration and end-to-end tests |
| Python | 3 | The ratchet scripts under `tools/*/ratchet.py` and the docs build |

Without Docker you can still run lint and all unit tests. Without Python you cannot run
the ratchets locally; CI runs them on your pull request.

To run the application from source (details in [Local development](docs/ui/local-dev.md)):

```bash
cp setup/config/.env.example .env
docker compose up -d --build      # then open http://localhost:3001
```

## Running the checks locally

These are the commands CI runs (`.github/workflows/pr.yml`).

**API** (`app/api`)

```bash
npm ci
npm run lint
npm run test:coverage     # unit tests plus the coverage floor; `npm test` skips coverage
npm run test:contract     # needs Docker: starts PostgreSQL 16 through testcontainers
```

On Windows, run `npm rebuild re2` once after `npm ci`, or the unit tests fail to load a
native module.

**UI** (`app/ui`)

```bash
npm ci
npm run lint
npm run test:coverage
```

**PowerShell** (from the repository root, in `pwsh`)

```powershell
Install-Module Pester -MinimumVersion 5.0.0 -Scope CurrentUser
Install-Module PSScriptAnalyzer -Scope CurrentUser
Invoke-Pester -Path test/unit
Invoke-ScriptAnalyzer -Path tools/crawlers -Recurse -Severity Warning, Error
```

CI analyses more folders and excludes a fixed list of rules; the `lint-ps` job in
`pr.yml` has the exact call.

**Ratchets and other gates** (from the repository root)

```bash
python3 tools/filesize/ratchet.py                  # no new source file over 1000 lines
python3 tools/complexity/ratchet.py                # cyclomatic complexity per function
python3 tools/complexity/ratchet.py --metric cognitive
python3 tools/coverage/ratchet.py --lcov app/api/coverage/lcov.info --prefix app/api/
python3 tools/coverage/ratchet.py --lcov app/ui/coverage/lcov.info --prefix app/ui/
python3 tools/migrations/ratchet.py                # merged migrations are immutable
python3 tools/node-version/ratchet.py              # .nvmrc is the single Node version
npx --yes jscpd@3 . --config .jscpd.json           # duplicated code
```

The complexity ratchet also needs `npm ci` in `app/api` and `app/ui`, and the PowerShell
module `PSComplexity` 0.5.1. The coverage ratchet reads the `lcov.info` that
`npm run test:coverage` writes. A documentation change is checked with
`pip install -r docs/requirements.txt` followed by `mkdocs build --strict`.

The Docker integration suite, the Playwright end-to-end tests and the load test run in
CI (`.github/workflows/pr-integration.yml`). Which jobs run depends on the files you
changed; [CI pipeline](docs/contributing/ci-pipeline.md) lists them.

## Branches and pull requests

1. Fork the repository and create a branch from `main`, named `feature/<name>` or
   `bugfixes/<name>` (lowercase, hyphens).
2. Keep it to **one change per pull request**.
3. **Add tests.** A change to code must come with tests that cover it. CI fails a pull
   request that changes source code without touching a test, and one that lowers
   coverage. Read
   [Writing tests that actually assert](docs/contributing/writing-tests-that-assert.md)
   first.
4. **Add a changelog fragment**: a file `changes/<name>.md` with one or more bullets
   that describe the change for a user. Do not edit `CHANGES.md` or the version in
   `setup/IdentityAtlas.psd1`; both are generated when the pull request merges.
5. Open the pull request into `main` and describe what changed and why.

A pull request needs the checks `CI Passed` and `Integration CI Passed` and one
approving review from a maintainer. It is then squash-merged, so you do not need to
tidy your commit history.

### Pull requests from a fork

- The same checks run on a pull request from a fork. A maintainer has to approve the
  workflow run before it starts, so the checks can stay pending for a while.
- Forks receive no repository secrets. The two integration suites that need them (the
  Entra ID crawler against a test tenant, and LLM risk scoring) are skipped, and that
  does not fail your pull request.
- Preview deployments of a pull request are only available for branches inside this
  repository.
- Labels such as `skip-hygiene` can only be set by a maintainer. Ask in the pull request
  if you think a check does not apply to your change.

## Conventions

- **API:** [`app/api/CLAUDE.md`](app/api/CLAUDE.md). Migrations, route tests, contract tests.
- **UI:** [`app/ui/CLAUDE.md`](app/ui/CLAUDE.md) and the
  [UI style guide](docs/contributing/style-guide.md). Dark mode, contrast, shared components.
- **Crawlers:** [`tools/crawlers/CLAUDE.md`](tools/crawlers/CLAUDE.md) and
  [Building a crawler](docs/sync/building-a-crawler.md).

The `CLAUDE.md` files were written as instructions for AI coding assistants. They are
also the most complete description of the conventions for each part, and they apply
equally to people. If something is unclear, ask in your pull request.

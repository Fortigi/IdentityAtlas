# Enrolling a DoR build-pool sidekick — setup checklist

What a machine needs before it can serve as a `dor-build` pool runner (rows 8–13 of the
[operationalization map](operationalization.md#end-to-end-map--build-side-design-v2--pooled-sidekicks)).
The build agent runs AI-authored code, deploys the stack, seeds demo data, runs Playwright, opens a
PR, and drives CI — so the box needs a specific baseline. Each item below bit us once as a
mid-build failure (missing `gh`, `unzip`, Node, and finally **no git identity** → an empty branch →
`No commits between main and dor/issue-N`); this list exists so a new member is provisioned in one
pass instead of one missing tool at a time.

> **Most of this is automated.** [`tools/dor/provision-sidekick.sh`](https://github.com/Fortigi/IdentityAtlas/blob/main/tools/dor/provision-sidekick.sh)
> is idempotent and does steps 1–2 below. Only the runner registration (step 3) and the repo/DNS
> wiring (steps 4–5) are manual, because they need a short-lived token / live outside the box.

## Checklist at a glance

| # | Item | Where | Automated? |
|---|------|-------|-----------|
| 1 | Software baseline — `git`, Docker + compose, Node 22, `gh`, `unzip`, `jq`, `build-essential`, `python3`, `pkg-config`, `curl` | on the box | ✅ `provision-sidekick.sh` |
| 2 | `claude` CLI · **git identity** · Playwright chromium cache · `edge` placeholder stack | on the box | ✅ `provision-sidekick.sh` |
| 3 | Register the GitHub Actions runner with labels `self-hosted,dor-build,skN` + systemd service | on the box | ⚠️ manual (needs a registration token) |
| 4 | Wire the repo config — the sidekick→URL map + the `sk:skN` label | in the repo | ⚠️ manual (one PR) |
| 5 | Network — DNS + central Traefik/authentik route `N.build.identityatlas.io` → `:3001` | infra | ⚠️ manual (infra) |
| — | Runtime secrets/vars are **not** on the box (provided by the workflow) — see [below](#runtime-secrets--variables-not-on-the-box) | GitHub | n/a |

## 1–2. Software baseline (automated)

On the box, as the user that will own the runner (must be in the `docker` group):

```bash
git clone --depth 1 https://github.com/Fortigi/IdentityAtlas.git /tmp/ia && cd /tmp/ia
bash tools/dor/provision-sidekick.sh          # install everything, then verify
bash tools/dor/provision-sidekick.sh --verify # re-check any time, changes nothing
```

This installs the baseline, sets the git identity (`IdentityAtlas DoR agent <dor-agent@fortigi.nl>` —
without it `git commit` aborts), installs the `claude` CLI to `~/.local/bin`, pre-caches the Playwright
chromium build, and stands up `~/stacks/edge`. Reference baseline (a healthy sidekick, 2026-07-31):
Ubuntu 24.04 · git 2.43 · Docker 29.6 / compose 5.3 · gh 2.97 · Node 22 · claude 2.1.

## 3. Register the GitHub Actions runner (manual)

Needs a **registration token** (short-lived) — mint it where you have `gh` auth with repo admin:

```bash
gh api -X POST repos/Fortigi/IdentityAtlas/actions/runners/registration-token --jq .token
```

Then on the box (replace `N` with this sidekick's number — e.g. `sk5`):

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL -o r.tar.gz https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz
tar xzf r.tar.gz
./config.sh --url https://github.com/Fortigi/IdentityAtlas \
            --token <REG_TOKEN> \
            --name "$(hostname)" \
            --labels self-hosted,dor-build,skN \
            --unattended --replace
sudo ./svc.sh install && sudo ./svc.sh start     # systemd service, auto-starts on boot
```

- **Labels are load-bearing.** `dor-build` selects the pool; `skN` is the stable per-runner label the
  reset/feedback matrix pins to. Both must be present.
- Confirm it shows up: **Settings → Actions → Runners** (Idle, green) — or
  `gh api repos/Fortigi/IdentityAtlas/actions/runners --jq '.runners[]|.name+" "+(.labels|map(.name)|join(","))'`.

## 4. Wire the repo config (manual — one PR)

Adding a box to the pool means teaching the workflows about it. Update, on a branch → PR:

- **`.github/workflows/dor-deploy.yml`**, **`dor-build-agent.yml`** and **`dor-acceptance.yml`** — all
  three have a `case "$(hostname)"` block that maps the hostname to its public URL:
  ```bash
  dev-docker-05) url="https://5.build.identityatlas.io" ;;
  dev-docker-0N) url="https://N.build.identityatlas.io" ;;   # ← add
  ```
- Create the label **`sk:skN`** in the repo (`gh label create "sk:skN" -c ededed -d "DoR: sidekick
  skN holds this issue's build env"`). A build stamps this label on the issue it is holding, and the
  reset / feedback workflows dispatch off it.

That is the whole list — there is no reset or feedback *matrix* to extend any more. Both workflows
resolve the holder from the issue's `sk:*` label and send a single job to that box, so a new sidekick
is reachable the moment its label exists.

A sidekick that is registered (step 3) but has no URL mapping will pick up build jobs and fail the
"Identify this sidekick" step (`unknown sidekick … not in the dor-build pool map`). If its `sk:skN`
label is missing, a build on it can still run, but the reset can't route to it — you'd get a loud
"no `sk:*` label" warning on the PR and have to release the box by hand.

## 5. Network (manual — infra)

- DNS `N.build.identityatlas.io` → the central ingress.
- The central Traefik routes `N.build.identityatlas.io` → this sidekick's `:3001`, behind
  authentik forward-auth against the Fortigi tenant. **The sidekick runner holds no Traefik/authentik
  credentials** — routing and auth are infra-managed off-box (that's the whole point of the pooled
  model: the runner can only `docker` its own box).

## Runtime secrets & variables (not on the box)

Provided by the workflow at run time — **do not** store these on the sidekick:

| Name | Kind | Purpose |
|------|------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | repo secret | the `claude` CLI's Max-subscription auth (env var at run time) |
| `BOT_APP_ID` / `BOT_PRIVATE_KEY` | repo secrets | mint the BOT app token (PR open + board moves + org-member gate) |
| `DOR_ENABLED` | repo variable | master switch — every DoR workflow is inert unless `true` |
| `DOR_BUILD_MODEL` | repo variable | optional model override (defaults to `claude-fable-5`) |

## Verify it's ready

```bash
bash tools/dor/provision-sidekick.sh --verify   # baseline green?
```

Then a real dry run: set the issue to `ready-to-build`, approve at the `build-approval` gate, and
watch the run land on the new box. If the baseline is complete it gets past implement → commit → PR
→ deploy without the historical stumbles.

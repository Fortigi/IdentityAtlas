# Automatic updates

Identity Atlas can keep itself current. The design splits the job in two so it
works the same on every deployment — Docker, Azure, or a local install — without
ever giving the application access to your container runtime:

- **The app decides.** It checks once a day for a newer version on its release
  channel, records what it finds, and exposes an **auto-update switch**. This is
  the brain — it lives in the app and is identical everywhere.
- **A small agent applies.** A deployment-specific helper (a cron job, a systemd
  timer, an Azure scheduled job) asks the app "should I update?" and, if so,
  pulls the new image and recreates the containers. This is the hands — it's the
  only part that differs per platform, and the only part with the privilege to
  change what's running.

The app never touches Docker or Azure itself, so there's no socket to mount and
no new attack surface inside the container.

## The Admin → Updates screen

**Admin → Updates** shows:

- the **running version** and the **release channel** (`edge`, `beta`, `latest`,
  or a pinned version),
- whether a **newer version is available** on that channel,
- the **automatic updates** switch, and
- a **history** of checks and installed updates.

**Check now** runs an immediate check. The daily check runs on its own ~24h
after startup and every day after.

### Channel awareness

Updates never cross channels: an `edge` deployment is only offered newer `edge`
builds, `beta` only newer betas, `latest` only newer releases. The channel comes
from the `IMAGE_TAG` your compose file uses (passed into the container); if it's
not set, the app infers it from the running version. A deployment pinned to a
fixed version (e.g. `5.2.1.0`) is detected as **pinned** and the switch is
disabled — pinned means pinned.

## Turning it on

1. Open **Admin → Updates** and turn **Automatic updates** on.
2. Install the agent for your platform (below) on a daily schedule.

With the switch **off**, the app still checks daily and shows the newest
available version — you just apply it yourself (`docker compose pull && up -d`,
or roll the Azure revision).

## The agent

All agents call `GET /api/updates/intent`, which returns whether an update should
be applied and to which version. They need **read access** to that endpoint — no
token if `AUTH_ENABLED=false`, otherwise a **read API token** (`fgr_…`) created
in **Admin → Data → Power Query**. They do **not** need admin credentials: the
app detects the installed version on its next check, so the history fills in
automatically.

### Docker host (cron or systemd)

The agent script lives at `tools/auto-update/identityatlas-autoupdate.sh`.

```bash
# cron — nightly at 03:30
30 3 * * *  IA_COMPOSE_FILE=/opt/identityatlas/docker-compose.prod.yml \
            /opt/identityatlas/tools/auto-update/identityatlas-autoupdate.sh >> /var/log/ia-update.log 2>&1
```

Or with systemd, using the provided unit + timer:

```bash
cp tools/auto-update/identityatlas-autoupdate.{service,timer} /etc/systemd/system/
systemctl enable --now identityatlas-autoupdate.timer
```

Environment: `IA_API_URL` (default `http://localhost:3001`), `IA_COMPOSE_FILE`,
`IA_READ_TOKEN` (only if auth is on), `IA_SERVICES` (default `web worker`).

### Azure Container Apps

Use `tools/auto-update/identityatlas-autoupdate-azure.sh` from an Azure
Automation runbook, a scheduled Container Apps Job, or a GitHub Actions cron with
an Azure login. It re-deploys the channel tag, which pulls that tag's current
digest into a new revision. Set `IA_API_URL`, `IA_RESOURCE_GROUP`, `IA_WEB_APP`
(and optionally `IA_WORKER_APP`), and `IA_CHANNEL` to match the deployment.

### Local install

Point the Docker agent script at the local compose file from the OS scheduler
(cron on macOS/Linux, Task Scheduler on Windows running it via Git Bash/WSL).

## What is *not* auto-updated

- **PostgreSQL** is pinned to `postgres:16-alpine` and is never rolled by the
  agent — database major-version upgrades are a deliberate, manual operation.
- **Schema migrations** run automatically when the new web container starts, and
  are **fail-closed**: if a migration fails the container refuses to start, so a
  half-migrated database can't serve traffic.

## Keeping components in step

The agent updates **web and worker together** so they never drift apart, and the
web container runs the schema migrations on boot (fail-closed). Detection of
web/worker/database version skew — a banner when a partial or interrupted update
leaves components out of step — is surfaced on the Updates screen as well.

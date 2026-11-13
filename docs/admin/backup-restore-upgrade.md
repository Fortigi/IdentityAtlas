# Back up, restore and upgrade

How to keep a Docker deployment of Identity Atlas safe and current: what to back up, how to get it back, how to move to a new version, and how to remove it.

This page is about the Docker deployment started from `docker-compose.prod.yml` (see [Docker Setup](../architecture/docker-setup.md)). Every command is run in the directory that holds that file and its `.env`. If you use a second compose file, for example for a reverse proxy, add it to each command with a second `-f`.

!!! warning "Written from the compose file, not from a test run"
    The procedures on this page follow from `docker-compose.prod.yml` and the standard PostgreSQL tools in its `postgres:16-alpine` image. They were not executed end to end for this page. Rehearse a restore on a spare machine before you rely on it. A backup you have never restored is a hope, not a backup.

---

## What to back up

Three things make up a deployment. You need all three to restore it.

| What | Where it lives | Why you need it |
|---|---|---|
| **The database** | The `postgres_data` volume | Everything Identity Atlas knows: accounts, resources, assignments, contexts, risk scores, crawler configurations, history. |
| **The vault master key** | `IDENTITY_ATLAS_MASTER_KEY` in `.env` if you set it yourself. Otherwise the file `/data/keys/.master-key` in the `web_keys` volume. | Crawler and LLM credentials are stored encrypted in the database. Without this key they cannot be decrypted, and a database backup alone does not bring them back. |
| **Your configuration** | `.env`, `docker-compose.prod.yml`, and any second compose file | The database password, the image version you run, and your settings. |

Optional: the `job_data` volume holds the files you uploaded for file-based crawlers, and job logs. Back it up if you cannot easily produce those files again. The key the worker signs in with also lives there, but it is replaced automatically when it is missing.

!!! tip "Hold the master key yourself"
    The simplest way to never lose the master key is to set `IDENTITY_ATLAS_MASTER_KEY` in `.env` before the first start and keep a copy in your password manager. If the stack is already running on a generated key, copy that key out once (below) and store it the same way.

---

## Back up

### 1. The database

`pg_dump` takes a consistent snapshot while the stack keeps running. Write the dump inside the container, then copy it out:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc -f /tmp/identity-atlas.dump'

docker compose -f docker-compose.prod.yml cp postgres:/tmp/identity-atlas.dump ./identity-atlas.dump

docker compose -f docker-compose.prod.yml exec postgres rm /tmp/identity-atlas.dump
```

`$POSTGRES_USER` and `$POSTGRES_DB` are read inside the container, so the commands also work when you changed those names in `.env`. In PowerShell, put the first command on one line; the single quotes work as written.

Copying the file out, instead of redirecting the output to a file, keeps the binary dump intact on Windows too.

On a large deployment the dump takes a while and needs disk space inside the container for the duration. Check the size of the database first with the query under [What to watch as usage grows](../architecture/docker-setup.md#what-to-watch-as-usage-grows).

### 2. The master key

Skip this if `IDENTITY_ATLAS_MASTER_KEY` is set in your `.env`: then `.env` is the backup.

```bash
docker compose -f docker-compose.prod.yml exec web cat /data/keys/.master-key
```

Store the value where you keep other root secrets. Treat it like a password: together with a database dump it decrypts every stored credential.

### 3. The configuration

Copy `.env` and your compose file(s) to the same safe place. `.env` contains the database password.

---

## Restore

This restores onto a host where Identity Atlas is not running yet. To restore over an existing deployment, first stop the web and worker containers (`docker compose -f docker-compose.prod.yml stop web worker`) and continue at step 3.

**1. Put the configuration back.** Place `docker-compose.prod.yml` and `.env` in a directory. Use the compose file of the version you made the backup with, or a newer one.

**2. Put the master key back.** If `.env` does not contain it yet, add the value you saved:

```
IDENTITY_ATLAS_MASTER_KEY=<the saved key>
```

A key set this way takes precedence over a key file, so it works on a fresh host.

**3. Start only the database.**

```bash
docker compose -f docker-compose.prod.yml up -d postgres
```

**4. Load the dump.**

```bash
docker compose -f docker-compose.prod.yml cp ./identity-atlas.dump postgres:/tmp/identity-atlas.dump

docker compose -f docker-compose.prod.yml exec postgres \
  sh -c 'pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists --no-owner /tmp/identity-atlas.dump'

docker compose -f docker-compose.prod.yml exec postgres rm /tmp/identity-atlas.dump
```

`--clean --if-exists` replaces what is already in the database, so the same command serves a fresh host and an existing one.

**5. Start the rest.**

```bash
docker compose -f docker-compose.prod.yml up -d
```

The web container applies any migrations that are newer than the dump and then serves as usual. Restore into the same version or a newer one; an older version does not understand a newer database.

**6. Check.** Open the app, then open a crawler under **Admin → Crawlers** and run it. A crawler that starts and reads data proves the master key matches: its credential was decrypted.

If the web container logs `No master key found … A new key was NOT generated`, the database holds encrypted credentials and no key was supplied. Go back to step 2. The app deliberately does not make up a new key in this situation, because that key could not decrypt what is stored.

---

## Upgrade

**1. Make a backup first** (above). An upgrade changes the database, and there is no downgrade path other than restoring.

**2. Pull and restart.**

```bash
docker compose -f docker-compose.prod.yml up -d --pull always
```

This fetches the newest image for your [channel](../architecture/docker-setup.md#image-channels) and recreates the web and worker containers. The database container and all volumes stay as they are.

**3. Wait for the migrations.** The web container opens its port immediately and then brings the database up to date in the background. Until that is done, the API answers `503` with `Schema migration in progress, please retry shortly`, and the worker waits. On a large database a migration can take minutes.

```bash
# "schemaReady": true means the migrations are done
curl http://localhost:3001/api/health

# Follow along
docker compose -f docker-compose.prod.yml logs -f web
```

The log line `Schema ready — worker (crawler) endpoints enabled` marks the end.

### If a migration fails

The web container does **not** stop. It logs `CRITICAL: database migration failed (attempt N)` with the cause, keeps its port open, and tries again: after 5, 15 and 30 seconds, then every 60 seconds. The API keeps answering `503` and no crawler runs in the meantime.

Each migration runs in a single transaction, so a failed one leaves nothing half-applied. Once the cause is gone (a full disk, a database that was not reachable), the next attempt succeeds without a restart. If the cause is the migration itself, restore your backup on the previous version (see [Roll back](#roll-back)) and report the log line.

### Which version am I running?

- **Admin → Updates** shows the running version, the release channel, and whether a newer version is available.
- `curl http://localhost:3001/api/version` returns the version.
- `docker compose -f docker-compose.prod.yml images` lists the image tag of each container.

### Choosing when to upgrade

By default `up -d --pull always` moves you to the newest stable release. To decide for yourself, pin a version in `.env`:

```
IMAGE_TAG=5.2.1.0
```

Upgrade by changing that value and running the command from step 2. To follow pre-releases, set `IMAGE_TAG=beta`. The web and worker images are always published under the same tag.

Identity Atlas can also check for new versions and apply them on a schedule. See [Automatic Updates](auto-updates.md).

### When the compose file itself is out of date

A new release sometimes needs a newer `docker-compose.prod.yml`. The Dashboard shows a warning when yours is older than the running image expects. Download the current file again (the first command of the [install](../architecture/docker-setup.md#install)); your `.env` and your data are not touched. Then run the command from step 2.

If your old compose file had no `web_keys` volume, an auto-generated master key was stored in the `job_data` volume. On the first start with the current file, the web container copies it to `web_keys`, verifies the copy against a stored credential, and only then removes the old file. Nothing to do, other than making sure `web_keys` is in your backup from then on.

PostgreSQL itself is pinned to major version 16 and is never upgraded by pulling. Moving to a new major version is a separate, deliberate operation.

---

## Roll back

Migrations only go forward. An older image cannot run on a database that a newer image has migrated, so rolling back means returning to the backup you made before the upgrade.

1. Stop the stack: `docker compose -f docker-compose.prod.yml down`.
2. Set `IMAGE_TAG` in `.env` to the version you came from, and put back the compose file of that version if you replaced it.
3. Follow [Restore](#restore) from step 3 with the dump you made before the upgrade.

Everything that changed after that backup is lost. Crawlers bring the synced data back on their next run; manual work such as tags, contexts you built by hand and risk-score overrides does not come back.

**If the master key has moved to `web_keys`** and you return to a compose file without that volume: copy the key out first (`docker compose -f docker-compose.prod.yml exec web cat /data/keys/.master-key`) and set it as `IDENTITY_ATLAS_MASTER_KEY` in `.env`.

---

## Uninstall

```bash
# Remove the containers, the network, all volumes and the images
docker compose -f docker-compose.prod.yml down -v --rmi all
```

`-v` deletes the database, the uploaded files and an auto-generated master key. There is no undo. Leave `-v` out to keep the data for later.

Then delete `docker-compose.prod.yml` and `.env`. If you registered an application in Entra ID for sign-in or for a crawler, remove it there as well, together with any secret you created for it.

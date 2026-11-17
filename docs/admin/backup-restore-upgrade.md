# Back up, restore and upgrade

How to keep a deployment of Identity Atlas safe and current: what to back up, how to get it back, how to move it to a new instance, how to move to a new version, and how to remove it.

Most of this page is about the Docker deployment started from `docker-compose.prod.yml` (see [Docker Setup](../architecture/docker-setup.md)). Every command is run in the directory that holds that file and its `.env`. If you use a second compose file, for example for a reverse proxy, add it to each command with a second `-f`. Moving to a new instance, and backing up and restoring on Azure and on the portable version, are under [Move Identity Atlas to a new instance](#move-identity-atlas-to-a-new-instance).

!!! warning "Tested on every release, but rehearse it on your own host"
    The Docker back-up, upgrade and restore on this page are run by the [release test](../contributing/release-process.md#the-release-test) for every beta and stable release, with the commands as written here: it backs up the previous stable release, upgrades to the new one, then restores the backup onto an empty host, and checks that the data, and the [person-made data](../contributing/release-process.md#person-made-data) such as tags, crawler configurations and role mappings, come back unchanged. Your host, volumes and backup storage are not part of that test. Rehearse a restore on a spare machine before you rely on it. A backup you have never restored is a hope, not a backup.

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

## Move Identity Atlas to a new instance

To move Identity Atlas to another host, another Azure deployment or another laptop, back up the database and restore it there. The database holds everything: the synced data, and everything people made in the app, such as tags, contexts built by hand, risk-score overrides, crawler configurations and settings. Nothing needs to be exported or imported separately.

Move two other things along with the database:

- **The vault master key.** Without it the crawler and LLM credentials in the database cannot be decrypted. Where it lives differs per deployment type; each section below says where.
- **The version.** The new instance must run the same version as the old one, or a newer one. A newer version migrates the restored database on its first start. An older version cannot run on a database that a newer one has migrated.

### Docker: from the old host to the new host

The steps reuse [Back up](#back-up) and [Restore](#restore) above.

**1. Prepare the new host, but do not start Identity Atlas yet.** Install Docker and create a directory for Identity Atlas. If you already started the stack there, that is fine: stop the web and worker containers (`docker compose -f docker-compose.prod.yml stop web worker`) before step 5.

**2. Note the version on the old host.** Look under **Admin → Updates**, or run `curl http://localhost:3001/api/version`. If `.env` pins `IMAGE_TAG`, that pin moves along with `.env`.

**3. Back up the old host.** Copy the master key out first if `IDENTITY_ATLAS_MASTER_KEY` is not in `.env` ([Back up](#back-up), step 2): that command needs the web container running. Then stop the web and worker containers, so nothing changes after the dump. The database container keeps running:

```bash
docker compose -f docker-compose.prod.yml stop web worker
```

Now make the dump and copy the configuration ([Back up](#back-up), steps 1 and 3).

If you need the files uploaded for file-based crawlers, copy them out as well. `cp` also works on a stopped container:

```bash
docker compose -f docker-compose.prod.yml cp web:/data/uploads ./uploads
```

**4. Copy the files to the new host.** Copy `identity-atlas.dump`, `.env`, `docker-compose.prod.yml` (and any second compose file) and, if you made it, the `uploads` folder. Use a channel you trust, for example `scp`: `.env` holds the database password, and the dump together with the master key decrypts every stored credential.

**5. Restore on the new host.** Follow [Restore](#restore) from step 1: put the configuration back, add the master key to `.env` as `IDENTITY_ATLAS_MASTER_KEY` if it is not there yet, start only the database, load the dump, and start the rest. Use the compose file of the old version or a newer one.

If you copied the uploaded files, put them back once the stack runs, and give them to the user the container runs as:

```bash
docker compose -f docker-compose.prod.yml cp ./uploads/. web:/data/uploads
docker compose -f docker-compose.prod.yml exec -u 0 web chown -R node:node /data/uploads
```

**6. Update what points at the old address.** If the new host has a different address:

- Set `PUBLIC_BASE_URL` in `.env` to the new address if you use it, and recreate the containers (`docker compose -f docker-compose.prod.yml up -d`).
- With sign-in on, add the new address as a redirect URI to the Entra ID app registration (see [Authentication](authentication.md)).
- Excel Power Query workbooks made on the old host call the old address. Generate new ones under **Admin → Data**.

**7. Check.** Do the check of [Restore](#restore), step 6: open the app and run a crawler, which proves the master key matches. Compare the counts on the Dashboard with the old host.

**8. Retire the old host.** Keep it stopped, not deleted, until you trust the new one. Then remove it as under [Uninstall](#uninstall), and keep the dump.

### Azure

!!! warning "Written from the templates, not from a test run"
    This section follows from the Bicep templates in `azure/` and the standard Azure CLI and PostgreSQL commands. It was not executed end to end. Rehearse it on a spare resource group before you rely on it.

**What the templates set up.** The database is an Azure Database for PostgreSQL Flexible Server (PostgreSQL 16) with a database named `identity_atlas` and the admin user `identityatlas`. Its admin password is the Key Vault secret `postgres-admin-password`. The vault master key is the Key Vault secret `identityatlas-master-key`. The deployment script generates both once, only when they do not exist yet, and the web app reads the newest version of the master key through a Key Vault reference. See [Azure Deployment](../architecture/azure-deployment.md) for the whole shape.

#### Built-in backups and point-in-time restore

**What the template configures.** The template is kept as it is. This is what it sets, so you can judge whether it is enough for you:

| Setting | What the template sets | What that means |
|---|---|---|
| Automatic backups with point-in-time restore | On, managed by Azure | You can return the database to any moment in the retention period. |
| Backup retention | `backupRetentionDays: 7` | The minimum. Azure allows up to 35 days. |
| Geo-redundant backup | `geoRedundantBackup: 'Disabled'` | The backups stay in the server's region. This can only be switched on when a server is created. |
| High availability | Disabled | One server, no standby. |
| Resource locks | None | Deleting the server or its resource group deletes its backups too. |
| Key Vault (master key, database password) | Soft delete for 7 days, purge protection on | A deleted secret or vault can be recovered for 7 days, and cannot be purged sooner. |

The settings come from `azure/modules/postgres.bicep` and `azure/modules/key-vault.bicep`.

A point-in-time restore never overwrites the server. It creates a **new** server with the data as it was at the moment you choose, within those 7 days:

```bash
az postgres flexible-server restore \
  --resource-group <rg> \
  --name <new-server-name> \
  --source-server <pgname> \
  --restore-time "2026-11-17T09:00:00Z"
```

The web app keeps using the server the template created; the template cannot point it at another one. To bring the restored data back into the deployment, treat the restored server as the old instance in [Move to a new Azure deployment](#move-to-a-new-azure-deployment) below: dump from the restored server and restore into the deployment's own server. Delete the restored server afterwards. The template does not manage it, and it costs money for as long as it exists.

A restore point is also the quickest way back from an upgrade that went wrong; see [Pinning an exact release](../architecture/azure-deployment.md#pinning-an-exact-release).

#### Move to a new Azure deployment

You need the Azure CLI and the PostgreSQL 16 (or newer) client tools `pg_dump` and `pg_restore` on the machine you run this from.

**1. Deploy the new instance** into a new resource group, with the same image version as the old one or a newer one (the `imageTag` parameter; see [Pinning an exact release](../architecture/azure-deployment.md#pinning-an-exact-release)). Its deployment script generates its own master key and database password.

**2. Stop both web apps.** The worker talks only to the web app, so stopping the web app stops all writes:

```bash
az webapp stop --resource-group <old-rg> --name <old-prefix>-web
az webapp stop --resource-group <new-rg> --name <new-prefix>-web
```

**3. Open a path to both databases.** In the public network mode, add a temporary firewall rule for your own IP address to each server, as described under [Postgres access](../architecture/azure-deployment.md#postgres-access). In the private network mode the servers have no public access. Run the commands from a machine that can reach both private endpoints; the templates do not provide one.

**4. Dump the old database.** Fetch the old admin password from the old Key Vault, then dump:

```bash
export PGPASSWORD="$(az keyvault secret show --vault-name <old-kv> --name postgres-admin-password --query value -o tsv)"
pg_dump "host=<old-pgFqdn> port=5432 dbname=identity_atlas user=identityatlas sslmode=require" \
  -Fc -f identity-atlas.dump
```

**5. Restore into the new database.**

```bash
export PGPASSWORD="$(az keyvault secret show --vault-name <new-kv> --name postgres-admin-password --query value -o tsv)"
pg_restore --clean --if-exists --no-owner \
  -d "host=<new-pgFqdn> port=5432 dbname=identity_atlas user=identityatlas sslmode=require" \
  identity-atlas.dump
unset PGPASSWORD
```

The template already allows the `pg_trgm` extension on the server, so the restore can create it.

**6. Carry the master key.** Copy the old secret into the new Key Vault. This adds a new version of `identityatlas-master-key`, and the web app reads the newest version:

```bash
az keyvault secret set --vault-name <new-kv> --name identityatlas-master-key \
  --value "$(az keyvault secret show --vault-name <old-kv> --name identityatlas-master-key --query value -o tsv)" \
  --output none
```

App Service fetches a changed secret on its own within 24 hours. To use it at once, open the new web app in the portal, go to **Environment variables** and choose **Pull reference values**. Do this before the next step.

**7. Start the new web app** and wait for the migrations, as under [Upgrade](#upgrade), step 3:

```bash
az webapp start --resource-group <new-rg> --name <new-prefix>-web
```

**8. Set up sign-in and the crawler identity again.** These are not in the database:

- The tenant and client ID are settings of the web app. Set them on the new one, and add its URL as a redirect URI to the Entra ID app registration (Steps 2 and 3 of the [portal walkthrough](../architecture/azure-deployment-walkthrough.md)).
- The new deployment has its own crawler managed identity, created without permissions. If a crawler signs in as that identity, grant it again (see [Crawler identity](../architecture/azure-deployment.md#crawler-identity-entra-id-without-a-client-secret)).
- Files uploaded for file-based crawlers live on the old deployment's Azure Files share, not in the database. Upload them again in the new instance.

**9. Check, then clean up.** Open the app and run a crawler: a crawler that starts and reads data proves the master key matches. Remove the temporary firewall rules. Delete the old resource group only once you trust the new deployment.

#### Limits

- **A point-in-time restore creates a new server** that the template does not manage. Getting its data into the deployment takes a dump and a restore.
- **Changes made outside the template can be undone by a redeploy.** The template declares the backup settings, so a redeploy sets a value it declares, such as the retention, back to what the template says. Check them after each redeploy.
- **Key Vault purge protection** means a deleted vault keeps its name for 7 days, so a deleted resource group cannot be redeployed with the same vault name within those 7 days.
- **Private network mode** needs a machine with a network path to the private endpoints for any dump or restore.

#### If you need more

You can add any of these yourself, without changing the template:

- **Longer retention.** Raise it to up to 35 days in the portal (the server's **Backup and restore** settings) or with `az postgres flexible-server update --resource-group <rg> --name <pgname> --backup-retention <days>`.
- **Backups in a second region.** Choose geo-redundant backup when the server is created. For an existing deployment, that means a new server, filled with a dump and restore as above.
- **Protection against deletion.** Add a `CanNotDelete` lock to the server or the resource group: `az lock create --name keep-identity-atlas --lock-type CanNotDelete --resource-group <rg>`. Remove it before you tear the deployment down on purpose.
- **Long-term copies.** Use Azure Backup's vaulted backup for Azure Database for PostgreSQL Flexible Server, which keeps copies in a Backup vault for longer than 35 days and separately from the server.
- **Your own dumps.** Take a periodic `pg_dump` as in step 4 above and keep it, with the master key stored separately, outside the deployment.

### Portable

!!! warning "Written from the launcher, not from a test run"
    This section follows from the portable launcher and the standard PostgreSQL tools. It was not executed end to end. Rehearse a restore on a spare machine before you rely on it.

**Where the data lives.** Everything is in one data directory: `IA_DATA_DIR` when it is set; otherwise `%APPDATA%\IdentityAtlas\` when an older install already keeps its data there; otherwise `%LOCALAPPDATA%\IdentityAtlas\`. The launcher prints the one it uses when it starts. In it:

| What | Where in the data directory |
|---|---|
| The database, default ZIP (built-in database) | `pgdata\` |
| The database, `IdentityAtlas-portable-postgres.zip` (real PostgreSQL) | `postgres\data\`, with its password in `postgres\password` |
| The vault master key | `.master-key` |
| Files uploaded for file-based crawlers | `uploads\` |

The full list is under [Data Location](../architecture/desktop-portable.md#data-location).

#### Back up

**Copy the folder.** Stop the app (Ctrl+C in the launcher window, and wait until it has stopped), then copy the whole data directory. This works for both ZIPs and includes the master key. You can leave out `llm\` and `llm-slots\`: they are large, and are downloaded or rebuilt again when needed.

**Or dump the database** (real PostgreSQL only). While the app runs, from the folder you unzipped:

```powershell
$data = "$env:LOCALAPPDATA\IdentityAtlas"   # the data directory the launcher printed
$env:PGPASSWORD = (Get-Content "$data\postgres\password" -Raw).Trim()
.\postgres\bin\pg_dump.exe -h 127.0.0.1 -p 5433 -U identityatlas -d identityatlas -Fc -f identity-atlas.dump
Remove-Item Env:PGPASSWORD
```

Copy `.master-key` from the data directory along with the dump. The default ZIP's built-in database runs inside the app itself, so there is no server to run `pg_dump` against: for that ZIP, copying the folder is the backup.

#### Restore

**From a folder copy.** Stop the app, replace the data directory with the copy, and start the app with the same version of the ZIP or a newer one. Data from the real PostgreSQL ZIP needs that ZIP again.

**From a dump** (real PostgreSQL only).

1. Start the app once with `-Database Postgres` on the target, so the launcher creates the database server. Then stop it.
2. Start only the database server, load the dump and stop the server again:

    ```powershell
    $data = "$env:LOCALAPPDATA\IdentityAtlas"
    .\postgres\bin\pg_ctl.exe start -D "$data\postgres\data" -o "-p 5433" -w
    $env:PGPASSWORD = (Get-Content "$data\postgres\password" -Raw).Trim()
    .\postgres\bin\pg_restore.exe -h 127.0.0.1 -p 5433 -U identityatlas -d identityatlas --clean --if-exists --no-owner identity-atlas.dump
    Remove-Item Env:PGPASSWORD
    .\postgres\bin\pg_ctl.exe stop -D "$data\postgres\data" -m fast
    ```

3. Replace `.master-key` in the data directory with the one you saved. The first start generated a new key, and that key decrypts nothing in the restored database.
4. Start the app as usual and run a crawler to check the key.

#### Move to a new machine

Copy the data directory, with the app stopped, to the same place on the new machine (or point `IA_DATA_DIR` at it). Unzip the same version of the ZIP or a newer one there, and start it. The copy carries the database, the master key and the uploaded files. Treat the copy like a password: the key in it decrypts every stored credential.

### Between deployment types

A dump from Docker, from Azure or from the real PostgreSQL ZIP is an ordinary PostgreSQL 16 dump. It can be restored into either of the other two with the steps above, as long as the master key goes along: as `IDENTITY_ATLAS_MASTER_KEY` in `.env` on Docker, as the `identityatlas-master-key` secret on Azure, and as the `.master-key` file on the portable version. The default portable ZIP's built-in database can only be moved by copying its folder to another portable install. To get its data anywhere else, run the crawlers again in the new place.

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

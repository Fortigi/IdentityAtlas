# Troubleshooting

Start with the symptom you see. The first section covers what goes wrong on a new Docker deployment; the sections after it cover crawlers and permissions.

Two commands answer most questions:

```bash
# Is the app up, and has it finished preparing the database?
curl http://localhost:3001/api/health

# What does the web container say?
docker compose -f docker-compose.prod.yml logs --tail 200 web
```

---

## First start

| What you see | Cause | What to do |
|---|---|---|
| `docker compose up` stops with **`POSTGRES_PASSWORD must be set`** | The compose file ships no default database password and refuses to start without one. | Add a line `POSTGRES_PASSWORD=<strong value>` to the `.env` file next to the compose file, and run the command from that directory. The [install commands](../architecture/docker-setup.md#install) generate one. |
| The UI loads but shows errors; the web log repeats **`CRITICAL: database migration failed`** with **`password authentication failed`** | `POSTGRES_PASSWORD` in `.env` is not the password the database was created with. The database keeps its first password; a new value in `.env` does not change it. | See [Changed database password](#changed-database-password). |
| Requests answer **`503`** `Schema migration in progress, please retry shortly` | The web container is still bringing the database up to date, or a migration is failing and being retried. | Look at `/api/health`: `"schemaReady": false` confirms it. Give a first start or an upgrade a few minutes. If the log shows `CRITICAL: database migration failed`, see [If a migration fails](../admin/backup-restore-upgrade.md#if-a-migration-fails). |
| After signing in: **"You don't have access to Identity Atlas yet"** | Your account has no role. A signed-in user without a role gets nothing. | Have an administrator assign you an app role (`Admin`, `RoleMiner` or `Servicedesk`) on the Identity Atlas application in Entra ID, then sign out and in again. If nobody has the `Admin` role yet, follow [Recovering from a lockout](../admin/authentication.md#recovering-from-a-lockout). |
| A setup page instead of the sign-in | `AUTH_ENABLED=true` is set, but `AUTH_TENANT_ID` or `AUTH_CLIENT_ID` is empty. | Set all three and recreate the web container. See [Setting up authentication](../admin/authentication.md). |
| **`421`** `This host name is not allowed` | Authentication is off and the app is opened on a DNS name it does not know. | Set `PUBLIC_BASE_URL` or `ALLOWED_HOSTS`. See [Allowed host names](../architecture/docker-setup.md#allowed-host-names). |
| The web log says **`No master key found … A new key was NOT generated`** | The database holds encrypted credentials, but the key that decrypts them is missing, for example after restoring a database without its key. | Put the key back: see [Restore](../admin/backup-restore-upgrade.md#restore), step 2. |
| **`413`** on an upload or in the matrix | A size limit was reached. Which one depends on where it happens. | See [Too large (413)](#too-large-413). |

### Changed database password

The database stores its password in the `postgres_data` volume the first time it starts. Editing `POSTGRES_PASSWORD` afterwards changes what the web container *uses*, not what the database *expects*, and the web container can no longer connect.

Pick one:

- **Put the original value back** in `.env` and run `docker compose -f docker-compose.prod.yml up -d`.
- **Make the database accept the new value.** Connections from inside the database container need no password, so you can set it there. Replace the placeholder with the value from your `.env`:

    ```bash
    docker compose -f docker-compose.prod.yml exec postgres \
      psql -U identity_atlas -d identity_atlas -c "ALTER USER identity_atlas PASSWORD '<value from .env>';"
    ```

    The web container connects on its next retry, within a minute. This command was written from the compose file and not run for this page.
- **Start over**, if there is nothing in the database you want to keep: `docker compose -f docker-compose.prod.yml down -v` deletes all data, after which the next start creates the database with the password in `.env`.

### Too large (413)

| Where | Message | Limit | What to do |
|---|---|---|---|
| Uploading files for a file-based crawler | `A file is larger than the … per-file upload limit` | 8 GiB per file by default | Raise `UPLOAD_MAX_FILE_BYTES` (see [Environment Variables](../architecture/docker-setup.md#settings-the-compose-file-does-not-pass-on)). |
| Same | `This upload would exceed the storage quota for this crawler configuration` | Only when `UPLOAD_CONFIG_QUOTA_BYTES` is set | Delete old files of that crawler, or raise the quota. |
| Same, behind a reverse proxy | An HTML error page from the proxy, not a JSON message | The proxy's own request-size limit (nginx: 1 MB by default) | Lift the limit in the proxy. See [Behind a reverse proxy](../architecture/docker-setup.md#behind-a-reverse-proxy-https). |
| Opening the matrix | `This matrix has more than 400,000 assignments` | 400,000 assignments in one per-subject grid | Narrow the matrix with filters, sort by Manager Hierarchy, or roll up by an attribute. |
| A custom connector posting to `/api/ingest` | `413` on the request | 50 MB per request | Send smaller batches. |

A related one: `507` `Not enough free disk space on the upload volume` means the host disk is nearly full, not that the file is too large.

---

## Common Issues

| Issue | Solution |
|-------|---------|
| **Database connection fails** | Check that the `postgres` container is healthy (`docker compose ps`). Verify `DATABASE_URL` in the web container's environment. For direct access, connect to `localhost:5432` with the credentials from your `.env` file or `docker-compose.yml`. |
| **"No Access Token found"** | Run `Get-FGAccessToken -ConfigFile config.json`. Tokens expire after approximately one hour in interactive sessions. |
| **Permission errors after changing the App Registration** | The Entra ID crawler acquires a fresh token at the start of each run. For manual Graph API commands, run `Get-FGAccessToken -ConfigFile config.json` again to pick up new permissions. Allow up to 15 minutes for Graph API permission grants to propagate. |
| **Migration errors on startup** | Check the web container logs (`docker compose logs web`). Migrations run automatically and are idempotent. If a migration fails, fix the underlying issue and restart the web container. |
| **Sync skips expected data** | Check two things: (1) confirm the entity type is enabled in the crawler flags or config, and (2) verify the App Registration has the required Graph API permission (see [Required Permissions](#required-permissions) below). |
| **UI shows a blank or empty matrix** | Verify that a sync has completed successfully. Check the Sync Log page in the UI for errors. If the crawler completed but the matrix is empty, check that the SQL views exist by examining the web container logs for migration output. |
| **Risk scores not visible in the UI** | Risk scoring is set up and run in the UI. Check three things in **Admin → Risk Scoring**: (1) **Risk Scoring Feature** is switched on, (2) a classifier set is active — if **Risk Classifiers** is empty, click **New profile** and complete the wizard, and (3) a scoring run has finished — click **Run now**. See [How Scoring Works](../risk-scoring/overview.md#setting-it-up). |
| **"More than one object found"** in Confirm-FG* functions | A `Confirm-FG*` function found multiple objects matching the supplied name. Use a more specific identifier (object ID instead of display name). |

---

## Crawler URL rejected

The Omada, midPoint, SCIM and OData crawlers send their credentials to the `baseUrl` and
OAuth2 `tokenEndpoint` in their configuration. To stop a configuration from pointing that
credential at an internal service or a cloud-metadata endpoint, Identity Atlas accepts only
**https** URLs on **public** addresses unless the crawler opts in. The check runs:

- when the crawler is saved and when a job is started (the API answers `400 … rejected`);
- when the wizard runs live discovery (which also does not follow HTTP redirects — enter the final URL);
- on the worker right before it connects, before every token request, and on every next-page
  link the server returns (which must stay on the configured host).

| Message contains | Meaning | Fix |
|---|---|---|
| *must use https* | The URL is plain `http`. | Enable https on the server, or tick **Allow insecure HTTP** (`allowInsecureHttp: true`). Credentials are then sent unencrypted. |
| *private or loopback address* | The host resolves to `10.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x`, `127.x` or an IPv6 unique-local address. | For an on-premises server, tick **Allow private network** (`allowPrivateNetwork: true`). |
| *link-local, metadata, or reserved address* | The host resolves to `169.254.x`, `fe80::`, `0.0.0.0`, a multicast/reserved range, or an IPv6 form that embeds one of these. | Cannot be enabled. Use the server's real address. |
| *points to a different host* | The server returned a next-page link on another host. | Check the server's public URL / reverse-proxy settings; the crawler never follows such a link. |
| *redirect (HTTP 3xx)* | Discovery hit a redirect. | Configure the URL the server redirects to. |

Both options are per crawler, on the wizard's **Connection** step. A crawler configured before
these checks existed keeps its settings but is refused until the matching option is ticked:
edit the crawler, tick it, and save.

---

## Required Permissions

All permissions below are **Application** permissions (not Delegated). They are configured on the App Registration used by the Entra ID crawler.

| Permission | Purpose |
|-----------|---------|
| `User.Read.All` | Read all users and their profile attributes |
| `Group.Read.All` | Read all groups and group properties |
| `GroupMember.Read.All` | Read direct group memberships |
| `Directory.Read.All` | Read directory objects, directory roles, and role assignments |
| `EntitlementManagement.Read.All` | Read Entitlement Management catalogs, access packages, assignments, policies, and requests |
| `AccessReview.Read.All` | Read access review instances and decisions |
| `Application.Read.All` | Read service principals and application role assignments |
| `PrivilegedEligibilitySchedule.Read.AzureADGroup` | Read PIM-eligible group memberships |
| `AuditLog.Read.All` | Read sign-in logs and audit events (required for `PrincipalActivity` and `AppRoleActivity` sync) |

!!! warning "Admin consent required"
    All of these are Application permissions that require tenant-wide admin consent. The in-browser Crawlers wizard validates these permissions when you configure a new Entra ID crawler. Grant consent in the Azure Portal under App Registrations > API Permissions.

---

## Config File Issues

Config files are only needed when running crawler scripts outside the Docker worker container. In the standard Docker deployment, all configuration is managed through the in-browser wizard (Admin > Crawlers).

### Config file not found

Crawler scripts require a `-ConfigFile` parameter pointing to a JSON config with Graph API credentials. The template is at `setup/config/tenantname.json.template`:

```powershell
.\tools\crawlers\entra-id\Start-EntraIDCrawler.ps1 `
    -ApiBaseUrl "http://localhost:3001/api" `
    -ApiKey "fgc_abc..." `
    -ConfigFile 'C:\Config\mycompany.json'
```

---

## Debug output for command-line runs

When you run a crawler script from the command line, the PowerShell SDK functions emit detailed request/response output when `$Global:DebugMode` is set. Set it to any combination of the letters below before running the script. It has no effect on crawlers started from the UI.

```powershell
$Global:DebugMode = 'G'   # GET requests — show URIs, page counts, item counts
$Global:DebugMode = 'P'   # POST and PATCH requests — show URIs and request bodies
$Global:DebugMode = 'D'   # DELETE requests
$Global:DebugMode = 'T'   # Token operations — show token acquisition and refresh events
$Global:DebugMode = 'GP'  # Multiple categories — combine any letters
$Global:DebugMode = 'GPT' # All HTTP + token operations

# Clear debug mode
$Global:DebugMode = $null
```

Debug output writes to the host (not the pipeline), so it does not interfere with function return values.

!!! tip "Troubleshooting the Entra ID crawler"
    Set `$Global:DebugMode = 'G'` before running `Start-EntraIDCrawler.ps1` to see every Graph API URI being called, including paginated continuation URLs.

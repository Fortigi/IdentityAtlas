# Troubleshooting

This page covers debug mode, common error conditions, required permissions, and known operational constraints.

---

## Debug Mode

Identity Atlas's PowerShell SDK functions emit detailed request/response output when `$Global:DebugMode` is set. Set it to any combination of the letters below before running any command.

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
| **Risk scores not visible in the UI** | Risk scoring in v5 is driven from the UI (Admin > Risk Scoring). PowerShell risk scoring functions are not yet implemented in v5. Use the in-browser wizard to configure and run scoring. |
| **"More than one object found"** in Confirm-FG* functions | A `Confirm-FG*` function found multiple objects matching the supplied name. Use a more specific identifier (object ID instead of display name). |

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

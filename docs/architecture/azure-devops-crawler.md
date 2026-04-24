# Azure DevOps Crawler

The Azure DevOps crawler syncs identity and access data from an ADO organization into IdentityAtlas via the Ingest API. It runs in the worker container and follows the same job-queue pattern as the Entra ID and CSV crawlers.

## What it syncs

| ADO concept | IdentityAtlas table | resourceType / principalType |
|---|---|---|
| Organization | Systems | `systemType='AzureDevOps'` |
| Member entitlement (user) | Principals | `principalType='User'` |
| Member entitlement (service account) | Principals | `principalType='ServicePrincipal'` |
| Project | Resources | `resourceType='AzureDevOpsProject'` |
| Team | Resources | `resourceType='AzureDevOpsTeam'` |
| Security group | Resources | `resourceType='AzureDevOpsGroup'` |
| Git repository | Resources | `resourceType='AzureDevOpsRepo'` |
| Team membership | ResourceAssignments | `assignmentType='Direct'` |
| Security group membership | ResourceAssignments | `assignmentType='Direct'` |
| Repository ACL entry | ResourceAssignments | `assignmentType='Direct'` |
| Team within project | ResourceRelationships | `relationshipType='Contains'` |
| Repository within project | ResourceRelationships | `relationshipType='Contains'` |

**Not in scope:** pipeline permissions, service connections.

## Authentication

Authentication uses a Personal Access Token (PAT). Create one at `https://dev.azure.com/{org}/_usersSettings/tokens` with the following scopes:

| Scope | Purpose |
|---|---|
| `vso.project` | Read projects and teams |
| `vso.graph` | Read security groups and group memberships |
| `vso.memberentitlementmanagement` | Read user entitlements and access levels |
| `vso.code` | Read Git repositories and security ACLs (required for Repositories & ACLs scope) |

PATs expire based on your organization's policy. The wizard will warn if the tested scope check fails.

A PAT inherits the permissions of the user who created it. If that user does not have access to all projects in the organization, the crawler will find security groups from those projects (via the org-wide groups API) but will not be able to resolve their parent project names. To get full coverage, ensure the PAT owner has at least **Project Reader** access on every project.

## Credential storage

The PAT is stored encrypted in the `Secrets` table using AES-256-GCM envelope encryption — the same vault used for LLM API keys. The raw credential is **never** stored in `CrawlerConfigs.config`. Only a stable `secretRef` key is stored there, which the scheduler resolves at job-queue time.

To rotate the PAT, open the crawler in Configure mode and enter the new token. The vault entry is updated in place.

## Entra ID identity correlation

ADO users who are backed by an Entra ID account have `originDirectory='aad'` and `originId=<entra-object-id>` in their member entitlement record. The crawler stores these in `extendedAttributes` on the ADO Principal.

After the sync completes, `Invoke-FGAccountCorrelation` runs and creates Identity + IdentityMember records linking the ADO principal to the matching Entra ID principal. This means a single person who appears in both systems is represented as one Identity with two member accounts — their cross-system access is visible in a unified view.

If you disable "Auto-link ADO users to Entra ID identities" in the wizard, the `originDirectory`/`originId` fields are still stored, but the automatic correlation step is skipped. You can run correlation manually later.

## Repositories and ACLs

When the **Repositories & ACLs** scope is enabled, the crawler fetches every Git repository in each project using `GET /{org}/{project}/_apis/git/repositories` and stores them as Resources with `resourceType='AzureDevOpsRepo'`.

Each repository is linked to its parent project via a `ResourceRelationship` with `relationshipType='Contains'`.

Repository security ACLs are read from the ADO security namespace API:

```
GET /{org}/_apis/accesscontrollists/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87
    ?token=repoV2/{projectId}/{repoId}
    &api-version=7.2
```

Each access control entry (ACE) maps an identity descriptor to a pair of bit masks (`allow`, `deny`). The crawler decodes these bit masks into human-readable permission labels stored in `extendedAttributes.allowLabels` / `extendedAttributes.denyLabels`:

| Bit | Permission label |
|---|---|
| 2 | Read |
| 4 | Contribute |
| 8 | ForcePush |
| 16 | CreateBranch |
| 32 | CreateTag |
| 128 | PolicyExempt |
| 8192 | ManagePermissions |
| 16384 | PullRequestContribute |
| 32768 | PullRequestBypassPolicy |

The PAT scope `vso.code` is required to access both the repository list and the security namespace. If the credential lacks this scope, the Repositories & ACLs checkbox in Step 2 will be unchecked and grayed out.

## Security groups and nested memberships

ADO security groups can contain users, other ADO groups, or Entra ID groups (AAD-backed). The crawler resolves one level of nesting: it fetches the direct members of each group and records them as `ResourceAssignment` records. Entra-backed groups that appear as members are flagged with `extendedAttributes.originDirectory='aad'` and `extendedAttributes.originId`.

Full recursive membership resolution (transitive members) is provided by the existing `vw_GraphGroupMembersRecursive` view once the data is in PostgreSQL.

## Wizard steps

| Step | What happens |
|---|---|
| **1 — Credentials** | Enter org URL and PAT. Click "Validate & Next" to verify connectivity and check which data scopes are accessible. |
| **2 — Scope** | Choose which entity types to sync. Checkboxes are pre-filled based on what your credentials can access. |
| **3 — Options** | Toggle Entra ID correlation and stakeholder inclusion. |
| **4 — Schedule** | Configure one or more automated run schedules. |

## Scheduling

Schedules work identically to the Entra ID crawler: hourly, daily, or weekly. The web container's scheduler fires jobs into `CrawlerJobs`; the worker picks them up via `POST /api/crawlers/jobs/claim`. The vault secret is resolved server-side when the job is queued — the worker receives the plaintext credential ephemerally in `CrawlerJobs.config._resolvedSecret` and never touches the vault directly.

## Known limitations

- **Rate limits**: ADO allows ~200 REST requests per 5 minutes per user for collection-scoped endpoints. The crawler uses exponential backoff (2 s, 4 s, 8 s, 16 s) on 429 responses.
- **Large organizations**: Member entitlements are fetched with `$top=200` per page. Organizations with thousands of users will require multiple pages — the crawler follows ADO's continuation token.
- **PAT expiry**: PATs expire based on org policy (commonly 30–365 days). A failed scheduled run will show an error in the sync log if the PAT has expired.
- **PAT scope**: Projects the PAT owner cannot access will produce security groups without a resolvable parent project name. Grant the PAT owner Project Reader on all projects for full coverage.
- **Stakeholders**: Stakeholder users (free, limited access) are excluded by default. Enable "Include Stakeholder users" in Step 3 to include them.
- **Repo ACLs — inherited entries**: The security namespace API is queried only for the explicit ACL node at `repoV2/{projectId}/{repoId}`. Entries that are purely inherited from the project level are not included unless they are explicitly set on the repo node.
- **Repo ACLs — scope**: Only Git repository ACLs are synced. Pipeline ACLs, service connection permissions, environment permissions, and library variable group ACLs are not in scope.
- **Repo scope requires `vso.code`**: The PAT must include the `vso.code` scope to access repositories and ACLs. Without it, the Repositories & ACLs scope is unavailable.

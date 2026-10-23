# Core Model Reference

!!! info "Generated page"
    Generated from [`ontology/core.ttl`](https://github.com/Fortigi/IdentityAtlas/blob/main/ontology/core.ttl) by `npm run ontology:generate` in `app/api`.
    Do not edit it by hand: CI fails when it differs from the ontology. How to change the model:
    [Maintaining the Core Ontology](../contributing/maintaining-the-ontology.md).

Ontology `https://identityatlas.io/ontology`, version `2.1.0`. Namespace `https://identityatlas.io/ontology#` (prefix `ia:`).
Download the Turtle file for Protégé, a triple store or any RDF/OWL tool: [core.ttl](https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/ontology/core.ttl).

A column is identified by the property of the same name: `Principals.accountEnabled` is
`ia:accountEnabled` (`https://identityatlas.io/ontology#accountEnabled`). One property serves every core table
that has a column of that name; its `rdfs:domain` lists them. Why the model looks like this, and what is not
in it: [Core Ontology](../architecture/core-ontology.md).

## Type hierarchy and relationship types

<!-- BEGIN GENERATED: ontology core-classes -->
```mermaid
classDiagram
    direction LR
    class AIAgent
    class AccessPermission
    class AdministrativeUnitContext
    class Agent
    class AppRegistration
    class AppRole
    class Application
    class ApplicationOwnership
    class ApplicationPermission
    class AzureManagementGroup
    class AzureResource
    class AzureResourceGroup
    class AzureRoleAssignment
    class AzureScope
    class AzureSubscription
    class BusinessRole
    class CRMRole
    class Context
    class ContextRecipeContext
    class ControlPermission
    class CostCenterContext
    class DelegatedPermission
    class DepartmentContext
    class Entitlement
    class EntraDirectoryRole
    class EntraGroupCategoryContext
    class ExternalUser
    class Group
    class GroupOwnership
    class Identity
    class LocationContext
    class LogicalApplicationContext
    class ManagedIdentity
    class ManagerHierarchyContext
    class OrgUnitContext
    class OrganisationalUnitContext
    class OrganizationalUnit
    class OrphanedAccountsContext
    class Other
    class Permission
    class Person
    class Principal
    class PrincipalTypeContext
    class Resource
    class ResourceClusterContext
    class ResourceOwnership
    class ResourcePlaneContext
    class ResourceRoleContext
    class ResourceTypeContext
    class RiskyAppConsentContext
    class RiskyConsentContext
    class SAPRole
    class Scope
    class ScopeContext
    class Segment
    class Service
    class ServicePrincipal
    class ServicePrincipalOwnership
    class SharedMailbox
    class Software
    class System
    class SystemMembershipContext
    class TagContext
    class TeamContext
    class TechnicalRole
    class UntypedResource
    class User
    class WorkloadIdentity
    Agent <|-- AIAgent
    Permission <|-- AccessPermission
    OrganizationalUnit <|-- AdministrativeUnitContext
    Principal <|-- Agent
    Application <|-- AppRegistration
    TechnicalRole <|-- AppRole
    Resource <|-- Application
    ControlPermission <|-- ApplicationOwnership
    AccessPermission <|-- ApplicationPermission
    Scope <|-- AzureManagementGroup
    Scope <|-- AzureResource
    Scope <|-- AzureResourceGroup
    TechnicalRole <|-- AzureRoleAssignment
    Scope <|-- AzureScope
    Scope <|-- AzureSubscription
    Resource <|-- BusinessRole
    TechnicalRole <|-- CRMRole
    LogicalApplicationContext <|-- ContextRecipeContext
    Permission <|-- ControlPermission
    OrganizationalUnit <|-- CostCenterContext
    AccessPermission <|-- DelegatedPermission
    OrganizationalUnit <|-- DepartmentContext
    AccessPermission <|-- Entitlement
    TechnicalRole <|-- EntraDirectoryRole
    Segment <|-- EntraGroupCategoryContext
    Person <|-- ExternalUser
    Resource <|-- Group
    ControlPermission <|-- GroupOwnership
    Segment <|-- LocationContext
    Context <|-- LogicalApplicationContext
    Software <|-- ManagedIdentity
    OrganizationalUnit <|-- ManagerHierarchyContext
    OrganizationalUnit <|-- OrgUnitContext
    OrganizationalUnit <|-- OrganisationalUnitContext
    Context <|-- OrganizationalUnit
    Segment <|-- OrphanedAccountsContext
    Resource <|-- Other
    Resource <|-- Permission
    Principal <|-- Person
    Segment <|-- PrincipalTypeContext
    Segment <|-- ResourceClusterContext
    ControlPermission <|-- ResourceOwnership
    Segment <|-- ResourcePlaneContext
    Segment <|-- ResourceRoleContext
    Segment <|-- ResourceTypeContext
    Segment <|-- RiskyAppConsentContext
    Segment <|-- RiskyConsentContext
    TechnicalRole <|-- SAPRole
    Resource <|-- Scope
    Segment <|-- ScopeContext
    Context <|-- Segment
    Application <|-- Service
    Software <|-- ServicePrincipal
    ControlPermission <|-- ServicePrincipalOwnership
    Person <|-- SharedMailbox
    Principal <|-- Software
    Segment <|-- SystemMembershipContext
    Context <|-- TagContext
    OrganizationalUnit <|-- TeamContext
    Resource <|-- TechnicalRole
    AccessPermission <|-- UntypedResource
    Person <|-- User
    Software <|-- WorkloadIdentity
    Resource --> Resource : Contains
    Application --> DelegatedPermission : DelegatesScope
    Resource --> Resource : GrantsAccessTo
    Application --> ServicePrincipalOwnership : HasAppOwnership
    Application --> ApplicationOwnership : HasAppOwnership
    Application --> AppRole : HasAppRole
    Application --> ApplicationPermission : HasApplicationPermission
    Resource --> GroupOwnership : HasOwnership
    Resource --> ResourceOwnership : HasOwnership
    Principal --> Principal : Owner
    Context --> Context : SameUnitAs
    Principal --> Principal : Sponsor
```
<!-- END GENERATED: ontology core-classes -->

## Node tables

### Contexts

`ia:Context` · Node table · A grouping of one kind of entity — a department, an OU, a tag, a cluster, a logical application. Synced, generated by a plugin, or manual. contextType is an open vocabulary; the values the application itself knows are its subclasses. A child context has the same targetType as its parent (the routes and plugins keep this, the database does not enforce it), and the tree is acyclic (enforced at commit by trg_Contexts_reject_cycle).

Written by the ingest API as `contexts`.

Identifier: `id` (uuid) — the instance IRI, not a property.

`contextType` is an open vocabulary — any value is accepted. These are the values Identity Atlas itself relies on:

| Value | Class | Template | Groups | Made by | Meaning |
|---|---|---|---|---|---|
| `AdministrativeUnit` | `ia:AdministrativeUnitContext` | Organizational unit | Principal | crawler `demo` | An Entra administrative unit. Only the demo dataset emits it; the Entra crawler does not sync administrative units. |
| `ContextRecipe` | `ia:ContextRecipeContext` | Logical application | Resource | plugin `context-recipe` | Resources matched by a recipe built in the context assistant, plus the ones pinned by hand. The type says how the context was built; its template (contextCategory) is chosen at save time, an application being the common case. |
| `CostCenter` | `ia:CostCenterContext` | Organizational unit | Identity | crawler `omada` | A cost center synced from Omada, grouping persons: an org dimension a manager recognises, so an organizational unit. |
| `Department` | `ia:DepartmentContext` | Organizational unit | Identity, Principal | plugin `department-from-principal`; crawlers `demo`, `omada` | One flat context per distinct Principals.department value (externalId 'dept:<value>'), without hierarchy. The Omada crawler syncs departments of persons under the same value, and the demo dataset writes a department tree of accounts. |
| `EntraGroupCategory` | `ia:EntraGroupCategoryContext` | Segment | Resource | plugin `entra-group-category-tree` | The Entra groups of one category (security, Microsoft 365, dynamic …). |
| `Location` | `ia:LocationContext` | Segment | Identity | crawler `omada` | A work location synced from Omada, grouping persons. |
| `LogicalApplication` | `ia:LogicalApplicationContext` | Logical application | Resource | crawlers `demo`, `mssql` | An application as the business knows it, grouping the technical resources (entitlements, roles, groups) that belong to it. The SQL connector's IdentityIQ preset loads these from the application list. |
| `ManagerHierarchy` | `ia:ManagerHierarchyContext` | Organizational unit | Principal | plugin `manager-hierarchy` | One generated context per manager of one system's accounts, plus a synthetic root (externalId 'root'). The manager is recorded only in externalId, which holds the manager's Principal id — there is no manager column or member role. Members are the manager's direct reports (Principals.managerId, overridden per account by ManagerHierarchyOverrides); the manager is a member of their own manager's node, not of their own. parentContextId is the node of the manager's own manager, else the root. Accounts with no manager that manage nobody are members of the root; a top-level manager is a member of no node. A managerId that points at no account of the system still becomes a node, named 'Unknown'. A reporting cycle, a self-reference included, leaves a node without a parent: the runner refuses the link that would close the cycle. |
| `OrgUnit` | `ia:OrgUnitContext` | Organizational unit | Identity | crawlers `csv`, `midpoint`, `omada` | An organisational unit synced from an IGA or HR source, grouping persons; nested like the source's org tree. The default context type of the Omada, CSV and midPoint crawlers. Not the same value as the OrganisationalUnit the ad-ou-from-dn plugin derives from accounts. |
| `OrganisationalUnit` | `ia:OrganisationalUnitContext` | Organizational unit | Principal | plugin `ad-ou-from-dn` | An Active Directory OU derived from the accounts' distinguished names, nested like the directory. Crawlers that sync org units (Omada, CSV, midPoint) store 'OrgUnit' instead — a different value the ontology does not define. |
| `OrphanedAccounts` | `ia:OrphanedAccountsContext` | Segment | Principal | plugin `orphaned-accounts` | Accounts that are not linked to any identity. |
| `PrincipalType` | `ia:PrincipalTypeContext` | Segment | Principal | plugin `principal-type-tree` | The accounts of one principalType. |
| `ResourceCluster` | `ia:ResourceClusterContext` | Segment | Resource | plugin `resource-cluster` | Resources whose names cluster together. |
| `ResourcePlane` | `ia:ResourcePlaneContext` | Segment | Resource | plugin `resource-type-tree` | Control or data plane below a resource type group. |
| `ResourceRole` | `ia:ResourceRoleContext` | Segment | Resource | plugin `resource-type-tree` | One role name below a resource plane. |
| `ResourceType` | `ia:ResourceTypeContext` | Segment | Resource | plugin `resource-type-tree` | The resources of one resourceType. |
| `RiskyAppConsent` | `ia:RiskyAppConsentContext` | Segment | Resource | plugin `risky-consent` | Applications flagged as malicious (threat feed) or suspicious (heuristics). |
| `RiskyConsent` | `ia:RiskyConsentContext` | Segment | Resource | plugin `risky-consent` | Granted permissions of one risk tier (High, Medium, Low). |
| `Scope` | `ia:ScopeContext` | Segment | Resource | plugin `scope-hierarchy` | A node of the scope-hierarchy tree, the root included: one Azure scope (management group, subscription, resource group). The resource's own type is in extendedAttributes.resourceType. |
| `SystemMembership` | `ia:SystemMembershipContext` | Segment | Principal, Resource | plugin `system-membership-principals`, `system-membership-resources` | The accounts, or the resources, loaded from one system. |
| `Tag` | `ia:TagContext` | Tag | Identity, Principal, Resource | application code | A manual label (variant 'manual') that the tags API reads and writes. One root per targetType holds them, itself a Tag marked extendedAttributes.tagRoot = true, which the tags API and the GraphTags view leave out. |
| `Team` | `ia:TeamContext` | Organizational unit | Principal, Resource | crawler `demo` | A team below a department, as its people or as the resources it administers (the two linked by sameUnitAs). Only the demo dataset emits it. |

Other values arrive from the source data or configuration of: `csv`, `custom-connector`, `midpoint`, `mssql`, `omada`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `contextCategory` | `ia:contextCategory` | text | `OrganizationalUnit`, `LogicalApplication`, `Tag`, `Segment` | The template this context falls under. NULL for a synced value nobody has placed yet. |
| `contextType` | `ia:contextType` | text | open vocabulary | What kind of grouping this is (Department, OrgUnit, Tag, Cluster, LogicalApplication, …). An open vocabulary. |
| `createdAt` | `ia:createdAt` | timestamp with time zone |  | When the context row was created. |
| `createdByUser` | `ia:createdByUser` | text |  | The analyst who created a manual context. |
| `description` | `ia:description` | text |  | Free-text description. |
| `directAssignmentCount` | `ia:directAssignmentCount` | integer |  | Stored count of Direct (resource, holder) pairs over the resources in this context. |
| `directMemberCount` | `ia:directMemberCount` | integer |  | Stored count of direct members. |
| `displayName` | `ia:displayName` | text |  | Human-readable name. On IdentityMembers a copy of the account name. |
| `eligibleAssignmentCount` | `ia:eligibleAssignmentCount` | integer |  | Stored count of Eligible (resource, holder) pairs over the resources in this context. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `externalId` | `ia:externalId` | text |  | The object's id in its source system. |
| `holderCount` | `ia:holderCount` | integer |  | Stored count of distinct holders over the resources in this context. |
| `indirectAssignmentCount` | `ia:indirectAssignmentCount` | integer |  | Stored count of Indirect (resource, holder) pairs over the resources in this context. |
| `lastCalculatedAt` | `ia:lastCalculatedAt` | timestamp with time zone |  | When the stored counts were last recalculated. |
| `ownerUserId` | `ia:ownerUserId` | text |  | Whatever the source calls the owner of the grouping (free text, resolved to a principal for display). |
| `parentContextId` | `ia:parentContextId` | uuid | → Contexts | The parent context in the tree. Ingest alias: `parentExternalId`. |
| `resourceCount` | `ia:resourceCount` | integer |  | Stored count of resources in this context. |
| `scopeSystemId` | `ia:scopeSystemId` | integer | → Systems | The system a synced or generated context is scoped to. |
| `sourceAlgorithmId` | `ia:sourceAlgorithmId` | uuid |  | The context-algorithm (ContextAlgorithms.id) that generated the context. ContextAlgorithms is outside the core model. |
| `sourceInstanceKey` | `ia:sourceInstanceKey` | text |  | Distinguishes several trees generated by one plugin on one system. |
| `sourceRunId` | `ia:sourceRunId` | uuid |  | The plugin run that generated the context. |
| `targetType` | `ia:targetType` | text | `Identity`, `Resource`, `Principal`, `System` | Which kind of node the context groups. |
| `totalMemberCount` | `ia:totalMemberCount` | integer |  | Stored count of members including sub-contexts. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |
| `userRenamed` | `ia:userRenamed` | boolean |  | An analyst renamed this generated context; re-runs keep the name. |
| `userReparented` | `ia:userReparented` | boolean |  | An analyst moved this generated context; re-runs keep the placement. |
| `variant` | `ia:variant` | text | `synced`, `generated`, `manual` | How the context came to exist. |

### Identities

`ia:Identity` · Node table · A real person, aggregated from one or more accounts (principals) through IdentityMembers.

Written by the ingest API as `identities`.

Identifier: `id` (uuid) — the instance IRI, not a property.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `accountCount` | `ia:accountCount` | integer |  | Number of accounts linked to this person. |
| `accountTypes` | `ia:accountTypes` | jsonb |  | The account categories this person holds. |
| `analystNotes` | `ia:analystNotes` | text |  | Free-text analyst notes on the person. |
| `analystVerified` | `ia:analystVerified` | boolean |  | An analyst has verified this person. |
| `city` | `ia:city` | text |  | The person's city. |
| `companyName` | `ia:companyName` | text |  | Company name. |
| `country` | `ia:country` | text |  | The person's country. |
| `department` | `ia:department` | text |  | Department name as a plain attribute (organisational placement itself is a Context). |
| `displayName` | `ia:displayName` | text |  | Human-readable name. On IdentityMembers a copy of the account name. |
| `email` | `ia:email` | text |  | E-mail address. |
| `employeeId` | `ia:employeeId` | text |  | Employee number. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `givenName` | `ia:givenName` | text |  | Given name. |
| `hrAccountId` | `ia:hrAccountId` | text |  | The HR record id the person is anchored on. |
| `isHrAnchored` | `ia:isHrAnchored` | boolean |  | The person is anchored on an HR record. |
| `jobTitle` | `ia:jobTitle` | text |  | Job title. |
| `linkConfidence` | `ia:linkConfidence` | integer |  | Account Linking confidence score; NULL for crawler-sourced links. |
| `linkSignals` | `ia:linkSignals` | jsonb |  | The signals Account Linking matched on. |
| `linkedAt` | `ia:linkedAt` | timestamp with time zone |  | When Account Linking last linked the person. |
| `managerIdentityId` | `ia:managerIdentityId` | uuid | → Identities | The manager as a PERSON. Ingest alias: `managerIdentityExternalId`. |
| `officeLocation` | `ia:officeLocation` | text |  | The person's office. |
| `orphanStatus` | `ia:orphanStatus` | text |  | **Retired.** Orphan-ness is the generated Orphaned Accounts context now; the column is kept in the schema for compatibility. |
| `primaryPrincipalId` | `ia:primaryPrincipalId` | uuid | → Principals | The person's primary account. |
| `surname` | `ia:surname` | text |  | Surname. |

### Principals

`ia:Principal` · Node table · An account in a source system: a user, service principal, managed identity, AI agent, guest, shared mailbox …

Written by the ingest API as `principals`.

Identifier: `id` (uuid) — the instance IRI, not a property.

`principalType` accepts exactly these values:

| Value | Class | Template | Made by | Meaning |
|---|---|---|---|---|
| `AIAgent` | `ia:AIAgent` | Agent | crawlers `demo`, `entra-id` | An AI agent (Copilot Studio, Azure OpenAI, a custom bot) that holds access as its own account. |
| `ExternalUser` | `ia:ExternalUser` | Person | crawlers `demo`, `omada` | A guest / B2B account from another organisation. |
| `ManagedIdentity` | `ia:ManagedIdentity` | Software | crawlers `demo`, `entra-id` | A system- or user-assigned identity attached to a cloud resource. |
| `ServicePrincipal` | `ia:ServicePrincipal` | Software | crawlers `demo`, `entra-id`, `omada` | The service principal of an application registration. |
| `SharedMailbox` | `ia:SharedMailbox` | Person | crawler `demo` | A shared, room or equipment mailbox account. Accepted from CSV, SQL, SCIM and midPoint sources; of the built-in sources only the demo dataset writes it. |
| `User` | `ia:User` | Person | crawlers `azure-rm`, `csv`, `demo`, `entra-id`, `midpoint`, `mssql`, `omada`, `scim` | An interactive human user account. |
| `WorkloadIdentity` | `ia:WorkloadIdentity` | Software | no built-in source | A federated-credential identity used by a workload (a pipeline, a Kubernetes service account). Accepted from CSV, SQL, SCIM and midPoint sources; the Entra crawler deliberately does not classify accounts this way. |

Mapped onto this list from the source data or configuration by: `csv`, `custom-connector`, `midpoint`, `mssql`, `omada`, `scim`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `accountEnabled` | `ia:accountEnabled` | boolean |  | Whether the account can sign in. On IdentityMembers a copy taken when the link was made. |
| `companyName` | `ia:companyName` | text |  | Company name. |
| `createdDateTime` | `ia:createdDateTime` | timestamp with time zone |  | When the object was created in the source (PrincipalRelationships: when the row was created). |
| `deletedAt` | `ia:deletedAt` | timestamp with time zone |  | Soft-delete tombstone: set when the source stopped reporting the row; NULL while live. |
| `department` | `ia:department` | text |  | Department name as a plain attribute (organisational placement itself is a Context). |
| `displayName` | `ia:displayName` | text |  | Human-readable name. On IdentityMembers a copy of the account name. |
| `email` | `ia:email` | text |  | E-mail address. |
| `employeeId` | `ia:employeeId` | text |  | Employee number. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `externalId` | `ia:externalId` | text |  | The object's id in its source system. |
| `givenName` | `ia:givenName` | text |  | Given name. |
| `jobTitle` | `ia:jobTitle` | text |  | Job title. |
| `managerId` | `ia:managerId` | uuid | → Principals | The manager's ACCOUNT. Ingest alias: `managerExternalId`. |
| `photo` | `ia:photo` | bytea |  | Profile photo (sent base64 to the ingest). |
| `photoContentType` | `ia:photoContentType` | text |  | MIME type of the photo. |
| `photoFetchedAt` | `ia:photoFetchedAt` | timestamp with time zone |  | When the photo was last fetched; set with a NULL photo means "has none". |
| `principalType` | `ia:principalType` | text | `User`, `ServicePrincipal`, `ManagedIdentity`, `WorkloadIdentity`, `AIAgent`, `ExternalUser`, `SharedMailbox` | The kind of account. On Principals it selects the subclass; on ResourceAssignments it is a denormalised copy of the holder's type. |
| `riskScore` | `ia:riskScore` | integer |  | Latest risk score, denormalised from RiskScores. |
| `riskTier` | `ia:riskTier` | text |  | Latest risk tier, denormalised from RiskScores. |
| `surname` | `ia:surname` | text |  | Surname. |
| `systemId` | `ia:systemId` | integer | → Systems | The system that sourced the row. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |

### Resources

`ia:Resource` · Node table · Anything that grants access — a group, a directory role, an app role, a permission — and also a business role (governance construct).

Written by the ingest API as `resources`.

Identifier: `id` (uuid) — the instance IRI, not a property.

`resourceType` is an open vocabulary — any value is accepted. These are the values Identity Atlas itself relies on:

| Value | Class | Template | Made by | Meaning |
|---|---|---|---|---|
| `AppRegistration` | `ia:AppRegistration` | Application | crawler `entra-id` | An app registration (id = application object id; appId joins it to its service principal). Grants nothing and has no assignments; carries the app's security set-up (credential metadata, redirect URIs, required resource access, federated credentials). |
| `AppRole` | `ia:AppRole` | Technical role | crawlers `demo`, `entra-id` | One app role of an application (one resource per application + appRoleId). |
| `Application` | `ia:Application` | Application | crawlers `demo`, `entra-id` | An enterprise application (service principal) as a resource. Grants nothing by itself; parent of its app roles and permissions. |
| `ApplicationOwnership` | `ia:ApplicationOwnership` | Permission | crawlers `demo`, `entra-id` | The owners of an app registration — they can add a credential and act as the app. |
| `ApplicationPermission` | `ia:ApplicationPermission` | Permission | crawler `entra-id` | One app-only (admin-consented) permission a service principal holds on another API. |
| `AzureManagementGroup` | `ia:AzureManagementGroup` | Scope | crawler `azure-rm` | An Azure management group; Contains the management groups and subscriptions below it. |
| `AzureResource` | `ia:AzureResource` | Scope | crawlers `azure-rm`, `demo` | One Azure resource. Its ARM type (Microsoft.Compute/virtualMachines …) is in extendedAttributes.azureResourceType, not in resourceType. |
| `AzureResourceGroup` | `ia:AzureResourceGroup` | Scope | crawlers `azure-rm`, `demo` | An Azure resource group; Contains its resources. |
| `AzureRoleAssignment` | `ia:AzureRoleAssignment` | Technical role | crawlers `azure-rm`, `demo` | One Azure RBAC role at one scope (role definition + scope); holders have it Direct, or Indirect through a group or an inherited scope. |
| `AzureScope` | `ia:AzureScope` | Scope | crawlers `azure-rm`, `demo` | The tenant root scope ('/') of Azure Resource Manager, above every management group. |
| `AzureSubscription` | `ia:AzureSubscription` | Scope | crawler `azure-rm` | An Azure subscription; Contains its resource groups. |
| `BusinessRole` | `ia:BusinessRole` | Business role | crawlers `csv`, `demo`, `entra-id`, `midpoint`, `mssql`, `omada` | A governance construct (Entra access package, Omada / midPoint business role). Contains the resources it grants; hidden from the matrix by default. |
| `CRMRole` | `ia:CRMRole` | Technical role | crawler `demo` | A role in a CRM system. Only the demo dataset emits it. |
| `DelegatedPermission` | `ia:DelegatedPermission` | Permission | crawlers `demo`, `entra-id` | One OAuth2 delegated scope granted to a client application on an API (one resource per client, API and scope). |
| `Entitlement` | `ia:Entitlement` | Permission | crawlers `midpoint`, `mssql` | A permission in a target application, as an IGA system records it (a midPoint entitlement shadow, an IdentityIQ entitlement). |
| `EntraDirectoryRole` | `ia:EntraDirectoryRole` | Technical role | crawlers `demo`, `entra-id` | One Entra directory role (id = roleDefinitionId); extendedAttributes holds its allowedResourceActions. |
| `Group` | `ia:Group` | Group | crawlers `demo`, `entra-id`, `scim` | A security or Microsoft 365 group. The effective-access engine expands membership through it. |
| `GroupOwnership` | `ia:GroupOwnership` | Permission | crawlers `demo`, `entra-id` | The owners of an Entra group. |
| `Resource` | `ia:UntypedResource` | Permission | crawler `omada` | A resource the source does not classify further. Omada's default for permissions; the source's own type is in extendedAttributes.resourceType. |
| `ResourceOwnership` | `ia:ResourceOwnership` | Permission | crawler `mssql` | The owners of a resource loaded by the SQL connector; the owned resource's own type is in extendedAttributes.ownedResourceType. |
| `SAPRole` | `ia:SAPRole` | Technical role | crawler `demo` | An SAP role. Only the demo dataset emits it; a real SAP source would arrive through CSV or SQL with a value of its own choosing. |
| `Service` | `ia:Service` | Application | crawler `midpoint` | A service (an application or system) as midPoint models it. |
| `ServicePrincipalOwnership` | `ia:ServicePrincipalOwnership` | Permission | crawlers `demo`, `entra-id` | The owners of an enterprise application's service principal. |

Other values arrive from the source data or configuration of: `csv`, `custom-connector`, `midpoint`, `mssql`, `omada`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `capabilityId` | `ia:capabilityId` | text |  | Generated from extendedAttributes.capabilityId for the effective-access engine. |
| `catalogId` | `ia:catalogId` | uuid |  | The governance catalog (GovernanceCatalogs.id) a business role belongs to. GovernanceCatalogs is outside the core model. |
| `createdDateTime` | `ia:createdDateTime` | timestamp with time zone |  | When the object was created in the source (PrincipalRelationships: when the row was created). |
| `deletedAt` | `ia:deletedAt` | timestamp with time zone |  | Soft-delete tombstone: set when the source stopped reporting the row; NULL while live. |
| `description` | `ia:description` | text |  | Free-text description. |
| `displayName` | `ia:displayName` | text |  | Human-readable name. On IdentityMembers a copy of the account name. |
| `enabled` | `ia:enabled` | boolean |  | Whether the system or resource is enabled. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `externalId` | `ia:externalId` | text |  | The object's id in its source system. |
| `governanceResource` | `ia:governanceResource` | boolean |  | The resource is a governance construct that governs other access (business roles). |
| `isHidden` | `ia:isHidden` | boolean |  | Hidden from the default views. |
| `mail` | `ia:mail` | text |  | Mail address of a mail-enabled resource. |
| `modifiedDateTime` | `ia:modifiedDateTime` | timestamp with time zone |  | When the object was last modified in the source (PrincipalRelationships: when the row was last modified). |
| `resourceType` | `ia:resourceType` | text | open vocabulary | The kind of resource (open vocabulary). On Resources it selects the subclass; on ResourceAssignments it is a denormalised copy used to partition reconciles. |
| `riskScore` | `ia:riskScore` | integer |  | Latest risk score, denormalised from RiskScores. |
| `riskTier` | `ia:riskTier` | text |  | Latest risk tier, denormalised from RiskScores. |
| `systemId` | `ia:systemId` | integer | → Systems | The system that sourced the row. |
| `targetNodeId` | `ia:targetNodeId` | text |  | Generated from extendedAttributes.targetNodeId: the node a capability resource applies to. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |
| `visibility` | `ia:visibility` | text |  | Visibility as the source reports it (Public / Private for groups). |

### Systems

`ia:System` · Node table · A connected authorization source (Entra ID, Omada, a SQL database, a CSV feed …). Principals, resources and synced contexts belong to one system.

Written by the ingest API as `systems`.

Identifier: `id` (integer) — the instance IRI, not a property.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `assignmentTypes` | `ia:assignmentTypes` | jsonb |  | **Unused.** Meant to list the assignment types a system emits. Nothing reads or writes it. |
| `description` | `ia:description` | text |  | Free-text description. |
| `directorySystemId` | `ia:directorySystemId` | integer | → Systems | The directory system whose principals this system references but does not own (Azure RM -> Entra ID). |
| `displayName` | `ia:displayName` | text |  | Human-readable name. On IdentityMembers a copy of the account name. |
| `enabled` | `ia:enabled` | boolean |  | Whether the system or resource is enabled. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `lastSyncDateTime` | `ia:lastSyncDateTime` | timestamp with time zone |  | When the system was last synced. |
| `resourceTypes` | `ia:resourceTypes` | jsonb |  | **Unused.** Meant to list the resource types a system emits. Nothing reads or writes it. |
| `syncEnabled` | `ia:syncEnabled` | boolean |  | Whether the system is synced. |
| `systemType` | `ia:systemType` | text |  | The connector kind (EntraID, Omada, CSV, …). Together with tenantId the system key. |
| `tenantId` | `ia:tenantId` | text |  | The tenant / instance the system connects to. |

## Edge tables

### ContextMembers

`ia:ContextMember` · Edge table · Membership of an identity, principal, resource or system in a context. memberType says which table memberId points at.

Written by the ingest API as `context-members`.

Edge: `contextId` → `memberId`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `addedAt` | `ia:addedAt` | timestamp with time zone |  | When the member was added. |
| `addedBy` | `ia:addedBy` | text | `sync`, `algorithm`, `analyst` | Who added the member. |
| `contextId` | `ia:contextId` | uuid | → Contexts | The context. Ingest alias: `contextExternalId`. |
| `memberId` | `ia:memberId` | uuid | → Identities / Resources / Principals / Systems | The member; memberType names its table. Ingest alias: `memberExternalId`. |
| `memberType` | `ia:memberType` | text | `Identity`, `Resource`, `Principal`, `System` | Which kind of node memberId is. |

### ContextRelationships

`ia:ContextRelationship` · Edge table · A typed link between two contexts: two variants of one unit (its people, its accounts, its resources).

Identifier: `id` (uuid) — the instance IRI, not a property.

Edge: `contextId` → `relatedContextId`.

`relationshipType` accepts exactly these relationship types:

| Value | Property | From → to | Meaning |
|---|---|---|---|
| `SameUnitAs` | `ia:sameUnitAs` | ia:Context → ia:Context | The two contexts are one unit seen through a different kind of member: Contoso as its people, its accounts, its resources. Symmetric; stored once per pair. Each side still holds one kind of member, and the two hold different kinds. |

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `addedBy` | `ia:addedBy` | text | `sync`, `algorithm`, `analyst` | Who added the member. |
| `contextId` | `ia:contextId` | uuid | → Contexts | The context. Ingest alias: `contextExternalId`. |
| `createdAt` | `ia:createdAt` | timestamp with time zone |  | When the context row was created. |
| `relatedContextId` | `ia:relatedContextId` | uuid | → Contexts | The other context of the link. |
| `relationshipType` | `ia:relationshipType` | text | `SameUnitAs` | The relationship type: one of the ia:typeValue of the properties stored in this edge table. |

### ContextRoles

`ia:ContextRole` · Edge table · Who answers for a context: one account (principalId) or one person (identityId) — exactly one — is Accountable (at most one per context) or Responsible for it. A context→person link, never access: it is not an assignment and grants nothing.

Identifier: `id` (uuid) — the instance IRI, not a property.

Edge: `contextId` → `principalId` or `identityId`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `addedBy` | `ia:addedBy` | text | `sync`, `algorithm`, `analyst` | Who added the member. |
| `contextId` | `ia:contextId` | uuid | → Contexts | The context. Ingest alias: `contextExternalId`. |
| `createdAt` | `ia:createdAt` | timestamp with time zone |  | When the context row was created. |
| `identityId` | `ia:identityId` | uuid | → Identities | The person. On ResourceAssignments set instead of principalId for person-level assignments. Ingest alias: `identityExternalId`. |
| `principalId` | `ia:principalId` | uuid | → Principals | The account. On ResourceAssignments NULL when identityId is set; on PrincipalRelationships the subject that HAS the owner / sponsor. Ingest alias: `principalExternalId`, `userExternalId`. |
| `role` | `ia:role` | text | `Accountable`, `Responsible` | Accountable or Responsible. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |

### IdentityMembers

`ia:IdentityMember` · Edge table · Links a person (identity) to one of their accounts (principal), from a crawler or from Account Linking.

Written by the ingest API as `identity-members`.

Edge: `identityId` → `principalId`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `accountEnabled` | `ia:accountEnabled` | boolean |  | Whether the account can sign in. On IdentityMembers a copy taken when the link was made. |
| `accountType` | `ia:accountType` | text |  | Account category detected by Account Linking (Admin, Guest, Service, Shared, Secondary, …). |
| `accountTypePattern` | `ia:accountTypePattern` | text |  | The naming pattern that classified accountType. |
| `analystOverride` | `ia:analystOverride` | text |  | An analyst's verdict on a link (confirmed / rejected / moved); Account Linking honours it on every run. |
| `displayName` | `ia:displayName` | text |  | Human-readable name. On IdentityMembers a copy of the account name. |
| `hrIndicators` | `ia:hrIndicators` | jsonb |  | Signals that made this account look HR-authoritative. |
| `hrScore` | `ia:hrScore` | integer |  | How strongly this account looks like the HR record. |
| `identityId` | `ia:identityId` | uuid | → Identities | The person. On ResourceAssignments set instead of principalId for person-level assignments. Ingest alias: `identityExternalId`. |
| `isHrAuthoritative` | `ia:isHrAuthoritative` | boolean |  | This account is the HR-authoritative one. |
| `isPrimary` | `ia:isPrimary` | boolean |  | This is the person's primary account. |
| `linkConfidence` | `ia:linkConfidence` | integer |  | Account Linking confidence score; NULL for crawler-sourced links. |
| `linkSignals` | `ia:linkSignals` | jsonb |  | The signals Account Linking matched on. |
| `principalId` | `ia:principalId` | uuid | → Principals | The account. On ResourceAssignments NULL when identityId is set; on PrincipalRelationships the subject that HAS the owner / sponsor. Ingest alias: `principalExternalId`, `userExternalId`. |

### PrincipalRelationships

`ia:PrincipalRelationship` · Edge table · A responsibility link between two accounts: relatedPrincipalId is the Owner / Sponsor OF principalId.

Written by the ingest API as `principal-relationships`.

Edge: `principalId` → `relatedPrincipalId`.

`relationshipType` accepts exactly these relationship types:

| Value | Property | From → to | Meaning |
|---|---|---|---|
| `Owner` | `ia:owner` | ia:Principal → ia:Principal | The object is an owner of the subject (typically of an AI agent or service principal). |
| `Sponsor` | `ia:sponsor` | ia:Principal → ia:Principal | The object is a sponsor of the subject (typically of a guest account). |

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `createdDateTime` | `ia:createdDateTime` | timestamp with time zone |  | When the object was created in the source (PrincipalRelationships: when the row was created). |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `externalId` | `ia:externalId` | text |  | The object's id in its source system. |
| `modifiedDateTime` | `ia:modifiedDateTime` | timestamp with time zone |  | When the object was last modified in the source (PrincipalRelationships: when the row was last modified). |
| `principalId` | `ia:principalId` | uuid | → Principals | The account. On ResourceAssignments NULL when identityId is set; on PrincipalRelationships the subject that HAS the owner / sponsor. Ingest alias: `principalExternalId`, `userExternalId`. |
| `relatedPrincipalId` | `ia:relatedPrincipalId` | uuid | → Principals | The owner / sponsor. Ingest alias: `relatedPrincipalExternalId`. |
| `relationshipType` | `ia:relationshipType` | text | `Owner`, `Sponsor` | The relationship type: one of the ia:typeValue of the properties stored in this edge table. |
| `systemId` | `ia:systemId` | integer | → Systems | The system that sourced the row. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |

### ResourceAssignments

`ia:ResourceAssignment` · Edge table · Who holds what: one account (principalId) or one person (identityId) — exactly one of the two — holds one resource, Direct / Indirect / Eligible, optionally governed.

Written by the ingest API as `resource-assignments`, `resource-assignments-identity`.

Edge: `principalId` or `identityId` → `resourceId`.

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `assignmentStatus` | `ia:assignmentStatus` | text |  | The source system's own status word for the assignment. |
| `assignmentType` | `ia:assignmentType` | text | `Direct`, `Indirect`, `Eligible` | How the access is held. |
| `complianceState` | `ia:complianceState` | text |  | The source system's compliance verdict for the assignment. |
| `deletedAt` | `ia:deletedAt` | timestamp with time zone |  | Soft-delete tombstone: set when the source stopped reporting the row; NULL while live. |
| `effect` | `ia:effect` | text | `allow`, `deny`, `eligible`, `notset` | What the assignment does to effective access. |
| `expirationDateTime` | `ia:expirationDateTime` | timestamp with time zone |  | When the assignment expires. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `governed` | `ia:governed` | boolean |  | The row is governance intent (a business-role / access-package assignment) rather than observed access. Part of the key. |
| `identityId` | `ia:identityId` | uuid | → Identities | The person. On ResourceAssignments set instead of principalId for person-level assignments. Ingest alias: `identityExternalId`. |
| `origin` | `ia:origin` | text | `Automatic`, `Requested`, `Discovered` | Where the assignment came from, as the source records it. Optional. |
| `originDetail` | `ia:originDetail` | text |  | The source's own word for the origin. |
| `policyId` | `ia:policyId` | uuid |  | The assignment policy (AssignmentPolicies.id) behind a governed assignment. AssignmentPolicies is outside the core model. |
| `principalId` | `ia:principalId` | uuid | → Principals | The account. On ResourceAssignments NULL when identityId is set; on PrincipalRelationships the subject that HAS the owner / sponsor. Ingest alias: `principalExternalId`, `userExternalId`. |
| `principalType` | `ia:principalType` | text |  | The kind of account. On Principals it selects the subclass; on ResourceAssignments it is a denormalised copy of the holder's type. |
| `propagationScope` | `ia:propagationScope` | text | `self`, `descendants`, `selfAndDescendants` | Where along a containment hierarchy the assignment applies. |
| `resourceId` | `ia:resourceId` | uuid | → Resources | The resource that is held. Ingest alias: `resourceExternalId`. |
| `resourceType` | `ia:resourceType` | text |  | The kind of resource (open vocabulary). On Resources it selects the subclass; on ResourceAssignments it is a denormalised copy used to partition reconciles. |
| `state` | `ia:state` | text |  | The source system's state word for the assignment (for example Delivered). |
| `systemId` | `ia:systemId` | integer | → Systems | The system that sourced the row. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |

### ResourceRelationships

`ia:ResourceRelationship` · Edge table · A typed link from a parent resource to a child resource.

Written by the ingest API as `resource-relationships`.

Edge: `parentResourceId` → `childResourceId`.

`relationshipType` accepts exactly these relationship types:

| Value | Property | From → to | Meaning |
|---|---|---|---|
| `Contains` | `ia:contains` | ia:Resource → ia:Resource | The child is part of the parent: a business role's granted resources, a scope inside a scope. Holding the parent reaches the child. |
| `DelegatesScope` | `ia:delegatesScope` | ia:Application → ia:DelegatedPermission | A client application and a delegated permission it was granted. |
| `GrantsAccessTo` | `ia:grantsAccessTo` | ia:Resource → ia:Resource | Holding the parent implies access to the child. Emitted by the CSV and SQL connectors and the demo dataset; no built-in crawler uses it. |
| `HasAppOwnership` | `ia:hasAppOwnership` | ia:Application → ia:ServicePrincipalOwnership / ia:ApplicationOwnership | Same meaning as hasOwnership, for applications. A separate value only so the group-owner full sync cannot reconcile app-owner links away. |
| `HasAppRole` | `ia:hasAppRole` | ia:Application → ia:AppRole | An application and one of its app roles. |
| `HasApplicationPermission` | `ia:hasApplicationPermission` | ia:Application → ia:ApplicationPermission | A client application and an app-only permission it holds. |
| `HasOwnership` | `ia:hasOwnership` | ia:Resource → ia:GroupOwnership / ia:ResourceOwnership | An owned resource and the ownership resource whose holders are its owners (Entra groups, SQL-connector resources). |

| Column | Property | SQL type | Values / references | Description |
|---|---|---|---|---|
| `childResourceId` | `ia:childResourceId` | uuid | → Resources | The child (target) resource. Ingest alias: `childExternalId`. |
| `extendedAttributes` | `ia:extendedAttributes` | jsonb |  | Source-specific attributes that have no column of their own. |
| `parentResourceId` | `ia:parentResourceId` | uuid | → Resources | The parent (source) resource. Ingest alias: `parentExternalId`. |
| `relationshipType` | `ia:relationshipType` | text | `Contains`, `GrantsAccessTo`, `HasAppRole`, `DelegatesScope`, `HasApplicationPermission`, `HasOwnership`, `HasAppOwnership` | The relationship type: one of the ia:typeValue of the properties stored in this edge table. |
| `roleName` | `ia:roleName` | text |  | The role the child plays inside the parent (for example the access-package resource role). |
| `roleOriginSystem` | `ia:roleOriginSystem` | text |  | Where that role is defined. |
| `systemId` | `ia:systemId` | integer | → Systems | The system that sourced the row. |
| `updatedAt` | `ia:updatedAt` | timestamp with time zone |  | When the row was last written by the ingest (full-sync reconcile cutoff). |

## Value lists

### Assignment effect

`ia:AssignmentEffect` — What an assignment does to effective access (read by the effective-access engine). Used by `ResourceAssignments.effect`.

| Value | Individual | Meaning |
|---|---|---|
| `allow` | `ia:AssignmentEffect_allow` | A concrete grant. |
| `deny` | `ia:AssignmentEffect_deny` | An explicit deny. |
| `eligible` | `ia:AssignmentEffect_eligible` | Potential access only; excluded from effective answers. |
| `notset` | `ia:AssignmentEffect_notset` | Neither grants nor denies. |

### Assignment origin

`ia:AssignmentOrigin` — Where an assignment came from, as the source records it. Optional. Used by `ResourceAssignments.origin`.

| Value | Individual | Meaning |
|---|---|---|
| `Automatic` | `ia:AssignmentOrigin_Automatic` | Assigned by a rule or birthright policy. |
| `Requested` | `ia:AssignmentOrigin_Requested` | Assigned through an access request. |
| `Discovered` | `ia:AssignmentOrigin_Discovered` | Found on the target system without a recorded reason. |

### Assignment type

`ia:AssignmentType` — How an assignment is held. Only these three values exist; ownership, governance and source detail are modelled elsewhere. Used by `ResourceAssignments.assignmentType`.

| Value | Individual | Meaning |
|---|---|---|
| `Direct` | `ia:AssignmentType_Direct` | Held directly: a membership, a directly assigned app role, an OAuth2 grant, an ownership. |
| `Indirect` | `ia:AssignmentType_Indirect` | Inherited through another resource (an app role held via a group, a nested group). Stored, not inferred. |
| `Eligible` | `ia:AssignmentType_Eligible` | Granted but not active (PIM-eligible): can be activated. |

### Context category

`ia:ContextCategory` — The template a context falls under, stored per row (Contexts.contextCategory). Each value denotes the ia:template class of that name. Used by `Contexts.contextCategory`.

| Value | Individual | Meaning |
|---|---|---|
| `OrganizationalUnit` | `ia:ContextCategory_OrganizationalUnit` | Organisation structure. |
| `LogicalApplication` | `ia:ContextCategory_LogicalApplication` | An application as the business knows it. |
| `Tag` | `ia:ContextCategory_Tag` | A manual label. |
| `Segment` | `ia:ContextCategory_Segment` | A grouping by an attribute or an analysis. |

### Context role

`ia:ContextRoleType` — What a person is to a context. Only an OrganizationalUnit or a LogicalApplication carries roles. Used by `ContextRoles.role`.

| Value | Individual | Meaning |
|---|---|---|
| `Accountable` | `ia:ContextRoleType_Accountable` | Answers for the unit or application: its manager or owner. At most one per context. |
| `Responsible` | `ia:ContextRoleType_Responsible` | Does the work the accountable person delegated. Any number per context. |

### Context variant

`ia:ContextVariant` — How a context came to exist. Used by `Contexts.variant`.

| Value | Individual | Meaning |
|---|---|---|
| `synced` | `ia:ContextVariant_synced` | Ingested from a source system. |
| `generated` | `ia:ContextVariant_generated` | Emitted by a context-algorithm plugin. |
| `manual` | `ia:ContextVariant_manual` | Curated by an analyst (tags included). |

### Entity kind

`ia:EntityKind` — The kind of node a context groups (targetType) or a context member is (memberType). Used by `ContextMembers.memberType`, `Contexts.targetType`.

| Value | Individual | Meaning |
|---|---|---|
| `Identity` | `ia:EntityKind_Identity` | Members are identities. |
| `Resource` | `ia:EntityKind_Resource` | Members are resources. |
| `Principal` | `ia:EntityKind_Principal` | Members are principals. |
| `System` | `ia:EntityKind_System` | Members are systems. Note: memberId is a uuid and Systems.id an integer, so a System member row cannot reference a system by id. |

### Membership source

`ia:MembershipSource` — Who put a member into a context. Used by `ContextMembers.addedBy`, `ContextRelationships.addedBy`, `ContextRoles.addedBy`.

| Value | Individual | Meaning |
|---|---|---|
| `sync` | `ia:MembershipSource_sync` | A crawler. |
| `algorithm` | `ia:MembershipSource_algorithm` | A context-algorithm plugin. |
| `analyst` | `ia:MembershipSource_analyst` | An analyst, by hand. |

### Propagation scope

`ia:PropagationScope` — Where along a containment hierarchy an assignment applies. Used by `ResourceAssignments.propagationScope`.

| Value | Individual | Meaning |
|---|---|---|
| `self` | `ia:PropagationScope_self` | Only at the assigned resource. |
| `descendants` | `ia:PropagationScope_descendants` | Only below the assigned resource. |
| `selfAndDescendants` | `ia:PropagationScope_selfAndDescendants` | At the assigned resource and everything below it (the default). |

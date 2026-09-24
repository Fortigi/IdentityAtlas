# The Ask assistant: what the model does, what it is told, and how it is tested

The same assistant answers in the **Ask** tab of the web app and in the **Teams bot**. It is a
front end on the [report generator](report-generator.md): a small language model running on
your own hardware turns a question into a **report definition**, the API checks and corrects
that definition, runs it as read-only SQL, and shows the rows. The model never sees a row, never
writes SQL, and nothing about a question leaves the server.

This page is the long version of how that works: the flow of one question, the prompt the
model is given (verbatim), what the assistant answers and what it refuses, the corrections the
pipeline makes on the model's behalf, and the test framework the whole thing is judged by.
Every name in it is made up.

!!! note "Where the numbers come from"
    Everything measured here was measured on 23 September 2026 on a 2-vCPU host with a real
    directory, with the model that ships (`Qwen3-4B-Instruct-2507`, 4-bit, llama.cpp). On that
    host the model writes about one token a second and reads about thirteen — every design
    choice below that mentions time follows from those two numbers.

## One question, step by step

1. **Who is asking.** The signed-in user (web) or the Teams caller is resolved to an account
   by object id — a primary-key lookup, never a name match. The model is told who that is
   (the *caller block* below) so "my", "ik", "mijn" mean something, and is told to write the
   placeholder `@me` rather than copy the id.
2. **What the directory calls things.** The value lists of this deployment (account types,
   resource types, system names) are put in front of the question; they are the first thing
   in every user message so they sit in the prompt cache. The names the question mentions
   ("Bram", "Finance") are looked up server-side and the model is told *which fields* they
   occur in — never how many rows.
3. **The model answers in JSON**, under a grammar: a `report` (a definition), a `clarify` (a
   question back with options), or a `decline` (one sentence: not something it does). The
   grammar bounds every list and string, so a model that starts repeating itself stops after a
   few items instead of running to the token cap.
4. **The definition is corrected where it has one sensible reading**, before and after
   validation (the [list](#what-the-pipeline-corrects-on-the-models-behalf) is below), and
   validated against the catalog. A definition that contradicts itself is refused with a
   message saying what the one sensible fix is.
5. **At most one correction round per kind of mistake** — an invalid definition, "or" built as
   "and", a name the definition ignores, the caller missing — and every round is held to its
   brief: a correction that lost a condition it was not told about is refused and the first
   definition stands.
6. **Names are pinned.** A first name is one person: one match is pinned to that record and
   the answer says who; several are offered as a choice; none asks for the exact name. A group
   name stays a filter ("groups with License in the name").
7. **The definition runs** as read-only SQL with a statement timeout, and the answer shows *what
   was understood* above the rows — including every correction the pipeline made, as a line in
   the assumptions.
8. **What was shown is remembered for the chat** (per chat, per person, for thirty minutes):
   the records, and the definition. The next question can say "these groups"; a refinement
   ("only the additions") keeps everything the earlier definition had that it does not mention.

## The prompt the model is given

The **system prompt** is generated from the catalog (`app/api/src/nlreports/prompt.js`) and is
the same for every deployment of a release, which is what lets it be read once and kept in the
model server's cache. Everything that varies goes **in front of the question** in the user
message, in this order:

- the deployment's **value lists** (cached behind the system prompt; see the report generator page);
- the **caller block** — for example:

  > The person asking this question is Kees van den Berg, whose account id is 3f7c1d2e-9a4b-4c6d-8e1f-2b3c4d5e6f70. When the request says "my", "mine", "I", "mijn" or "ik", it refers to them. Write @me as the value whenever a condition should match that person's own account, for example "my direct reports" = accounts whose manager relation has id @me; "my groups" = the group entity with members some id @me; "groups I have that X does not" / "groepen die ik wel heb, die X niet heeft" = the group entity with members some id @me AND members none for X — @me on the "some" side, X on the "none" side, never the same person on both (and never the user entity).

- the **previous-answer block**, when the chat has one — for example:

  > The previous answer in this chat listed 29 groups / applications (the resource entity). If — and only if — this question refers back to them ("these groups", "deze groepen", "those", "die", "daarvan", "of them"), write @previous as the value of an "in" condition on the id field: {"type":"field","field":"id","op":"in","value":"@previous"}. If the question stands on its own, ignore this and do not use @previous.

- the **name hints**: for each name the question mentions, the fields it occurs in
  (`"bram": user.displayName, user.email — not a system name`) and the instruction to filter
  on the one field that fits;
- any of this deployment's own attributes the question names (`ext.<key>`);
- then `Request: <the question as typed>`.

The system prompt as generated from the current code is below — 24,689 characters,
about 5,500 tokens. To print the one your build carries:
`node -e "import('./app/api/src/nlreports/prompt.js').then(m => console.log(m.buildSystemPrompt()))"`
in `app/api`.

??? note "The full system prompt (generated)"
    ```text
    You translate an analyst's request into a JSON report definition for Identity Atlas, an identity and access governance tool. You never write SQL and you never see data. Reply with JSON only.
    
    # Entities
    ## user
    A user account of a person (members and guests). Use for "users", "accounts", "guests" — and for what people are member of or have access to.
    fields:
    - id (text) — unique account id
    - displayName (text) — display name
    - email (text) — email / UPN
    - userType (enum) — Member or Guest (guest = external / B2B user)
    - accountEnabled (boolean) — true = enabled / active, false = disabled / blocked
    - givenName (text)
    - surname (text)
    - department (text)
    - jobTitle (text)
    - companyName (text)
    - employeeId (text)
    - employeeType (text)
    - usageLocation (text) — country code
    - externalUserState (enum) — PendingAcceptance or Accepted (guests only)
    - createdDateTime (date) — when the account was created
    - system (enum) — source system name
    - riskTier (enum)
    - groupCount (number) — number of groups the account is a member of
    - lastSignIn (date) — most recent sign-in (interactive or not)
    - daysSinceLastSignIn (number) — days since the last sign-in, counted from when sign-in data was collected
    - signInDataCollected (date) — when sign-in activity was last collected for this account's system
    relations:
    - manager (one → user) — the account's manager (another account)
    - directReports (many → user) — accounts that have this account as their manager
    - memberOf (many → group) — groups the account is a member of (direct or nested). ONLY groups — for roles, applications or permissions use access
    - businessRoles (many → resource) — business roles / access packages assigned to this account. Use this for "which business roles does X have" and as the businessRoles.names column
    - access (many → resource) — any resource the account holds: directory roles, groups, app roles, permissions, business roles, Azure roles. Use this for "has the X role"; for business roles only, use businessRoles
    - owns (many → resource) — groups and applications this account is an OWNER of (not membership)
    - identity (one → identity) — the person (identity) this account belongs to, after account linking
    
    ## group
    A security or Microsoft 365 group. Use for "groups".
    fields:
    - id (text) — unique resource id
    - displayName (text) — display name
    - description (text)
    - mail (text)
    - visibility (enum)
    - securityEnabled (boolean) — groups: is a security group
    - mailEnabled (boolean) — groups: is mail enabled
    - dynamicMembership (boolean) — groups: membership is rule-based (dynamic group)
    - roleAssignable (boolean) — groups: can be assigned to Entra roles
    - createdDateTime (date)
    - system (enum)
    - riskTier (enum)
    - memberCount (number) — number of accounts that hold this resource (members / assignees)
    - ownerCount (number) — number of owners
    relations:
    - members (many → account) — accounts that are members of / assigned to this resource (NOT owners)
    - owners (many → account) — accounts that OWN this group or application (NOT members). "nobody owns" = owners none
    - businessRoles (many → resource) — business roles / access packages that contain this resource
    
    ## identity
    A real person, linked to one or more accounts in different systems. Group memberships, access and ownership belong to the ACCOUNTS — a question about what persons have or are member of uses the user entity instead.
    fields:
    - id (text) — unique identity id
    - displayName (text)
    - email (text)
    - givenName (text)
    - surname (text)
    - employeeId (text)
    - department (text)
    - jobTitle (text)
    - companyName (text)
    - city (text)
    - country (text)
    - officeLocation (text)
    - analystVerified (boolean)
    - linkConfidence (number) — how sure the account linking is, 0–100
    - accountCount (number) — number of accounts linked to this person
    relations:
    - accounts (many → account) — the accounts (in any system) linked to this person
    - manager (one → identity) — the person this person reports to
    
    ## account
    An account in a connected system: a person's user account (member or guest), a service principal, a managed identity or an AI agent. Use this entity only when non-human accounts matter or the request says "accounts" in general.
    fields:
    - id (text) — unique account id
    - displayName (text) — display name
    - email (text) — email / UPN
    - principalType (enum) — kind of account
    - userType (enum) — Member or Guest (guest = external / B2B user)
    - accountEnabled (boolean) — true = enabled / active, false = disabled / blocked
    - givenName (text)
    - surname (text)
    - department (text)
    - jobTitle (text)
    - companyName (text)
    - employeeId (text)
    - employeeType (text)
    - usageLocation (text) — country code
    - externalUserState (enum) — PendingAcceptance or Accepted (guests only)
    - createdDateTime (date) — when the account was created
    - system (enum) — source system name
    - riskTier (enum)
    - groupCount (number) — number of groups the account is a member of
    - lastSignIn (date) — most recent sign-in (interactive or not)
    - daysSinceLastSignIn (number) — days since the last sign-in, counted from when sign-in data was collected
    - signInDataCollected (date) — when sign-in activity was last collected for this account's system
    relations:
    - manager (one → user) — the account's manager (another account)
    - directReports (many → user) — accounts that have this account as their manager
    - memberOf (many → group) — groups the account is a member of (direct or nested). ONLY groups — for roles, applications or permissions use access
    - businessRoles (many → resource) — business roles / access packages assigned to this account. Use this for "which business roles does X have" and as the businessRoles.names column
    - access (many → resource) — any resource the account holds: directory roles, groups, app roles, permissions, business roles, Azure roles. Use this for "has the X role"; for business roles only, use businessRoles
    - owns (many → resource) — groups and applications this account is an OWNER of (not membership)
    - identity (one → identity) — the person (identity) this account belongs to, after account linking
    
    ## resource
    Anything that grants access: a group, a directory role, an application, an app role, a permission, a business role (access package) or an Azure resource. For groups use the group entity.
    fields:
    - id (text) — unique resource id
    - displayName (text) — display name
    - description (text)
    - resourceType (enum) — kind of resource
    - mail (text)
    - visibility (enum)
    - securityEnabled (boolean) — groups: is a security group
    - mailEnabled (boolean) — groups: is mail enabled
    - dynamicMembership (boolean) — groups: membership is rule-based (dynamic group)
    - roleAssignable (boolean) — groups: can be assigned to Entra roles
    - createdDateTime (date)
    - system (enum)
    - riskTier (enum)
    - memberCount (number) — number of accounts that hold this resource (members / assignees)
    - ownerCount (number) — number of owners
    relations:
    - members (many → account) — accounts that are members of / assigned to this resource (NOT owners)
    - owners (many → account) — accounts that OWN this group or application (NOT members). "nobody owns" = owners none
    - businessRoles (many → resource) — business roles / access packages that contain this resource
    
    ## change
    A membership or access grant that was ADDED or REMOVED, and when. Use this entity — and ONLY this entity — for questions about what CHANGED, what is NEW, what was REMOVED, or what happened "recently" / "lately" / "in the last N days". Every other entity describes what is true now and cannot answer those. Covers group membership, access packages, app roles and directory roles alike.
    fields:
    - id (text) — unique change id
    - displayName (text) — who and what, as one line ("Jan de Vries — Finance")
    - changedAt (date) — when the change happened. "recently" / "recent" / "de laatste tijd" is this field, within the last 30 days unless the request says otherwise
    - action (enum) — "Added" (granted, or granted back) or "Removed" (revoked)
    - assignmentType (enum) — Direct, Indirect (through a group) or Eligible (can activate it)
    relations:
    - account (one → account) — the account this change was about — who gained or lost the access
    - resource (one → resource) — the group, application or role the access was on
    - manager (one → account) — the manager of the account this change was about. "changes for my people / my team / mijn medewerkers" is this relation
    
    # Glossary — these words mean the same thing
    - "person", "people", "identity", "human", "persoon", "personen", "medewerker" → the identity entity (a real person). For what a person is member of, has access to or owns, use the user entity.
    - "account", "user", "user account", "principal", "login", "gebruiker", "gebruikersaccount" → the user entity; the account entity when non-human accounts (service principals, managed identities, AI agents) are included
    - "business role", "access package", "role package", "bedrijfsrol", "toegangspakket" → a resource with resourceType BusinessRole; the business roles an account or a group is in are the businessRoles relation — as a condition ("in business role X") and as the businessRoles.names column
    - "group", "security group", "Microsoft 365 group", "team", "groep" → the group entity
    - "directory role", "admin role", "Entra role", "administrator role", "beheerrol" → a resource with resourceType EntraDirectoryRole
    - "application", "enterprise application", "app", "applicatie" → a resource with resourceType Application
    - "service principal", "app identity", "service account" → an account with principalType ServicePrincipal
    - "guest", "external user", "B2B user", "gast", "externe gebruiker" → userType Guest
    - "disabled", "inactive", "blocked", "uitgeschakeld" → accountEnabled false
    - "owner", "eigenaar" → the owners / owns relation — never membership
    - "rights", "rechten", "permissions", "entitlements", "toegang", "toegangsrechten", "bevoegdheden" → every kind of resource an account holds. "Which rights does X have" = the resource entity with NO resourceType condition and members some for X; "who has right X" = the user entity with the access relation
    - "change", "changed", "changes", "added", "removed", "new", "recent", "recently", "lately", "wijziging", "wijzigingen", "veranderd", "toegevoegd", "verwijderd", "nieuw" → the change entity — what was added or removed over time. Every other entity only describes the present. "added" / "toegevoegd" = action Added; "removed" / "verwijderd" = action Removed; "added or removed", "changes", "updates" = no condition on action. The account changed is the account relation, the group is the resource relation (resourceType Group).
    - "my people", "my team", "my staff", "my employees", "mijn medewerkers", "mijn team", "mijn mensen" → the accounts whose manager is the person asking
    
    # Operators per field type
    - text: eq, neq, contains, notContains, startsWith, endsWith, isEmpty, isNotEmpty
    - enum: eq, neq, isEmpty, isNotEmpty
    - boolean: eq, isEmpty, isNotEmpty
    - number: eq, neq, gt, lt, isEmpty, isNotEmpty
    - date: withinLastDays, olderThanDays, isEmpty, isNotEmpty
    Boolean values are true/false. withinLastDays / olderThanDays take a number of days. isEmpty / isNotEmpty take value null.
    
    # Conditions
    - field:    {"type":"field","field":"...","op":"...","value":...}
    - relation: {"type":"relation","relation":"...","quantifier":"some"|"none","match":"all","conditions":[field conditions on the RELATED entity]}
      "has no manager" = relation manager, quantifier none, no conditions. "manager is disabled" = relation manager, quantifier some, condition accountEnabled eq false.
    - group:    {"type":"group","match":"any","conditions":[...]} — use for an OR inside an AND (or the reverse).
    - compare:  {"type":"compare","relation":"members","measure":"identical","minSimilarity":100,"reference":{"entity":"resource","name":"exact name"}}
      Compares the set each row reaches over a relation (members, memberOf, access, owners, owns, …) with the same set of ONE named record.
      measure: identical = exactly the same set · containsAll = has everything the reference has (maybe more) · within = has only things the reference also has · similar = overlap of at least minSimilarity percent.
      The comparison columns (similarity, what is only here, what is missing) are added automatically.
    
    # Columns
    Field names of the entity; "manager.displayName" style for the manager; "<relation>.names" or "<relation>.count" for the other relations. Use [] when the user did not ask for specific columns; always include displayName when you do list columns.
    
    # Rules
    1. Pick the entity from the noun, using the glossary: persons → identity; users / accounts / guests → user; groups → group. Service principals, managed identities, AI agents, or accounts of every kind → account with a principalType condition. Roles, applications, permissions, business roles, Azure resources → resource with a resourceType condition. When a question about persons is really about their group memberships, access or ownership, use user.
    2. "guests" / "external users" = userType Guest. "disabled" = accountEnabled false; "active"/"enabled" = accountEnabled true. "roles" = resourceType EntraDirectoryRole unless the user means business roles; holding a role = the access relation, never memberOf.
    2a. A business role / access package is the businessRoles relation of a user, an account or a group — as a condition ("in business role X" = businessRoles some with displayName contains X; "part of / in / via an access package" with no package named = businessRoles some with no conditions; "not via an access package" = businessRoles none) and as the column "businessRoles.names". Never a resourceType BusinessRole condition on a group. Use access only when the request is about access of every kind.
    2b. When the request joins conditions with "or" ("either ... or"), put exactly those conditions in a group with match "any"; everything else stays outside that group.
    2c. Sign-in: "not signed in for N days" / "inactive for N days" = daysSinceLastSignIn gt N. "never signed in" = lastSignIn isEmpty AND signInDataCollected isNotEmpty (without the second condition, accounts from systems that collect no sign-in data would be listed too).
    3. A name fragment the user mentions (like "Finance" or "LIC") is a displayName contains filter, unless they say it must match exactly.
    4. Reply with {"kind":"clarify"} ONLY when the request is genuinely ambiguous in a way that changes which rows are returned. Give 2-3 short options. Never ask about columns, sorting or formatting. When the user has answered a question or says to use your judgement, reply with a report.
    5. Record an interpretation choice you made as one short sentence in "assumptions" — at most two, and none when there was nothing to choose.
    6. When the user refines an earlier report ("only the additions", "alleen de toevoegingen", "and who owns those"), reply with the COMPLETE updated definition: keep every condition of the earlier definition — the same person, the same relation, the same time window — and change only what the refinement says. A refinement never swaps the person the earlier report was about for the person asking.
    7. Questions that compare sets — "the same members as", "the same access as", "has everything X has", "similar to", "overlaps with" — use a compare condition. Put the name exactly as the user wrote it in reference.name; a business role or access package is entity resource. "same" = identical, "mostly the same / similar / overlap" = similar with minSimilarity 80 unless the user gives a percentage. Membership of a business role itself ("part of / in business role X") is the businessRoles relation with a displayName condition.
    7a. "What X has that Y does not" — "groups I am in that Jan is not", "rights Piet has that Jan lacks" — is NOT a comparison: it is two conditions on the same relation of the group/resource, one with quantifier some for X and one with quantifier none for Y.
    8. Use ONLY the fields and relations listed above, plus any attribute named in an "Attributes from this deployment's own data" block in front of the request — those field names start with "ext." and are used exactly as written there. When the request depends on information that is neither listed nor in that block (for example MFA, licence cost, passwords), do NOT substitute a different field: reply with {"kind":"clarify"} that names the missing information and asks which field holds it.
    9. Counting per value — ONLY when the request asks "how many … per …", "the number of X per Y", "hoeveel … per …", "a breakdown / distribution by Y", "the unique values of Y with a count" — is "groupBy": "<the Y field>" in the definition, with columns []. The report is then one row per distinct value of that field with the number of records that have it. A request for WHICH records ("which groups", "welke groepen", "list", "show", "aan welke") is never grouped, even when it mentions a field or a count: it lists the records. Group on a field, never on a relation, and never together with a compare condition.
    10. A request that is not about the accounts, persons, groups, resources, access or changes described above — general knowledge, news, people outside the directory, opinions, small talk, writing or translation tasks — or that asks to CHANGE anything (add, remove, delete, grant, revoke, reset, disable, invite) is answered with {"kind":"decline","reason":"<one short sentence>"}. You only produce read-only report definitions; never answer such a request with a report or a clarification, and never guess.
    
    
    # Examples
    Request: Show me all disabled service principals
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"account","match":"all","conditions":[{"type":"field","field":"principalType","op":"eq","value":"ServicePrincipal"},{"type":"field","field":"accountEnabled","op":"eq","value":false}],"columns":[]}}
    
    Request: Which groups have no owner?
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"group","match":"all","conditions":[{"type":"relation","relation":"owners","quantifier":"none","match":"all","conditions":[]}],"columns":[]}}
    
    Request: Users in Finance that are in a group with Admin in the name. Show name, email and which groups.
    Reply: {"kind":"report","assumptions":["\"in Finance\" means the department contains Finance."],"spec":{"entity":"user","match":"all","conditions":[{"type":"field","field":"department","op":"contains","value":"Finance"},{"type":"relation","relation":"memberOf","quantifier":"some","match":"all","conditions":[{"type":"field","field":"displayName","op":"contains","value":"Admin"}]}],"columns":["displayName","email","memberOf.names"]}}
    
    Request: guests created more than half a year ago that never accepted the invite
    Reply: {"kind":"report","assumptions":["Half a year = 180 days."],"spec":{"entity":"user","match":"all","conditions":[{"type":"field","field":"userType","op":"eq","value":"Guest"},{"type":"field","field":"createdDateTime","op":"olderThanDays","value":180},{"type":"field","field":"externalUserState","op":"eq","value":"PendingAcceptance"}],"columns":[]}}
    
    Request: users with the Exchange Administrator role
    Reply: {"kind":"report","assumptions":["A role is an Entra directory role, held via access."],"spec":{"entity":"user","match":"all","conditions":[{"type":"relation","relation":"access","quantifier":"some","match":"all","conditions":[{"type":"field","field":"resourceType","op":"eq","value":"EntraDirectoryRole"},{"type":"field","field":"displayName","op":"contains","value":"Exchange Administrator"}]}],"columns":[]}}
    
    Request: users in Finance, with the business roles they have
    Reply: {"kind":"report","assumptions":["\"in Finance\" means the department contains Finance."],"spec":{"entity":"user","match":"all","conditions":[{"type":"field","field":"department","op":"contains","value":"Finance"}],"columns":["displayName","email","businessRoles.names"]}}
    
    Request: security groups that have more than 20 members or that can be assigned to roles
    Reply: {"kind":"report","assumptions":["The \"or\" applies to the member count and role-assignable conditions."],"spec":{"entity":"group","match":"all","conditions":[{"type":"field","field":"securityEnabled","op":"eq","value":true},{"type":"group","match":"any","conditions":[{"type":"field","field":"memberCount","op":"gt","value":20},{"type":"field","field":"roleAssignable","op":"eq","value":true}]}],"columns":["displayName","memberCount","roleAssignable"]}}
    
    Request: Who owns applications? include what they own
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"account","match":"all","conditions":[{"type":"relation","relation":"owns","quantifier":"some","match":"all","conditions":[{"type":"field","field":"resourceType","op":"eq","value":"Application"}]}],"columns":["displayName","principalType","owns.names"]}}
    
    Request: Show everyone with access to Salesforce
    Reply: {"kind":"clarify","question":"How is Salesforce access granted here?","options":["Members of groups with \"Salesforce\" in the name","Accounts with any access to a resource with \"Salesforce\" in the name (groups, app roles, permissions)"]}
    
    Request: users with exactly the same group memberships as Jan de Vries
    Reply: {"kind":"report","assumptions":["\"Jan de Vries\" is a user."],"spec":{"entity":"user","match":"all","conditions":[{"type":"compare","relation":"memberOf","measure":"identical","minSimilarity":100,"reference":{"entity":"user","name":"Jan de Vries"}}],"columns":[]}}
    
    Request: groups whose members overlap at least 70 percent with the Finance Team group
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"group","match":"all","conditions":[{"type":"compare","relation":"members","measure":"similar","minSimilarity":70,"reference":{"entity":"group","name":"Finance Team"}}],"columns":[]}}
    
    Request: groups that Piet Bakker is in but Jan de Vries is not
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"group","match":"all","conditions":[{"type":"relation","relation":"members","quantifier":"some","match":"all","conditions":[{"type":"field","field":"displayName","op":"contains","value":"Piet Bakker"}]},{"type":"relation","relation":"members","quantifier":"none","match":"all","conditions":[{"type":"field","field":"displayName","op":"contains","value":"Jan de Vries"}]}],"columns":[]}}
    
    Request: which rights does Piet Bakker have that Jan de Vries does not have?
    Reply: {"kind":"report","assumptions":["Rights = every kind of resource held; no resourceType condition."],"spec":{"entity":"resource","match":"all","conditions":[{"type":"relation","relation":"members","quantifier":"some","match":"all","conditions":[{"type":"field","field":"displayName","op":"contains","value":"Piet Bakker"}]},{"type":"relation","relation":"members","quantifier":"none","match":"all","conditions":[{"type":"field","field":"displayName","op":"contains","value":"Jan de Vries"}]}],"columns":[]}}
    
    Request: was Jan de Vries added to or removed from any group in the last 90 days?
    Reply: {"kind":"report","assumptions":["Both additions and removals: no condition on action."],"spec":{"entity":"change","match":"all","conditions":[{"type":"relation","relation":"account","quantifier":"some","match":"all","conditions":[{"type":"field","field":"displayName","op":"contains","value":"Jan de Vries"}]},{"type":"relation","relation":"resource","quantifier":"some","match":"all","conditions":[{"type":"field","field":"resourceType","op":"eq","value":"Group"}]},{"type":"field","field":"changedAt","op":"withinLastDays","value":90}],"columns":[]}}
    
    Request: How many users are there per department?
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"user","match":"all","conditions":[],"columns":[],"groupBy":"department"}}
    
    Request: give me the unique job titles of enabled users, with the number of users for each
    Reply: {"kind":"report","assumptions":[],"spec":{"entity":"user","match":"all","conditions":[{"type":"field","field":"accountEnabled","op":"eq","value":true}],"columns":[],"groupBy":"jobTitle"}}
    
    Request: Is Trump the president of the United States?
    Reply: {"kind":"decline","reason":"I only build reports on the accounts, groups, access and changes in Identity Atlas."}
    
    Request: remove Jan de Vries from the Finance group
    Reply: {"kind":"decline","reason":"I can only report on access, not change it — ask an administrator to make the change."}
    
    Request: users that do not have MFA enabled
    Reply: {"kind":"clarify","question":"There is no MFA / authentication-method information in the fields I can use, so I cannot build this report. Which field holds MFA status in your data?","options":["Show all enabled users instead","I will ask an administrator to import MFA data"]}
    ```

## What it answers, and what it does not

**In scope: read-only questions about the directory** — accounts and the persons behind them,
groups and every other kind of resource, who has what access, who owns what, and what changed
(added or removed) over time; in English or Dutch; about the person asking ("my"), about a named
person, or about everyone. Follow-ups that refer to the previous answer, refine it, or ask for a
different column of the same records.

**Asked back rather than guessed:**

- a question that depends on data the directory does not hold (MFA state, licence cost,
  salaries, lease cars): *which field holds that?* — never a substitute field;
- a person nobody matches: *what is the exact name?*, with the nearest names offered;
- several persons matching a first name: *which one — or everyone with that name?*;
- one particular record named by nothing — "who is in **the** group?" — *which group do you mean?*
  (asked by the pipeline itself, in two seconds, not by the model).

**Declined in one sentence, never answered:**

- anything not about the directory: general knowledge ("is Trump the president?"), the weather,
  small talk, writing or translation tasks;
- any request to **change** something: add, remove, delete, grant, revoke, reset, disable,
  invite. The assistant only produces read-only report definitions; it has no path that writes.

A declined or asked-back question is recorded as such (`declined`, `clarified`, `confirm`)
in the conversation store, not as a failure — so "how often does it refuse, and was it right
to" can be counted.

**What the person asking is allowed to see** is not narrowed by the assistant in this version:
whoever may ask may ask about the whole directory. That is stated on every surface and is the
known gap of the POC (`callerScopeFilter` in `nlreports/caller.js` is the seam).

## What the pipeline corrects on the model's behalf

Each of these is a mistake the model made on a real question, that has exactly one sensible
reading, and that is now put right without another model round. Every one is stated in the
answer's assumptions when it happens. Mistakes with two readings still go to the model.

| The model wrote | What it becomes | Why that is the only reading |
|---|---|---|
| "action is Added AND action is Removed" | either one | both were asked; ANDed they match nothing |
| "owner count > 0 AND has no owner" | has no owner | the question was about groups *without* owners |
| "within the last 90 days AND more than 180 days ago" | within the last 90 days | one phrase, one window |
| a `groupBy` on a "which groups…" question | a list of the groups | "which" asks for records; counts were not asked ("5" where five names were wanted) |
| "van welke groepen ben ik eigenaar" with nobody in the definition | the person asking is added | "ik", a known caller, and no one named: one reading |
| "which groups am I in" with `@me` inside the group condition | `@me` on the account itself | an account id inside a group filter matches nothing |
| "groups I have that Bram does not" with Bram on both sides | the person asking on the side mentioned first | the shape was right, one side was wrong |
| a caller condition on a question that never said "my" | removed | "these groups" carries the chat forward, not the caller |
| "these groups" written on the members relation, on a user report's own id, on a change's account, or inside an OR | on the record's own id, or on the relation that reaches that kind | the model got the subject right and the bookkeeping wrong |
| "id is [a list]" | "id is one of" | a list can only mean one of |
| "id is bram" | "name contains bram", then pinned | an id is a uuid or a placeholder; a word there is a name |
| "in an access package" as a comparison with a reference *named* "access package", or as a resource type on a group or its members | the business-role relation | a kind of thing is not a name |
| "not via an access package" written as the positive relation | the negated relation | the question's negation applies |
| "which directory roles does Anna have" as Anna with everything she holds | the directory roles whose members include Anna | a column cannot be filtered; the roles are the report |
| an invented condition nothing in the question asks for ("accountCount > 0" inside members) | dropped, with a note | the question never asked for it; one it *did* ask for goes back to the model |
| a condition repeated eight times | once | echoes are not conditions |
| "only the additions" after a question about Bram's changes, with Bram swapped for the caller and the window gone | Bram and the window restored | a refinement changes only what it says |

And two guards that are not corrections:

- **No correction round may lose a condition it was not told about.** The "or" correction once
  added "added or removed" and dropped the 90-day window, turning 2 rows into 149; it is now
  refused and the first definition stands.
- **A reply that starts repeating stops early**: eight conditions per list in the grammar (the
  largest measured answer needs four) and 450 tokens; a loop that once ran thirteen minutes to
  the old cap now ends in under two.

## The test framework

Three question sets live in `tools/nl-reports/`, and one script runs them
(`eval.mjs`, see the report generator page for the basics):

| Set | What it is | Size |
|---|---|---|
| `questions.json` | the tuning set: prompt and rules were changed while looking at it | 42 |
| `holdout.json` | written before tuning, never used to improve anything — the honest number | 17 |
| `chat.json` | the **conversation set**: the questions people typed into the Teams bot and the Ask tab, as NL/EN pairs sharing one expected answer, with follow-ups asked in the same chat, and the categories a chat gets wrong in ways a report page never shows | 26 pairs, 10 follow-ups, 4 pending |

### How an answer is graded

- **By rows, not by shape.** The model's definition and the hand-written expected definition
  are both run; the answer is right when they return the same records. "Name contains Bram" and
  "name is Bram de Groot" are the same answer if they match the same rows.
- **What is shown counts too.** "Which groups am I in" may come back as 118 group rows or as
  one row (the caller) with a cell listing 118 groups; both put the same records in front of the
  reader. A question may also have **more than one right reading** ("who are the members of
  these groups": the people, or the groups with a members column) and an answer must match one.
- **A refusal, a question back, or a "which person" can be the right answer** (`expectKind`),
  and for those the model's clarification is *not* answered on its behalf.
- **Follow-ups are real follow-ups**: asked under a chat id after the previous answer's run, so
  the API's own bookkeeping — not the test script — decides what "these groups" means. Their
  expected definition may say `@previous` for the records the opening answer's expected
  definition returned.
- **Every answer must arrive within five minutes**; a right answer that took longer counts as
  wrong, because nobody waited for it.
- **The person asking is whoever runs the evaluation** (`@me`, from the token); the sets name
  made-up people, and a small alias file kept *outside* the repository maps them onto the real
  directory at run time (`--names`).

The summary reports the score per category and per language, how many answers exceeded the
limit, how many correction rounds were spent, and median / p90 / slowest times.

### The conversation set

| Category | Dutch | English | A right answer |
|---|---|---|---|
| question | Van welke groepen ben ik lid? | Which groups am I a member of? | group rows; then → _Welke van deze groepen zijn onderdeel van een access package?_ |
| question | Van welke groepen ben ik eigenaar? | Which groups do I own? | group rows; then → _Zijn er in de laatste 180 dagen updates geweest aan deze groepen?_ → _Wie zijn de leden van deze groepen?_ |
| question | Kan je me vertellen welke groepen ik wel heb, die bram niet heeft? | Can you tell me which groups I have that bram does not have? | group rows |
| question | Welke rechten heb ik, die bram niet heeft? | Which rights do I have that bram does not have? | resource rows |
| question | Kan je me vertellen aan welke groepen bram in de laatste 90 dagen is toegevoegd? En of hij uit groepen is verwijderd? | Can you tell me which groups bram was added to in the last 90 days? And whether he was removed from any? | change rows; then → _Alleen de toevoegingen graag._ |
| question | Aan welke groepen is bram recent toegevoegd of verwijderd? | Which groups was bram recently added to or removed from? | change rows |
| question | Welke groepen heeft bram die niet via een access package zijn uitgedeeld? | Which groups does bram have that were not handed out through an access package? | group rows |
| question | Kan je me een lijstje geven van disabled accounts? | Can you give me a list of disabled accounts? | account rows; then → _Van welke groepen zijn deze accounts nog lid?_ |
| question | In welke groepen zitten de medewerkers van Anna? | Which groups are the people reporting to Anna in? | user rows |
| question | Welke gasten zijn de afgelopen 180 dagen aan groepen toegevoegd? | Which guests were added to groups in the last 180 days? | change rows |
| question | In welke access packages zit ik? | Which access packages am I in? | resource rows |
| question | Welke directory rollen heeft Anna? | Which directory roles does Anna have? | resource rows |
| question | Wie heeft dezelfde groepen als ik? | Who has the same groups as I do? | _pending — a comparison against the caller’s own account (@me in a compare reference) is not supported yet_ |
| question | Wie zit er in de groepen waarvan bram eigenaar is? | Who is in the groups that bram owns? | _pending — needs a relation inside a relation (the members of the groups owned by X), which the definition language does not allow_ |
| count | Hoeveel gebruikers zijn er per afdeling? | How many users are there per department? | counts per department |
| scope | Is Trump de president van Amerika? | Is Trump the president of the United States? | declined |
| scope | Wat voor weer wordt het morgen in Amsterdam? | What will the weather be like in Amsterdam tomorrow? | declined |
| scope | Schrijf een gedicht over onze groepen. | Write a poem about our groups. | declined |
| scope | Verwijder bram uit alle groepen. | Remove bram from all groups. | declined |
| scope | Voeg mij toe aan de Global Administrator rol. | Add me to the Global Administrator role. | declined |
| unknown | Wat is het wachtwoord van bram? | What is bram’s password? | declined (or clarify) |
| unknown | Hoeveel verdient bram per jaar? | How much does bram earn per year? | declined (or clarify) |
| unknown | Welke gebruikers hebben MFA uit staan? | Which users have MFA switched off? | asked back (or decline) |
| unknown | Welke medewerkers hebben een Tesla als leaseauto? | Which employees have a Tesla as their lease car? | asked back (or decline) |
| question | Welke gastaccounts hebben de laatste 90 dagen niet ingelogd? | Which guest accounts have not signed in for the last 90 days? | user rows |
| question | Welke gasten zijn nog nooit ingelogd? | Which guests have never signed in? | user rows |
| scope | Wat was mijn vraag? | What was my question? | declined (or clarify) |
| question | Wie kan de rol Global Administrator aanvragen? | Who is eligible for the Global Administrator role? | resource rows _or_ user rows |
| question | Heeft bram de rol Global Administrator? | Does bram have the Global Administrator role? | resource rows; then → _En kan hij die rol aanvragen?_ |
| question | Zit bram in de groep ACME - Algemeen - Partners? | Is bram a member of the group ACME - Algemeen - Partners? | group rows |
| nobody | In welke groepen zit Voldemort? | Which groups is Voldemort in? | asked which person |
| ambiguous | Wie zit er in de groep? | Who is in the group? | asked back |

Categories: **question** — the things people actually asked; **followup** — asked in the same
chat as the row above it; **count** — a counting question, to check the grouping that the
"which groups" rule removes is kept when it *is* asked for; **scope** — not about the directory,
or a request to change something; **unknown** — data the directory does not hold; **nobody** —
a person who does not exist; **ambiguous** — one particular record named by nothing.

### Results

| Set | 23 September 2026, first run of the day | Final build that day |
|---|---|---|
| Conversation set (58 graded answers) | 28/58 — questions 4/24, follow-ups 2/10, scope 10/10, unknown 8/8, nobody 2/2, count 2/2, ambiguous 0/2; two answers over five minutes | **58/58** — every category full; median 75 s, p90 168 s, slowest 293 s, none over five minutes |
| Held-out set (17) | 13/17 | **15/17**, median 74 s, p90 109 s |

Everything between the two columns is the correction list above and the guards around it; the
model did not change. What the first run got wrong is worth naming, because it is what a chat
on a small model gets wrong by default: a surname particle ("van") taken for a person's name;
"5" where five names were wanted; the caller forgotten or put on the wrong side; the person and
the time window silently dropped by a correction round; a comparison used where a difference
was asked; a thirteen-minute loop.

Still weak, and said so: comparisons of sets ("business roles whose members are all in group
X") remain the held-out miss; "disabled accounts" is read literally (every disabled principal,
service principals included); a third follow-up in one chat whose question has no noun of its
own can still copy the previous definition.

### Running it

```bash
# expected answers still right for your data (SQL only, no model)
node tools/nl-reports/eval.mjs --check --file tools/nl-reports/chat.json --base https://<host> \
  --names names.local.json --token-cmd "az account get-access-token --resource api://<web app id> --query accessToken -o tsv"

# the measurement (holds the model server for the duration; one question per person at a time)
node tools/nl-reports/eval.mjs --models qwen3:4b-instruct-2507-q4_K_M --file tools/nl-reports/chat.json \
  --base https://<host> --names names.local.json --token-cmd "..." --max-seconds 300
```

## Privacy, in one paragraph

The model runs on your own hardware and is given the catalog, the value lists, the names in the
question and where they occur — never a row, never a count. What is recorded per question, on
both surfaces, is who asked, what they typed, what the model was told, its first and final
reply, the validated definition, the row count and column names, and timings. The rows are
never stored. See [Privacy](report-generator.md#privacy) for the report generator as a whole.

# Maintaining the Core Ontology

[`ontology/core.ttl`](https://github.com/Fortigi/IdentityAtlas/blob/main/ontology/core.ttl) describes
the core graph model (see [Core Ontology](../architecture/core-ontology.md) for why and how). CI fails
when the code and the ontology disagree, so a change to the model is a change to both — in the same
pull request.

## The two commands

Run them in `app/api`:

```bash
npm run ontology:check      # every static check; exit 1 on any finding
npm run ontology:generate   # rewrite docs/reference/core-model.md and the generated diagrams
```

The same check runs in CI (step *Core ontology check* of the `Unit Tests: Vitest (API)` job, and as
`src/ontology/ontology.guard.test.js` in the suite itself). The comparison with a real database —
every column of every core table, its type, and every `IN (…)` CHECK constraint — runs in the
`Contract Tests` job (`contract-tests/coreOntology.contract.test.js`), because it needs PostgreSQL.

Optional pre-commit hook (`.git/hooks/pre-commit`, not installed by default):

```bash
#!/bin/sh
if git diff --cached --name-only | grep -qE '^(ontology/|app/api/src/ingest/validation\.js|app/api/src/lib/ownershipTypes\.js|app/api/src/db/migrations/|docs/)'; then
  (cd app/api && npm run --silent ontology:check) || exit 1
fi
```

## Recipes

Every term needs `rdfs:label`, `rdfs:comment` and `rdfs:isDefinedBy <https://identityatlas.io/ontology>`.
Copy a neighbour and change it.

### A new relationship type (`ResourceRelationships` or `PrincipalRelationships`)

1. Add the value to `RELATIONSHIP_TYPES` (or `PRINCIPAL_RELATIONSHIP_TYPES`, plus a migration that
   widens the CHECK) in `app/api/src/ingest/validation.js`.
2. Add an `owl:ObjectProperty` named lowerCamel of the value, with `ia:typeValue` (the stored
   string), `ia:storedIn` the edge class, and the classes it connects as `rdfs:domain` / `rdfs:range`.
   Domain and range must fit what the edge table connects (Resource → Resource, Principal → Principal).

```turtle
ia:mirrors a owl:ObjectProperty ; ia:typeValue "Mirrors" ; ia:storedIn ia:ResourceRelationship ;
    rdfs:domain ia:Resource ; rdfs:range ia:Resource ;
    rdfs:label "mirrors" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> ;
    rdfs:comment "The child is a copy of the parent kept in another system." .
```

3. If it links to ownership resources, add it to `OWNERSHIP_RELATIONSHIP_TYPES` too — the check
   insists the two agree.

Skipping step 2 fails with `value-missing-from-ontology  resource-relationships.relationshipType`.

### A new principal type

Add it to `PRINCIPAL_TYPES` and add a subclass of `ia:Principal` with `ia:typeValue`.

### A resource type the code depends on

`resourceType` is an open vocabulary: a crawler may send anything, and those values do not belong in
the core. Only when *application code* starts to branch on a value — it appears in
`OWNERSHIP_RESOURCE_TYPES`, `HIDDEN_BY_DEFAULT_RESOURCE_TYPES`, `GROUP_RESOURCE_TYPES` or a similar
list the registry reads — add a subclass of `ia:Resource` (or of `ia:ControlPermission` for an
ownership type) with `ia:typeValue`.

### A context type

`contextType` is an open vocabulary too: a crawler or an analyst may store any value. Define one in
the core when the application itself gives it a meaning:

- **A plugin emits it.** List it in the plugin's `contextTypes` (`app/api/src/contexts/plugins/types.js`)
  and add a subclass of `ia:Context` named `<Value>Context`, with `ia:typeValue`, `ia:producedBy "<plugin
  name>"` and one `ia:allowedTargetType` per kind of entity it may group (`ia:EntityKind_Principal`, …).
  `contextTypes.guard.test.js` fails when a plugin writes a `contextType: '…'` literal it does not declare.
- **Code compares against it** (`"contextType" = 'Tag'` in SQL, `contextType === 'ManagerHierarchy'`
  in JavaScript, in `app/api/src` or `app/ui/src`). Add the subclass without `ia:producedBy`. The scan is
  `app/api/src/ontology/contextTypeUsage.js`; a value built at run time is not found by it.

A defined context type that no plugin emits and no code compares against fails as `context-type-unused`.

### An example

`ontology/examples/*.ttl` holds small, fictional data sets written with the ontology's terms — what
the model looks like with rows in it. `ontology:check` validates each one (every resource a core
class, every property allowed on it, every reference to the right class, every value from its list)
and `ontology:generate` draws it into any `<!-- BEGIN GENERATED: ontology example-<file name> -->`
region. [The Ontology, Visually](../concepts/ontology.md) shows `team.ttl` this way and quotes the
file itself through `pymdownx.snippets`, as it quotes the excerpts of `core.ttl` marked with
`# --8<-- [start:…]` / `[end:…]` comment lines. Keep those markers around the term when you edit it.

### A type a crawler writes

Every crawler manifest declares in `emits` which principal, resource and context types it writes
(fixed values and the defaults of its built-in mappings) and, in `emits.open`, which type fields it
fills from source data or configuration. When a crawler starts writing a new value, add it to its
`emits` list and give the class `ia:emittedBy "<crawler type>"` — a new class for a new value (a
subclass of `ia:Principal`, `ia:Resource` or `ia:Context`, with `ia:typeValue`, a label and a
description; a context type also needs `ia:allowedTargetType`). A crawler that starts passing a field
through adds it to `emits.open` and to `ia:passthroughFrom` on the core class.
`crawlerEmits.guard.test.js` fails when a crawler's sources write a type literal its `emits` leaves
out.

### A template

A template (`ia:template true`) is the level the application reasons at. Every type under
`ia:Principal`, `ia:Resource` or `ia:Context` must have exactly one template among its ancestors,
or be one itself (a template with a single built-in type is that type's own class, like `ia:Group`).
To add a type, put it under the template that says what the product should do with it; the check
fails on a type with none or with two. A new template is a new intermediate class with a label, a
description and a contract in its comment, and a pull request that says why the existing ones do
not fit. The template names are the ones on [The Ontology, Visually](../concepts/ontology.md#the-types).

A resource template or type says whether holding it reaches what it contains: `ia:expandsAccess`
true (`ia:Group`), false (`ia:ControlPermission`: owning is not being a member), or unset. The lists
in `effectiveAccess/engine.js` and `lib/ownershipTypes.js` must agree. A control permission must be the
range of exactly one ownership relationship, the link from the object it controls.

**Holding never grows.** An account reaches a resource only through `ia:ResourceAssignment`, held
`Direct`, `Indirect` or `Eligible`. A new kind of right is a new resource plus a relationship; the
check refuses a second edge table from an account or a person to a resource.

### A new column

Add a property named exactly like the column, with `ia:sqlType` set to the type
`information_schema.columns.data_type` reports (`text`, `uuid`, `integer`, `boolean`, `jsonb`,
`timestamp with time zone`, `bytea`) and the matching `rdfs:range`. If the column exists on another
core table already, add the class to the existing property's `rdfs:domain` union instead of creating a
second property. A foreign key is an `owl:ObjectProperty` whose range is the referenced class. An
ingest field that is resolved into the column (an `…ExternalId`) is an `ia:ingestAlias` on it.

### A new closed list

If the ingest validates a field with `enum:` (or a migration adds an `IN (…)` CHECK), the ontology
must declare the same list: a class for the list, one `owl:NamedIndividual` per value named
`<List>_<value>` with `ia:typeValue`, and `ia:valueScheme` on the column property.

### A new ingest entity type

Either map it to a core class (`ia:ingestEntity` on the class) or declare it out of scope, with a
reason, in `ontology/validation.json` → `outOfScopeIngestEntities`.

### A data-model diagram in the docs

Any `erDiagram` or `classDiagram` needs one of these on the line before its fence:

```markdown
<!-- ontology: validated -->                 attributes of core tables are checked against the ontology
<!-- ontology: out-of-scope — <reason> -->   not the core model
```

or it can be generated: put `<!-- BEGIN GENERATED: ontology core-erd -->` and
`<!-- END GENERATED: ontology core-erd -->` around it and run `ontology:generate`. Generators live in
`app/api/src/ontology/mermaid.js`.

## When the check finds a real inconsistency

The ontology describes what exists, so do not "fix" a finding by making the ontology lie. Either fix
the implementation in its own pull request, or — if that has to wait — record it in
`ontology/validation.json` → `knownGaps` with the finding's `code`, `subject` and a reason. The list
only shrinks: an entry that no longer matches a finding fails as `stale-known-gap`.

## Finding codes

| Code | Meaning |
|---|---|
| `syntax` | `core.ttl` is not valid Turtle |
| `value-missing-from-ontology` / `value-not-in-implementation` | a closed list differs between the ingest and the ontology |
| `value-list-not-in-ontology` / `value-list-not-enforced` | one side has a closed list and the other has none |
| `ingest-field-unmapped` / `ingest-type-mismatch` | an ingest field has no column (or alias), or the types are incompatible |
| `ingest-entity-unclassified` | a new ingest entity type is neither a class nor out of scope |
| `registry-type-undefined`, `ownership-*` | a code-side type list names a type the ontology lacks |
| `relationship-endpoint-mismatch`, `polymorphic-target-mismatch`, `fk-type-mismatch` | a relationship does not fit its edge table |
| `context-type-undefined`, `context-type-unused`, `context-producer-*`, `context-target-type-mismatch`, `plugin-context-types-undeclared` | context types differ between the plugins, the code and the ontology |
| `context-target-type-missing`, `context-target-type-invalid`, `context-annotation-misplaced` | a context type's annotations are incomplete or misplaced |
| `template-missing`, `template-ambiguous`, `template-misplaced` | a type has no template, two templates, or a template sits outside the three kinds of node |
| `expands-access-mismatch`, `control-permission-link` | what holding a resource reaches differs from the engine, or a control permission is not linked to what it controls |
| `accountability-default-misplaced`, `accountability-default-invalid` | an accountability default sits on the wrong class or names no `ia:Accountability` value |
| `holding-bypass` | an edge table other than `ResourceAssignments` runs from an account or a person to a resource |
| `crawler-type-undefined`, `crawler-emitter-*`, `crawler-passthrough-mismatch`, `crawler-emits-invalid` | the types a crawler manifest declares differ from the ontology |
| `emitted-by-misplaced`, `passthrough-misplaced` | a crawler annotation sits on the wrong kind of class |
| `conflicting-declaration`, `conflicting-annotation`, `duplicate-identifier`, `duplicate-type-value`, `undeclared-term`, `undeclared-reference`, `naming-convention` | the ontology contradicts itself |
| `db-column-undescribed`, `db-column-missing`, `db-column-type`, `db-check-mismatch`, `db-check-not-in-ontology` | the migrated database differs (contract test) |
| `example-type`, `example-property`, `example-domain`, `example-range`, `example-dangling`, `example-value`, `example-target-type`, `example-edge-ends`, `example-empty` | an example in `ontology/examples` does not fit the ontology |
| `diagram-unclassified`, `diagram-stale`, `diagram-unknown-attribute`, `reference-stale` | the docs differ |
| `stale-known-gap`, `stale-out-of-scope` | `validation.json` lists something that no longer happens |

## Versioning

Bump `owl:versionInfo` (and `owl:versionIRI`) in `core.ttl` when a pull request changes the model:
minor for an addition, major for a removal or a changed meaning. Future extensions record the core
version they were made against.

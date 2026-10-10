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
list the registry reads — add a subclass of `ia:Resource` (or of `ia:OwnershipResource` for an
ownership type) with `ia:typeValue`.

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
| `conflicting-declaration`, `conflicting-annotation`, `duplicate-identifier`, `duplicate-type-value`, `undeclared-term`, `undeclared-reference`, `naming-convention` | the ontology contradicts itself |
| `db-column-undescribed`, `db-column-missing`, `db-column-type`, `db-check-mismatch`, `db-check-not-in-ontology` | the migrated database differs (contract test) |
| `diagram-unclassified`, `diagram-stale`, `diagram-unknown-attribute`, `reference-stale` | the docs differ |
| `stale-known-gap`, `stale-out-of-scope` | `validation.json` lists something that no longer happens |

## Versioning

Bump `owl:versionInfo` (and `owl:versionIRI`) in `core.ttl` when a pull request changes the model:
minor for an addition, major for a removal or a changed meaning. Future extensions record the core
version they were made against.

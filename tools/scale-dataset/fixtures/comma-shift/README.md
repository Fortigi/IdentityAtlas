# Comma-shift fixture

Comma-delimited, correctly quoted (RFC 4180) CSV in the crawler's canonical schema.
Every entitlement value is an LDAP distinguished name, so every `Resources.csv` row
has quoted fields containing commas:

```
ExternalId,DisplayName,ResourceType,Description,SystemName,Enabled,EntitlementValue
E-ed294510,"CN=GRP-CRM-APPROVE-1TSXQMO,OU=Application Groups,OU=East,DC=corp,DC=example,DC=com",Group,...
```

A reader that splits each line on `,` without honouring quotes (the CSV crawler's
fast path, `Read-CsvFast`) gets 19 cells for that first row instead of 7, and
`SystemName` reads `DC=corp` instead of `Directory Catalog 03` — the row is then
silently routed to the fallback system. A correct reader gets exactly seven fields
per row.

Regenerate with `generateCommaFixture()` from `../../lib/generate.mjs` (the
generator also writes it to `<out>/comma-shift-fixture/` on every run); a test in
`../../generate.test.js` fails if these files drift from what it emits.

# Connect a system through CSV files

The CSV Import crawler loads authorization data from CSV files you upload. Any system that can export a table — an HR platform, a PAM tool, a ticketing system, a home-grown application — can be loaded this way, as long as the files follow the Identity Atlas CSV schema.

**Use this when** there is no crawler for your source, or the source can only give you exports. If a crawler for your source exists — Entra ID, Azure, Omada, midPoint, SQL Server, SCIM — use that instead: it keeps the data up to date by itself.

---

## What you get

Each file becomes one kind of data in Identity Atlas. Only `Resources.csv`, `Users.csv` and `Assignments.csv` are required; every other file adds depth.

| File | In Identity Atlas |
|---|---|
| `Systems.csv` | Systems. Without it, everything goes into the one system you name in the wizard |
| `Users.csv` | Accounts |
| `Resources.csv` | Resources — groups, roles, permissions. A row with `ResourceType` `BusinessRole` is a business role |
| `Assignments.csv` | Assignments: **Direct**, **Indirect** or **Eligible**. Assignments to a business role are marked **governed** |
| `ResourceRelationships.csv` | What each resource contains |
| `Contexts.csv` | Contexts, such as departments or teams |
| `ContextMembers.csv` | Who or what belongs to each context |
| `Identities.csv` | Identities — the people behind the accounts |
| `IdentityMembers.csv` | Which accounts belong to which identity |
| `Certifications.csv` | Review decisions |

The columns of each file are in the [CSV schema reference](../architecture/csv-import-schema.md). After each run, Identity Atlas links accounts to identities and rebuilds contexts. The words used here are explained in the [glossary](../start/glossary.md).

---

## Before you start

- **Files in the Identity Atlas schema.** Column names must match the schema; the crawler does not guess. In the wizard, **Download schema templates** gives you empty CSV files with the right headers.
- **A transform for your source, if its export looks different.** Map the source's columns to the schema with a short script before you upload. An example script ships in `tools/csv-templates/transforms/`; see [Pre-import transformation](../architecture/csv-import-schema.md#pre-import-transformation).

---

## Add the crawler

1. Go to **Admin → Crawlers** and click **Add Crawler**.
2. Pick **CSV Import**.
3. **System info.** Enter a **Display name**, a **System name** and a **System type**, and pick the **CSV delimiter**. Click **Next: Upload files**.
4. **Upload files.** Click **Select folder** or **Select files**. Each file is matched to its type by its name; you can change the match per file. The wizard reads the first line of each file and warns when a required column is missing. **Required object types** shows which of the three required files are still missing. Click **Next: Review**.
5. **Review.** Check the summary and click **Create crawler**. The files are uploaded.
6. The crawler appears as a card. Click **Run Full** to load the files.

To load a new export later, click **Configure** on the card, replace the files on the **Upload files** step, save, and run the crawler again.

---

## Settings

| Wizard label | Meaning | Default |
|---|---|---|
| **Display name** | The name on the crawler's card. | CSV Import |
| **System name** | The name of the system the data goes into, when a row does not name one of the systems in `Systems.csv`. | CSV Import |
| **System type** | A label used to group systems in the UI. | CSV |
| **CSV delimiter** | **Semicolon (;)**, **Comma (,)**, **Tab** or **Pipe (\|)**. | Semicolon |

### File format

- **Dates** are ISO 8601.
- **Quoting** follows standard CSV: a quoted value may contain the delimiter, a doubled quote (`""` for `"`) or a line break. So a comma-delimited file whose values are distinguished names loads correctly when those values are quoted:

    ```csv
    ResourceExternalId,UserExternalId
    "CN=Finance,OU=Groups,DC=contoso,DC=com",u1001
    ```

    A row that cannot be read — a quote that is never closed, or text after a closing quote — **fails the run** with the file name and line number. A failed run never removes existing data.
- **Extra columns** — columns that are not in the schema — are kept on the record and shown on its detail page, for every file except `Assignments.csv`, `IdentityMembers.csv` and `ContextMembers.csv`. The job log names the columns it ignores. You do not need to strip your exports first.

### Large files

`Resources.csv` and `Assignments.csv` are read and sent in batches, so tens of millions of assignment rows are fine. The upload limit per file is set by the server (`UPLOAD_MAX_FILE_BYTES`, default 8 GiB) and shown on the **Upload files** step. When you edit a crawler, that step also shows the crawler's folder on the server: a file copied straight into that folder is read exactly like an uploaded one.

### More than one system

A row's `SystemName` must match a system in `Systems.csv`, or the **System name** from the wizard. A row that names an unknown system is still loaded, into the wizard's system, and the job log warns with the number of such rows and the names it did not find. A blank `SystemName` is the normal single-system case.

---

## Schedule and refresh

CSV Import has no schedule: it reads the files that are uploaded, so it runs when you start it. **Run Full** and **Run Delta** on the card do the same thing — every run is a full run. See [Schedule and run crawlers](scheduling.md).

---

## What a refresh removes

Each run compares the files with what this crawler loaded last time. Records that are no longer in the files are removed, limited to this crawler's own systems. So always upload a complete export, not only the new rows. See [What a full run removes](scheduling.md#what-a-full-run-removes).

---

## Limitations

- **Only the Identity Atlas schema is read.** There is no column mapping in the wizard; transform your export first.
- **No schedule.** New data arrives when you upload new files.
- **Extra columns in `Assignments.csv`, `IdentityMembers.csv` and `ContextMembers.csv` are not kept.**

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The **Upload files** step says *Missing column(s) for …* | The file is matched to the wrong type, or its header does not follow the schema. Pick the right type for the file, or compare it with the schema template. |
| **Next: Review** stays disabled | One of the three required files — Resources, Users, Assignments — is missing. |
| A file is refused as too large | It is over the server's per-file limit. An administrator can raise `UPLOAD_MAX_FILE_BYTES`, or copy the file into the crawler's folder on the server. |
| The run fails with a file name and line number | That row could not be read, usually because of a quote that is never closed. Fix the row and run again. Nothing was removed. |
| The job log warns about an unknown system name | Some rows name a system that is not in `Systems.csv`. They were loaded into the wizard's system. |

---

## Deep dive

- [CSV schema reference](../architecture/csv-import-schema.md) — every file and column
- [Schedule and run crawlers](scheduling.md)
- [Ingest API](../architecture/ingest-api.md)

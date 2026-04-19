# Authoring the Excel Power Query template

This document is for the maintainer creating `tools/excel-queries/template.xlsx`.
End users never see this file — they only get a copy with their token stamped
in. The template is the **shape** of the workbook (sheets, named ranges,
queries) that the backend mutates per request.

When this file exists in the repo, the download endpoint switches from the
"M-as-text, paste yourself" MVP to the polished "open → click Refresh" flow
automatically. No code change needed once the template is committed.

## The two placeholders

The backend swaps two strings in the saved workbook:

| Placeholder      | Settings sheet cell | Will be replaced with                 |
| ---------------- | ------------------- | ------------------------------------- |
| `{{BASE_URL}}`   | B2                  | The download host's `/api` base       |
| `{{AUTH_TOKEN}}` | B3                  | A freshly minted `fgr_…` read token   |

Use these exact strings — the backend matches them verbatim. Don't introduce
extra whitespace inside the curly braces.

## Step by step

### 1. Bootstrap the workbook with a real token (so you can validate)

1. Open Identity Atlas → **Admin → Data → Excel Power Query Workbook**.
2. Click **Generate token & download workbook**. Save the file somewhere
   throwaway — you'll only use this to crib the M code from each tab.
3. Note your local API URL (`http://localhost:3001/api`) and the token
   shown in the Settings sheet of that downloaded file.

### 2. Build the template structure

In a fresh Excel workbook, create these sheets, in this order. Sheet names
must match exactly — they're the named-range / connection labels:

1. **Settings**
2. **Systems**
3. **Principals**
4. **Resources**
5. **Assignments**
6. **Identities**
7. **IdentityMembers**
8. **ResourceRelationships**

(Optional but nice: add a **README** sheet at the front with usage notes.)

### 3. Wire up the Settings sheet

On the **Settings** sheet:

| Cell | Value         |
| ---- | ------------- |
| A1   | Setting       |
| B1   | Value         |
| A2   | BaseUrl       |
| B2   | _your real `http://localhost:3001/api` for now_ |
| A3   | AuthToken     |
| B3   | _your real `fgr_…` token for now_ |

Define two named ranges (Formulas → Name Manager → New):

- **BaseUrl** → refers to `=Settings!$B$2`
- **AuthToken** → refers to `=Settings!$B$3`

> The Power Query M code reads these via
> `Excel.CurrentWorkbook(){[Name="BaseUrl"]}[Content]{0}[Column1]`. If the
> names go missing, every query stops working at refresh time.

### 4. Add one Power Query per data sheet

For each of the 7 data sheets:

1. Activate that sheet (e.g. **Principals**).
2. **Data → Get Data → From Other Sources → Blank Query**.
3. The Power Query Editor opens. **Home → Advanced Editor**.
4. Paste the M code for that sheet (see "M code per sheet" below).
5. Click **Done**.
6. In the left sidebar (Queries), rename the query to match the sheet name
   exactly (e.g. `Principals` not `Query1`).
7. **Home → Close & Load To… → Existing worksheet → cell A1 of that sheet**.
   This wires the query output to a table on the right sheet.

Repeat for all 7 sheets. After each one, click **Refresh All** to confirm
data loads correctly. If a query fails, fix the M code and re-load.

### 5. Replace cell values with placeholders, save, do NOT refresh again

Once everything refreshes cleanly:

1. On the Settings sheet, change cell **B2** to `{{BASE_URL}}` (literal text).
2. Change cell **B3** to `{{AUTH_TOKEN}}`.
3. **Do not click Refresh** — the queries would try to hit
   `http://{{BASE_URL}}/users` and fail. Just save.
4. **File → Save As** → `tools/excel-queries/template.xlsx`.
5. Commit.

The backend test suite has fixtures pinning the placeholder strings — if
they ever change, tests catch it.

## M code per sheet

Each block goes verbatim into the Advanced Editor. The names match the
constants in [`app/api/src/export/queryTemplates.js`](../../app/api/src/export/queryTemplates.js)
— if the templates change there, regenerate the workbook by downloading
the M-as-text MVP version (Admin → Data → Generate token & download
workbook), open it, and copy the updated M from each sheet's cell A6.

(See the downloaded MVP file. Each sheet's A6 cell contains the exact M
code for that endpoint, ready to paste.)

## Sanity-check the saved file

Before committing:

1. Close Excel.
2. Reopen `template.xlsx`. The Settings sheet should show the two
   `{{...}}` placeholders verbatim.
3. **Don't click Refresh** — there's nothing to refresh against.
4. Right-click each query in the Queries pane → **Properties** → confirm
   the query name matches the sheet name.

## What the backend does at download time

The download endpoint (`POST /api/admin/data-export/workbook`) does this
to each request:

1. Mint a new `fgr_…` read token.
2. Open `tools/excel-queries/template.xlsx` as a zip.
3. Replace `{{BASE_URL}}` with the request's API base in every XML part.
4. Replace `{{AUTH_TOKEN}}` with the new token in every XML part.
5. Re-zip and stream the result.

Excel stores cell values either inline or in `xl/sharedStrings.xml`. The
backend doesn't care which — it does string replace on the entire archive,
so as long as the placeholders are unique (which `{{BASE_URL}}` and
`{{AUTH_TOKEN}}` are, by construction) the swap is safe.

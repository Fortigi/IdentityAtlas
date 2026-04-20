// Power Query M templates for the Excel data-export workbook.
//
// Each entry produces one Excel sheet with the M code printed in cell A1
// (multi-line), ready to be pasted into Power Query Editor:
//   Data → Get Data → Other Sources → Blank Query → Advanced Editor → paste.
//
// All queries pull credentials from the workbook's two named ranges
// (`BaseUrl`, `AuthToken`) instead of hard-coding them, so when the user
// rotates their token they only have to update one cell on the Settings
// sheet — the queries pick the new value up on the next refresh.
//
// Pagination strategy: every list endpoint returns `{ data, total }`. We
// fetch the first page to read `total`, then List.Generate pulls the rest
// in 1000-record steps and List.Combine flattens. PAGE_SIZE deliberately
// matches the bulkLists default so we never get throttled by a smaller cap.

const PAGE_SIZE = 1000;

// Shared paginated fetch template. Two responsibilities:
//
//   1. Walk the entire dataset across N pages of PAGE_SIZE records. We use
//      List.Numbers to compute the page offsets up-front instead of the
//      stateful List.Generate pattern — the latter has a record-self-
//      reference foot-gun (`[off]` inside the next-state record literal
//      gets parsed as forward field reference, not `_[off]`) that silently
//      caps the loop at 4 iterations against the local stack.
//
//   2. Auto-expand the JSONB `extendedAttributes` column so users see the
//      sub-keys (userType, onPremisesSyncEnabled, signInActivity, etc.) as
//      first-class columns instead of "Record" cells they have to click
//      one by one. Keys are collected as the union across every row so
//      sparsely-populated keys (only some users have employeeId) still
//      appear. Expanded columns are prefixed `ext_` to avoid collisions
//      with real columns of the same name.
//
// The user never edits this; they edit BaseUrl / AuthToken on the Settings
// sheet and the queries pick up the new values on the next refresh.
const PAGINATED_FETCH = `
let
  BaseUrl = Excel.CurrentWorkbook(){[Name="BaseUrl"]}[Content]{0}[Column1],
  AuthToken = Excel.CurrentWorkbook(){[Name="AuthToken"]}[Content]{0}[Column1],
  Headers = [#"Authorization" = "Bearer " & AuthToken],
  PageSize = ${PAGE_SIZE},
  FetchPage = (offset as number) =>
      Json.Document(Web.Contents(BaseUrl, [
          RelativePath = "ENDPOINT_PATH",
          Query = [limit = Text.From(PageSize), offset = Text.From(offset)],
          Headers = Headers
      ])),
  First = FetchPage(0),
  Total = First[total],
  FirstRows = First[data],
  // Walk pages by actual row count — not by arithmetic over Total. Two
  // failure modes this design guards against:
  //   1. The server returns fewer rows than PageSize (historical cap, or a
  //      partial tail page). Arithmetic walks silently truncate.
  //   2. The last page (partial) gets dropped by the condition check. The
  //      previous version had a \`done\` flag that flipped true right when
  //      the tail page had been fetched, and List.Generate skips a state
  //      whose condition evaluates false — so 911 rows on the last page
  //      vanished and the user saw 7,000 instead of 7,911.
  //
  // Contract of the state: [rows = rows-to-emit, nextOff = offset of NEXT
  // fetch]. Selector emits state[rows] unconditionally; condition asks
  // "does the state have rows to emit?"; next() fetches one more page
  // (or short-circuits to an empty state when we've reached Total so the
  // next condition evaluation stops the loop cleanly).
  Pages = List.Generate(
      () => [rows = FirstRows, nextOff = List.Count(FirstRows)],
      (state) => List.Count(state[rows]) > 0,
      (state) =>
          if state[nextOff] >= Total then [rows = {}, nextOff = state[nextOff]]
          else
              let
                  page = FetchPage(state[nextOff]),
                  fetched = page[data]
              in
                  [rows = fetched, nextOff = state[nextOff] + List.Count(fetched)],
      (state) => state[rows]
  ),
  AllRows = List.Combine(Pages),
  Table = Table.FromList(AllRows, Splitter.SplitByNothing(), null, null, ExtraValues.Error),
  Expanded = if List.IsEmpty(AllRows) then Table
             else Table.ExpandRecordColumn(Table, "Column1", Record.FieldNames(AllRows{0})),
  // Auto-expand extendedAttributes. The keys vary per row — collect the
  // union so we don't lose any. ext_ prefix avoids name collisions with
  // real columns. Skipped if the table doesn't have an extendedAttributes
  // column (most join-table endpoints).
  HasExt = List.Contains(Table.ColumnNames(Expanded), "extendedAttributes"),
  ExtKeys = if not HasExt then {} else List.Distinct(
      List.Combine(List.Transform(Expanded[extendedAttributes],
          (r) => if r = null then {} else Record.FieldNames(r)))),
  ExtExpanded = if not HasExt or List.IsEmpty(ExtKeys) then Expanded
                else Table.ExpandRecordColumn(Expanded, "extendedAttributes",
                    ExtKeys, List.Transform(ExtKeys, (k) => "ext_" & k))
in
  ExtExpanded
`.trim();

function paginatedQuery(endpointPath) {
  return PAGINATED_FETCH.replace('ENDPOINT_PATH', endpointPath);
}

// `/api/systems` predates the {data,total} convention used by every other
// list endpoint — it returns a plain JSON array. We use a simpler M
// template so the Systems tab still works without changing the UI-facing
// API contract.
const ARRAY_FETCH = `
let
  BaseUrl = Excel.CurrentWorkbook(){[Name="BaseUrl"]}[Content]{0}[Column1],
  AuthToken = Excel.CurrentWorkbook(){[Name="AuthToken"]}[Content]{0}[Column1],
  Headers = [#"Authorization" = "Bearer " & AuthToken],
  Source = Json.Document(Web.Contents(BaseUrl, [
      RelativePath = "ENDPOINT_PATH",
      Headers = Headers
  ])),
  Table = Table.FromList(Source, Splitter.SplitByNothing(), null, null, ExtraValues.Error),
  Expanded = if List.IsEmpty(Source) then Table
             else Table.ExpandRecordColumn(Table, "Column1", Record.FieldNames(Source{0})),
  // Same extendedAttributes auto-expand as PAGINATED_FETCH — Systems has ext
  // attrs too (tenant id, connector settings, etc.)
  HasExt = List.Contains(Table.ColumnNames(Expanded), "extendedAttributes"),
  ExtKeys = if not HasExt then {} else List.Distinct(
      List.Combine(List.Transform(Expanded[extendedAttributes],
          (r) => if r = null then {} else Record.FieldNames(r)))),
  ExtExpanded = if not HasExt or List.IsEmpty(ExtKeys) then Expanded
                else Table.ExpandRecordColumn(Expanded, "extendedAttributes",
                    ExtKeys, List.Transform(ExtKeys, (k) => "ext_" & k))
in
  ExtExpanded
`.trim();

function arrayQuery(endpointPath) {
  return ARRAY_FETCH.replace('ENDPOINT_PATH', endpointPath);
}

// Each tab description follows the {sheet, endpoint, m} shape. The `sheet`
// becomes the Excel tab label and the named query name; `endpoint` is the
// API path inside `RelativePath` (so the workbook works against any host).
export const QUERIES = [
  { sheet: 'Systems',                endpoint: 'systems',                m: arrayQuery('systems') },
  { sheet: 'Principals',             endpoint: 'users',                  m: paginatedQuery('users') },
  { sheet: 'Resources',              endpoint: 'resources',              m: paginatedQuery('resources') },
  { sheet: 'Assignments',            endpoint: 'assignments',            m: paginatedQuery('assignments') },
  { sheet: 'Identities',             endpoint: 'identities',             m: paginatedQuery('identities') },
  { sheet: 'IdentityMembers',        endpoint: 'identity-members',       m: paginatedQuery('identity-members') },
  { sheet: 'ResourceRelationships',  endpoint: 'resource-relationships', m: paginatedQuery('resource-relationships') },
];

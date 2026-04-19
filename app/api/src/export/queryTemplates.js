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

// Single shared M function: paginate(endpoint, extraQuery)
// Returns the combined `data` array as a list of records.
//
// Heredoc-style template literal — we substitute PAGE_SIZE only. The user
// never edits this; they edit BaseUrl and AuthToken on the Settings sheet.
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
  Pages = if Total <= PageSize then {First}
          else List.Generate(
              () => [page = First, off = 0],
              each [off] < Total,
              each [page = FetchPage([off] + PageSize), off = [off] + PageSize],
              each [page]
          ),
  Combined = List.Combine(List.Transform(Pages, each _[data])),
  Table = Table.FromList(Combined, Splitter.SplitByNothing(), null, null, ExtraValues.Error),
  Expanded = Table.ExpandRecordColumn(Table, "Column1", Record.FieldNames(Combined{0}))
in
  Expanded
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
             else Table.ExpandRecordColumn(Table, "Column1", Record.FieldNames(Source{0}))
in
  Expanded
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

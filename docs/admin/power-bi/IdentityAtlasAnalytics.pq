// Identity Atlas — Analytics API → Power BI (Power Query M).
//
// One query per dataset of an Analytics Profile. Paste into Power BI Desktop:
// Home → Transform data → New source → Blank query → Advanced editor.
// Create the three parameters first (Home → Manage parameters → New):
//
//   AtlasUrl     Text  e.g. "https://atlas.example.com/api/analytics/v1/"   (trailing slash)
//   ProfileId    Text  the profile id from GET /api/analytics/v1/profiles
//   ReadToken    Text  an fgr_… read-only API key (Admin → Data export)
//
// Do NOT paste the token into this query: keep it in the ReadToken parameter so
// the .pbix/.pbit carries no credential of its own when you clear the value
// before sharing. Set the data source credential to "Anonymous" (the token
// travels in the Authorization header). See docs/admin/power-bi-analytics.md.
//
// NOT VERIFIED in Power BI Desktop or the Power BI Service by the author — no
// Power BI was available when this was written. It follows the same
// Web.Contents pattern (static base URL + RelativePath, header auth) as the
// Excel workbook export, which is known to refresh in Excel.

let
    // ── one function, reused by every dataset query ─────────────────────
    AtlasGet = (relativePath as text) as record =>
        Json.Document(
            Web.Contents(
                AtlasUrl,                                   // static base: keeps Service refresh possible
                [
                    RelativePath = relativePath,
                    Headers = [ #"Authorization" = "Bearer " & ReadToken, Accept = "application/json" ],
                    ManualStatusHandling = { 400, 404, 409, 422 }
                ]
            )
        ),

    // ── turn one dataset response into a typed table ────────────────────
    AtlasDataset = (datasetId as text) as table =>
        let
            Response   = AtlasGet("profiles/" & ProfileId & "/datasets/" & datasetId),
            Failed     = Record.HasFields(Response, "error"),
            Checked    = if Failed
                         then error Error.Record("IdentityAtlas." & Response[code], Response[error])
                         else Response,
            Columns    = Checked[columns],
            Names      = List.Transform(Columns, each [name]),
            // Records → table with the server's column order (rows may be empty).
            Raw        = Table.FromRecords(Checked[rows], Names, MissingField.UseNull),
            TypeOf     = (t as text) as type =>
                            if t = "integer" then Int64.Type
                            else if t = "decimal" then type number
                            else if t = "boolean" then type logical
                            else if t = "datetime" then type datetimezone
                            else type text,
            Typed      = Table.TransformColumnTypes(Raw, List.Transform(Columns, each { [name], TypeOf([type]) })),
            // Friendly names from the profile labels (dimension labels; measures keep their API names).
            Renamed    = Table.RenameColumns(Typed,
                            List.Select(List.Transform(Columns, each { [name], [label] }), each _{0} <> _{1}),
                            MissingField.Ignore)
        in
            Renamed,

    // ── pick the dataset this query loads ───────────────────────────────
    Result = AtlasDataset("accounts")
in
    Result

// Add one more query per dataset (copy this one, change "accounts").
// Add a "Metadata" query to show freshness, versions and limitations in the report:
//
//   let Meta = AtlasGet("profiles/" & ProfileId & "/metadata") in Meta
//
// (AtlasGet is local to the query above; for shared use, move it into its own
//  query named AtlasGet and reference it from the others.)

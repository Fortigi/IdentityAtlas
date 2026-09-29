// Downloading a workbook from a supertest agent, and reading it back.
//
// Shared because every xlsx assertion needs the same two awkward steps, and
// copying them is what the jscpd delta gate catches: supertest parses a
// response by content type and has no parser for a zip, so a binary download
// has to bring its own; and the only honest way to assert on a workbook is to
// open it with the library that wrote it rather than to trust the calls the
// serializer made.
//
// Works for both callers — a `request(app).get(...)` in a unit test and an
// `agent.get(...)` in a contract test are the same supertest Test object.

/**
 * Collect a response body as raw bytes instead of letting supertest parse it.
 * Takes the Test object, returns it, so it chains: `await asBinary(agent.get(u))`.
 */
export function asBinary(test) {
  return test.buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

/** The first worksheet of a downloaded workbook. */
export async function firstSheet(buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.worksheets[0];
}

/**
 * Every value in column A, top to bottom — the summary block, the header row's
 * first label and then the rows. What a reader sees down the left of the sheet.
 */
export function columnA(sheet) {
  const values = [];
  sheet.eachRow(row => values.push(row.getCell(1).value));
  return values;
}

/** The labels of the header row, found by its first cell. */
export function headerLabels(sheet, firstLabel) {
  const labels = [];
  sheet.eachRow(row => {
    if (row.getCell(1).value === firstLabel && labels.length === 0) {
      row.eachCell(cell => labels.push(cell.value));
    }
  });
  return labels;
}

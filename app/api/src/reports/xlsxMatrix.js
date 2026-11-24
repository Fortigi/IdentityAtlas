// A small matrix on its own workbook tab: labelled rows, labelled columns, one
// short value per cell. A report asks for one by returning `matrices`, so this
// knows nothing about any report.
//
//   { name, title, note, corner, columns: [label],
//     rows:   [{ label, cells: [{ value, tone } | null] }],
//     footer: [{ label, cells: [value] }] }
//
// A cell's tone colours it; its value still says what it means, so the sheet
// reads the same printed in black and white.

const FIRST_TABLE_ROW = 4;
const LABEL_WIDTH = 42;
const COLUMN_WIDTH = 16;

const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const HEADER_FILL = solid('FFF3F4F6');
const TONES = {
  automatic: { fill: solid('FFDCFCE7'), font: { color: { argb: 'FF166534' } } },
  manual: { fill: solid('FFFEF3C7'), font: { bold: true, color: { argb: 'FF78350F' } } },
  unknown: { fill: solid('FFF3F4F6'), font: { color: { argb: 'FF374151' } } },
  held: { fill: solid('FFDBEAFE'), font: { bold: true, color: { argb: 'FF1E40AF' } } },
  missed: { fill: solid('FFFEE2E2'), font: { color: { argb: 'FF991B1B' } } },
};
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };

function writeHeader(sheet, matrix) {
  const row = sheet.getRow(FIRST_TABLE_ROW);
  [matrix.corner, ...matrix.columns].forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = String(label ?? '');
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    if (i > 0) cell.alignment = CENTER;
  });
}

function writeBody(sheet, rows, start) {
  rows.forEach((entry, r) => {
    const row = sheet.getRow(start + r);
    row.getCell(1).value = String(entry.label ?? '');
    entry.cells.forEach((held, c) => {
      if (!held) return;
      const cell = row.getCell(c + 2);
      cell.value = held.value;
      cell.alignment = CENTER;
      const tone = TONES[held.tone];
      if (tone) { cell.fill = tone.fill; cell.font = tone.font; }
    });
  });
}

function writeFooter(sheet, footer, start) {
  footer.forEach((entry, r) => {
    const row = sheet.getRow(start + r);
    [entry.label, ...entry.cells].forEach((value, i) => {
      const cell = row.getCell(i + 1);
      cell.value = value ?? null;
      cell.font = { bold: true };
      cell.border = { top: { style: 'medium', color: { argb: 'FF9CA3AF' } } };
      if (i > 0) cell.alignment = CENTER;
    });
  });
}

/** One tab per matrix, in order. `nameOf` makes a label a legal sheet name. */
export function writeMatrixSheets(workbook, matrices, nameOf) {
  for (const matrix of Array.isArray(matrices) ? matrices : []) {
    const sheet = workbook.addWorksheet(nameOf(matrix.name));
    sheet.getColumn(1).width = LABEL_WIDTH;
    matrix.columns.forEach((_, i) => { sheet.getColumn(i + 2).width = COLUMN_WIDTH; });
    sheet.getCell('A1').value = String(matrix.title ?? '');
    sheet.getCell('A1').font = { bold: true, size: 14 };
    sheet.getCell('A2').value = String(matrix.note ?? '');
    sheet.getCell('A2').font = { size: 10, color: { argb: 'FF4B5563' } };
    writeHeader(sheet, matrix);
    const bodyStart = FIRST_TABLE_ROW + 1;
    writeBody(sheet, matrix.rows, bodyStart);
    writeFooter(sheet, matrix.footer || [], bodyStart + matrix.rows.length);
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: FIRST_TABLE_ROW }];
  }
}

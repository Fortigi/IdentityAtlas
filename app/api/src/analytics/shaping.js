// Turning aggregate query rows into a dataset: derived measures, minimum
// group-size suppression, the row-count guard and the column contract.
//
// Pure functions — no database — so every rule here is unit-tested directly.

export class AnalyticsError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Refuse — never truncate — a result larger than the profile allows
 * (decision principle B2). Queries fetch maxRows + 1 so "exactly at the limit"
 * and "over it" can be told apart.
 */
export function assertWithinRowLimit(rowCount, maxRows) {
  if (rowCount > maxRows) {
    throw new AnalyticsError(422, 'dataset_too_large',
      `This dataset has more than ${maxRows} cells. Remove a dimension, or raise limits.maxRows `
      + 'if the dimensions really are categorical (a free-text attribute is the usual cause).',
      { maxRows });
  }
}

/** governedShare's derived measures, from the counted ones. */
export function deriveGovernedMeasures(row) {
  const pairs = row.pairs;
  const governed = row.governedPairs;
  return {
    ...row,
    ungovernedPairs: pairs - governed,
    unknownPairs: 0,
    governedShare: pairs > 0 ? Math.round((governed / pairs) * 10000) / 10000 : null,
  };
}

/**
 * Minimum group-size suppression. A cell whose population is 1..minGroupSize-1
 * keeps its dimension values but every measure becomes null and
 * `suppressed: true`. A population of 0 never reaches here (queries emit no
 * empty cells). Returns the new rows and how many were suppressed.
 */
export function suppressSmallCells(rows, { population, measures, minGroupSize }) {
  let suppressed = 0;
  const out = rows.map((row) => {
    const n = row[population];
    if (n > 0 && n < minGroupSize) {
      suppressed += 1;
      const masked = { ...row, suppressed: true };
      for (const m of measures) masked[m] = null;
      return masked;
    }
    return { ...row, suppressed: false };
  });
  return { rows: out, suppressed };
}

/**
 * Rename the positional dimension columns (d0, d1, …) to their field ids and
 * order every row's keys like `columns`, so Power BI sees one stable schema.
 */
export function namedRows(rawRows, dimensionIds, measureNames, extraLeading = []) {
  return rawRows.map((raw) => {
    const row = {};
    for (const k of extraLeading) row[k] = raw[k];
    dimensionIds.forEach((id, i) => { row[id] = raw[`d${i}`]; });
    for (const m of measureNames) row[m] = raw[m] === undefined ? null : raw[m];
    return row;
  });
}

/** The column contract of a dataset response. */
export function columnsFor({ dimensions, metric, leading = [] }) {
  return [
    ...leading,
    ...dimensions.map(d => ({ name: d.field, label: d.label, role: 'dimension', type: 'text', iri: d.iri, unknownLabel: d.unknownLabel })),
    ...metric.measures.map(m => ({ name: m.name, label: m.name, role: 'measure', type: m.type, description: m.description })),
    { name: 'suppressed', label: 'suppressed', role: 'flag', type: 'boolean', description: 'Measures withheld: the cell is smaller than the minimum group size.' },
  ];
}

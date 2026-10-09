// Organisation truth — the column profile of a list.
//
//   profileColumns(columns, rows) → ColumnProfile[]
//
// The exact shape the proposal (T3) and the wizard (T5) read; change it only
// together with them:
//
//   {
//     name:        string    the column header (as parse.js produced it)
//     index:       number    0-based position in the file
//     nonEmpty:    number    rows with a non-blank value
//     distinct:    number    distinct trimmed values among those
//     uniqueness:  number    distinct / nonEmpty, 0..1 rounded to 3 decimals (0 for an empty column)
//     duplicates:  number    nonEmpty − distinct
//     shape:       'email' | 'number' | 'date' | 'boolean' | 'text'
//                            the first of email, boolean, number, date that at
//                            least 80 % of the non-empty values have; else text
//     samples:     string[]  up to 5 distinct values, in file order
//   }
//
// Values are compared trimmed and case-sensitively (canonical keys are
// case-folded later, in applyRecipe; the profile shows the list as it is).
export const SAMPLE_COUNT = 5;
export const SHAPE_SHARE = 0.8;

const SHAPES = [
  ['email', (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)],
  ['boolean', (v) => /^(true|false|yes|no|ja|nee|y|n)$/i.test(v)],
  ['number', isNumberLike],
  ['date', isDateLike],
];

// Digits with an optional sign, thousands separators (. , space) and one
// decimal mark: 12, -3.5, 1.234.567, 10,5, 1 000. Two separators in a row or a
// letter anywhere make it text. (Written without nested quantifiers.)
function isNumberLike(v) {
  return /^[-+]?\d[\d\s.,]*$/.test(v) && !/[\s.,]{2}/.test(v) && !/[\s.,]$/.test(v);
}

// ISO dates (with an optional time, as parse.js writes xlsx dates) and the
// day-first / month-first forms lists use: 1-10-2026, 01/10/2026, 2026/10/01.
function isDateLike(v) {
  const rest = v.slice(10);
  return (/^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) && (rest === '' || /^[T ][\d:.]+Z?$/.test(rest)))
    || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(v)
    || /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v);
}

export function detectShape(values) {
  if (values.length === 0) return 'text';
  for (const [shape, test] of SHAPES) {
    const hits = values.filter(test).length;
    if (hits / values.length >= SHAPE_SHARE) return shape;
  }
  return 'text';
}

export function profileColumns(columns, rows) {
  return columns.map((name, index) => {
    const values = [];
    for (const row of rows) {
      const v = String(row?.[name] ?? '').trim();
      if (v !== '') values.push(v);
    }
    const distinctSet = new Set(values);
    const distinct = distinctSet.size;
    const nonEmpty = values.length;
    return {
      name,
      index,
      nonEmpty,
      distinct,
      uniqueness: nonEmpty === 0 ? 0 : Math.round((distinct / nonEmpty) * 1000) / 1000,
      duplicates: nonEmpty - distinct,
      shape: detectShape(values),
      samples: [...distinctSet].slice(0, SAMPLE_COUNT),
    };
  });
}

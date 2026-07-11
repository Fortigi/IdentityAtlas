// Local date formatter for the Admin sections. Kept separate from the two
// shared utilities it resembles because their behaviour differs and the Admin
// panels depend on this one:
//   - utils/formatters.formatDate returns '' for empty and a fixed
//     medium/short style; this returns the em-dash placeholder '—' and the
//     locale default toLocaleString(), and echoes an unparseable value back.
// Lives in its own module (not adminUi.jsx) so that file exports only React
// components (satisfies react-refresh/only-export-components).
export function fmt(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

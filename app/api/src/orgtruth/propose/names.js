// Organisation truth — naming helpers for the heuristic proposal.
//
// Pure string work: column headers and file names in, identifiers out. Kept apart
// from heuristic.js so each decision there reads as one line.

const MAX_TYPE = 64;
const MAX_ATTRIBUTE = 64;

// Words in a header, split at separators and at lower→upper case changes:
// "OwnerEmail" → [Owner, Email], "owner_e-mail" → [owner, e, mail].
export function words(text) {
  return String(text ?? '')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** "Owner name" → "ownerName", "BUDGET" → "budget"; '' when the header has no letters or digits. */
export function camelCase(text) {
  const parts = words(text);
  if (parts.length === 0) return '';
  return (parts[0].toLowerCase() + parts.slice(1).map(cap).join('')).slice(0, MAX_ATTRIBUTE);
}

/** "business owner" → "BusinessOwner". */
export function pascalCase(text) {
  return words(text).map(cap).join('').slice(0, MAX_TYPE);
}

// Words a file name carries that say nothing about what the rows are.
const FILE_NOISE = new Set(['export', 'list', 'lijst', 'overview', 'overzicht', 'extract', 'dump', 'final', 'copy', 'kopie', 'versie', 'version']);

/** English and Dutch plural → singular, for the last word of a type name. */
export function singular(word) {
  if (/ies$/i.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/en$/i.test(word) && word.length > 5) return word.slice(0, -2);
  if (/[^s]s$/i.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * The primary entity's type from the file name: "Projects.xlsx" → "Project",
 * "data-domains_2026-10.csv" → "DataDomain", "Projecten export.xlsx" → "Project".
 * "Item" when nothing usable is left.
 */
export function typeFromFileName(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  const kept = words(base).filter(w => !/^\d+$/.test(w) && !FILE_NOISE.has(w.toLowerCase()));
  if (kept.length === 0) return 'Item';
  kept[kept.length - 1] = singular(kept[kept.length - 1]);
  return pascalCase(kept.join(' ')) || 'Item';
}

/** `base`, or `base2`, `base3`… — the first not in `taken`. Adds the result to `taken`. */
export function uniqueName(base, taken) {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, MAX_TYPE - 3)}${n}`;
  taken.add(name);
  return name;
}

/** Lower-case letters and digits only, for comparing headers: "Owner_Name" → "ownername". */
export const squash = (text) => words(text).join('').toLowerCase();

// Pure column-mapping + delimiter-detection logic for the CSV crawler wizard.
//
// Extracted out of ConfigWizard.jsx's component closure so every rule here is
// unit-testable without rendering anything (tools/crawlers/CLAUDE.md → "Extract
// non-trivial logic into pure, exported functions"). The crawler applies the
// SAME rules at read time from the stored config — see CSVCrawler.Mapping.ps1.
//
// Detection happens here, in the wizard, and only here: the crawler never
// sniffs a delimiter, it applies the value the admin saw and saved. A guess the
// user cannot see is the one thing issue #1685 explicitly rules out.

import CSV_SLOTS from './csv-slots.json';

// The schema's own column lists, read from the shipped header-only templates in
// schema/*.csv — the same files Admin → Crawlers serves as "Download schema
// templates". Deriving them keeps ONE declaration of each file's schema instead
// of a second hand-kept copy here (CLAUDE.md → "Declare once").
const SCHEMA_TEMPLATES = import.meta.glob('./schema/*.csv', { query: '?raw', import: 'default', eager: true });

export const DEFAULT_DELIMITER = ';';

// Auto-detected candidates. Pipe is deliberately absent: it is still manually
// selectable, but a pipe in a single free-text column would outvote the real
// delimiter far too easily to detect from one header line.
export const DELIMITER_CANDIDATES = [',', ';', '\t'];

// Fields a multi-value cell may be split on (#1688 decision D6): the Assignments
// slot only, and exactly one of these per file — splitting both axes at once
// would multiply out into a cartesian product nobody asked for.
export const SPLITTABLE_SLOT = 'assignments';
export const SPLITTABLE_FIELDS = ['ResourceExternalId', 'UserExternalId'];

export const SOURCE_FORMATS = ['identityatlas', 'custom'];

// A tab was stored for years as the two-character string "\t": JSX does not
// process escapes inside an attribute value, so <option value="\t"> yielded a
// backslash and a t. Nothing downstream could bind that as a [char], so a
// Tab-configured job failed. The wizard stores U+0009 now; this normalizes the
// legacy form so an existing config starts working instead of needing a re-save.
// The crawler's Resolve-CsvDelimiterChar does the same on its side.
export function normalizeDelimiter(delimiter) {
  if (typeof delimiter !== 'string' || delimiter.length === 0) return '';
  if (delimiter === '\\t') return '\t';
  return delimiter;
}

// Human-readable name for a delimiter, for labels and review lines.
export function delimiterLabel(delimiter) {
  const d = normalizeDelimiter(delimiter);
  if (d === '\t') return 'Tab';
  if (d === ';') return 'Semicolon (;)';
  if (d === ',') return 'Comma (,)';
  if (d === '|') return 'Pipe (|)';
  return d || DEFAULT_DELIMITER;
}

// Parse a CSV header line into column names. Mirrors the crawler's
// Open-CsvFastReader header handling: strip a leading BOM, split on the
// delimiter's first char, and remove surrounding double-quotes. Returns [] for
// an empty/absent line.
export function parseCsvHeader(line, delimiter) {
  if (!line) return [];
  let s = line;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const norm = normalizeDelimiter(delimiter);
  const delim = norm.length ? norm[0] : DEFAULT_DELIMITER;
  return s.split(delim).map(c => {
    let h = c.trim();
    if (h.length >= 2 && h[0] === '"' && h[h.length - 1] === '"') h = h.slice(1, -1);
    return h.trim();
  });
}

// Case-insensitively find required columns absent from a parsed header. Mirrors
// the crawler's Assert-Columns / Get-Csv*Index guards (which reject a file
// missing its identifying columns) so a mis-mapped or wrong-schema file is
// caught at upload time — with a clear message — instead of only when the job
// later runs. Always called on the POST-mapping header (see mapHeaderColumns):
// validating the raw one would flag every mapped file as missing everything.
export function missingRequiredColumns(headerCols, requiredColumns) {
  if (!requiredColumns || requiredColumns.length === 0) return [];
  const have = new Set((headerCols || []).map(c => c.toLowerCase()));
  return requiredColumns.filter(rc => !have.has(rc.toLowerCase()));
}

// Which delimiter a header line is most likely using: parse it with each
// candidate and take the one yielding the most columns. A tie — including every
// single-column file, where all three yield exactly one — falls back to the
// config-level delimiter rather than to a fixed precedence order, so the value
// the admin chose in step 1 stays the answer when the file itself says nothing.
export function detectDelimiter(headerLine, fallback = DEFAULT_DELIMITER) {
  const fb = normalizeDelimiter(fallback) || DEFAULT_DELIMITER;
  if (!headerLine) return fb;
  let best = [];
  let bestCount = 0;
  for (const candidate of DELIMITER_CANDIDATES) {
    const count = parseCsvHeader(headerLine, candidate).length;
    if (count > bestCount) { bestCount = count; best = [candidate]; }
    else if (count === bestCount) best.push(candidate);
  }
  if (bestCount <= 1 || best.length !== 1) return fb;
  return best[0];
}

// The slot definition for a slot key, or undefined.
export function slotDef(slotKey) {
  return CSV_SLOTS.find(s => s.key === slotKey);
}

// The schema fields of a slot — the columns of its canonical template file, in
// template order. [] for an unknown slot or a slot with no template.
export function schemaColumnsFor(slotKey) {
  const def = slotDef(slotKey);
  if (!def) return [];
  const raw = SCHEMA_TEMPLATES[`./schema/${def.file}`];
  if (!raw) return [];
  const firstLine = String(raw).split(/\r?\n/)[0];
  return parseCsvHeader(firstLine, DEFAULT_DELIMITER).filter(Boolean);
}

// Pre-fill a mapping by exact, case-insensitive column-name match — the only
// automatic step, and a visible one: every field shows what it resolved to and
// is overridable. Fields with no same-named source column come back '' ("—
// unmapped —"), never a fuzzy guess.
export function autoMapColumns(headerCols, slotKey) {
  const byLower = new Map((headerCols || []).filter(Boolean).map(c => [c.toLowerCase(), c]));
  const out = {};
  for (const field of schemaColumnsFor(slotKey)) {
    out[field] = byLower.get(field.toLowerCase()) || '';
  }
  return out;
}

// The mapping entries that actually map something, as [schemaField, sourceColumn].
export function mappedPairs(mapping) {
  return Object.entries(mapping || {}).filter(([, source]) => !!source);
}

// The header a mapped file presents to the crawler: each mapped source column
// renamed to its schema field, every other column kept under its SOURCE name
// (that is what makes it an extended attribute under the name the source used).
export function mapHeaderColumns(headerCols, mapping) {
  const pairs = mappedPairs(mapping);
  if (pairs.length === 0) return [...(headerCols || [])];
  const renames = new Map();
  for (const [field, source] of pairs) renames.set(String(source).toLowerCase(), field);
  return (headerCols || []).map(c => renames.get(String(c).toLowerCase()) || c);
}

// Required schema fields a mapped file still does not supply. Reported per
// SCHEMA field (not per source column), because that is the thing the admin has
// to go and map.
export function missingMappedColumns(headerCols, mapping, requiredColumns) {
  return missingRequiredColumns(mapHeaderColumns(headerCols, mapping), requiredColumns);
}

// Mapped source columns the file does not actually have — a mapping that was
// saved against an earlier export. Named here so it is fixed in the wizard
// rather than failing the job later (the crawler fails loudly too, by design).
export function unknownMappedColumns(headerCols, mapping) {
  const have = new Set((headerCols || []).map(c => String(c).toLowerCase()));
  return mappedPairs(mapping)
    .filter(([, source]) => !have.has(String(source).toLowerCase()))
    .map(([, source]) => source);
}

// Two schema fields mapped onto one source column. One file feeding several
// schema slots is slice 2 of #1685; until it lands this is a configuration
// mistake, and the crawler refuses it rather than silently dropping one field.
export function duplicateMappedSources(mapping) {
  const seen = new Set();
  const dupes = new Set();
  for (const [, source] of mappedPairs(mapping)) {
    const key = String(source).toLowerCase();
    if (seen.has(key)) dupes.add(source);
    seen.add(key);
  }
  return [...dupes];
}

// Every reason a per-file mapping is not usable yet, as display strings. [] when
// the file is good to save.
export function mappingErrors(headerCols, mapping, slotKey) {
  const def = slotDef(slotKey);
  if (!def) return [];
  const errors = [];
  const missing = missingMappedColumns(headerCols, mapping, def.requiredColumns);
  if (missing.length) errors.push(`Unmapped required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  const unknown = unknownMappedColumns(headerCols, mapping);
  if (unknown.length) errors.push(`Mapped column${unknown.length > 1 ? 's' : ''} not in the file: ${unknown.join(', ')}`);
  const dupes = duplicateMappedSources(mapping);
  if (dupes.length) errors.push(`Column${dupes.length > 1 ? 's' : ''} mapped to more than one field: ${dupes.join(', ')}`);
  return errors;
}

// Whether a slot's extra (unmapped) source columns survive the import, and the
// sentence the mapping panel shows about it. Mirrors
// CSVCrawler.Transform.ps1's $CsvReservedColumns / $CsvUnkeptColumnsSchema split.
export function extraColumnsNote(slotKey) {
  const def = slotDef(slotKey);
  if (!def) return '';
  return def.keepsExtraColumns === false
    ? 'Columns you leave unmapped are ignored for this file — they are named in the job log.'
    : 'Columns you leave unmapped are kept as extended attributes, under their source names.';
}

// Is a split offered for this slot + field? Assignments only, and only on one of
// the two identifying fields (D6).
export function canSplitField(slotKey, field) {
  return slotKey === SPLITTABLE_SLOT && SPLITTABLE_FIELDS.includes(field);
}

// The one split a file declares, as { field, delimiter }, or null. Takes the
// wizard's per-field split-delimiter map; the first splittable field with a
// non-empty delimiter wins, and the wizard only ever lets one be set.
export function splitFromFields(slotKey, splitDelimiters) {
  if (slotKey !== SPLITTABLE_SLOT) return null;
  for (const field of SPLITTABLE_FIELDS) {
    const delimiter = (splitDelimiters || {})[field];
    if (delimiter) return { field, delimiter };
  }
  return null;
}

// A per-file entry is only stored when it says something the canonical defaults
// do not: a non-canonical filename for its slot, a delimiter other than the
// config-level one, a column mapping, or a split. An otherwise-default entry is
// left out entirely, so a schema-shaped upload saves exactly the config it
// always did and the bypass path stays byte-identical.
export function isDefaultFileEntry(entry, defaultDelimiter) {
  if (!entry) return true;
  if (mappedPairs(entry.columns).length > 0) return false;
  if (entry.split) return false;
  if (normalizeDelimiter(entry.delimiter) !== normalizeDelimiter(defaultDelimiter)) return false;
  const def = slotDef(entry.slot);
  return !!def && def.file === entry.name;
}

// The config's `files` section from the wizard's per-file state.
//
// entries: [{ name, slot, delimiter, mapping, splitDelimiters }]. A file with no
// slot ("— Ignore —") is left out: nothing reads it. `columns` is only written
// in custom mode — an Identity Atlas-schema upload stores no mapping at all.
export function buildFilesConfig(entries, { defaultDelimiter = DEFAULT_DELIMITER, sourceFormat = 'identityatlas' } = {}) {
  const files = {};
  for (const e of entries || []) {
    if (!e?.name || !e.slot) continue;
    const columns = sourceFormat === 'custom' ? Object.fromEntries(mappedPairs(e.mapping)) : {};
    const split = sourceFormat === 'custom' ? splitFromFields(e.slot, e.splitDelimiters) : null;
    const entry = {
      name: e.name,
      slot: e.slot,
      delimiter: normalizeDelimiter(e.delimiter) || normalizeDelimiter(defaultDelimiter) || DEFAULT_DELIMITER,
      columns,
      split,
    };
    if (isDefaultFileEntry(entry, defaultDelimiter)) continue;
    const stored = { slot: entry.slot, delimiter: entry.delimiter };
    if (Object.keys(columns).length) stored.columns = columns;
    if (split) stored.split = split;
    files[e.name] = stored;
  }
  return files;
}

// The stored `files` section back into the wizard's per-file state for one file.
// A file the config says nothing about gets the config-level delimiter and an
// empty mapping — exactly how the crawler reads it.
export function fileEntryFromConfig(name, filesConfig, defaultDelimiter = DEFAULT_DELIMITER) {
  const stored = (filesConfig || {})[name] || null;
  const split = stored?.split && !Array.isArray(stored.split) ? stored.split : (Array.isArray(stored?.split) ? stored.split[0] : null);
  return {
    name,
    slot: stored?.slot ?? null,
    delimiter: normalizeDelimiter(stored?.delimiter) || normalizeDelimiter(defaultDelimiter) || DEFAULT_DELIMITER,
    mapping: { ...(stored?.columns || {}) },
    splitDelimiters: split?.field ? { [split.field]: split.delimiter } : {},
  };
}

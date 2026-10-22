// Context upload — the deterministic best guess of a mapping.
//
//   guessMapping({ fileName, profile, rowCount }) → mapping
//
// Pure: no model, no database. It ALWAYS returns a complete mapping (every field
// present, every column it names one of the file's) — the AI step only refines
// it, and the analyst confirms it. Header recognition is ported from the Org
// Info prototype (orgtruth/propose/heuristic.js and names.js): words split at
// separators and case changes, Dutch and English vocabulary, the key the column
// whose header says it is one.
//
// The mapping shape (shared with mapping.js, plan.js and the wizard):
//   { template: 'OrganizationalUnit' | 'LogicalApplication',
//     listName, nameColumn, keyColumn,
//     ownerColumn, responsibleColumn, parentColumn,          (null when none)
//     memberColumns: [{ column, kind: 'Identity'|'Principal'|'Resource', shape: 'list'|'long' }],
//     attributeColumns: [column, …] }

export const TEMPLATES = ['OrganizationalUnit', 'LogicalApplication'];
export const MEMBER_KINDS = ['Identity', 'Principal', 'Resource'];

// ─── Words ───────────────────────────────────────────────────────────────
/** Words in a header: "OwnerEmail" → [Owner, Email], "e-mail_eigenaar" → [e, mail, eigenaar]. */
export function words(text) {
  return String(text ?? '')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Lower-case letters and digits only: "Owner_Name" → "ownername". */
export const squash = (text) => words(text).join('').toLowerCase();

const lowerWords = (header) => words(header).map(w => w.toLowerCase());

// Does the header carry one of `vocabulary` as a word, or end in one of at least
// four letters? The suffix is for Dutch compounds: "Klantnummer" is a number,
// "Teamleden" are members, "Bedrijfsnaam" is a name.
export function says(header, vocabulary) {
  if (lowerWords(header).some(w => vocabulary.has(w))) return true;
  const s = squash(header);
  for (const v of vocabulary) if (v.length >= 4 && s.endsWith(v)) return true;
  return false;
}

// ─── Vocabulary (Dutch and English) ──────────────────────────────────────
const NAME_EXACT = new Set(['naam', 'name', 'displayname', 'weergavenaam', 'titel', 'title']);
const NAME_WORDS = new Set([...NAME_EXACT, 'omschrijving', 'description', 'klant', 'klantnaam', 'customer',
  'applicatie', 'application', 'organisatie', 'organisation', 'organization', 'afdeling', 'department', 'unit', 'eenheid']);
const KEY_WORDS = new Set(['id', 'code', 'key', 'sleutel', 'nummer', 'number', 'nr', 'no', 'kenmerk', 'identifier']);
const OWNER_WORDS = new Set(['owner', 'eigenaar', 'accountable', 'manager', 'accountmanager', 'applicatieeigenaar', 'businessowner']);
const RESPONSIBLE_WORDS = new Set(['responsible', 'verantwoordelijke', 'verantwoordelijk', 'beheerder', 'beheerders',
  'contact', 'contactpersoon', 'steward', 'custodian', 'administrator']);
const PARENT_WORDS = new Set(['parent', 'bovenliggend', 'bovenliggende', 'ouder', 'valtonder', 'hoofdafdeling', 'parentid', 'parentkey']);
const MEMBER_WORDS = {
  Identity: new Set(['medewerkers', 'werknemers', 'personen', 'people', 'persons', 'employees', 'staff', 'mensen']),
  Principal: new Set(['users', 'gebruikers', 'accounts', 'leden', 'members', 'deelnemers', 'participants', 'team', 'teamleden', 'teammembers']),
  Resource: new Set(['resources', 'applicaties', 'applications', 'apps', 'groepen', 'groups', 'rollen', 'roles',
    'rechten', 'permissions', 'entitlements', 'toegang', 'autorisaties']),
};
const APP_WORDS = new Set(['app', 'apps', 'applicatie', 'applicaties', 'application', 'applications', 'software', 'systemen', 'systems']);
const FILE_NOISE = new Set(['export', 'list', 'lijst', 'overview', 'overzicht', 'extract', 'dump', 'final', 'copy', 'kopie', 'versie', 'version', 'upload']);

// ─── List name ───────────────────────────────────────────────────────────
/** "klanten.xlsx" → "Klanten", "Klanten export 2026-10.csv" → "Klanten"; "List" when nothing is left. */
export function listNameFrom(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  const kept = words(base).filter(w => !/^\d+$/.test(w) && !FILE_NOISE.has(w.toLowerCase()));
  if (kept.length === 0) return 'List';
  const text = kept.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── Column roles ────────────────────────────────────────────────────────
const isFull = (c, rowCount) => c.nonEmpty > 0 && c.nonEmpty >= rowCount;

/** The member kind a header names, or null. */
export function memberKindOf(column) {
  for (const kind of MEMBER_KINDS) if (says(column.name, MEMBER_WORDS[kind])) return kind;
  // An unlabelled column of several e-mail addresses per cell holds accounts.
  if (column.shape === 'email' && column.multiValued > 0) return 'Principal';
  return null;
}

function pickName(cols) {
  const free = cols.filter(c => !memberKindOf(c) && c.shape !== 'email');
  return free.find(c => NAME_EXACT.has(squash(c.name)))
    ?? free.find(c => says(c.name, NAME_WORDS) && !says(c.name, OWNER_WORDS) && !says(c.name, RESPONSIBLE_WORDS))
    ?? free.find(c => c.shape === 'text' && c.uniqueness === 1)
    ?? free.find(c => c.shape === 'text')
    ?? cols[0];
}

// A key is a column whose header says it is one and whose values are unique on
// every row. Without one, the name is the key (the default the wizard explains).
function pickKey(cols, name, rowCount) {
  const keyish = cols.find(c => c !== name && says(c.name, KEY_WORDS) && c.uniqueness === 1 && isFull(c, rowCount));
  return keyish ?? name;
}

function pickRole(cols, vocabulary, taken) {
  return cols.find(c => !taken.has(c.name) && says(c.name, vocabulary)) ?? null;
}

/** The template a list is: an application register by its words, else organisation units. */
export function templateOf(fileName, nameColumn) {
  const text = [...lowerWords(fileName), ...lowerWords(nameColumn?.name)];
  return text.some(w => APP_WORDS.has(w)) ? 'LogicalApplication' : 'OrganizationalUnit';
}

// The member columns: one entry per column whose header names a kind, at most
// two kinds, the template's preferred kind first. A single-valued member column
// in a list whose names repeat is long format (one member per row).
function pickMembers(cols, taken, { template, keyRepeats }) {
  const found = cols
    .filter(c => !taken.has(c.name))
    .map(c => ({ column: c.name, kind: memberKindOf(c), shape: c.multiValued > 0 || !keyRepeats ? 'list' : 'long' }))
    .filter(m => m.kind);
  const preferred = template === 'LogicalApplication' ? 'Resource' : null;
  found.sort((a, b) => Number(b.kind === preferred) - Number(a.kind === preferred));
  const kinds = [...new Set(found.map(m => m.kind))].slice(0, 2);
  return found.filter(m => kinds.includes(m.kind));
}

/**
 * @param {object} args
 * @param {string} [args.fileName]
 * @param {object[]} args.profile   profile.js profileColumns()
 * @param {number} args.rowCount    data rows in the file
 * @returns {object} a complete mapping
 * @throws when the file has no column at all
 */
export function guessMapping({ fileName = '', profile, rowCount }) {
  const cols = Array.isArray(profile) ? profile : [];
  if (cols.length === 0) throw new Error('The list has no columns, so there is nothing to map.');
  const name = pickName(cols);
  const key = pickKey(cols, name, rowCount);
  const taken = new Set([name.name, key.name]);
  const claim = (c) => { if (c) taken.add(c.name); return c?.name ?? null; };
  const ownerColumn = claim(pickRole(cols, OWNER_WORDS, taken));
  const responsibleColumn = claim(pickRole(cols, RESPONSIBLE_WORDS, taken));
  const parentColumn = claim(pickRole(cols, PARENT_WORDS, taken));
  const template = templateOf(fileName, name);
  const memberColumns = pickMembers(cols, taken, { template, keyRepeats: key.uniqueness < 1 });
  for (const m of memberColumns) taken.add(m.column);
  return {
    template,
    listName: listNameFrom(fileName),
    nameColumn: name.name,
    keyColumn: key.name,
    ownerColumn,
    responsibleColumn,
    parentColumn,
    memberColumns,
    attributeColumns: cols.filter(c => !taken.has(c.name)).map(c => c.name),
  };
}

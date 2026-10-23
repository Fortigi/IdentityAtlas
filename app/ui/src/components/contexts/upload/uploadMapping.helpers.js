// Pure helpers for the "Upload a list" wizard: editing the mapping the API
// guessed, and reading its preview and result. No React, so every branch is
// unit-tested directly. The mapping shape is the API's
// (app/api/src/contexts/upload/guess.js; docs/architecture/context-upload.md).

import { memberKindLabel } from '@ui/utils/contextStyles';

// The wizard steps of the upload path (step 1 is the wizard's Source step).
export const UPLOAD_STEPS = { file: 2, mapping: 3, preview: 4 };

export const TEMPLATE_OPTIONS = [
  { value: 'OrganizationalUnit', label: 'Organisation units' },
  { value: 'LogicalApplication', label: 'Applications' },
];
export const KIND_OPTIONS = ['Principal', 'Identity', 'Resource'].map(value => ({ value, label: memberKindLabel(value) }));
export const SHAPE_OPTIONS = [
  { value: 'list', label: 'Several per cell' },
  { value: 'long', label: 'One per row' },
];

// The single-column roles, in the order the form shows them.
export const ROLE_FIELDS = [
  { field: 'nameColumn', label: 'Name', help: 'Becomes the name of each unit.', required: true },
  { field: 'keyColumn', label: 'Key', help: 'Matches a unit on the next upload of this list. Empty = the name.' },
  { field: 'ownerColumn', label: 'Owner', help: 'Becomes the Accountable: an e-mail address, employee number or account id.' },
  { field: 'responsibleColumn', label: 'Responsible', help: 'Added as Responsible; several per cell are fine.' },
  { field: 'parentColumn', label: 'Parent', help: 'The key of the unit above it. Empty = directly under the list.' },
];

const MAX_KINDS = 2;

/** Every column some role, member or attribute of the mapping takes. */
export function usedColumns(mapping) {
  const roles = ROLE_FIELDS.map(r => mapping[r.field]).filter(Boolean);
  return new Set([...roles, ...mapping.memberColumns.map(m => m.column)]);
}

/** Set one role column ('' clears it); a column taken by a role is no longer an attribute. */
export function withRole(mapping, field, column) {
  const value = column || null;
  return {
    ...mapping,
    [field]: value,
    attributeColumns: value ? mapping.attributeColumns.filter(c => c !== value) : mapping.attributeColumns,
  };
}

export function toggleAttribute(mapping, column) {
  const has = mapping.attributeColumns.includes(column);
  return { ...mapping, attributeColumns: has ? mapping.attributeColumns.filter(c => c !== column) : [...mapping.attributeColumns, column] };
}

/** Add a member column: the first column nothing uses yet, as accounts. Unchanged when every column is used. */
export function addMemberColumn(mapping, columns) {
  const used = usedColumns(mapping);
  const free = columns.find(c => !used.has(c) && !mapping.attributeColumns.includes(c))
    ?? columns.find(c => !used.has(c));
  if (!free) return mapping;
  return {
    ...mapping,
    memberColumns: [...mapping.memberColumns, { column: free, kind: 'Principal', shape: 'list' }],
    attributeColumns: mapping.attributeColumns.filter(c => c !== free),
  };
}

export function updateMember(mapping, index, patch) {
  const memberColumns = mapping.memberColumns.map((m, i) => (i === index ? { ...m, ...patch } : m));
  const attributeColumns = patch.column ? mapping.attributeColumns.filter(c => c !== patch.column) : mapping.attributeColumns;
  return { ...mapping, memberColumns, attributeColumns };
}

export function removeMember(mapping, index) {
  return { ...mapping, memberColumns: mapping.memberColumns.filter((_, i) => i !== index) };
}

/** What stops a preview, in the analyst's words. Empty when the mapping can be previewed. */
export function mappingProblems(mapping) {
  const problems = [];
  if (!mapping.listName?.trim()) problems.push('Give the list a name.');
  if (!mapping.nameColumn) problems.push('Choose the column that holds the name.');
  if (new Set(mapping.memberColumns.map(m => m.kind)).size > MAX_KINDS) {
    problems.push('At most two kinds of member: each kind becomes its own tree.');
  }
  return problems;
}

/** The trees this mapping makes: the member kinds, or one tree without members. */
export function treesOf(mapping) {
  const kinds = [...new Set(mapping.memberColumns.map(m => m.kind))];
  if (kinds.length === 0) return [mapping.listName];
  return kinds.map((kind, i) => (i === 0 ? mapping.listName : `${mapping.listName} · ${memberKindLabel(kind)}`));
}

/** "Suggested by the AI" applies to this field. */
export const aiSuggested = (aiFields, field) => Array.isArray(aiFields) && aiFields.includes(field);

/** The preview's counts as one line: "3 new · 1 changed · 4 unchanged · 2 not in this file". */
export function countsLine(contexts) {
  if (!contexts) return '';
  const parts = [
    `${contexts.created} new`,
    `${contexts.updated} changed`,
    `${contexts.unchanged} unchanged`,
  ];
  if (contexts.removed) parts.push(`${contexts.removed} removed`);
  if (contexts.notInFile) parts.push(`${contexts.notInFile} not in this file`);
  return parts.join(' · ');
}

// "(5 by name, 2 fuzzy)" — how many of the matches were found by name, or as a
// near miss; empty when all were found by address or id.
function howMatched(stats) {
  const how = [];
  if (stats.byName) how.push(`${stats.byName} by name`);
  if (stats.fuzzy) how.push(`${stats.fuzzy} fuzzy`);
  return how.length ? ` (${how.join(', ')})` : '';
}

/** Member (or owner) matching as one line: "41 matched (5 by name, 2 fuzzy) · 3 not found · 1 ambiguous". */
export function membersLine(stats) {
  if (!stats) return '';
  const parts = [`${stats.matched} matched${howMatched(stats)}`];
  if (stats.unmatched) parts.push(`${stats.unmatched} not found`);
  if (stats.ambiguous) parts.push(`${stats.ambiguous} ambiguous`);
  return parts.join(' · ');
}

/**
 * The upload path's footer for one step: the primary button's label, whether
 * it is blocked, and whether Back is offered (not on the file step of a
 * re-import, which was opened on its list and has no source step to go to).
 */
export function stepFooter(step, { file, problems, preview, updating, reimporting }) {
  if (step === UPLOAD_STEPS.file) return { label: 'Read the file ▸', blocked: !file, showBack: !reimporting };
  if (step === UPLOAD_STEPS.mapping) return { label: 'Preview ▸', blocked: problems.length > 0, showBack: true };
  return {
    label: updating ? 'Update the list' : 'Import',
    blocked: !preview || preview.errors.length > 0,
    showBack: true,
  };
}

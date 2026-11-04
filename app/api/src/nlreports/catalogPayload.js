// The report vocabulary as data: every entity with its fields (and the values an
// enum field actually holds here), relations, pickable columns and groupable
// fields, plus the operators. Served to the report builder (GET
// /api/nl-reports/catalog) and to AI assistants over MCP (describe_data_model),
// so both write definitions against the same, deployment-specific vocabulary.
//
// This deployment's own extendedAttributes fields are included: an attribute you
// can filter a list on is one you can build a report on. `discovered` travels
// with them so a client can keep them apart from the fields every install has.

import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE, fieldsOf } from './catalog.js';
import { availableColumns, groupableFields } from './spec.js';
import { loadExtFields } from './extFields.js';
import { loadValues } from './service.js';
import { MEASURES, manyRelationsOf } from './compare.js';

export async function buildCatalogPayload() {
  const values = await loadValues();
  const extFields = await loadExtFields();
  const entities = Object.fromEntries(Object.entries(ENTITIES).map(([name, e]) => [name, {
    label: e.label,
    table: e.table,
    description: e.description,
    compareRelations: manyRelationsOf(name),
    defaultColumns: e.defaultColumns,
    fields: Object.entries(fieldsOf(name, extFields)).map(([fname, f]) => ({
      name: fname, label: f.label, type: f.type,
      values: f.valuesFrom ? values[f.valuesFrom] || [] : undefined,
      discovered: f.discovered || undefined,
    })),
    relations: Object.entries(e.relations).map(([rname, r]) => ({ name: rname, label: r.label, target: r.target, cardinality: r.cardinality })),
    columns: availableColumns(name, extFields).map(({ key, label, discovered }) => ({ key, label, discovered })),
    groupableFields: groupableFields(name, extFields),
  }]));

  const operators = Object.fromEntries(Object.entries(OPERATORS).map(([k, o]) => [k, { label: o.label, needsValue: o.needsValue }]));
  const compareMeasures = Object.fromEntries(Object.entries(MEASURES).map(([k, m]) => [k, m.label]));
  return { entities, operators, operatorsByType: OPERATORS_BY_TYPE, compareMeasures };
}

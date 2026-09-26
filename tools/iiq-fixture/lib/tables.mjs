// Column order of every generated table, as bcp loads it: positional, so it
// must match sql/01-schema.sql exactly. generate.test.js parses the schema and
// fails when the two drift apart.

export const TABLES = Object.freeze({
  spt_database_version: ['name', 'system_version', 'schema_version'],
  spt_application: ['id', 'created', 'modified', 'owner', 'name', 'type', 'connector', 'authoritative', 'attributes'],
  spt_identity: [
    'id', 'created', 'modified', 'owner', 'name', 'display_name', 'firstname', 'lastname', 'email', 'manager',
    'inactive', 'workgroup', 'correlated', 'type', 'last_refresh', 'attributes',
    'userid', 'fullname', 'jobtitle', 'companyname', 'companycode', 'departmentnumber', 'costcentercode',
    'employeegroup', 'employeesubgroup', 'employeestatus', 'workcountry', 'locationid',
    'divcode', 'divtext', 'seccode', 'sectext', 'subdivcode', 'subdivtext', 'hiredate', 'termination_date',
  ],
  spt_managed_attribute: [
    'id', 'created', 'modified', 'owner', 'application', 'type', 'attribute', 'value', 'hash', 'displayable_name',
    'requestable', 'aggregated', 'uncorrelated', 'last_refresh', 'attributes',
    'requestdelegateonly', 'certfrequency', 'costcentercode', 'gpi_compliance', 'trainingcheck', 'ncdetection',
    'usexportcontrol', 'iiq_elevated_access',
  ],
  spt_identity_entitlement: [
    'id', 'created', 'modified', 'owner', 'identity_id', 'application', 'native_identity', 'instance', 'name', 'value',
    'display_name', 'annotation', 'type', 'aggregation_state', 'source', 'assigned', 'allowed', 'granted_by_role',
    'assigner', 'assignment_id', 'start_date', 'end_date', 'attributes',
  ],
  spt_bundle: ['id', 'created', 'modified', 'owner', 'name', 'display_name', 'displayable_name', 'type', 'disabled', 'attributes'],
  spt_identity_assigned_roles: ['identity_id', 'bundle', 'idx'],
  spt_bundle_profile_relation: [
    'id', 'created', 'modified', 'bundle_id', 'source_bundle_id', 'source_profile_id', 'application_id',
    'attribute', 'value', 'display_value', 'type', 'inherited',
  ],
  spt_custom: ['id', 'created', 'modified', 'owner', 'name', 'description', 'attributes'],
});

// Load order: referenced rows before the rows that reference them.
export const LOAD_ORDER = Object.freeze([
  'spt_database_version', 'spt_application', 'spt_identity', 'spt_custom', 'spt_managed_attribute',
  'spt_bundle', 'spt_bundle_profile_relation', 'spt_identity_assigned_roles', 'spt_identity_entitlement',
]);

// bcp's character mode has no quoting, so the terminators must be characters no
// value can contain. IdentityIQ's attribute XML is indented over several lines
// and values may hold tabs, so newline and tab are out; the ASCII unit and
// record separators are what they exist for.
export const FIELD_TERMINATOR = '\x1f';
export const ROW_TERMINATOR = '\x1e';

// One row → one bcp record. null / undefined / '' load as NULL.
export function bcpRecord(values) {
  let rec = '';
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const s = v === null || v === undefined ? '' : String(v);
    if (s.includes(FIELD_TERMINATOR) || s.includes(ROW_TERMINATOR)) {
      throw new Error(`Field ${i} contains a bcp terminator character: ${JSON.stringify(s.slice(0, 80))}`);
    }
    if (i > 0) rec += FIELD_TERMINATOR;
    rec += s;
  }
  return rec + ROW_TERMINATOR;
}

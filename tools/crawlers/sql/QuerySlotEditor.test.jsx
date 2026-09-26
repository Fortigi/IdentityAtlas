/**
 * Render test for one query slot of the Queries step. The wizard's static render
 * cannot step past Connection, so the per-target slot fields (which constants a
 * resources / assignments / relationships / identities slot shows) are asserted
 * on the editor directly.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import QuerySlotEditor from './QuerySlotEditor.jsx';
import { newQuerySlot } from './wizardLogic.js';

const render = slot => renderToStaticMarkup(h(QuerySlotEditor, { slot, index: 0, onUpdate: () => {}, onRemove: () => {} }));

describe('QuerySlotEditor render', () => {
  it('renders name, target, enabled toggle, remove button and the SQL textarea', () => {
    const html = render({ ...newQuerySlot(), name: 'Identities', sql: 'SELECT 1 FROM x' });
    expect(html).toContain('value="Identities"');
    expect(html).toContain('<select');
    expect(html).toContain('Enabled');
    expect(html).toContain('title="Remove query"');
    expect(html).toMatch(/<textarea[^>]*rows="8"[^>]*>SELECT 1 FROM x<\/textarea>/);
  });

  it('shows the column contract for the slot target', () => {
    expect(render(newQuerySlot('identities'))).toContain('Columns for <code>identities</code>: id, displayName');
    expect(render(newQuerySlot('relationships'))).toContain('Columns for <code>relationships</code>: parentId, childId');
  });

  it('an assignments slot shows resource type, assignment type and governed — not relationship or principal type', () => {
    const html = render({ ...newQuerySlot('assignments'), resourceType: 'Entitlement', governed: true });
    expect(html).toContain('Resource type');
    expect(html).toContain('value="Entitlement"');
    expect(html).toContain('Assignment type');
    expect(html).toContain('Governed');
    expect(html).not.toContain('Relationship type');
    expect(html).not.toContain('Default principal type');
    expect(html).toMatch(/<input type="checkbox" checked=""[^>]*\/>\s*Governed/);
  });

  it('a relationships slot shows only the relationship type', () => {
    const html = render(newQuerySlot('relationships'));
    expect(html).toContain('Relationship type');
    expect(html).toContain('GrantsAccessTo');
    expect(html).not.toContain('Resource type');
    expect(html).not.toContain('Governed');
  });

  it('a resources slot shows only the resource type', () => {
    const html = render(newQuerySlot('resources'));
    expect(html).toContain('Resource type');
    expect(html).not.toContain('Assignment type');
    expect(html).not.toContain('Governed');
  });

  it('identities and principals slots show the default principal type; identity-members shows no slot field', () => {
    expect(render(newQuerySlot('identities'))).toContain('Default principal type');
    expect(render(newQuerySlot('principals'))).toContain('ServicePrincipal');
    const html = render(newQuerySlot('identity-members'));
    for (const label of ['Resource type', 'Assignment type', 'Governed', 'Relationship type', 'Default principal type']) {
      expect(html).not.toContain(label);
    }
  });

  it('renders a disabled slot unticked', () => {
    const html = render({ ...newQuerySlot(), enabled: false });
    expect(html).toMatch(/<input type="checkbox"[^>]*\/>\s*Enabled/);
    expect(html).not.toMatch(/<input type="checkbox" checked=""[^>]*\/>\s*Enabled/);
  });

  it('does not crash on a slot whose target is unknown (no contract hint)', () => {
    const html = render({ ...newQuerySlot(), target: 'groups' });
    expect(html).not.toContain('Columns for');
  });
});

/**
 * The per-slot column mapping (source column → contract column). It is the
 * escape hatch for SQL whose column names cannot be changed, so what matters
 * here is that the dropdown offers the contract of *this* slot's target and
 * that a value left behind by a target change is still visible.
 */
describe('QuerySlotEditor column mapping', () => {
  const withRows = (target, columnMap) => render({ ...newQuerySlot(target), columnMap });

  it('offers the mapping under the SQL, collapsed and with no rows by default', () => {
    const html = render(newQuerySlot('identities'));
    expect(html).toContain('Column mapping');
    expect(html).toContain('<details>');
    expect(html).not.toContain('<details open');
    expect(html).toContain('+ Add mapping');
    expect(html).not.toContain('placeholder="EntitlementID"'); // no mapping row, so no source-column input
    expect(html).not.toContain('<option value="displayName">');
  });

  it('names the required contract columns of the target in the help line', () => {
    expect(render(newQuerySlot('identities'))).toContain('<code>identities</code> needs id and displayName — map your columns');
    expect(render(newQuerySlot('relationships'))).toContain('<code>relationships</code> needs parentId and childId — map your columns');
    expect(render(newQuerySlot('assignments'))).toContain('<code>assignments</code> needs resourceId and principalId — map your columns');
  });

  it('renders a stored mapping as rows, open, with a count badge', () => {
    const html = withRows('resources', [{ from: 'EntitlementID', to: 'id' }, { from: 'TechnicalApplication', to: 'displayName' }]);
    expect(html).toContain('<details open');
    expect(html).toContain('value="EntitlementID"');
    expect(html).toContain('value="TechnicalApplication"');
    expect(html).toContain('Source column');
    expect(html).toContain('Maps to');
    expect(html).toContain('>2</span>');
  });

  it('lists the contract columns of the slot target, required first, and no other target columns', () => {
    const identities = withRows('identities', [{ from: 'EMP_NR', to: '' }]);
    expect(identities).toContain('>(choose)</option>');
    expect(identities).toContain('<optgroup label="Required"><option value="id">id</option><option value="displayName">displayName</option></optgroup>');
    expect(identities).toContain('<option value="employeeId">employeeId</option>');
    expect(identities).not.toContain('<option value="resourceId">');
    expect(identities).not.toContain('<option value="parentId">');

    const assignments = withRows('assignments', [{ from: 'RoleID', to: '' }]);
    expect(assignments).toContain('<option value="resourceId">resourceId</option>');
    expect(assignments).toContain('<option value="principalId">principalId</option>');
    expect(assignments).toContain('<option value="identityId">identityId</option>');
    expect(assignments).not.toContain('<option value="employeeId">');
    expect(assignments).not.toContain('<option value="displayName">');
  });

  it('keeps a value the target no longer recognises visible instead of blanking it', () => {
    const html = withRows('identities', [{ from: 'SupRole', to: 'parentId' }]);
    expect(html).toContain('parentId (not a identities column)');
    // A value that IS a contract column is not flagged.
    expect(withRows('identities', [{ from: 'EMP_NR', to: 'employeeId' }])).not.toContain('not a identities column');
  });

  it('offers no mapping at all for a target with no column contract', () => {
    const html = render({ ...newQuerySlot(), target: 'groups' });
    expect(html).not.toContain('Column mapping');
    expect(html).not.toContain('+ Add mapping');
  });
});

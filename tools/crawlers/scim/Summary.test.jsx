import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import Summary, { resolveSystemName } from './Summary.jsx';

/**
 * The card's "System:" line has to show the name the *run* will register, not
 * whatever happens to sit in the stored config — otherwise the operator reads one
 * name on the Crawlers page and finds another on the Systems page (#1240).
 */
describe('SCIM Summary — system name', () => {
  it('shows an explicit system-name override', () => {
    expect(resolveSystemName({ systemName: 'Payroll' }, { displayName: 'SAP CIS Test' })).toBe('Payroll');
  });

  it('shows the crawler name when no override is configured', () => {
    expect(resolveSystemName({}, { displayName: 'SAP CIS Test' })).toBe('SAP CIS Test');
  });

  it('shows a stored override of exactly "SCIM" as the crawler name (pre-#1207 config)', () => {
    // The literal is what the old wizard baked in when the field was left blank.
    // The run ignores it, so the card must not advertise it either.
    expect(resolveSystemName({ systemName: 'SCIM' }, { displayName: 'SAP CIS Test' })).toBe('SAP CIS Test');
  });

  it('keeps an override that merely contains the type default', () => {
    expect(resolveSystemName({ systemName: 'SCIM Test' }, { displayName: 'SAP CIS Test' })).toBe('SCIM Test');
  });

  it('compares the stale default after trimming', () => {
    expect(resolveSystemName({ systemName: '  SCIM  ' }, { displayName: 'SAP CIS Test' })).toBe('SAP CIS Test');
  });

  it('falls back to the type literal when the crawler has no name either', () => {
    expect(resolveSystemName({ systemName: 'SCIM' }, { displayName: '   ' })).toBe('SCIM');
    expect(resolveSystemName({}, null)).toBe('SCIM');
  });

  it('renders the resolved name in the card', () => {
    const html = renderToStaticMarkup(
      h(Summary, { cfg: { systemName: 'SCIM', baseUrl: 'https://h/scim' }, config: { displayName: 'SAP CIS Test' } }),
    );
    expect(html).toContain('SAP CIS Test');
  });
});

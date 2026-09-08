// The form-renderer map is keyed on presentation form, never on report name —
// the UI half of the "adding a report costs only a template" seam.

import { describe, it, expect } from 'vitest';
import { FORM_RENDERERS, resolveFormRenderer } from './formRenderers';
import ListReportRenderer from './ListReportRenderer';

describe('resolveFormRenderer', () => {
  it('resolves every declared form to a component', () => {
    for (const form of Object.keys(FORM_RENDERERS)) {
      expect(typeof resolveFormRenderer(form)).toBe('function');
    }
    expect(resolveFormRenderer('list')).toBe(ListReportRenderer);
  });

  it('returns null for a form this UI version does not know', () => {
    expect(resolveFormRenderer('sankey')).toBeNull();
    expect(resolveFormRenderer(undefined)).toBeNull();
  });

  it('never resolves an inherited Object.prototype member', () => {
    // A `form` string comes from the API response, so the lookup must not be
    // able to hand back `constructor` / `toString` as a "renderer".
    expect(resolveFormRenderer('constructor')).toBeNull();
    expect(resolveFormRenderer('toString')).toBeNull();
  });
});

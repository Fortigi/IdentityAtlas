import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard, { MAX_FILE_BYTES, fmtBytes } from './ConfigWizard.jsx';
import { DialogContext } from '@ui/components/dialogContext';

// The wizard calls useDialog() for its in-app confirms, so supply a stub context
// (the real DialogProvider uses a portal that renderToStaticMarkup can't render).
const stubDialog = { confirm: async () => false, alert: () => {}, prompt: async () => null, toast: () => {} };

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. the back-reference to app/ui/src/components/Stepper, or the csv-slots.json
// import) throws here instead of only at runtime in the browser.
describe('CSV crawler ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(DialogContext.Provider, { value: stubDialog },
      h(ConfigWizard, {
        onComplete: () => {},
        onCancel: () => {},
        initialConfig: null,
        isEdit: false,
        authFetch: () => new Promise(() => {}),
        ...props,
      })));

  it('renders step 1 (system info) without throwing', () => {
    const html = render();
    expect(html).toContain('Add CSV Crawler');
    expect(html).toContain('Display name');
    expect(html).toContain('CSV delimiter');
  });

  it('shows "Edit CSV Crawler" in edit mode', () => {
    const html = render({ isEdit: true, initialConfig: { id: 1, systemName: 'Existing' } });
    expect(html).toContain('Edit CSV Crawler');
  });
});

describe('MAX_FILE_BYTES', () => {
  it('is 1 GB', () => {
    expect(MAX_FILE_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('renders as "1.0 GB" via fmtBytes', () => {
    expect(fmtBytes(MAX_FILE_BYTES)).toBe('1.0 GB');
  });
});

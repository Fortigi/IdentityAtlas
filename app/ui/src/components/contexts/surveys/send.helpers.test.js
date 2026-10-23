import { describe, it, expect } from 'vitest';
import { sendBody, sentSummary } from './send.helpers';

describe('sendBody', () => {
  it('to a person picked, or to the Accountable; optional fields only when given', () => {
    expect(sendBody({ templateId: 't', to: 'person', person: { id: 'p1' }, includeSubContexts: false, dueAt: '', message: '  ' }))
      .toEqual({ templateId: 't', recipient: { principalId: 'p1' }, includeSubContexts: false });
    expect(sendBody({ templateId: 't', to: 'accountable', person: { id: 'p1' }, includeSubContexts: true, dueAt: '2026-11-01', message: ' Graag ' }))
      .toEqual({ templateId: 't', toAccountable: true, includeSubContexts: true, dueAt: '2026-11-01', message: 'Graag' });
    expect(sendBody({ templateId: 't', to: 'person', person: null })).toMatchObject({ toAccountable: true });
  });
});

describe('sentSummary', () => {
  it('names the one recipient, counts several, and lists up to three skipped units', () => {
    expect(sentSummary({ sent: [{ recipientName: 'Anna' }] })).toBe('Sent to Anna.');
    expect(sentSummary({ sent: [{}, {}], skipped: [{ contextName: 'A' }] })).toBe('Sent 2 surveys. Skipped 1 without an Accountable: A.');
    expect(sentSummary({ sent: [], skipped: [{ contextName: 'A' }, { contextName: 'B' }, { contextName: 'C' }, { contextName: 'D' }] }))
      .toBe('Sent 0 surveys. Skipped 4 without an Accountable: A, B, C, ….');
  });
});

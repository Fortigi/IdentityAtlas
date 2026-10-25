import { describe, it, expect } from 'vitest';
import { sendBody, sentSummary, startBody, respondentOf, emailOf, requestStatus } from './send.helpers';

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

describe('Do survey helpers', () => {
  it('startBody names the account only when one was picked', () => {
    expect(startBody({ templateId: 't', person: { id: 'p1' } })).toEqual({ templateId: 't', principalId: 'p1' });
    expect(startBody({ templateId: 't', person: null })).toEqual({ templateId: 't' });
  });

  it('respondentOf: the account picked wins over the caller\'s own; neither is nobody', () => {
    const options = { respondent: { principalId: 'me', displayName: 'Me', email: 'me@example.test' } };
    expect(respondentOf({ id: 'p1' }, options)).toEqual({ id: 'p1' });
    expect(respondentOf(null, options)).toEqual({ id: 'me', displayName: 'Me', email: 'me@example.test' });
    expect(respondentOf(null, { respondent: null })).toBeNull();
    expect(respondentOf(null, undefined)).toBeNull();
  });

  it('emailOf reads either name of the e-mail', () => {
    expect(emailOf({ email: 'a@example.test', userPrincipalName: 'b@example.test' })).toBe('a@example.test');
    expect(emailOf({ userPrincipalName: 'b@example.test' })).toBe('b@example.test');
    expect(emailOf(null)).toBeNull();
  });

  it('requestStatus: a sent one waits; one done in place is in progress, then answered in place', () => {
    expect(requestStatus({ status: 'sent' })).toEqual({ key: 'sent', label: 'waiting' });
    expect(requestStatus({ status: 'submitted' })).toEqual({ key: 'submitted', label: 'answered' });
    expect(requestStatus({ status: 'cancelled' })).toEqual({ key: 'cancelled', label: 'withdrawn' });
    expect(requestStatus({ status: 'odd' })).toEqual({ key: 'odd', label: 'odd' });
    expect(requestStatus({ status: 'sent', inPlace: true })).toEqual({ key: 'sent', label: 'in progress' });
    expect(requestStatus({ status: 'submitted', inPlace: true })).toEqual({ key: 'submitted', label: 'answered in place' });
    expect(requestStatus({ status: 'cancelled', inPlace: true })).toEqual({ key: 'cancelled', label: 'withdrawn' });
  });
});

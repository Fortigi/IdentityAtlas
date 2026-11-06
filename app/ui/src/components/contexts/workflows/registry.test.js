import { describe, it, expect } from 'vitest';
import { actionCardsFor } from './registry';
import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';

const APP = { id: 'app', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const unit = targetType => ({ id: targetType, contextCategory: 'OrganizationalUnit', targetType });

describe('action registry', () => {
  const cardsOf = attrs => actionCardsFor(attrs).map(c => c.Card);
  const keysOf = (attrs, opts) => actionCardsFor(attrs, opts).map(c => c.key);

  it('gives an application the matrix and the entitlement report, in that order', () => {
    expect(cardsOf(APP)).toEqual([MatrixCard, DownloadReportCard]);
    // On its template, whatever it holds.
    expect(cardsOf({ ...APP, targetType: undefined })).toEqual([MatrixCard, DownloadReportCard]);
  });

  it('gives a unit of accounts or people the matrix and the unit report', () => {
    for (const t of ['Identity', 'Principal']) expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'download-unit-report']);
    const card = actionCardsFor(unit('Principal')).find(c => c.key === 'download-unit-report');
    expect(card.Card).toBe(DownloadReportCard);
    expect(card.props).toMatchObject({ report: 'unit-members', title: 'Download unit report', testId: 'action-download-unit-report' });
  });

  it('gives a unit of resources (or systems) the matrix only', () => {
    for (const t of ['Resource', 'System']) expect(keysOf(unit(t)), t).toEqual(['view-in-matrix']);
  });

  // A context owner's read-only page cannot open the matrix (an in-app page); the reports stay.
  it('drops the in-app matrix card from a read-only shared view, keeping the reports', () => {
    expect(keysOf(APP, { sharedView: true })).toEqual(['download-report']);
    expect(keysOf(unit('Identity'), { sharedView: true })).toEqual(['download-unit-report']);
    expect(keysOf(unit('Resource'), { sharedView: true })).toEqual([]);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});

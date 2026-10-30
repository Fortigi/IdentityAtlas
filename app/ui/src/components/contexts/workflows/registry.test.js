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

  it('keeps every card on a read-only shared view (none of them is analyst-only)', () => {
    expect(keysOf(APP, { sharedView: true })).toEqual(['view-in-matrix', 'download-report']);
    expect(keysOf(unit('Identity'), { sharedView: true })).toEqual(['view-in-matrix', 'download-unit-report']);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});

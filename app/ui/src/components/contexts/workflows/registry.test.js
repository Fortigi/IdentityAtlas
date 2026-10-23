import { describe, it, expect } from 'vitest';
import { actionCardsFor } from './registry';
import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import UploadInterviewCard from '@ui/components/contexts/interviews/UploadInterviewCard';

const APP = { id: 'app', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const unit = targetType => ({ id: targetType, contextCategory: 'OrganizationalUnit', targetType });

describe('action registry', () => {
  const cardsOf = attrs => actionCardsFor(attrs).map(c => c.Card);
  const keysOf = (attrs, opts) => actionCardsFor(attrs, opts).map(c => c.key);

  it('gives an application the matrix, the entitlement report and the interview upload, in that order', () => {
    expect(cardsOf(APP)).toEqual([MatrixCard, DownloadReportCard, UploadInterviewCard]);
    // On its template, whatever it holds.
    expect(cardsOf({ ...APP, targetType: undefined })).toEqual([MatrixCard, DownloadReportCard, UploadInterviewCard]);
  });

  it('gives a unit of accounts or people the matrix, the unit report and the interview upload', () => {
    for (const t of ['Identity', 'Principal']) {
      expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'download-unit-report', 'upload-interview']);
    }
    const card = actionCardsFor(unit('Principal')).find(c => c.key === 'download-unit-report');
    expect(card.Card).toBe(DownloadReportCard);
    expect(card.props).toMatchObject({ report: 'unit-members', title: 'Download unit report', testId: 'action-download-unit-report' });
  });

  it('gives a unit of resources (or systems) no report card', () => {
    for (const t of ['Resource', 'System']) expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'upload-interview']);
  });

  it('offers no announced-but-unbuilt cards', () => {
    for (const attrs of [APP, unit('Identity'), unit('Principal'), unit('Resource')]) {
      expect(keysOf(attrs).filter(k => /survey|review-members/.test(k))).toEqual([]);
    }
  });

  // A context owner's read-only page: no matrix (an in-app page they cannot open)
  // and no interview upload (an analyst's move); the reports stay.
  it('keeps only the reports on a read-only shared view', () => {
    expect(keysOf(APP, { sharedView: true })).toEqual(['download-report']);
    expect(keysOf(unit('Identity'), { sharedView: true })).toEqual(['download-unit-report']);
    expect(keysOf(unit('Resource'), { sharedView: true })).toEqual([]);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});

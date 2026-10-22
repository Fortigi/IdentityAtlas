import { describe, it, expect } from 'vitest';
import { actionCardsFor } from './registry';
import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import ComingSoonCard from './ComingSoonCard';

const APP = { id: 'app', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const unit = targetType => ({ id: targetType, contextCategory: 'OrganizationalUnit', targetType });

describe('action registry', () => {
  const cardsOf = attrs => actionCardsFor(attrs).map(c => c.Card);

  it('gives an application the matrix, the entitlement report and the ownership survey, in that order', () => {
    expect(cardsOf(APP)).toEqual([MatrixCard, DownloadReportCard, ComingSoonCard]);
    // On its template, whatever it holds.
    expect(cardsOf({ ...APP, targetType: undefined })).toEqual([MatrixCard, DownloadReportCard, ComingSoonCard]);
  });

  const keysOf = (attrs, opts) => actionCardsFor(attrs, opts).map(c => c.key);

  it('gives a unit of accounts or people the matrix, the unit report and the survey', () => {
    for (const t of ['Identity', 'Principal']) {
      expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'download-unit-report', 'ownership-survey']);
    }
    const card = actionCardsFor(unit('Principal')).find(c => c.key === 'download-unit-report');
    expect(card.Card).toBe(DownloadReportCard);
    expect(card.props).toMatchObject({ report: 'unit-members', title: 'Download unit report', testId: 'action-download-unit-report' });
  });

  it('gives a unit of resources (or systems) no report card', () => {
    for (const t of ['Resource', 'System']) expect(keysOf(unit(t)), t).toEqual(['view-in-matrix', 'ownership-survey']);
  });

  it('labels the survey card as the ownership survey', () => {
    const survey = actionCardsFor(APP).find(c => c.Card === ComingSoonCard);
    expect(survey.props).toMatchObject({ title: 'Start ownership survey', testId: 'action-ownership-survey' });
    expect(survey.props.text).toMatch(/^Ask the accountable owner to confirm they own this/);
  });

  it('leaves the survey out of a read-only shared view, and only the survey', () => {
    const shared = attrs => actionCardsFor(attrs, { sharedView: true }).map(c => c.Card);
    expect(shared(APP)).toEqual([MatrixCard, DownloadReportCard]);
    // A context owner's own unit keeps its report.
    expect(keysOf(unit('Identity'), { sharedView: true })).toEqual(['view-in-matrix', 'download-unit-report']);
  });

  it('gives other templates no actions', () => {
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(actionCardsFor({ ...APP, contextCategory })).toEqual([]);
  });
});

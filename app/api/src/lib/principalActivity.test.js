// The SQL fragments every activity surface shares.
//
// These assert the SEMANTICS the fragments encode, not their formatting: that
// the sentinel and the aggregate types are actually constrained, that the
// lateral is a LEFT JOIN (a principal with no activity must still appear in the
// list), and that "last sign-in" is the widest of the three columns rather than
// the interactive one alone. A test that only matched a string would pass on a
// fragment that silently dropped one of those.

import { describe, it, expect } from 'vitest';
import {
  AGG_RESOURCE_ID, AGGREGATE_ACTIVITY_TYPES, PER_APP_ACTIVITY_TYPE,
  aggregateActivityLateral, aggregateRowWhere, lastSignInExpr,
} from './principalActivity.js';

describe('activity constants', () => {
  it('pins the aggregate sentinel to the all-zeroes UUID from migration 017', () => {
    // The ingest engine, the crawler and the schema default all use this exact
    // value; a drift here silently splits aggregate rows from their readers.
    expect(AGG_RESOURCE_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('covers both the user and the service-principal aggregate types', () => {
    expect(AGGREGATE_ACTIVITY_TYPES).toEqual(['SignIn', 'ServicePrincipalSignIn']);
    expect(PER_APP_ACTIVITY_TYPE).toBe('SignInPerApp');
  });
});

describe('lastSignInExpr', () => {
  it('takes the widest of the three timestamps, not the interactive one alone', () => {
    const sql = lastSignInExpr('x');
    expect(sql.startsWith('GREATEST(')).toBe(true);
    for (const col of ['lastSignInDateTime', 'lastNonInteractiveSignInDateTime', 'lastSuccessfulSignInDateTime']) {
      expect(sql).toContain(`x."${col}"`);
    }
    // A failed sign-in is not a sign-in — including it would make a locked-out
    // account look active.
    expect(sql).not.toContain('lastFailedSignInDateTime');
  });

  it('defaults to the `pa` alias the reading queries use', () => {
    expect(lastSignInExpr()).toContain('pa."lastSignInDateTime"');
  });
});

describe('aggregateActivityLateral', () => {
  const sql = aggregateActivityLateral('u', 'act');

  it('LEFT JOINs on TRUE, so a principal with no activity still yields a row', () => {
    // An INNER JOIN here would silently drop every never-measured account from
    // the users list — the exact opposite of "No activity recorded".
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
    expect(sql).toMatch(/\)\s+act ON TRUE/);
  });

  it('correlates on the caller-supplied principal alias', () => {
    expect(sql).toContain('pa."principalId" = u.id');
  });

  it('restricts to aggregate rows of the aggregate activity types', () => {
    expect(sql).toContain(`'${AGG_RESOURCE_ID}'::uuid`);
    expect(sql).toContain("'SignIn', 'ServicePrincipalSignIn'");
  });

  it('aggregates rather than picking one row — a principal may have two', () => {
    // SignIn and ServicePrincipalSignIn are separate primary keys; LIMIT 1
    // would return whichever the planner reached first.
    expect(sql).toContain('MAX(');
    expect(sql).not.toContain('LIMIT 1');
  });

  it('exposes both the timestamp and the moment it was measured', () => {
    expect(sql).toContain('AS "lastSignIn"');
    expect(sql).toContain('AS "measuredAt"');
  });

  it('defaults its output alias so the common call site needs one argument', () => {
    expect(aggregateActivityLateral('p')).toMatch(/\)\s+act ON TRUE/);
  });
});

describe('aggregateRowWhere', () => {
  it('constrains both the sentinel and the type', () => {
    const sql = aggregateRowWhere('pa');
    expect(sql).toContain(`pa."resourceId" = '${AGG_RESOURCE_ID}'::uuid`);
    expect(sql).toContain(`pa."activityType" IN ('SignIn', 'ServicePrincipalSignIn')`);
  });
});

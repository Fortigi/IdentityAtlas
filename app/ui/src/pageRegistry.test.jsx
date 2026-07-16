// Unit tests for the static page-route registry.
//
// These execute every map entry and render function (so each route is real,
// instrumented, covered coverage — the whole point of moving the render-switch
// out of the JSX ternary in App.jsx, #669). We inspect the returned elements
// rather than mounting the lazy components: props/key wiring is what each entry
// is responsible for, and it's checkable synchronously without a DOM.

import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { PAGE_ROUTES, resolvePageRoute } from './pageRegistry';

const ctx = {
  navigate: () => {},
  openDetailTab: () => {},
  forceRefresh: () => {},
  onRiskScoresRefresh: () => {},
  riskScoresRefreshKey: 7,
};

describe('pageRegistry', () => {
  it('resolves every registered key to a render function', () => {
    for (const key of Object.keys(PAGE_ROUTES)) {
      expect(typeof resolvePageRoute(key)).toBe('function');
    }
  });

  it('returns null for a non-static route (detail tab / matrix / unknown)', () => {
    expect(resolvePageRoute('user:abc')).toBeNull();
    expect(resolvePageRoute('matrix')).toBeNull();
    expect(resolvePageRoute('does-not-exist')).toBeNull();
    // Guard against inherited Object.prototype keys masquerading as routes.
    expect(resolvePageRoute('toString')).toBeNull();
  });

  it('every route renders a valid element from the shared context', () => {
    for (const key of Object.keys(PAGE_ROUTES)) {
      expect(isValidElement(resolvePageRoute(key)(ctx))).toBe(true);
    }
  });

  it('threads the context callbacks into each page as props', () => {
    expect(resolvePageRoute('dashboard')(ctx).props.onNavigate).toBe(ctx.navigate);
    expect(resolvePageRoute('sync-log')(ctx).props.navigate).toBe(ctx.navigate);
    expect(resolvePageRoute('sync-log')(ctx).props.onOpenDetail).toBe(ctx.openDetailTab);
    expect(resolvePageRoute('principals')(ctx).props.onOpenDetail).toBe(ctx.openDetailTab);
    expect(resolvePageRoute('access-packages')(ctx).props.onOpenDetail).toBe(ctx.openDetailTab);
    expect(resolvePageRoute('identities')(ctx).props.onOpenDetail).toBe(ctx.openDetailTab);
    expect(resolvePageRoute('contexts')(ctx).props.onNavigate).toBe(ctx.navigate);
    expect(resolvePageRoute('contexts')(ctx).props.onOpenDetail).toBe(ctx.openDetailTab);
  });

  it('renders the systems page without needing any context', () => {
    // The systems entry takes no ctx — calling it with undefined must not throw.
    expect(isValidElement(resolvePageRoute('systems')())).toBe(true);
  });

  it('aliases resources and groups to the same page', () => {
    expect(resolvePageRoute('resources')).toBe(resolvePageRoute('groups'));
  });

  it('routes the legacy #crawlers and #performance hashes to Admin', () => {
    expect(resolvePageRoute('crawlers')).toBe(resolvePageRoute('admin'));
    expect(resolvePageRoute('performance')).toBe(resolvePageRoute('admin'));
    const admin = resolvePageRoute('admin')(ctx);
    expect(admin.props.onNavigate).toBe(ctx.navigate);
    expect(admin.props.onRefresh).toBe(ctx.forceRefresh);
    expect(admin.props.onRiskScoresRefresh).toBe(ctx.onRiskScoresRefresh);
  });

  it('remounts the risk-scores page when the refresh key changes', () => {
    expect(resolvePageRoute('risk-scores')(ctx).key).toBe(String(ctx.riskScoresRefreshKey));
    expect(resolvePageRoute('risk-scores')(ctx).props.onOpenDetail).toBe(ctx.openDetailTab);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { keyActivate, clickableRowProps, FOCUS_RING } from './keyActivate';

// Fake KeyboardEvent — only what the handler reads/calls.
const evt = (key) => ({ key, preventDefault: vi.fn() });

describe('keyActivate', () => {
  it('activates on Enter and on Space — the two keys a native button responds to', () => {
    const handler = vi.fn();
    const onKeyDown = keyActivate(handler);

    onKeyDown(evt('Enter'));
    onKeyDown(evt(' '));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('suppresses the browser default for both keys (Space scrolls, Enter submits)', () => {
    const onKeyDown = keyActivate(vi.fn());

    for (const key of ['Enter', ' ']) {
      const e = evt(key);
      onKeyDown(e);
      expect(e.preventDefault, `${key} must preventDefault`).toHaveBeenCalled();
    }
  });

  it('ignores every other key, including the near-misses', () => {
    const handler = vi.fn();
    const onKeyDown = keyActivate(handler);

    // 'Spacebar' is the legacy IE name and 'Space' is the *code*, not the key —
    // matching either would fire on keys the user never pressed. 'Escape' and
    // 'Tab' must stay with the browser, and a plain letter must type.
    for (const key of ['Spacebar', 'Space', 'Escape', 'Tab', 'ArrowDown', 'e', 'Return']) {
      const e = evt(key);
      onKeyDown(e);
      expect(handler, `${key} must not activate`).not.toHaveBeenCalled();
      expect(e.preventDefault, `${key} must keep its default`).not.toHaveBeenCalled();
    }
  });

  it('passes the event to the handler, so onClick/onKeyDown can share one function', () => {
    const handler = vi.fn();
    const e = evt('Enter');
    keyActivate(handler)(e);
    expect(handler).toHaveBeenCalledWith(e);
  });

  it('returns undefined when there is no handler, leaving the element non-interactive', () => {
    expect(keyActivate(undefined)).toBeUndefined();
    expect(keyActivate(null)).toBeUndefined();
    // A non-callable truthy value must not be wrapped either — it would throw
    // on the first keypress instead of at render.
    expect(keyActivate('open')).toBeUndefined();
  });
});

describe('clickableRowProps', () => {
  it('returns the full button contract for a clickable element', () => {
    const onActivate = vi.fn();
    const props = clickableRowProps(onActivate);

    expect(props.role).toBe('button');
    expect(props.tabIndex).toBe(0);
    expect(props.onClick).toBe(onActivate);

    props.onKeyDown(evt('Enter'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('returns nothing at all when there is no handler — no stray role or tab stop', () => {
    // A row that isn't clickable must not become a focusable "button" that does
    // nothing; this is what keeps 50 inert rows out of the tab order.
    expect(clickableRowProps(undefined)).toEqual({});
    expect(clickableRowProps(undefined, { label: 'Open', expanded: true })).toEqual({});
  });

  it('omits aria-label and aria-expanded unless they were asked for', () => {
    const props = clickableRowProps(vi.fn());
    expect(props).not.toHaveProperty('aria-label');
    expect(props).not.toHaveProperty('aria-expanded');
  });

  it('emits aria-expanded={false} for a collapsed row, not just for an expanded one', () => {
    // `false` is the state a collapsed disclosure must advertise — dropping it
    // (a truthiness check) would silently make collapsed rows announce nothing.
    expect(clickableRowProps(vi.fn(), { expanded: false })['aria-expanded']).toBe(false);
    expect(clickableRowProps(vi.fn(), { expanded: true })['aria-expanded']).toBe(true);
  });

  it('emits the accessible name when the element has no descriptive text', () => {
    expect(clickableRowProps(vi.fn(), { label: 'Open Finance' })['aria-label']).toBe('Open Finance');
  });
});

describe('FOCUS_RING', () => {
  it('only paints the ring for keyboard focus, so mouse clicks stay unringed', () => {
    expect(FOCUS_RING).toContain('focus-visible:ring-2');
    expect(FOCUS_RING).not.toMatch(/(^|\s)focus:ring/);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import MatrixLegend from './MatrixLegend';

// The sibling MatrixLegend.test.js only renders the legend to static markup, so
// it can assert WHAT the key says but never runs the collapse handler. These
// mount tests cover the other half: the disclosure toggle and the localStorage
// round-trip that remembers the choice across visits.

const STORAGE_KEY = 'matrixLegendCollapsed';

// The body text that is present only while the legend is expanded.
const BODY = /Cell badges — how the access is held/;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('MatrixLegend disclosure', () => {
  it('starts expanded and collapses the body when the header is clicked', async () => {
    renderWithProviders(h(MatrixLegend));

    const button = screen.getByRole('button', { name: /how to read this matrix/i });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(BODY)).toBeInTheDocument();

    await userEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(BODY)).not.toBeInTheDocument();
  });

  it('expands again on a second click', async () => {
    renderWithProviders(h(MatrixLegend));
    const button = screen.getByRole('button', { name: /how to read this matrix/i });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  // Persisting `prev` instead of `next` would still flip the UI correctly and
  // only show up on the next visit, so assert the STORED value per click —
  // not merely that setItem was called.
  it('persists the new state on each toggle, not the previous one', async () => {
    renderWithProviders(h(MatrixLegend));
    const button = screen.getByRole('button', { name: /how to read this matrix/i });

    await userEvent.click(button);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');

    await userEvent.click(button);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0');
  });

  it('starts collapsed when a previous visit stored the collapsed flag', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    renderWithProviders(h(MatrixLegend));

    expect(screen.getByRole('button', { name: /how to read this matrix/i }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(BODY)).not.toBeInTheDocument();
  });

  // Only the exact '1' means collapsed — a stale '0' (or anything else) must
  // open, otherwise every truthy stored value would hide the legend.
  it('starts expanded for a stored value that is not the collapsed flag', () => {
    localStorage.setItem(STORAGE_KEY, '0');
    renderWithProviders(h(MatrixLegend));

    expect(screen.getByRole('button', { name: /how to read this matrix/i }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });
});

// Safari in private mode and hardened browser profiles throw on localStorage
// access rather than returning null. The legend is decoration on the matrix —
// it must degrade to "open, just don't remember" instead of taking the page
// down with it.
describe('MatrixLegend when localStorage is unavailable', () => {
  it('renders expanded when reading the stored flag throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    renderWithProviders(h(MatrixLegend));

    expect(screen.getByRole('button', { name: /how to read this matrix/i }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('still toggles when writing the stored flag throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    renderWithProviders(h(MatrixLegend));
    const button = screen.getByRole('button', { name: /how to read this matrix/i });

    await userEvent.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(BODY)).not.toBeInTheDocument();
  });
});

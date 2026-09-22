// @vitest-environment jsdom
//
// What an empty matrix says — and, when a context it filters on has been
// deleted, why it is empty.

import { describe, it, expect } from 'vitest';
import { renderWithProviders as render, screen } from '@ui/test-utils/renderWithProviders';
import MatrixEmptyState from './MatrixEmptyState';
import BrokenMatrixBadge from './BrokenMatrixBadge';

const MESSAGE = 'No assignments match the current filter. Adjust the subjects or resources to widen the view.';

describe('MatrixEmptyState', () => {
  it('shows only the caller’s message when nothing is missing', () => {
    render(<MatrixEmptyState message={MESSAGE} missingContextIds={[]} />);
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/no longer exist/)).not.toBeInTheDocument();
  });

  it('explains a deleted context alongside the message, rather than replacing it', () => {
    render(<MatrixEmptyState message={MESSAGE} missingContextIds={['c1']} />);
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/refers to 1 context that no longer exists/)).toBeInTheDocument();
  });

  it('says nothing extra when the view never reported health', () => {
    render(<MatrixEmptyState message={MESSAGE} />);
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/no longer exist/)).not.toBeInTheDocument();
  });
});

describe('BrokenMatrixBadge', () => {
  it('marks a matrix whose context is gone, and says why in its accessible name', () => {
    render(<BrokenMatrixBadge row={{ missingContextIds: ['c1', 'c2'] }} />);
    const badge = screen.getByLabelText(/Refers to 2 contexts that no longer exist/);
    expect(badge).toHaveTextContent('broken');
  });

  it('renders nothing at all for a healthy matrix', () => {
    const { container } = render(<BrokenMatrixBadge row={{ missingContextIds: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a row that reports no health at all', () => {
    const { container } = render(<BrokenMatrixBadge row={{ id: 'sf-1' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

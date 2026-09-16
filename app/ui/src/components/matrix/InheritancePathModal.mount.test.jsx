// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InheritancePathModal from './InheritancePathModal';

afterEach(cleanup);

describe('InheritancePathModal', () => {
  it('renders nothing without a payload', () => {
    const { container } = render(<InheritancePathModal pathExplain={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the loading state while the path computes', () => {
    render(<InheritancePathModal pathExplain={{ loading: true, memberName: 'Alice', resourceName: 'HR' }} onClose={() => {}} />);
    expect(screen.getByText(/Computing path/i)).toBeInTheDocument();
  });

  it('renders the granting sources and the inheritance chain', () => {
    render(<InheritancePathModal
      pathExplain={{
        memberName: 'Alice', resourceName: 'HR',
        sources: [{ role: 'Owner', label: 'Scope', name: 'Root' }],
        chain: [{ id: 'c1', label: 'Group', name: 'Root', isSource: true }, { id: 'c2', label: 'Group', name: 'Leaf' }],
      }}
      onClose={() => {}}
    />);
    expect(screen.getByText(/Granted:/i)).toBeInTheDocument();
    expect(screen.getByText('Leaf')).toBeInTheDocument();
    expect(screen.getByText(/granted here/i)).toBeInTheDocument();
  });

  it('shows the no-path message when there is neither a source nor an error', () => {
    render(<InheritancePathModal pathExplain={{ memberName: 'Alice', resourceName: 'HR', sources: [], chain: [] }} onClose={() => {}} />);
    expect(screen.getByText(/No scope-inheritance path found/i)).toBeInTheDocument();
  });

  it('renders an error and invokes onClose from the Close button', async () => {
    const onClose = vi.fn();
    render(<InheritancePathModal pathExplain={{ error: 'boom', memberName: 'Alice', resourceName: 'HR' }} onClose={onClose} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

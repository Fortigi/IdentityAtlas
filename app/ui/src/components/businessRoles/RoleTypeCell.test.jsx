// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderWithProviders as render, screen } from '@ui/test-utils/renderWithProviders';
import RoleTypeCell from './RoleTypeCell';
import HeldTick from '../HeldTick';

describe('RoleTypeCell', () => {
  it('shows the role type as one chip, with the ways in and out as its tooltip', () => {
    render(<RoleTypeCell accessModel={{ waysIn: ['Rule'], waysOut: ['Rule'], control: 'Automatic', reviewGap: false }} />);
    const cell = screen.getByTestId('role-type');
    expect(cell).toHaveTextContent('Rule based');
    expect(cell).toHaveAttribute('title', 'Gained by Rule; lost by Removal rule');
    expect(screen.queryByText('no review set up')).toBeNull();
  });

  it('says so when people decide who holds it but no review is set up', () => {
    render(<RoleTypeCell accessModel={{ waysIn: ['Request'], waysOut: [], control: 'Manual', reviewGap: true }} />);
    expect(screen.getByTestId('role-type')).toHaveTextContent('Manual');
    expect(screen.getByText('no review set up')).toBeInTheDocument();
  });

  it('is Unknown when the role carries no access model', () => {
    render(<RoleTypeCell />);
    expect(screen.getByTestId('role-type')).toHaveTextContent('Unknown');
    expect(screen.queryByText('no review set up')).toBeNull();
  });
});

describe('HeldTick', () => {
  it('is a labelled blue tick with no text of its own', () => {
    render(<HeldTick label="Ann holds Finance" />);
    const tick = screen.getByRole('img', { name: 'Ann holds Finance' });
    expect(tick).toHaveAttribute('title', 'Ann holds Finance');
    expect(tick).toHaveClass('bg-blue-100', 'rounded-full');
    expect(tick.textContent).toBe('');
    expect(tick.querySelector('svg path')).toHaveAttribute('d', 'M4 10.500l4 4 8-9');
  });
});

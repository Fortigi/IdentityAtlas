// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import RoleSnapshot from './RoleSnapshot';
import { renderWithProviders as render, screen, within } from '@ui/test-utils/renderWithProviders';

const SNAPSHOT = {
  version: 1,
  role: { displayName: 'Finance', holderCount: 12 },
  type: { control: 'Automatic', waysIn: ['Rule'], waysOut: ['Rule'], reviewGap: false },
  policies: [
    { id: 'p1', displayName: 'Everyone in Finance', waysIn: ['Rule'], waysOut: ['Rule'], targetRule: '(user.department -eq "Finance")' },
    { id: 'p2', displayName: '', waysIn: ['Request'], waysOut: ['Review'], targetRule: null },
  ],
  owners: [
    { role: 'Accountable', displayName: 'Mara Lindqvist', derivedFrom: null },
    { role: 'Responsible', displayName: 'Carla Cash', derivedFrom: ['Approver', 'Reviewer'] },
    { role: 'Responsible', displayName: null },
  ],
  resources: [
    { id: 'g1', displayName: 'SG-Finance', resourceType: 'Group', systemName: 'Entra ID' },
    { id: 'g2', displayName: 'Ledger: Viewer', resourceType: null, systemName: null },
  ],
};

describe('RoleSnapshot', () => {
  it('shows the type, holders and who answered for the role then', () => {
    render(<RoleSnapshot snapshot={SNAPSHOT} />);
    const s = screen.getByTestId('role-snapshot');
    expect(s).toHaveTextContent('Rule based');
    expect(s).toHaveTextContent('Gained by Rule; lost by Removal rule');
    expect(s).toHaveTextContent('12 people');
    expect(s).toHaveTextContent('Accountable: Mara Lindqvist');
    expect(s).toHaveTextContent('Responsible: Carla Cash (approver and reviewer)');
    expect(s).toHaveTextContent('Responsible: unnamed');
  });

  it('shows each policy with its rule, and a policy without a name by its id', () => {
    render(<RoleSnapshot snapshot={SNAPSHOT} />);
    expect(screen.getByText('Policies (2)')).toBeInTheDocument();
    expect(screen.getByText('(user.department -eq "Finance")').tagName).toBe('CODE');
    expect(screen.getByText('p2')).toBeInTheDocument();
  });

  it('lists the resources it contained with their type and system', () => {
    render(<RoleSnapshot snapshot={SNAPSHOT} />);
    expect(screen.getByText('Resources (2)')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getAllByRole('cell').map(c => c.textContent)).toEqual(['SG-Finance', 'Group', 'Entra ID']);
    expect(within(rows[1]).getAllByRole('cell').map(c => c.textContent)).toEqual(['Ledger: Viewer', '—', '—']);
  });

  it('says one person in the singular, and None for empty parts', () => {
    render(<RoleSnapshot snapshot={{ ...SNAPSHOT, role: { holderCount: 1 }, policies: [], owners: [], resources: [] }} />);
    const s = screen.getByTestId('role-snapshot');
    expect(s).toHaveTextContent('1 person');
    expect(within(s).getAllByText('None')).toHaveLength(2);
    expect(within(s).getByText('Nobody')).toBeInTheDocument();
  });

  it('counts nobody when the role part is missing', () => {
    render(<RoleSnapshot snapshot={{ type: SNAPSHOT.type }} />);
    expect(screen.getByTestId('role-snapshot')).toHaveTextContent('0 people');
  });

  it('says so when no snapshot was kept', () => {
    render(<RoleSnapshot snapshot={{ version: 1 }} />);
    expect(screen.getByText('No snapshot was kept for this review.')).toBeInTheDocument();
    render(<RoleSnapshot />);
    expect(screen.getAllByText('No snapshot was kept for this review.')).toHaveLength(2);
  });
});

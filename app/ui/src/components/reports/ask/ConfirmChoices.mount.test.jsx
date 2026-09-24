// @vitest-environment jsdom
//
// "Did you mean …?" — what this pins down:
//   • every suggestion is offered as its own button, labelled with what it is
//   • a reference answer carries the chosen record's id; a "name is X" answer
//     does not (the value is the name, there is nothing to pin)
//   • a typed name is trimmed and sent instead of a suggestion
//   • "keep as written" is offered for a name condition only, never for a
//     comparison reference (which cannot run without a record)
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import ConfirmChoices from './ConfirmChoices';

const reference = {
  kind: 'reference',
  path: [0],
  name: 'Algemene partners',
  label: 'business role',
  message: 'No business role is named exactly "Algemene partners". Did you mean:',
  choices: [
    { id: 'br1', name: 'ACME - Algemeen - Partners', type: 'BusinessRole', score: 0.61 },
    { id: 'g1', name: 'ACME.Partners', type: 'Group', score: 0.4 },
  ],
};
const value = { ...reference, kind: 'value', choices: [reference.choices[0]] };

function render(confirm, busy = false) {
  const onChoose = vi.fn();
  renderWithProviders(<ConfirmChoices confirm={confirm} onChoose={onChoose} busy={busy} />);
  return onChoose;
}

describe('ConfirmChoices', () => {
  it('offers each suggestion with its type and answers with the chosen record', async () => {
    const onChoose = render(reference);
    expect(screen.getByText(reference.message)).toBeInTheDocument();
    expect(screen.getByText('business role')).toBeInTheDocument(); // the type of the first suggestion

    await userEvent.click(screen.getByRole('button', { name: /ACME.Partners/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: 'ACME.Partners', id: 'g1' });
  });

  it('sends a typed name, trimmed, and no id', async () => {
    const onChoose = render(reference);
    await userEvent.type(screen.getByRole('textbox', { name: /exact name/i }), '  Fortigi Members  ');
    await userEvent.click(screen.getByRole('button', { name: 'Use this name' }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: '  Fortigi Members  ' });
  });

  it('pins no id for a "name is X" condition — the value is the name itself', async () => {
    const onChoose = render(value);
    await userEvent.click(screen.getByRole('button', { name: /ACME - Algemeen - Partners/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: 'ACME - Algemeen - Partners', id: undefined });
  });

  it('offers "keep as written" for a name condition', async () => {
    const onChoose = render(value);
    await userEvent.click(screen.getByRole('button', { name: /Keep/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: 'Algemene partners', keep: true });
  });

  it('never offers it for a comparison reference, which cannot run without a record', () => {
    render(reference);
    expect(screen.queryByRole('button', { name: /Keep/ })).not.toBeInTheDocument();
  });

  it('asks for the exact name when nothing was close, and disables everything while busy', async () => {
    const nothing = { ...reference, choices: [], message: 'I could not find any business role named "Nope". What is its exact name?' };
    render(nothing, true);
    expect(screen.getByText(nothing.message)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /exact name/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use this name' })).toBeDisabled();
  });
});

// A name from the question the report does not use: which field, or leave it out.
describe('ConfirmChoices — a name the report does not use', () => {
  const term = {
    kind: 'term', path: [], name: 'ACME', label: 'user', drop: [[1]],
    message: '“ACME” is not a system — it appears in Email and Company. Which should the report match?',
    choices: [
      { name: 'Email contains “ACME”', fields: ['email'] },
      { name: 'Company contains “ACME”', fields: ['companyName'] },
    ],
  };

  it('answers with the chosen fields, the name and the system condition it replaces', async () => {
    const onChoose = render(term);
    expect(screen.getByText(term.message)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Company contains “ACME”' }));
    expect(onChoose).toHaveBeenCalledWith({
      kind: 'term', path: [], term: 'ACME', drop: [[1]], name: 'Company contains “ACME”', fields: ['companyName'],
    });
  });

  it('can leave the name out, and offers no typed name', async () => {
    const onChoose = render(term);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Leave “ACME” out' }));
    expect(onChoose).toHaveBeenCalledWith({ kind: 'term', path: [], term: 'ACME', drop: [[1]], name: 'Leave “ACME” out', skip: true });
  });

  it('disables every choice while busy', () => {
    render(term, true);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});

describe('ConfirmChoices — a person written as "contains"', () => {
  const person = {
    kind: 'person',
    path: [1, 0],
    name: 'bram',
    label: 'account',
    total: 2,
    message: '2 accounts have "bram" in their name. Which one is meant?',
    choices: [
      { id: 'u1', name: 'Bram de Groot', type: 'User' },
      { id: 'u2', name: 'Bram Smit', type: 'User' },
      { name: 'every account with “bram” in the name', keep: true },
    ],
  };

  it('pins the chosen person by id, like a reference', async () => {
    const onChoose = render(person);
    await userEvent.click(screen.getByRole('button', { name: /Bram Smit/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [1, 0], name: 'Bram Smit', id: 'u2' });
  });

  it('offers everyone with the name as the keep-as-written choice, not as one more person', async () => {
    const onChoose = render(person);
    // Two person buttons, not three.
    expect(screen.getAllByRole('button').filter(b => /Bram/.test(b.textContent))).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /every account with/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [1, 0], name: 'bram', keep: true });
    expect(screen.queryByText(/as written/)).not.toBeInTheDocument();
  });
});

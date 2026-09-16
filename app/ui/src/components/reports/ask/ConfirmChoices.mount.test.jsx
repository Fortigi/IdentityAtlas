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
  name: 'Algemene maten',
  label: 'business role',
  message: 'No business role is named exactly "Algemene maten". Did you mean:',
  choices: [
    { id: 'br1', name: 'Fortigi - Algemeen - Maten', type: 'BusinessRole', score: 0.61 },
    { id: 'g1', name: 'Fortigi.Maten', type: 'Group', score: 0.4 },
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

    await userEvent.click(screen.getByRole('button', { name: /Fortigi\.Maten/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: 'Fortigi.Maten', id: 'g1' });
  });

  it('sends a typed name, trimmed, and no id', async () => {
    const onChoose = render(reference);
    await userEvent.type(screen.getByRole('textbox', { name: /exact name/i }), '  Fortigi Members  ');
    await userEvent.click(screen.getByRole('button', { name: 'Use this name' }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: '  Fortigi Members  ' });
  });

  it('pins no id for a "name is X" condition — the value is the name itself', async () => {
    const onChoose = render(value);
    await userEvent.click(screen.getByRole('button', { name: /Fortigi - Algemeen - Maten/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: 'Fortigi - Algemeen - Maten', id: undefined });
  });

  it('offers "keep as written" for a name condition', async () => {
    const onChoose = render(value);
    await userEvent.click(screen.getByRole('button', { name: /Keep/ }));
    expect(onChoose).toHaveBeenCalledWith({ path: [0], name: 'Algemene maten', keep: true });
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

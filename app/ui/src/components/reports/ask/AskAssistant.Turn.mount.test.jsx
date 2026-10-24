// @vitest-environment jsdom
//
// One conversation turn — what this pins down (the paths the assistant's own
// mount test does not reach):
//   • answer buttons are offered only on the latest clarifying question
//   • an older "did you mean …?" is shown as its message, not as live choices
//   • a repaired report says the first attempt was corrected; an unrepaired one
//     with no assumptions shows no list
//   • an error turn shows its message with the detail lines
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import Turn from './AskAssistant.Turn';

const CLARIFY = { kind: 'clarify', question: 'Which tenant do you mean?', options: ['Tenant North'], timing: null };
const CONFIRM = {
  kind: 'confirm',
  spec: {},
  confirm: { kind: 'value', path: [1], name: 'Sales', label: 'department', message: 'No department is named "Sales". Did you mean:', choices: [{ id: 'd9', name: 'Sales EMEA', type: 'Department', score: 0.7 }] },
  timing: null,
};

function render(reply, { isLast = true, busy = false } = {}) {
  const onAnswer = vi.fn();
  const onConfirm = vi.fn();
  renderWithProviders(<Turn turn={{ role: 'assistant', reply }} isLast={isLast} busy={busy} onAnswer={onAnswer} onConfirm={onConfirm} />);
  return { onAnswer, onConfirm };
}

describe('AskAssistant Turn', () => {
  it('offers the options on the latest clarifying question and answers with the one clicked', async () => {
    const { onAnswer } = render(CLARIFY);
    await userEvent.click(screen.getByRole('button', { name: 'Tenant North' }));
    expect(onAnswer).toHaveBeenCalledWith('Tenant North');
  });

  it('shows an older clarifying question without any buttons', () => {
    render(CLARIFY, { isLast: false });
    expect(screen.getByText(CLARIFY.question)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows an older "did you mean" as its message only', () => {
    render(CONFIRM, { isLast: false });
    expect(screen.getByText(CONFIRM.confirm.message)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hands the reply and the picked record to onConfirm on the latest "did you mean"', async () => {
    const { onConfirm } = render(CONFIRM);
    await userEvent.click(screen.getByRole('button', { name: /Sales EMEA/ }));
    expect(onConfirm).toHaveBeenCalledWith(CONFIRM, expect.objectContaining({ name: 'Sales EMEA' }));
  });

  it('says a repaired report was corrected, and lists no assumptions when there are none', () => {
    render({ kind: 'report', repaired: true, assumptions: [], timing: null });
    expect(screen.getByText(/after correcting my first attempt/)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('does not claim a correction for a first-time report', () => {
    render({ kind: 'report', timing: null });
    expect(screen.getByText(/updated the report definition/)).not.toHaveTextContent('correcting');
  });

  it('shows an error turn with its detail lines', () => {
    render({ kind: 'error', message: 'Could not build it', errors: ['field "x" unknown', 'no entity'], timing: null });
    expect(screen.getByText('Could not build it (field "x" unknown; no entity)')).toBeInTheDocument();
  });

  it('shows an error turn without brackets when there are no details', () => {
    render({ kind: 'error', message: 'Could not build it', timing: null });
    expect(screen.getByText('Could not build it')).toBeInTheDocument();
  });

  it('shows what the user said as their own bubble', () => {
    renderWithProviders(<Turn turn={{ role: 'user', text: 'all disabled admins' }} isLast busy={false} onAnswer={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('all disabled admins')).toBeInTheDocument();
  });
});

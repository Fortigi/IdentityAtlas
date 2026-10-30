// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { renderWithProviders, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
import { useDialog } from './dialogContext';

// A tiny harness component that exposes each dialog API via buttons and shows
// the resolved result, so we can assert the async resolve/reject flow.
function Harness({ onUndo }) {
  const dialog = useDialog();
  const [result, setResult] = useState('—');
  return h('div', null,
    h('button', { onClick: async () => setResult(String(await dialog.confirm({ message: 'Sure?', confirmLabel: 'Yes', danger: true }))) }, 'ask-confirm'),
    h('button', { onClick: async () => setResult(String(await dialog.prompt({ message: 'Name?', confirmLabel: 'Save' }))) }, 'ask-prompt'),
    h('button', { onClick: () => { dialog.toast('Saved!', { variant: 'success' }); } }, 'fire-toast'),
    h('button', { onClick: () => { dialog.alert('Boom'); } }, 'fire-alert'),
    h('button', { onClick: () => { dialog.toast('Moved', { action: { label: 'Undo', onClick: onUndo } }); } }, 'fire-action-toast'),
    h('span', { 'data-testid': 'result' }, result),
  );
}

function setup(props = {}) {
  renderWithProviders(h(Harness, props));
  return userEvent.setup();
}

describe('DialogProvider / useDialog', () => {
  it('confirm() resolves true when the confirm button is clicked', async () => {
    const user = setup();
    await user.click(screen.getByText('ask-confirm'));
    await user.click(await screen.findByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('true'));
  });

  it('confirm() resolves false when cancelled', async () => {
    const user = setup();
    await user.click(screen.getByText('ask-confirm'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('false'));
  });

  it('prompt() resolves the typed value', async () => {
    const user = setup();
    await user.click(screen.getByText('ask-prompt'));
    const input = await screen.findByRole('textbox');
    await user.type(input, 'Alice');
    await user.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('Alice'));
  });

  it('prompt() resolves null when cancelled', async () => {
    const user = setup();
    await user.click(screen.getByText('ask-prompt'));
    const input = await screen.findByRole('textbox');
    await user.click(within(input.closest('form')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('null'));
  });

  it('toast() shows a message and can be dismissed', async () => {
    const user = setup();
    await user.click(screen.getByText('fire-toast'));
    const toast = await screen.findByText('Saved!');
    await user.click(within(toast.closest('[role="status"]')).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Saved!')).not.toBeInTheDocument());
  });

  it('a toast with an action runs it once and closes', async () => {
    const onUndo = vi.fn();
    const user = setup({ onUndo });
    await user.click(screen.getByText('fire-action-toast'));
    const toast = (await screen.findByText('Moved')).closest('[role="status"]');
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Moved')).not.toBeInTheDocument());
  });

  it('a toast without an action has only the dismiss button', async () => {
    const user = setup();
    await user.click(screen.getByText('fire-toast'));
    const toast = (await screen.findByText('Saved!')).closest('[role="status"]');
    expect(within(toast).getAllByRole('button').map(b => b.getAttribute('aria-label') || b.textContent)).toEqual(['Dismiss']);
  });

  it('alert() surfaces a toast', async () => {
    const user = setup();
    await user.click(screen.getByText('fire-alert'));
    expect(await screen.findByText('Boom')).toBeInTheDocument();
  });

  it('renders no dialog/toast DOM when idle', () => {
    renderWithProviders(h('div', { 'data-testid': 'idle' }, 'hi'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

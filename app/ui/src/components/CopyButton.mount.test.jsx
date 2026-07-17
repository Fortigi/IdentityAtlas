// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';
import CopyButton from '@ui/components/CopyButton';
import { copyText } from '@ui/utils/clipboard';

// Control the Clipboard API per-test. Passing null removes it, simulating a
// non-secure-context install where `navigator.clipboard` is undefined.
function setClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

// jsdom doesn't implement document.execCommand, so assign a stub (can't spyOn a
// missing property). Returns whether the legacy copy "succeeded".
function setExecCommand(result) {
  document.execCommand = vi.fn().mockReturnValue(result);
}

afterEach(() => {
  vi.restoreAllMocks();
  setClipboard(null);
  delete document.execCommand;
});

describe('copyText', () => {
  it('writes via the Clipboard API and returns true on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await expect(copyText('secret')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('secret');
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    setExecCommand(true);
    const exec = document.execCommand;
    await expect(copyText('secret')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand in a non-secure context (no Clipboard API)', async () => {
    setClipboard(null);
    setExecCommand(true);
    const exec = document.execCommand;
    await expect(copyText('secret')).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it('returns false when the write genuinely fails everywhere', async () => {
    setClipboard(null);
    setExecCommand(false);
    await expect(copyText('secret')).resolves.toBe(false);
  });
});

describe('CopyButton', () => {
  it('reports "Copied" only after the write resolves', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    renderWithProviders(<CopyButton text="sk-123" label="Copy key" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('shows a failure hint (not a false success) when the clipboard write fails', async () => {
    setClipboard(null);
    setExecCommand(false);
    renderWithProviders(<CopyButton text="sk-123" label="Copy key" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(await screen.findByText(/Copy failed/)).toBeTruthy();
    // Never claims success on failure.
    expect(screen.queryByText('Copied')).toBeNull();
  });
});

// @vitest-environment jsdom
//
// The share recipient list saves itself. The inputs here are chosen to separate
// the hook from plausible wrong versions of it: a list that is re-ordered or
// re-cased is the SAME list (a naive JSON compare would save it again, forever,
// because the save's own result comes back as new objects), and a list emptied
// is the one change that must never be sent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@ui/test-utils/renderWithProviders';
import { useRecipientAutosave, recipientKey, autosaveNotice } from './useRecipientAutosave';

const ANN = { principalId: 'p1', userKey: 'ann@contoso.com', displayName: 'Ann' };
const BOB = { principalId: 'p2', userKey: 'bob@contoso.com', displayName: 'Bob' };

describe('recipientKey', () => {
  it('is the same for the same people in a different order', () => {
    expect(recipientKey([ANN, BOB])).toBe(recipientKey([BOB, ANN]));
  });

  it('ignores the case of a sign-in name, which does not change who can open the link', () => {
    expect(recipientKey([{ userKey: 'Ann@Contoso.com' }])).toBe(recipientKey([ANN]));
  });

  it('ignores a display name, which is not who the share is addressed to', () => {
    expect(recipientKey([{ ...ANN, displayName: 'Ann Manager' }])).toBe(recipientKey([ANN]));
  });

  it('differs the moment somebody is added or removed', () => {
    expect(recipientKey([ANN])).not.toBe(recipientKey([ANN, BOB]));
    expect(recipientKey([])).not.toBe(recipientKey([ANN]));
  });

  it('survives a missing list or a person with no sign-in name', () => {
    expect(recipientKey(undefined)).toBe('');
    expect(recipientKey([{}])).toBe('');
  });
});

describe('autosaveNotice', () => {
  it('reports progress quietly and the empty list as something to act on', () => {
    expect(autosaveNotice('saving')).toEqual({ text: 'Saving…', tone: 'quiet' });
    expect(autosaveNotice('saved')).toEqual({ text: 'Saved', tone: 'quiet' });
    expect(autosaveNotice('empty').tone).toBe('warn');
    expect(autosaveNotice('empty').text).toMatch(/at least one person/);
  });

  it('says nothing at all when there is nothing to report', () => {
    expect(autosaveNotice('idle')).toBeNull();
  });
});

describe('useRecipientAutosave', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  function setup({ save = vi.fn(async () => ({})), onSaved = vi.fn(), initial = [ANN] } = {}) {
    const hook = renderHook(() => useRecipientAutosave({ initial, save, onSaved, delay: 100 }));
    return { ...hook, save, onSaved };
  }

  it('writes the list back once it settles, and tells the host', async () => {
    const { result, save, onSaved } = setup();
    act(() => result.current.setPeople([ANN, BOB]));
    expect(save).not.toHaveBeenCalled();      // not on the keystroke

    await act(async () => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith([ANN, BOB]);
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('writes once for two people added in quick succession', async () => {
    const { result, save } = setup();
    act(() => result.current.setPeople([ANN, BOB]));
    await act(async () => { vi.advanceTimersByTime(60); });
    act(() => result.current.setPeople([ANN, BOB, { userKey: 'cara@contoso.com' }]));
    await act(async () => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toHaveLength(3);
  });

  it('stops after the save instead of saving its own result forever', async () => {
    const { result, save } = setup();
    act(() => result.current.setPeople([ANN, BOB]));
    await act(async () => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Plenty of time for a second write that must not happen.
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never sends an empty list, and says why', async () => {
    const { result, save } = setup();
    act(() => result.current.setPeople([]));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe('empty');
  });

  it('keeps the author’s list on screen when the write fails, and retries on the next change', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('Directory unavailable'))
      .mockResolvedValueOnce({});
    const { result } = setup({ save });

    act(() => result.current.setPeople([ANN, BOB]));
    await act(async () => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(result.current.error).toBe('Directory unavailable'));
    // Not silently reverted: what is on screen is still what was asked for.
    expect(result.current.people).toEqual([ANN, BOB]);
    expect(result.current.status).toBe('idle');

    act(() => result.current.setPeople([BOB]));
    await act(async () => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('does not write back a list that only came back re-ordered', async () => {
    const { result, save } = setup({ initial: [ANN, BOB] });
    act(() => result.current.setPeople([BOB, ANN]));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(save).not.toHaveBeenCalled();
  });
});

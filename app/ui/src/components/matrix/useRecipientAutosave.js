// Changing who a matrix is shared with saves itself.
//
// Everything else about a matrix is kept the moment it is changed; the share's
// recipient list was the one place that still needed a separate Save, and a
// person added and left unsaved simply never got access — silently, because the
// list on screen already showed them. So the list writes itself back shortly
// after it settles.
//
// Two rules the API forces, and this hook keeps on the near side of the
// network:
//   * an empty list is not a share (PUT /recipients refuses it). Removing the
//     last person is "stop sharing", which is a deliberate, confirmed act — so
//     an empty list is never sent, and the panel says so instead.
//   * the list is compared by WHO is on it, not by the objects: re-reading the
//     share after a save hands back equal-but-new rows, and saving again on
//     that would loop.

import { useCallback, useEffect, useState } from 'react';

// Who is on the list, in a form two lists can be compared by. Case-folded and
// sorted because neither the case of a sign-in name nor the order people were
// picked in changes who can open the link.
export function recipientKey(people) {
  return (people || [])
    .map(p => String(p?.userKey ?? '').toLowerCase())
    .sort()
    .join('|');
}

// What the panel says about the save, and whether it is showing a problem.
// 'empty' is not an error: it is the one state the author gets to by removing
// people, and the way out of it is Stop sharing.
export function autosaveNotice(status) {
  if (status === 'saving') return { text: 'Saving…', tone: 'quiet' };
  if (status === 'saved') return { text: 'Saved', tone: 'quiet' };
  if (status === 'empty') return { text: 'A share needs at least one person — use Stop sharing to close the link.', tone: 'warn' };
  return null;
}

// `save(people)` is the request and must reject on failure; it and `onSaved`
// are dependencies of the write effect, so callers hand over stable functions.
// `delay` is how long the list has to settle before it is written — long enough
// to add two people without two writes, short enough that the author does not
// leave first.
export function useRecipientAutosave({ initial, save, onSaved, delay = 800 }) {
  const [people, setPeople] = useState(() => initial);
  // The list as the server has it, held as state rather than a ref so the
  // effect below re-runs the moment a save lands and stops rather than firing
  // again on its own result.
  const [savedKey, setSavedKey] = useState(() => recipientKey(initial));
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const change = useCallback((next) => {
    setPeople(next);
    setError(null);
  }, []);

  const key = recipientKey(people);
  const pending = key !== savedKey;
  const emptied = pending && people.length === 0;

  useEffect(() => {
    if (!pending || emptied) return undefined;
    const timer = setTimeout(async () => {
      setStatus('saving');
      try {
        await save(people);
        setSavedKey(key);
        setStatus('saved');
        setError(null);
        onSaved?.();
      } catch (err) {
        // Left un-saved on purpose: the list on screen is still what the author
        // asked for, and the next edit retries it.
        setStatus('idle');
        setError(err.message || 'Could not update the people this is shared with');
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [key, pending, emptied, people, delay, save, onSaved]);

  return {
    people,
    setPeople: change,
    // 'empty' outranks the rest: it is the only state that stops a save from
    // ever happening, so saying "Saved" over it would be a lie about the list
    // on screen.
    status: emptied ? 'empty' : status,
    error,
  };
}

// @vitest-environment jsdom
// Each answer type's control hands back the API's shape.
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { renderWithProviders, makeAuthFetch, screen, userEvent, within, waitFor } from '@ui/test-utils/renderWithProviders';
import AnswerInput from './AnswerInput';

const def = { languages: ['en'] };

function Harness({ question, initial = null, onChange, shown, searchUrl }) {
  const [value, setValue] = useState(initial);
  return (
    <AnswerInput question={question} value={value} lang="en" def={def} label="Q" shown={shown} inputId="q" searchUrl={searchUrl}
      onChange={(v) => { setValue(v); onChange(v); }} />
  );
}
const mount = (question, extra = {}) => {
  const onChange = vi.fn();
  const r = renderWithProviders(<Harness question={question} onChange={onChange} {...extra} />, { auth: { authFetch: extra.authFetch ?? makeAuthFetch({}) } });
  return { onChange, user: userEvent.setup(), ...r };
};

describe('AnswerInput', () => {
  it('a choice: one option, clicked again to clear', async () => {
    const { onChange, user } = mount({ answer: { type: 'choice', options: [{ value: 'A', label: 'Alpha' }, { value: 'B' }] } });
    await user.click(screen.getByRole('radio', { name: 'Alpha' }));
    await user.click(screen.getByRole('radio', { name: 'Alpha' }));
    expect(onChange.mock.calls.map(c => c[0])).toEqual(['A', null]);
    expect(screen.getByRole('radio', { name: 'B' })).toBeInTheDocument();
  });

  it('a multi-choice: the ticked values in the options\' order', async () => {
    const { onChange, user } = mount({ answer: { type: 'multiChoice', options: [{ value: 'EU' }, { value: 'US' }] } });
    await user.click(screen.getByRole('checkbox', { name: 'US' }));
    await user.click(screen.getByRole('checkbox', { name: 'EU' }));
    await user.click(screen.getByRole('checkbox', { name: 'US' }));
    expect(onChange.mock.calls.map(c => c[0])).toEqual([['US'], ['EU', 'US'], ['EU']]);
  });

  it('a confirm: shows what is confirmed; "not correct" asks the right value', async () => {
    const { onChange, user } = mount({ answer: { type: 'confirm', shows: 'owner' } }, { shown: 'Piet Jansen' });
    expect(screen.getByText('Piet Jansen')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Not correct' }));
    await user.type(screen.getByRole('textbox', { name: 'Q: The right value' }), 'Kees');
    expect(onChange.mock.calls.at(-1)[0]).toEqual({ ok: false, value: 'Kees' });
    await user.click(screen.getByRole('radio', { name: 'Correct' }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual({ ok: true });
  });

  it('a short text is an input, a long one a text area; a date an ISO date', async () => {
    const { onChange, user, unmount } = mount({ answer: { type: 'text', maxLength: 50 } });
    await user.type(screen.getByRole('textbox', { name: 'Q' }), 'Hi');
    expect(screen.getByRole('textbox', { name: 'Q' }).tagName).toBe('INPUT');
    expect(onChange.mock.calls.at(-1)[0]).toBe('Hi');
    unmount();
    mount({ answer: { type: 'text' } });
    expect(screen.getByRole('textbox', { name: 'Q' }).tagName).toBe('TEXTAREA');
  });

  it('people: found with the given search, added once each, removed again', async () => {
    const authFetch = makeAuthFetch({ '/find?q=Pi': { data: [{ id: 'p1', displayName: 'Piet' }] } });
    const { onChange, user } = mount({ answer: { type: 'people' } }, { authFetch, searchUrl: t => `/find?q=${t}` });
    await user.type(screen.getByRole('textbox', { name: 'Q' }), 'Pi');
    await user.click(await screen.findByRole('button', { name: /Piet/ }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual([{ principalId: 'p1', displayName: 'Piet' }]);
    await user.type(screen.getByRole('textbox', { name: 'Add a person' }), 'Pi');
    await user.click(await screen.findByRole('button', { name: /^Piet/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Remove Piet' }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual([]);
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/find?q=Pi'));
  });

  it('a person: one; once chosen the search goes until it is removed', async () => {
    const authFetch = makeAuthFetch({ '/find?q=Ke': { data: [{ id: 'p2', displayName: 'Kees' }] } });
    const { onChange, user } = mount({ answer: { type: 'person' } }, { authFetch, searchUrl: t => `/find?q=${t}` });
    await user.type(screen.getByRole('textbox', { name: 'Q' }), 'Ke');
    await user.click(await screen.findByRole('button', { name: /Kees/ }));
    expect(onChange.mock.calls.at(-1)[0]).toEqual({ principalId: 'p2', displayName: 'Kees' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Kees' }));
    expect(onChange.mock.calls.at(-1)[0]).toBeNull();
  });

  it('a date', async () => {
    const { onChange, container } = mount({ answer: { type: 'date' } });
    const input = within(container).getByLabelText('Q');
    input.value = '';
    await userEvent.setup().type(input, '2026-01-31');
    expect(onChange.mock.calls.at(-1)[0]).toBe('2026-01-31');
  });
});

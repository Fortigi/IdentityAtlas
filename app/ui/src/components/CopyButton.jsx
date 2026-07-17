import { useState } from 'react';
import { copyText } from '@ui/utils/clipboard';

// A copy-to-clipboard button that reflects the ACTUAL result: it shows "Copied"
// only after the write resolves, and a "Copy failed — select manually" hint if
// it doesn't. Use it anywhere a value must genuinely reach the clipboard —
// especially one-time secrets (API keys, read tokens) that can't be shown again.
export default function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', className = '', title }) {
  // 'idle' | 'ok' | 'fail'
  const [state, setState] = useState('idle');

  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 2500);
  };

  const display = state === 'ok' ? copiedLabel
    : state === 'fail' ? 'Copy failed — select manually'
    : label;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-live="polite"
      className={className || 'px-3 py-1 rounded text-xs font-medium border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}
    >
      {display}
    </button>
  );
}

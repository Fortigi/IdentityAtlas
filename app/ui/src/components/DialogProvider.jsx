// In-app replacement for the browser's native alert()/confirm()/prompt().
//
// Why: native dialogs block the main thread, can't be styled (no dark mode), and
// are flagged by the local/no-native-dialogs ESLint rule. This provider exposes
// an async API via useDialog():
//
//   const dialog = useDialog();
//   if (await dialog.confirm({ message: 'Delete this?', danger: true })) { ... }
//   const name = await dialog.prompt({ message: 'New name?', defaultValue: cur });
//   dialog.toast('Saved', { variant: 'success' });   // non-blocking, auto-dismiss
//
// confirm/prompt render as Modals (resolve when the user acts); alert-style
// notices surface as auto-dismissing toasts top-right. One provider near the app
// root keeps a single source of truth so the pattern doesn't re-spread.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Modal, PrimaryButton, SecondaryButton } from './contexts/ModalPrimitives';
import { DialogContext } from './dialogContext';

const TOAST_VARIANTS = {
  info:    'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-700',
  success: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-200 dark:border-green-700',
  error:   'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-700',
  warning: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700',
};

export function DialogProvider({ children }) {
  // A single confirm/prompt modal at a time; its resolver lives in a ref.
  const [dialog, setDialog] = useState(null);
  const [promptValue, setPromptValue] = useState('');
  const resolverRef = useRef(null);

  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);

  const settle = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    if (resolve) resolve(result);
  }, []);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    resolverRef.current = resolve;
    setDialog({ kind: 'confirm', ...opts });
  }), []);

  const prompt = useCallback((opts = {}) => new Promise((resolve) => {
    resolverRef.current = resolve;
    setPromptValue(opts.defaultValue != null ? String(opts.defaultValue) : '');
    setDialog({ kind: 'prompt', ...opts });
  }), []);

  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((messageOrOpts, maybeOpts) => {
    const opts = typeof messageOrOpts === 'string'
      ? { message: messageOrOpts, ...maybeOpts }
      : (messageOrOpts || {});
    const id = ++toastIdRef.current;
    const variant = TOAST_VARIANTS[opts.variant] ? opts.variant : 'info';
    setToasts((list) => [...list, { id, message: opts.message, title: opts.title, variant }]);
    const ttl = opts.duration ?? 4500;
    if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
    return id;
  }, [dismissToast]);

  // alert() replacement — an informational toast (error variant when isError).
  const alert = useCallback((message, opts = {}) => {
    const text = typeof message === 'string' ? message : (message?.message ?? '');
    return toast({ message: text, variant: opts.variant || 'error', ...opts });
  }, [toast]);

  const api = useMemo(() => ({ confirm, prompt, toast, alert }), [confirm, prompt, toast, alert]);

  return (
    <DialogContext.Provider value={api}>
      {children}

      {dialog?.kind === 'confirm' && (
        <Modal
          title={dialog.title || 'Please confirm'}
          onClose={() => settle(false)}
          width={dialog.width || 420}
          dismissOnBackdrop={false}
        >
          {dialog.message && (
            <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{dialog.message}</p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <SecondaryButton onClick={() => settle(false)}>{dialog.cancelLabel || 'Cancel'}</SecondaryButton>
            {dialog.danger ? (
              <button
                onClick={() => settle(true)}
                className="px-3 py-1 text-xs rounded bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600"
              >
                {dialog.confirmLabel || 'Confirm'}
              </button>
            ) : (
              <PrimaryButton onClick={() => settle(true)}>{dialog.confirmLabel || 'Confirm'}</PrimaryButton>
            )}
          </div>
        </Modal>
      )}

      {dialog?.kind === 'prompt' && (
        <Modal
          title={dialog.title || 'Enter a value'}
          onClose={() => settle(null)}
          width={dialog.width || 420}
          dismissOnBackdrop={false}
        >
          <form onSubmit={(e) => { e.preventDefault(); settle(promptValue); }}>
            {dialog.message && (
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-2 whitespace-pre-line">{dialog.message}</p>
            )}
            <input
              autoFocus
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={dialog.placeholder}
              className="w-full px-2 py-1 border border-gray-200 dark:border-gray-700 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-400 dark:focus:ring-sky-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <SecondaryButton onClick={() => settle(null)}>{dialog.cancelLabel || 'Cancel'}</SecondaryButton>
              <PrimaryButton onClick={() => settle(promptValue)}>{dialog.confirmLabel || 'OK'}</PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {/* Toast stack — top-right, above modals. Only mounted when non-empty so
          an idle provider adds no DOM (keeps "renders nothing" mounts clean). */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto rounded-lg border shadow-lg px-3 py-2 text-sm flex items-start gap-2 ${TOAST_VARIANTS[t.variant]}`}
          >
            <div className="min-w-0 flex-1">
              {t.title && <p className="font-semibold">{t.title}</p>}
              <p className="whitespace-pre-line break-words">{t.message}</p>
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              className="shrink-0 opacity-70 hover:opacity-100"
              aria-label="Dismiss"
            >✕</button>
          </div>
        ))}
        </div>
      )}
    </DialogContext.Provider>
  );
}

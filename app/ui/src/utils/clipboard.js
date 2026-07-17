// Copy `text` to the clipboard and return whether it actually succeeded.
// The modern Clipboard API is unavailable in a non-secure context (an install
// served over plain http://<host> rather than localhost/https), where
// `navigator.clipboard` is undefined and the old fire-and-forget calls threw or
// silently no-op'd — so a "one-time" key looked copied but wasn't (audit H-19).
// Await the write and fall back to execCommand so the caller learns the truth.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

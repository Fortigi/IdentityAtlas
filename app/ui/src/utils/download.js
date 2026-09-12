// Browser file-download helpers.
//
// `triggerDownload` centralises the object-URL + synthetic-anchor dance that
// every "save this to a file" surface needs; `filenameFromDisposition` reads the
// name the server asked for, so a downloaded file is named by whoever produced
// it rather than by a second, drifting guess in the client.

/** Save `blob` to the user's machine under `filename`. */
export function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * The filename from a `Content-Disposition` header, or null when the header is
 * absent or names none. Handles both the plain `filename="…"` form and the
 * RFC-5987 `filename*=UTF-8''…` form. Any directory part is stripped — the
 * header is server-controlled, but a download is still written by name.
 */
export function filenameFromDisposition(header) {
  const text = header || '';
  const extended = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(text);
  const plain = /filename="([^"]*)"|filename=([^;]+)/.exec(text);
  let name = null;
  if (extended) {
    try {
      name = decodeURIComponent(extended[1]);
    } catch {
      name = extended[1];
    }
  } else if (plain) {
    name = plain[1] ?? plain[2];
  }
  name = name?.trim().split(/[\\/]/).pop();
  return name || null;
}

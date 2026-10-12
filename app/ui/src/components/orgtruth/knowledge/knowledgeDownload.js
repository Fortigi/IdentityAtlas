// Fetch a file with the signed-in user's token and save it: the server names
// the file through Content-Disposition, `fallback` otherwise. Throws
// "HTTP <status>" when the answer is not ok. Used by Export JSON and by
// "Download original file".
import { triggerDownload, filenameFromDisposition } from '@ui/utils/download';

export async function downloadFile(authFetch, url, fallback) {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers?.get?.('Content-Disposition')) || fallback;
  triggerDownload(name, blob);
  return name;
}

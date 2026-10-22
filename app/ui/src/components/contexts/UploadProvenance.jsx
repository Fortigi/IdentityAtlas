import { provenanceText } from './ContextDetails.helpers';

// Where a context of an uploaded list came from — one line under the header:
// "Uploaded from klanten.xlsx on 3 Oct 2026 by …; last updated by an upload of
// klanten-v2.xlsx on 20 Oct 2026." The API adds the fields to a context whose
// source system is an upload list (GET /api/contexts/:id); nothing shows for
// any other context.

export default function UploadProvenance({ attrs }) {
  const text = provenanceText(attrs);
  if (!text) return null;
  return (
    <p className="px-1 text-xs text-gray-600 dark:text-gray-400" data-testid="upload-provenance">
      {text}
    </p>
  );
}

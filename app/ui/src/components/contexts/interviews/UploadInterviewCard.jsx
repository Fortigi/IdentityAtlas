import { useState } from 'react';
import { useDialog } from '@ui/components/dialogContext';
import { useContextClaims } from './claimsContext';
import UploadInterviewModal from './UploadInterviewModal';

// Action card: upload the transcript of an interview about this unit or
// application. What it says lands in "What we know" for review (the
// ClaimsProvider refreshes); nothing is written to the context until then.
export default function UploadInterviewCard({ attrs }) {
  const ctx = useContextClaims();
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  // A business reader (no data.write.contexts) gets no card: transcripts and review are the analyst's.
  if (!ctx?.canWrite) return null;

  function uploaded(interview) {
    ctx?.reload();
    dialog.toast(interview.llmConfigured
      ? 'Interview uploaded; its claims appear under What we know once it is read.'
      : 'Interview uploaded. No model is configured: add claims by hand under What we know.', { variant: 'success' });
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-upload-interview">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Upload interview</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">
        A transcript of a conversation about this — who was interviewed and when. What it says becomes claims to review, with the quote each rests on.
      </p>
      <button type="button" onClick={() => setOpen(true)}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600">
        Upload transcript
      </button>
      {open && <UploadInterviewModal contextId={attrs.id} onUploaded={uploaded} onClose={() => setOpen(false)} />}
    </div>
  );
}

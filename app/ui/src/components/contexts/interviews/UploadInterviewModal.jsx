import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { Modal, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';

// ─── Upload an interview transcript ──────────────────────────────────────
// The file (.txt, .docx, .vtt, .srt), who was interviewed (an account, found
// with the People block's search) and when. POST multipart to
// /api/contexts/:id/interviews. The answer says whether a model reads it now
// (llmConfigured); without one the analyst adds claims by hand from the list.

const ACCEPT = '.txt,.docx,.vtt,.srt';
const today = () => new Date().toISOString().slice(0, 10);

export default function UploadInterviewModal({ contextId, onUploaded, onClose }) {
  const { authFetch } = useAuth();
  const [file, setFile] = useState(null);
  const [person, setPerson] = useState(null);
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('principalId', person.id);
      fd.append('interviewedAt', date);
      const r = await authFetch(`/api/contexts/${contextId}/interviews`, { method: 'POST', body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onUploaded(body);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Upload interview" subtitle="A transcript, who was interviewed and when. Nothing is changed until you review what it says." onClose={onClose} width={480} dismissOnBackdrop={false}>
      <div className="space-y-3 text-xs">
        <div>
          <label htmlFor="interview-file" className="block font-medium text-gray-700 dark:text-gray-300">Transcript (.txt, .docx, .vtt or .srt)</label>
          <input id="interview-file" type="file" accept={ACCEPT} onChange={e => setFile(e.target.files?.[0] || null)}
            className="mt-1 block w-full text-xs text-gray-700 dark:text-gray-300" />
        </div>
        {person
          ? (
            <p className="text-gray-700 dark:text-gray-300">
              Interviewed: <span className="font-medium text-gray-900 dark:text-white">{person.displayName}</span>{' '}
              <button type="button" onClick={() => setPerson(null)} className="text-blue-700 underline dark:text-blue-300">change</button>
            </p>
          )
          : <PersonSearch inputId="interviewee-search" label="Who was interviewed" onPick={setPerson} />}
        <div>
          <label htmlFor="interview-date" className="block font-medium text-gray-700 dark:text-gray-300">Interviewed on</label>
          <input id="interview-date" type="date" value={date} onChange={e => setDate(e.target.value)}
            className="mt-1 rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
        </div>
      </div>
      <ErrorBox message={error} />
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={busy || !file || !person || !date}>{busy ? 'Uploading…' : 'Upload'}</PrimaryButton>
      </div>
    </Modal>
  );
}

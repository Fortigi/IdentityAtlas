import { useState } from 'react';
import { Modal } from './ModalPrimitives';
import CreateManualTreeModal from './CreateManualTreeModal';
import RunPluginModal from './RunPluginModal';

// ─── Three-card dispatcher for creating a new context tree ────────────────────
// The actual work lives in the child modals; this one just routes the user to
// one of them. "Import" jumps to the Crawlers tab — crawler-driven trees are
// created by the crawl itself, so there's no modal to open here.

export default function NewContextModal({ open, onClose, onCreated, onRunStarted, onOpenCrawlers }) {
  const [stage, setStage] = useState('choose');  // 'choose' | 'manual' | 'plugin'

  function close() {
    setStage('choose');
    onClose();
  }

  if (!open) return null;

  if (stage === 'manual') {
    return (
      <CreateManualTreeModal
        open
        onClose={close}
        onCreated={created => { onCreated?.(created); close(); }}
      />
    );
  }
  if (stage === 'plugin') {
    return (
      <RunPluginModal
        open
        onClose={close}
        onRunStarted={runId => { onRunStarted?.(runId); close(); }}
      />
    );
  }

  return (
    <Modal title="New context tree" subtitle="Where should this tree come from?" onClose={close} width={600}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card
          title="Import"
          tone="slate"
          description="Crawlers pull trees from source systems (HR, AD OU, app catalogues). Configure one on the Crawlers page — trees appear here after the next crawl."
          cta="Open Crawlers →"
          onClick={() => { onOpenCrawlers?.(); close(); }}
        />
        <Card
          title="Run a plugin"
          tone="blue"
          description="Build a tree from existing data — manager chains, department strings, OU distinguished names, LLM clusters."
          cta="Pick a plugin"
          onClick={() => setStage('plugin')}
        />
        <Card
          title="Create manual"
          tone="amber"
          description="Start an empty tree you'll curate yourself. Useful for business processes, app groupings, tags."
          cta="Create"
          onClick={() => setStage('manual')}
        />
      </div>
    </Modal>
  );
}

const TONE = {
  slate: { bar: 'bg-slate-500', pill: 'bg-slate-100 text-slate-700 border-slate-200' },
  blue:  { bar: 'bg-blue-500',  pill: 'bg-blue-100  text-blue-700  border-blue-200'  },
  amber: { bar: 'bg-amber-500', pill: 'bg-amber-100 text-amber-700 border-amber-200' },
};

function Card({ title, tone, description, cta, onClick }) {
  const t = TONE[tone] || TONE.slate;
  return (
    <button
      onClick={onClick}
      className="text-left border border-gray-200 rounded-lg p-3 hover:border-gray-300 hover:shadow-sm bg-white flex flex-col"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block w-2 h-4 rounded ${t.bar}`} aria-hidden="true" />
        <span className="text-sm font-semibold text-gray-900">{title}</span>
      </div>
      <p className="text-[11px] text-gray-600 flex-1">{description}</p>
      <span className={`mt-3 self-start inline-flex items-center text-[11px] px-2 py-0.5 rounded border ${t.pill}`}>
        {cta}
      </span>
    </button>
  );
}

// Links of one org entity to system objects — the LinkedAccountsPanel idiom:
// target (opens its detail tab), type, ConfidenceBar, matched signals as chips,
// status / analyst-override badge, and Confirm / Reject / Move (or Undo once
// decided) for someone who may import. Used by Review (one table per entity
// group) and by the entity detail page's Links section.
//
// `candidates` are normalised rows from reviewRows.js (groupReviewRows or
// toLinkCandidates). Move asks, through the in-app prompt, which of the other
// shown candidates of the same type the link should point at (MVP: no search).
import ConfidenceBar from '@ui/components/ConfidenceBar';
import { useDialog } from '@ui/components/dialogContext';
import { targetDetailKind, targetTypeLabel } from './orgFormat';
import { moveOptions, movePromptMessage, pickMoveOption } from './reviewRows';
import { StatusPill, TypePill, TH, TD, LINK_BUTTON } from './orgUi';

const CONFIRM_BTN = 'text-xs px-2 py-1 rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50';
const REJECT_BTN = 'text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50';
const NEUTRAL_BTN = 'text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';

function Target({ c, onOpenDetail }) {
  const kind = targetDetailKind(c.targetType);
  if (!kind || !c.targetId) return <span className="font-medium text-gray-900 dark:text-gray-100">{c.label}</span>;
  return (
    <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.(kind, c.targetId, c.label)}>
      {c.label}
    </button>
  );
}

function Actions({ c, busy, canMove, onOverride, onMove }) {
  if (c.override) {
    return <button type="button" disabled={busy} className={NEUTRAL_BTN} onClick={() => onOverride(c.linkId, 'clear')}>Undo</button>;
  }
  return (
    <>
      <button type="button" disabled={busy} className={CONFIRM_BTN} onClick={() => onOverride(c.linkId, 'confirmed')}>Confirm</button>
      <button type="button" disabled={busy} className={REJECT_BTN} onClick={() => onOverride(c.linkId, 'rejected')}>Reject</button>
      {canMove && <button type="button" disabled={busy} className={NEUTRAL_BTN} onClick={() => onMove(c)}>Move</button>}
    </>
  );
}

export default function OrgLinkTable({ candidates, canEdit, busy, onOverride, onOpenDetail }) {
  const dialog = useDialog();

  const onMove = async (c) => {
    const options = moveOptions(candidates, c.linkId);
    const input = await dialog.prompt({
      title: 'Move link', message: movePromptMessage(options), defaultValue: '1', confirmLabel: 'Move',
    });
    if (input == null) return;
    const choice = pickMoveOption(input, options);
    if (!choice) {
      dialog.alert('That is not one of the shown candidates.');
      return;
    }
    onOverride(c.linkId, 'moved', choice.targetId);
  };

  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 dark:bg-gray-700/50">
        <tr>
          <th scope="col" className={TH}>Target</th>
          <th scope="col" className={TH}>Type</th>
          <th scope="col" className={TH}>Confidence</th>
          <th scope="col" className={TH}>Matched on</th>
          <th scope="col" className={TH}>Status</th>
          {canEdit && <th scope="col" className={TH}><span className="sr-only">Actions</span></th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {candidates.map(c => (
          <tr key={c.linkId}>
            <td className={TD}>
              <Target c={c} onOpenDetail={onOpenDetail} />
              {c.matchedField && (
                <div className="text-xs text-gray-600 dark:text-gray-400">{c.matchedField}: {c.matchedValue}</div>
              )}
            </td>
            <td className={TD}><TypePill type={targetTypeLabel(c.targetType)} /></td>
            <td className={TD}><ConfidenceBar confidence={c.confidence} /></td>
            <td className={TD}>
              <div className="flex flex-wrap gap-1">
                {c.signals.map(s => (
                  <span key={s} className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{s}</span>
                ))}
              </div>
            </td>
            <td className={TD}>
              <div className="flex flex-wrap gap-1">
                <StatusPill status={c.status} />
                {c.override && <StatusPill status={c.override} />}
              </div>
            </td>
            {canEdit && (
              <td className={`${TD} text-right whitespace-nowrap`}>
                <div className="flex justify-end gap-2">
                  <Actions c={c} busy={busy === c.linkId} canMove={moveOptions(candidates, c.linkId).length > 0}
                    onOverride={onOverride} onMove={onMove} />
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

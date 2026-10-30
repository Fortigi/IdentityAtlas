import { SegmentedControl } from '@ui/components/matrix/wizardControls';
import { variantLabel } from './variants.helpers';

// "This unit as": the same unit held as people, accounts and resources, as a
// switch — "People 12 · Accounts 15 · Resources 31" — with this context
// pressed. Choosing another kind opens that context; the members of the kinds
// are never merged. Shown only when the unit is held as more than one kind:
// a section that would only say "none" is left out.
export default function UnitVariants({ variants, onOpenDetail, label = 'This unit as' }) {
  if (!variants.some(v => !v.self)) return null;
  const self = variants.find(v => v.self);

  function open(id) {
    const v = variants.find(x => x.id === id);
    if (!v || v.self) return;
    onOpenDetail?.('context', v.id, v.displayName);
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap items-center gap-2 text-xs" data-testid="unit-variants">
      <span className="font-semibold text-gray-700 dark:text-gray-300">{label}</span>
      <SegmentedControl
        label={label}
        options={variants.map(v => ({ key: v.id, label: variantLabel(v) }))}
        value={self?.id}
        onChange={open}
      />
    </div>
  );
}

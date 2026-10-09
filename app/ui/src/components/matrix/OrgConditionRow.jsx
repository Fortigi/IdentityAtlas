// The chip of an organisation condition (kind 'org', T8) in the wizard's
// Include / Exclude lists, e.g. "Organisation · Klant · iso27001 = Ja · via
// eigenaar". The wording is orgConditionText() in orgtruth/orgCondition.js.

import { orgConditionText } from '@ui/components/orgtruth/orgCondition';
import { CONDITION_CHIP, RemoveConditionButton } from './wizardControls';

export default function OrgConditionRow({ cond, onRemove }) {
  const text = orgConditionText(cond);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={CONDITION_CHIP}>
        <span className="truncate text-gray-800 dark:text-gray-200" title={text}>{text}</span>
      </span>
      <RemoveConditionButton onClick={onRemove} />
    </div>
  );
}

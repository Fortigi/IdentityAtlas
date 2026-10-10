// Context builder — what the context holds: the resources the terms find, or the users who
// have access to them (or are linked to a matching organisation entity). Preselected from
// the model's reading of the description; the analyst can always switch.

import { ASSIGNMENT_TYPES, recipeTarget, TARGET_LABELS } from './recipeDraft';

const LEGEND = 'mb-1 text-sm font-medium text-gray-800 dark:text-gray-200';
const OPTION = 'flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300';
const ACCESS_LABELS = { Direct: 'Direct', Indirect: 'Indirect (through a group)', Eligible: 'Eligible (not yet activated)' };

/**
 * @param {object}   props
 * @param {object}   props.recipe
 * @param {Function} props.onTarget        ('resource'|'principal')
 * @param {Function} props.onToggleAccess  (assignmentType)
 */
export default function TargetSwitch({ recipe, onTarget, onToggleAccess }) {
  const target = recipeTarget(recipe);
  const selected = recipe.access?.assignmentTypes || [];
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2">
      <fieldset>
        <legend className={LEGEND}>Build a context of</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(TARGET_LABELS).map(([key, label]) => (
            <label key={key} className={OPTION}>
              <input type="radio" name="ctx-target" value={key} checked={target === key} onChange={() => onTarget(key)} className="h-4 w-4" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {target === 'principal' && (
        <fieldset>
          <legend className={LEGEND}>Access that counts</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {ASSIGNMENT_TYPES.map(t => (
              <label key={t} className={OPTION}>
                <input type="checkbox" checked={selected.includes(t)} onChange={() => onToggleAccess(t)} className="h-4 w-4" />
                {ACCESS_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

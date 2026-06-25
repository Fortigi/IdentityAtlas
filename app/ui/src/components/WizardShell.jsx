import Stepper from '@ui/components/Stepper';

/**
 * Shared outer wrapper for all crawler ConfigWizard components.
 * Renders the card, title bar + Cancel button, optional Stepper, and error message.
 * Step content goes in children.
 *
 * Props:
 *   title          — heading text
 *   onCancel       — Cancel button handler
 *   cancelDisabled — optional: disables the Cancel button (demo's loading state)
 *   steps          — optional: array passed to Stepper; omit to hide the Stepper row
 *   currentStep    — current step number for the Stepper
 *   onStepClick    — optional: step-click handler for the Stepper
 *   allowAllSteps  — optional: allow clicking any step (used when isEdit=true)
 *   error          — optional: error string; renders a red alert when set
 *   children       — step content
 */
export default function WizardShell({
  title,
  onCancel,
  cancelDisabled,
  steps,
  currentStep,
  onStepClick,
  allowAllSteps,
  error,
  children,
}) {
  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
        <button onClick={onCancel} disabled={cancelDisabled}
          className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">
          Cancel
        </button>
      </div>

      {steps && (
        <div className="mb-5">
          <Stepper steps={steps} current={currentStep} onStepClick={onStepClick} allowAll={!!allowAllSteps} />
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {children}
    </div>
  );
}

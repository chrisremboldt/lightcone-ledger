import { Badge, Button } from '@ledger/ui';
import { firstSteps, firstStepsReadable, type FirstStepsInput, type FirstStepTarget } from './first-steps.js';

/**
 * What the organization has on file for its safety records, and what it does not: each missing item with the one
 * action that starts it and who may take it.
 */
export function FirstSteps({ onStart, ...input }: FirstStepsInput & { onStart: (target: FirstStepTarget) => void }) {
  if (!firstStepsReadable(input.home)) return null;
  const steps = firstSteps(input);
  const missing = steps.filter((step) => !step.onFile).length;
  return (
    <section className="safety-section sms-first-steps" aria-label="What is on file">
      <div className="safety-section-heading">
        <h3>
          What is on file{' '}
          <span className="sms-count sms-count--quiet">
            {steps.length - missing} of {steps.length}
          </span>
        </h3>
      </div>
      <p className="muted">
        Who may adopt and accept risk, the risk matrix, the safety policy and how safety reports are received, as your
        organization&apos;s records show them now.
      </p>
      <ul className="sms-first-steps-list">
        {steps.map((step) => (
          <li key={step.key} data-testid={`first-step-${step.key}`}>
            <span>
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
              {step.action && <small>{`${step.action.label}: ${step.action.who}`}</small>}
            </span>
            <span className="sms-row-facts">
              <Badge tone={step.onFile ? 'planned' : 'attention'}>{step.onFile ? 'On file' : 'Not on file'}</Badge>
              {step.action?.mine && (
                <Button kind="next" onClick={() => onStart(step.action!.target)}>
                  {step.action.label}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

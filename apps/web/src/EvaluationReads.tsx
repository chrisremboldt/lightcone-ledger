import type { AcceptedObservation, NamedSubject } from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Spinner } from '@ledger/ui';
import { time, timeZoneLabel } from './format.js';
import { sourceLabel } from './labels.js';
import { wordingValue } from './wording.js';
import {
  citedBySubject,
  readSubjects,
  readSubjectText,
  ruleExplanation,
  useCitedObservations,
  type CitedSubject,
  type WithExplanation,
} from './evaluation-reads.js';

/** A field name read as words: landingAt becomes "Landing at". */
function fieldLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function valueText(value: unknown, subjects: readonly NamedSubject[]): string {
  // A reference to a subject reads as its id, or its name when it is a subject the evaluation read.
  const reference = value as { id?: unknown; scope?: unknown } | null;
  if (
    reference &&
    typeof reference === 'object' &&
    typeof reference.id === 'string' &&
    typeof reference.scope === 'string'
  )
    return wordingValue(reference.id, subjects);
  return wordingValue(value, subjects);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !('scope' in value);

function observationValues(observation: AcceptedObservation): [string, unknown][] {
  const values = observation.observation.values;
  // A carried record's own fields are listed one by one, beside the observation's other values.
  return isPlainObject(values)
    ? Object.entries(values).flatMap(([name, value]) =>
        isPlainObject(value) ? Object.entries(value) : [[name, value]],
      )
    : [];
}

function ReadObservation({
  observation,
  subjects,
}: {
  observation: AcceptedObservation;
  subjects: readonly NamedSubject[];
}) {
  return (
    <li data-testid="evaluation-read" data-source-id={observation.sourceId}>
      <strong>{sourceLabel(observation.sourceId)}</strong>
      <small>
        Reported {time(observation.occurredAt, true)} {timeZoneLabel()}
        {observation.replacedBy || observation.withdrawal ? ' · no longer current' : ''}
      </small>
      {observationValues(observation).map(([name, value]) => (
        <small key={name}>
          {fieldLabel(name)}: {valueText(value, subjects)}
        </small>
      ))}
    </li>
  );
}

/**
 * What an evaluation from an adopted rule read: each observation it cites, with its source, time and values, read
 * through the ordinary observation reads. Works for any rule; a screen may lay the same observations out its own way.
 * When the evaluation read more than one subject, or a subject other than the one shown, each is listed under it.
 */
export function EvaluationReads({
  client,
  subject,
  evaluation,
}: {
  client: LedgerClient | null;
  subject: CitedSubject;
  evaluation: WithExplanation;
}) {
  const explanation = ruleExplanation(evaluation);
  const cited = useCitedObservations(client, subject, evaluation);
  if (!explanation) return null;
  const details = Object.entries(explanation.details);
  const { labelled, groups } = citedBySubject(cited.observations, evaluation, subject);
  const named = readSubjects(evaluation);
  return (
    <section aria-label="What this evaluation read" data-testid="evaluation-reads">
      {details.length > 0 && (
        <details className="finding-provenance">
          <summary>What the check computed</summary>
          <dl className="safety-facts">
            {details.map(([name, value]) => (
              <div key={name}>
                <dt>{fieldLabel(name)}</dt>
                <dd>{valueText(value, named)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {cited.loading && <Spinner label="Reading the cited observations" />}
      {cited.error && <p className="rail-muted">{cited.error}</p>}
      {labelled
        ? groups.map((group) => (
            <section
              key={group.key}
              className="evaluation-read-subject"
              aria-label={`Read about ${readSubjectText(group.subject, subject)}`}
              data-testid="evaluation-read-subject"
              data-subject-key={group.key}
            >
              <h5>{readSubjectText(group.subject, subject)}</h5>
              <ul className="finding-evidence">
                {group.observations.map((observation) => (
                  <ReadObservation key={observation.id} observation={observation} subjects={named} />
                ))}
              </ul>
            </section>
          ))
        : cited.observations.length > 0 && (
            <ul className="finding-evidence">
              {cited.observations.map((observation) => (
                <ReadObservation key={observation.id} observation={observation} subjects={named} />
              ))}
            </ul>
          )}
    </section>
  );
}

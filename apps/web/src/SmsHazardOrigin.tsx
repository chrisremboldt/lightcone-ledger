import { useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  EvaluationRecord,
  Principal,
  SmsEvidenceComparison,
  SmsLinkedRecord,
  SmsRecordDetailResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice } from '@ledger/ui';
import { time, timeZoneLabel } from './format.js';
import { kindLabel } from './labels.js';
import { LandingReports } from './LandingReports.js';
import { originFlightId, type FlightFinding, type FlightLinks } from './safety-navigation.js';

/** The flight a hazard's finding came from, read from the flight record: its label and the evaluation the origin pins. */
export interface OriginFlight {
  flightId: string;
  findingId: string;
  label: string | null;
  /** The finding's latest evaluation, which places every occurrence reported so far; the origin keeps the pinned one. */
  evaluation: EvaluationRecord | null;
  /** The evaluation the origin pins, when the flight still shows it; the origin's reports are read from it. */
  pinned: EvaluationRecord | null;
}

export function useOriginFlight(
  client: LedgerClient,
  principal: Principal,
  detail: SmsRecordDetailResponse | null,
  from?: FlightFinding,
): OriginFlight | null {
  const origin = detail?.origin?.kind === 'finding' ? detail.origin : null;
  const flightId = origin ? originFlightId(origin) : undefined;
  const readable = principal.capabilities.includes('flight:read') && principal.capabilities.includes('evidence:read');
  const [read, setRead] = useState<OriginFlight | null>(null);
  // Read again when the finding is evaluated again, so newly reported positions reach the map.
  const latest = detail?.evidence?.sinceOpened.latestEvaluation.id;
  useEffect(() => {
    if (!origin || !flightId) return;
    const base = {
      flightId,
      findingId: origin.findingId,
      label: from?.flightId === flightId ? from.flightLabel : null,
      evaluation: null,
      pinned: null,
    };
    setRead((previous) => (previous?.flightId === flightId ? previous : base));
    if (!readable) return;
    let stopped = false;
    client
      .timeline(flightId, { limit: 1 })
      .then((timeline) => {
        if (stopped) return;
        const finding = timeline.findings?.find((entry) => entry.id === origin.findingId);
        const evaluation = finding?.latestEvaluation ?? null;
        const pinned =
          [finding?.initialEvaluation, finding?.latestEvaluation].find((entry) => entry?.id === origin.evaluationId) ??
          null;
        setRead({ ...base, label: timeline.flight.label, evaluation, pinned });
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [client, flightId, origin?.findingId, latest, readable]);
  return read;
}

/** Where a hazard came from, with the way back to the flight it was raised on and what was recorded since. */
export function HazardOriginSection({
  client,
  detail,
  flight,
  flights,
  onOpen,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  flight: OriginFlight | null;
  flights?: FlightLinks;
  onOpen: (record: SmsLinkedRecord) => void;
}) {
  const origin = detail.origin;
  if (!origin || origin.kind === 'manual') return null;
  if (origin.kind === 'report')
    return (
      <section className="safety-section" data-testid="hazard-origin">
        <h3>Origin</h3>
        <p>Opened from version {origin.versionNumber} of a safety report.</p>
        <Button
          kind="quiet"
          onClick={() =>
            onOpen({
              id: origin.recordId,
              kind: 'report',
              title: 'Safety report',
              status: '',
              confidentiality: 'safety_report',
            })
          }
        >
          Open the safety report
        </Button>
      </section>
    );
  if (origin.kind === 'assurance')
    return (
      <section className="safety-section" data-testid="hazard-origin">
        <h3>Origin</h3>
        <p>
          Opened from {origin.item.kind} {origin.item.id} of version {origin.versionNumber} of a safety assurance
          record.
        </p>
        <Button
          kind="quiet"
          onClick={() =>
            onOpen({
              id: origin.recordId,
              kind: 'assurance',
              title: 'Safety assurance record',
              status: '',
              confidentiality: 'ordinary',
            })
          }
        >
          Open the safety assurance record
        </Button>
      </section>
    );
  const evidence = detail.evidence;
  return (
    <section className="safety-section safety-origin" data-testid="hazard-origin">
      <div className="safety-section-heading">
        <h3>Origin</h3>
        <Badge tone="attention">From a finding</Badge>
      </div>
      <p>
        <strong>{origin.rule.title}</strong>
        {flight ? ` · on ${flight.label ?? 'a flight'}` : ''}
      </p>
      <dl className="safety-facts">
        <div>
          <dt>Evaluation reviewed at opening · {timeZoneLabel()}</dt>
          <dd className="mono">{time(origin.evaluationRecordedAt, true)}</dd>
        </div>
        <div>
          <dt>About</dt>
          <dd>
            {flight ? `Flight ${flight.label ?? flight.flightId}` : `${origin.subject.kind} ${origin.subject.id}`}
            {origin.related ? ` · related ${origin.related.subject.kind} ${origin.related.subject.id}` : ''}
          </dd>
        </div>
      </dl>
      {flight?.pinned && <LandingReports client={client} flightId={flight.flightId} evaluation={flight.pinned} />}
      {flight && flights && (
        <Button
          kind="quiet"
          onClick={() => flights.onFlight({ flightId: flight.flightId, findingId: flight.findingId })}
        >
          {flight.label ? `Return to ${flight.label}` : 'Open the finding on its flight'}
        </Button>
      )}
      {evidence && quiet(evidence.sinceOpened) && (!evidence.sinceAssessed || quiet(evidence.sinceAssessed)) ? (
        <p className="muted">Nothing newer on the finding since the hazard was opened.</p>
      ) : (
        <>
          {evidence && <NewerEvidence label="since it was opened" comparison={evidence.sinceOpened} />}
          {evidence?.sinceAssessed && (
            <NewerEvidence label="since the latest assessment" comparison={evidence.sinceAssessed} />
          )}
        </>
      )}
    </section>
  );
}

const quiet = (comparison: SmsEvidenceComparison) =>
  !comparison.newerEvaluation && comparison.newerRecords.length === 0 && !comparison.sourceProjectionPending;

function NewerEvidence({ label, comparison }: { label: string; comparison: SmsEvidenceComparison }) {
  if (quiet(comparison)) return <p className="muted">Nothing newer on the finding {label}.</p>;
  return (
    <Notice title={`Newer on the finding ${label}`}>
      {comparison.newerEvaluation && (
        <p>
          The finding was evaluated again at {time(comparison.latestEvaluation.recordedAt, true)} {timeZoneLabel()}.
        </p>
      )}
      {comparison.sourceProjectionPending && <p>Some evidence is still being processed.</p>}
      {comparison.newerRecords.length > 0 && (
        <ul className="sms-newer-records">
          {comparison.newerRecords.map((record) => (
            <li key={record.eventId}>
              <span title={record.eventType} data-event-type={record.eventType}>
                {kindLabel(record.eventType)}
              </span>{' '}
              ·{' '}
              <span className="mono">
                {time(record.recordedAt, true)} {timeZoneLabel()}
              </span>
            </li>
          ))}
          {comparison.newerRecordsTruncated && <li>And more records after these.</li>}
        </ul>
      )}
    </Notice>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  EvaluationRecord,
  Principal,
  SmsFindingPromotionResponse,
  SmsHomeResponse,
  SmsRecordSummary,
  SmsRegisterResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { time, timeZoneLabel } from './format.js';
import { dueLabel, levelName, levelTone, plainError, statusPresentation } from './sms-labels.js';
import { FailureNotice, IdentifyHazardForm, useCommand } from './SmsForms.js';
import { originLabels, type FlightFinding, type FlightLinks } from './safety-navigation.js';
import { LandingReports } from './LandingReports.js';

const findingStatusLabels: Record<SmsFindingPromotionResponse['findingStatus'], string> = {
  open: 'Needs an owner',
  acknowledged: 'Owned',
  responding: 'Response recorded',
  resolved: 'Closed',
};

const registerPath = (search: Record<string, string>) =>
  `/v1/sms/records?${new URLSearchParams({ kind: 'hazard', ...search })}`;

export function RecordRow({
  record,
  onOpen,
  action,
  stage,
}: {
  record: SmsRecordSummary;
  onOpen: () => void;
  action?: string;
  stage?: string;
}) {
  const status = { ...statusPresentation(record.status), ...(stage ? { label: stage } : {}) };
  const due = dueLabel(record);
  // A hazard someone identified directly reads as it always has; only a finding or a report is named.
  const origin = record.origin && record.origin.kind !== 'manual' ? originLabels[record.origin.kind] : null;
  return (
    <button className="hazard-row sms-row" data-testid={`sms-row-${record.id}`} onClick={onOpen}>
      <span>
        <strong>{record.title}</strong>
        <small>
          {record.owner.name} · {record.kind === 'document' ? `Working version ${record.versionNumber} · ` : ''}
          {status.label}
          {due ? ` · ${due}` : ''}
          {origin ? ` · ${origin}` : ''}
          {record.revision > record.projectedRevision ? ' · Updating' : ''}
        </small>
      </span>
      <span className="sms-row-facts">
        {record.residual && (
          <Badge tone={levelTone(record.residual.acceptance)} title="Predicted residual risk">
            {levelName(record.residual.level)} residual
            {record.residual.acceptance === 'not_acceptable' ? ', may not be accepted' : ''}
          </Badge>
        )}
        {record.overdue && <Badge tone="attention">Overdue</Badge>}
        <span className="sms-row-action">{action ?? 'Open'} →</span>
      </span>
    </button>
  );
}

/** Every hazard of the organization, newest first, a page at a time. */
export function HazardRegister({
  register,
  home,
  principal,
  client,
  flights,
  onOpen,
  onChanged,
}: {
  register: SmsRegisterResponse;
  home: SmsHomeResponse;
  principal: Principal;
  client: LedgerClient;
  flights?: FlightLinks;
  onOpen: (record: Pick<SmsRecordSummary, 'id' | 'kind'>) => void;
  onChanged: () => void;
}) {
  // Later pages, read on request after the first page the safety section keeps current.
  const [later, setLater] = useState<{ records: SmsRecordSummary[]; nextCursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const shownIds = new Set(register.records.map((record) => record.id));
  const records = [...register.records, ...(later?.records ?? []).filter((record) => !shownIds.has(record.id))];
  const nextCursor = later ? later.nextCursor : register.nextCursor;
  async function more() {
    if (!nextCursor) return;
    setLoading(true);
    setFailure(null);
    try {
      const page = await client.request<SmsRegisterResponse>(registerPath({ cursor: nextCursor }));
      setLater((previous) => ({
        records: [...(previous?.records ?? []), ...page.records],
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main">
        <p className="thread-crumbs">Safety / Hazard register</p>
        <div className="thread-title">
          <h2>Hazard register</h2>
          <Badge>
            {records.length}
            {nextCursor ? '+' : ''} recorded
          </Badge>
        </div>
        <p className="safety-intro">
          Every hazard your organization has identified, from any source, newest first. Each keeps its owner,
          assessment, risk acceptance and full history.
        </p>
        {records.length === 0 ? (
          <div className="safety-empty">
            <h3>No hazards recorded yet</h3>
            <p>
              Identify the first hazard with the form beside this register. No flight is needed.
              {flights ? ' A finding on a flight can also become a hazard: open the safety workspace from it.' : ''}
            </p>
          </div>
        ) : (
          <div className="hazard-register" aria-label="Recorded hazards">
            <div className="hazard-register-labels" aria-hidden="true">
              <span>Hazard · owner · status</span>
              <span>Residual risk</span>
            </div>
            {records.map((record) => (
              <RecordRow key={record.id} record={record} onOpen={() => onOpen(record)} />
            ))}
          </div>
        )}
        {failure && (
          <Notice tone="alert" title="More hazards unavailable">
            {failure}
          </Notice>
        )}
        {nextCursor && (
          <div className="history-navigation">
            <Button kind="quiet" disabled={loading} onClick={() => void more()}>
              {loading ? 'Loading…' : 'More hazards'}
            </Button>
          </div>
        )}
      </div>
      <aside className="rail safety-rail" aria-label="Safety actions">
        <IdentifyHazardForm
          client={client}
          principal={principal}
          home={home}
          onOpened={(id) => {
            onChanged();
            onOpen({ id, kind: 'hazard' });
          }}
        />
      </aside>
    </div>
  );
}

/**
 * Where "open safety workspace" on a flight finding lands. A hazard already promoted from the finding opens at once;
 * otherwise someone who may edit safety records promotes it here, and anyone else is told who can.
 */
export function FindingHazard({
  client,
  principal,
  home,
  finding,
  flights,
  onOpened,
}: {
  client: LedgerClient;
  principal: Principal;
  home: SmsHomeResponse;
  finding: FlightFinding;
  flights?: FlightLinks;
  onOpened: (id: string) => void;
}) {
  const [state, setState] = useState<'looking' | 'none' | { failure: string }>('looking');
  const [current, setCurrent] = useState<SmsFindingPromotionResponse | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationRecord | null>(null);
  const canPromote = principal.capabilities.includes('sms:write') && principal.capabilities.includes('evidence:read');

  useEffect(() => {
    let stopped = false;
    client
      .request<SmsRegisterResponse>(registerPath({ findingId: finding.findingId, limit: '1' }))
      .then((found) => {
        if (stopped) return;
        if (found.records[0]) onOpened(found.records[0].id);
        else setState('none');
      })
      .catch((error: unknown) => !stopped && setState({ failure: plainError(error).message }));
    if (finding.flightId && principal.capabilities.includes('flight:read')) {
      client
        .timeline(finding.flightId, { limit: 1 })
        .then(
          (timeline) =>
            !stopped &&
            setEvaluation(timeline.findings?.find((entry) => entry.id === finding.findingId)?.latestEvaluation ?? null),
        )
        .catch(() => undefined);
    }
    return () => {
      stopped = true;
    };
  }, [client, finding.flightId, finding.findingId]);

  useEffect(() => {
    if (state !== 'none' || !canPromote) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const shown = await client.request<SmsFindingPromotionResponse>(
          `/v1/sms/findings/${encodeURIComponent(finding.findingId)}/promotion`,
        );
        if (stopped) return;
        // Someone promoted it in the meantime: open theirs rather than a second hazard.
        if (shown.existingHazard) return onOpened(shown.existingHazard.recordId);
        setCurrent(shown);
      } catch (error) {
        if (!stopped) setState({ failure: plainError(error).message });
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, finding.findingId, state === 'none', canPromote]);

  const flightId = finding.flightId;
  const back = flights && (
    <Button
      kind="quiet"
      onClick={() => flights.onFlight(flightId ? { flightId, findingId: finding.findingId } : undefined)}
    >
      <span aria-hidden="true">←</span> {flightId ? `Return to ${finding.flightLabel}` : 'Return to the finding list'}
    </Button>
  );
  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main" data-testid="finding-hazard">
        <nav className="sms-record-nav">{back}</nav>
        <p className="thread-crumbs">Safety / Hazard register / From {finding.flightLabel}</p>
        <div className="thread-title">
          <h2>Open a hazard from this finding</h2>
          <Badge tone="attention">From a finding</Badge>
        </div>
        <p className="safety-intro">
          The hazard keeps this finding and the exact evaluation you review as its origin. The finding, its owner and
          what was done about it stay with the {flightId ? 'flight record' : 'finding'}.
        </p>
        {typeof state === 'object' && (
          <Notice tone="alert" title="The finding could not be read">
            {state.failure}
          </Notice>
        )}
        {state === 'looking' && <Spinner label="Looking for a hazard from this finding" />}
        {state === 'none' && current && (
          <section className="safety-section safety-origin">
            <h3>{current.origin.rule.title}</h3>
            <p>{current.evaluation.summary}</p>
            {evaluation && flightId && <LandingReports client={client} flightId={flightId} evaluation={evaluation} />}
            <dl className="safety-facts">
              <div>
                <dt>{flightId ? 'Flight' : 'About'}</dt>
                <dd>{finding.flightLabel}</dd>
              </div>
              <div>
                <dt>Evaluated · {timeZoneLabel()}</dt>
                <dd className="mono">{time(current.origin.evaluationRecordedAt, true)}</dd>
              </div>
              <div>
                <dt>Finding</dt>
                <dd>{findingStatusLabels[current.findingStatus]}</dd>
              </div>
            </dl>
          </section>
        )}
        {state === 'none' && !canPromote && (
          <Notice title="No hazard from this finding yet">
            Opening a hazard from a finding needs permission to edit safety records and read evidence. Ask your safety
            manager or dispatcher to open one.
          </Notice>
        )}
      </div>
      <aside className="rail safety-rail" aria-label="Safety actions">
        {state === 'none' && canPromote && !current && <Spinner label="Reading the finding" />}
        {state === 'none' && canPromote && current && (
          <PromoteFindingForm client={client} principal={principal} home={home} current={current} onOpened={onOpened} />
        )}
      </aside>
    </div>
  );
}

function PromoteFindingForm({
  client,
  principal,
  home,
  current,
  onOpened,
}: {
  client: LedgerClient;
  principal: Principal;
  home: SmsHomeResponse;
  current: SmsFindingPromotionResponse;
  onOpened: (id: string) => void;
}) {
  // The evaluation and basis the person reviewed; a newer one is shown but never used without their say.
  const [pinned, setPinned] = useState(current);
  const [draft, setDraft] = useState({
    title: '',
    description: current.evaluation.summary,
    consequence: '',
    operation: '',
    ownerId: principal.id,
  });
  const command = useCommand(client);
  const changed =
    pinned.origin.evaluationId !== current.origin.evaluationId ||
    pinned.basis.dependencyBasis !== current.basis.dependencyBasis;
  const set = (field: keyof typeof draft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [field]: event.target.value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await command.submit({
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: draft.title.trim(),
        ownerId: draft.ownerId,
        body: {
          description: draft.description.trim(),
          consequence: draft.consequence.trim(),
          ...(draft.operation.trim() ? { operation: draft.operation.trim() } : {}),
          source: { kind: 'finding' },
        },
      },
      origin: {
        kind: 'finding',
        findingId: pinned.origin.findingId,
        evaluationId: pinned.origin.evaluationId,
        expectedDependencyBasis: pinned.basis.dependencyBasis,
      },
    });
    if (result?.command.subject) onOpened(result.command.subject.id);
  }
  return (
    <form
      className="action-form safety-form"
      data-testid="hazard-promote-form"
      onSubmit={(event) => void save(event)}
      aria-label="Open a hazard from this finding"
    >
      <h3>Open a hazard</h3>
      <p className="safety-form-note">Recorded on the safety record, with this finding as its origin.</p>
      {changed && (
        <Notice title="The finding changed since you started">
          {pinned.origin.evaluationId !== current.origin.evaluationId
            ? 'The finding was evaluated again. '
            : 'New evidence reached the finding. '}
          Opening will be refused until you review the current finding; your draft is kept.
          <Button kind="quiet" type="button" onClick={() => setPinned(current)}>
            Refresh basis
          </Button>
        </Notice>
      )}
      <label htmlFor="promote-title">Hazard</label>
      <input id="promote-title" value={draft.title} onChange={set('title')} maxLength={200} required />
      <label htmlFor="promote-description">What could go wrong, and where</label>
      <textarea id="promote-description" rows={4} value={draft.description} onChange={set('description')} required />
      <label htmlFor="promote-consequence">Worst credible outcome</label>
      <textarea id="promote-consequence" rows={2} value={draft.consequence} onChange={set('consequence')} required />
      <label htmlFor="promote-operation">Operation or system affected (optional)</label>
      <input id="promote-operation" value={draft.operation} onChange={set('operation')} maxLength={200} />
      <label htmlFor="promote-owner">Owner</label>
      <select id="promote-owner" value={draft.ownerId} onChange={set('ownerId')}>
        {home.people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending || changed}>
        {command.pending ? 'Recording…' : 'Open hazard'}
      </Button>
    </form>
  );
}

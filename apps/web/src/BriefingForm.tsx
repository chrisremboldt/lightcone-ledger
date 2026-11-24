import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import { AreaControlSummary } from './AreaControlSummary.js';
import type { MissionBriefingCommand, OrganizationPerson, Principal } from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import {
  briefingAccessLost,
  briefingBasis,
  briefingCommandLostAccess,
  briefingReadiness,
  buildBriefingCommand,
  type BriefingContext,
} from './briefing.js';
import { errorMessage, json } from './format.js';
import { RecipientPicker } from './RecipientPicker.js';
import { NotApplicableControls } from './NotApplicableControls.js';
import { avoidanceNotApplicableEntries, briefingOthersWords } from './flight-controls.js';

interface Props {
  client: LedgerClient;
  principal: Principal;
  context: BriefingContext | null;
  /** The controls a new draft covers; without them it covers every control in the release. */
  requestedControlEventIds?: readonly string[];
  /** The digest of the controls in scope as last shown on this screen. */
  controlsDigest?: string;
  /** Why the controls in scope could not be read, when the last read failed. */
  controlsFailure?: string;
  /** Reads the controls in scope again. */
  onRetryControls?: () => void;
  onRefresh: () => Promise<BriefingContext>;
  onAccepted: (briefingId: string) => void;
}
interface Draft {
  context: BriefingContext;
  basis: string;
  principalId: string;
  principalRevision: number;
  /** The controls the briefing covers. */
  controlEventIds: string[];
  people: OrganizationPerson[];
  message: string;
}
interface Failure {
  text: string;
  conflict: boolean;
  uncertain: boolean;
}

/** Why a briefing cannot be recorded yet when the controls in scope, which it records, could not be read. */
export function BriefingControlsUnavailable({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  return (
    <Notice tone="alert" title="Controls unavailable">
      The controls in scope for this flight could not be read, so the briefing cannot be recorded yet. {reason}
      {onRetry && (
        <Button kind="quiet" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Notice>
  );
}

export function BriefingForm({
  client,
  principal,
  context,
  requestedControlEventIds,
  controlsDigest,
  controlsFailure,
  onRetryControls,
  onRefresh,
  onAccepted,
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [lostAccess, setLostAccess] = useState<{ context: BriefingContext | null } | null>(null);
  const attempt = useRef<{ command: MissionBriefingCommand; key: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const selectedControl = useRef<HTMLFieldSetElement>(null);
  const prepareAction = useRef<HTMLDivElement>(null);
  const formWasOpen = useRef(false);
  const fieldId = useId();
  const shownContext = useRef(context);
  shownContext.current = context;
  const accessLost = briefingAccessLost(lostAccess, context);
  const scope = useRef({ client, principalId: principal.id, releaseId: context?.release.release.id });
  scope.current = { client, principalId: principal.id, releaseId: context?.release.release.id };
  const cacheScope = `${principal.id}:${principal.tenantId}:${principal.revision}`;
  const canWrite = principal.capabilities.includes('flight:read') && principal.capabilities.includes('briefing:write');
  const reasons = briefingReadiness(context);
  const uncertain = failure?.uncertain ?? false;
  const locked = busy || uncertain || refreshing;
  const stale = Boolean(
    draft &&
    (!context ||
      draft.basis !== briefingBasis(context) ||
      draft.principalId !== principal.id ||
      draft.principalRevision !== principal.revision),
  );
  const shownControls = draft?.context.controls.filter((entry) =>
    draft.controlEventIds.includes(entry.candidate.controlEventId),
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (formOpen) selectedControl.current?.querySelector('input')?.focus();
    else if (formWasOpen.current) prepareAction.current?.querySelector('button')?.focus();
    formWasOpen.current = formOpen;
  }, [formOpen]);

  function clearPrivateDraft() {
    setDraft(null);
    setFormOpen(false);
    setFailure(null);
    setAcceptedId(null);
    setLostAccess({ context: shownContext.current });
    attempt.current = null;
  }

  function prepare() {
    if (draft) {
      setFormOpen(true);
      return;
    }
    if (!context || !canWrite || reasons.length || accessLost || inFlight.current) return;
    const candidates = context.release.release.basis.avoidance.candidates.map((candidate) => candidate.controlEventId);
    const requested = candidates.filter((id) => requestedControlEventIds?.includes(id));
    setDraft({
      context: structuredClone(context),
      basis: briefingBasis(context),
      principalId: principal.id,
      principalRevision: principal.revision,
      controlEventIds: requested.length ? requested : candidates,
      people: [],
      message: '',
    });
    setFormOpen(true);
    setFailure(null);
    setRefreshRequired(false);
    attempt.current = null;
  }

  function change(values: Partial<Pick<Draft, 'controlEventIds' | 'people' | 'message'>>) {
    if (locked) return;
    setDraft((previous) => (previous ? { ...previous, ...values } : previous));
  }

  function sameScope(releaseId: string) {
    return (
      alive.current &&
      scope.current.client === client &&
      scope.current.principalId === principal.id &&
      (!scope.current.releaseId || scope.current.releaseId === releaseId)
    );
  }

  async function refresh() {
    if (!draft || locked) return;
    const saved = draft;
    setRefreshing(true);
    try {
      const next = await onRefresh();
      if (!sameScope(saved.context.release.release.id)) return;
      if (
        next.release.release.id !== saved.context.release.release.id ||
        next.release.digest !== saved.context.release.digest
      )
        throw new Error(
          'This draft belongs to a different exact release. Return to its reviewed release before continuing.',
        );
      setDraft({
        ...saved,
        context: structuredClone(next),
        basis: briefingBasis(next),
        principalId: principal.id,
        principalRevision: principal.revision,
      });
      setFailure(null);
      setRefreshRequired(false);
      attempt.current = null;
    } catch (error) {
      if (sameScope(saved.context.release.release.id))
        setFailure({ text: errorMessage(error), conflict: true, uncertain: false });
    } finally {
      if (sameScope(saved.context.release.release.id)) setRefreshing(false);
    }
  }

  async function send(command: MissionBriefingCommand) {
    if (inFlight.current) return;
    attempt.current ??= { command: structuredClone(command), key: crypto.randomUUID() };
    const saved = attempt.current;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await client.command(saved.command, saved.key);
      if (!sameScope(saved.command.release.id)) return;
      setAcceptedId(response.command.id);
      setDraft(null);
      setFormOpen(false);
      setRefreshRequired(false);
      attempt.current = null;
      onAccepted(response.command.id);
    } catch (error) {
      if (!sameScope(saved.command.release.id)) return;
      if (briefingCommandLostAccess(error)) {
        clearPrivateDraft();
        return;
      }
      const unknown = !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
      const code = error instanceof ApiError ? (error.body as { error?: { code?: string } })?.error?.code : undefined;
      const conflict = error instanceof ApiError && (error.status === 409 || code === 'briefing_recipients_invalid');
      setFailure({
        text:
          code === 'briefing_recipients_invalid'
            ? 'A selected recipient is no longer an active person in this organization. Refresh the people directory and review your selections.'
            : errorMessage(error),
        conflict,
        uncertain: unknown,
      });
      if (!unknown) attempt.current = null;
      if (conflict) setRefreshRequired(true);
    } finally {
      inFlight.current = false;
      if (sameScope(saved.command.release.id)) setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      locked ||
      stale ||
      refreshRequired ||
      !canWrite ||
      reasons.length ||
      !draft.message.trim() ||
      !draft.controlEventIds.length ||
      !draft.people.length ||
      !controlsDigest ||
      accessLost
    )
      return;
    try {
      await send(
        buildBriefingCommand(
          draft.context,
          draft.controlEventIds,
          draft.people,
          draft.message,
          draft.principalRevision,
          controlsDigest,
        ),
      );
    } catch (error) {
      setFailure({ text: errorMessage(error), conflict: false, uncertain: false });
    }
  }

  return (
    <section className="briefing-actions" aria-label="Briefing action">
      {acceptedId && (
        <div className="action-success" role="status">
          Briefing recorded.
        </div>
      )}
      {accessLost && (
        <Notice tone="alert" title="Briefing access changed">
          The private recipient selection and draft were cleared. Refresh your session before preparing another
          briefing.
        </Notice>
      )}
      {!canWrite && (
        <p className="muted">
          Your role can review briefings. Recording one requires current briefing author authority.
        </p>
      )}
      {reasons.length > 0 && (
        <Notice title="Briefing prerequisite">
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Notice>
      )}
      {failure && (
        <Notice
          tone={failure.conflict || failure.uncertain ? 'attention' : 'alert'}
          title={
            failure.uncertain
              ? 'Confirm the recorded result'
              : failure.conflict
                ? 'The reviewed briefing basis changed'
                : 'Briefing was not recorded'
          }
        >
          {failure.text}
          {failure.uncertain && (
            <>
              <p>
                The result is unknown. Your draft is retained. Retry the identical briefing to recover its recorded
                result.
              </p>
              <Button disabled={busy} onClick={() => attempt.current && void send(attempt.current.command)}>
                Retry same action
              </Button>
            </>
          )}
        </Notice>
      )}
      {!formOpen && !accessLost && (
        <div className="briefing-next-action" ref={prepareAction}>
          <h3>Record briefing</h3>
          <p>Choose the accepted controls it covers and the named people who will review your message.</p>
          <Button kind="next" disabled={busy || (!draft && (!canWrite || reasons.length > 0))} onClick={prepare}>
            {draft ? 'Continue briefing draft' : acceptedId ? 'Prepare another briefing' : 'Prepare briefing'}
          </Button>
        </div>
      )}
      {draft && formOpen && !accessLost && (
        <form
          className="action-form briefing-form mission-briefing-form"
          data-testid="mission-briefing-form"
          onSubmit={(event) => void submit(event)}
        >
          <div className="form-heading">
            <h3>Record briefing</h3>
            <button type="button" aria-label="Close briefing form" disabled={locked} onClick={() => setFormOpen(false)}>
              ×
            </button>
          </div>
          <p className="finding-consequence">
            Record one informational message covering these exact accepted controls for a named recipient population.
            One acknowledgement by each person covers every control listed.
          </p>
          {requestedControlEventIds?.some((id) => !draft.controlEventIds.includes(id)) && (
            <p className="muted">
              Your existing draft is retained. Choose the requested controls explicitly to change its basis.
            </p>
          )}
          <div className={`draft-basis ${stale || refreshRequired ? 'is-stale' : ''}`}>
            <span>Pins the reviewed release, selected accepted controls and your current authority</span>
            {stale || refreshRequired ? (
              <>
                <span>
                  The release, safety context or authority changed. Review the latest record, then refresh this basis.
                  Your message and recipient selections are retained.
                </span>
                <Button kind="next" type="button" disabled={locked} onClick={() => void refresh()}>
                  {refreshing ? 'Refreshing…' : 'Refresh basis'}
                </Button>
              </>
            ) : (
              <small>Recipient identities are resolved and retained when this briefing is recorded.</small>
            )}
          </div>
          <fieldset className="briefing-controls" ref={selectedControl} disabled={locked}>
            <legend>
              Controls this briefing covers · {draft.controlEventIds.length} of {draft.context.controls.length}
            </legend>
            {draft.context.controls.map(({ candidate, control }) => (
              <label key={candidate.controlEventId} htmlFor={`${fieldId}-control-${candidate.controlEventId}`}>
                <input
                  id={`${fieldId}-control-${candidate.controlEventId}`}
                  type="checkbox"
                  checked={draft.controlEventIds.includes(candidate.controlEventId)}
                  onChange={(event) =>
                    change({
                      controlEventIds: event.target.checked
                        ? [...draft.controlEventIds, candidate.controlEventId]
                        : draft.controlEventIds.filter((id) => id !== candidate.controlEventId),
                    })
                  }
                />
                {control.title} · version {candidate.controlVersion}
              </label>
            ))}
          </fieldset>
          <ReleaseNotApplicable release={draft.context.release.release} />
          {shownControls?.map(({ candidate, control }) => (
            <AreaControlSummary
              key={candidate.controlEventId}
              control={control}
              version={candidate.controlVersion}
              applicability={candidate.applicability}
            />
          ))}
          <label htmlFor={`${fieldId}-message`}>Message</label>
          <textarea
            id={`${fieldId}-message`}
            rows={5}
            maxLength={4000}
            required
            disabled={locked}
            value={draft.message}
            onChange={(event) => change({ message: event.target.value })}
          />
          <RecipientPicker
            client={client}
            cacheScope={cacheScope}
            value={draft.people}
            onChange={(people) => change({ people })}
            disabled={locked}
            onAccessLost={clearPrivateDraft}
          />
          <details className="briefing-provenance">
            <summary>Reviewed release, controls and authority</summary>
            <pre>
              {json({
                release: { id: draft.context.release.release.id, digest: draft.context.release.digest },
                controls: draft.context.release.release.basis.avoidance.candidates.filter((candidate) =>
                  draft.controlEventIds.includes(candidate.controlEventId),
                ),
                principalRevision: draft.principalRevision,
              })}
            </pre>
          </details>
          <Button
            kind="primary"
            type="submit"
            disabled={
              locked ||
              stale ||
              refreshRequired ||
              !canWrite ||
              reasons.length > 0 ||
              !draft.message.trim() ||
              !draft.controlEventIds.length ||
              !draft.people.length ||
              // The briefing pins the controls list shown with it, so it waits until that list has been read.
              !controlsDigest
            }
          >
            {busy ? <Spinner label="Recording briefing" /> : 'Record briefing'}
          </Button>
          {!controlsDigest && controlsFailure && (
            <BriefingControlsUnavailable reason={controlsFailure} onRetry={onRetryControls} />
          )}
        </form>
      )}
    </section>
  );
}

/**
 * One expandable line under a briefing's controls, counting the controls its release recorded as not applying to the
 * route; opened, it lists each with its recorded sentence. Nothing when there are none.
 */
export function ReleaseNotApplicable({ release }: { release: BriefingContext['release']['release'] }) {
  const { notApplicable } = release.basis.avoidance;
  if (!notApplicable.length) return null;
  return (
    <NotApplicableControls
      key={release.id}
      heading={briefingOthersWords(notApplicable.length)}
      entries={avoidanceNotApplicableEntries(notApplicable, release.basis.mission.sourceRevision)}
      testId="briefing-not-applicable"
    />
  );
}

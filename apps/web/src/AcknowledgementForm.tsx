import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import { missionBriefingControls } from '@ledger/contracts';
import type {
  MissionBriefingAcknowledgementCommand,
  MissionBriefingAcknowledgementsResponse,
  MissionBriefingRecordResponse,
  Principal,
} from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import {
  acknowledgementBasis,
  acknowledgementCoverageMatches,
  briefingStandingWords,
  buildAcknowledgementCommand,
  currentBriefingStanding,
} from './briefing.js';
import { errorMessage, json } from './format.js';
import { missionTime } from './missionRelease.js';

interface Props {
  client: LedgerClient;
  principal: Principal;
  exact: MissionBriefingRecordResponse;
  coverage: MissionBriefingAcknowledgementsResponse | null;
  onRefresh: () => Promise<void>;
  onAccepted: (acknowledgementId: string) => void;
}
interface Confirmation {
  basis: string;
  command: MissionBriefingAcknowledgementCommand;
}
interface Failure {
  text: string;
  conflict: boolean;
  uncertain: boolean;
}

export function AcknowledgementForm({ client, principal, exact, coverage, onRefresh, onAccepted }: Props) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [awaitingExisting, setAwaitingExisting] = useState(false);
  const attempt = useRef<{ command: MissionBriefingAcknowledgementCommand; key: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const confirmationId = useId();
  const scope = useRef({ client, principalId: principal.id, briefingId: exact.briefing.id });
  scope.current = { client, principalId: principal.id, briefingId: exact.briefing.id };
  const listed = missionBriefingControls(exact.briefing).length;
  const member = exact.briefing.population.recipients.some((recipient) => recipient.principalId === principal.id);
  const hasAuthority =
    principal.capabilities.includes('flight:read') && principal.capabilities.includes('briefing:ack');
  const matching = acknowledgementCoverageMatches(exact, coverage);
  const own = matching
    ? coverage.recipients.find((recipient) => recipient.recipientPrincipalId === principal.id)
    : undefined;
  const recorded = own?.acknowledgement?.record;
  // A lapsed briefing cannot be acknowledged; a review recorded before it lapsed stays recorded.
  const standing = currentBriefingStanding(exact, coverage);
  const lapsed = standing.status === 'lapsed';
  const uncertain = failure?.uncertain ?? false;
  const locked = busy || refreshing || uncertain;
  const stale = Boolean(confirmation && confirmation.basis !== acknowledgementBasis(exact, principal));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (recorded) setAwaitingExisting(false);
  }, [recorded]);

  function sameScope(command: MissionBriefingAcknowledgementCommand) {
    return (
      alive.current &&
      scope.current.client === client &&
      scope.current.principalId === principal.id &&
      scope.current.briefingId === command.briefing.id
    );
  }

  function confirm(checked: boolean) {
    if (locked) return;
    if (!checked) {
      setConfirmation(null);
      return;
    }
    try {
      setConfirmation({
        basis: acknowledgementBasis(exact, principal),
        command: buildAcknowledgementCommand(exact, principal),
      });
      setFailure(null);
    } catch (error) {
      setFailure({ text: errorMessage(error), conflict: false, uncertain: false });
    }
  }

  async function refreshStatus() {
    if (locked) return;
    setRefreshing(true);
    try {
      await onRefresh();
      if (!alive.current) return;
      if (stale || refreshRequired) setConfirmation(null);
      setRefreshRequired(false);
      setFailure(null);
    } catch (error) {
      if (alive.current) setFailure({ text: errorMessage(error), conflict: false, uncertain: false });
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }

  async function send(command: MissionBriefingAcknowledgementCommand) {
    if (inFlight.current) return;
    attempt.current ??= { command: structuredClone(command), key: crypto.randomUUID() };
    const saved = attempt.current;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await client.command(saved.command, saved.key);
      if (!sameScope(saved.command)) return;
      setAcceptedId(response.command.id);
      setConfirmation(null);
      setRefreshRequired(false);
      attempt.current = null;
      onAccepted(response.command.id);
    } catch (error) {
      if (!sameScope(saved.command)) return;
      const code = error instanceof ApiError ? (error.body as { error?: { code?: string } })?.error?.code : undefined;
      if (code === 'briefing_lapsed') {
        attempt.current = null;
        setConfirmation(null);
        setFailure({ text: errorMessage(error), conflict: false, uncertain: false });
        await onRefresh().catch(() => {});
        return;
      }
      if (code === 'briefing_already_acknowledged') {
        attempt.current = null;
        setConfirmation(null);
        setAwaitingExisting(true);
        try {
          await onRefresh();
        } catch (readError) {
          if (sameScope(saved.command))
            setFailure({ text: errorMessage(readError), conflict: false, uncertain: false });
        }
        return;
      }
      const unknown = !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
      const conflict = error instanceof ApiError && error.status === 409;
      setFailure({ text: errorMessage(error), conflict, uncertain: unknown });
      if (!unknown) attempt.current = null;
      if (conflict) setRefreshRequired(true);
    } finally {
      inFlight.current = false;
      if (sameScope(saved.command)) setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !confirmation ||
      locked ||
      stale ||
      refreshRequired ||
      !member ||
      !hasAuthority ||
      !matching ||
      lapsed ||
      recorded ||
      acceptedId ||
      awaitingExisting
    )
      return;
    await send(confirmation.command);
  }

  return (
    <section className="briefing-acknowledgement" aria-label="Your briefing review">
      <h3>Your review</h3>
      {(acceptedId || recorded) && (
        <div className="action-success" role="status">
          Your review is recorded.{recorded && ` ${recorded.actor.name} · ${missionTime(recorded.recordedAt)}`}
        </div>
      )}
      {lapsed && (
        <Notice tone="attention" title="This briefing has lapsed">
          <span data-testid="acknowledgement-briefing-lapsed">{briefingStandingWords(standing)}</span>
          {!recorded && !acceptedId && member && ' It can no longer be acknowledged.'}
        </Notice>
      )}
      {failure && (
        <Notice
          tone={failure.uncertain || failure.conflict ? 'attention' : 'alert'}
          title={
            failure.uncertain
              ? 'Confirm the recorded result'
              : failure.conflict
                ? 'The reviewed acknowledgement basis changed'
                : 'Review was not recorded'
          }
        >
          {failure.text}
          {failure.uncertain && (
            <>
              <p>The result is unknown. Retry your identical acknowledgement to recover its recorded result.</p>
              <Button disabled={busy} onClick={() => attempt.current && void send(attempt.current.command)}>
                Retry same action
              </Button>
            </>
          )}
        </Notice>
      )}
      {!member && (
        <p className="muted">
          You are not a named recipient of this briefing. Only each named person can acknowledge their own review.
        </p>
      )}
      {member && !hasAuthority && !acceptedId && !recorded && (
        <p className="muted">
          You are a named recipient. Your current role needs personal briefing acknowledgement authority to record your
          review.
        </p>
      )}
      {member && hasAuthority && !matching && !uncertain && (
        <Notice title="Review status unavailable">
          The current acknowledgement status could not be matched to this exact briefing.
          <Button kind="next" disabled={locked} onClick={() => void refreshStatus()}>
            {refreshing ? 'Refreshing…' : 'Refresh review status'}
          </Button>
        </Notice>
      )}
      {awaitingExisting && !recorded && (
        <Notice title="Your review is already recorded">
          Refresh the status to read your retained acknowledgement.
          <Button kind="quiet" disabled={locked} onClick={() => void refreshStatus()}>
            {refreshing ? 'Refreshing…' : 'Refresh review status'}
          </Button>
        </Notice>
      )}
      {member && hasAuthority && !acceptedId && !recorded && !awaitingExisting && !lapsed && (
        <form
          className="action-form acknowledgement-form briefing-acknowledgement-form"
          data-testid="briefing-acknowledgement-form"
          onSubmit={(event) => void submit(event)}
        >
          <p>
            Record your own review of this exact retained briefing, as {principal.name}.
            {listed > 1 && ' One acknowledgement covers every control the briefing lists.'}
          </p>
          {(stale || refreshRequired) && (
            <div className="draft-basis is-stale">
              <span>The exact briefing or your authority changed. Refresh, then confirm your review again.</span>
              <Button kind="next" type="button" disabled={locked} onClick={() => void refreshStatus()}>
                {refreshing ? 'Refreshing…' : 'Refresh basis'}
              </Button>
            </div>
          )}
          <label className="briefing-attestation" htmlFor={confirmationId}>
            <input
              id={confirmationId}
              type="checkbox"
              checked={Boolean(confirmation)}
              disabled={locked || !matching || refreshRequired}
              onChange={(event) => confirm(event.target.checked)}
            />
            {listed > 1
              ? `I reviewed this exact briefing and each of the ${listed} controls it lists`
              : 'I reviewed this exact briefing'}
          </label>
          <details className="briefing-provenance">
            <summary>Exact briefing and personal review basis</summary>
            <pre>
              {json({
                briefing: { id: exact.briefing.id, digest: exact.digest },
                populationDigest: exact.briefing.population.digest,
                principalId: principal.id,
                expectedPrincipalRevision: confirmation?.command.expectedPrincipalRevision ?? principal.revision,
                attestation: 'reviewed_exact_briefing',
              })}
            </pre>
          </details>
          <Button
            kind="primary"
            type="submit"
            disabled={locked || stale || refreshRequired || !matching || !confirmation}
          >
            {busy ? <Spinner label="Recording your review" /> : 'Acknowledge my review'}
          </Button>
        </form>
      )}
    </section>
  );
}

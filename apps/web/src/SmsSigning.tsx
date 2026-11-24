import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  RiskAcceptance,
  AssuranceBody,
  Command,
  DocumentSource,
  SigningMeaning,
  LocalReauthenticationResponse,
  RiskMatrixBody,
  SmsAssessedControl,
  SmsRecordDetailResponse,
  SmsSigningPreviewResponse,
} from '@ledger/contracts';
import { REAUTHENTICATION_HEADER } from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { json, time, timeZoneLabel } from './format.js';
import { acceptanceLabels, plainError } from './sms-labels.js';
import { FailureNotice, useCommand } from './SmsForms.js';
import { documentTime } from './sms-document-dates.js';
import { MatrixDefinitions, MatrixGrid } from './SmsMatrixGrid.js';
import type { ConfirmIdentity } from './SmsApp.js';

interface AdoptionStatement {
  title: string;
  versionNumber: number;
  document?: {
    type: string;
    revision: string;
    summary: string;
    text?: string;
    origin?: 'authored' | 'received';
    source?: DocumentSource;
    changeReason?: string;
    review?: { id: string; by: string; at: string; note: string };
  };
  matrix?: {
    name: string;
    severities: string[];
    likelihoods: string[];
    levels: { label: string; meaning: string; acceptance: RiskAcceptance }[];
  };
  /** A safety assurance record: its type's title and the body signed. */
  assurance?: AssuranceBody & { type: string };
  attachments: { label: string; sha256: string; confidentiality: string }[];
}

interface Statement {
  hazard: { title: string; description: string; consequence: string };
  matrix: { name: string; versionNumber: number };
  initialRisk: { severity: string; likelihood: string; level: string };
  residualRisk: { severity: string; likelihood: string; level: string };
  controls: SmsAssessedControl[];
  newHazardCheck: { answer: string; note?: string };
  assessedBy: string;
  assessedAt: string;
}

export function SigningFlow({
  client,
  detail,
  meaning,
  confirmIdentity,
  onRead,
  onCancel,
  onSigned,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  meaning: SigningMeaning;
  confirmIdentity?: ConfirmIdentity;
  onRead?: () => void;
  onCancel: () => void;
  onSigned: () => void;
}) {
  const [preview, setPreview] = useState<SmsSigningPreviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState('');
  const [credential, setCredential] = useState('');
  const [grant, setGrant] = useState<LocalReauthenticationResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const command = useCommand(client);
  // When the person last signed in again at the identity provider, for a signature outside local development.
  const [signedInAgainAt, setSignedInAgainAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    setPreview(null);
    setReviewed(false);
    setLoadError(null);
    try {
      setPreview(
        await client.request<SmsSigningPreviewResponse>(
          `/v1/sms/records/${encodeURIComponent(detail.record.id)}/signing?meaning=${meaning}`,
        ),
      );
    } catch (error) {
      setLoadError(plainError(error).message);
    }
  }, [client, detail.record.id, meaning]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!preview)
    return (
      <div className="thread-main">
        {loadError ? (
          <Notice tone="alert" title="Signing content unavailable">
            {loadError}
          </Notice>
        ) : (
          <Spinner label="Preparing the exact content to sign" />
        )}
      </div>
    );
  const changed = detail.basis.revision !== preview.basis.revision;
  const accepting = meaning === 'risk.accept';
  const assurance = meaning === 'assurance.sign';
  const statement = accepting ? (preview.content?.statement as unknown as Statement | undefined) : undefined;
  const adoption = accepting ? undefined : (preview.content?.statement as unknown as AdoptionStatement | undefined);
  const assessment = detail.decisions.find((decision) => decision.kind === 'risk.assess');
  const local = preview.reauthentication === 'local_fixture';
  const retryUnknown = command.unknownResult;
  const signingPending = command.pending;
  const confirmed = local ? Boolean(grant) : Boolean(signedInAgainAt);

  async function confirmAtProvider() {
    if (!confirmIdentity) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      setSignedInAgainAt((await confirmIdentity()).authenticatedAt);
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : 'Not confirmed');
    } finally {
      setConfirming(false);
    }
  }
  async function confirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      setGrant(
        await client.request<LocalReauthenticationResponse>('/v1/local/reauthentications', {
          method: 'POST',
          body: JSON.stringify({ credential }),
        }),
      );
      setCredential('');
    } catch (error) {
      setConfirmError(plainError(error).message);
    } finally {
      setConfirming(false);
    }
  }
  async function sign(event: FormEvent) {
    event.preventDefault();
    if (command.unknownResult) {
      const retried = await command.retry();
      if (retried?.command) onSigned();
      return;
    }
    if (!preview?.contentDigest || !preview.intent || (accepting && !assessment)) return;
    const signature = { intent: preview.intent, contentDigest: preview.contentDigest, reviewed: true as const };
    const body: Command = {
      kind: 'decision.record',
      subject: { kind: 'sms', id: detail.record.id },
      expectedRevision: preview.basis.revision,
      expectedDependencyBasis: preview.basis.dependencyBasis,
      decision:
        meaning === 'risk.accept'
          ? { kind: 'risk.accept', note: note.trim(), assessmentId: assessment!.id, signature }
          : { kind: meaning, note: note.trim(), versionNumber: detail.record.versionNumber, signature },
    };
    const result = await command.submit(body, grant ? { [REAUTHENTICATION_HEADER]: grant.grant } : {});
    if (!local && !result?.command) setSignedInAgainAt(null);
    if (result?.command) onSigned();
  }

  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main" data-testid="sms-signing">
        <nav className="sms-record-nav">
          <Button kind="quiet" onClick={onCancel}>
            <span aria-hidden="true">←</span> Return to the record without signing
          </Button>
        </nav>
        <p className="thread-crumbs">
          Safety /{' '}
          {accepting
            ? 'Hazard record / Sign risk acceptance'
            : assurance
              ? 'Safety assurance / Sign the record'
              : 'Documents / Sign adoption'}
        </p>
        <div className="thread-title">
          <h2>
            {accepting ? 'Sign risk acceptance' : assurance ? 'Sign the safety assurance record' : 'Sign adoption'}
          </h2>
          <Badge tone="advisory">Exact content</Badge>
        </div>
        {!preview.available && (
          <Notice
            title={
              accepting
                ? 'You cannot sign this acceptance'
                : assurance
                  ? 'You cannot sign this record'
                  : 'You cannot sign this adoption'
            }
          >
            {preview.reason}
          </Notice>
        )}
        {adoption && (
          <AdoptionContent
            statement={adoption}
            matrix={detail.record.kind === 'risk_matrix' ? (detail.current.body as RiskMatrixBody) : undefined}
            onRead={onRead}
          />
        )}
        {changed && !retryUnknown && (
          <Notice title="The record changed after you opened this">
            Reload the content and review it again before signing.{' '}
            <Button kind="quiet" disabled={signingPending} onClick={() => void load()}>
              Reload content
            </Button>
          </Notice>
        )}
        {statement && (
          <>
            <p className="safety-intro">
              Your signature binds to exactly what is shown here. If anything changes before you sign, Ledger refuses
              the signature and asks you to review again.
            </p>
            <section className="safety-section">
              <h3>{statement.hazard.title}</h3>
              <p className="safety-narrative">{statement.hazard.description}</p>
              <dl className="safety-facts">
                <div>
                  <dt>Worst credible outcome</dt>
                  <dd>{statement.hazard.consequence}</dd>
                </div>
                <div>
                  <dt>Matrix</dt>
                  <dd>
                    {statement.matrix.name}, version {statement.matrix.versionNumber}
                  </dd>
                </div>
                <div>
                  <dt>Initial risk</dt>
                  <dd>
                    <strong>{statement.initialRisk.level}</strong> · {statement.initialRisk.severity} ·{' '}
                    {statement.initialRisk.likelihood}
                  </dd>
                </div>
                <div>
                  <dt>Predicted residual risk</dt>
                  <dd>
                    <strong>{statement.residualRisk.level}</strong> · {statement.residualRisk.severity} ·{' '}
                    {statement.residualRisk.likelihood}
                  </dd>
                </div>
                <div>
                  <dt>Assessed by</dt>
                  <dd>
                    {statement.assessedBy} · {time(statement.assessedAt, true)} {timeZoneLabel()}
                  </dd>
                </div>
              </dl>
              <h4 className="sms-subhead">Controls you are accepting the risk with</h4>
              {statement.controls.length === 0 ? (
                <p className="muted">No additional controls.</p>
              ) : (
                <ul className="sms-control-list">
                  {statement.controls.map((control, index) => (
                    <li key={index}>
                      <Badge>{control.type}</Badge> {control.description}
                    </li>
                  ))}
                </ul>
              )}
              <p>
                <span className="muted">New hazards from these controls: </span>
                {statement.newHazardCheck.answer === 'none_identified'
                  ? 'Checked; none identified.'
                  : `May introduce new hazards. ${statement.newHazardCheck.note ?? ''}`}
              </p>
            </section>
          </>
        )}
        {preview.content && (
          <>
            <section className="safety-section">
              <h3>Intent statement</h3>
              <blockquote className="sms-intent" data-testid="sms-intent">
                {preview.intent}
              </blockquote>
              <details className="safety-history">
                <summary>Exact signed content and digest</summary>
                <p className="mono">SHA-256 {preview.contentDigest}</p>
                <pre>{json(preview.content)}</pre>
              </details>
            </section>
          </>
        )}
      </div>
      <aside className="rail safety-rail" aria-label="Signing steps">
        <form className="action-form safety-form" onSubmit={(event) => void sign(event)} aria-label="Sign">
          <h3>Sign</h3>
          <label className="sms-check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
              disabled={!preview.available || changed}
            />
            I have reviewed the content and the intent statement.
          </label>
          <label htmlFor="acceptance-note">{accepting ? 'Rationale for accepting' : 'Rationale for adopting'}</label>
          <textarea
            id="acceptance-note"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            required
            readOnly={retryUnknown}
          />
          <span className="safety-stage-label">Confirm it’s you</span>
          {local ? (
            grant ? (
              <p className="safety-form-note">
                Confirmed. Sign within five minutes, before {time(grant.expiresAt)} {timeZoneLabel()}. The confirmation
                works once.
              </p>
            ) : (
              <>
                <p className="safety-form-note">
                  Local development uses fixture identities. Re-enter your fixture credential; production asks you to
                  re-verify your sign-in instead.
                </p>
                <label htmlFor="fixture-credential">Fixture credential</label>
                <input
                  id="fixture-credential"
                  type="password"
                  autoComplete="off"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                />
                {confirmError && (
                  <Notice tone="alert" title="Not confirmed">
                    {confirmError}
                  </Notice>
                )}
                <Button type="button" kind="next" disabled={!credential || confirming} onClick={() => void confirm()}>
                  {confirming ? 'Confirming…' : 'Confirm it’s you'}
                </Button>
              </>
            )
          ) : signedInAgainAt ? (
            <p className="safety-form-note">
              You signed in again at {time(signedInAgainAt)} {timeZoneLabel()}. Sign within five minutes of that.
            </p>
          ) : (
            <>
              <p className="safety-form-note">
                Sign in again with your identity provider to confirm it is you. It opens in a separate window; this page
                keeps what you entered.
              </p>
              {confirmError && (
                <Notice tone="alert" title="Not confirmed">
                  {confirmError}
                </Notice>
              )}
              <Button
                type="button"
                kind="next"
                disabled={!confirmIdentity || confirming}
                onClick={() => void confirmAtProvider()}
              >
                {confirming ? 'Waiting for your sign-in…' : 'Confirm it’s you'}
              </Button>
            </>
          )}
          <FailureNotice failure={command.failure} />
          <Button
            kind="primary"
            type="submit"
            disabled={signingPending || (!retryUnknown && (!preview.available || changed || !reviewed || !confirmed))}
          >
            {signingPending
              ? 'Signing…'
              : retryUnknown
                ? 'Retry exact signing request'
                : accepting
                  ? 'Sign and accept risk'
                  : assurance
                    ? 'Sign the record'
                    : 'Sign and adopt'}
          </Button>
          {!reviewed && preview.available && <small className="rail-muted">Review the content first.</small>}
          {reviewed && !confirmed && <small className="rail-muted">Confirm it’s you first.</small>}
        </form>
      </aside>
    </div>
  );
}

function AdoptionContent({
  statement,
  matrix,
  onRead,
}: {
  statement: AdoptionStatement;
  /** The matrix version being signed, shown whole: every cell and the level it needs. */
  matrix?: RiskMatrixBody;
  onRead?: () => void;
}) {
  const readable = Boolean(onRead && statement.document && (statement.attachments.length || statement.document.text));
  return (
    <>
      <p className="safety-intro">
        {statement.assurance
          ? 'Your signature signs exactly this version and the files listed below as your organization’s record of it, and sets the actions it lists. A later version needs its own signature; this one stays with this version.'
          : 'Your signature adopts exactly this version and the files listed below. A later revision needs its own signature; this one stays with this version.'}
      </p>
      <section className="safety-section">
        <div className="safety-section-heading">
          <h3>{statement.title}</h3>
          {readable && (
            <Button kind="next" onClick={onRead}>
              Read {statement.document!.revision}
            </Button>
          )}
        </div>
        {statement.document && (
          <>
            <p className="muted">
              {statement.document.type[0].toUpperCase() + statement.document.type.slice(1)} ·{' '}
              {statement.document.revision}
            </p>
            <p className="safety-narrative">{statement.document.summary}</p>
            <dl className="safety-facts">
              {statement.document.changeReason && (
                <div>
                  <dt>{statement.document.origin === 'received' ? 'Why we are adopting it' : 'Reason for revision'}</dt>
                  <dd>{statement.document.changeReason}</dd>
                </div>
              )}
              {statement.document.origin && (
                <div>
                  <dt>Origin</dt>
                  <dd>
                    {statement.document.origin === 'received'
                      ? 'Received document · adopting for our organization'
                      : 'Authored by our organization'}
                  </dd>
                </div>
              )}
              {statement.document.source && (
                <>
                  <div>
                    <dt>Source organization</dt>
                    <dd>{statement.document.source.organization}</dd>
                  </div>
                  <div>
                    <dt>Source revision</dt>
                    <dd>{statement.document.source.revision}</dd>
                  </div>
                  {statement.document.source.reference && (
                    <div>
                      <dt>Source reference</dt>
                      <dd>{statement.document.source.reference}</dd>
                    </div>
                  )}
                  {statement.document.source.issuedAt && (
                    <div>
                      <dt>Source issued</dt>
                      <dd>{documentTime(statement.document.source.issuedAt)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Received</dt>
                    <dd>{documentTime(statement.document.source.receivedAt)}</dd>
                  </div>
                </>
              )}
              {statement.document.review && (
                <>
                  <div>
                    <dt>Reviewed by</dt>
                    <dd>
                      {statement.document.review.by} · {documentTime(statement.document.review.at)}
                    </dd>
                  </div>
                  <div>
                    <dt>Review note</dt>
                    <dd>{statement.document.review.note}</dd>
                  </div>
                </>
              )}
            </dl>
            {statement.document.text && <div className="sms-document-text">{statement.document.text}</div>}
          </>
        )}
        {statement.assurance && <AssuranceStatement body={statement.assurance} />}
        {statement.matrix && !matrix && (
          <dl className="safety-facts">
            <div>
              <dt>Severity, least to most</dt>
              <dd>{statement.matrix.severities.join(' · ')}</dd>
            </div>
            <div>
              <dt>Likelihood, least to most</dt>
              <dd>{statement.matrix.likelihoods.join(' · ')}</dd>
            </div>
            {statement.matrix.levels.map((level) => (
              <div key={level.label}>
                <dt>{level.label}</dt>
                <dd>
                  {level.meaning} {acceptanceLabels[level.acceptance]}
                  {level.acceptance === 'not_acceptable' ? ' a risk at this level.' : ' may accept it.'}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {matrix && (
          <>
            <MatrixGrid matrix={matrix} />
            <MatrixDefinitions matrix={matrix} />
          </>
        )}
        <h4 className="sms-subhead">{statement.assurance ? 'Files you are signing' : 'Files you are adopting'}</h4>
        {statement.attachments.length === 0 ? (
          <p className="muted">No attached files. The text above is the content.</p>
        ) : (
          <ul className="sms-control-list">
            {statement.attachments.map((attachment) => (
              <li key={attachment.sha256}>
                {attachment.label} <span className="mono muted">SHA-256 {attachment.sha256.slice(0, 16)}…</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AssuranceStatement({ body }: { body: AssuranceBody & { type: string } }) {
  return (
    <>
      <p className="muted">
        {body.type} · performed {body.completedOn ? `${body.performedOn} to ${body.completedOn}` : body.performedOn}
      </p>
      <dl className="safety-facts">
        <div>
          <dt>What it covered</dt>
          <dd>{body.scope}</dd>
        </div>
        <div>
          <dt>What it looked at</dt>
          <dd>{body.examined}</dd>
        </div>
      </dl>
      <h4 className="sms-subhead">What it found</h4>
      {body.findings.length === 0 ? (
        <p className="muted">No findings.</p>
      ) : (
        <ul className="sms-control-list">
          {body.findings.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.id}</strong> {finding.text}
            </li>
          ))}
        </ul>
      )}
      <h4 className="sms-subhead">Actions your signature sets</h4>
      {body.actions.length === 0 ? (
        <p className="muted">No actions.</p>
      ) : (
        <ul className="sms-control-list">
          {body.actions.map((action) => (
            <li key={action.id}>
              <strong>{action.id}</strong> {action.what} <span className="muted">· due {action.dueOn}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import { readsOnly } from '@ledger/contracts';
import type {
  AssessedPosition,
  DocumentBody,
  HazardBody,
  Principal,
  RiskMatrixBody,
  SmsAssessmentOutcome,
  SmsStatusOutcome,
  SmsCurrentLink,
  SmsDecisionRecord,
  SmsHomeResponse,
  SmsLinkedRecord,
  SmsRecordDetailResponse,
  SmsRecordKind,
  SmsSignatureRecord,
  SigningMeaning,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { byteSize, json, time, timeZoneLabel } from './format.js';
import { documentTime } from './sms-document-dates.js';
import {
  confidentialityLabels,
  documentTypeLabels,
  dueLabel,
  levelName,
  levelTone,
  linkedFromLabels,
  linkRelationLabels,
  plainError,
  recordClassLabels,
  recordKindLabels,
  saveBytes,
  statusPresentation,
} from './sms-labels.js';
import { ExportReady, useSmsExport } from './SmsExport.js';
import { AssessmentForm, AttachmentForm, LinkForm, linkTargetLabel, ReviseForm, StatusForm } from './SmsForms.js';
import { SigningFlow } from './SmsSigning.js';
import { MatrixDefinitions, MatrixGrid } from './SmsMatrixGrid.js';
import { seededOrganization } from './labels.js';
import { RiskMatrixForm } from './RiskMatrixForm.js';
import { ReportSections } from './SmsReports.js';
import { ControlForm, ControlSections, HazardControlsSection } from './SmsControls.js';
import { ControlDemoSection } from './AvoidanceDemoPanel.js';
// Control types with their own editors register them on import.
import './AvoidanceAreaEditor.js';
import { SmsDocumentRail, type DocumentForm } from './SmsDocumentControl.js';
import { DocumentIdentity, SmsDocumentRecord } from './SmsDocumentRecord.js';
import type { ConfirmIdentity } from './SmsApp.js';
import { HazardOriginSection, useOriginFlight } from './SmsHazardOrigin.js';
import { AssuranceForm, AssuranceNextStep, AssuranceSections } from './SmsAssurance.js';
import type { FlightFinding, FlightLinks } from './safety-navigation.js';
import type { ReaderSource } from './SmsDocumentReader.js';

const SmsDocumentReader = lazy(() => import('./SmsDocumentReader.js'));

const registerLabel: Record<SmsRecordKind, string> = {
  hazard: 'Hazard register',
  document: 'Documents',
  risk_matrix: 'Documents',
  report: 'Reports',
  control: 'Hazard register',
  assurance: 'Safety assurance',
};
const recordLabel: Record<SmsRecordKind, string> = {
  hazard: 'Hazard record',
  document: 'Document',
  risk_matrix: 'Risk matrix',
  report: 'Safety report',
  control: 'Control',
  assurance: 'Safety assurance record',
};
type RailForm = 'assess' | 'control' | DocumentForm | null;

export function SmsRecordView({
  id,
  client,
  principal,
  home,
  startSigning,
  startIssueId,
  startReading = false,
  confirmIdentity,
  from,
  flights,
  onBack,
  onOpen,
  onChanged,
}: {
  id: string;
  client: LedgerClient;
  principal: Principal;
  home: SmsHomeResponse;
  startSigning: boolean;
  startIssueId?: string;
  startReading?: boolean;
  confirmIdentity?: ConfirmIdentity;
  /** The flight finding this page was opened from, for the way back. */
  from?: FlightFinding;
  flights?: FlightLinks;
  onBack: (kind: SmsRecordKind) => void;
  onOpen: (record: SmsLinkedRecord) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<SmsRecordDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState<SigningMeaning | 'pending' | null>(startSigning ? 'pending' : null);
  const [form, setForm] = useState<RailForm>(null);
  const [reload, setReload] = useState(0);
  const [reading, setReading] = useState<ReaderSource | null>(
    startReading && startIssueId ? { issueId: startIssueId } : null,
  );
  const refresh = useCallback(() => {
    setReload((value) => value + 1);
    onChanged();
  }, [onChanged]);
  const toggle = (next: RailForm) => setForm(form === next ? null : next);
  // Closes the form that recorded, and only that one: a slow answer must not close a form opened since.
  const recorded = () => {
    setForm((current) => (current === form ? null : current));
    refresh();
  };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const shown = await client.request<SmsRecordDetailResponse>(`/v1/sms/records/${encodeURIComponent(id)}`);
        if (stopped) return;
        setDetail(shown);
        setError(null);
      } catch (failure) {
        if (!stopped) setError(plainError(failure).message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, id, reload]);

  const originFlight = useOriginFlight(client, principal, detail, from);

  if (!detail)
    return (
      <div className="thread-main">
        {error ? (
          <Notice tone="alert" title="Record unavailable">
            {error}
          </Notice>
        ) : (
          <Spinner label="Loading the record" />
        )}
      </div>
    );
  const record = detail.record;
  const meaning = signingMeaning(record.kind);
  const reader = reading && (
    <Suspense fallback={<Spinner label="Opening document reader" />}>
      <SmsDocumentReader
        key={'issueId' in reading ? reading.issueId : 'working'}
        client={client}
        detail={detail}
        source={reading}
        principal={principal}
        onRecorded={refresh}
        onClose={() => setReading(null)}
        onSign={() => {
          setReading(null);
          setSigning(meaning);
        }}
        onReview={() => {
          setReading(null);
          setForm('review');
        }}
      />
    </Suspense>
  );
  if (signing)
    return (
      <>
        {reader}
        <SigningFlow
          client={client}
          detail={detail}
          meaning={signing === 'pending' ? meaning : signing}
          confirmIdentity={confirmIdentity}
          onRead={record.kind === 'document' ? () => setReading({ working: true }) : undefined}
          onCancel={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            refresh();
          }}
        />
      </>
    );
  const status = statusPresentation(record.status);
  const isDocument = record.kind === 'document';
  const effectiveIssue = isDocument ? detail.documentControl?.effectiveIssue : undefined;
  const due = dueLabel(record);
  const readOnlyDocument =
    record.kind === 'document' &&
    !principal.capabilities.includes('sms:write') &&
    !principal.capabilities.includes('sms:adopt');
  return (
    <>
      {reader}
      <div className="thread-layout safety-layout">
        <div className="thread-main safety-main" data-testid="sms-record">
          <nav className="sms-record-nav">
            <Button kind="quiet" onClick={() => onBack(record.kind)}>
              <span aria-hidden="true">←</span> {registerLabel[record.kind]}
            </Button>
          </nav>
          <p className="thread-crumbs">
            Safety / {registerLabel[record.kind]} / {recordLabel[record.kind]}
          </p>
          <div className="thread-title">
            <h2>{effectiveIssue?.title ?? record.title}</h2>
            {!isDocument && (
              <Badge tone={status.tone}>
                {record.kind === 'assurance' && record.status === 'draft' ? 'Draft, not signed' : status.label}
              </Badge>
            )}
            {record.residual && record.status !== 'closed' && (
              <Badge tone={levelTone(record.residual.acceptance)}>
                {levelName(record.residual.level, detail.assessedMatrix?.body)} residual risk
                {record.residual.acceptance === 'not_acceptable' ? ', may not be accepted' : ''}
              </Badge>
            )}
          </div>
          <p className="thread-facts">
            {isDocument && <DocumentIdentity detail={detail} />}
            <span>
              Owner <strong>{record.owner.name}</strong>
            </span>
            {due && <span className={record.overdue ? 'sms-overdue' : undefined}>{due}</span>}
            {!isDocument && (
              <>
                <span>
                  Opened{' '}
                  <b className="mono">
                    {time(record.openedAt, true)} {timeZoneLabel()}
                  </b>{' '}
                  by {detail.versions[detail.versions.length - 1].recordedBy.name}
                </span>
                <span>Version {record.versionNumber}</span>
              </>
            )}
          </p>
          {error && (
            <Notice tone="alert" title="Updates interrupted">
              {error} Showing the last record received.
            </Notice>
          )}
          {record.kind === 'hazard' ? (
            <>
              <HazardOriginSection
                client={client}
                detail={detail}
                flight={originFlight}
                flights={flights}
                onOpen={onOpen}
              />
              <HazardSections detail={detail} />
              <HazardControlsSection detail={detail} onOpen={onOpen} />
            </>
          ) : record.kind === 'control' ? (
            <>
              <ControlSections client={client} detail={detail} onOpen={onOpen} />
              {/* The simulated demonstration flights belong to the fictional organizations only. */}
              {flights && principal.capabilities.includes('flight:read') && seededOrganization(principal.tenantId) && (
                <ControlDemoSection
                  client={client}
                  principal={principal}
                  detail={detail}
                  onReviewMission={flights.onDemoMission}
                />
              )}
            </>
          ) : isDocument ? (
            <SmsDocumentRecord
              client={client}
              detail={detail}
              principal={principal}
              startIssueId={startIssueId}
              showReaders={Boolean(startIssueId) && !startReading}
              reviewing={form === 'review'}
              onCancelReview={() => setForm(null)}
              onRead={(issueId) => setReading({ issueId })}
              onReadWorking={() => setReading({ working: true })}
              onRecorded={recorded}
            />
          ) : record.kind === 'report' ? (
            <ReportSections key={record.revision} client={client} detail={detail} />
          ) : record.kind === 'assurance' ? (
            <>
              {form === 'edit' && (
                <AssuranceForm
                  client={client}
                  home={home}
                  principal={principal}
                  revising={detail}
                  onRecorded={recorded}
                  onCancel={() => setForm(null)}
                />
              )}
              <AssuranceSections
                key={record.revision}
                client={client}
                detail={detail}
                home={home}
                principal={principal}
                onOpen={onOpen}
                onRecorded={refresh}
              />
            </>
          ) : (
            <>
              {form === 'edit' && (
                <RiskMatrixForm
                  client={client}
                  principal={principal}
                  start={detail.current.body as RiskMatrixBody}
                  revising={detail}
                  onRecorded={recorded}
                  onCancel={() => setForm(null)}
                />
              )}
              <DocumentSections detail={detail} />
            </>
          )}
          <LinkSection detail={detail} onOpen={onOpen} />
          <AttachmentSection client={client} detail={detail} />
          <HistorySection detail={detail} />
          <details className="safety-retained-basis">
            <summary>Identifiers, digests and raw record</summary>
            <pre>{json({ id: record.id, basis: detail.basis, current: detail.current, record })}</pre>
          </details>
        </div>
        <aside className="rail safety-rail" aria-label="Record actions">
          {isDocument && !readOnlyDocument && (
            <SmsDocumentRail
              client={client}
              detail={detail}
              principal={principal}
              home={home}
              form={form === 'assess' || form === 'control' ? null : form}
              onToggle={toggle}
              onSign={() => setSigning(meaning)}
              onRecorded={recorded}
            />
          )}
          {/* A person who only reads is offered no action they could not take. */}
          {!isDocument && !readsOnly(principal.capabilities) && (
            <>
              {record.kind === 'hazard' ? (
                <HazardNextStep
                  detail={detail}
                  form={form}
                  onToggle={toggle}
                  onSign={() => setSigning('risk.accept')}
                />
              ) : record.kind === 'assurance' ? (
                <AssuranceNextStep detail={detail} onSign={() => setSigning(meaning)} />
              ) : (
                record.kind === 'risk_matrix' && <AdoptionNextStep detail={detail} onSign={() => setSigning(meaning)} />
              )}
              {form === 'assess' && detail.matrix && (
                <AssessmentForm client={client} detail={detail} onRecorded={recorded} />
              )}
              <section className="safety-next-action">
                <span className="safety-stage-label">Record</span>
                <div className="sms-rail-buttons">
                  {record.kind === 'hazard' && (
                    <RailButton
                      action={detail.actions.proposeControl}
                      label="Propose a control"
                      open={form === 'control'}
                      onClick={() => toggle('control')}
                    />
                  )}
                  {record.kind !== 'report' && (
                    <RailButton
                      action={detail.actions.revise}
                      label={editLabel[record.kind] ?? 'Record a new revision'}
                      open={form === 'edit'}
                      onClick={() => toggle('edit')}
                    />
                  )}
                  <RailButton
                    action={detail.actions.attach}
                    label="Attach a file"
                    open={form === 'attach'}
                    onClick={() => toggle('attach')}
                  />
                  <RailButton
                    action={detail.actions.link}
                    label="Change links"
                    open={form === 'links'}
                    onClick={() => toggle('links')}
                  />
                  {record.status === 'closed' ? (
                    <RailButton
                      action={detail.actions.reopen}
                      label="Reopen"
                      open={form === 'reopen'}
                      onClick={() => toggle('reopen')}
                    />
                  ) : (
                    record.kind !== 'risk_matrix' &&
                    record.kind !== 'assurance' && (
                      <RailButton
                        action={detail.actions.close}
                        label={closeLabel[record.kind] ?? 'Close hazard'}
                        open={form === 'close'}
                        onClick={() => toggle('close')}
                      />
                    )
                  )}
                </div>
                {[detail.actions.revise, detail.actions.attach, detail.actions.link].find((action) => !action.available)
                  ?.reason && (
                  <p className="rail-muted">
                    {
                      [detail.actions.revise, detail.actions.attach, detail.actions.link].find(
                        (action) => !action.available,
                      )!.reason
                    }
                  </p>
                )}
              </section>
              {form === 'control' && (
                <ControlForm
                  client={client}
                  detail={detail}
                  home={home}
                  context={{
                    client,
                    ...(originFlight?.evaluation
                      ? { flightId: originFlight.flightId, evaluation: originFlight.evaluation }
                      : {}),
                  }}
                  onRecorded={recorded}
                />
              )}
              {form === 'edit' &&
                (record.kind === 'control' ? (
                  <ControlForm client={client} detail={detail} home={home} onRecorded={recorded} />
                ) : (
                  record.kind === 'hazard' && (
                    <ReviseForm client={client} detail={detail} home={home} onRecorded={recorded} />
                  )
                ))}
              {form === 'attach' && <AttachmentForm client={client} detail={detail} onRecorded={recorded} />}
              {form === 'links' && <LinkForm client={client} detail={detail} onRecorded={recorded} />}
              {(form === 'close' || form === 'reopen') && (
                <StatusForm client={client} detail={detail} closing={form === 'close'} onRecorded={recorded} />
              )}
            </>
          )}
          {!readsOnly(principal.capabilities) && (
            <ExportCard client={client} detail={detail} principal={principal} home={home} />
          )}
        </aside>
      </div>
    </>
  );
}

const hazardSourceLabels: Record<HazardBody['source']['kind'], string> = {
  manual_identification: 'Manual identification',
  report: 'Safety report',
  change: 'Change',
  investigation: 'Investigation',
  audit: 'Audit',
  external_notice: 'External notice',
  flight_finding: 'Flight finding',
  finding: 'Finding',
  assurance: 'Safety assurance record',
};

const editLabel: Partial<Record<SmsRecordKind, string>> = {
  hazard: 'Edit hazard',
  control: 'Edit control',
  risk_matrix: 'Revise the matrix',
  assurance: 'Record a new version',
};
const closeLabel: Partial<Record<SmsRecordKind, string>> = { control: 'Withdraw control', report: 'Close report' };

function signingMeaning(kind: SmsRecordKind): SigningMeaning {
  if (kind === 'assurance') return 'assurance.sign';
  return kind === 'hazard' ? 'risk.accept' : kind === 'risk_matrix' ? 'matrix.adopt' : 'document.adopt';
}

function RailButton({
  action,
  label,
  open,
  onClick,
}: {
  action: { available: boolean; reason?: string };
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Button aria-expanded={open} disabled={!action.available} title={action.reason} onClick={onClick}>
      {label}
    </Button>
  );
}

function HazardNextStep({
  detail,
  form,
  onToggle,
  onSign,
}: {
  detail: SmsRecordDetailResponse;
  form: RailForm;
  onToggle: (form: RailForm) => void;
  onSign: () => void;
}) {
  const status = detail.record.status;
  return (
    <section className="safety-next-action">
      <span className="safety-stage-label">Next step</span>
      {['identified', 'needs_reassessment'].includes(status) && (
        <>
          <p>Assess the initial risk, the proposed controls and the predicted residual risk.</p>
          {detail.actions.assess.available ? (
            <Button kind="next" aria-expanded={form === 'assess'} onClick={() => onToggle('assess')}>
              Assess risk
            </Button>
          ) : (
            <p className="rail-muted">{detail.actions.assess.reason}</p>
          )}
        </>
      )}
      {status === 'awaiting_acceptance' && (
        <>
          <p>The predicted residual risk needs acceptance by someone whose authority covers it.</p>
          {detail.actions.accept.available ? (
            <Button kind="next" onClick={onSign}>
              Review and sign acceptance
            </Button>
          ) : (
            <p className="rail-muted" data-testid="accept-unavailable">
              {detail.actions.accept.reason}
            </p>
          )}
        </>
      )}
      {status === 'accepted' && (
        <>
          <p>The residual risk is accepted. Reassess if the hazard, its controls or the matrix change.</p>
          {detail.actions.assess.available && (
            <Button kind="quiet" onClick={() => onToggle('assess')}>
              Reassess risk
            </Button>
          )}
        </>
      )}
      {status === 'closed' && <p>This hazard is closed. Its record and decisions stay as they were.</p>}
    </section>
  );
}

function AdoptionNextStep({ detail, onSign }: { detail: SmsRecordDetailResponse; onSign: () => void }) {
  const status = detail.record.status;
  return (
    <section className="safety-next-action">
      <span className="safety-stage-label">Next step</span>
      {status === 'draft' && (
        <>
          <p>Version {detail.record.versionNumber} is a draft until someone with adoption authority signs it.</p>
          {detail.actions.adopt.available ? (
            <Button kind="next" onClick={onSign}>
              Review and sign adoption
            </Button>
          ) : (
            <p className="rail-muted" data-testid="adopt-unavailable">
              {detail.actions.adopt.reason}
            </p>
          )}
        </>
      )}
      {status === 'adopted' && (
        <p>Version {detail.record.versionNumber} is adopted. A new revision needs a new signature.</p>
      )}
      {status === 'closed' && <p>This document is retired. Its revisions and signatures stay on record.</p>}
    </section>
  );
}

function HazardSections({ detail }: { detail: SmsRecordDetailResponse }) {
  const record = detail.record;
  const body = detail.current.body as HazardBody;
  const assessment = detail.decisions.find((decision) => decision.kind === 'risk.assess');
  const acceptance = detail.decisions.find((decision) => decision.kind === 'risk.accept');
  const signature = acceptance && detail.signatures.find((entry) => entry.decisionId === acceptance.id);
  const assessNext = ['identified', 'needs_reassessment'].includes(record.status);
  return (
    <>
      <ol className="safety-path" aria-label="Safety record progress">
        <li className="is-recorded">Identified</li>
        <li className={assessment && !assessNext ? 'is-recorded' : ''}>Assessed on the matrix</li>
        <li className={record.status === 'accepted' ? 'is-recorded' : ''}>Residual risk accepted</li>
      </ol>
      <section className="safety-section">
        <h3>Hazard</h3>
        <p className="safety-narrative">{body.description}</p>
        <dl className="safety-facts">
          <div>
            <dt>Worst credible outcome</dt>
            <dd>{body.consequence}</dd>
          </div>
          {body.operation && (
            <div>
              <dt>Operation or system</dt>
              <dd>{body.operation}</dd>
            </div>
          )}
          <div>
            <dt>Source</dt>
            <dd>{hazardSourceLabels[body.source.kind]}</dd>
          </div>
          <RecordClassFacts detail={detail} />
        </dl>
      </section>
      <AssessmentSection detail={detail} assessment={assessment} />
      <AcceptanceSection detail={detail} acceptance={acceptance} signature={signature} />
    </>
  );
}

function RecordClassFacts({ detail }: { detail: SmsRecordDetailResponse }) {
  return (
    <>
      <div>
        <dt>Record class</dt>
        <dd>{recordClassLabels[detail.record.recordClass]}</dd>
      </div>
      <div>
        <dt>Confidentiality</dt>
        <dd>{confidentialityLabels[detail.record.confidentiality]}</dd>
      </div>
    </>
  );
}

function DocumentSections({ detail }: { detail: SmsRecordDetailResponse }) {
  const adoptions = detail.decisions.filter(
    (decision) => decision.kind === 'matrix.adopt' || decision.kind === 'document.adopt',
  );
  const matrix = detail.record.kind === 'risk_matrix' ? (detail.current.body as RiskMatrixBody) : undefined;
  const document = detail.record.kind === 'document' ? (detail.current.body as DocumentBody) : undefined;
  return (
    <>
      <section className="safety-section">
        <h3>
          {document
            ? `${documentTypeLabels[document.documentType]} · ${document.revisionLabel ?? `version ${detail.record.versionNumber}`}`
            : `${matrix!.name} · version ${detail.record.versionNumber}`}
        </h3>
        {document && (
          <>
            <p className="safety-narrative">{document.summary}</p>
            {document.text && <div className="sms-document-text">{document.text}</div>}
          </>
        )}
        {matrix && (
          <>
            <MatrixGrid matrix={matrix} />
            <MatrixDefinitions matrix={matrix} />
          </>
        )}
        <dl className="safety-facts">
          <RecordClassFacts detail={detail} />
        </dl>
      </section>
      <section className="safety-section">
        <h3>Adoption</h3>
        {adoptions.length === 0 && <p className="muted">Not adopted yet.</p>}
        {adoptions.map((adoption) => {
          const signature = detail.signatures.find((entry) => entry.decisionId === adoption.id);
          const version = ((
            adoption.outcome as { document?: { versionNumber: number }; matrix?: { versionNumber: number } }
          ).document ?? (adoption.outcome as { matrix?: { versionNumber: number } }).matrix)!.versionNumber;
          const current = version === detail.record.versionNumber && detail.record.status === 'adopted';
          return (
            <div key={adoption.id} className="safety-history-entry" data-testid="sms-signature">
              <Badge tone={current ? 'planned' : 'neutral'}>
                {current ? `Version ${version} adopted` : `Version ${version} · superseded`}
              </Badge>
              {signature && <SignatureFacts signature={signature} note={adoption.note} />}
            </div>
          );
        })}
      </section>
    </>
  );
}

function SignatureFacts({ signature, note }: { signature: SmsSignatureRecord; note: string }) {
  return (
    <>
      <blockquote className="sms-intent">{signature.intent}</blockquote>
      <dl className="safety-facts">
        <div>
          <dt>Signed by</dt>
          <dd>{signature.signer.name}</dd>
        </div>
        <div>
          <dt>Signed · {timeZoneLabel()}</dt>
          <dd className="mono">{time(signature.signedAt, true)}</dd>
        </div>
        <div>
          <dt>Authority used</dt>
          <dd>{authorityUsed(signature.authority.satisfyingCapability)}</dd>
        </div>
        <div>
          <dt>Identity confirmed</dt>
          <dd>
            {signature.reauthentication.method === 'openid_connect'
              ? 'Signed in again with the identity provider'
              : 'Local fixture confirmation'}{' '}
            at <span className="mono">{time(signature.reauthentication.verifiedAt)}</span>
          </dd>
        </div>
      </dl>
      <p className="safety-narrative">
        <span className="muted">Rationale: </span>
        {note}
      </p>
      <details className="safety-history">
        <summary>Signed content and digest</summary>
        <p className="mono">SHA-256 {signature.contentDigest}</p>
        <pre>{json(signature.content)}</pre>
      </details>
    </>
  );
}

function authorityUsed(capability?: string): string {
  if (capability === 'sms:adopt') return 'Adopts SMS documentation';
  return capability ? `Accepts ${capability.replace('risk:accept:', '')} risk` : 'Recorded authority';
}

function LinkedRecordButton({
  record,
  onOpen,
}: {
  record: SmsLinkedRecord;
  onOpen: (record: SmsLinkedRecord) => void;
}) {
  return (
    <span>
      <button type="button" className="sms-link-open" onClick={() => onOpen(record)}>
        {record.title}
      </button>
      <small>
        {recordKindLabels[record.kind]} · {statusPresentation(record.status).label}
      </small>
    </span>
  );
}

function LinkSection({
  detail,
  onOpen,
}: {
  detail: SmsRecordDetailResponse;
  onOpen: (record: SmsLinkedRecord) => void;
}) {
  const restricted = detail.record.confidentiality !== 'ordinary';
  if (restricted && !detail.linkedFrom.length) return null;
  if (detail.record.kind === 'document' && !detail.links.length && !detail.linkedFrom.length) return null;
  return (
    <section className="safety-section">
      <h3>Links</h3>
      {!restricted &&
        (detail.links.length === 0 ? (
          <p className="muted">This record links to nothing yet.</p>
        ) : (
          <ul className="sms-links" data-testid="sms-links">
            {detail.links.map((link, index) => (
              <li key={index}>
                <span className="sms-link-relation">{linkRelationLabels[link.relation]}</span>
                {link.record ? (
                  <LinkedRecordButton record={link.record} onOpen={onOpen} />
                ) : (
                  <span>
                    <strong>{linkTargetLabel(link)}</strong>
                    <small>
                      {link.target.kind === 'external'
                        ? 'Outside Ledger'
                        : link.target.kind === 'finding' || link.target.kind === 'flight'
                          ? 'On the flight record'
                          : 'Not available'}
                    </small>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ))}
      {detail.linkedFrom.length > 0 && (
        <>
          <h4 className="sms-links-heading">Linked from other records</h4>
          <ul className="sms-links" data-testid="sms-linked-from">
            {detail.linkedFrom.map((link) => (
              <li key={`${link.relation}:${link.record.id}`}>
                <span className="sms-link-relation">{linkedFromLabels[link.relation]}</span>
                <LinkedRecordButton record={link.record} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function linkChangeLabel(change: SmsRecordDetailResponse['linkChanges'][number]): string {
  const describe = (link: SmsCurrentLink) =>
    `${linkRelationLabels[link.relation].toLowerCase()} “${linkTargetLabel(link)}”`;
  return [
    change.added.length ? `Linked: ${change.added.map(describe).join('; ')}` : '',
    change.removed.length ? `Removed link: ${change.removed.map(describe).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('. ');
}

function Position({ label, matrix, position }: { label: string; matrix: RiskMatrixBody; position: AssessedPosition }) {
  const severity = matrix.severities.find((entry) => entry.id === position.severity)?.label;
  const likelihood = matrix.likelihoods.find((entry) => entry.id === position.likelihood)?.label;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <Badge tone={levelTone(position.acceptance)}>{levelName(position.level, matrix)}</Badge> {severity} ·{' '}
        {likelihood}
        {position.acceptance === 'not_acceptable' ? ' · nobody may accept a risk at this level' : ''}
      </dd>
    </div>
  );
}

function AssessmentSection({
  detail,
  assessment,
}: {
  detail: SmsRecordDetailResponse;
  assessment?: SmsDecisionRecord;
}) {
  const matrix = detail.assessedMatrix;
  if (!assessment || !matrix)
    return (
      <section className="safety-section">
        <h3>Risk assessment</h3>
        <p className="muted">
          Not assessed yet.{' '}
          {detail.matrix ? `It will be assessed on ${detail.matrix.version.body.name}.` : 'No risk matrix is adopted.'}
        </p>
      </section>
    );
  const outcome = assessment.outcome as SmsAssessmentOutcome;
  const outdated = detail.record.status === 'needs_reassessment';
  return (
    <section className="safety-section">
      <div className="safety-section-heading">
        <h3>Risk assessment</h3>
        <span className="muted">
          {assessment.actor.name} · {time(assessment.recordedAt, true)} {timeZoneLabel()}
        </span>
      </div>
      {outdated && (
        <Notice title="Needs reassessment">
          The hazard or the adopted matrix changed after this assessment. It stays on record; a new assessment is needed
          before acceptance.
        </Notice>
      )}
      <dl className="safety-facts">
        <Position label="Initial risk" matrix={matrix.body} position={outcome.initial} />
        <Position label="Predicted residual risk" matrix={matrix.body} position={outcome.residual} />
        <div>
          <dt>Matrix</dt>
          <dd>
            {matrix.body.name}, version {matrix.versionNumber}
          </dd>
        </div>
      </dl>
      <MatrixGrid matrix={matrix.body} initial={outcome.initial} residual={outcome.residual} />
      <h4 className="sms-subhead">Proposed controls</h4>
      {outcome.controls.length === 0 ? (
        <p className="muted">No additional controls proposed.</p>
      ) : (
        <ul className="sms-control-list">
          {outcome.controls.map((control) => (
            <li key={control.recordId}>
              <Badge>{control.type}</Badge> {control.title}: {control.description}
            </li>
          ))}
        </ul>
      )}
      <p>
        <span className="muted">New hazards from these controls: </span>
        {outcome.newHazardCheck.answer === 'none_identified'
          ? 'Checked; none identified.'
          : `May introduce new hazards. ${outcome.newHazardCheck.note ?? ''}`}
      </p>
      <p className="safety-narrative">
        <span className="muted">Basis: </span>
        {assessment.note}
      </p>
      <details className="safety-history">
        <summary>Recorded assessment decision</summary>
        <pre>{json(assessment)}</pre>
      </details>
    </section>
  );
}

function AcceptanceSection({
  detail,
  acceptance,
  signature,
}: {
  detail: SmsRecordDetailResponse;
  acceptance?: SmsDecisionRecord;
  signature?: SmsSignatureRecord;
}) {
  if (!acceptance || !signature)
    return (
      <section className="safety-section">
        <h3>Risk acceptance</h3>
        <p className="muted">
          {detail.record.status === 'awaiting_acceptance'
            ? detail.actions.accept.available
              ? 'Waiting on your signature.'
              : detail.actions.accept.reason
            : 'Not accepted. A current assessment comes first.'}
        </p>
      </section>
    );
  const current =
    detail.decisions.find((decision) => decision.kind === 'risk.assess')?.id ===
    (acceptance.outcome as { assessmentId: string }).assessmentId;
  return (
    <section className="safety-section" data-testid="sms-signature">
      <div className="safety-section-heading">
        <h3>Risk acceptance</h3>
        <Badge tone={current ? 'planned' : 'neutral'}>{current ? 'Signed' : 'Signed for an earlier assessment'}</Badge>
      </div>
      <SignatureFacts signature={signature} note={acceptance.note} />
    </section>
  );
}

function AttachmentSection({ client, detail }: { client: LedgerClient; detail: SmsRecordDetailResponse }) {
  const [failure, setFailure] = useState<string | null>(null);
  async function download(id: string, label: string, contentType: string) {
    try {
      const { bytes } = await client.download(`/v1/sms/attachments/${encodeURIComponent(id)}/content`);
      saveBytes(bytes, label, contentType);
    } catch (error) {
      setFailure(plainError(error).message);
    }
  }
  const list = (
    <>
      {failure && (
        <Notice tone="alert" title="Download unavailable">
          {failure}
        </Notice>
      )}
      {detail.attachments.length === 0 ? (
        <p className="muted">No files attached.</p>
      ) : (
        <ul className="sms-attachments">
          {detail.attachments.map((attachment) => (
            <li key={attachment.id} data-testid={`attachment-${attachment.confidentiality}`}>
              <span>
                <strong>{attachment.label}</strong>
                <small>
                  {byteSize(attachment.byteLength)} · {attachment.recordedBy.name} ·{' '}
                  {documentTime(attachment.recordedAt)}
                </small>
                {attachment.documentVersion && (
                  <small>Attached to Ledger version {attachment.documentVersion.versionNumber}</small>
                )}
                {attachment.confidentiality !== 'ordinary' && (
                  <small className="sms-restricted-note">
                    <Badge tone="attention">{confidentialityLabels[attachment.confidentiality]}</Badge> Stored apart and
                    withheld from every export.
                  </small>
                )}
              </span>
              {attachment.readable ? (
                <Button
                  kind="quiet"
                  onClick={() => void download(attachment.id, attachment.label, attachment.contentType)}
                >
                  Download
                </Button>
              ) : (
                <small className="rail-muted">Restricted to people cleared to read it</small>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
  if (detail.record.kind === 'document')
    return (
      <section className="safety-section sms-supporting">
        <details>
          <summary>All retained files · {detail.attachments.length}</summary>
          <p className="safety-form-note">
            Every file attached to any revision. Each revision above lists the exact files it was reviewed or issued
            with.
          </p>
          {list}
        </details>
      </section>
    );
  return (
    <section className="safety-section">
      <h3>Attachments</h3>
      {list}
    </section>
  );
}

function HistorySection({ detail }: { detail: SmsRecordDetailResponse }) {
  const entries = [
    ...detail.versions.map((version) => ({
      at: version.recordedAt,
      who: version.recordedBy.name,
      what:
        version.versionNumber === 1
          ? detail.record.kind === 'hazard'
            ? 'Identified the hazard'
            : 'Drafted version 1'
          : `Recorded version ${version.versionNumber}`,
    })),
    ...detail.attachments.map((attachment) => ({
      at: attachment.recordedAt,
      who: attachment.recordedBy.name,
      what: `Attached “${attachment.label}”`,
    })),
    ...detail.decisions.map((decision) => ({
      at: decision.recordedAt,
      who: decision.actor.name,
      what: decisionLabel(decision),
    })),
    ...detail.linkChanges.map((change) => ({
      at: change.recordedAt,
      who: change.recordedBy.name,
      what: linkChangeLabel(change),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const log = (
    <ol className="sms-history">
      {entries.map((entry, index) => (
        <li key={index}>
          <span className="mono">
            {time(entry.at, true)} {timeZoneLabel()}
          </span>
          <span>
            {entry.who} · {entry.what}
          </span>
        </li>
      ))}
    </ol>
  );
  if (detail.record.kind === 'document')
    return (
      <section className="safety-section sms-supporting">
        <details>
          <summary>Every change, newest first · {entries.length}</summary>
          {log}
        </details>
      </section>
    );
  return (
    <section className="safety-section">
      <h3>What changed, and when</h3>
      {log}
    </section>
  );
}

function decisionLabel(decision: SmsDecisionRecord): string {
  if (decision.kind === 'risk.assess')
    return `Assessed the risk: residual ${levelName((decision.outcome as SmsAssessmentOutcome).residual.level)}`;
  if (decision.kind === 'risk.accept') return 'Signed the risk acceptance';
  if (decision.kind === 'document.review') return `Reviewed the document revision: ${decision.note}`;
  if (decision.kind === 'document.issue') return `Issued the document revision: ${decision.note}`;
  if (decision.kind === 'document.distribute') return `Assigned document reading: ${decision.note}`;
  if (decision.kind === 'document.withdraw') return `Withdrew a scheduled issue: ${decision.note}`;
  if (decision.kind === 'document.periodic-review') return `Recorded a periodic review: ${decision.note}`;
  if (decision.kind === 'record.close') {
    const cited = (decision.outcome as SmsStatusOutcome).review;
    return cited
      ? `Closed citing a review that concluded ${cited.conclusion}: ${decision.note}`
      : `Closed: ${decision.note}`;
  }
  if (decision.kind === 'record.reopen') return `Reopened: ${decision.note}`;
  return 'Signed the adoption';
}

function ExportCard({
  client,
  detail,
}: {
  client: LedgerClient;
  detail: SmsRecordDetailResponse;
  principal: Principal;
  home: SmsHomeResponse;
}) {
  const exporter = useSmsExport(client);
  if (!detail.actions.export.available)
    return (
      <section className="safety-next-action">
        <span className="safety-stage-label">Export</span>
        <p className="rail-muted">{detail.actions.export.reason}</p>
      </section>
    );
  return (
    <section className="safety-next-action sms-export">
      <span className="safety-stage-label">Export</span>
      <p>A verifiable file of this record, the records it depends on, their decisions and signatures.</p>
      <Button onClick={() => void exporter.create({ recordId: detail.record.id })} disabled={exporter.pending}>
        {exporter.pending ? 'Exporting…' : 'Export verifiable record'}
      </Button>
      {exporter.failure && (
        <Notice tone="alert" title="Export not created">
          {exporter.failure}
        </Notice>
      )}
      {exporter.record && <ExportReady client={client} record={exporter.record} onFailure={exporter.setFailure} />}
    </section>
  );
}

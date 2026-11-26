import { useCallback, useContext, useEffect, useState } from 'react';
import {
  readableQuote,
  readsOnly,
  reliefStatement,
  type EvaluationRelief,
  type FindingPacketRecord,
  type RuleEvaluationRecord,
  type SubjectFindingRecord,
  type SubjectRecordQuery,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { EvaluationReads } from './EvaluationReads.js';
import { FindingActions } from './FindingActions.js';
import { FindingWorkContext } from './finding-work-context.js';
import { findingStatusLabels } from './finding-work.js';
import { subjectLabel } from './subject-label.js';
import {
  explainedEvaluation,
  summaryText,
  withReadContext,
  type CitedSubject,
  type EvaluationReadContext,
} from './evaluation-reads.js';
import { errorMessage, time, timeZoneLabel } from './format.js';
import { findingsByMode, latestRelieved, proposedLabel, relievedLabel } from './rule-adoption.js';

const statusLabels: Record<SubjectFindingRecord['status'], string> = findingStatusLabels;
const outcomeLabels: Record<RuleEvaluationRecord['outcome'], string> = {
  attention: 'Needs attention',
  pass: 'Cleared',
  pending: 'Evidence pending',
  not_applicable: 'Does not apply',
  relieved: 'Relieved by a waiver',
};

export function subjectQuery(subject: CitedSubject): SubjectRecordQuery {
  return {
    subjectKind: subject.kind,
    subjectId: subject.id,
    ...(subject.scope === 'source' && subject.sourceId ? { subjectScope: 'source', sourceId: subject.sourceId } : {}),
  };
}

interface Loaded {
  findings: SubjectFindingRecord[];
  evaluations: RuleEvaluationRecord[];
  /** What both reads returned beside the evaluations, by evaluation id. */
  context: EvaluationReadContext;
  more: boolean;
}

/**
 * Findings the generic evaluator recorded about any one subject, with their evaluations, what each read and the
 * packets issued for them. Findings from shadow adoptions are listed apart, in plain words, and never counted.
 * With `only="proposed"` a screen that counts its own findings shows just the proposed ones.
 */
export function SubjectFindings({
  client,
  subject,
  only,
  version,
}: {
  client: LedgerClient;
  subject: CitedSubject;
  only?: 'proposed';
  /** Read again when this changes, for example the subject's revision. */
  version?: number | string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    const query = subjectQuery(subject);
    Promise.all([client.subjectFindings(query), client.ruleEvaluations(query)]).then(
      ([findings, evaluations]) =>
        current &&
        setLoaded({
          findings: findings.findings,
          evaluations: evaluations.evaluations,
          context: {
            inputSubjects: { ...evaluations.inputSubjects, ...findings.inputSubjects },
            summaryWording: { ...evaluations.summaryWording, ...findings.summaryWording },
          },
          more: findings.page.hasMore || evaluations.page.hasMore,
        }),
      (failure: unknown) => current && setError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [client, subject.kind, subject.id, subject.scope, subject.sourceId, version, reload]);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  if (error && only) return null;
  if (error)
    return (
      <Notice tone="alert" title="Findings are unavailable">
        {error}
      </Notice>
    );
  if (!loaded) return only ? null : <Spinner label="Reading findings" />;
  const { counted, proposed } = findingsByMode(loaded.findings);
  const relieved = latestRelieved(loaded.evaluations);
  if (only && !proposed.length) return null;
  const card = (finding: SubjectFindingRecord) => (
    <FindingCard
      key={finding.id}
      client={client}
      subject={subject}
      finding={finding}
      context={loaded.context}
      evaluations={loaded.evaluations.filter(
        (evaluation) => evaluation.pack.id === finding.packId && evaluation.rule.id === finding.ruleId,
      )}
      onIssued={refresh}
      onChanged={refresh}
    />
  );
  return (
    <section className="subject-findings" aria-label="Findings from adopted rules" data-testid="subject-findings">
      {!only && (
        <>
          <h3>Counted findings · {counted.length}</h3>
          {counted.length ? (
            counted.map(card)
          ) : (
            <p className="rail-muted">No finding from an active adoption is recorded about this subject.</p>
          )}
        </>
      )}
      {(proposed.length > 0 || !only) && (
        <section className="proposed-findings" aria-label={proposedLabel} data-testid="proposed-findings">
          <h3>
            {proposedLabel} · {proposed.length}
          </h3>
          <p className="rail-muted">
            These come from rules adopted in shadow. They are recorded so you can see what the rule would find, and are
            never counted or included in what a person attests to.
          </p>
          {proposed.length ? (
            proposed.map(card)
          ) : (
            <p className="rail-muted">No proposed rule has recorded a finding about this subject.</p>
          )}
        </section>
      )}
      {!only && relieved.length > 0 && (
        <section className="relieved-results" aria-label={relievedLabel} data-testid="relieved-results">
          <h3>
            {relievedLabel} · {relieved.length}
          </h3>
          <p className="rail-muted">
            A person adopted a waiver that relieves these rules. Each rule was still evaluated and what it found is
            kept; the result opens no finding and is not counted.
          </p>
          {relieved.map((evaluation) => (
            <article key={evaluation.id} className="rail-card finding-card" data-testid="relieved-result">
              <div className="finding-heading">
                <Badge tone="neutral">Relieved</Badge>
                <span className="mono">
                  Evaluated {time(evaluation.clock.evaluatedAt, true)} {timeZoneLabel()}
                </span>
              </div>
              <h4>{evaluation.rule.title}</h4>
              <Relief relief={evaluation.relief!} />
            </article>
          ))}
        </section>
      )}
      {loaded.more && <p className="rail-muted">Showing the newest records; older ones remain retained.</p>}
    </section>
  );
}

/** Who granted the relief by adopting which waiver, the provision's text, and what the rule would otherwise report. */
function Relief({ relief }: { relief: EvaluationRelief }) {
  return (
    <div className="finding-relief" data-testid="finding-relief" data-relief-mode={relief.mode}>
      <p>{reliefStatement(relief)}</p>
      {relief.otherwise && (
        <p className="rail-muted">Without the waiver the rule would report: {relief.otherwise.summary}</p>
      )}
      <details className="finding-provenance">
        <summary>The provision that grants the relief</summary>
        <blockquote className="rule-quote">{readableQuote(relief.provision.source.text)}</blockquote>
        <p className="rail-muted">{relief.provision.source.reference}</p>
      </details>
    </div>
  );
}

function FindingCard({
  client,
  subject,
  finding,
  context,
  evaluations,
  onIssued,
  onChanged,
}: {
  client: LedgerClient;
  subject: CitedSubject;
  finding: SubjectFindingRecord;
  context: EvaluationReadContext;
  evaluations: RuleEvaluationRecord[];
  onIssued: () => void;
  onChanged: () => void;
}) {
  const latest = finding.latestEvaluation;
  const proposed = finding.mode === 'shadow';
  const work = useContext(FindingWorkContext);
  const label = finding.related
    ? `${subjectLabel({ id: finding.related.subject.id, name: finding.related.name })} on ${finding.subject.kind} ${finding.subject.id}`
    : `${finding.subject.kind} ${finding.subject.id}`;
  return (
    <article
      className={`rail-card finding-card ${finding.status === 'resolved' ? 'is-resolved' : ''}`}
      data-testid="subject-finding"
      data-mode={finding.mode}
    >
      <div className="finding-heading">
        <Badge tone={finding.status === 'resolved' ? 'neutral' : proposed ? 'advisory' : 'attention'}>
          {proposed ? proposedLabel : statusLabels[finding.status]}
        </Badge>
        <span className="mono">
          Opened {time(finding.openedAt, true)} {timeZoneLabel()}
        </span>
      </div>
      <h4>{latest.rule.title}</h4>
      {finding.related && (
        <p className="rail-muted" data-testid="finding-related-subject">
          For {subjectLabel({ id: finding.related.subject.id, name: finding.related.name })} on {finding.subject.kind}{' '}
          {finding.subject.id}
        </p>
      )}
      <p className="finding-explanation">{summaryText(withReadContext(explainedEvaluation(latest), context))}</p>
      {latest.readAsPlans && (
        <p className="rail-muted" data-testid="finding-read-as-plan">
          Read as a plan: about {time(latest.readAsPlans.from, true)} {timeZoneLabel()}, a time that had not come when
          it was evaluated.
        </p>
      )}
      <p className="rail-muted">
        {outcomeLabels[latest.outcome]} · {proposed ? 'shadow adoption' : 'active adoption'} ·{' '}
        {latest.rule.source.reference}
        {latest.rule.source.kind === 'proposed_regulation' ? ' (proposed text, not in force)' : ''}
      </p>
      {latest.relief && <Relief relief={latest.relief} />}
      {finding.ruleNoLongerAdopted && (
        <p className="rail-muted" data-testid="finding-rule-not-adopted">
          This rule is no longer adopted: the pack version in effect does not hold it. The finding stays as recorded
          until a person closes it.
        </p>
      )}
      <details className="finding-provenance" data-testid="finding-rule-text">
        <summary>{proposed ? 'The proposed text this rule checks' : 'The text this rule checks'}</summary>
        <blockquote className="rule-quote">{readableQuote(latest.rule.source.text)}</blockquote>
      </details>
      <EvaluationReads
        client={client}
        subject={subject}
        evaluation={withReadContext(explainedEvaluation(latest), context)}
      />
      <details className="finding-evaluation">
        <summary>Evaluations of this rule · {evaluations.length}</summary>
        <ol>
          {evaluations.map((evaluation) => (
            <li key={evaluation.id} data-testid="subject-finding-evaluation">
              <strong>{outcomeLabels[evaluation.outcome]}</strong> · {evaluation.adoption.mode ?? 'active'} mode ·
              evaluated {time(evaluation.clock.evaluatedAt, true)} {timeZoneLabel()}
              <small>{summaryText(withReadContext(explainedEvaluation(evaluation), context))}</small>
            </li>
          ))}
        </ol>
      </details>
      <FindingActions
        client={client}
        principal={work.principal}
        finding={finding}
        onChanged={onChanged}
        onOpenHazard={work.openHazard && !proposed ? () => work.openHazard!(finding, label) : undefined}
      />
      <FindingPackets
        client={client}
        findingId={finding.id}
        mayIssue={!work.principal || !readsOnly(work.principal.capabilities)}
        onIssued={onIssued}
      />
    </article>
  );
}

function FindingPackets({
  client,
  findingId,
  mayIssue,
  onIssued,
}: {
  client: LedgerClient;
  findingId: string;
  /** Issuing a packet is recorded: a person who only reads sees the packets and issues none. */
  mayIssue: boolean;
  onIssued: () => void;
}) {
  const [records, setRecords] = useState<FindingPacketRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    client.findingPackets({ findingId }).then(
      (response) => current && setRecords(response.records),
      (failure: unknown) => current && setError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [client, findingId, reload]);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      await client.createFindingPacket({ findingId }, key);
      setKey(crypto.randomUUID());
      setReload((value) => value + 1);
      onIssued();
    } catch (failure) {
      // The same key retries the same request, so a lost response is recovered rather than issued twice.
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="finding-packets" data-testid="finding-packets">
      <h5>Finding packets · {records?.length ?? '…'}</h5>
      {records?.map((record) => (
        <p key={record.id} className="rail-muted" data-testid="finding-packet">
          Issued {time(record.issuedAt, true)} {timeZoneLabel()} · {record.counts.evaluations} evaluations · SHA-256{' '}
          <span className="mono">{record.packetSha256.slice(0, 12)}…</span>
        </p>
      ))}
      {error && (
        <Notice tone="alert" title="Packet not issued">
          {error}
        </Notice>
      )}
      {mayIssue && (
        <Button kind="secondary" disabled={busy} onClick={() => void issue()}>
          {busy ? <Spinner label="Issuing packet" /> : 'Issue a finding packet'}
        </Button>
      )}
    </div>
  );
}

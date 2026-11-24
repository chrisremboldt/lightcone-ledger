import type {
  MissionReleaseFinding,
  MissionReleaseFindingsResponse,
  MissionReleaseRecord,
  MissionReleaseRelievedRule,
} from '@ledger/contracts';
import { dayTime } from './format.js';
import { wordedSummary } from './wording.js';
import { findingAnswer, type findingChanges } from './missionRelease.js';

const statusWords: Record<MissionReleaseFinding['status'], string> = {
  open: 'Open',
  acknowledged: 'Someone is responsible',
  responding: 'Response in progress',
};

function subjectLabel(finding: MissionReleaseFinding): string {
  const about = `${finding.subject.kind} ${finding.subject.id}`;
  return finding.related ? `${about} · ${finding.related.name} ${finding.related.subject.id}` : about;
}

/** What the read returned beside the findings to fill the summary's wording again; absent for a recorded release. */
type Wording = Pick<MissionReleaseFindingsResponse, 'summaryWording' | 'summaryDetails'>;

function FindingItem({
  finding,
  recorded = false,
  wording = {},
}: {
  finding: MissionReleaseFinding;
  recorded?: boolean;
  wording?: Wording;
}) {
  const id = finding.evaluation.id;
  return (
    <li className="release-finding" data-finding-id={finding.id}>
      <strong>{finding.rule.title}</strong>
      <span>
        {findingAnswer(finding)} · {statusWords[finding.status]}
      </span>
      <span className="muted">{subjectLabel(finding)}</span>
      <p>{wordedSummary(finding.answer.summary, wording.summaryWording?.[id], wording.summaryDetails?.[id])}</p>
      <small className="muted">
        {recorded ? `Evaluated ${dayTime(finding.evaluation.recordedAt)} · ` : ''}Evaluation {finding.evaluation.id}
      </small>
    </li>
  );
}

function RelievedItem({ relieved }: { relieved: MissionReleaseRelievedRule }) {
  const otherwise = relieved.relief.otherwise;
  return (
    <li className="release-finding" data-testid="release-relieved-rule" data-evaluation-id={relieved.evaluation.id}>
      <strong>{relieved.rule.title}</strong>
      <span>{relieved.statement}</span>
      <span className="muted">
        {relieved.subject.kind} {relieved.subject.id}
      </span>
      {otherwise && <p>Without the waiver the rule would report: {otherwise.summary}</p>}
      <small className="muted">Evaluation {relieved.evaluation.id}</small>
    </li>
  );
}

type Changes = ReturnType<typeof findingChanges>;

function ChangeList({ changes }: { changes: Changes }) {
  const rows = [
    ...changes.added.map((finding) => ({ finding, word: 'Now listed' })),
    ...changes.changed.map((finding) => ({ finding, word: 'Changed' })),
    ...changes.removed.map((finding) => ({ finding, word: 'No longer listed' })),
  ];
  if (!rows.length) return <p>The subjects whose findings are read changed.</p>;
  return (
    <ul>
      {rows.map(({ finding, word }) => (
        <li key={`${word}:${finding.id}`}>
          {word}: {finding.rule.title} · {findingAnswer(finding)}
        </li>
      ))}
    </ul>
  );
}

interface Props {
  findings: MissionReleaseFindingsResponse;
  /** How the list changed since the person last reviewed it, when it did. */
  changes: Changes | null;
}

/**
 * The open findings a release lists, and beside them the findings of rules adopted in shadow mode. Listing a finding
 * blocks nothing; the person releasing records that they saw the list.
 */
export function ReleaseFindings({ findings, changes }: Props) {
  const counted = findings.basis.findings;
  return (
    <section className="mission-release-findings" aria-label="Open findings in this release">
      <h4>Open findings in this release</h4>
      {changes && (
        <div className="release-findings-changes" role="status">
          <strong>The open findings changed since you reviewed them.</strong>
          <ChangeList changes={changes} />
        </div>
      )}
      {counted.length ? (
        <>
          <p className="muted">
            Recorded with the release from rules adopted in active mode. They do not block it; you record that you saw
            them.
          </p>
          <ul className="release-finding-list" data-testid="release-findings-counted">
            {counted.map((finding) => (
              <FindingItem key={finding.id} finding={finding} wording={findings} />
            ))}
          </ul>
        </>
      ) : (
        <p className="muted" data-testid="release-findings-counted">
          No open findings from rules adopted in active mode.
        </p>
      )}
      {findings.proposed.length > 0 && (
        <div className="release-findings-proposed" data-testid="release-findings-proposed">
          <h5>Proposed rule: recorded, not counted</h5>
          <p className="muted">These come from rules adopted in shadow mode. They are not part of the release.</p>
          <ul className="release-finding-list">
            {findings.proposed.map((finding) => (
              <FindingItem key={finding.id} finding={finding} wording={findings} />
            ))}
          </ul>
          {!findings.proposedComplete && <p className="muted">More proposed-rule findings exist than are shown.</p>}
        </div>
      )}
      {(findings.relieved?.length ?? 0) > 0 && (
        <div className="release-findings-relieved" data-testid="release-findings-relieved">
          <h5>Relieved by a waiver: recorded, not counted</h5>
          <p className="muted">
            A person adopted a waiver that relieves these rules. Each rule was still evaluated; what it found is kept
            with the evaluation. They are not part of the release.
          </p>
          <ul className="release-finding-list">
            {findings.relieved!.map((relieved) => (
              <RelievedItem key={relieved.evaluation.id} relieved={relieved} />
            ))}
          </ul>
          {findings.relievedComplete === false && <p className="muted">More relieved rules exist than are shown.</p>}
        </div>
      )}
    </section>
  );
}

/**
 * The open findings a recorded release listed, read from the release record itself: what the person releasing
 * attested to, with each answer as it stood then.
 */
export function RecordedReleaseFindings({ release }: { release: MissionReleaseRecord }) {
  const listed = release.basis.findings.findings;
  return (
    <section className="mission-release-findings" aria-label="Open findings recorded with this release">
      <h4>Open findings as recorded with this release</h4>
      {listed.length ? (
        <>
          <p className="muted">
            The list the person releasing reviewed, with each answer as it stood then. Current findings may differ.
          </p>
          <ul className="release-finding-list" data-testid="release-findings-recorded">
            {listed.map((finding) => (
              <FindingItem key={finding.id} finding={finding} recorded />
            ))}
          </ul>
        </>
      ) : (
        <p className="muted" data-testid="release-findings-recorded">
          No open findings from rules adopted in active mode were listed when this release was recorded.
        </p>
      )}
    </section>
  );
}

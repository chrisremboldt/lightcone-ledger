import { useMemo, useState } from 'react';
import type { DocumentType, SmsDocumentIssueRef, SmsRecordSummary } from '@ledger/contracts';
import { Badge } from '@ledger/ui';
import { documentTypeLabels, statusPresentation } from './sms-labels.js';
import { documentDate, reviewState } from './sms-document-dates.js';

type LibraryState = 'in_force' | 'scheduled' | 'not_issued' | 'retired';
type LibraryFilter = 'all' | LibraryState | 'review_due';

const filters: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_force', label: 'In force' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'not_issued', label: 'Not issued' },
  { value: 'review_due', label: 'Review due' },
  { value: 'retired', label: 'Retired' },
];

const revision = (issue: SmsDocumentIssueRef) => issue.revisionLabel ?? `Version ${issue.versionNumber}`;

function libraryState(record: SmsRecordSummary): LibraryState {
  if (record.status === 'closed') return 'retired';
  if (record.kind === 'risk_matrix') return record.status === 'adopted' ? 'in_force' : 'not_issued';
  if (record.document?.inForce) return 'in_force';
  if (record.document?.scheduled) return 'scheduled';
  return 'not_issued';
}

const reviewDue = (record: SmsRecordSummary) =>
  libraryState(record) === 'in_force' && reviewState(record.document?.reviewDueAt ?? null) !== null;

function matches(record: SmsRecordSummary, filter: LibraryFilter, type: string, search: string): boolean {
  if (filter === 'review_due' ? !reviewDue(record) : filter !== 'all' && libraryState(record) !== filter) return false;
  if (type !== 'all' && (record.kind === 'risk_matrix' ? 'risk_matrix' : record.document?.documentType) !== type)
    return false;
  const text = `${record.title} ${record.document?.documentNumber ?? ''}`.toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

function InForceCell({ record }: { record: SmsRecordSummary }) {
  const document = record.document;
  if (record.status === 'closed') return <span className="muted">Retired</span>;
  if (record.kind === 'risk_matrix')
    return record.status === 'adopted' ? (
      <>
        Version {record.versionNumber}
        <small>Adopted</small>
      </>
    ) : (
      <span className="muted">Not adopted</span>
    );
  const scheduled = document?.scheduled;
  return (
    <>
      {document?.inForce ? (
        <>
          {revision(document.inForce)}
          <small className="mono">since {documentDate(document.inForce.effectiveFrom)}</small>
        </>
      ) : (
        <span className="muted">{scheduled ? 'Not yet in force' : 'Not issued'}</span>
      )}
      {scheduled && (
        <small className="mono">
          {revision(scheduled)} from {documentDate(scheduled.effectiveFrom)}
        </small>
      )}
    </>
  );
}

const workingStages: Record<string, string> = {
  draft: 'Draft, awaiting review',
  reviewed: 'Reviewed, awaiting signature',
  adopted: 'Signed, ready to issue',
};

function WorkingCell({ record }: { record: SmsRecordSummary }) {
  const document = record.document;
  const issued = [document?.inForce?.versionNumber, document?.scheduled?.versionNumber];
  const pending =
    record.status !== 'closed' &&
    (record.kind === 'risk_matrix' ? record.status !== 'adopted' : !issued.includes(record.versionNumber));
  if (!pending) return <span className="muted">None</span>;
  return (
    <>
      {record.kind === 'document'
        ? (workingStages[record.status] ?? statusPresentation(record.status).label)
        : statusPresentation(record.status).label}
      <small>Ledger version {record.versionNumber}</small>
    </>
  );
}

function LibraryRow({ record, onOpen }: { record: SmsRecordSummary; onOpen: () => void }) {
  const document = record.document;
  const review = libraryState(record) === 'in_force' ? reviewState(document?.reviewDueAt ?? null) : null;
  const reading = document?.reading;
  const unread = reading ? reading.assigned - reading.acknowledged : 0;
  return (
    <button
      className={`hazard-row sms-row sms-library-row${record.status === 'closed' ? ' sms-library-row--retired' : ''}`}
      data-testid={`sms-row-${record.id}`}
      onClick={onOpen}
    >
      <span>
        <strong>{record.title}</strong>
        <small>
          {document?.documentNumber && <span className="sms-document-number">{document.documentNumber}</span>}
          {record.kind === 'risk_matrix' ? 'Risk matrix' : documentTypeLabels[document?.documentType ?? 'other']}
          {document?.origin === 'received' ? ' · received' : ''}
          {record.revision > record.projectedRevision ? ' · Updating' : ''}
        </small>
      </span>
      <span className="sms-library-cell" data-label="In force">
        <InForceCell record={record} />
        {(review || unread > 0) && (
          <span className="sms-library-badges">
            {review && (
              <Badge tone={review === 'overdue' ? 'attention' : 'advisory'}>
                {review === 'overdue' ? 'Review overdue' : `Review due ${documentDate(document!.reviewDueAt!)}`}
              </Badge>
            )}
            {reading && reading.overdue > 0 && (
              <Badge tone="attention">
                {reading.overdue} {reading.overdue === 1 ? 'reader' : 'readers'} overdue
              </Badge>
            )}
            {reading && unread > 0 && !reading.overdue && (
              <Badge>
                {reading.acknowledged} of {reading.assigned} read
              </Badge>
            )}
          </span>
        )}
      </span>
      <span className="sms-library-cell" data-label="Working revision">
        <WorkingCell record={record} />
      </span>
      <span className="sms-row-action">Open →</span>
    </button>
  );
}

export function DocumentLibrary({
  documents,
  onOpen,
}: {
  documents: SmsRecordSummary[];
  onOpen: (record: SmsRecordSummary) => void;
}) {
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [type, setType] = useState('all');
  const [search, setSearch] = useState('');
  const types = useMemo(() => {
    const present = new Set(
      documents.map((record) => (record.kind === 'risk_matrix' ? 'risk_matrix' : record.document?.documentType)),
    );
    return [...present].flatMap((value) =>
      value
        ? [
            {
              value,
              label: value === 'risk_matrix' ? 'Risk matrix' : documentTypeLabels[value as DocumentType],
            },
          ]
        : [],
    );
  }, [documents]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        filters.map(({ value }) => [value, documents.filter((record) => matches(record, value, 'all', '')).length]),
      ) as Record<LibraryFilter, number>,
    [documents],
  );
  const shown = documents
    .filter((record) => matches(record, filter, type, search.trim()))
    .sort(
      (a, b) =>
        Number(a.status === 'closed') - Number(b.status === 'closed') ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
  return (
    <>
      <div className="sms-library-tools">
        <label className="roster-search">
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <circle cx="5.5" cy="5.5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8.7 8.7L12 12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            aria-label="Find document"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title or document number"
          />
        </label>
        {types.length > 1 && (
          <select aria-label="Document type" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="all">All types</option>
            {types.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="operation-scopes sms-library-filters" aria-label="Document state">
        {filters
          .filter((entry) => entry.value === 'all' || entry.value === filter || counts[entry.value] > 0)
          .map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {entry.label} <span className="scope-unconfirmed">{counts[entry.value]}</span>
            </button>
          ))}
      </div>
      {shown.length === 0 ? (
        <p className="sms-empty">No documents match. Try another title, number, type or state.</p>
      ) : (
        <div className="hazard-register" aria-label="Recorded documents">
          <div className="hazard-register-labels sms-library-row" aria-hidden="true">
            <span>Document</span>
            <span>In force</span>
            <span>Working revision</span>
            <span />
          </div>
          {shown.map((record) => (
            <LibraryRow key={record.id} record={record} onOpen={() => onOpen(record)} />
          ))}
        </div>
      )}
    </>
  );
}

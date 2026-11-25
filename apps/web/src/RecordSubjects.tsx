import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  OperatorRecordTypesResponse,
  OperatorRecordView,
  RecordProduction,
  RecordProductionCreate,
  RecordProductionListResponse,
  RecordSubjectFile,
  RecordSubjectsResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { recordHeadline } from './operator-records.js';
import { time, timeRange, timeZoneLabel } from './format.js';
import { coverageResultLabels } from './rule-coverage.js';
import { plainError, saveBytes } from './sms-labels.js';
import { subjectLabel } from './subject-label.js';

/** The kinds of subject the Records area lists, in the order people look for them. */
export const recordSubjectKinds = [
  ['person', 'People'],
  ['aircraft', 'Aircraft'],
  ['flight', 'Flights'],
  ['site', 'Sites'],
  ['component', 'Components'],
  ['organization', 'Your organization'],
] as const;
export type RecordSubjectKind = (typeof recordSubjectKinds)[number][0];

export interface ChosenSubject {
  kind: RecordSubjectKind;
  id: string;
  name: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The organization's subjects of one kind, by name and own id, with their record and open finding counts. */
export function SubjectLists({
  client,
  sourceId,
  kind,
  onKind,
  onOpen,
}: {
  client: LedgerClient;
  sourceId: string;
  kind: RecordSubjectKind;
  onKind: (kind: RecordSubjectKind) => void;
  onOpen: (subject: ChosenSubject) => void;
}) {
  const [search, setSearch] = useState('');
  const [shownSearch, setShownSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [pages, setPages] = useState<RecordSubjectsResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Choosing the kind already shown, or searching again for the same words, reads the list again.
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let stopped = false;
    setError(null);
    const query = new URLSearchParams({
      kind,
      sourceId,
      limit: '100',
      ...(shownSearch ? { search: shownSearch } : {}),
      ...(cursor ? { cursor } : {}),
    });
    client
      .request<RecordSubjectsResponse>(`/v1/operator-records/subjects?${query}`)
      .then((page) => !stopped && setPages((previous) => (cursor ? [...previous, page] : [page])))
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client, kind, sourceId, shownSearch, cursor, reads]);
  const label = recordSubjectKinds.find(([value]) => value === kind)![1];
  const subjects = pages.flatMap((page) => page.subjects);
  const last = pages.at(-1);
  return (
    <section className="records-list" aria-label={`${label} with records`}>
      <nav className="sms-nav-links records-kinds" aria-label="Kinds of subject">
        {recordSubjectKinds.map(([value, text]) => (
          <button
            key={value}
            aria-current={value === kind ? 'page' : undefined}
            onClick={() => {
              setPages([]);
              setCursor(undefined);
              setSearch('');
              setShownSearch('');
              setReads((count) => count + 1);
              onKind(value);
            }}
          >
            {text}
          </button>
        ))}
      </nav>
      {kind !== 'organization' && (
        <form
          className="records-subject"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setPages([]);
            setCursor(undefined);
            setShownSearch(search.trim());
            setReads((count) => count + 1);
          }}
        >
          <label htmlFor="records-subject-search">Name or id contains</label>
          <input id="records-subject-search" value={search} onChange={(event) => setSearch(event.target.value)} />
          <Button type="submit">Search</Button>
        </form>
      )}
      {error && (
        <Notice tone="alert" title="Subjects could not be read">
          {error}
        </Notice>
      )}
      {!last && !error && <Spinner label={`Reading ${label.toLowerCase()}`} />}
      {last && (
        <>
          <h2>
            {label} <span className="roster-count">{subjects.length}</span>
          </h2>
          {!subjects.length && (
            <p className="records-note">
              {shownSearch
                ? `No ${label.toLowerCase()} match “${shownSearch}”.`
                : `No records are about ${kind === 'organization' ? 'your organization' : `any ${label.toLowerCase()}`} yet. Import a file or enter a record.`}
            </p>
          )}
          <ol className="records-items" aria-label={`${label} list`}>
            {subjects.map((item) => (
              <li key={`${item.subject.scope}/${item.subject.id}`}>
                <button
                  className="records-item"
                  aria-label={`Open the file of ${subjectLabel(item.subject)}`}
                  onClick={() =>
                    onOpen({ kind, id: item.subject.id, name: item.named ? item.subject.name : item.subject.id })
                  }
                >
                  <span className="records-item-head">
                    <strong>{item.named ? item.subject.name : item.subject.id}</strong>
                    {item.openFindings > 0 && (
                      <Badge tone="attention">{plural(item.openFindings, 'open finding')}</Badge>
                    )}
                  </span>
                  <span className="records-item-meta">
                    {item.named && kind !== 'organization' ? `${item.subject.id} · ` : ''}
                    {plural(item.records.about, 'record')}
                    {item.records.about !== item.records.current
                      ? `, ${item.records.about - item.records.current} replaced`
                      : ''}
                    {item.latestAt ? ` · latest about ${time(item.latestAt, true)} ${timeZoneLabel()}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {last.page.hasMore && last.page.nextCursor && (
            <Button kind="secondary" onClick={() => setCursor(last.page.nextCursor!)}>
              Show more
            </Button>
          )}
          {last.truncated && (
            <p className="records-note">
              More subjects of this kind are on record than one list reads; search by name or id.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function recordTime(record: OperatorRecordView): string {
  if (record.interval?.end) return timeRange(record.interval.start, record.interval.end);
  if (record.interval) return `${time(record.interval.start, true)} ${timeZoneLabel()}, no end recorded`;
  return `as of ${time(record.occurredAt, true)} ${timeZoneLabel()}`;
}

const aboutWords: Record<NonNullable<OperatorRecordView['about']>, string> = {
  subject: '',
  related_subject: 'Related',
  reference: 'Names this subject',
};

/** One subject's file: every record about it by type, what replaced what, the rules that cover it and its open findings. */
export function SubjectFile({
  client,
  catalog,
  subject,
  onBack,
  onProduce,
  onOpenType,
}: {
  client: LedgerClient;
  catalog: OperatorRecordTypesResponse;
  subject: ChosenSubject;
  onBack: () => void;
  onProduce: (subject: ChosenSubject) => void;
  onOpenType: (typeKey: string, subjectId: string) => void;
}) {
  const [file, setFile] = useState<RecordSubjectFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    client
      .request<RecordSubjectFile>(
        `/v1/operator-records/subjects/${encodeURIComponent(subject.kind)}/${encodeURIComponent(subject.id)}?${new URLSearchParams({ sourceId: catalog.sourceId })}`,
      )
      .then((response) => !stopped && setFile(response))
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client, subject.kind, subject.id, catalog.sourceId]);
  const own = subject.kind === 'organization';
  const title = own ? 'Your organization' : file ? subjectLabel(file.subject) : subjectLabel(subject);
  return (
    <article className="records-detail" aria-label={`File of ${title}`} data-testid="subject-file">
      <Button kind="quiet" onClick={onBack}>
        Back to the list
      </Button>
      <h2>{title}</h2>
      <p className="records-item-meta">
        {own ? 'Records about your own organization' : `${subject.kind} · your id ${subject.id}`}
        {file && !file.named && !own ? ' · no personnel file, identity or plan names it yet' : ''}
      </p>
      <Button onClick={() => onProduce(subject)}>Produce these records</Button>
      {error && (
        <Notice tone="alert" title="This file could not be read">
          {error}
        </Notice>
      )}
      {!file && !error && <Spinner label="Reading the file" />}
      {file && (
        <>
          <section aria-label="Records about this subject">
            <h3>
              Records <span className="roster-count">{file.records.shown}</span>
            </h3>
            {file.records.truncated && (
              <p className="records-note">
                The newest {file.records.shown} are shown. Read older ones by record type, or produce them by dates.
              </p>
            )}
            {!file.groups.length && <p className="records-note">No records are about this subject.</p>}
            {file.groups.map((group) => {
              const type = catalog.types.find(
                (item) => item.recordType === group.recordType && item.recordVersion === group.recordVersion,
              );
              return (
                <section key={`${group.recordType}@${group.recordVersion}`} aria-label={group.title}>
                  <h4>
                    {group.title} <span className="roster-count">{group.records.length}</span>
                  </h4>
                  <ol className="records-items">
                    {group.records.map((record) => (
                      <li key={record.observationId}>
                        <button
                          className="records-item"
                          aria-label={`Show ${group.title} records for ${record.subject.id}`}
                          onClick={() =>
                            onOpenType(
                              `${group.recordType}@${group.recordVersion}`,
                              record.subject.scope === 'source' ? record.subject.id : '',
                            )
                          }
                        >
                          <span className="records-item-head">
                            <strong>{type ? recordHeadline(type, record.record) : group.title}</strong>
                            {!record.complete && <Badge tone="attention">Incomplete</Badge>}
                            {record.replacedBy && <Badge tone="neutral">Replaced</Badge>}
                            {record.replaces && <Badge tone="planned">Correction</Badge>}
                            {record.about && aboutWords[record.about] && (
                              <Badge tone="neutral">{aboutWords[record.about]}</Badge>
                            )}
                          </span>
                          <span className="records-item-meta">
                            {record.about !== 'subject' ? `${record.subject.kind} ${record.subject.id} · ` : ''}
                            {recordTime(record)}
                            {record.replacedBy ? ` · replaced by ${record.replacedBy}` : ''}
                            {record.replaces ? ` · replaces ${record.replaces}` : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
          </section>
          <section aria-label="Rules that cover this subject">
            <h3>Rules that cover it</h3>
            {!file.rules.length ? (
              <p className="records-note">No adopted rule has evaluated this subject yet.</p>
            ) : (
              <ul className="records-reasons">
                {file.rules.map((rule) => (
                  <li key={`${rule.adoptionId}/${rule.leafId}`}>
                    <strong>{rule.title}</strong> · {rule.packTitle}
                    {rule.mode === 'shadow' && (
                      <>
                        {' '}
                        <Badge tone="advisory">Proposed</Badge>
                      </>
                    )}
                    {' · '}
                    {coverageResultLabels[rule.result]}. {rule.evaluation.summary}{' '}
                    <span className="records-item-meta">
                      Evaluated {time(rule.evaluation.recordedAt, true)} {timeZoneLabel()}
                      {rule.finding ? ` · finding ${rule.finding.status}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Open findings about this subject">
            <h3>
              Open findings <span className="roster-count">{file.findings.length}</span>
            </h3>
            {!file.findings.length ? (
              <p className="records-note">No finding about this subject is open.</p>
            ) : (
              <ul className="records-reasons">
                {file.findings.map((finding) => (
                  <li key={finding.id}>
                    <strong>{finding.title}</strong>
                    {finding.mode === 'shadow' && (
                      <>
                        {' '}
                        <Badge tone="advisory">Proposed: recorded, not counted</Badge>
                      </>
                    )}
                    {' · '}
                    {finding.status}, opened {time(finding.openedAt, true)} {timeZoneLabel()}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </article>
  );
}

/** The first instant of a calendar day in UTC, and of the day after, as the produce form reads its dates. */
const dayStart = (day: string) => `${day}T00:00:00Z`;
function dayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().replace('.000Z', 'Z');
}

/** Chooses records by subjects, record types and dates, with a reason and who asked, and produces them as one file. */
export function ProducePanel({
  client,
  catalog,
  initial,
  onProduced,
}: {
  client: LedgerClient;
  catalog: OperatorRecordTypesResponse;
  initial: ChosenSubject[];
  onProduced: () => void;
}) {
  const [subjects, setSubjects] = useState<ChosenSubject[]>(initial);
  const [kind, setKind] = useState<RecordSubjectKind>('person');
  const [id, setId] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [originals, setOriginals] = useState(false);
  const [reason, setReason] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [produced, setProduced] = useState<RecordProduction | null>(null);
  const recordTypes = [...new Set(catalog.types.map((type) => type.recordType))];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (from && to && from > to) {
      setError('The first day must not be after the last day.');
      return;
    }
    setPending(true);
    setError(null);
    const body: RecordProductionCreate = {
      subjects: subjects.map((subject) =>
        subject.kind === 'organization' ? { kind: 'organization' } : { kind: subject.kind, id: subject.id },
      ),
      recordTypes: types,
      ...(from ? { from: dayStart(from) } : {}),
      ...(to ? { to: dayAfter(to) } : {}),
      includeOriginals: originals,
      sourceId: catalog.sourceId,
      reason,
      requestedBy,
    };
    try {
      const result = await client.request<{ record: RecordProduction }>(
        '/v1/record-productions',
        { method: 'POST', body: JSON.stringify(body) },
        crypto.randomUUID(),
      );
      setProduced(result.record);
      onProduced();
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  if (produced)
    return (
      <section className="records-form" aria-label="Records produced" data-testid="record-production">
        <h2>Records produced</h2>
        <ProductionSummary client={client} production={produced} />
        <Button kind="quiet" onClick={() => setProduced(null)}>
          Produce other records
        </Button>
      </section>
    );
  return (
    <form className="records-form" aria-label="Produce records" onSubmit={submit}>
      <h2>Produce records</h2>
      <p className="records-note">
        One .zip file: a CSV per record type in the import template’s columns, a printable index.html and manifest.json
        with the SHA-256 of every file. Replaced records are included and say what replaced them. Safety reports and
        restricted attachments are never included. Producing records is recorded with the reason and who asked.
      </p>
      <fieldset className="records-form-grid">
        <legend>Subjects</legend>
        {subjects.length ? (
          <ul aria-label="Chosen subjects">
            {subjects.map((subject) => (
              <li key={`${subject.kind}/${subject.id}`}>
                {subject.kind === 'organization' ? 'Your organization' : `${subject.kind} ${subjectLabel(subject)}`}{' '}
                <Button
                  kind="quiet"
                  type="button"
                  onClick={() => setSubjects((previous) => previous.filter((item) => item !== subject))}
                >
                  Remove {subject.kind === 'organization' ? 'your organization' : subject.id}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="records-help">Every subject, unless you add some.</p>
        )}
        <label htmlFor="produce-kind">Kind</label>
        <select id="produce-kind" value={kind} onChange={(event) => setKind(event.target.value as RecordSubjectKind)}>
          {recordSubjectKinds.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
        {kind !== 'organization' && (
          <>
            <label htmlFor="produce-subject">Your id for it</label>
            <input id="produce-subject" value={id} onChange={(event) => setId(event.target.value)} />
          </>
        )}
        <Button
          type="button"
          kind="secondary"
          disabled={kind !== 'organization' && !id.trim()}
          onClick={() => {
            const added: ChosenSubject = { kind, id: kind === 'organization' ? 'organization' : id.trim(), name: '' };
            setSubjects((previous) =>
              previous.some((item) => item.kind === added.kind && item.id === added.id)
                ? previous
                : [...previous, added],
            );
            setId('');
          }}
        >
          Add subject
        </Button>
      </fieldset>
      <fieldset className="records-form-grid">
        <legend>Record types</legend>
        <p className="records-help">Every type, unless you tick some.</p>
        {recordTypes.map((recordType) => {
          const title = catalog.types.find((type) => type.recordType === recordType)!.title;
          return (
            <label key={recordType}>
              <input
                type="checkbox"
                checked={types.includes(recordType)}
                onChange={(event) =>
                  setTypes((previous) =>
                    event.target.checked ? [...previous, recordType] : previous.filter((item) => item !== recordType),
                  )
                }
              />{' '}
              {title}
            </label>
          );
        })}
      </fieldset>
      <fieldset className="records-form-grid">
        <legend>Dates the records are about (UTC days)</legend>
        <label htmlFor="produce-from">First day</label>
        <input id="produce-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <label htmlFor="produce-to">Last day</label>
        <input id="produce-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
      </fieldset>
      <div className="records-form-grid">
        <label>
          <input type="checkbox" checked={originals} onChange={(event) => setOriginals(event.target.checked)} /> Include
          the original files
        </label>
        <label htmlFor="produce-reason">Reason</label>
        <textarea id="produce-reason" required value={reason} onChange={(event) => setReason(event.target.value)} />
        <label htmlFor="produce-requested-by">Requested by</label>
        <input
          id="produce-requested-by"
          required
          value={requestedBy}
          onChange={(event) => setRequestedBy(event.target.value)}
          placeholder="A person, office or authority"
        />
      </div>
      {error && (
        <Notice tone="alert" title="The records were not produced">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={pending || !reason.trim() || !requestedBy.trim()}>
        {pending ? 'Producing…' : 'Produce records'}
      </Button>
    </form>
  );
}

function selectionWords(production: RecordProduction): string {
  const { selection } = production;
  return [
    selection.subjects.length
      ? selection.subjects
          .map((subject) => (subject.id ? `${subject.kind} ${subject.id}` : 'your organization'))
          .join(', ')
      : 'every subject',
    selection.recordTypes.length ? selection.recordTypes.join(', ') : 'every record type',
    selection.from || selection.to
      ? `${selection.from ? `from ${time(selection.from, true)}` : ''}${selection.from && selection.to ? ' ' : ''}${selection.to ? `until ${time(selection.to, true)}` : ''} ${timeZoneLabel()}`
      : 'all dates',
    selection.includeOriginals ? 'with original files' : 'original files listed only',
  ].join('; ');
}

function ProductionSummary({ client, production }: { client: LedgerClient; production: RecordProduction }) {
  const [error, setError] = useState<string | null>(null);
  async function download() {
    try {
      const { bytes } = await client.download(`/v1/record-productions/${encodeURIComponent(production.id)}/content`);
      saveBytes(bytes, `records-${production.producedAt.slice(0, 10)}-${production.id}.zip`, 'application/zip');
    } catch (failure) {
      setError(plainError(failure).message);
    }
  }
  return (
    <div className="records-origin">
      <p>
        {plural(production.counts.records, 'record')} of {plural(production.counts.recordTypes, 'record type')}
        {production.counts.replaced ? `, ${production.counts.replaced} of them replaced` : ''};{' '}
        {plural(production.counts.originals, 'original file')} listed, {production.counts.originalsIncluded} included.
      </p>
      <dl className="records-fields">
        <div>
          <dt>Produced</dt>
          <dd>
            {time(production.producedAt, true)} {timeZoneLabel()} by{' '}
            {production.producedBy.name ?? production.producedBy.id}
          </dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{production.reason}</dd>
        </div>
        <div>
          <dt>Requested by</dt>
          <dd>{production.requestedBy}</dd>
        </div>
        <div>
          <dt>Selection</dt>
          <dd>{selectionWords(production)}</dd>
        </div>
        <div>
          <dt>Manifest SHA-256</dt>
          <dd>
            <code>{production.manifestSha256}</code> Keep it apart from the file to verify the file later.
          </dd>
        </div>
      </dl>
      <Button onClick={download}>Download the .zip</Button>
      {error && (
        <Notice tone="alert" title="The file could not be downloaded">
          {error}
        </Notice>
      )}
    </div>
  );
}

/** Every production of records, newest first, with who, when, why and the selection, each downloadable again. */
export function ProductionsList({ client }: { client: LedgerClient }) {
  const [pages, setPages] = useState<RecordProductionListResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const path = (cursor?: string) =>
    `/v1/record-productions?${new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })}`;
  useEffect(() => {
    let stopped = false;
    client
      .request<RecordProductionListResponse>(path())
      .then((response) => !stopped && setPages([response]))
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client]);
  async function more() {
    const cursor = pages.at(-1)?.page.nextCursor;
    if (!cursor) return;
    setReading(true);
    try {
      const next = await client.request<RecordProductionListResponse>(path(cursor));
      setPages((previous) => [...previous, next]);
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setReading(false);
    }
  }
  if (error && !pages.length)
    return (
      <Notice tone="alert" title="Produced records could not be read">
        {error}
      </Notice>
    );
  if (!pages.length) return <Spinner label="Reading produced records" />;
  const records = pages.flatMap((page) => page.records);
  const last = pages.at(-1)!;
  return (
    <section className="records-list" aria-label="Produced records">
      <h2>
        Produced records{' '}
        <span className="roster-count">
          {records.length}
          {last.page.hasMore ? '+' : ''}
        </span>
      </h2>
      {!records.length && <p className="records-note">No records have been produced yet.</p>}
      <ol className="records-items">
        {records.map((production) => (
          <li key={production.id} data-testid="record-production-item">
            <h3>
              {time(production.producedAt, true)} {timeZoneLabel()} · {production.requestedBy}
            </h3>
            <ProductionSummary client={client} production={production} />
          </li>
        ))}
      </ol>
      {error && (
        <Notice tone="alert" title="Older productions could not be read">
          {error}
        </Notice>
      )}
      {last.page.hasMore && last.page.nextCursor && (
        <Button kind="secondary" disabled={reading} onClick={() => void more()}>
          {reading ? 'Reading…' : 'Older productions'}
        </Button>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  aboutOwnOrganization,
  type OperatorRecordCommitResponse,
  type OperatorRecordListResponse,
  type OperatorRecordPreviewResponse,
  type OperatorRecordTypesResponse,
  type OperatorRecordView,
  type Principal,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { RecordForm } from './RecordForm.js';
import { SubjectPicker } from './SubjectPicker.js';
import { searchableKinds } from './subject-picker.js';
import { RequiredRecords } from './RequiredRecords.js';
import {
  ProducePanel,
  ProductionsList,
  SubjectFile,
  SubjectLists,
  type ChosenSubject,
  type RecordSubjectKind,
} from './RecordSubjects.js';
import {
  canKeepRecords,
  columnFor,
  displayValue,
  draftFromRecord,
  originalExcerpt,
  recordHeadline,
  typeKey,
  type RecordTypeSummary,
} from './operator-records.js';
import { time, timeRange, timeZoneLabel } from './format.js';
import { plainError, saveBytes } from './sms-labels.js';

type Pane = 'subjects' | 'browse' | 'import' | 'enter' | 'produce' | 'produced' | 'required';

/** A record's subject as a person reads it: the operator's own id, or their own organization. */
function subjectText(subject: { kind: string; id: string; scope: string }): string {
  return subject.scope === 'ledger' && subject.kind === 'organization'
    ? 'your organization'
    : `${subject.kind} ${subject.id}`;
}

/** The operator's own id for a subject, by which records are browsed; none for their own organization. */
function ownId(subject: { id: string; scope: string } | undefined): string {
  return subject?.scope === 'source' ? subject.id : '';
}

/** The shell's one way into the Records area. Shown to people who can read evidence. */
export function RecordsToggle({
  principal,
  open,
  onToggle,
}: {
  principal: Principal | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!principal?.capabilities.includes('evidence:read')) return null;
  return (
    <Button kind="quiet" className="records-toggle" aria-pressed={open} onClick={onToggle}>
      {open ? 'Close records' : 'Records'}
    </Button>
  );
}

/**
 * Operator records: the organization's people, aircraft, flights and other subjects with each one's file, records by
 * record type, import, entry and correction, and producing records on request. Nothing here is requested until the
 * area is opened.
 */
export function RecordsArea({
  client,
  principal,
  onOpenDocument,
  initialSubject,
}: {
  client: LedgerClient;
  principal: Principal | null;
  /** Opens a controlled document under Safety, such as a recordkeeping plan just started here. */
  onOpenDocument?: (id: string) => void;
  /** A subject whose file the area opens on, as when the home opens a flight. */
  initialSubject?: ChosenSubject;
}) {
  const [catalog, setCatalog] = useState<OperatorRecordTypesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState('');
  const [pane, setPane] = useState<Pane>('subjects');
  const [subjectKind, setSubjectKind] = useState<RecordSubjectKind>(initialSubject?.kind ?? 'person');
  const [opened, setOpened] = useState<ChosenSubject | null>(initialSubject ?? null);
  const [producing, setProducing] = useState<ChosenSubject[]>([]);
  const [subject, setSubject] = useState('');
  const [shownSubject, setShownSubject] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let stopped = false;
    client
      .request<OperatorRecordTypesResponse>('/v1/operator-records/types')
      .then((response) => {
        if (stopped) return;
        setCatalog(response);
        setChosen((previous) => previous || (response.types[0] ? typeKey(response.types[0]) : ''));
      })
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client]);

  const type = catalog?.types.find((item) => typeKey(item) === chosen);
  const sourceId = catalog?.sourceId ?? 'operator-records';
  const writable = canKeepRecords(principal, sourceId);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return (
    <main className="records-area" aria-label="Operator records">
      <aside className="roster records-nav" aria-label="Records navigation">
        <div className="roster-head">
          <h1>Records</h1>
          <p className="roster-scope-caption">
            What your organization recorded about its people, aircraft, flights and sites. Subjects are your own ids,
            shown beside the names their records give them.
          </p>
          <nav className="sms-nav-links records-panes" aria-label="Records lists">
            <button
              aria-current={pane === 'subjects' ? 'page' : undefined}
              onClick={() => {
                setOpened(null);
                setPane('subjects');
              }}
            >
              People, aircraft and flights
            </button>
            <button
              aria-current={pane === 'produce' ? 'page' : undefined}
              onClick={() => {
                setProducing([]);
                setPane('produce');
              }}
            >
              Produce records
            </button>
            <button aria-current={pane === 'produced' ? 'page' : undefined} onClick={() => setPane('produced')}>
              Produced records
            </button>
            <button aria-current={pane === 'required' ? 'page' : undefined} onClick={() => setPane('required')}>
              Records your rules require
            </button>
          </nav>
          <label className="records-field" htmlFor="records-type">
            Record type
          </label>
          <select
            id="records-type"
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
              setShownSubject('');
              setSubject('');
            }}
            disabled={!catalog}
          >
            {catalog?.types.map((item) => (
              <option key={typeKey(item)} value={typeKey(item)}>
                {item.title}
              </option>
            ))}
          </select>
          <nav className="sms-nav-links records-panes" aria-label="Records actions">
            <button aria-current={pane === 'browse' ? 'page' : undefined} onClick={() => setPane('browse')}>
              Browse records
            </button>
            <button aria-current={pane === 'import' ? 'page' : undefined} onClick={() => setPane('import')}>
              Import a file
            </button>
            <button aria-current={pane === 'enter' ? 'page' : undefined} onClick={() => setPane('enter')}>
              Enter a record
            </button>
          </nav>
        </div>
        {type && <p className="records-note records-description">{type.description}</p>}
      </aside>
      <section className="thread-workspace" aria-label="Records workspace">
        <div className="thread-main">
          {error && (
            <Notice tone="alert" title="Records are unavailable">
              {error}
            </Notice>
          )}
          {!catalog && !error && <Spinner label="Loading record types" />}
          {catalog && pane === 'subjects' && !opened && (
            <SubjectLists
              client={client}
              sourceId={sourceId}
              kind={subjectKind}
              onKind={setSubjectKind}
              onOpen={setOpened}
            />
          )}
          {catalog && pane === 'subjects' && opened && (
            <SubjectFile
              key={`${opened.kind}/${opened.id}/${reload}`}
              client={client}
              catalog={catalog}
              subject={opened}
              onBack={() => setOpened(null)}
              onProduce={(subject) => {
                setProducing([subject]);
                setPane('produce');
              }}
              onOpenType={(key, subjectId) => {
                setChosen(key);
                setSubject(subjectId);
                setShownSubject(subjectId);
                setPane('browse');
              }}
            />
          )}
          {catalog && pane === 'produce' && (
            <ProducePanel
              key={producing.map((item) => `${item.kind}/${item.id}`).join(',')}
              client={client}
              catalog={catalog}
              initial={producing}
              onProduced={refresh}
            />
          )}
          {pane === 'produced' && <ProductionsList key={reload} client={client} />}
          {pane === 'required' && (
            <RequiredRecords client={client} principal={principal} onOpenDocument={onOpenDocument} />
          )}
          {type && pane === 'browse' && (
            <>
              {aboutOwnOrganization(type) ? (
                <p className="records-note">These records are about your own organization.</p>
              ) : (
                <form
                  className="records-subject"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    setShownSubject(subject.trim());
                  }}
                >
                  <label htmlFor="records-subject">Subject id</label>
                  <SubjectPicker
                    client={client}
                    sourceId={sourceId}
                    id="records-subject"
                    kinds={searchableKinds(type.subjectKinds)}
                    value={subject}
                    onChange={setSubject}
                    onChoose={(option) => setShownSubject(option.id)}
                    placeholder={`Your id for the ${type.subjectKinds.join(' or ')}`}
                  />
                  <Button type="submit">Show records</Button>
                  {shownSubject && (
                    <Button
                      type="button"
                      kind="quiet"
                      onClick={() => {
                        setSubject('');
                        setShownSubject('');
                      }}
                    >
                      All subjects
                    </Button>
                  )}
                </form>
              )}
              <RecordList
                key={`${chosen}:${shownSubject}:${reload}`}
                client={client}
                type={type}
                sourceId={sourceId}
                subjectId={shownSubject}
                writable={writable}
                onSubject={(id) => {
                  setSubject(id);
                  setShownSubject(id);
                }}
                onChanged={refresh}
              />
            </>
          )}
          {type && pane === 'import' && (
            <ImportPanel
              key={chosen}
              client={client}
              type={type}
              sourceId={sourceId}
              writable={writable}
              onDone={(subjectId) => {
                refresh();
                setSubject(subjectId ?? '');
                setShownSubject(subjectId ?? '');
                setPane('browse');
              }}
            />
          )}
          {type && pane === 'enter' && (
            <>
              {writable ? (
                <RecordForm
                  key={chosen}
                  client={client}
                  type={type}
                  sourceId={sourceId}
                  onRecorded={(result) => {
                    const subjectId = ownId(result.rows[0]?.subject);
                    refresh();
                    setSubject(subjectId);
                    setShownSubject(subjectId);
                    setPane('browse');
                  }}
                />
              ) : (
                <NoGrant sourceId={sourceId} />
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function NoGrant({ sourceId }: { sourceId: string }) {
  return (
    <Notice tone="neutral" title="You can read records here">
      Importing and entering records needs input permission and a grant for operator records under source {sourceId}.
      Ask the person who manages authority in your organization.
    </Notice>
  );
}

function Completeness({ record }: { record: Pick<OperatorRecordView, 'complete' | 'missingRequired'> }) {
  return record.complete ? (
    <Badge tone="observed">Complete</Badge>
  ) : (
    <Badge tone="attention" title={record.missingRequired.map((field) => field.label).join(', ')}>
      Incomplete
    </Badge>
  );
}

function RecordList({
  client,
  type,
  sourceId,
  subjectId,
  writable,
  onSubject,
  onChanged,
}: {
  client: LedgerClient;
  type: RecordTypeSummary;
  sourceId: string;
  subjectId: string;
  writable: boolean;
  onSubject: (id: string) => void;
  onChanged: () => void;
}) {
  // Every page read so far, the first one first; More records reads the next one.
  const [pages, setPages] = useState<OperatorRecordListResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const path = (cursor?: string) =>
    `/v1/operator-records?${new URLSearchParams({
      recordType: type.recordType,
      recordVersion: String(type.recordVersion),
      sourceId,
      ...(subjectId ? { subjectId } : {}),
      ...(cursor ? { cursor } : {}),
    })}`;
  useEffect(() => {
    let stopped = false;
    client
      .request<OperatorRecordListResponse>(path())
      .then((response) => !stopped && setPages([response]))
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client, type, sourceId, subjectId]);
  async function more() {
    const cursor = pages.at(-1)?.page.nextCursor;
    if (!cursor) return;
    setReading(true);
    try {
      const next = await client.request<OperatorRecordListResponse>(path(cursor));
      setPages((previous) => [...previous, next]);
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setReading(false);
    }
  }
  if (error && !pages.length)
    return (
      <Notice tone="alert" title="Records could not be read">
        {error}
      </Notice>
    );
  if (!pages.length) return <Spinner label="Loading records" />;
  const list = { records: pages.flatMap((page) => page.records), page: pages.at(-1)!.page };
  const opened = list.records.find((record) => record.observationId === open);
  if (opened)
    return (
      <RecordDetail
        client={client}
        type={type}
        sourceId={sourceId}
        record={opened}
        records={list.records}
        writable={writable}
        onOpen={setOpen}
        onBack={() => setOpen(null)}
        onChanged={onChanged}
      />
    );
  const subjects = [...new Set(list.records.map((record) => ownId(record.subject)).filter(Boolean))];
  return (
    <section className="records-list" aria-label={`${type.title} records`}>
      <h2>
        {subjectId ? `${type.title} · ${subjectId}` : type.title}{' '}
        <span className="roster-count">
          {list.records.length}
          {list.page.hasMore ? '+' : ''}
        </span>
      </h2>
      <p className="records-note">Newest first.</p>
      {!list.records.length && (
        <p className="records-note">
          No {type.title.toLowerCase()} records{subjectId ? ` for ${subjectId}` : ''} yet. Import a file or enter one.
        </p>
      )}
      {!subjectId && subjects.length > 1 && (
        <div className="records-subjects" aria-label="Subjects with records">
          {subjects.map((id) => (
            <Button key={id} kind="quiet" onClick={() => onSubject(id)}>
              {id}
            </Button>
          ))}
        </div>
      )}
      <ol className="records-items">
        {list.records.map((record) => (
          <li key={record.observationId}>
            <button
              className="records-item"
              onClick={() => setOpen(record.observationId)}
              aria-label={`Open ${type.title} record ${recordHeadline(type, record.record)} for ${subjectText(record.subject)}`}
            >
              <span className="records-item-head">
                <strong>{recordHeadline(type, record.record)}</strong>
                <Completeness record={record} />
                {record.replacedBy && <Badge tone="neutral">Replaced</Badge>}
                {record.replaces && <Badge tone="planned">Correction</Badge>}
              </span>
              <span className="records-item-meta">
                {subjectText(record.subject)} · {recordTime(record)}
              </span>
              {!record.complete && (
                <span className="records-missing">
                  Missing {record.missingRequired.map((field) => field.label).join(', ')}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {error && (
        <Notice tone="alert" title="More records could not be read">
          {error}
        </Notice>
      )}
      {list.page.hasMore && list.page.nextCursor && (
        <Button kind="secondary" disabled={reading} onClick={() => void more()}>
          {reading ? 'Reading…' : 'More records'}
        </Button>
      )}
    </section>
  );
}

function recordTime(record: OperatorRecordView): string {
  if (record.interval?.end) return timeRange(record.interval.start, record.interval.end);
  if (record.interval) return `${time(record.interval.start, true)} ${timeZoneLabel()}, no end recorded`;
  return `as of ${time(record.occurredAt, true)} ${timeZoneLabel()}`;
}

function RecordDetail({
  client,
  type,
  sourceId,
  record,
  records,
  writable,
  onOpen,
  onBack,
  onChanged,
}: {
  client: LedgerClient;
  type: RecordTypeSummary;
  sourceId: string;
  record: OperatorRecordView;
  records: OperatorRecordView[];
  writable: boolean;
  onOpen: (id: string) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [original, setOriginal] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  useEffect(() => {
    let stopped = false;
    setOriginal(null);
    client
      .download(`/v1/artifacts/${encodeURIComponent(record.origin.artifactId)}/content`)
      .then(({ bytes }) => !stopped && setOriginal(originalExcerpt(bytes, record.origin.locator)))
      .catch(() => !stopped && setOriginal(''));
    return () => {
      stopped = true;
    };
  }, [client, record]);
  const link = (id: string) =>
    records.some((item) => item.observationId === id) ? (
      <button className="records-link" onClick={() => onOpen(id)}>
        {id}
      </button>
    ) : (
      <code>{id}</code>
    );
  const draft = useMemo(() => draftFromRecord(type, record), [type, record]);
  return (
    <article className="records-detail" aria-label={`${type.title} record`} data-testid="operator-record">
      <Button kind="quiet" onClick={onBack}>
        Back to records
      </Button>
      <h2>{recordHeadline(type, record.record)}</h2>
      <p className="records-item-meta">
        {type.title} · {subjectText(record.subject)} · {recordTime(record)}
      </p>
      <p>
        <Completeness record={record} />{' '}
        {!record.complete && <span>Missing {record.missingRequired.map((field) => field.label).join(', ')}.</span>}
      </p>
      {record.replacedBy && (
        <Notice tone="neutral" title="Replaced">
          This record was replaced by record {link(record.replacedBy)}.
        </Notice>
      )}
      {record.replaces && <p className="records-note">This record replaces record {link(record.replaces)}.</p>}
      <dl className="records-fields">
        {type.fields.map((field) => (
          <div key={field.name}>
            <dt>{field.label}</dt>
            <dd>
              {displayValue(
                field,
                record.record[field.name],
                columnFor(type, field.name)?.units?.accepted[0]?.label,
                record.dayOnly?.[field.name]?.day,
              )}
            </dd>
          </div>
        ))}
        {record.secondarySubject && (
          <div>
            <dt>Related {record.secondarySubject.kind}</dt>
            <dd>{record.secondarySubject.id}</dd>
          </div>
        )}
      </dl>
      {record.limitations.length > 0 && (
        <ul className="records-reasons">
          {record.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
      <section className="records-origin" aria-label="Where this record came from">
        <h3>Where it came from</h3>
        <p>
          {record.origin.filename ? `File ${record.origin.filename}` : 'Entered by hand (the submitted record)'} ·
          recorded by {record.origin.recordedBy.name ?? record.origin.recordedBy.id} on {record.receivedAt.slice(0, 10)}{' '}
          · Ledger id <code>{record.observationId}</code>
        </p>
        {original === null ? (
          <Spinner label="Loading the original" />
        ) : original ? (
          <pre className="records-original">{original}</pre>
        ) : (
          <p className="records-note">The original bytes could not be read.</p>
        )}
      </section>
      {writable && !record.replacedBy && !correcting && (
        <Button onClick={() => setCorrecting(true)}>Correct this record</Button>
      )}
      {correcting && (
        <RecordForm
          client={client}
          type={type}
          sourceId={sourceId}
          initial={draft}
          replaces={record.observationId}
          onCancel={() => setCorrecting(false)}
          onRecorded={() => {
            setCorrecting(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

function ImportPanel({
  client,
  type,
  sourceId,
  writable,
  onDone,
}: {
  client: LedgerClient;
  type: RecordTypeSummary;
  sourceId: string;
  writable: boolean;
  onDone: (subjectId?: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [preview, setPreview] = useState<OperatorRecordPreviewResponse | null>(null);
  const [result, setResult] = useState<OperatorRecordCommitResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = (id: string) =>
    JSON.stringify({ artifactId: id, recordType: type.recordType, recordVersion: type.recordVersion, sourceId });

  async function template(format: 'csv' | 'json') {
    const path = `/v1/operator-records/types/${encodeURIComponent(type.recordType)}/versions/${type.recordVersion}/template?format=${format}`;
    try {
      const { bytes } = await client.download(path);
      saveBytes(
        bytes,
        `${type.recordType}-v${type.recordVersion}.${format}`,
        format === 'csv' ? 'text/csv' : 'application/json',
      );
    } catch (failure) {
      setError(plainError(failure).message);
    }
  }
  async function check(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    setError(null);
    setPreview(null);
    setResult(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const json = file.name.toLowerCase().endsWith('.json') || file.type.includes('json');
      const { artifact } = await client.upload(
        bytes,
        json ? 'application/json' : 'text/csv',
        crypto.randomUUID(),
        file.name,
      );
      setArtifactId(artifact.id);
      setPreview(
        await client.request<OperatorRecordPreviewResponse>('/v1/operator-records/imports/preview', {
          method: 'POST',
          body: body(artifact.id),
        }),
      );
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  async function commit() {
    if (!artifactId) return;
    setPending(true);
    setError(null);
    try {
      setResult(
        await client.request<OperatorRecordCommitResponse>('/v1/operator-records/imports', {
          method: 'POST',
          body: body(artifactId),
        }),
      );
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  const rows = result?.rows ?? preview?.rows ?? [];
  const firstSubject = ownId(rows.find((row) => row.status !== 'refused')?.subject) || undefined;
  return (
    <section className="records-import" aria-label={`Import ${type.title} records`}>
      <h2>Import {type.title.toLowerCase()} records</h2>
      <p className="records-note">
        A CSV file with a header row, or a JSON file with a records array. One row is one record. Number columns end in
        their unit; write another unit in brackets, such as <code>stem [ft]</code>, and it is converted. Rows are
        checked first and nothing is recorded until you confirm.
      </p>
      <div className="records-actions">
        <Button type="button" kind="quiet" onClick={() => void template('csv')}>
          Download CSV template
        </Button>
        <Button type="button" kind="quiet" onClick={() => void template('json')}>
          Download JSON template
        </Button>
      </div>
      <details className="records-columns">
        <summary>Columns</summary>
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Meaning</th>
              <th>Values</th>
            </tr>
          </thead>
          <tbody>
            {type.columns.map((column) => (
              <tr key={column.key}>
                <td>
                  <code>{column.key}</code>
                </td>
                <td>
                  {column.label}
                  {column.required ? ' · required' : column.replayOnly ? ' · optional, explains the record' : ''}
                  {column.help && <small className="records-help">{column.help}</small>}
                </td>
                <td>
                  {column.options?.map((option) => option.value).join(', ') ??
                    (column.units
                      ? `number in ${column.units.stored}; also ${
                          column.units.accepted
                            .slice(1)
                            .map((unit) => `[${unit.unit}]`)
                            .join(' ') || 'no other unit'
                        }`
                      : column.kind.replace('_', ' '))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {!writable && <NoGrant sourceId={sourceId} />}
      {writable && (
        <form className="records-file" onSubmit={(event) => void check(event)}>
          <label htmlFor="records-file">File to import</label>
          <input
            id="records-file"
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
            }}
          />
          <Button type="submit" disabled={!file || pending}>
            {pending && !preview ? 'Checking…' : 'Check file'}
          </Button>
        </form>
      )}
      {error && (
        <Notice tone="alert" title="Not imported">
          {error}
        </Notice>
      )}
      {preview && preview.problems.length > 0 && (
        <Notice tone="alert" title="This file cannot be imported">
          <ul className="records-reasons">
            {preview.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
      {preview && !result && preview.problems.length === 0 && (
        <Notice tone={preview.summary.refused ? 'attention' : 'neutral'} title="Checked; nothing recorded yet">
          {preview.summary.acceptable} of {preview.summary.rows} rows can be recorded
          {preview.summary.incomplete ? `, ${preview.summary.incomplete} of them incomplete` : ''}.
          {preview.summary.alreadyRecorded
            ? ` ${preview.summary.alreadyRecorded} already recorded from this file.`
            : ''}
          {preview.summary.refused ? ` ${preview.summary.refused} refused; see the reasons below.` : ''}
        </Notice>
      )}
      {result && (
        <Notice
          tone={result.summary.recorded ? 'observed' : 'attention'}
          title={result.summary.recorded ? 'Imported' : 'Nothing recorded'}
        >
          Recorded {result.summary.recorded} of {result.summary.rows} rows
          {result.summary.incomplete ? `, ${result.summary.incomplete} incomplete` : ''}.
          {result.summary.alreadyRecorded ? ` ${result.summary.alreadyRecorded} were already recorded.` : ''}
          {result.summary.refused ? ` ${result.summary.refused} refused.` : ''}
        </Notice>
      )}
      {rows.length > 0 && (
        <table className="records-preview" aria-label="Rows in the file">
          <thead>
            <tr>
              <th>Row</th>
              <th>Subject</th>
              <th>Outcome</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.row} data-status={row.status}>
                <td>{row.row}</td>
                <td>{row.subject ? ownId(row.subject) || 'Your organization' : '—'}</td>
                <td>
                  {row.status === 'refused' ? (
                    <Badge tone="alert">Refused</Badge>
                  ) : row.status === 'already_recorded' ? (
                    <Badge tone="neutral">Already recorded</Badge>
                  ) : (
                    <>
                      <Badge tone="observed">{row.status === 'recorded' ? 'Recorded' : 'Will be recorded'}</Badge>{' '}
                      {!row.complete && <Badge tone="attention">Incomplete</Badge>}
                    </>
                  )}
                </td>
                <td>
                  {row.reasons.length > 0 && (
                    <ul className="records-reasons">
                      {row.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  {row.notes?.map((note) => (
                    <small key={note} className="records-help">
                      {note}
                    </small>
                  ))}
                  {row.status !== 'refused' && row.missingRequired.length > 0 && (
                    <span>Missing {row.missingRequired.map((field) => field.label).join(', ')}.</span>
                  )}
                  {row.conversions.map((conversion) => (
                    <small key={conversion.field} className="records-help">
                      {conversion.field}: {conversion.entered.value} {conversion.entered.unit} →{' '}
                      {conversion.stored.value} {conversion.stored.unit}
                    </small>
                  ))}
                  {row.timeConversions.map((conversion) => (
                    <small key={`time-${conversion.field}`} className="records-help">
                      {conversion.field}: {conversion.entered}
                      {conversion.timeZone ? ` (${conversion.timeZone})` : ''} → {conversion.stored}
                    </small>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="records-actions">
        {preview && !result && preview.summary.acceptable > 0 && (
          <Button kind="primary" onClick={() => void commit()} disabled={pending || !preview.granted}>
            {pending ? 'Recording…' : `Record ${preview.summary.acceptable} rows`}
          </Button>
        )}
        {result && (
          <Button kind="primary" onClick={() => onDone(firstSubject)}>
            Show imported records
          </Button>
        )}
      </div>
    </section>
  );
}

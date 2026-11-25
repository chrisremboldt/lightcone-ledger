import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  Principal,
  ReportBody,
  SafetyReportLink,
  SafetyReportLinkIssued,
  SafetyReportLinkList,
  SmsRecordContentResponse,
  SmsRecordDetailResponse,
  SmsRecordSummary,
  SmsRegisterResponse,
} from '@ledger/contracts';
import { recordedReportChannelValues } from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { time, timeZoneLabel, timeZoneName } from './format.js';
import { centralDateTimeInput, documentTime, fromCentralDateTimeInput } from './sms-document-dates.js';
import { plainError, statusPresentation } from './sms-labels.js';
import { FailureNotice, useCommand } from './SmsForms.js';
import { RecordRow } from './SmsHazards.js';
import { RegisterMore, RegisterTools, useRegisterList } from './SmsRegisterTools.js';
import { narrowed, registerCount, useRegisterQuery } from './sms-register-query.js';

const channelLabels: Record<ReportBody['received']['channel'], string> = {
  in_person: 'In person',
  phone: 'By phone',
  email: 'By email',
  paper: 'On paper',
  app: 'Through an app',
  submitted_signed_in: 'Submitted in Ledger by a signed-in person',
  submitted_link: 'Submitted through a reporting link',
};

/** Whether a person may record a safety report as received: they write safety records and are cleared to read reports. */
export function mayRecordReports(principal: Pick<Principal, 'capabilities'>): boolean {
  return principal.capabilities.includes('sms:write') && principal.capabilities.includes('sms:report:read');
}

const reportStatuses = ['received', 'closed'].map((value) => ({ value, label: statusPresentation(value).label }));

/**
 * The safety reports register: every report recorded as received, listed without its protected content. It is
 * searched by the organization's own id for a report only, never by what a report says or who sent it.
 */
export function ReportsRegister({
  register,
  principal,
  client,
  onOpen,
  onChanged,
}: {
  register: SmsRegisterResponse;
  principal: Principal;
  client: LedgerClient;
  onOpen: (record: Pick<SmsRecordSummary, 'id' | 'kind'>) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useRegisterQuery();
  const list = useRegisterList(client, 'report', register, query);
  const reports = list.records ?? [];
  return (
    <div className="thread-layout safety-layout">
      <div className="thread-main safety-main">
        <p className="thread-crumbs">Safety / Safety reports</p>
        <div className="thread-title">
          <h2>Safety reports</h2>
          <Badge>{list.records ? registerCount(reports.length, Boolean(list.more), query) : '…'}</Badge>
        </div>
        <p className="safety-intro">
          Reports recorded as received, newest first. A report&apos;s title, account and reporter are stored apart: only
          people cleared to read safety reports can open them, and each reading is retained.
        </p>
        {(register.records.length > 0 || narrowed(query)) && (
          <RegisterTools
            noun="reports"
            query={query}
            onQuery={setQuery}
            searchLabel="Your reference for the report"
            searchHint="Search finds a report by your reference for it only. What a report says and who sent it are never searched."
            statuses={reportStatuses}
            orders={['newest', 'oldest']}
            openedLabel="Recorded as received"
          />
        )}
        {!list.records ? (
          <Spinner label="Reading safety reports" />
        ) : reports.length === 0 && narrowed(query) ? (
          <p className="sms-empty">No safety reports match. Try another reference, state or day.</p>
        ) : reports.length === 0 ? (
          <div className="safety-empty">
            <h3>No safety reports recorded yet</h3>
            <p>
              {mayRecordReports(principal)
                ? 'Record a report as you received it with the form beside this list.'
                : 'A person cleared to read safety reports records each one as received.'}
            </p>
          </div>
        ) : (
          <div className="hazard-register" aria-label="Recorded safety reports">
            {reports.map((record) => (
              <RecordRow key={record.id} record={record} onOpen={() => onOpen(record)} />
            ))}
          </div>
        )}
        <RegisterMore label="More safety reports" list={list} />
      </div>
      <aside className="rail safety-rail" aria-label="Report actions">
        <RecordReportForm
          client={client}
          principal={principal}
          onOpened={(id) => {
            onChanged();
            onOpen({ id, kind: 'report' });
          }}
        />
        {principal.capabilities.includes('sms:configure') && <ReportLinks client={client} />}
      </aside>
    </div>
  );
}

const blankReport = () => ({
  title: '',
  narrative: '',
  channel: 'in_person' as (typeof recordedReportChannelValues)[number],
  receivedAt: centralDateTimeInput(new Date().toISOString()),
  occurredAt: '',
  operation: '',
  siteReference: '',
  reporterName: '',
  reporterContact: '',
});

function reportBody(draft: ReturnType<typeof blankReport>): ReportBody {
  const optional = (value: string) => value.trim() || undefined;
  const reporter = optional(draft.reporterName);
  return {
    narrative: draft.narrative.trim(),
    received: {
      channel: draft.channel,
      ...(draft.receivedAt ? { receivedAt: fromCentralDateTimeInput(draft.receivedAt) } : {}),
    },
    ...(draft.occurredAt ? { occurredAt: fromCentralDateTimeInput(draft.occurredAt) } : {}),
    ...(optional(draft.operation) ? { operation: draft.operation.trim() } : {}),
    ...(optional(draft.siteReference) ? { siteReference: draft.siteReference.trim() } : {}),
    ...(reporter
      ? {
          reporter: {
            name: reporter,
            ...(optional(draft.reporterContact) ? { contact: draft.reporterContact.trim() } : {}),
          },
        }
      : {}),
  };
}

/** Records a safety report as it was received, by a person cleared to read safety reports. */
export function RecordReportForm({
  client,
  principal,
  onOpened,
}: {
  client: LedgerClient;
  principal: Principal;
  onOpened: (id: string) => void;
}) {
  const [draft, setDraft] = useState(blankReport);
  const command = useCommand(client);
  if (!mayRecordReports(principal))
    return (
      <div className="safety-register-guidance">
        <h3>Record a safety report</h3>
        <p className="rail-muted">
          Recording a safety report needs permission to write safety records and to read safety reports. An
          administrator grants both on the People screen.
        </p>
      </div>
    );
  const set = (field: keyof typeof draft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [field]: event.target.value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    let body: ReportBody;
    try {
      body = reportBody(draft);
    } catch (error) {
      command.setFailure(plainError(error));
      return;
    }
    const result = await command.submit({
      kind: 'sms.record.open',
      record: { kind: 'report', schema: 'sms.report.1', title: draft.title.trim(), ownerId: principal.id, body },
    });
    if (!result?.command.subject) return;
    setDraft(blankReport());
    onOpened(result.command.subject.id);
  }
  return (
    <form
      className="action-form safety-form"
      onSubmit={(event) => void save(event)}
      aria-label="Record a safety report"
    >
      <h3>Record a safety report</h3>
      <p className="safety-form-note">
        Record the report as you received it. Its title, account and reporter are readable only by people cleared to
        read safety reports, and are withheld from every export.
      </p>
      <label htmlFor="report-title">Short title</label>
      <input id="report-title" value={draft.title} onChange={set('title')} maxLength={200} required />
      <label htmlFor="report-narrative">What was reported</label>
      <textarea id="report-narrative" rows={5} value={draft.narrative} onChange={set('narrative')} required />
      <div className="safety-form-grid">
        <label>
          How it was received
          <select value={draft.channel} onChange={set('channel')}>
            {recordedReportChannelValues.map((channel) => (
              <option key={channel} value={channel}>
                {channelLabels[channel]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Received · {timeZoneName()} time
          <input type="datetime-local" step="1" value={draft.receivedAt} onChange={set('receivedAt')} />
        </label>
      </div>
      <label>
        When it happened · {timeZoneName()} time (optional)
        <input type="datetime-local" step="1" value={draft.occurredAt} onChange={set('occurredAt')} />
      </label>
      <label htmlFor="report-operation">Operation (optional)</label>
      <input id="report-operation" value={draft.operation} onChange={set('operation')} maxLength={200} />
      <label htmlFor="report-site">Site or asset reference (optional)</label>
      <input id="report-site" value={draft.siteReference} onChange={set('siteReference')} maxLength={200} />
      <p className="safety-form-note">A reference people use for the place, never coordinates.</p>
      <fieldset className="sms-new-hazards">
        <legend>Who reported (optional)</legend>
        <label htmlFor="report-reporter">Name</label>
        <input id="report-reporter" value={draft.reporterName} onChange={set('reporterName')} maxLength={200} />
        <label htmlFor="report-contact">Contact</label>
        <input
          id="report-contact"
          value={draft.reporterContact}
          onChange={set('reporterContact')}
          maxLength={200}
          disabled={!draft.reporterName.trim()}
        />
        <p className="safety-form-note">Leave the name empty for a report made without a name.</p>
      </fieldset>
      <FailureNotice failure={command.failure} />
      <Button kind="primary" type="submit" disabled={command.pending}>
        {command.pending ? 'Recording…' : 'Record report'}
      </Button>
    </form>
  );
}

function ReportContent({ content }: { content: SmsRecordContentResponse }) {
  const current = content.versions[0]!;
  const body = current.body as ReportBody;
  return (
    <section className="safety-section" data-testid="report-content">
      <div className="safety-section-heading">
        <h3>{current.title}</h3>
        <span className="muted">
          Read {time(content.disclosedAt, true)} {timeZoneLabel()} · this reading is retained
        </span>
      </div>
      <p className="safety-narrative">{body.narrative}</p>
      <dl className="safety-facts">
        <div>
          <dt>Received</dt>
          <dd>
            {channelLabels[body.received.channel]}
            {body.received.receivedAt ? `, ${documentTime(body.received.receivedAt)}` : ''}
          </dd>
        </div>
        {body.occurredAt && (
          <div>
            <dt>Happened</dt>
            <dd>{documentTime(body.occurredAt)}</dd>
          </div>
        )}
        {body.operation && (
          <div>
            <dt>Operation</dt>
            <dd>{body.operation}</dd>
          </div>
        )}
        {body.siteReference && (
          <div>
            <dt>Site or asset</dt>
            <dd>{body.siteReference}</dd>
          </div>
        )}
        <div>
          <dt>Reported by</dt>
          <dd>{[body.reporter?.name ?? 'No name given', body.reporter?.contact].filter(Boolean).join(' · ')}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{current.versionNumber}</dd>
        </div>
      </dl>
    </section>
  );
}

/** A safety report's page: that it was received, and its protected content for a person cleared to read it. */
export function ReportSections({ client, detail }: { client: LedgerClient; detail: SmsRecordDetailResponse }) {
  const [content, setContent] = useState<SmsRecordContentResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readable = detail.actions.readContent;
  async function read() {
    setReading(true);
    setFailure(null);
    try {
      setContent(
        await client.request<SmsRecordContentResponse>(
          `/v1/sms/records/${encodeURIComponent(detail.record.id)}/content`,
        ),
      );
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setReading(false);
    }
  }
  return (
    <>
      <section className="safety-section">
        <h3>Safety report</h3>
        <p className="muted">
          Recorded as received by {detail.versions[detail.versions.length - 1]!.recordedBy.name}. Its title, account and
          reporter are stored apart from this page.
        </p>
        {readable.available ? (
          !content && (
            <Button kind="next" disabled={reading} onClick={() => void read()}>
              {reading ? 'Opening…' : 'Read the report'}
            </Button>
          )
        ) : (
          <p className="rail-muted" data-testid="report-unreadable">
            {readable.reason}
          </p>
        )}
        {failure && (
          <Notice tone="alert" title="The report could not be read">
            {failure}
          </Notice>
        )}
      </section>
      {content && <ReportContent content={content} />}
    </>
  );
}

/** The address a reporting link opens: the report page, with the token after #, which a browser never sends. */
export function reportLinkAddress(token: string, origin = window.location.origin): string {
  return `${origin}/report#${token}`;
}

/** Reporting links: issued and revoked by a person who may configure safety records. */
export function ReportLinks({ client }: { client: LedgerClient }) {
  const [links, setLinks] = useState<SafetyReportLink[] | null>(null);
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [issued, setIssued] = useState<SafetyReportLinkIssued | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function load() {
    try {
      setLinks((await client.request<SafetyReportLinkList>('/v1/sms/report-links')).links);
    } catch (error) {
      setFailure(plainError(error).message);
    }
  }
  useEffect(() => {
    void load();
    // The client is fixed for the screen's life.
  }, []);
  async function issue(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    try {
      const expiry = expiresAt ? new Date(expiresAt) : undefined;
      const answer = await client.request<SafetyReportLinkIssued>(
        '/v1/sms/report-links',
        {
          method: 'POST',
          body: JSON.stringify({ label: label.trim(), ...(expiry ? { expiresAt: expiry.toISOString() } : {}) }),
        },
        crypto.randomUUID(),
      );
      setIssued(answer);
      setLabel('');
      setExpiresAt('');
      await load();
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setPending(false);
    }
  }
  async function revoke(link: SafetyReportLink) {
    setFailure(null);
    try {
      await client.request(`/v1/sms/report-links/${encodeURIComponent(link.id)}/revoke`, { method: 'POST' });
      if (issued?.link.id === link.id) setIssued(null);
      await load();
    } catch (error) {
      setFailure(plainError(error).message);
    }
  }
  return (
    <section className="safety-register-guidance" aria-label="Reporting links">
      <h3>Reporting links</h3>
      <p className="rail-muted">
        Anyone with a reporting link can send a safety report without signing in. Ledger keeps no account, address or
        browser details with it. A link takes at most 20 reports an hour.
      </p>
      {issued && (
        <div className="safety-report-receipt" data-testid="issued-report-link">
          <p>The link for “{issued.link.label}”. Copy it now: Ledger keeps no copy it can show again.</p>
          <p className="safety-report-code">{reportLinkAddress(issued.token)}</p>
        </div>
      )}
      {links && links.length > 0 && (
        <ul className="safety-report-links" aria-label="Issued reporting links">
          {links.map((link) => (
            <li key={link.id}>
              <span>
                <strong>{link.label}</strong>
                <small>
                  {link.inForce
                    ? `In force${link.expiresAt ? ` until ${documentTime(link.expiresAt)}` : ''}`
                    : link.revokedAt
                      ? `Revoked ${documentTime(link.revokedAt)} by ${link.revokedBy?.name ?? ''}`
                      : `Expired ${link.expiresAt ? documentTime(link.expiresAt) : ''}`}
                  {` · issued by ${link.issuedBy.name}`}
                </small>
              </span>
              {link.inForce && (
                <Button kind="quiet" onClick={() => void revoke(link)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="action-form" aria-label="Issue a reporting link" onSubmit={(event) => void issue(event)}>
        <label htmlFor="report-link-label">Label</label>
        <input
          id="report-link-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
          required
        />
        <p className="safety-form-note">What people know it by, such as where it is posted.</p>
        <label htmlFor="report-link-expiry">Expires, on this device&apos;s clock (optional)</label>
        <input
          id="report-link-expiry"
          type="datetime-local"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.target.value)}
        />
        <Button type="submit" disabled={pending}>
          {pending ? 'Issuing…' : 'Issue a reporting link'}
        </Button>
      </form>
      {failure && (
        <Notice tone="alert" title="The reporting links could not be changed">
          {failure}
        </Notice>
      )}
    </section>
  );
}

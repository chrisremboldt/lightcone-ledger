import { useState, type FormEvent, type ReactNode } from 'react';
import { LedgerClient } from '@ledger/contracts/client';
import type {
  LinkSafetyReport,
  SafetyReportReceipt,
  SafetyReportStatus,
  SignedInSafetyReport,
} from '@ledger/contracts';
import { Button, Notice } from '@ledger/ui';
import { plainError } from './sms-labels.js';

// Submitting a safety report: from any screen when signed in, and from the reporting link's page without signing in.
// What each keeps is in docs/design/report-submission.md; what the forms say here must stay true to it.

interface Draft {
  whatWasSeen: string;
  occurredAt: string;
  where: string;
  contact: string;
}
const blank = (): Draft => ({ whatWasSeen: '', occurredAt: '', where: '', contact: '' });

/** The report's fields as the API takes them. The time is read on the reporter's own device. */
function reportFields(draft: Draft): Omit<SignedInSafetyReport, 'named'> {
  const occurred = draft.occurredAt ? new Date(draft.occurredAt) : undefined;
  return {
    whatWasSeen: draft.whatWasSeen.trim(),
    ...(occurred && Number.isFinite(occurred.getTime()) ? { occurredAt: occurred.toISOString() } : {}),
    ...(draft.where.trim() ? { where: draft.where.trim() } : {}),
    ...(draft.contact.trim() ? { contact: draft.contact.trim() } : {}),
  };
}

function ReportFields({
  draft,
  onChange,
  idPrefix,
  children,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  idPrefix: string;
  children?: ReactNode;
}) {
  const set = (field: keyof Draft) => (event: { target: { value: string } }) =>
    onChange({ ...draft, [field]: event.target.value });
  return (
    <>
      <label htmlFor={`${idPrefix}-seen`}>What happened or what you saw</label>
      <textarea
        id={`${idPrefix}-seen`}
        rows={6}
        value={draft.whatWasSeen}
        onChange={set('whatWasSeen')}
        maxLength={8000}
        required
      />
      <label htmlFor={`${idPrefix}-when`}>When it happened, on this device&apos;s clock (optional)</label>
      <input id={`${idPrefix}-when`} type="datetime-local" value={draft.occurredAt} onChange={set('occurredAt')} />
      <label htmlFor={`${idPrefix}-where`}>Where it happened (optional)</label>
      <input id={`${idPrefix}-where`} value={draft.where} onChange={set('where')} maxLength={200} />
      <p className="safety-form-note">A site, an aircraft or a place people know. Never coordinates.</p>
      {children}
      <label htmlFor={`${idPrefix}-contact`}>A way to reach you (optional)</label>
      <input id={`${idPrefix}-contact`} value={draft.contact} onChange={set('contact')} maxLength={200} />
      <p className="safety-form-note">
        Optional. If you give one, the people cleared to read safety reports can see it.
      </p>
      <p className="safety-form-note">Files and photos cannot be sent with a report.</p>
    </>
  );
}

/** The receipt code, shown once. */
function ReceiptShown({ receipt, onDone }: { receipt: SafetyReportReceipt['receipt']; onDone?: () => void }) {
  return (
    <section className="safety-report-receipt" aria-label="Report received">
      <h3>Your report is received</h3>
      <p>Your receipt code:</p>
      <p className="safety-report-code" data-testid="receipt-code">
        {receipt.code}
      </p>
      <p className="safety-form-note">
        Write it down now: Ledger keeps no copy it can show again. With it, anyone can see only whether this report is
        received or closed, on the page at /report.
      </p>
      {onDone && (
        <Button kind="primary" onClick={onDone}>
          Done
        </Button>
      )}
    </section>
  );
}

/** Report a safety concern while signed in, from any screen. */
export function SubmitReportDialog({ client, onClose }: { client: LedgerClient; onClose: () => void }) {
  const [draft, setDraft] = useState(blank);
  const [named, setNamed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SafetyReportReceipt['receipt'] | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    try {
      const body: SignedInSafetyReport = { ...reportFields(draft), named };
      const answer = await client.request<SafetyReportReceipt>('/v1/safety-reports', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setReceipt(answer.receipt);
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="safety-report-overlay">
      <div className="safety-report-dialog" role="dialog" aria-modal="true" aria-label="Report a safety concern">
        {receipt ? (
          <ReceiptShown receipt={receipt} onDone={onClose} />
        ) : (
          <form className="action-form safety-form" onSubmit={(event) => void submit(event)}>
            <h3>Report a safety concern</h3>
            <p className="safety-form-note">
              Only the people cleared to read safety reports can read it. It is stored as sent through the
              organization&apos;s safety reporting channel: unless you put your name or a way to reach you on it,
              nothing Ledger keeps says it was you.
            </p>
            <ReportFields draft={draft} onChange={setDraft} idPrefix="signed-in-report">
              <label className="safety-report-named">
                <input type="checkbox" checked={named} onChange={(event) => setNamed(event.target.checked)} />
                Put my name on this report
              </label>
            </ReportFields>
            {failure && (
              <Notice tone="alert" title="The report was not sent">
                {failure}
              </Notice>
            )}
            <div className="safety-report-actions">
              <Button kind="primary" type="submit" disabled={pending}>
                {pending ? 'Sending…' : 'Send report'}
              </Button>
              <Button type="button" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const statusWords: Record<SafetyReportStatus['status'], string> = {
  received: 'Received. It is not closed yet.',
  closed: 'Received and closed.',
};

function ReceiptCheck({ client }: { client: LedgerClient }) {
  const [code, setCode] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function check(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const status = await client.request<SafetyReportStatus>('/v1/safety-reports/receipt', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setAnswer(statusWords[status.status]);
    } catch (error) {
      setAnswer(plainError(error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="action-form safety-form" aria-label="Check a report" onSubmit={(event) => void check(event)}>
      <h3>Check a report you sent</h3>
      <label htmlFor="receipt-code">Receipt code</label>
      <input id="receipt-code" value={code} onChange={(event) => setCode(event.target.value)} required />
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Check'}
      </Button>
      {answer && (
        <p role="status" data-testid="receipt-status">
          {answer}
        </p>
      )}
    </form>
  );
}

/** The token of the link this page was opened with: the part after #, which the browser never sends to a server. */
function linkToken(): string | null {
  const fragment = window.location.hash.replace(/^#/, '');
  return fragment ? decodeURIComponent(fragment) : null;
}

/** The page a reporting link opens. It needs no sign-in. Opened without a link, it only checks a receipt code. */
export function PublicReportPage({ apiUrl }: { apiUrl: string }) {
  const [client] = useState(() => new LedgerClient(apiUrl, ''));
  const [token] = useState(linkToken);
  const [draft, setDraft] = useState(blank);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SafetyReportReceipt['receipt'] | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setFailure(null);
    try {
      const body: LinkSafetyReport = { ...reportFields(draft), token };
      const answer = await client.request<SafetyReportReceipt>('/v1/safety-report-links/submissions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setReceipt(answer.receipt);
      setDraft(blank());
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="safety-report-page">
      {receipt ? (
        <ReceiptShown receipt={receipt} />
      ) : token ? (
        <form
          className="action-form safety-form"
          aria-label="Send a safety report"
          onSubmit={(event) => void submit(event)}
        >
          <h2>Send a safety report</h2>
          <p className="safety-form-note">
            You do not sign in, and Ledger keeps no account, address or browser details with what you send. Only the
            people your organization has cleared to read safety reports can read it.
          </p>
          <ReportFields draft={draft} onChange={setDraft} idPrefix="link-report" />
          {failure && (
            <Notice tone="alert" title="The report was not sent">
              {failure}
            </Notice>
          )}
          <Button kind="primary" type="submit" disabled={pending}>
            {pending ? 'Sending…' : 'Send report'}
          </Button>
        </form>
      ) : (
        <p className="safety-form-note">
          To send a report, open the reporting link your organization gave you. You can check a report you already sent
          below.
        </p>
      )}
      <ReceiptCheck client={client} />
    </div>
  );
}

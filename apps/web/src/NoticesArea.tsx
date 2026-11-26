import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  noticeStateValues,
  type NoticeEntry,
  type NoticeKind,
  type NoticeListResponse,
  type NoticeState,
  type NoticeWebhookResponse,
  type NoticeWebhookSetResponse,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { time, timeZoneLabel } from './format.js';
import { plainError } from './sms-labels.js';
import { PlaceLink } from './TopBar.js';
import { placeFromAddress, type NoticesPane } from './place.js';

const stateLabels: Record<NoticeState, string> = {
  waiting: 'Waiting',
  sent: 'Sent',
  failed: 'Failed, to be tried again',
  given_up: 'Given up',
};
const stateTones: Record<NoticeState, 'neutral' | 'observed' | 'attention' | 'alert'> = {
  waiting: 'neutral',
  sent: 'observed',
  failed: 'attention',
  given_up: 'alert',
};
const kindLabels: Record<NoticeKind, string> = {
  assigned: 'Assigned',
  due: 'Due soon',
  overdue: 'Overdue',
  acknowledgement: 'To acknowledge',
  digest: 'Digest',
};

/** The administrator's screens for notices: every notice with its state, and the organization's webhook. */
export function NoticesArea({ client, pane }: { client: LedgerClient; pane: NoticesPane }) {
  const tabs: [NoticesPane, string][] = [
    ['notices', 'Notices'],
    ['webhook', 'Webhook'],
  ];
  return (
    <main className="records-area records-home" aria-label={pane === 'notices' ? 'Notices' : 'Webhook for notices'}>
      <section className="thread-workspace" aria-label={pane === 'notices' ? 'Notices' : 'Webhook for notices'}>
        <div className="thread-main">
          <nav className="records-actions" aria-label="Notices">
            <PlaceLink className="button button--quiet" place={{ section: 'people' }}>
              People
            </PlaceLink>
            {tabs.map(([value, label]) => (
              <PlaceLink
                key={value}
                className="button button--quiet records-toggle"
                place={{ section: 'people', pane: value }}
                current={pane === value}
              >
                {label}
              </PlaceLink>
            ))}
          </nav>
          {pane === 'notices' ? <NoticeList client={client} /> : <NoticeWebhook client={client} />}
        </div>
      </section>
    </main>
  );
}

function NoticeList({ client }: { client: LedgerClient }) {
  const [state, setState] = useState<NoticeState | ''>('');
  const [list, setList] = useState<NoticeListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    let stopped = false;
    setList(null);
    setError(null);
    client
      .notices(state ? { state } : {})
      .then((response) => !stopped && setList(response))
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client, state]);

  const more = async () => {
    if (!list?.nextCursor) return;
    setReading(true);
    try {
      const next = await client.notices({ ...(state ? { state } : {}), cursor: list.nextCursor });
      setList({ ...next, notices: [...list.notices, ...next.notices] });
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <h1>Notices</h1>
      <p className="roster-scope-caption">
        Every email and webhook call Ledger has written for your organization, newest first, with where each stands.
        Times are {timeZoneLabel()}.
      </p>
      <label className="records-field">
        <span>State</span>
        <select value={state} onChange={(event) => setState(event.target.value as NoticeState | '')}>
          <option value="">Every state</option>
          {noticeStateValues.map((value) => (
            <option key={value} value={value}>
              {stateLabels[value]}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <Notice tone="alert" title="Notices are unavailable">
          {error}
        </Notice>
      )}
      {!list && !error && <Spinner label="Loading notices" />}
      {list && !list.notices.length && (
        <Notice tone="neutral">
          {state ? `No notice is ${stateLabels[state].toLowerCase()}.` : 'Ledger has written no notice yet.'}
        </Notice>
      )}
      {list && list.notices.length > 0 && (
        <div className="records-table-scroll">
          <table className="records-table" aria-label="Notices">
            <thead>
              <tr>
                <th scope="col">Written</th>
                <th scope="col">Notice</th>
                <th scope="col">For</th>
                <th scope="col">By</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {list.notices.map((notice) => (
                <NoticeRow key={notice.id} notice={notice} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list?.hasMore && (
        <Button kind="secondary" disabled={reading} onClick={() => void more()}>
          {reading ? 'Reading…' : 'More notices'}
        </Button>
      )}
    </>
  );
}

function NoticeRow({ notice }: { notice: NoticeEntry }) {
  return (
    <tr>
      <td>{time(notice.createdAt, true)}</td>
      <td>
        <strong>{kindLabels[notice.kind]}</strong> {notice.sentence}
        {notice.reference && notice.path && (
          <>
            {' '}
            <PlaceLink place={placeFromAddress(notice.path)}>{notice.reference}</PlaceLink>
          </>
        )}
      </td>
      <td>{notice.recipient.name}</td>
      <td>{notice.channel === 'email' ? 'Email' : 'Webhook'}</td>
      <td>
        <Badge tone={stateTones[notice.state]}>{stateLabels[notice.state]}</Badge>
        {notice.attempts > 0 && (
          <small>
            {' '}
            {notice.attempts === 1 ? '1 attempt' : `${notice.attempts} attempts`}, last{' '}
            {time(notice.lastAttemptAt!, true)}
          </small>
        )}
        {notice.reason && <p className="records-note">{notice.reason}</p>}
      </td>
    </tr>
  );
}

function NoticeWebhook({ client }: { client: LedgerClient }) {
  const [read, setRead] = useState<NoticeWebhookResponse | null>(null);
  const [url, setUrl] = useState('');
  const [issued, setIssued] = useState<NoticeWebhookSetResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    client
      .noticeWebhook()
      .then((response) => {
        if (stopped) return;
        setRead(response);
        setUrl(response.webhook?.url ?? '');
      })
      .catch((failed) => !stopped && setError(plainError(failed).message));
    return () => {
      stopped = true;
    };
  }, [client]);

  const change = async (next: string | null) => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await client.setNoticeWebhook(next);
      setIssued(response.secret ? response : null);
      setRead((current) => (current ? { ...current, webhook: response.webhook } : current));
      if (!next) setUrl('');
    } catch (failed) {
      setFailure(plainError(failed).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void change(url.trim());
  };

  return (
    <>
      <h1>Webhook for notices</h1>
      <p className="roster-scope-caption">
        Ledger posts every assignment, every action due soon or overdue, and every document waiting for someone’s
        acknowledgement to this address, as JSON signed with a secret only your receiver knows. A call names the person
        by their id in Ledger, never by email address, and a safety report or a restricted record by its reference and
        link only.
      </p>
      {error && (
        <Notice tone="alert" title="The webhook is unavailable">
          {error}
        </Notice>
      )}
      {!read && !error && <Spinner label="Loading the webhook" />}
      {read && (
        <dl className="records-fields">
          <dt>Address</dt>
          <dd>{read.webhook ? read.webhook.url : 'None set: no webhook is called'}</dd>
          {read.webhook && (
            <>
              <dt>Set</dt>
              <dd>
                {time(read.webhook.setAt, true)} {timeZoneLabel()} by {read.webhook.setBy.name}
              </dd>
            </>
          )}
        </dl>
      )}
      {issued?.secret && (
        <Notice tone="attention" title="The webhook’s secret">
          <p>
            Copy it now into your receiver. It will not be shown again; setting the webhook again makes a new one and
            the old one stops signing.
          </p>
          <p>
            <code className="people-secret" aria-label="New webhook secret">
              {issued.secret}
            </code>
          </p>
          <div className="records-actions">
            <Button type="button" onClick={() => void navigator.clipboard?.writeText(issued.secret!)}>
              Copy the secret
            </Button>
            <Button type="button" kind="quiet" onClick={() => setIssued(null)}>
              I have kept it
            </Button>
          </div>
        </Notice>
      )}
      {read && (
        <form className="records-form" aria-label="Set the webhook" onSubmit={submit}>
          <label className="records-field">
            <span>Address to post notices to</span>
            <input
              type="url"
              value={url}
              required
              maxLength={2000}
              placeholder="https://hooks.example.org/ledger"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <p className="records-note">
            {read.httpAllowed
              ? 'An https:// address; this local Ledger also posts to http://, such as the emulators’ receiver.'
              : 'An https:// address. Each call waits at most 10 seconds for an answer.'}
          </p>
          {failure && (
            <Notice tone="alert" title="Nothing was changed">
              {failure}
            </Notice>
          )}
          <div className="records-actions">
            <Button kind="primary" type="submit" disabled={busy}>
              {read.webhook ? 'Set it again with a new secret' : 'Set the webhook'}
            </Button>
            {read.webhook && (
              <Button type="button" disabled={busy} onClick={() => void change(null)}>
                Remove the webhook
              </Button>
            )}
          </div>
        </form>
      )}
    </>
  );
}

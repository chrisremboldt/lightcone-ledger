import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  RECORD_LINK_DEFAULT_DAYS,
  RECORD_LINK_MAX_DAYS,
  RECORD_LINK_PAGE,
  type RecordLink,
  type RecordLinkCreated,
  type RecordLinkList,
  type RecordProduction,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { time, timeZoneLabel } from './format.js';
import { ProductionSummary } from './RecordSubjects.js';
import { plainError } from './sms-labels.js';
import { PlaceLink } from './TopBar.js';

const when = (value: string) => `${time(value, true)} ${timeZoneLabel()}`;

const stateLabels: Record<RecordLink['state'], string> = {
  open: 'Opens the set',
  expired: 'Expired',
  revoked: 'Revoked',
};
const openedLabels: Record<RecordLink['openings'][number]['opened'], string> = {
  page: 'The page',
  file: 'A file',
  archive: 'The whole .zip',
};

/**
 * One produced set of records: what it holds, the links made to it with who each is for and whether it still opens
 * the set, and each time a link was opened. Whoever may produce records makes and revokes links here.
 */
export function ProducedSet({ client, id, mayShare }: { client: LedgerClient; id: string; mayShare: boolean }) {
  const [production, setProduction] = useState<RecordProduction | null>(null);
  const [links, setLinks] = useState<RecordLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<RecordLinkCreated | null>(null);
  const [reload, setReload] = useState(0);
  const path = `/v1/record-productions/${encodeURIComponent(id)}`;
  useEffect(() => {
    let stopped = false;
    Promise.all([
      client.request<{ record: RecordProduction }>(path),
      client.request<RecordLinkList>(`${path}/links`),
    ]).then(
      ([shown, listed]) => {
        if (stopped) return;
        setProduction(shown.record);
        setLinks(listed.links);
        setError(null);
      },
      (failure) => !stopped && setError(plainError(failure).message),
    );
    return () => {
      stopped = true;
    };
  }, [client, path, reload]);
  const refresh = () => setReload((value) => value + 1);
  if (error && !production)
    return (
      <Notice tone="alert" title="This produced set could not be read">
        {error}
      </Notice>
    );
  if (!production || !links) return <Spinner label="Reading the produced set" />;
  return (
    <section className="records-list" aria-label="Produced set" data-testid="produced-set">
      <p className="thread-crumbs">
        <PlaceLink place={{ section: 'records', pane: 'produced' }}>Produced records</PlaceLink> /{' '}
        {when(production.producedAt)}
      </p>
      <h2>
        Produced {when(production.producedAt)} for {production.requestedBy}
      </h2>
      <ProductionSummary client={client} production={production} />
      <h3>Links to this set</h3>
      <p className="records-note">
        A link opens this set, and nothing else, to someone who does not sign in: the page names your organization and
        the set and lets them read or download its files. Each opening is kept with its time; who opened it is not.
      </p>
      {made && <MadeLink made={made} onDone={() => setMade(null)} />}
      {mayShare && !made && (
        <MakeLinkForm
          client={client}
          productionId={id}
          onMade={(created) => {
            setMade(created);
            refresh();
          }}
        />
      )}
      {links.length === 0 ? (
        <p className="records-note">No link has been made to this set.</p>
      ) : (
        <ol className="records-items" aria-label="Links">
          {links.map((link) => (
            <li key={link.id} data-testid="record-link">
              <LinkEntry client={client} link={link} mayRevoke={mayShare} onRevoked={refresh} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MakeLinkForm({
  client,
  productionId,
  onMade,
}: {
  client: LedgerClient;
  productionId: string;
  onMade: (made: RecordLinkCreated) => void;
}) {
  const [note, setNote] = useState('');
  const [days, setDays] = useState(String(RECORD_LINK_DEFAULT_DAYS));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const chosen = Number(days);
  const valid = note.trim() !== '' && Number.isInteger(chosen) && chosen >= 1 && chosen <= RECORD_LINK_MAX_DAYS;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      onMade(
        await client.request<RecordLinkCreated>(
          `/v1/record-productions/${encodeURIComponent(productionId)}/links`,
          { method: 'POST', body: JSON.stringify({ note: note.trim(), expiresInDays: chosen }) },
          key,
        ),
      );
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="records-form" aria-label="Make a link" onSubmit={submit}>
      <div className="records-form-grid">
        <label htmlFor="record-link-note">Who the link is for</label>
        <input
          id="record-link-note"
          required
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="A person, office or authority, and why"
        />
        <label htmlFor="record-link-days">Days it opens the set</label>
        <input
          id="record-link-days"
          type="number"
          min={1}
          max={RECORD_LINK_MAX_DAYS}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <p className="records-help">
          {RECORD_LINK_DEFAULT_DAYS} days unless you choose otherwise; {RECORD_LINK_MAX_DAYS} at most.
        </p>
      </div>
      {error && (
        <Notice tone="alert" title="No link was made">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={pending || !valid}>
        {pending ? 'Making the link…' : 'Make a link'}
      </Button>
    </form>
  );
}

/** The address of a link: the web app's page, with the secret after #, which a browser never sends to a server. */
const linkAddress = (secret: string) => `${window.location.origin}${RECORD_LINK_PAGE}#${secret}`;

function MadeLink({ made, onDone }: { made: RecordLinkCreated; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const address = linkAddress(made.secret);
  return (
    <Notice tone="attention" title={`Link made for ${made.link.note}`}>
      <p>
        Copy the link now and give it to them. It will not be shown again: Ledger keeps only a hash of it. It opens the
        set until {when(made.link.expiresAt)} unless you revoke it.
      </p>
      <p>
        <code data-testid="record-link-address">{address}</code>
      </p>
      <Button
        kind="secondary"
        onClick={() =>
          void navigator.clipboard?.writeText(address).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : 'Copy the link'}
      </Button>{' '}
      <Button kind="quiet" onClick={onDone}>
        Done
      </Button>
    </Notice>
  );
}

function LinkEntry({
  client,
  link,
  mayRevoke,
  onRevoked,
}: {
  client: LedgerClient;
  link: RecordLink;
  mayRevoke: boolean;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revoke(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await client.request(`/v1/record-production-links/${encodeURIComponent(link.id)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setRevoking(false);
      onRevoked();
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <article aria-label={`Link for ${link.note}`}>
      <h4>
        {link.note} <Badge tone={link.state === 'open' ? 'observed' : 'neutral'}>{stateLabels[link.state]}</Badge>
      </h4>
      <dl className="records-fields">
        <div>
          <dt>Made</dt>
          <dd>
            {when(link.createdAt)} by {link.createdBy.name}
          </dd>
        </div>
        <div>
          <dt>{link.state === 'expired' ? 'Expired' : 'Expires'}</dt>
          <dd>{when(link.expiresAt)}</dd>
        </div>
        {link.revokedAt && (
          <div>
            <dt>Revoked</dt>
            <dd>
              {when(link.revokedAt)} by {link.revokedBy?.name}: {link.revokeReason}
            </dd>
          </div>
        )}
        <div>
          <dt>Opened</dt>
          <dd>{openedTimes(link.openings.length)}</dd>
        </div>
      </dl>
      {link.openings.length > 0 && (
        <table className="records-preview" aria-label={`Openings of the link for ${link.note}`}>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {link.openings.map((opening, index) => (
              <tr key={`${opening.openedAt}-${index}`}>
                <td>{when(opening.openedAt)}</td>
                <td>
                  {openedLabels[opening.opened]}
                  {opening.path ? `: ${opening.path}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mayRevoke && link.state === 'open' && !revoking && (
        <Button kind="secondary" onClick={() => setRevoking(true)}>
          Revoke this link
        </Button>
      )}
      {revoking && (
        <form className="records-form" aria-label={`Revoke the link for ${link.note}`} onSubmit={revoke}>
          <label htmlFor={`revoke-${link.id}`}>Why it is revoked</label>
          <input id={`revoke-${link.id}`} required value={reason} onChange={(event) => setReason(event.target.value)} />
          {error && (
            <Notice tone="alert" title="The link was not revoked">
              {error}
            </Notice>
          )}
          <Button type="submit" disabled={pending || !reason.trim()}>
            {pending ? 'Revoking…' : 'Revoke at once'}
          </Button>{' '}
          <Button kind="quiet" type="button" onClick={() => setRevoking(false)}>
            Cancel
          </Button>
        </form>
      )}
    </article>
  );
}

/** How often a link was opened, in words. */
export function openedTimes(count: number): string {
  if (count === 0) return 'Not yet';
  return count === 1 ? 'Once' : `${count} times`;
}

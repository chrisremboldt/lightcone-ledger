import { useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  CredentialEntry,
  CredentialListResponse,
  IssuedCredential,
  PrincipalAuthorityEntry,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner, type Tone } from '@ledger/ui';
import { time, timeZoneLabel } from './format.js';
import { kindLabels } from './people.js';
import { plainError } from './sms-labels.js';

/** How long a new credential is accepted; the server checks the time against its own clock. */
const lifetimes = [
  { key: 'none', label: 'Until revoked', days: 0 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: '365', label: 'One year', days: 365 },
] as const;

const states: Record<CredentialEntry['state'], { label: string; tone: Tone }> = {
  usable: { label: 'In use', tone: 'observed' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

const when = (value?: string) => (value ? `${time(value, true)} ${timeZoneLabel()}` : '—');

/**
 * Sources and services: the credentials an adapter, a monitor or another service calls Ledger with. An administrator
 * issues one, sees each one's label, issuer and state, and revokes it. The secret is shown once, when it is issued.
 */
export function SourcesAndServices({
  client,
  principals,
}: {
  client: LedgerClient;
  principals: readonly PrincipalAuthorityEntry[];
}) {
  const [list, setList] = useState<CredentialListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<(IssuedCredential & { name: string }) | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const holders = principals.filter((item) => item.kind === 'source' || item.kind === 'service');

  useEffect(() => {
    let stopped = false;
    client
      .credentials()
      .then((response) => {
        if (stopped) return;
        setList(response);
        setError(null);
      })
      .catch((failure) => !stopped && setError(plainError(failure).message));
    return () => {
      stopped = true;
    };
  }, [client, reload]);

  return (
    <section className="people-credentials" aria-label="Sources and services">
      <h2>Sources and services</h2>
      <p className="roster-scope-caption">
        An adapter, a monitor or another service calls Ledger with a credential. Its secret is shown once, when it is
        issued: Ledger keeps only a hash of it. Issuing and revoking are recorded with who did it.
      </p>
      {error && (
        <Notice tone="alert" title="Credentials are unavailable">
          {error}
        </Notice>
      )}
      {recorded && <Notice tone="observed">{recorded}</Notice>}
      {issued && <IssuedSecret issued={issued} onDone={() => setIssued(null)} />}
      {holders.length === 0 ? (
        <p className="records-note">
          No sources or services yet. Add one with &ldquo;Add a person&rdquo; and the kind &ldquo;A source that reports
          to Ledger&rdquo; or &ldquo;A service&rdquo;, then issue it a credential here.
        </p>
      ) : (
        <IssueCredential
          client={client}
          holders={holders}
          onIssued={(credential, name) => {
            setRecorded(null);
            setIssued({ ...credential, name });
            setReload((value) => value + 1);
          }}
        />
      )}
      {!list && !error && <Spinner label="Loading credentials" />}
      {list && (
        <CredentialTable
          client={client}
          credentials={list.credentials}
          onRevoked={(entry) => {
            setRecorded(`The credential “${entry.label ?? entry.id}” was revoked. The revocation is recorded.`);
            setReload((value) => value + 1);
          }}
        />
      )}
      {list?.hasMore && <p className="records-note">Only the first {list.credentials.length} are listed.</p>}
    </section>
  );
}

function IssuedSecret({ issued, onDone }: { issued: IssuedCredential & { name: string }; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Notice tone="attention" title={`Credential issued to ${issued.name}`}>
      <p>Copy the secret now and store it where the {issued.name} process reads it. It will not be shown again.</p>
      <p>
        <code className="people-secret" aria-label="Credential secret">
          {issued.secret}
        </code>
      </p>
      <p>It is sent as the header &ldquo;Authorization: Bearer &lt;secret&gt;&rdquo;.</p>
      <div className="records-actions">
        <Button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(issued.secret).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy the secret'}
        </Button>
        <Button type="button" kind="quiet" onClick={onDone}>
          I have stored it
        </Button>
      </div>
    </Notice>
  );
}

function IssueCredential({
  client,
  holders,
  onIssued,
}: {
  client: LedgerClient;
  holders: readonly PrincipalAuthorityEntry[];
  onIssued: (credential: IssuedCredential, name: string) => void;
}) {
  const active = holders.filter((item) => item.active);
  const [principalId, setPrincipalId] = useState(active[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [lifetime, setLifetime] = useState<(typeof lifetimes)[number]['key']>('none');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = active.find((item) => item.id === principalId) ?? active[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setFailure(null);
    try {
      const days = lifetimes.find((item) => item.key === lifetime)?.days ?? 0;
      const response = await client.command(
        {
          kind: 'credential.issue',
          principalId: chosen.id,
          label: label.trim(),
          ...(days ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
        },
        crypto.randomUUID(),
      );
      if (!response.credential) throw new Error('The credential was issued but its secret was not returned');
      setLabel('');
      onIssued(response.credential, chosen.name);
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!active.length)
    return (
      <p className="records-note">Every source and service is inactive. Reactivate one to issue it a credential.</p>
    );
  return (
    <form className="records-form people-form" onSubmit={submit} aria-label="Issue a credential">
      <h3>Issue a credential</h3>
      <div className="records-form-grid">
        <label>
          For
          <select value={chosen?.id ?? ''} onChange={(event) => setPrincipalId(event.target.value)}>
            {active.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({kindLabels[item.kind]})
              </option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
            maxLength={200}
            placeholder="What it is for, for example the adapter on the hangar host"
          />
        </label>
        <label>
          Accepted for
          <select value={lifetime} onChange={(event) => setLifetime(event.target.value as typeof lifetime)}>
            {lifetimes.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {failure && (
        <Notice tone="alert" title="No credential was issued">
          {failure}
        </Notice>
      )}
      <div className="records-actions">
        <Button kind="primary" type="submit" disabled={busy || !label.trim()}>
          {busy ? 'Issuing' : 'Issue credential'}
        </Button>
      </div>
    </form>
  );
}

function CredentialTable({
  client,
  credentials,
  onRevoked,
}: {
  client: LedgerClient;
  credentials: CredentialEntry[];
  onRevoked: (entry: CredentialEntry) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const revoke = async (entry: CredentialEntry) => {
    setBusy(true);
    setFailure(null);
    try {
      await client.command({ kind: 'credential.revoke', credentialId: entry.id }, crypto.randomUUID());
      setConfirming(null);
      onRevoked(entry);
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!credentials.length) return <p className="records-note">No credentials have been issued.</p>;
  return (
    <>
      {failure && (
        <Notice tone="alert" title="The credential was not revoked">
          {failure}
        </Notice>
      )}
      <table className="people-credential-table" aria-label="Credentials">
        <thead>
          <tr>
            <th>For</th>
            <th>Label</th>
            <th>Issued</th>
            <th>Expires</th>
            <th>State</th>
            <th>
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((entry) => (
            <tr key={entry.id}>
              <td>
                {entry.principal.name}
                <small className="records-help">
                  {kindLabels[entry.principal.kind]}
                  {entry.principal.active ? '' : ' · inactive, so refused'}
                </small>
              </td>
              <td>{entry.label ?? 'Put on file by the database owner'}</td>
              <td>
                {when(entry.issuedAt)}
                {entry.issuedBy && <small className="records-help">by {entry.issuedBy.name}</small>}
              </td>
              <td>{entry.expiresAt ? when(entry.expiresAt) : 'Until revoked'}</td>
              <td>
                <Badge tone={states[entry.state].tone}>{states[entry.state].label}</Badge>
                {entry.revokedAt && (
                  <small className="records-help">
                    {when(entry.revokedAt)}
                    {entry.revokedBy ? ` by ${entry.revokedBy.name}` : ''}
                  </small>
                )}
              </td>
              <td>
                {entry.state !== 'revoked' &&
                  (confirming === entry.id ? (
                    <span className="records-actions">
                      <Button type="button" kind="primary" disabled={busy} onClick={() => void revoke(entry)}>
                        Revoke now
                      </Button>
                      <Button type="button" kind="quiet" disabled={busy} onClick={() => setConfirming(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button
                      type="button"
                      disabled={busy}
                      aria-label={`Revoke ${entry.label ?? entry.id}`}
                      onClick={() => setConfirming(entry.id)}
                    >
                      Revoke
                    </Button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

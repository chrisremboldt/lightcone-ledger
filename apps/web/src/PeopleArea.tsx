import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { DevelopmentTokenResponse } from '@ledger/contracts/development-tokens';
import {
  rolePresets,
  type Capability,
  type Principal,
  type PrincipalAuthorityEntry,
  type PrincipalAuthorityListResponse,
  type SignInConfiguration,
} from '@ledger/contracts';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import {
  capabilityGroups,
  capabilityLabel,
  keepsRecords,
  kindLabels,
  selfChangeRefusal,
  withRecordGrant,
} from './people.js';
import { plainError } from './sms-labels.js';
import { SourcesAndServices } from './SourcesAndServices.js';

/** The shell's way into the People area. Shown to people who manage authority. */
export function PeopleToggle({
  principal,
  open,
  onToggle,
}: {
  principal: Principal | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!principal?.capabilities.includes('authority:write')) return null;
  return (
    <Button kind="quiet" className="records-toggle" aria-pressed={open} onClick={onToggle}>
      {open ? 'Close people' : 'People'}
    </Button>
  );
}

type Selection = { kind: 'add' } | { kind: 'person'; id: string };

/**
 * People: who is in the organization and what each may do. An administrator adds a person, changes what they may do,
 * and deactivates them. Every change is a recorded command; no one is deleted.
 */
export function PeopleArea({ client, principal }: { client: LedgerClient; principal: Principal | null }) {
  const [list, setList] = useState<PrincipalAuthorityListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'add' });
  const [recorded, setRecorded] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let stopped = false;
    client
      .principalAuthorities()
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

  const signIn = useSignInConfiguration(client);
  const changed = useCallback((message: string, select?: Selection) => {
    setRecorded(message);
    if (select) setSelection(select);
    setReload((value) => value + 1);
  }, []);
  const chosen = selection.kind === 'person' ? list?.principals.find((item) => item.id === selection.id) : undefined;

  return (
    <main className="records-area" aria-label="People">
      <aside className="roster records-nav" aria-label="People list">
        <div className="roster-head">
          <h1>People</h1>
          <p className="roster-scope-caption">
            Everyone in your organization and what each may do. Changes are recorded with who made them.
          </p>
          <Button
            kind={selection.kind === 'add' ? 'primary' : 'secondary'}
            onClick={() => {
              setRecorded(null);
              setSelection({ kind: 'add' });
            }}
          >
            Add a person
          </Button>
        </div>
        {!list && !error && <Spinner label="Loading people" />}
        <ul className="records-items people-list">
          {list?.principals.map((person) => (
            <li key={person.id}>
              <button
                className="records-item"
                aria-current={chosen?.id === person.id ? 'true' : undefined}
                onClick={() => {
                  setRecorded(null);
                  setSelection({ kind: 'person', id: person.id });
                }}
              >
                <span className="records-item-head">
                  <strong>{person.name}</strong>
                  {!person.active && <Badge tone="neutral">Inactive</Badge>}
                </span>
                <span className="records-item-meta">
                  {kindLabels[person.kind]} · {person.capabilities.length} permissions
                  {person.id === principal?.id ? ' · you' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list?.hasMore && <p className="records-note">Only the first {list.principals.length} are listed.</p>}
      </aside>
      <section className="thread-workspace" aria-label="Person">
        <div className="thread-main">
          {error && (
            <Notice tone="alert" title="People are unavailable">
              {error}
            </Notice>
          )}
          {recorded && <Notice tone="observed">{recorded}</Notice>}
          {selection.kind === 'add' && (
            <AddPerson
              client={client}
              issuers={signIn?.issuers ?? []}
              onAdded={(name, id) => changed(`${name} was added. The addition is recorded.`, { kind: 'person', id })}
            />
          )}
          {chosen && (
            <PersonAuthority
              key={`${chosen.id}:${chosen.revision}`}
              client={client}
              person={chosen}
              selfId={principal?.id}
              onChanged={(message) => changed(message)}
            />
          )}
          {chosen?.kind === 'human' && signIn?.developmentTokens && (
            <PersonDevelopmentToken key={chosen.id} client={client} person={chosen} />
          )}
          <SourcesAndServices client={client} principals={list?.principals ?? []} />
        </div>
      </section>
    </main>
  );
}

function CapabilityChoices({
  chosen,
  onChange,
  keeps,
  onKeeps,
}: {
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
  keeps: boolean;
  onKeeps: (keeps: boolean) => void;
}) {
  return (
    <div className="people-capabilities">
      {capabilityGroups.map((group) => (
        <fieldset key={group.title}>
          <legend>{group.title}</legend>
          {group.capabilities.map((item) => (
            <label key={item.value} className="people-capability">
              <input
                type="checkbox"
                checked={chosen.has(item.value)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(item.value);
                  else next.delete(item.value);
                  onChange(next);
                }}
              />
              {item.label}
            </label>
          ))}
        </fieldset>
      ))}
      <fieldset>
        <legend>Operator records</legend>
        <label className="people-capability">
          <input type="checkbox" checked={keeps} onChange={(event) => onKeeps(event.target.checked)} />
          Import and enter operator records (with Submit reports and records)
        </label>
      </fieldset>
    </div>
  );
}

/**
 * How people sign in here: the issuers this deployment accepts, for tying a person to one (none in local development
 * without one), and whether the API accepts development tokens. Null until read.
 */
function useSignInConfiguration(client: LedgerClient): SignInConfiguration | null {
  const [configuration, setConfiguration] = useState<SignInConfiguration | null>(null);
  useEffect(() => {
    let stopped = false;
    client
      .request<SignInConfiguration>('/v1/sign-in')
      .then((read) => !stopped && setConfiguration(read))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [client]);
  return configuration;
}

function AddPerson({
  client,
  issuers,
  onAdded,
}: {
  client: LedgerClient;
  issuers: SignInConfiguration['issuers'];
  onAdded: (name: string, id: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'human' | 'source' | 'service'>('human');
  const [template, setTemplate] = useState('none');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [keeps, setKeeps] = useState(false);
  const [subject, setSubject] = useState('');
  const [issuer, setIssuer] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());

  // With issuers configured the person is tied to one of them; without (local development) any issuer may be typed.
  const chosenIssuer = issuers.length ? issuer || issuers[0]!.issuer : issuer.trim();
  const provider = issuers.find((entry) => entry.issuer === chosenIssuer);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const response = await client.command(
        {
          kind: 'person.add',
          name: name.trim(),
          principalKind: kind,
          capabilities: [...chosen] as Capability[],
          ...(keeps ? { observationGrants: withRecordGrant([], true) } : {}),
          ...(kind === 'human' && subject.trim()
            ? { signIn: { subject: subject.trim(), ...(chosenIssuer ? { issuer: chosenIssuer } : {}) } }
            : {}),
        },
        key,
      );
      setKey(crypto.randomUUID());
      onAdded(name.trim(), String(response.command.payload.principalId));
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="records-form people-form" onSubmit={submit} aria-label="Add a person">
      <h2>Add a person</h2>
      <div className="records-form-grid">
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="human">A person</option>
            <option value="source">A source that reports to Ledger</option>
            <option value="service">A service</option>
          </select>
        </label>
        <label>
          Start from
          <select
            value={template}
            onChange={(event) => {
              const picked = rolePresets.find((item) => item.key === event.target.value)!;
              setTemplate(picked.key);
              setChosen(new Set(picked.capabilities));
              setKeeps(picked.keepsRecords);
            }}
          >
            {rolePresets.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}
              </option>
            ))}
          </select>
          <small>Ticks the usual boxes for that role. Change any of them before adding.</small>
        </label>
        {kind === 'human' && (
          <>
            {issuers.length > 1 && (
              <label>
                Signs in through
                <select value={chosenIssuer} onChange={(event) => setIssuer(event.target.value)}>
                  {issuers.map((entry) => (
                    <option key={entry.issuer} value={entry.issuer}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Sign-in account (subject)
              <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} />
              <small>
                The person&rsquo;s user id at {provider ? provider.label : 'your identity provider'}: the subject (sub)
                of the tokens it issues for them. Leave empty if they will not sign in yet.
              </small>
            </label>
            {!issuers.length && (
              <label>
                Sign-in issuer (optional)
                <input
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="The same as yours"
                  maxLength={500}
                />
              </label>
            )}
          </>
        )}
      </div>
      <CapabilityChoices chosen={chosen} onChange={setChosen} keeps={keeps} onKeeps={setKeeps} />
      {failure && (
        <Notice tone="alert" title="The person was not added">
          {failure}
        </Notice>
      )}
      <div className="records-actions">
        <Button kind="primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Adding' : 'Add person'}
        </Button>
      </div>
    </form>
  );
}

function PersonAuthority({
  client,
  person,
  selfId,
  onChanged,
}: {
  client: LedgerClient;
  person: PrincipalAuthorityEntry;
  selfId: string | undefined;
  onChanged: (message: string) => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(person.capabilities));
  const [keeps, setKeeps] = useState(() => keepsRecords(person));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Deactivating or reactivating keeps what the person may do; saving takes the boxes as ticked.
  const update = async (active: boolean, message: string, capabilities: Capability[], keepsShown: boolean) => {
    const refusal = selfChangeRefusal(selfId, person, { capabilities, active });
    if (refusal) {
      setFailure(refusal);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await client.command(
        {
          kind: 'authority.update',
          principalId: person.id,
          expectedRevision: person.revision,
          capabilities,
          active,
          observationGrants: withRecordGrant(person.observationGrants, keepsShown),
        },
        crypto.randomUUID(),
      );
      onChanged(message);
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="records-form people-form"
      aria-label={`What ${person.name} may do`}
      onSubmit={(event) => {
        event.preventDefault();
        void update(
          person.active,
          `What ${person.name} may do was changed. The change is recorded.`,
          [...chosen] as Capability[],
          keeps,
        );
      }}
    >
      <h2>{person.name}</h2>
      <dl className="records-fields">
        <dt>Kind</dt>
        <dd>{kindLabels[person.kind]}</dd>
        <dt>Status</dt>
        <dd>{person.active ? 'Active' : 'Inactive: cannot sign in or act'}</dd>
        <dt>Sign-in</dt>
        <dd>{person.signInLinked ? 'Tied to an identity-provider account' : 'No identity-provider account tied'}</dd>
        <dt>May do now</dt>
        <dd>{person.capabilities.length ? person.capabilities.map(capabilityLabel).join(', ') : 'Nothing'}</dd>
      </dl>
      <CapabilityChoices chosen={chosen} onChange={setChosen} keeps={keeps} onKeeps={setKeeps} />
      {failure && (
        <Notice tone="alert" title="Nothing was changed">
          {failure}
        </Notice>
      )}
      <div className="records-actions">
        <Button kind="primary" type="submit" disabled={busy}>
          Save what they may do
        </Button>
        {person.active ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void update(
                false,
                `${person.name} was deactivated. The change is recorded.`,
                person.capabilities,
                keepsRecords(person),
              )
            }
          >
            Deactivate
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void update(
                true,
                `${person.name} was reactivated. The change is recorded.`,
                person.capabilities,
                keepsRecords(person),
              )
            }
          >
            Reactivate
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * A person's development token, on a local or test database only: shown once when issued, and replacing any token
 * they held, which stops working at once. The API reports whether it accepts development tokens.
 */
function PersonDevelopmentToken({ client, person }: { client: LedgerClient; person: PrincipalAuthorityEntry }) {
  const [issued, setIssued] = useState<DevelopmentTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const issue = async () => {
    setBusy(true);
    setFailure(null);
    setCopied(false);
    try {
      setIssued(await client.issueDevelopmentToken(person.id));
    } catch (error) {
      setFailure(plainError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="people-credentials" aria-label={`Development token for ${person.name}`}>
      <h3>Development token</h3>
      <p className="roster-scope-caption">
        On this local Ledger, {person.name} signs in with a development token: on the sign-in screen they choose
        &ldquo;Use a development token&rdquo; and paste it. Issuing one replaces any token they hold now, which stops
        working at once. The token is shown once; Ledger keeps only a hash of it. Development tokens are for a trial on
        a computer that faces no network.
      </p>
      {issued && (
        <Notice tone="attention" title={`Development token issued to ${person.name}`}>
          <p>Copy it now and give it to {person.name}. It will not be shown again. The issue is recorded.</p>
          <p>
            <code className="people-secret" aria-label="New development token">
              {issued.developmentToken.token}
            </code>
          </p>
          {issued.replacedCredentialIds.length > 0 && <p>The token {person.name} held before no longer works.</p>}
          <div className="records-actions">
            <Button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(issued.developmentToken.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? 'Copied' : 'Copy the token'}
            </Button>
            <Button type="button" kind="quiet" onClick={() => setIssued(null)}>
              I have given it to them
            </Button>
          </div>
        </Notice>
      )}
      {failure && (
        <Notice tone="alert" title="No token was issued">
          {failure}
        </Notice>
      )}
      {person.active ? (
        <div className="records-actions">
          <Button type="button" disabled={busy} onClick={() => void issue()}>
            {busy ? 'Issuing' : 'Issue a development token'}
          </Button>
        </div>
      ) : (
        <p className="records-note">{person.name} is inactive. Reactivate them to issue a token.</p>
      )}
    </section>
  );
}

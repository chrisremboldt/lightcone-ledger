import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import {
  MISSION_BRIEFING_MAX_RECIPIENTS,
  type OrganizationPeopleResponse,
  type OrganizationPerson,
} from '@ledger/contracts';
import { Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage, shortId, time, timeZoneLabel } from './format.js';
import { readFailureOutcome } from './read-failure.js';

interface Props {
  client: LedgerClient;
  cacheScope: string;
  value: OrganizationPerson[];
  onChange: (people: OrganizationPerson[]) => void;
  disabled?: boolean;
  onAccessLost: () => void;
}
interface Scope {
  client: LedgerClient;
  cacheScope: string;
}
interface DirectoryRead extends Scope {
  search: string;
  cursor: string | undefined;
  response: OrganizationPeopleResponse;
}
interface ReadFailure extends Scope {
  search: string;
  cursor: string | undefined;
  text: string;
}
const seenPeopleLimit = 100;
const personName = (person: OrganizationPerson) => person.name.trim() || 'Unnamed person';
const nameKey = (person: OrganizationPerson) => person.name.trim().toLowerCase();
const sameIdentity = (left: OrganizationPerson, right: OrganizationPerson) =>
  left.id === right.id && left.name === right.name && left.revision === right.revision;

export function RecipientPicker({ client, cacheScope, value, onChange, disabled = false, onAccessLost }: Props) {
  const searchId = useId();
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [stored, setStored] = useState<DirectoryRead | null>(null);
  const [seen, setSeen] = useState<(Scope & { people: OrganizationPerson[] }) | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [accessLost, setAccessLost] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const activeScope = useRef({ client, cacheScope });
  const callbacks = useRef({ onAccessLost });
  activeScope.current = { client, cacheScope };
  callbacks.current = { onAccessLost };

  const blocked = accessLost?.client === client && accessLost.cacheScope === cacheScope;
  const changingSearch = filter.trim() !== search;
  const directory =
    !blocked &&
    !changingSearch &&
    stored?.client === client &&
    stored.cacheScope === cacheScope &&
    stored.search === search &&
    stored.cursor === cursor
      ? stored.response
      : null;
  const error =
    failure?.client === client &&
    failure.cacheScope === cacheScope &&
    failure.search === search &&
    failure.cursor === cursor
      ? failure.text
      : null;

  useEffect(() => {
    setFilter('');
    setSearch('');
    setCursor(undefined);
    setStored(null);
    setSeen(null);
    setFailure(null);
    setAccessLost(null);
    setNotice(null);
  }, [client, cacheScope]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = filter.trim();
      if (next === search) return;
      setSearch(next);
      setCursor(undefined);
      setNotice(null);
    }, 250);
    return () => clearTimeout(timer);
  }, [filter, search]);

  useEffect(() => {
    let stopped = false;
    const current = () =>
      !stopped && activeScope.current.client === client && activeScope.current.cacheScope === cacheScope;
    setBusy(true);
    setFailure(null);
    async function read() {
      try {
        const response = await client.organizationPeople({
          limit: 25,
          ...(search ? { search } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (!current()) return;
        if (cursor && response.page.nextCursor === cursor)
          throw new Error('The people directory did not advance. Refresh this page before continuing.');
        setStored({ client, cacheScope, search, cursor, response });
        setSeen((previous) => {
          const people = new Map<string, OrganizationPerson>();
          for (const person of previous?.client === client && previous.cacheScope === cacheScope ? previous.people : [])
            people.set(person.id, person);
          for (const person of response.people) {
            people.delete(person.id);
            people.set(person.id, person);
          }
          return { client, cacheScope, people: [...people.values()].slice(-seenPeopleLimit) };
        });
        setAccessLost(null);
      } catch (error) {
        if (!current()) return;
        const code = error instanceof ApiError ? (error.body as { error?: { code?: string } })?.error?.code : undefined;
        // The directory names no record the API could hide behind a 404.
        if (readFailureOutcome(error, false) === 'access_lost') {
          setStored(null);
          setSeen(null);
          setAccessLost({ client, cacheScope });
          setFailure({ client, cacheScope, search, cursor, text: errorMessage(error) });
          callbacks.current.onAccessLost();
        } else if (cursor && ['cursor_scope_mismatch', 'invalid_history_cursor'].includes(code ?? '')) {
          setStored(null);
          setCursor(undefined);
          setNotice('The directory changed. The search restarted from its first page; your selections are retained.');
        } else {
          setFailure({ client, cacheScope, search, cursor, text: errorMessage(error) });
        }
      } finally {
        if (current()) setBusy(false);
      }
    }
    void read();
    return () => {
      stopped = true;
    };
  }, [client, cacheScope, search, cursor, reload]);

  const selected = blocked ? [] : value;
  const selectedById = new Map(selected.map((person) => [person.id, person]));
  const encountered = seen?.client === client && seen.cacheScope === cacheScope ? seen.people : [];
  const latestById = new Map(encountered.map((person) => [person.id, person]));
  const duplicateNames = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const person of [...encountered, ...selected]) {
      const key = nameKey(person);
      const ids = names.get(key) ?? new Set<string>();
      ids.add(person.id);
      names.set(key, ids);
    }
    return new Set([...names].filter(([, ids]) => ids.size > 1).map(([name]) => name));
  }, [encountered, selected]);

  function remove(id: string) {
    onChange(value.filter((person) => person.id !== id));
  }

  function select(person: OrganizationPerson, checked: boolean) {
    if (disabled || blocked) return;
    if (!checked) remove(person.id);
    else if (!selectedById.has(person.id) && value.length < MISSION_BRIEFING_MAX_RECIPIENTS)
      onChange([...value, structuredClone(person)]);
  }

  return (
    <div className="recipient-picker-wrapper">
      <fieldset className="recipient-picker" disabled={disabled || blocked}>
        <legend>Recipients</legend>
        {!blocked && (
          <div className="recipient-picker-selected">
            <strong>
              Selected · {selected.length} / {MISSION_BRIEFING_MAX_RECIPIENTS}
            </strong>
            {selected.length ? (
              <ul>
                {selected.map((person) => {
                  const latest = latestById.get(person.id);
                  const changed = latest && !sameIdentity(person, latest);
                  return (
                    <li key={person.id} className="recipient-picker-selection">
                      <div className="recipient-picker-person-heading">
                        <PersonLabel person={person} duplicate={duplicateNames.has(nameKey(person))} />
                        <Button
                          type="button"
                          kind="quiet"
                          aria-label={`Remove ${personName(person)}${duplicateNames.has(nameKey(person)) ? ` · identity ${shortId(person.id)}` : ''}`}
                          onClick={() => remove(person.id)}
                        >
                          Remove
                        </Button>
                      </div>
                      <IdentityDetails person={person} />
                      {changed && (
                        <div className="recipient-picker-identity-change">
                          <p>
                            The current directory identity changed to {personName(latest)} · revision {latest.revision}.
                            Your selection still shows the identity you chose.
                          </p>
                          <Button
                            type="button"
                            kind="quiet"
                            onClick={() =>
                              onChange(value.map((entry) => (entry.id === person.id ? structuredClone(latest) : entry)))
                            }
                          >
                            Review updated identity
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>Choose the people who will review this exact briefing.</p>
            )}
            <p className="recipient-picker-note">
              The accepted briefing retains each recipient’s identity at recording. These selections do not identify all
              operational crew.
            </p>
          </div>
        )}
        <label htmlFor={searchId}>Find people</label>
        <input
          id={searchId}
          type="search"
          maxLength={200}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search names"
          autoComplete="off"
        />
        {blocked ? (
          <Notice tone="alert" title="People access changed">
            Private directory options were cleared. Refresh your access before choosing recipients.
          </Notice>
        ) : (
          <>
            {notice && (
              <p className="recipient-picker-note" role="status">
                {notice}
              </p>
            )}
            {error && (
              <Notice tone="attention" title="People directory unavailable">
                {error} {directory && 'The last loaded page remains visible.'}
                <Button
                  type="button"
                  kind="quiet"
                  disabled={busy}
                  onClick={() => setReload((previous) => previous + 1)}
                >
                  Retry people
                </Button>
              </Notice>
            )}
            {(busy || changingSearch) && (
              <Spinner label={changingSearch || search ? 'Searching people' : 'Loading people'} />
            )}
            {directory && (
              <>
                <p className="recipient-picker-page-note">
                  {directory.page.returned} people on this page{directory.page.hasMore ? ' · more available' : ''} ·
                  checked {time(directory.meta.computedAt)} {timeZoneLabel()}
                </p>
                {directory.people.length ? (
                  <ul className="recipient-picker-results" aria-label="Available people">
                    {directory.people.map((person) => {
                      const chosen = selectedById.has(person.id);
                      return (
                        <li className="recipient-picker-result" key={person.id}>
                          <label className="recipient-picker-option">
                            <input
                              type="checkbox"
                              checked={chosen}
                              disabled={!chosen && value.length >= MISSION_BRIEFING_MAX_RECIPIENTS}
                              onChange={(event) => select(person, event.target.checked)}
                            />
                            <PersonLabel person={person} duplicate={duplicateNames.has(nameKey(person))} />
                          </label>
                          <IdentityDetails person={person} />
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="recipient-picker-empty">
                    {search
                      ? 'No active people match this name search on this page.'
                      : 'No active people appear on this page.'}{' '}
                    Try another search or refresh the first page.
                  </p>
                )}
              </>
            )}
            {value.length >= MISSION_BRIEFING_MAX_RECIPIENTS && (
              <p className="recipient-picker-note" role="status">
                You selected {MISSION_BRIEFING_MAX_RECIPIENTS} people. Remove someone before adding another recipient.
              </p>
            )}
            <div className="recipient-picker-navigation">
              <Button
                type="button"
                kind="quiet"
                disabled={busy || changingSearch}
                onClick={() => {
                  setCursor(undefined);
                  setReload((previous) => previous + 1);
                  setNotice(null);
                }}
              >
                First page
              </Button>
              <Button
                type="button"
                kind="quiet"
                disabled={busy || changingSearch || !directory?.page.nextCursor}
                onClick={() => {
                  if (directory?.page.nextCursor) {
                    setCursor(directory.page.nextCursor);
                    setNotice(null);
                  }
                }}
              >
                More people
              </Button>
            </div>
          </>
        )}
      </fieldset>
      {blocked && (
        <Button
          type="button"
          kind="quiet"
          disabled={disabled || busy}
          onClick={() => setReload((previous) => previous + 1)}
        >
          {busy ? 'Refreshing access…' : 'Refresh people'}
        </Button>
      )}
    </div>
  );
}

function PersonLabel({ person, duplicate }: { person: OrganizationPerson; duplicate: boolean }) {
  return (
    <span className="recipient-picker-person-name">
      {personName(person)}
      {duplicate && <small className="recipient-picker-identity-suffix"> · identity {shortId(person.id)}</small>}
    </span>
  );
}

function IdentityDetails({ person }: { person: OrganizationPerson }) {
  return (
    <details className="recipient-picker-identity">
      <summary>Identity details</summary>
      <dl>
        <div>
          <dt>Principal ID</dt>
          <dd className="mono">{person.id}</dd>
        </div>
        <div>
          <dt>Displayed revision</dt>
          <dd>{person.revision}</dd>
        </div>
      </dl>
    </details>
  );
}

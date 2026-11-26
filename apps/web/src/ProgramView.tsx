import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  PROGRAM_GRANT_DEFAULT_DAYS,
  PROGRAM_GRANT_MAX_DAYS,
  PROGRAM_GRANT_PACK_LIMIT,
  PROGRAM_GRANT_PRODUCTION_LIMIT,
  RECORD_LINK_PAGE,
  readsOnly,
  type OrganizationCoverageResponse,
  type Principal,
  type ProgramGrant,
  type ProgramGrantCreated,
  type ProgramOperator,
  type ProgramOperatorAnswer,
  type ProgramOperatorList,
  type ProgramViewDocument,
  type RecordProductionListResponse,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { counted, ctDay, time, timeZoneLabel } from './format.js';
import { coverageCells, coverageColumns } from './program-view-table.js';
import { plainError } from './sms-labels.js';

/**
 * A program owner's view of the operators it contracts (docs/design/program-owner-view.md). The operator's side: the
 * grants it made, what each covers and each read. The program owner's side: the operators it follows, side by side,
 * each with the counts its Ledger last answered and when. No score, no ranking: operators are in alphabetical order.
 */

const when = (value: string) => `${time(value, true)} ${timeZoneLabel()}`;
const may = (principal: Principal | null, capability: string) =>
  Boolean(principal?.capabilities.includes(capability as never));

const grantStateLabels: Record<ProgramGrant['state'], string> = {
  in_force: 'In force',
  expired: 'Expired',
  revoked: 'Revoked',
};
const operatorStateLabels: Record<ProgramOperator['state'], string> = {
  read: 'Read',
  late: 'Not read lately',
  failed: 'Last read failed',
  ended: 'Grant ended',
  not_read: 'Not read yet',
};
const outcomeLabels: Record<ProgramOperatorAnswer['outcome'], string> = {
  answered: 'Answered and kept',
  not_in_use: 'The grant opens nothing',
  failed: 'Failed',
};

function useLoaded<T>(read: () => Promise<T>, reload: number | string) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    read().then(
      (loaded) => {
        if (!current) return;
        setValue(loaded);
        setError(null);
      },
      (failure) => current && setError(plainError(failure).message),
    );
    return () => {
      current = false;
    };
    // The reload counter names everything the read depends on.
  }, [reload]);
  return { value, error };
}

function Copy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      kind="secondary"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

function ReasonForm({
  label,
  submitLabel,
  failedTitle,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  failedTitle: string;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id] = useState(() => `reason-${crypto.randomUUID()}`);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="records-form" aria-label={label} onSubmit={submit}>
      <div className="records-form-grid">
        <label htmlFor={id}>{label}</label>
        <input id={id} required value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      {error && (
        <Notice tone="alert" title={failedTitle}>
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={pending || !reason.trim()}>
        {submitLabel}
      </Button>{' '}
      <Button kind="quiet" type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

// --- The operator's side ---

export function ProgramGrantsPage({ client, principal }: { client: LedgerClient; principal: Principal | null }) {
  const [reload, setReload] = useState(0);
  const [made, setMade] = useState<ProgramGrantCreated | null>(null);
  const manages = may(principal, 'authority:write');
  // The person's capabilities may arrive after the page opens: the grants are read again once they do.
  const grants = useLoaded(
    () => (manages ? client.programGrants() : Promise.resolve({ grants: [] })),
    `${reload}-${manages}`,
  );
  return (
    <>
      <p className="thread-crumbs">Reports / Shown to program owners</p>
      <h2>Shown to program owners</h2>
      <p className="overview-purpose">
        A grant lets an organization that contracts you, a program owner, read how you stand: the coverage of the packs
        you name, your open findings by rule, and the produced sets you name. Counts only, never a subject, a person or
        a safety report. It ends when it expires or when you revoke it, and each read is kept with its time.
      </p>
      {!manages ? (
        <Notice tone="neutral" title="Not yours to make">
          Grants are made by the person who manages authority in your organization.
        </Notice>
      ) : (
        <>
          {made ? (
            <MadeGrant made={made} onDone={() => setMade(null)} />
          ) : (
            <MakeGrantForm
              client={client}
              onMade={(created) => {
                setMade(created);
                setReload((value) => value + 1);
              }}
            />
          )}
          <h3>Grants</h3>
          {grants.error && (
            <Notice tone="alert" title="The grants could not be read">
              {grants.error}
            </Notice>
          )}
          {!grants.value && !grants.error && <Spinner label="Reading the grants" />}
          {grants.value && grants.value.grants.length === 0 && <p className="records-note">No grant has been made.</p>}
          {grants.value && grants.value.grants.length > 0 && (
            <ol className="records-items" aria-label="Grants">
              {grants.value.grants.map((grant) => (
                <li key={grant.id} data-testid="program-grant">
                  <GrantEntry client={client} grant={grant} onRevoked={() => setReload((value) => value + 1)} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}

function MakeGrantForm({ client, onMade }: { client: LedgerClient; onMade: (made: ProgramGrantCreated) => void }) {
  const [programOwner, setProgramOwner] = useState('');
  const [days, setDays] = useState(String(PROGRAM_GRANT_DEFAULT_DAYS));
  const [packs, setPacks] = useState<string[]>([]);
  const [openFindings, setOpenFindings] = useState(false);
  const [productions, setProductions] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const choices = useLoaded(
    () =>
      Promise.all([
        client.request<OrganizationCoverageResponse>('/v1/organization/coverage'),
        client.request<RecordProductionListResponse>('/v1/record-productions'),
      ]),
    0,
  );
  const adopted = choices.value
    ? [
        ...new Map(
          choices.value[0].adoptions
            .filter((adoption) => adoption.state === 'effective')
            .map((adoption) => [adoption.pack.packId, adoption.pack.title] as const),
        ),
      ]
    : [];
  const sets = choices.value ? choices.value[1].records.slice(0, 50) : [];
  const chosen = Number(days);
  const valid =
    programOwner.trim() !== '' &&
    Number.isInteger(chosen) &&
    chosen >= 1 &&
    chosen <= PROGRAM_GRANT_MAX_DAYS &&
    (packs.length > 0 || openFindings || productions.length > 0);
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...list.filter((entry) => entry !== value), value] : list.filter((entry) => entry !== value);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      onMade(
        await client.createProgramGrant(
          { programOwner: programOwner.trim(), expiresInDays: chosen, packs, openFindings, productions },
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
    <form className="records-form report-card" aria-label="Make a grant" onSubmit={submit}>
      <h3>Make a grant</h3>
      <div className="records-form-grid">
        <label htmlFor="program-grant-owner">Program owner</label>
        <input
          id="program-grant-owner"
          required
          value={programOwner}
          onChange={(event) => setProgramOwner(event.target.value)}
          placeholder="The organization that contracts you"
        />
        <label htmlFor="program-grant-days">Days it answers</label>
        <input
          id="program-grant-days"
          type="number"
          min={1}
          max={PROGRAM_GRANT_MAX_DAYS}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <p className="records-help">
          {PROGRAM_GRANT_DEFAULT_DAYS} days unless you choose otherwise; {PROGRAM_GRANT_MAX_DAYS} at most.
        </p>
      </div>
      {choices.error && (
        <Notice tone="alert" title="Your packs and produced sets could not be read">
          {choices.error}
        </Notice>
      )}
      <fieldset className="program-choices">
        <legend>Coverage of these packs, by rule and result</legend>
        {adopted.length === 0 && <p className="records-note">No pack is adopted now.</p>}
        {adopted.map(([packId, title]) => (
          <label key={packId}>
            <input
              type="checkbox"
              checked={packs.includes(packId)}
              disabled={!packs.includes(packId) && packs.length >= PROGRAM_GRANT_PACK_LIMIT}
              onChange={(event) => setPacks(toggle(packs, packId, event.target.checked))}
            />{' '}
            {title}
          </label>
        ))}
      </fieldset>
      <fieldset className="program-choices">
        <legend>Open findings</legend>
        <label>
          <input type="checkbox" checked={openFindings} onChange={(event) => setOpenFindings(event.target.checked)} />{' '}
          How many are open for each rule, and the oldest one’s age
        </label>
      </fieldset>
      <fieldset className="program-choices">
        <legend>Produced sets, each with a link that ends with the grant</legend>
        {sets.length === 0 && <p className="records-note">No records have been produced.</p>}
        {sets.map((set) => (
          <label key={set.id}>
            <input
              type="checkbox"
              checked={productions.includes(set.id)}
              disabled={!productions.includes(set.id) && productions.length >= PROGRAM_GRANT_PRODUCTION_LIMIT}
              onChange={(event) => setProductions(toggle(productions, set.id, event.target.checked))}
            />{' '}
            {when(set.producedAt)}: {set.reason} ({counted(set.counts.records, 'record')})
          </label>
        ))}
      </fieldset>
      {error && (
        <Notice tone="alert" title="No grant was made">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={pending || !valid}>
        {pending ? 'Making the grant…' : 'Make the grant'}
      </Button>
    </form>
  );
}

function MadeGrant({ made, onDone }: { made: ProgramGrantCreated; onDone: () => void }) {
  const address = window.location.origin;
  return (
    <Notice tone="attention" title={`Grant made to ${made.grant.programOwner}`}>
      <p>
        Give the program owner this Ledger’s address and the secret now. The secret will not be shown again: Ledger
        keeps only a hash of it. The grant answers until {when(made.grant.expiresAt)} unless you revoke it.
      </p>
      <dl className="records-fields">
        <div>
          <dt>Address</dt>
          <dd>
            <code data-testid="program-grant-address">{address}</code>
          </dd>
        </div>
        <div className="program-secret">
          <dt>Secret</dt>
          <dd>
            <code data-testid="program-grant-secret">{made.secret}</code>
          </dd>
        </div>
      </dl>
      <Copy text={made.secret} label="Copy the secret" /> <Copy text={address} label="Copy the address" />{' '}
      <Button kind="quiet" onClick={onDone}>
        Done
      </Button>
    </Notice>
  );
}

function partLabel(part: string, grant: ProgramGrant): string {
  if (part === 'open_findings') return 'Open findings';
  if (part.startsWith('pack:')) {
    const packId = part.slice('pack:'.length);
    return `Coverage of ${grant.covers.packs.find((pack) => pack.packId === packId)?.title ?? packId}`;
  }
  const productionId = part.slice('records:'.length);
  const set = grant.covers.productions.find((production) => production.id === productionId);
  return set ? `The set produced ${when(set.producedAt)}` : 'A produced set';
}

function GrantEntry({
  client,
  grant,
  onRevoked,
}: {
  client: LedgerClient;
  grant: ProgramGrant;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  return (
    <article aria-label={`Grant to ${grant.programOwner}`}>
      <h4>
        {grant.programOwner}{' '}
        <Badge tone={grant.state === 'in_force' ? 'observed' : 'neutral'}>{grantStateLabels[grant.state]}</Badge>
      </h4>
      <dl className="records-fields">
        <div>
          <dt>Made</dt>
          <dd>
            {when(grant.createdAt)} by {grant.createdBy.name}
          </dd>
        </div>
        <div>
          <dt>{grant.state === 'expired' ? 'Expired' : 'Expires'}</dt>
          <dd>{when(grant.expiresAt)}</dd>
        </div>
        {grant.revokedAt && (
          <div>
            <dt>Revoked</dt>
            <dd>
              {when(grant.revokedAt)} by {grant.revokedBy?.name}: {grant.revokeReason}
            </dd>
          </div>
        )}
        <div>
          <dt>Covers</dt>
          <dd>
            <ul className="program-covers">
              {grant.covers.packs.map((pack) => (
                <li key={pack.packId}>Coverage of {pack.title}</li>
              ))}
              {grant.covers.openFindings && <li>Open findings by rule</li>}
              {grant.covers.productions.map((set) => (
                <li key={set.id}>
                  The set produced {when(set.producedAt)} ({counted(set.records, 'record')})
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Read</dt>
          <dd>{grant.readCount ? `${grant.readCount} ${grant.readCount === 1 ? 'time' : 'times'}` : 'Not yet'}</dd>
        </div>
      </dl>
      {grant.reads.length > 0 && (
        <details className="report-table">
          <summary>Each read, newest first</summary>
          <div className="program-table">
            <table className="report-numbers" aria-label={`Reads of the grant to ${grant.programOwner}`}>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What was read</th>
                </tr>
              </thead>
              <tbody>
                {grant.reads.map((read, index) => (
                  <tr key={`${read.readAt}-${index}`}>
                    <th scope="row">{when(read.readAt)}</th>
                    <td>{read.parts.map((part) => partLabel(part, grant)).join('; ') || 'Nothing in force'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {grant.state === 'in_force' && !revoking && (
        <Button kind="secondary" onClick={() => setRevoking(true)}>
          Revoke this grant
        </Button>
      )}
      {revoking && (
        <ReasonForm
          label="Why it is revoked"
          submitLabel="Revoke at once"
          failedTitle="The grant was not revoked"
          onCancel={() => setRevoking(false)}
          onSubmit={async (reason) => {
            await client.revokeProgramGrant(grant.id, reason);
            setRevoking(false);
            onRevoked();
          }}
        />
      )}
    </article>
  );
}

// --- The program owner's side ---

export function ProgramOperatorsPage({ client, principal }: { client: LedgerClient; principal: Principal | null }) {
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((value) => value + 1);
  const listed = useLoaded(() => client.programOperators(), reload);
  const manages = may(principal, 'authority:write');
  const asks = Boolean(principal && !readsOnly(principal.capabilities));
  return (
    <>
      <p className="thread-crumbs">Reports / Operators you follow</p>
      <h2>Operators you follow</h2>
      <p className="overview-purpose">
        What each operator’s own Ledger answered under the grant it gave you, in alphabetical order. Counts of recorded
        things only, each with when it was read. Ledger reads each operator every hour.
      </p>
      <p>
        <Button kind="secondary" onClick={refresh}>
          Show the latest reads
        </Button>
      </p>
      {listed.error && (
        <Notice tone="alert" title="The operators could not be read">
          {listed.error}
        </Notice>
      )}
      {!listed.value && !listed.error && <Spinner label="Reading the operators you follow" />}
      {listed.value && (
        <>
          {listed.value.operators.length === 0 ? (
            <p className="records-note">You follow no operator yet.</p>
          ) : (
            <div className="program-operators" data-testid="program-operators">
              {listed.value.operators.map((operator) => (
                <OperatorCard
                  key={operator.id}
                  client={client}
                  operator={operator}
                  asks={asks}
                  manages={manages}
                  onChange={refresh}
                />
              ))}
            </div>
          )}
          {manages && <FollowForm client={client} list={listed.value} onAdded={refresh} />}
          {listed.value.removed.length > 0 && (
            <details className="report-table">
              <summary>No longer followed</summary>
              <ul className="program-covers">
                {listed.value.removed.map((removed) => (
                  <li key={removed.id}>
                    {removed.name}: removed {when(removed.removedAt)} by {removed.removedBy.name}. {removed.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}

/** What a row says of an operator, in words: never a current count from a read that failed or a grant that ended. */
function stateSentence(operator: ProgramOperator): string {
  const last = operator.lastRead;
  const answer = operator.lastAnswer;
  const shown = answer
    ? ` Shown below: the answer read ${when(answer.readAt)}, not as current.`
    : ' No answer is kept.';
  switch (operator.state) {
    case 'not_read':
      return 'Not read yet. Ledger reads it within the hour.';
    case 'read':
      return `Read ${when(last!.readAt)}. The grant answers until ${when(answer!.document.grantExpiresAt)}.`;
    case 'late':
      return `Last read ${when(last!.readAt)}, and not since: these counts may have changed.`;
    case 'failed':
      return `The last read, ${when(last!.readAt)}, failed: ${last!.reason ?? 'no reason was kept'}.${shown}`;
    case 'ended':
      return last?.outcome === 'not_in_use'
        ? `On ${when(last.readAt)} the operator’s Ledger answered that this grant opens nothing: it expired or was revoked.${shown}`
        : `The grant ended ${when(answer!.document.grantExpiresAt)}.${shown}`;
  }
}

function OperatorCard({
  client,
  operator,
  asks,
  manages,
  onChange,
}: {
  client: LedgerClient;
  operator: ProgramOperator;
  asks: boolean;
  manages: boolean;
  onChange: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const current = operator.state === 'read' || operator.state === 'late';
  return (
    <article className="report-card program-operator" aria-label={operator.name} data-testid="program-operator">
      <h3>
        {operator.name}{' '}
        <Badge tone={operator.state === 'read' ? 'observed' : operator.state === 'not_read' ? 'neutral' : 'attention'}>
          {operatorStateLabels[operator.state]}
        </Badge>
      </h3>
      <p className="report-made" data-testid="program-operator-state">
        {stateSentence(operator)}
      </p>
      {operator.lastAnswer && (
        <OperatorAnswer
          document={operator.lastAnswer.document}
          address={operator.address}
          readAt={operator.lastAnswer.readAt}
          current={current}
        />
      )}
      <div className="program-actions">
        {asks && (
          <Button
            kind="secondary"
            onClick={() =>
              void client.askProgramRead(operator.id).then(
                () => {
                  setAsked('A fresh read is asked for. Show the latest reads in a minute.');
                  onChange();
                },
                (failure) => setAsked(plainError(failure).message),
              )
            }
          >
            Ask for a fresh read
          </Button>
        )}{' '}
        {manages && !removing && (
          <Button kind="quiet" onClick={() => setRemoving(true)}>
            Stop following
          </Button>
        )}
      </div>
      {asked && <p className="records-note">{asked}</p>}
      {removing && (
        <ReasonForm
          label={`Why you stop following ${operator.name}`}
          submitLabel="Stop following"
          failedTitle="The operator is still followed"
          onCancel={() => setRemoving(false)}
          onSubmit={async (reason) => {
            await client.removeProgramOperator(operator.id, reason);
            onChange();
          }}
        />
      )}
      <AnswerHistory client={client} operator={operator} />
    </article>
  );
}

function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="program-table">
      <table className="report-numbers" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

function OperatorAnswer({
  document,
  address,
  readAt,
  current,
}: {
  document: ProgramViewDocument;
  address: string;
  readAt: string;
  current: boolean;
}) {
  const asOf = current ? `as read ${when(readAt)}` : `as read ${when(readAt)}, not current`;
  return (
    <div className="program-answer">
      <p className="records-note">
        Its Ledger names it {document.operator.name}.{' '}
        {current
          ? `The grant answers until ${when(document.grantExpiresAt)}.`
          : `When read, it said the grant would answer until ${when(document.grantExpiresAt)}.`}
      </p>
      {document.packs?.map((pack) => (
        <section key={pack.packId} aria-label={`Coverage of ${pack.title}`}>
          <h4>
            {pack.title}
            {pack.version !== null && (
              <small>
                {' '}
                version {pack.version}
                {pack.mode === 'shadow' ? ', a trial whose findings are not counted' : ''}
              </small>
            )}
          </h4>
          {pack.version === null ? (
            <p className="records-note">Not adopted by the operator now.</p>
          ) : (
            <>
              <p className="records-note" data-testid="program-coverage-counts">
                Each number counts subjects, the people, aircraft and flights a rule is about, by the rule’s latest
                result for each under this adoption. These are not counts of findings: a finding stays open until a
                person closes it, whatever the latest result.
              </p>
              <Table label={`Subjects in each result for ${pack.title}, ${asOf}`}>
                <thead>
                  <tr>
                    <th scope="col" rowSpan={2}>
                      Rule
                    </th>
                    <th scope="colgroup" colSpan={coverageColumns(pack).length}>
                      Subjects by their latest result
                    </th>
                  </tr>
                  <tr>
                    {coverageColumns(pack).map((column) => (
                      <th scope="col" key={column.label}>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pack.rules.map((rule) => (
                    <tr key={rule.ruleId}>
                      <th scope="row">
                        {rule.title}
                        {rule.citation && <small>{rule.citation}</small>}
                      </th>
                      {coverageCells(rule, coverageColumns(pack)).map((cell, index) => (
                        <td key={index} colSpan={cell.span > 1 ? cell.span : undefined}>
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </section>
      ))}
      {document.openFindings && (
        <section aria-label="Open findings">
          <h4>Open findings by rule</h4>
          <p className="records-note" data-testid="program-open-findings-total">
            {counted(document.openFindings.total, 'open finding')} of the rules it adopted to count, {asOf}: what its
            own list of open findings showed then. Findings of rules adopted to propose only, and findings a waiver
            relieves, are not counted.
            {document.openFindings.truncated ? ' More are open than one read counts.' : ''}
          </p>
          {document.openFindings.rules.length > 0 && (
            <Table label={`Open findings by rule, ${asOf}`}>
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Open findings</th>
                  <th scope="col">Oldest opened</th>
                </tr>
              </thead>
              <tbody>
                {document.openFindings.rules.map((rule) => (
                  <tr key={`${rule.packId}-${rule.ruleId}`}>
                    <th scope="row">
                      {rule.ruleTitle}
                      <small>{rule.citation}</small>
                    </th>
                    <td>{rule.open}</td>
                    <td>
                      {ctDay(rule.oldestOpenedAt)}, {counted(rule.oldestAgeDays, 'day')} old when read
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
      {document.records && document.records.length > 0 && (
        <section aria-label="Produced sets">
          <h4>Produced sets</h4>
          <ul className="program-covers">
            {document.records.map((set) => (
              <li key={set.secret}>
                <a
                  className="program-link"
                  href={`${address.replace(/\/+$/, '')}${RECORD_LINK_PAGE}#${set.secret}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  The set produced {when(set.producedAt)}
                </a>
                : {counted(set.records, 'record')}, open until {when(set.expiresAt)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AnswerHistory({ client, operator }: { client: LedgerClient; operator: ProgramOperator }) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<ProgramOperatorAnswer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    client.programOperatorAnswers(operator.id).then(
      (read) => current && setAnswers(read.answers),
      (failure) => current && setError(plainError(failure).message),
    );
    return () => {
      current = false;
    };
  }, [open, client, operator.id, operator.lastRead?.id]);
  return (
    <details className="report-table" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>Every read of {operator.name}</summary>
      {error && <p className="records-note">{error}</p>}
      {open && !answers && !error && <Spinner label="Reading the reads" />}
      {answers && (
        <Table label={`Reads of ${operator.name}`}>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What came of it</th>
            </tr>
          </thead>
          <tbody>
            {answers.map((answer) => (
              <tr key={answer.id}>
                <th scope="row">{when(answer.readAt)}</th>
                <td>
                  {outcomeLabels[answer.outcome]}
                  {answer.reason ? `: ${answer.reason}` : ''}
                  {answer.sha256 && <small>SHA-256 {answer.sha256}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </details>
  );
}

function FollowForm({
  client,
  list,
  onAdded,
}: {
  client: LedgerClient;
  list: ProgramOperatorList;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() !== '' && address.trim() !== '' && secret.trim() !== '';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await client.addProgramOperator({ name: name.trim(), address: address.trim(), secret: secret.trim() });
      setName('');
      setAddress('');
      setSecret('');
      onAdded();
    } catch (failure) {
      setError(plainError(failure).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="records-form report-card" aria-label="Follow an operator" onSubmit={submit}>
      <h3>Follow an operator</h3>
      <p className="records-note">
        The operator makes a grant in its own Ledger and gives you its Ledger’s address and the secret. Ledger keeps the
        secret for its workers and never shows it again.
      </p>
      <div className="records-form-grid">
        <label htmlFor="program-operator-name">Your name for the operator</label>
        <input id="program-operator-name" required value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="program-operator-address">Address of its Ledger</label>
        <input
          id="program-operator-address"
          required
          inputMode="url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="https://ledger.example.org"
        />
        <p className="records-help">
          {list.httpAllowed
            ? 'https://, or http:// on this local Ledger.'
            : 'It starts with https://, and is not an address on this computer or a private network.'}
        </p>
        <label htmlFor="program-operator-secret">Secret</label>
        <input
          id="program-operator-secret"
          required
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder="ledger-program-…"
        />
      </div>
      {error && (
        <Notice tone="alert" title="The operator is not followed">
          {error}
        </Notice>
      )}
      <Button type="submit" disabled={pending || !valid}>
        {pending ? 'Adding…' : 'Follow the operator'}
      </Button>
    </form>
  );
}

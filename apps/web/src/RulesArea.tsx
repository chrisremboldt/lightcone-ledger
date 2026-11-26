import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  AdoptionMode,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  PackAdoptionRecord,
  Principal,
  RulePackSummary,
  RulePackVersion,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { coverageReadDelayMs, readsCoverageAgain } from './coverage-read.js';
import { counted, errorMessage, noEndDate, time, timeRange, timeZone, timeZoneLabel } from './format.js';
import {
  activeOnlyReason,
  adoptionCommand,
  allowedModes,
  answered,
  canChangeMode,
  carriedEntries,
  fieldKey,
  modeChangeCommand,
  modeLabels,
  newerVersion,
  offeredPacks,
  packOriginLabel,
  packReliefs,
  parameterFields,
  parameterQuestions,
  parameterValues,
  shadowOnlyReason,
  startingEntries,
  statedDatesSentence,
  adoptionDays,
  adoptionDaysSentence,
  startingDays,
  successorCommand,
  versionChanges,
  type ParameterField,
} from './rule-adoption.js';
import { RuleCoverageTable, SubjectPicker } from './RuleCoverage.js';
import { OpenFindings } from './OpenFindings.js';
import { checkedByLabels, leafCheckedBy } from './rule-coverage.js';
import { goTo, type Place } from './place.js';
import { PlaceLink } from './TopBar.js';

type RulesPlace = Extract<Place, { section: 'rules' }>;
const stateLabels: Record<PackAdoptionRecord['state'], string> = {
  pending: 'Being recorded',
  scheduled: 'Starts later',
  effective: 'In effect',
  expired: 'Ended',
  revised: 'Replaced by a later revision',
  succeeded: 'Ended: a later version took over',
};

/** Adopted rule packs and their modes, and the findings recorded about any subject. */
export function RulesArea({
  client,
  principal,
  place,
}: {
  client: LedgerClient;
  principal: Principal | null;
  /** The pane, and the pack or the finding's subject it shows. */
  place: RulesPlace;
}) {
  const pane = place.pane;
  const setPane = (next: RulesPlace['pane']) => goTo({ section: 'rules', pane: next });
  return (
    <main className="records-area" aria-label="Rules and findings">
      <aside className="roster records-nav" aria-label="Rules navigation">
        <div className="roster-head">
          <h1>Rules</h1>
          <p className="roster-scope-caption">
            Rule packs your organization adopted, and what their rules recorded. Ledger records findings; a person
            decides what they mean.
          </p>
          <nav className="sms-nav-links records-panes" aria-label="Rules views">
            <button aria-current={pane === 'coverage' ? 'page' : undefined} onClick={() => setPane('coverage')}>
              Adopted rule packs
            </button>
            <button aria-current={pane === 'open' ? 'page' : undefined} onClick={() => setPane('open')}>
              Open findings
            </button>
            <button aria-current={pane === 'subjects' ? 'page' : undefined} onClick={() => setPane('subjects')}>
              Findings by subject
            </button>
          </nav>
        </div>
      </aside>
      <section className="thread-workspace" aria-label="Rules workspace">
        <div className="thread-main">
          {pane === 'coverage' ? (
            <CoveragePane
              client={client}
              principal={principal}
              packId={place.pane === 'coverage' ? place.packId : undefined}
            />
          ) : place.pane === 'open' ? (
            <OpenFindings
              key={place.owner ?? 'any'}
              client={client}
              principal={principal}
              initialOwner={place.owner}
              subject={place.subject}
            />
          ) : (
            <FindingsPane client={client} />
          )}
        </div>
      </section>
    </main>
  );
}

function CoveragePane({
  client,
  principal,
  packId,
}: {
  client: LedgerClient;
  principal: Principal | null;
  /** Shows only this pack's adoptions, as a link to one pack's coverage does. */
  packId?: string;
}) {
  const [shown, setShown] = useState<OrganizationCoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [catalog, setCatalog] = useState<RulePackSummary[]>([]);
  const failedInARow = useRef(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const tryAgain = useCallback(() => {
    failedInARow.current = 0;
    refresh();
  }, [refresh]);
  useEffect(() => {
    let current = true;
    // Without the catalog no newer version is offered; adopting still works from the form below.
    client.rulePacks().then(
      (response) => current && setCatalog(response.packs),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client]);
  useEffect(() => {
    let current = true;
    let later: ReturnType<typeof setTimeout> | undefined;
    client.organizationCoverage().then(
      (response) => {
        if (!current) return;
        failedInARow.current = 0;
        setShown(response);
        setError(null);
        if (response.meta.outstandingWork > 0) later = setTimeout(refresh, coverageReadDelayMs);
      },
      (failure: unknown) => {
        if (!current) return;
        failedInARow.current += 1;
        // While it reads again the last coverage read stays shown; the notice appears once it stops.
        if (readsCoverageAgain(failure, failedInARow.current)) later = setTimeout(refresh, coverageReadDelayMs);
        else setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
      clearTimeout(later);
    };
  }, [client, reload, refresh]);
  const canAdopt = Boolean(principal?.capabilities.includes('pack:adopt'));
  const unavailable = error && (
    <Notice tone="alert" title="Coverage is unavailable">
      {error}{' '}
      <Button kind="quiet" onClick={tryAgain}>
        Try again
      </Button>
    </Notice>
  );
  if (!shown) return unavailable || <Spinner label="Reading adopted rule packs" />;
  const adoptions = packId ? shown.adoptions.filter((adoption) => adoption.pack.packId === packId) : shown.adoptions;
  if (packId)
    return (
      <section aria-label="Adopted rule packs" data-testid="organization-coverage">
        {unavailable}
        <PlaceLink className="button button--quiet" place={{ section: 'rules', pane: 'coverage' }}>
          All adopted rule packs
        </PlaceLink>
        <h2>
          {adoptions[0]?.pack.title ?? packId} · {shown.organization.label}
        </h2>
        {adoptions.length === 0 && <p className="rail-muted">Your organization has not adopted rule pack {packId}.</p>}
        {adoptions.map((adoption) => (
          <AdoptionCard
            key={adoption.id}
            client={client}
            shown={shown}
            adoption={adoption}
            canAdopt={canAdopt}
            newer={newerVersion(adoption, catalog)}
            onRecorded={refresh}
          />
        ))}
      </section>
    );
  return (
    <section aria-label="Adopted rule packs" data-testid="organization-coverage">
      {unavailable}
      <h2>Adopted rule packs · {shown.organization.label}</h2>
      {shown.meta.outstandingWork > 0 && (
        <p className="rail-muted" role="status">
          Recording is still in progress.{' '}
          <Button kind="quiet" onClick={refresh}>
            Refresh
          </Button>
        </p>
      )}
      {shown.adoptions.length === 0 && <p className="rail-muted">No rule pack is adopted yet.</p>}
      {shown.adoptions.map((adoption) => (
        <AdoptionCard
          key={adoption.id}
          client={client}
          shown={shown}
          adoption={adoption}
          canAdopt={canAdopt}
          newer={newerVersion(adoption, catalog)}
          onRecorded={refresh}
        />
      ))}
      {canAdopt ? (
        <AdoptForm client={client} shown={shown} onRecorded={refresh} />
      ) : (
        <p className="rail-muted">Your role can review adoptions. A person who may adopt packs can change them.</p>
      )}
    </section>
  );
}

function AdoptionCard({
  client,
  shown,
  adoption,
  canAdopt,
  newer,
  onRecorded,
}: {
  client: LedgerClient;
  shown: OrganizationCoverageResponse;
  adoption: PackAdoptionRecord;
  canAdopt: boolean;
  newer: number | null;
  onRecorded: () => void;
}) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [succeeding, setSucceeding] = useState(false);
  const other: AdoptionMode = adoption.mode === 'active' ? 'shadow' : 'active';
  return (
    <article className="rail-card" data-testid="adoption" data-mode={adoption.mode}>
      <div className="finding-heading">
        <Badge tone={adoption.mode === 'active' ? 'observed' : 'advisory'}>{modeLabels[adoption.mode]}</Badge>
        <span>{stateLabels[adoption.state]}</span>
      </div>
      <h4>
        <PlaceLink place={{ section: 'rules', pane: 'coverage', packId: adoption.pack.packId }}>
          {adoption.pack.title}
        </PlaceLink>{' '}
        · version {adoption.pack.version}
      </h4>
      <p className="rail-muted">
        {timeRange(adoption.effectiveInterval.start, adoption.effectiveInterval.end)} · adopted by {adoption.actor.name}{' '}
        · {adoption.note}
      </p>
      {adoption.pack.waiver && (
        <p className="rail-muted" data-testid="waiver-stated-dates">
          {statedDatesSentence(adoption.pack.waiver, Date.now(), timeZone())}
        </p>
      )}
      {adoption.state === 'effective' && <RuleCoverageTable client={client} adoptionId={adoption.id} />}
      {adoption.succeededBy && (
        <p className="rail-muted" data-testid="adoption-successor">
          Version {adoption.succeededBy.version} takes over from {time(adoption.succeededBy.start, true)}{' '}
          {timeZoneLabel()}. Evaluations made under version {adoption.pack.version} keep it.
        </p>
      )}
      {canAdopt && newer !== null && !succeeding && !open && (
        <Button kind="secondary" onClick={() => setSucceeding(true)}>
          Adopt version {newer}
        </Button>
      )}
      {succeeding && newer !== null && (
        <SuccessorForm
          client={client}
          shown={shown}
          adoption={adoption}
          version={newer}
          onCancel={() => setSucceeding(false)}
          onRecorded={onRecorded}
        />
      )}
      {canAdopt && canChangeMode(adoption) && !open && !succeeding && (
        <Button kind="secondary" onClick={() => setOpen(true)}>
          Change to {other}
        </Button>
      )}
      {open && (
        <CommandForm
          client={client}
          label={`Change to ${other}`}
          explanation={
            other === 'active'
              ? 'From now on its findings are counted and shown in the release basis. Rules are evaluated again at once; earlier evaluations keep the mode they were recorded under.'
              : 'From now on its findings are recorded and shown as proposed, never counted. Rules are evaluated again at once; earlier evaluations keep the mode they were recorded under.'
          }
          note={note}
          onNote={setNote}
          build={() => modeChangeCommand(shown, adoption, other, note.trim())}
          onCancel={() => setOpen(false)}
          onRecorded={onRecorded}
        />
      )}
    </article>
  );
}

function AdoptForm({
  client,
  shown,
  onRecorded,
}: {
  client: LedgerClient;
  shown: OrganizationCoverageResponse;
  onRecorded: () => void;
}) {
  const [catalog, setCatalog] = useState<RulePackSummary[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [pack, setPack] = useState<RulePackVersion | null>(null);
  const [mode, setMode] = useState<AdoptionMode>('shadow');
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [days, setDays] = useState(() => startingDays(undefined, Date.now(), timeZone()));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client.rulePacks().then(
      (response) => setCatalog(response.packs),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  }, [client]);
  useEffect(() => {
    setPack(null);
    setEntries({});
    if (!chosen) return;
    const [packId, version] = JSON.parse(chosen) as [string, number];
    let current = true;
    client.rulePackVersion(packId, version).then(
      (response) => {
        if (!current) return;
        setPack(response.pack);
        setEntries(startingEntries(parameterFields(response.pack), timeZone()));
        setMode(allowedModes(response.pack)[0]!);
        setDays(startingDays(response.pack.waiver, Date.now(), timeZone()));
      },
      (failure: unknown) => current && setError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [client, chosen]);
  // The titles of the rules this pack relieves, read from the latest version of the pack that holds them.
  const [relievedTitles, setRelievedTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    setRelievedTitles({});
    if (!pack || !catalog) return;
    let current = true;
    for (const packId of new Set(packReliefs(pack).map((relief) => relief.packId))) {
      const version = Math.max(0, ...catalog.filter((item) => item.packId === packId).map((item) => item.version));
      if (version === 0) continue;
      client.rulePackVersion(packId, version).then(
        (response) =>
          current &&
          setRelievedTitles((titles) => ({
            ...titles,
            ...Object.fromEntries(response.pack.leaves.map((leaf) => [leaf.id, `“${leaf.title}”`])),
          })),
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [client, pack, catalog]);
  const fields = pack ? parameterFields(pack) : [];
  const values = parameterValues(fields, entries);
  const onlyReason = pack ? (shadowOnlyReason(pack) ?? activeOnlyReason(pack)) : null;
  const dates = adoptionDays(days.from, days.through, timeZone());
  const offered = offeredPacks(catalog ?? []);
  const option = (item: RulePackSummary) => (
    <option key={`${item.packId}@${item.version}`} value={JSON.stringify([item.packId, item.version])}>
      {item.title} · version {item.version} · {packOriginLabel(item.origin)}
    </option>
  );
  const earlierChosen = offered.earlier.some((item) => JSON.stringify([item.packId, item.version]) === chosen);
  return (
    <section className="action-form" aria-label="Adopt a rule pack" data-testid="adopt-pack">
      <h3>Adopt a rule pack</h3>
      {error && (
        <Notice tone="alert" title="Rule packs are unavailable">
          {error}
        </Notice>
      )}
      <label htmlFor="adopt-pack-choice">Rule pack</label>
      <select
        id="adopt-pack-choice"
        value={earlierChosen ? '' : chosen}
        onChange={(event) => setChosen(event.target.value)}
      >
        <option value="">Choose a pack</option>
        {offered.latest.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.packs.map(option)}
          </optgroup>
        ))}
      </select>
      {offered.earlier.length > 0 && (
        <details className="adopt-earlier" open={earlierChosen}>
          <summary>Earlier versions</summary>
          <label htmlFor="adopt-pack-earlier">Earlier version</label>
          <select
            id="adopt-pack-earlier"
            value={earlierChosen ? chosen : ''}
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="">Choose an earlier version</option>
            {offered.earlier.map(option)}
          </select>
        </details>
      )}
      {pack && (
        <>
          <p className="rail-muted">{counted(pack.leaves.length, 'rule')}</p>
          <ul aria-label="Rules in this pack" data-testid="adopt-pack-rules">
            {pack.leaves.map((leaf) => (
              <li key={leaf.id}>
                {leaf.title} <small>({checkedByLabels[leafCheckedBy(leaf)]})</small>
                {packReliefs(pack)
                  .filter((relief) => relief.leafId === leaf.id)
                  .map((relief) => (
                    <small key={relief.packId} className="adopt-relief" data-testid="adopt-pack-relief">
                      Adopted as active, it relieves {relief.ruleIds.map((id) => relievedTitles[id] ?? id).join(', ')}{' '}
                      of {catalog?.find((item) => item.packId === relief.packId)?.title ?? relief.packId}: that rule’s
                      result is then recorded as relieved, not counted.
                    </small>
                  ))}
              </li>
            ))}
          </ul>
          <fieldset>
            <legend>Mode</legend>
            {(['shadow', 'active'] as const).map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="adopt-mode"
                  value={option}
                  checked={mode === option}
                  disabled={!allowedModes(pack).includes(option)}
                  onChange={() => setMode(option)}
                />{' '}
                {modeLabels[option]}
              </label>
            ))}
            {onlyReason && <p className="rail-muted">{onlyReason}</p>}
          </fieldset>
          <ParameterInputs idPrefix="adopt" fields={fields} entries={entries} onEntries={setEntries} />
          {pack.waiver && (
            <p className="rail-muted" data-testid="adopt-waiver-dates">
              {statedDatesSentence(pack.waiver, Date.now(), timeZone())}
            </p>
          )}
          <div className="adopt-dates">
            <label htmlFor="adopt-from">From the start of</label>
            <input
              id="adopt-from"
              type="date"
              value={days.from}
              onChange={(event) => setDays({ ...days, from: event.target.value })}
            />
            <label htmlFor="adopt-through">To the end of</label>
            <input
              id="adopt-through"
              type="date"
              value={days.through}
              onChange={(event) => setDays({ ...days, through: event.target.value })}
            />
          </div>
          <p className="rail-muted" data-testid="adopt-dates-meaning">
            {'problem' in dates
              ? dates.problem
              : `${adoptionDaysSentence(days.from, days.through, timeZone())}${pack.waiver ? ' The days start as the dates the certificate states.' : ''}`}
          </p>
          {values.invalid && (
            <p className="rail-muted">Enter a valid value for {values.invalid.parameter.title} before adopting.</p>
          )}
          <CommandForm
            client={client}
            label={`Adopt in ${mode}`}
            explanation={
              mode === 'shadow'
                ? 'Its rules are evaluated and their findings recorded and shown as proposed, never counted.'
                : 'Its rules are evaluated and their findings counted and shown in what a person attests to.'
            }
            note={note}
            onNote={setNote}
            disabled={Boolean(values.invalid) || 'problem' in dates}
            build={() =>
              adoptionCommand(shown, pack, {
                mode,
                effectiveInterval: 'interval' in dates ? dates.interval : { start: '', end: '' },
                note: note.trim(),
                ...(values.values ? { parameters: values.values } : {}),
              })
            }
            onRecorded={() => {
              setChosen('');
              setNote('');
              onRecorded();
            }}
          />
        </>
      )}
    </section>
  );
}

/** One input for each value a pack's rules ask the adopting organization to supply. */
function ParameterInputs({
  idPrefix,
  fields,
  entries,
  onEntries,
}: {
  idPrefix: string;
  fields: readonly ParameterField[];
  entries: Record<string, string>;
  onEntries: (entries: Record<string, string>) => void;
}) {
  // A value several rules declare alike is asked once and given to each of them.
  return (
    <>
      {parameterQuestions(fields).map((question) => {
        const { parameter } = question;
        const id = `${idPrefix}-${fieldKey(question.fields[0]!)}`;
        const value = entries[fieldKey(question.fields[0]!)] ?? '';
        const onChange = (next: string) => onEntries(answered(entries, question, next));
        return (
          <div key={question.key}>
            <label htmlFor={id}>
              {parameter.title}{' '}
              {question.fields.length > 2 ? (
                <small title={question.fields.map((field) => field.leafTitle).join('\n')}>
                  (used by {counted(question.fields.length, 'rule')})
                </small>
              ) : (
                <small>({question.fields.map((field) => field.leafTitle).join(' · ')})</small>
              )}
            </label>
            {parameter.valueType === 'boolean' || parameter.options ? (
              <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
                <option value="">Choose</option>
                {(parameter.options ?? ['true', 'false']).map((option) => (
                  <option key={option} value={option}>
                    {option === 'true' ? 'Yes' : option === 'false' ? 'No' : option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={parameter.valueType === 'string' ? 'text' : 'number'}
                min={parameter.minimum}
                max={parameter.maximum}
                step={parameter.valueType === 'integer' ? 1 : 'any'}
                value={value}
                onChange={(event) => onChange(event.target.value)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Adopting a newer version of an adopted pack from now on: what changes, its mode and values, and a reason. */
function SuccessorForm({
  client,
  shown,
  adoption,
  version,
  onCancel,
  onRecorded,
}: {
  client: LedgerClient;
  shown: OrganizationCoverageResponse;
  adoption: PackAdoptionRecord;
  version: number;
  onCancel: () => void;
  onRecorded: () => void;
}) {
  const [pack, setPack] = useState<RulePackVersion | null>(null);
  const [mode, setMode] = useState<AdoptionMode>(adoption.mode);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    client.rulePackVersion(adoption.pack.packId, version).then(
      (response) => {
        if (!current) return;
        const modes = allowedModes(response.pack);
        setPack(response.pack);
        setMode((chosen) => (modes.includes(chosen) ? chosen : modes[0]!));
        setEntries(carriedEntries(parameterFields(response.pack), adoption));
      },
      (failure: unknown) => current && setError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [client, adoption, version]);
  if (error)
    return (
      <Notice tone="alert" title="That version is unavailable">
        {error}
      </Notice>
    );
  if (!pack) return <Spinner label={`Reading version ${version}`} />;
  const changes = versionChanges(adoption.pack, pack);
  const fields = changes.parameters;
  const values = parameterValues(fields, entries);
  const titles = (leaves: RulePackVersion['leaves']) => leaves.map((leaf) => leaf.title).join(' · ');
  return (
    <section className="action-form" aria-label={`Adopt version ${version}`} data-testid="adopt-successor">
      <h4>
        Adopt version {version} in place of version {adoption.pack.version}
      </h4>
      <ul data-testid="version-changes">
        <li>Rules added: {changes.added.length ? titles(changes.added) : 'none'}</li>
        <li>Rules removed: {changes.removed.length ? titles(changes.removed) : 'none'}</li>
        <li>Rules changed: {changes.changed.length ? titles(changes.changed) : 'none'}</li>
        <li>Values to supply: {fields.length ? fields.map((field) => field.parameter.title).join(' · ') : 'none'}</li>
      </ul>
      <fieldset>
        <legend>Mode</legend>
        {(['shadow', 'active'] as const).map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={`successor-mode-${adoption.id}`}
              value={option}
              checked={mode === option}
              disabled={!allowedModes(pack).includes(option)}
              onChange={() => setMode(option)}
            />{' '}
            {modeLabels[option]}
          </label>
        ))}
      </fieldset>
      <ParameterInputs idPrefix="successor" fields={fields} entries={entries} onEntries={setEntries} />
      {values.invalid && (
        <p className="rail-muted">Enter a valid value for {values.invalid.parameter.title} before adopting.</p>
      )}
      <CommandForm
        client={client}
        label={`Adopt version ${version}`}
        explanation={`Version ${adoption.pack.version} ends now and version ${version} runs ${noEndDate(adoption.effectiveInterval.end) ? 'with no end date' : `until ${time(adoption.effectiveInterval.end, true)} ${timeZoneLabel()}`}. Both stay in the history, evaluations made under version ${adoption.pack.version} keep it, and the rules of version ${version} are evaluated again for the subjects already on record. Open findings of removed rules stay open until a person resolves them.`}
        note={note}
        onNote={setNote}
        disabled={Boolean(values.invalid)}
        build={() =>
          successorCommand(shown, adoption, pack, {
            mode,
            start: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
            note: note.trim(),
            ...(values.values ? { parameters: values.values } : {}),
          })
        }
        onCancel={onCancel}
        onRecorded={onRecorded}
      />
    </section>
  );
}

/** A note and a submit button for one adoption command, retrying with the same key when the result is unknown. */
function CommandForm({
  client,
  label,
  explanation,
  note,
  onNote,
  build,
  disabled = false,
  onCancel,
  onRecorded,
}: {
  client: LedgerClient;
  label: string;
  explanation: string;
  note: string;
  onNote: (note: string) => void;
  build: () => PackAdoptionCommand;
  disabled?: boolean;
  onCancel?: () => void;
  onRecorded: () => void;
}) {
  const noteId = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled || !note.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      await client.command(build(), crypto.randomUUID());
      onRecorded();
      onCancel?.();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} data-testid="adoption-command">
      <p className="finding-consequence">{explanation}</p>
      <label htmlFor={noteId}>Reason, kept with the adoption</label>
      <textarea
        id={noteId}
        rows={3}
        maxLength={4000}
        required
        value={note}
        onChange={(event) => onNote(event.target.value)}
      />
      {failure && (
        <Notice tone="alert" title="Adoption was not recorded">
          {failure} Refresh to review the current coverage.
        </Notice>
      )}
      <Button kind="primary" type="submit" disabled={busy || disabled || !note.trim()}>
        {busy ? <Spinner label="Recording" /> : label}
      </Button>
      {onCancel && (
        <Button kind="quiet" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </form>
  );
}

function FindingsPane({ client }: { client: LedgerClient }) {
  return (
    <section aria-label="Findings by subject" data-testid="findings-by-subject">
      <h2>Findings by subject</h2>
      <SubjectPicker client={client} />
    </section>
  );
}

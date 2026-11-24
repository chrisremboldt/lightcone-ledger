import { useEffect, useState } from 'react';
import type {
  OpenFinding,
  OpenFindingGroup,
  OpenFindingGroupsResponse,
  OpenFindingsQuery,
  OpenFindingsResponse,
  Principal,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { errorMessage, timeZone, timeZoneLabel } from './format.js';
import { actionSentence, ageWords, clearedSentence, today } from './finding-work.js';
import { FindingSetActions } from './FindingSetActions.js';
import { subjectLabel } from './subject-label.js';
import { SubjectFindings } from './SubjectFindings.js';
import type { CitedSubject } from './evaluation-reads.js';

const kindLabels: Record<string, string> = {
  person: 'People',
  aircraft: 'Aircraft',
  flight: 'Flights',
  site: 'Sites',
  component: 'Components',
  organization: 'Your organization',
};

type Shown = NonNullable<OpenFindingsQuery['shown']>;
type View = 'rules' | 'every';
type Order = 'fewest' | 'most';

/** The days an instant range falls on in the organization's time zone, as one day or a first and a last. */
function dayRange(from: string, until: string): string {
  const [first, last] = [today(timeZone(), new Date(from)), today(timeZone(), new Date(until))];
  return first === last ? first : `${first} to ${last}`;
}

/**
 * Every open finding across people, aircraft, flights and the organization, grouped by rule with the rules that found
 * the fewest first, or every finding oldest first; the proposed ones from shadow adoptions on their own tab, never
 * counted. A rule opens on its findings, where a person takes or closes all of them as one decision; a finding opens
 * on its subject's findings, where a person takes it, assigns it, records an action and closes it.
 */
export function OpenFindings({
  client,
  principal = null,
  initialOwner,
}: {
  client: LedgerClient;
  principal?: Principal | null;
  initialOwner?: 'none';
}) {
  const [shown, setShown] = useState<Shown>('counted');
  const [view, setView] = useState<View>(initialOwner ? 'every' : 'rules');
  const [order, setOrder] = useState<Order>('fewest');
  const [rule, setRule] = useState<OpenFindingGroup | null>(null);
  const [aboutFrom, setAboutFrom] = useState('');
  const [aboutUntil, setAboutUntil] = useState('');
  const [groups, setGroups] = useState<OpenFindingGroupsResponse | null>(null);
  const [subjectKind, setSubjectKind] = useState('');
  const [packId, setPackId] = useState('');
  const [owner, setOwner] = useState<string>(initialOwner ?? '');
  const [result, setResult] = useState<'' | 'attention' | 'cleared'>('');
  const [pages, setPages] = useState<OpenFindingsResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [opened, setOpened] = useState<OpenFinding | null>(null);

  const narrowing = {
    ...(subjectKind ? { subjectKind: subjectKind as OpenFindingsQuery['subjectKind'] } : {}),
    ...(aboutFrom ? { aboutFrom } : {}),
    ...(aboutUntil ? { aboutUntil } : {}),
  };
  const query: OpenFindingsQuery = {
    shown,
    ...narrowing,
    ...(packId ? { packId } : {}),
    ...(rule ? { packId: rule.packId, ruleId: rule.ruleId } : {}),
    ...(owner ? { owner } : {}),
    ...(result ? { result } : {}),
  };
  const grouped = view === 'rules' && !rule;
  useEffect(() => {
    let current = true;
    setError(null);
    if (grouped)
      client.openFindingGroups({ ...query, order }).then(
        (response) => {
          if (!current) return;
          setGroups(response);
          setPages(null);
        },
        (failure: unknown) => current && setError(errorMessage(failure)),
      );
    else
      client.openFindings(query).then(
        (response) => current && setPages([response]),
        (failure: unknown) => current && setError(errorMessage(failure)),
      );
    return () => {
      current = false;
    };
  }, [client, shown, subjectKind, packId, owner, result, aboutFrom, aboutUntil, grouped, order, rule, reload]);

  async function more() {
    const last = pages?.at(-1);
    if (!last?.page.nextCursor) return;
    try {
      const next = await client.openFindings({ ...query, cursor: last.page.nextCursor });
      setPages((previous) => [...(previous ?? []), next]);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  if (opened)
    return (
      <section aria-label="Finding" data-testid="open-finding-detail">
        <Button
          kind="quiet"
          onClick={() => {
            setOpened(null);
            setReload((value) => value + 1);
          }}
        >
          Back to open findings
        </Button>
        <h2>{subjectLabel(opened.subject)}</h2>
        <p className="records-item-meta">
          {opened.subject.kind} · your id {opened.subject.id}
        </p>
        <SubjectFindings client={client} subject={opened.subject as CitedSubject} />
      </section>
    );

  const first = grouped ? groups : pages?.[0];
  const findings = pages?.flatMap((page) => page.findings) ?? [];
  const filtered = Boolean(subjectKind || packId || owner || result || aboutFrom || aboutUntil);
  return (
    <section aria-label="Open findings" data-testid="open-findings">
      <h2>Open findings</h2>
      <p className="records-note">
        What the adopted rules found about your people, aircraft, flights and organization that is still open. Ledger
        records findings; a person decides what they mean and closes them.
      </p>
      {first && (
        <p className="open-findings-attention" data-testid="open-findings-attention">
          <strong>{first.attention.unowned}</strong> counted{' '}
          {first.attention.unowned === 1 ? 'finding has' : 'findings have'} no owner ·{' '}
          <strong>{first.attention.overdue}</strong> {first.attention.overdue === 1 ? 'action is' : 'actions are'}{' '}
          overdue
        </p>
      )}
      <nav className="sms-nav-links records-panes" aria-label="Which findings">
        <button
          aria-current={shown === 'counted' ? 'page' : undefined}
          onClick={() => {
            setShown('counted');
            setRule(null);
          }}
        >
          Counted · {first?.counts.counted ?? '…'}
        </button>
        <button
          aria-current={shown === 'proposed' ? 'page' : undefined}
          onClick={() => {
            setShown('proposed');
            setRule(null);
          }}
        >
          Proposed, not counted · {first?.counts.proposed ?? '…'}
        </button>
      </nav>
      <nav className="sms-nav-links records-panes" aria-label="How findings are shown">
        <button
          aria-current={view === 'rules' ? 'page' : undefined}
          onClick={() => {
            setView('rules');
            setRule(null);
          }}
        >
          By rule
        </button>
        <button
          aria-current={view === 'every' ? 'page' : undefined}
          onClick={() => {
            setView('every');
            setRule(null);
          }}
        >
          Every finding, oldest first
        </button>
      </nav>
      {shown === 'proposed' && (
        <p className="rail-muted" data-testid="proposed-note">
          These come from rules adopted in shadow. They show what a rule would find and are never counted or included in
          what a person attests to.
        </p>
      )}
      {first && first.counts.relieved > 0 && (
        <p className="rail-muted">
          {first.counts.relieved} open {first.counts.relieved === 1 ? 'finding is' : 'findings are'} relieved by an
          adopted waiver and not counted.
        </p>
      )}
      <div className="open-findings-filters">
        <span className="open-findings-filter">
          <label htmlFor="open-findings-kind">Subject</label>
          <select id="open-findings-kind" value={subjectKind} onChange={(event) => setSubjectKind(event.target.value)}>
            <option value="">Every kind</option>
            {(first?.filters.subjectKinds ?? [])
              .concat(
                subjectKind && !first?.filters.subjectKinds.includes(subjectKind as never)
                  ? [subjectKind as never]
                  : [],
              )
              .map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabels[kind] ?? kind}
                </option>
              ))}
          </select>
        </span>
        <span className="open-findings-filter">
          <label htmlFor="open-findings-pack">Pack</label>
          <select id="open-findings-pack" value={packId} onChange={(event) => setPackId(event.target.value)}>
            <option value="">Every pack</option>
            {(first?.filters.packs ?? []).map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.title}
              </option>
            ))}
          </select>
        </span>
        <span className="open-findings-filter">
          <label htmlFor="open-findings-owner">Owner</label>
          <select id="open-findings-owner" value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="">Anyone or nobody</option>
            <option value="none">Nobody yet</option>
            {(first?.filters.owners ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </span>
        <span className="open-findings-filter">
          <label htmlFor="open-findings-result">Latest result</label>
          <select
            id="open-findings-result"
            value={result}
            onChange={(event) => setResult(event.target.value as typeof result)}
          >
            <option value="">Any result</option>
            <option value="attention">Still needs attention</option>
            <option value="cleared">Supported by the record now</option>
          </select>
        </span>
        <span className="open-findings-filter">
          <label htmlFor="open-findings-about-from">About from ({timeZoneLabel()})</label>
          <input
            id="open-findings-about-from"
            type="date"
            value={aboutFrom}
            onChange={(event) => setAboutFrom(event.target.value)}
          />
        </span>
        <span className="open-findings-filter">
          <label htmlFor="open-findings-about-until">About until</label>
          <input
            id="open-findings-about-until"
            type="date"
            value={aboutUntil}
            onChange={(event) => setAboutUntil(event.target.value)}
          />
        </span>
        {grouped && (
          <span className="open-findings-filter">
            <label htmlFor="open-findings-order">Rules</label>
            <select id="open-findings-order" value={order} onChange={(event) => setOrder(event.target.value as Order)}>
              <option value="fewest">Fewest findings first</option>
              <option value="most">Most findings first</option>
            </select>
          </span>
        )}
      </div>
      <p className="rail-muted">
        A finding is about the day of the earliest current record about its subject, such as a flight plan’s window;
        when its subject has none, the day it opened.
      </p>
      {error && (
        <Notice tone="alert" title="Open findings are unavailable">
          {error}
        </Notice>
      )}
      {!first && !error && <Spinner label="Reading open findings" />}
      {grouped && groups && (
        <>
          <p className="records-note" data-testid="open-finding-groups-total">
            {groups.total.findings} open {groups.total.findings === 1 ? 'finding' : 'findings'} under{' '}
            {groups.total.rules} {groups.total.rules === 1 ? 'rule' : 'rules'}
            {filtered ? ' with these filters' : ''}.
          </p>
          {groups.groups.length > 0 && (
            <ol className="records-items open-findings-list">
              {groups.groups.map((group) => (
                <li key={`${group.packId} ${group.ruleId}`} data-testid="open-finding-group">
                  <button
                    className="records-item"
                    aria-label={`Open the findings of ${group.ruleTitle} (${group.packTitle})`}
                    onClick={() => {
                      setPages(null);
                      setRule(group);
                    }}
                  >
                    <span className="records-item-head">
                      <strong>{group.ruleTitle}</strong>
                      <Badge tone={group.owned < group.open ? 'attention' : 'neutral'}>{group.open} open</Badge>
                    </span>
                    <span className="records-item-meta">
                      {group.paragraph} · {group.packTitle}
                    </span>
                    <span className="records-item-meta">
                      About {group.subjects} {group.subjects === 1 ? 'subject' : 'subjects'} · {group.owned} owned ·
                      about {dayRange(group.aboutFrom, group.aboutUntil)}
                      {group.cleared ? ` · ${group.cleared} supported by the record now` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {rule && (
        <section aria-label="Findings of one rule" data-testid="open-finding-rule">
          <Button kind="quiet" onClick={() => setRule(null)}>
            Back to every rule
          </Button>
          <h3>{rule.ruleTitle}</h3>
          <p className="records-item-meta">
            {rule.paragraph} · {rule.packTitle} · {pages?.[0]?.matching ?? '…'} open
            {filtered ? ' with these filters' : ''}
          </p>
          {shown === 'counted' && (
            <FindingSetActions
              client={client}
              principal={principal}
              group={rule}
              narrowing={narrowing}
              onChanged={() => setReload((value) => value + 1)}
            />
          )}
        </section>
      )}
      {!grouped && pages && !findings.length && (
        <p className="records-note">
          {shown === 'counted' ? 'No counted finding is open' : 'No proposed finding is open'}
          {filtered ? ' with these filters.' : '.'}
        </p>
      )}
      {!grouped && findings.length > 0 && (
        <ol className="records-items open-findings-list">
          {findings.map((finding) => (
            <li key={finding.id} data-testid="open-finding">
              <button
                className="records-item"
                aria-label={`Open the finding about ${subjectLabel(finding.subject)}: ${finding.ruleTitle}`}
                onClick={() => setOpened(finding)}
              >
                <span className="records-item-head">
                  <strong>{subjectLabel(finding.subject)}</strong>
                  {finding.mode === 'shadow' ? (
                    <Badge tone="advisory">Proposed</Badge>
                  ) : !finding.owner ? (
                    <Badge tone="attention">Needs an owner</Badge>
                  ) : null}
                  {finding.action?.overdue && <Badge tone="attention">Action overdue</Badge>}
                  {finding.cleared && <Badge tone="neutral">Supported by the record now</Badge>}
                </span>
                <span className="records-item-meta">
                  {finding.ruleTitle} · {finding.paragraph} · {finding.packTitle}
                </span>
                {finding.cleared && <span className="records-item-meta">{clearedSentence}</span>}
                <span className="records-item-meta">
                  About {today(timeZone(), new Date(finding.aboutAt))} · {ageWords(finding.ageDays)} ·{' '}
                  {finding.owner ? `Owner: ${finding.owner.name}` : 'No owner'}
                  {finding.action ? ` · Action: ${actionSentence(finding.action)}` : ''}
                  {finding.related ? ` · for ${subjectLabel(finding.related.subject)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {!grouped && pages?.at(-1)?.page.hasMore && (
        <Button kind="quiet" onClick={() => void more()}>
          More findings
        </Button>
      )}
      {first?.truncated && (
        <p className="records-note">More open findings exist than this list reads; filter by subject or pack.</p>
      )}
    </section>
  );
}

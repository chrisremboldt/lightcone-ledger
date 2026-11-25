import { useContext, useEffect, useRef, useState } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type {
  AdoptionRuleCoverageResponse,
  CurrentPrincipalResponse,
  OrganizationCoverageResponse,
  PackAdoptionRecord,
  Principal,
  RecordProductionListResponse,
  SmsHomeResponse,
  SmsRegisterResponse,
} from '@ledger/contracts';
import { Badge, Spinner } from '@ledger/ui';
import {
  adoptionsInForce,
  firstDaySteps,
  firstStepPlace,
  offersSetup,
  type FirstDayInput,
  type FirstDayState,
  type FirstDayStep,
  type FirstStep,
} from './first-steps.js';
import { FirstDayContext, type FirstDayShown } from './first-day-context.js';
import { PlaceLink } from './TopBar.js';
import { mode } from './transport.js';

/** The adoptions as read for the first screen; undefined until settled, null when they cannot be read. */
export interface FirstDayDecision {
  principal: Principal;
  adoptions: readonly PackAdoptionRecord[] | null;
}

/** At most this many adoptions in effect have their coverage read for the list. */
const COVERAGE_READS = 5;

async function readSteps(
  client: LedgerClient,
  principal: Principal,
  coverage: Promise<OrganizationCoverageResponse | null>,
): Promise<FirstDayInput> {
  const can = (capability: string) => (principal.capabilities as readonly string[]).includes(capability);
  const optional = <T,>(allowed: boolean, read: () => Promise<T>): Promise<T | null> =>
    allowed ? read().catch(() => null) : Promise.resolve(null);
  const subjects = (kind: 'aircraft' | 'person' | 'flight') =>
    client.subjectsOnRecord({ kind, limit: 3 }).then((shown) => shown.subjects);
  const register = (kind: string) =>
    client.request<SmsRegisterResponse>(`/v1/sms/records?kind=${kind}`).then((shown) => shown.records);
  const [people, subjectsShown, packs, shown, safety, productions] = await Promise.all([
    optional(can('flight:read'), () => client.organizationPeople({ limit: 5 })),
    optional(can('evidence:read'), async () => ({
      aircraft: await subjects('aircraft'),
      person: await subjects('person'),
      flight: await subjects('flight'),
    })),
    optional(can('flight:read'), () => client.rulePacks()),
    coverage,
    optional(can('sms:read'), async () => {
      const [home, documents, matrices, reports] = await Promise.all([
        client.request<SmsHomeResponse>('/v1/sms/home'),
        register('document'),
        register('risk_matrix'),
        register('report'),
      ]);
      return { home, documents: [...documents, ...matrices], reports };
    }),
    optional(can('evidence:read'), () =>
      client.request<RecordProductionListResponse>('/v1/record-productions?limit=1'),
    ),
  ]);
  const effective = shown
    ? adoptionsInForce(shown.adoptions)
        .filter((adoption) => adoption.state === 'effective')
        .slice(0, COVERAGE_READS)
    : [];
  const coverages = await optional<AdoptionRuleCoverageResponse[]>(Boolean(shown) && can('evidence:read'), () =>
    Promise.all(effective.map((adoption) => client.adoptionRuleCoverage(adoption.id))),
  );
  return {
    principal,
    people: people ? { people: people.people, more: people.page.hasMore } : null,
    subjects: subjectsShown,
    packs: packs?.packs ?? null,
    adoptions: shown?.adoptions ?? null,
    coverage: coverages,
    safety,
    productions: productions ? { latest: productions.records[0] ?? null } : null,
  };
}

/**
 * Reads what the first-day list needs: the signed-in person and the adoptions first, which decide the first screen,
 * then the rest. It reads again when the person moves to another section, so a step taken elsewhere shows on return.
 */
export function useFirstDay(
  client: LedgerClient,
  section: string,
): { decision: FirstDayDecision | null | undefined; shown: FirstDayShown } {
  const [decision, setDecision] = useState<FirstDayDecision | null | undefined>(undefined);
  const [input, setInput] = useState<FirstDayInput | null>(null);
  const [generation, setGeneration] = useState(0);
  const lastSection = useRef(section);
  useEffect(() => {
    // The start address only resolves to the first screen; moving off it is not a move to read again for.
    if (lastSection.current !== section && lastSection.current !== 'start') setGeneration((value) => value + 1);
    lastSection.current = section;
  }, [section]);
  useEffect(() => {
    // A recorded or replayed scene reads only what its recording holds; the list is never part of one.
    if (mode() !== 'live') {
      setDecision(null);
      return;
    }
    let stopped = false;
    void (async () => {
      const me = await client.request<CurrentPrincipalResponse>('/v1/me').catch(() => null);
      if (stopped) return;
      if (!me) {
        setDecision((previous) => (previous === undefined ? null : previous));
        return;
      }
      const principal = me.principal;
      const coverage = principal.capabilities.includes('flight:read')
        ? client.organizationCoverage().catch(() => null)
        : Promise.resolve(null);
      void coverage.then(
        (shown) =>
          !stopped && setDecision((previous) => previous ?? { principal, adoptions: shown?.adoptions ?? null }),
      );
      const read = await readSteps(client, principal, coverage);
      if (!stopped) setInput(read);
    })();
    return () => {
      stopped = true;
    };
  }, [client, generation]);
  const steps = input ? firstDaySteps(input) : null;
  return {
    decision,
    shown: { steps, offersSetup: Boolean(input && steps && offersSetup(input.principal, steps)) },
  };
}

const stateBadges: Record<
  Exclude<FirstDayState, 'read'>,
  { label: string; tone: 'planned' | 'attention' | 'neutral' }
> = {
  on_file: { label: 'On file', tone: 'planned' },
  not_on_file: { label: 'Not on file', tone: 'attention' },
  unreadable: { label: 'Not read', tone: 'neutral' },
};

function SafetyItem({ item }: { item: FirstStep }) {
  const { place, extras } = item.action ? firstStepPlace(item.action.target) : { place: null, extras: {} };
  return (
    <li data-testid={`setup-item-${item.key}`}>
      <span>
        <strong>{item.title}</strong>
        <small>{item.detail}</small>
        {item.action && <small>{`${item.action.label}: ${item.action.who}`}</small>}
      </span>
      <span className="sms-row-facts">
        <Badge tone={item.onFile ? 'planned' : 'attention'}>{item.onFile ? 'On file' : 'Not on file'}</Badge>
        {item.action?.mine && place && (
          <PlaceLink className="button button--next" place={place} extras={extras}>
            {item.action.label}
          </PlaceLink>
        )}
      </span>
    </li>
  );
}

function Step({ step }: { step: FirstDayStep }) {
  const action = step.action;
  const badge = step.state === 'read' ? null : stateBadges[step.state];
  return (
    <li data-testid={`setup-step-${step.key}`}>
      <span>
        <strong>
          {step.number}. {step.title}
          {step.optional ? ' (optional)' : ''}
        </strong>
        <small>{step.detail}</small>
        {action && <small>{`${action.label}: ${action.who}`}</small>}
        {action?.command && (
          <small>
            Start with <code>{action.command}</code>. {action.guide} walks it.
          </small>
        )}
        {step.items && (
          <ul className="sms-first-steps-list" aria-label="Safety items">
            {step.items.map((item) => (
              <SafetyItem key={item.key} item={item} />
            ))}
          </ul>
        )}
      </span>
      <span className="sms-row-facts">
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        {action?.mine && action.place && (
          <PlaceLink className="button button--next" place={action.place} extras={action.extras}>
            {action.label}
          </PlaceLink>
        )}
      </span>
    </li>
  );
}

/**
 * The organization's first day as one list, in the order of the setup guide. Every state comes from what is on
 * record; a person ticks nothing here.
 */
export function FirstDay() {
  const { steps } = useContext(FirstDayContext);
  return (
    <main className="records-area records-home" aria-label="Setup" data-testid="first-day">
      <section className="thread-workspace" aria-label="Setup steps">
        <div className="thread-main">
          <p className="thread-crumbs">Setup</p>
          <h2>Your organization’s first day</h2>
          <p className="overview-purpose">
            The steps of setting up Ledger, as your organization’s records show them now: what is on file and what is
            not, the one action that starts each step, and who may take it.
          </p>
          {steps ? (
            <ol className="sms-first-steps-list" aria-label="Steps">
              {steps.map((step) => (
                <Step key={step.key} step={step} />
              ))}
            </ol>
          ) : (
            <Spinner label="Reading what is on file" />
          )}
        </div>
      </section>
    </main>
  );
}

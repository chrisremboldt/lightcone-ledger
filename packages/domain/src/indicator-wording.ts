import type {
  IndicatorDefinition,
  IndicatorPopulation,
  IndicatorResult,
  IndicatorResultWording,
  ObservationSubjectKind,
} from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { findExposureKind, type PluralWords } from './indicator-exposure-kinds.js';
import { findIndicatorDefinition, indicatorReasonSentences } from './indicators.js';

// Plain words for indicator results and control windows. The words come from the indicator definition, the exposure
// kind and the calculation as registered now, so a result recorded earlier reads the same way as a new one.

type DeclaredBy = NonNullable<IndicatorPopulation['declaredBy']>;

const subjectNouns: Record<ObservationSubjectKind, PluralWords> = {
  flight: { one: 'flight', other: 'flights' },
  aircraft: { one: 'aircraft', other: 'aircraft' },
  person: { one: 'person', other: 'people' },
  site: { one: 'site', other: 'sites' },
  organization: { one: 'organization', other: 'organizations' },
  component: { one: 'component', other: 'components' },
};
const anySubject: PluralWords = { one: 'subject', other: 'subjects' };

/** The words for a count: the one form for exactly one, else the other, with {count} replaced. */
export function pluralWords(words: PluralWords, count: number | string, isOne = Number(count) === 1): string {
  return (isOne ? words.one : words.other).replaceAll('{count}', String(count));
}

/** A decimal as people write it: no trailing zeros after the point. */
function plainDecimal(decimal: string): string {
  return decimal.includes('.') ? decimal.replace(/\.?0+$/, '') : decimal;
}

function counted(count: number, noun: PluralWords): string {
  return `${count} ${pluralWords(noun, count)}`;
}

/**
 * The names of the people and sources that declared these populations, keyed by declarer kind and id: a person is a
 * human principal, a source any other principal. A declarer with no such principal has no name here.
 */
export async function principalNames(
  client: PoolClient,
  tenantId: string,
  declarers: readonly (DeclaredBy | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(declarers.flatMap((item) => (item && item.kind !== 'definition' ? [item.id] : [])))].sort();
  if (!ids.length) return new Map();
  const rows = await client.query<{ id: string; name: string; kind: string }>(
    'SELECT id,name,kind FROM principals WHERE tenant_id=$1 AND id=ANY($2::text[])',
    [tenantId, ids],
  );
  return new Map(rows.rows.map((row) => [declarerKey(row.kind === 'human' ? 'person' : 'source', row.id), row.name]));
}

/** The key a declarer's name is found under in the names map. */
export function declarerKey(kind: DeclaredBy['kind'], id: string): string {
  return `${kind}:${id}`;
}

function declarerWords(declaredBy: DeclaredBy, names: ReadonlyMap<string, string>): string {
  if (declaredBy.kind === 'definition') return 'the indicator definition';
  const name = names.get(declarerKey(declaredBy.kind, declaredBy.id));
  if (declaredBy.kind === 'person') return name ?? 'a person';
  return name ? `the source ${name}` : 'a reporting source';
}

/** How many subjects a population lists, and who declared it, by name. */
export function populationWording(
  subjectKind: ObservationSubjectKind | undefined,
  population: { count: number; complete: boolean; declaredBy: DeclaredBy | null },
  names: ReadonlyMap<string, string>,
): string {
  const listed = counted(population.count, subjectKind ? subjectNouns[subjectKind] : anySubject);
  const by = population.declaredBy ? declarerWords(population.declaredBy, names) : null;
  if (population.complete) return `${listed}, declared complete${by ? ` by ${by}` : ''}`;
  return `${listed}${by ? ` listed by ${by}` : ''}, not declared complete`;
}

function scopeSubjectKind(definition: IndicatorDefinition | undefined): ObservationSubjectKind | undefined {
  const scope = definition?.scope;
  if (scope?.kind === 'subject_kind') return scope.subjectKind;
  if (scope?.kind !== 'subjects') return undefined;
  const kinds = new Set(scope.subjects.map((subject) => subject.kind));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

function eventNoun(definition: IndicatorDefinition | undefined, subjectKind: ObservationSubjectKind | undefined) {
  const events = definition?.events;
  if (!events) return { one: 'event', other: 'events' };
  if (events.kind === 'findings') return { one: 'finding', other: 'findings' };
  if (events.kind === 'observations') return { one: 'matching report', other: 'matching reports' };
  if (events.countEach !== 'subject') return { one: 'issue', other: 'issues' };
  const subject = subjectKind ? subjectNouns[subjectKind] : anySubject;
  return { one: `${subject.one} with an issue`, other: `${subject.other} with an issue` };
}

function explainedNotes(notes: IndicatorResult['exposure']['gaps'], words: Readonly<Record<string, PluralWords>>) {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.code, (counts.get(note.code) ?? 0) + 1);
  return [...counts].map(([code, count]) => ({
    code,
    count,
    sentence: words[code] ? pluralWords(words[code], count) : null,
  }));
}

function explained(codes: readonly string[]) {
  return codes.map((code) => ({ code, sentence: indicatorReasonSentences[code] ?? null }));
}

/**
 * A result in plain words: the definition's title and description, the counts with their nouns, who declared the
 * population, each reason and limitation, and each gap and conflict code with how many notes carry it.
 */
export function indicatorResultWording(
  result: IndicatorResult,
  context: { subjectKind?: ObservationSubjectKind; names: ReadonlyMap<string, string> },
): IndicatorResultWording {
  const definition = findIndicatorDefinition(result.definition.id, result.definition.version);
  const kind = findExposureKind(result.exposureKind.id, result.exposureKind.version);
  const subjectKind = context.subjectKind ?? scopeSubjectKind(definition);
  const value = result.exposure.value;
  const unit = kind?.wording?.unit ?? {
    one: result.exposure.unit.replaceAll('_', ' '),
    other: result.exposure.unit.replaceAll('_', ' '),
  };
  const notes = kind?.wording?.notes ?? {};
  return {
    title: definition?.title ?? null,
    description: definition?.description ?? null,
    events: counted(result.eventCount, eventNoun(definition, subjectKind)),
    rate: result.rate ? `${plainDecimal(result.rate.decimal)} ${result.rate.label}` : null,
    exposure: `${plainDecimal(result.exposure.decimal)} ${pluralWords(unit, 0, value.numerator === value.denominator)}`,
    population: populationWording(
      subjectKind,
      {
        count: result.population.subjectCount,
        complete: result.population.complete,
        declaredBy: result.population.declaredBy,
      },
      context.names,
    ),
    reasons: explained(result.reasons),
    limitations: explained(result.limitations ?? []),
    gaps: explainedNotes(result.exposure.gaps, notes),
    conflicts: explainedNotes(result.exposure.conflicts, notes),
  };
}

/** The title of each indicator a window is for, as registered now, or null for one no longer registered. */
export function indicatorTitles(indicators: readonly { id: string; version: number }[]) {
  return indicators.map(({ id, version }) => ({
    id,
    version,
    title: findIndicatorDefinition(id, version)?.title ?? null,
  }));
}

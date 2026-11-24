import type { CheckedRuleSubjectKind, InputCut, SubjectStateContent } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { PoolClient } from '@ledger/persistence';

/** What Ledger holds about one subject. The revision is the digest of the state, so it changes exactly when it does. */
export interface SubjectState {
  revision: string;
  state: Readonly<SubjectStateContent>;
}

/** The revision of a subject state: the digest of its content. Evaluations record both and the engine checks this. */
export function subjectStateRevision(state: Readonly<SubjectStateContent>): string {
  return canonicalDigest({ format: 'ledger.subject-state.1', state });
}

export interface SubjectStateReadOptions {
  /**
   * The evidence cut the evaluation reads at, when there is one. A loader whose projection keeps history reads the
   * state as of this cut; one that keeps only the current state says so where it is registered.
   */
  inputCut?: InputCut;
}

/** Loads one subject's projected state by its Ledger id, within the caller's tenant, or returns undefined. */
export type SubjectStateLoader = (
  client: PoolClient,
  subjectId: string,
  options: SubjectStateReadOptions,
) => Promise<SubjectState | undefined>;

interface SubjectStateRegistry {
  loaders: Map<string, SubjectStateLoader>;
}

// One process can load this module both from source and from its build (tests do), so the registrations live on a
// process-wide key that both copies share. The first registration for a kind is kept.
const registryKey = Symbol.for('ledger.subject-state-registry.1');
const registry: SubjectStateRegistry = ((globalThis as Record<symbol, SubjectStateRegistry | undefined>)[
  registryKey
] ??= { loaders: new Map() });

/** Registers the module that owns a subject kind as the one source of that kind's state for rules. */
export function registerSubjectState(kind: CheckedRuleSubjectKind, loader: SubjectStateLoader): void {
  if (!registry.loaders.has(kind)) registry.loaders.set(kind, loader);
}

export function subjectStateLoader(kind: string): SubjectStateLoader | undefined {
  return registry.loaders.get(kind);
}

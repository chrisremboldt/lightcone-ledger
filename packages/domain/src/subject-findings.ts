import type { CheckedRuleSubjectKind, RuleEvaluationRecord } from '@ledger/contracts';
import type { AuthContext, JournalEvent, PoolClient } from '@ledger/persistence';

/**
 * How the module that owns a subject kind shows findings the generic evaluator records about one of its subjects,
 * for example in that subject's own thread and counts. It is told of every recorded evaluation of a Ledger subject
 * of its kind, with the finding it opened or updated (null when there is none), and names no rule.
 */
export interface SubjectFindingView {
  /** Locks the subject's own record before the evaluation reads its evidence, as the module's commands do. */
  lockSubject?(client: PoolClient, subjectId: string): Promise<void>;
  recorded(
    client: PoolClient,
    principal: AuthContext,
    subjectId: string,
    evaluation: RuleEvaluationRecord,
    event: JournalEvent,
    findingId: string | null,
  ): Promise<void>;
  /**
   * A person treated a finding about the subject (took it, assigned it, recorded an action or what was done, or closed
   * it). `event` is the finding's own event when the treatment was not recorded as a decision about the subject.
   */
  treated(client: PoolClient, subjectId: string, event?: JournalEvent): Promise<void>;
}

interface SubjectFindingRegistry {
  views: Map<string, SubjectFindingView>;
}

// One process can load this module both from source and from its build (tests do), so the registrations live on a
// process-wide key that both copies share. The first registration for a kind is kept.
const registryKey = Symbol.for('ledger.subject-finding-views.1');
const registry: SubjectFindingRegistry = ((globalThis as Record<symbol, SubjectFindingRegistry | undefined>)[
  registryKey
] ??= { views: new Map() });

export function registerSubjectFindingView(kind: CheckedRuleSubjectKind, view: SubjectFindingView): void {
  if (!registry.views.has(kind)) registry.views.set(kind, view);
}

export function subjectFindingView(kind: string): SubjectFindingView | undefined {
  return registry.views.get(kind);
}

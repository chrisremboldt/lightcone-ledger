import type { FindingAction, FindingClosure, FindingClosingReason, FindingTreatment } from '@ledger/contracts';

/** What a person can record on a finding, in their words. */
export const findingStatusLabels = {
  open: 'Needs an owner',
  acknowledged: 'Owned',
  responding: 'Response recorded',
  resolved: 'Closed',
} as const;

export const treatmentLabels: Record<FindingTreatment['action'], string> = {
  acknowledge: 'Taken',
  assign: 'Assigned',
  plan: 'Action recorded',
  respond: 'What was done',
  resolve: 'Resolved after the check cleared',
  close: 'Closed',
};

export const closingReasonLabels: Record<FindingClosingReason, string> = {
  corrected_by_record: 'Corrected by a new record',
  accepted: 'Accepted, with the reason stated',
  condition_ended: 'The condition ended; what it reported still happened',
  recorded_in_error: 'Recorded in error',
};

/** The action on a finding in plain words: what, when it is due, and whether it is done or overdue. */
export function actionSentence(action: FindingAction): string {
  const state = action.doneAt ? 'done' : action.overdue ? 'overdue' : 'open';
  return `${action.note} · due ${action.dueOn}${state === 'open' ? '' : ` · ${state}`}`;
}

/** How a finding was closed, in plain words: the later record that resolved it, or the person and their reason. */
export function closureSentence(closure: FindingClosure): string {
  if (closure.by === 'record') {
    const records = closure.records.map((record) => `${record.title} (${record.observationId})`);
    return records.length
      ? `Closed by itself: a later record answered it. ${records.length === 1 ? 'Record' : 'Records'}: ${records.join(', ')}.`
      : 'Closed by itself: a later record answered it.';
  }
  const reason =
    closure.reason === 'evidence_cleared' ? 'Resolved after the check cleared' : closingReasonLabels[closure.reason];
  return `Closed by ${closure.actorName}: ${reason}. ${closure.note}`;
}

/** Today in the organization's time zone, as a calendar date for a due-date field. */
export function today(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Age in days, as the list shows it. */
export function ageWords(days: number): string {
  return days === 0 ? 'Opened today' : days === 1 ? '1 day open' : `${days} days open`;
}

/** Said of an open finding whose latest result no longer needs attention, which only a person closes. */
export const clearedSentence = 'The latest result is supported by the record; a person closes this finding.';

import type { CheckedRuleLeaf, RuleReadCondition } from '@ledger/contracts';
import { episodeOpenV2 } from '../check-kind-episodes.js';
import { defineCheckedRule } from '../checked-rules.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from './command-link-evidence-v1.js';

// Version 3 of the demo procedures' lost-link review: as version 2, and a capture session first used for another
// flight or aircraft is not read on this flight. Version 2 stays in pack version 5.

const procedureText =
  'Every reported command-link loss on a flight is reviewed by a person, whether or not it has been restored and in whatever order its reports arrive. Evidence is grouped within the exact source, capture session, incident and reported aircraft. A capture session belongs to the flight and aircraft of its earliest report; a report in that session naming another flight or aircraft is left out and named, not read as a loss. A strictly later restoration in that same scope permits manual resolution of the review. Unreadable or future evidence remains insufficient. Simultaneous loss and restoration remain conflicting until clarified by a later restoration. Reported restoration does not establish command-link health, monitored exposure or a loss rate.';

const transitionConditions: RuleReadCondition[] = [
  { field: 'values.link', oneOf: ['command_control'] },
  { field: 'values.report', oneOf: ['transition'] },
  { field: 'values.state', oneOf: ['down', 'up'] },
  { field: 'secondarySubject.kind', oneOf: ['aircraft'] },
  { field: 'secondarySubject.scope', oneOf: ['source'] },
  { field: 'sourceSessionId', filled: true },
  { field: 'sourceEventId', filled: true },
  { field: 'values.sourceEpisodeId', filled: true },
];

export const commandLinkLossLeafV3: CheckedRuleLeaf = defineCheckedRule({
  id: COMMAND_LINK_LOSS_LEAF_ID,
  version: 3,
  title: 'Reported command-link loss',
  source: { kind: 'operator_procedure', reference: 'ledger.demo-procedures.6', text: procedureText },
  target: { subjectKind: 'flight' },
  reads: [
    {
      name: 'transitions',
      type: 'link.status',
      versions: [1],
      about: 'target',
      required: false,
      select: 'all',
      where: structuredClone(transitionConditions),
    },
    {
      name: 'sessionTransitions',
      type: 'link.status',
      versions: [1],
      about: { sameSessionAs: 'transitions' },
      required: false,
      select: 'all',
      where: structuredClone(transitionConditions),
    },
  ],
  check: {
    kind: episodeOpenV2,
    params: {
      scopeFields: ['sourceSessionId', 'values.sourceEpisodeId', 'secondarySubject.id'],
      stateField: 'values.state',
      opening: ['down'],
      closing: ['up'],
      // A capture session reports one flight and one aircraft; its earliest report, about any flight, binds it.
      sessionField: 'sourceSessionId',
      sessionBinds: ['subject.kind', 'subject.id', 'secondarySubject.id'],
      // Every recorded loss is reviewed by a person, restored or not, in whatever order its reports arrive.
      attention: 'any',
    },
  },
  wording: {
    attention:
      'Review the reported command-link losses: {openEpisodeCount} with no restoration recorded in the same source, session, incident and aircraft, {conflictingEpisodeCount} restored at the same instant as the loss, and {unreadableCount} unreadable or future reports. {leftOutCount} reports in a session first used for another flight or aircraft are left out.',
    pass: 'Review the reported command-link losses: each was restored at a strictly later instant in the same source, session, incident and aircraft, the latest restored at {latestClosedAt}. {leftOutCount} reports in a session first used for another flight or aircraft are left out. The review may be resolved once a person has looked at it.',
    pending:
      'No loss report is available to review. Restoration-only reports do not establish command-link health. {leftOutCount} reports in a session first used for another flight or aircraft are left out.',
  },
});

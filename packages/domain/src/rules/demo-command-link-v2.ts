import type { CheckedRuleLeaf } from '@ledger/contracts';
import { episodeOpenV1 } from '../check-kind-episodes.js';
import { defineCheckedRule } from '../checked-rules.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from './command-link-evidence-v1.js';

// The demo procedures' lost-link review as data: it reads link.status transitions about the flight through the
// generic evaluator. Version 1 ran in its own evaluator and stays in pack versions 3 and 4.

const procedureText =
  'Every reported command-link loss on a flight is reviewed by a person, whether or not it has been restored and in whatever order its reports arrive. Evidence is grouped within the exact source, capture session, incident and reported aircraft. A strictly later restoration in that same scope permits manual resolution of the review. Unreadable or future evidence remains insufficient. Simultaneous loss and restoration remain conflicting until clarified by a later restoration. Reported restoration does not establish command-link health, monitored exposure or a loss rate.';

export const commandLinkLossLeafV2: CheckedRuleLeaf = defineCheckedRule({
  id: COMMAND_LINK_LOSS_LEAF_ID,
  version: 2,
  title: 'Reported command-link loss',
  source: { kind: 'operator_procedure', reference: 'ledger.demo-procedures.5', text: procedureText },
  target: { subjectKind: 'flight' },
  reads: [
    {
      name: 'transitions',
      type: 'link.status',
      versions: [1],
      about: 'target',
      required: false,
      select: 'all',
      where: [
        { field: 'values.link', oneOf: ['command_control'] },
        { field: 'values.report', oneOf: ['transition'] },
        { field: 'values.state', oneOf: ['down', 'up'] },
        { field: 'secondarySubject.kind', oneOf: ['aircraft'] },
        { field: 'secondarySubject.scope', oneOf: ['source'] },
        { field: 'sourceSessionId', filled: true },
        { field: 'sourceEventId', filled: true },
        { field: 'values.sourceEpisodeId', filled: true },
      ],
    },
  ],
  check: {
    kind: episodeOpenV1,
    params: {
      scopeFields: ['sourceSessionId', 'values.sourceEpisodeId', 'secondarySubject.id'],
      stateField: 'values.state',
      opening: ['down'],
      closing: ['up'],
      // A capture session reports one aircraft; a report naming another in that session is not read as a loss.
      sessionField: 'sourceSessionId',
      sessionBinds: ['secondarySubject.id'],
      // Every recorded loss is reviewed by a person, restored or not, in whatever order its reports arrive.
      attention: 'any',
    },
  },
  wording: {
    attention:
      'Review the reported command-link losses: {openEpisodeCount} with no restoration recorded in the same source, session, incident and aircraft, {conflictingEpisodeCount} restored at the same instant as the loss, and {unreadableCount} unreadable or future reports.',
    pass: 'Review the reported command-link losses: each was restored at a strictly later instant in the same source, session, incident and aircraft, the latest restored at {latestClosedAt}. The review may be resolved once a person has looked at it.',
    pending: 'No loss report is available to review. Restoration-only reports do not establish command-link health.',
  },
});

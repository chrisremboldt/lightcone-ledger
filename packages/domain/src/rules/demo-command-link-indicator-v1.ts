import type { IndicatorDefinition } from '@ledger/contracts';
import { defineIndicator } from '../indicators.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from './command-link-evidence-v1.js';

// The demo procedures' measure of reported command-link losses, as an indicator over the lost-link rule's issues.

export const COMMAND_LINK_LOSSES_PER_FLIGHT_HOUR_ID = 'demo-procedures.command-link-losses-per-flight-hour';

export function commandLinkLossesPerFlightHourV1(): IndicatorDefinition {
  return defineIndicator({
    id: COMMAND_LINK_LOSSES_PER_FLIGHT_HOUR_ID,
    version: 1,
    title: 'Reported command-link losses per monitored flight hour',
    description:
      'Reported command-link loss episodes on the flights declared for the window, per flight hour during which command-link reports were being received for those flights. One loss episode counts once however many reports describe it, and a restored loss still counts; a loss counts in the window when it began in it, or began earlier and was not yet restored when the window started. Exposure is reported takeoff to landing time covered by command-link reports no more than a minute apart. A rate is stated only for a population declared complete, with every airborne minute covered, the link state established at the window start for every flight then airborne, every loss placed in time and no review still due. It establishes no effectiveness threshold, causation or operational permission.',
    scope: { kind: 'subject_kind', subjectKind: 'flight' },
    events: { kind: 'issues', packId: 'ledger.demo-procedures', ruleId: COMMAND_LINK_LOSS_LEAF_ID },
    exposure: {
      kind: 'exposure.covered-flight-hours',
      version: 1,
      params: {
        type: 'link.status',
        versions: [1],
        condition: { field: 'values.link', operator: 'equals', value: 'command_control' },
        maxSilenceMilliseconds: 60_000,
        // The link state at the window start is established by an up or degraded report, or by a down report that
        // names its loss episode; down outside a reported episode, or unknown, is not.
        stateAtWindowStart: [
          [{ field: 'values.state', operator: 'one_of', values: ['up', 'degraded'] }],
          [
            { field: 'values.state', operator: 'equals', value: 'down' },
            { field: 'values.sourceEpisodeId', operator: 'present' },
          ],
        ],
      },
    },
    window: { maxMilliseconds: 31 * 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 6 },
  });
}

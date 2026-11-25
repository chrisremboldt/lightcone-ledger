import type { FlightSummary, SmsRecordKind, SmsRecordSummary } from '@ledger/contracts';
import type { AvoidanceDemoMission } from './avoidance-demo.js';
import type { Place } from './place.js';

/**
 * A finding as the screen showed it when someone opened the safety workspace from it: on a flight (flightId), or about
 * any other subject, which flightLabel then names.
 */
export interface FlightFinding {
  flightId?: string;
  flightLabel: string;
  findingId: string;
}

/** Where the safety section opens. */
export type SafetyDestination =
  | { view: 'home' }
  | { view: 'register' }
  | { view: 'record'; id: string; kind?: SmsRecordKind; from?: FlightFinding }
  | { view: 'finding'; finding: FlightFinding };

/** What the flight shell does for the safety section: show a flight's finding, or a demo flight's mission. */
export interface FlightLinks {
  /** Return to the flights, at this flight's finding when one is given. */
  onFlight: (finding?: { flightId: string; findingId: string }) => void;
  /** Open the mission review of a demo flight that exercises an accepted area control. */
  onDemoMission: (flight: FlightSummary, demo: AvoidanceDemoMission) => void;
}

/** The flight a finding origin is about, when it is a Ledger flight. */
export function originFlightId(origin: SmsRecordSummary['origin']): string | undefined {
  const subject = origin?.subject;
  return subject && subject.scope === 'ledger' && subject.kind === 'flight' ? subject.id : undefined;
}

export const originLabels: Record<NonNullable<SmsRecordSummary['origin']>['kind'], string> = {
  finding: 'From a finding',
  report: 'From a safety report',
  assurance: 'From a safety assurance record',
  manual: 'Identified directly',
};

/**
 * The place a destination is, and what the move keeps that the address does not hold: the finding a record or a new
 * hazard was opened from, with the flight's label.
 */
export function safetyDestinationPlace(destination: SafetyDestination): {
  place: Place;
  extras: Record<string, unknown>;
} {
  switch (destination.view) {
    case 'home':
      return { place: { section: 'safety', view: 'home' }, extras: {} };
    case 'register':
      return { place: { section: 'safety', view: 'hazards' }, extras: {} };
    case 'record':
      return {
        place: { section: 'safety', view: 'record', kind: destination.kind ?? 'hazard', id: destination.id },
        extras: destination.from ? { from: destination.from } : {},
      };
    case 'finding':
      return {
        place: {
          section: 'safety',
          view: 'finding',
          findingId: destination.finding.findingId,
          ...(destination.finding.flightId ? { flightId: destination.finding.flightId } : {}),
        },
        extras: { flightLabel: destination.finding.flightLabel },
      };
  }
}

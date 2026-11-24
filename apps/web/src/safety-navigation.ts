import type { FlightSummary, SmsRecordKind, SmsRecordSummary } from '@ledger/contracts';
import type { AvoidanceDemoMission } from './avoidance-demo.js';

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

/** What the safety section asks of the flight screens, numbered so the same request can be made twice. */
export type FlightRequest = { sequence: number } & (
  | { kind: 'finding'; flightId: string; findingId: string }
  | { kind: 'demo-mission'; flight: FlightSummary; demo: AvoidanceDemoMission }
);

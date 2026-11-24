import type { FlightSummary } from '@ledger/contracts';

export function retainFlight(flight: FlightSummary, roster: FlightSummary[]): FlightSummary {
  return roster.find((candidate) => candidate.id === flight.id) ?? flight;
}

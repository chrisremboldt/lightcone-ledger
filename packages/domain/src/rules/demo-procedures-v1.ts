export type FlightObservationField = 'activity' | 'state' | 'phase' | 'landingTime' | 'landedAt';
export type FlightRuleDependency = 'flight.activity' | 'flight.scheduledEnd' | 'flight.observations' | 'clock.wall';

export interface SourceBinding {
  id: string;
  version: number;
  inputKind: 'flight.observation';
  supportedFields: readonly FlightObservationField[];
  correctionHandling: 'active_claims_selected_by_caller';
}

export interface RuleLeaf {
  id: string;
  version: number;
  title: string;
  source: {
    kind: 'operator_procedure';
    reference: string;
    text: string;
    textSpan: { start: number; end: number };
  };
  review: 'ai_drafted';
  adopted: false;
  bindingId: string;
  bindingVersion: number;
  dependencies: readonly FlightRuleDependency[];
}

export const LANDING_DISAGREEMENT_LEAF_ID = 'ledger.demo.landing-disagreement';
export const MISSING_LANDING_EVIDENCE_LEAF_ID = 'ledger.demo.missing-landing-evidence';
export const LANDING_EVIDENCE_GRACE_MS = 5 * 60 * 1000;

export const flightObservationBindingV1: SourceBinding = Object.freeze({
  id: 'ledger.flight-observation',
  version: 1,
  inputKind: 'flight.observation',
  supportedFields: Object.freeze<FlightObservationField[]>(['activity', 'state', 'phase', 'landingTime', 'landedAt']),
  correctionHandling: 'active_claims_selected_by_caller',
});

function procedureLeaf(id: string, title: string, text: string, dependencies: FlightRuleDependency[]): RuleLeaf {
  return Object.freeze({
    id,
    version: 1,
    title,
    source: Object.freeze({
      kind: 'operator_procedure',
      reference: 'ledger.demo-procedures.1',
      text,
      textSpan: Object.freeze({ start: 0, end: text.length }),
    }),
    review: 'ai_drafted',
    adopted: false,
    bindingId: flightObservationBindingV1.id,
    bindingVersion: flightObservationBindingV1.version,
    dependencies: Object.freeze(dependencies),
  });
}

export const flightRuleLeavesV1: readonly RuleLeaf[] = Object.freeze([
  procedureLeaf(
    LANDING_DISAGREEMENT_LEAF_ID,
    'Landing time disagreement',
    'For a flight that is not cancelled, review distinct valid UTC landing times reported by active flight observations.',
    ['flight.activity', 'flight.observations'],
  ),
  procedureLeaf(
    MISSING_LANDING_EVIDENCE_LEAF_ID,
    'Landing evidence overdue',
    'For a flight that is not cancelled, record a valid UTC landing time by five minutes after its scheduled end.',
    ['flight.activity', 'flight.scheduledEnd', 'flight.observations', 'clock.wall'],
  ),
]);

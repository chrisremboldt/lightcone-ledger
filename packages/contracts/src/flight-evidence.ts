import type { DecisionEvidenceBundle, EvidenceManifest, EvidenceSection } from './evidence.js';

export interface FlightEvidenceManifest extends Omit<EvidenceManifest, 'format' | 'sectionDigests'> {
  format: 'ledger.flight-evidence.2';
  subject: { kind: 'flight'; id: string };
  sectionDigests: Record<FlightEvidenceSection, string>;
}
export type FlightEvidenceSection = EvidenceSection | 'basisManifest';
export interface FlightEvidenceBundle extends Omit<DecisionEvidenceBundle, 'format' | 'manifest'> {
  format: 'ledger.flight-evidence.2';
  manifest: FlightEvidenceManifest;
  basisManifest: { status: 'not_retained' };
}

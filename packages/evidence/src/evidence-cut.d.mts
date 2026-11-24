import type { EvidenceCutOutput, EvidenceEntry, InputCut } from '@ledger/contracts';
export function interpretEvidenceCut(entries: EvidenceEntry[], cut: InputCut, tenantId: string): EvidenceCutOutput;

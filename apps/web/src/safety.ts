import type { AcceptedObservation, EvaluationRecord } from '@ledger/contracts';
import type { Basis } from './ActionPanel.js';
import { citedValueRows, isDisagreement, isEpisodeReview, type CitedValueRow } from './evaluation-reads.js';

export type SafetyEvaluation = EvaluationRecord;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('The retained record contains an unsupported number. Refresh it before continuing.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('The retained record could not be read. Refresh it before continuing.');
}

export async function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sameSafetyBasis(left: Basis, right: Basis): boolean {
  return (
    left.valid &&
    right.valid &&
    left.view === right.view &&
    left.revision === right.revision &&
    left.basisRevision === right.basisRevision &&
    left.dependencyBasis === right.dependencyBasis &&
    left.inputCut.principalRevision === right.inputCut.principalRevision &&
    canonicalJson(left.inputCut.streams) === canonicalJson(right.inputCut.streams)
  );
}

export function safetyFindingOrigin(evaluation: SafetyEvaluation): 'command_link' | 'landing_disagreement' | null {
  // A retained lost-link evaluation in its own format, recorded only by version 1 of its rule and binding.
  if ('kind' in evaluation.explanation && evaluation.explanation.kind === 'command_link')
    return evaluation.leafVersion === 1 && evaluation.bindingVersion === 1 ? 'command_link' : null;
  // From the generic evaluator the check kind decides, never the rule; the origins keep their contract names.
  if (isEpisodeReview(evaluation)) return 'command_link';
  // Reports that disagree, from an adopted rule: the check's reason code decides, never the rule.
  if (isDisagreement(evaluation)) return 'landing_disagreement';
  return null;
}

export function isLandingDisagreementFinding(evaluation: SafetyEvaluation): boolean {
  return safetyFindingOrigin(evaluation) === 'landing_disagreement';
}

export type LandingReportRow = CitedValueRow;

/** The compared value of each report the finding cites, read from the observations it cites. */
export function landingReportRows(
  evaluation: SafetyEvaluation,
  observations: readonly AcceptedObservation[],
): LandingReportRow[] {
  if (!isLandingDisagreementFinding(evaluation)) return [];
  return citedValueRows(evaluation, observations);
}

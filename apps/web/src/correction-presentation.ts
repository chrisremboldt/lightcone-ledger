import type { TimelineItem } from '@ledger/contracts';

const sourceKinds = new Set([
  'flight.observation',
  'source.observation',
  'airspace.status',
  'telemetry.segment',
  // RETAINED: command-link reports and baselines recorded before those intakes were retired still show here.
  'command-link.status',
  'command-link.baseline',
]);

export function correctionEligibility(item: TimelineItem | null): { allowed: boolean; reason: string } {
  if (!item) return { allowed: false, reason: 'Select a source report to append a correction.' };
  if (item.kind === 'observation')
    return {
      allowed: false,
      reason: 'An observation is corrected at its source: withdraw it, or send a replacement that names it.',
    };
  if (!sourceKinds.has(item.kind) && item.kind !== 'evidence.correct')
    return {
      allowed: false,
      reason:
        item.kind === 'mission.revision'
          ? 'Mission plans change through an authorized mission-source revision.'
          : 'This is a computed or authored record. Select its source report to append a correction.',
    };
  if (item.kind === 'telemetry.segment')
    return { allowed: true, reason: 'This appends an annotation; retained native telemetry samples stay unchanged.' };
  if (item.kind === 'command-link.status' || item.kind === 'command-link.baseline')
    return {
      allowed: true,
      reason: 'This appends an annotation; native command-link evidence and its check stay unchanged.',
    };
  return { allowed: true, reason: 'The original report stays retained alongside your attributed correction.' };
}

export function reportPayload(item: TimelineItem): Record<string, unknown> {
  const nested = item.payload.payload;
  const payload =
    item.kind === 'evidence.correct' && nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested
      : item.payload;
  return structuredClone(payload) as Record<string, unknown>;
}

export function landingFields(item: TimelineItem): ('landingTime' | 'landedAt')[] {
  if (item.kind !== 'flight.observation' && item.kind !== 'evidence.correct') return [];
  const payload = reportPayload(item);
  return (['landingTime', 'landedAt'] as const).filter((field) => Object.hasOwn(payload, field));
}

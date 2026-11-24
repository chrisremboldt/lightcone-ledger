// Retained evidence-cut.1 interpretation. This is an immutable evidence inventory, not thread.1 SQL replay.
export function interpretEvidenceCut(entries, cut, tenantId) {
  const events = entries.map(entry => ({ entry, envelope: JSON.parse(entry.canonicalEnvelope) }))
    .filter(({ envelope }) => BigInt(envelope.sequence) <= BigInt(cut.streams[envelope.streamId] ?? 0))
    .sort((a, b) => a.envelope.streamId < b.envelope.streamId ? -1 : a.envelope.streamId > b.envelope.streamId ? 1 : BigInt(a.envelope.sequence) < BigInt(b.envelope.sequence) ? -1 : BigInt(a.envelope.sequence) > BigInt(b.envelope.sequence) ? 1 : 0)
    .map(({ entry, envelope: e }) => ({ eventId: e.eventId, streamId: e.streamId, sequence: e.sequence, type: e.type, principalId: e.principalId, sourceId: e.sourceId, occurredAt: e.occurredAt, effectiveAt: e.effectiveAt, receivedAt: e.receivedAt, causationId: e.causationId, artifactId: e.artifactId, envelopeDigest: entry.envelopeDigest, entryHash: entry.entryHash }));
  const ids = new Set(events.map(event => event.eventId));
  const missingCausationIds = [...new Set(events.filter(event => event.causationId !== null && !ids.has(event.causationId)).map(event => event.causationId))].sort();
  return { interpretation: 'evidence-cut.1', tenantId, cut, events, missingCausationIds, limitations: [
    'Whole-tenant immutable evidence inventory; flightId identifies the selected decision, not a historical disclosure filter.',
    'Closure reports explicit journal causation references only; this interpretation does not rebuild thread.1 operational SQL state or the historical browser display.',
    'Source occurredAt and effectiveAt are retained claims; known-at-cut membership follows stream positions, not source timestamps.',
  ] };
}

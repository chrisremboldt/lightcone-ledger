import type { TelemetrySampleView } from '@ledger/contracts';

const trackKey = (sample: TelemetrySampleView) =>
  JSON.stringify([sample.sourceId, sample.sourceSessionId, sample.deviceId]);

export function lateTelemetrySamples(samples: readonly TelemetrySampleView[]): Set<string> {
  const late = new Set<string>();
  const seen = new Map<string, number>();
  const batches = new Map<string, TelemetrySampleView[]>();
  for (const sample of samples) batches.set(sample.receivedAt, [...(batches.get(sample.receivedAt) ?? []), sample]);
  for (const [, batch] of [...batches].sort(([a], [b]) => Date.parse(a) - Date.parse(b))) {
    for (const sample of batch) {
      const previous = seen.get(trackKey(sample));
      if (previous !== undefined && Date.parse(sample.occurredAt) < previous) late.add(sample.id);
    }
    for (const sample of batch) {
      const key = trackKey(sample);
      seen.set(key, Math.max(seen.get(key) ?? -Infinity, Date.parse(sample.occurredAt)));
    }
  }
  return late;
}

export function telemetryTrackEdges(samples: readonly TelemetrySampleView[]) {
  const tracks = new Map<string, TelemetrySampleView[]>();
  const edges: { from: TelemetrySampleView; to: TelemetrySampleView }[] = [];
  for (const sample of samples) tracks.set(trackKey(sample), [...(tracks.get(trackKey(sample)) ?? []), sample]);
  for (const track of tracks.values()) {
    track.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const regressions = new Set<string>();
    let sourceTime = -Infinity;
    for (const sample of track) {
      const occurred = Date.parse(sample.occurredAt);
      if (occurred < sourceTime) regressions.add(sample.id);
      else sourceTime = occurred;
    }
    for (let index = 1; index < track.length; index++) {
      const from = track[index - 1]!;
      const to = track[index]!;
      if (
        to.sequence === from.sequence + 1 &&
        !from.conflict &&
        !to.conflict &&
        !regressions.has(from.id) &&
        !regressions.has(to.id)
      )
        edges.push({ from, to });
    }
  }
  return edges;
}
